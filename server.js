// Promovox - servico de masterizacao de musica (ffmpeg)
// POST /mixar  { voz, musica?, efeitos? } -> MP3 final (voz + musica com abaixamento + efeitos)
// POST /masterizar  { "url": "https://...mp3", "so_volume": true (opcional: so acerta o volume, sem EQ/compressao/reverb) }   header: x-api-key: <MASTER_KEY>
// Responde com o MP3 tratado (audio/mpeg). GET /health responde ok.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const KEY = process.env.MASTER_KEY || "";
const MAX_BYTES = 40 * 1024 * 1024;
const LUFS = Number(process.env.TARGET_LUFS || -14);
const REVERB = Number(process.env.REVERB_WET || 0.10);     // 0 = sem reverb, 0.10 = discreto

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(cmd + " saiu com " + code + ": " + err.slice(-500)))));
  });
}

// cadeia de estudio: limpeza, EQ, brilho, compressao, espaco (reverb), limitador e volume final
function cadeia(wet, medida, soVolume) {
  const base = soVolume ? "anull" : [
    "highpass=f=30",
    "equalizer=f=250:t=q:w=1:g=-1.5",        // tira o "embolado" dos graves medios
    "equalizer=f=3200:t=q:w=1:g=2.2",        // presenca da voz
    "highshelf=f=10500:g=2.5",               // brilho / ar
    "acompressor=threshold=-19dB:ratio=2.4:attack=18:release=220:makeup=2.5",   // cola a mixagem
  ].join(",");
  const rev = wet > 0
    ? "[0:a]" + base + ",asplit[d][w];[w][1:a]afir=dry=0:wet=1[r];[d][r]amix=inputs=2:weights=1 " + wet + ":normalize=0,"
    : "[0:a]" + base + ",";
  const lim = "alimiter=limit=0.89:attack=5:release=70";
  const ln = medida
    ? "loudnorm=I=" + LUFS + ":TP=-1.0:LRA=11:measured_I=" + medida.input_i + ":measured_TP=" + medida.input_tp + ":measured_LRA=" + medida.input_lra + ":measured_thresh=" + medida.input_thresh + ":offset=" + medida.target_offset + ":linear=true"
    : "loudnorm=I=" + LUFS + ":TP=-1.0:LRA=11:print_format=json";
  return rev + lim + "," + ln + (wet > 0 ? "[out]" : "");
}

async function masterizar(entrada, saida, dir, soVolume) {
  const wet = soVolume ? 0 : REVERB;
  let irArgs = [];
  if (wet > 0) {
    const ir = path.join(dir, "ir.wav");
    // resposta de impulso sintetica: ruido rosa que decai (placa curta, ~1,1 s)
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "anoisesrc=d=1.1:c=pink:r=48000:a=0.5", "-af", "afade=t=out:st=0.05:d=1.05:curve=exp,highpass=f=200,lowpass=f=9000", "-ac", "2", ir]);
    irArgs = ["-i", ir];
  }
  const filtro = (medida) => {
    const g = cadeia(wet, medida, soVolume);
    return wet > 0 ? ["-filter_complex", g, "-map", "[out]"] : ["-af", g.replace(/^\[0:a\]/, "")];
  };
  // 1a passada: mede
  const log = await run("ffmpeg", ["-y", "-i", entrada, ...irArgs, ...filtro(null), "-f", "null", "-"]);
  const i = log.lastIndexOf("{"); const j = log.lastIndexOf("}");
  let medida = null;
  try { medida = JSON.parse(log.slice(i, j + 1)); } catch (e) {}
  // 2a passada: aplica
  await run("ffmpeg", ["-y", "-i", entrada, ...irArgs, ...filtro(medida), "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", saida]);
  return medida;
}

async function baixar(url, destino) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) { throw new Error("download falhou: " + r.status); }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) { throw new Error("arquivo grande demais"); }
  fs.writeFileSync(destino, buf);
}


// ---------- MIXAGEM: voz + musica (com abaixamento automatico) + efeitos ----------
// POST /mixar { voz, musica?, efeitos?: [{url, offset}], duck_ratio?, musica_db?, lufs? }  -> MP3 final
const DUCK_RATIO = Number(process.env.DUCK_RATIO || 4);        // 4 ~ musica 9 dB mais baixa enquanto a voz fala; 8 ~ 11 dB
const MUSICA_DB = Number(process.env.MUSICA_DB || 0);          // ganho extra da musica (dB)
const MIX_LUFS = Number(process.env.MIX_LUFS || -13);
const FX_DB = Number(process.env.FX_DB || -4);
const FMT = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

async function duracao(arq) {
  const out = await new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", arq]);
    let o = ""; p.stdout.on("data", (d) => { o += d.toString(); });
    p.on("error", reject); p.on("close", () => resolve(o.trim()));
  });
  const d = parseFloat(out);
  if (!(d > 0)) { throw new Error("nao consegui ler a duracao da voz"); }
  return d;
}

