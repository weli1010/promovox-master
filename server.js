// Promovox - servico de masterizacao de musica (ffmpeg)
// POST /masterizar  { "url": "https://...mp3" }   header: x-api-key: <MASTER_KEY>
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
function cadeia(wet, medida) {
  const base = [
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

async function masterizar(entrada, saida, dir) {
  const wet = REVERB;
  let irArgs = [];
  if (wet > 0) {
    const ir = path.join(dir, "ir.wav");
    // resposta de impulso sintetica: ruido rosa que decai (placa curta, ~1,1 s)
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "anoisesrc=d=1.1:c=pink:r=48000:a=0.5", "-af", "afade=t=out:st=0.05:d=1.05:curve=exp,highpass=f=200,lowpass=f=9000", "-ac", "2", ir]);
    irArgs = ["-i", ir];
  }
  const filtro = (medida) => {
    const g = cadeia(wet, medida);
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

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (req.method !== "POST" || req.url !== "/masterizar") { res.writeHead(404); return res.end("nao encontrado"); }
  if (KEY && req.headers["x-api-key"] !== KEY) { res.writeHead(401); return res.end("chave invalida"); }
  let corpo = "";
  req.on("data", (d) => { corpo += d; if (corpo.length > 10000) { req.destroy(); } });
  req.on("end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mst-"));
    try {
      const { url } = JSON.parse(corpo || "{}");
      if (!(/^https:\/\//.test(String(url || "")) || (process.env.ALLOW_HTTP === "1" && /^http:\/\//.test(String(url || ""))))) { res.writeHead(400); return res.end("url invalida"); }
      const ent = path.join(dir, "in.mp3"), sai = path.join(dir, "out.mp3");
      await baixar(url, ent);
      const medida = await masterizar(ent, sai, dir);
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