async function mixar(p, dir) {
  const vozF = path.join(dir, "voz.mp3");
  await baixar(p.voz, vozF);
  const D = await duracao(vozF);
  const args = ["-y", "-i", vozF];
  let idx = 1;
  let musIdx = -1;
  if (p.musica) {
    const musF = path.join(dir, "mus.mp3");
    await baixar(p.musica, musF);
    // musica em loop, cortada no fim da voz + 1,2 s de saida
    args.push("-i", musF);
    musIdx = idx++;
  }
  const fxIdx = [];
  const efeitos = Array.isArray(p.efeitos) ? p.efeitos.slice(0, 4) : [];
  for (let k = 0; k < efeitos.length; k++) {
    const f = path.join(dir, "fx" + k + ".mp3");
    await baixar(efeitos[k].url, f);
    args.push("-i", f);
    fxIdx.push({ i: idx++, ms: Math.max(0, Math.round(Number(efeitos[k].offset || 0) * 1000)) });
  }
  const f = [];
  // voz nivelada
  f.push("[0:a]" + FMT + ",loudnorm=I=-16:TP=-1.5:LRA=7,aresample=44100[v]");
  // efeitos em primeiro plano, no tempo certo
  fxIdx.forEach((x, k) => { f.push("[" + x.i + ":a]" + FMT + ",volume=" + FX_DB + "dB,adelay=" + x.ms + "|" + x.ms + "[fx" + k + "]"); });
  const fgIn = "[v]" + fxIdx.map((x, k) => "[fx" + k + "]").join("");
  if (fxIdx.length > 0) { f.push(fgIn + "amix=inputs=" + (1 + fxIdx.length) + ":normalize=0:duration=longest[fg]"); }
  else { f.push("[v]anull[fg]"); }
  const ratio = Number(p.duck_ratio || DUCK_RATIO);
  const mdb = Number(p.musica_db !== undefined ? p.musica_db : MUSICA_DB);
  const lufs = Number(p.lufs || MIX_LUFS);
  if (musIdx >= 0) {
    f.push("[fg]asplit=2[fg1][fg2]");
    const fim = (D + 1.2).toFixed(2), ini = Math.max(0, D + 1.2 - 1.5).toFixed(2);
    f.push("[" + musIdx + ":a]" + FMT + ",aloop=loop=-1:size=2000000000,atrim=duration=" + fim + ",loudnorm=I=-16:TP=-1.5:LRA=7,aresample=44100,volume=" + mdb + "dB,afade=t=out:st=" + ini + ":d=1.5[m]");
    f.push("[m][fg1]sidechaincompress=threshold=0.02:ratio=" + ratio + ":attack=30:release=500:makeup=1[md]");
    f.push("[fg2][md]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=" + lufs + ":TP=-1:LRA=11,aresample=48000[o]");
  } else {
    f.push("[fg]loudnorm=I=" + lufs + ":TP=-1:LRA=11,aresample=48000[o]");
  }
  const saida = path.join(dir, "mix.mp3");
  await run("ffmpeg", [...args, "-filter_complex", f.join(";"), "-map", "[o]", "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", saida]);
  return saida;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.method !== "POST" || (req.url !== "/masterizar" && req.url !== "/mixar")) { res.writeHead(404); return res.end("nao encontrado"); }
  if (KEY && req.headers["x-api-key"] !== KEY) { res.writeHead(401); return res.end("chave invalida"); }
  let corpo = "";
  req.on("data", (d) => { corpo += d; if (corpo.length > 20000) { req.destroy(); } });
  req.on("end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mst-"));
    try {
      if (req.url === "/mixar") {
        const p = JSON.parse(corpo || "{}");
        const ok = (u) => /^https:\/\//.test(String(u || "")) || (process.env.ALLOW_HTTP === "1" && /^http:\/\//.test(String(u || "")));
        if (!ok(p.voz) || (p.musica && !ok(p.musica)) || (Array.isArray(p.efeitos) && p.efeitos.some((e) => !ok(e.url)))) { res.writeHead(400); return res.end("url invalida"); }
        const saidaMix = await mixar(p, dir);
        const o = fs.readFileSync(saidaMix);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": o.length });
        return res.end(o);
      }
      const { url, so_volume } = JSON.parse(corpo || "{}");
      if (!(/^https:\/\//.test(String(url || "")) || (process.env.ALLOW_HTTP === "1" && /^http:\/\//.test(String(url || ""))))) { res.writeHead(400); return res.end("url invalida"); }
      const ent = path.join(dir, "in.mp3"), sai = path.join(dir, "out.mp3");
      await baixar(url, ent);
      const medida = await masterizar(ent, sai, dir, so_volume === true);
      const out = fs.readFileSync(sai);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": out.length, "x-loudness-in": medida ? String(medida.input_i) : "" });
      res.end(out);
    } catch (e) {
      console.error(e.message);
      res.writeHead(500); res.end("erro: " + e.message.slice(0, 300));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
server.requestTimeout = 170000;
server.listen(PORT, () => console.log("promovox-master na porta " + PORT));
