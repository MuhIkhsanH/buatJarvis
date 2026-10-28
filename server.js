// ============================================================
//  J.A.R.V.I.S. — server.js (all-in-one)
//  Express + Groq Whisper (STT) + Gemini (otak) + Edge TTS (suara)
//  UI HUD index.html sudah ditanam di bawah (konstanta HTML)
// ============================================================
require("dotenv").config();
const express = require("express");
const { EdgeTTS } = require("@andresaya/edge-tts");

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const GROQ_MODEL = process.env.GROQ_MODEL || "whisper-large-v3";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const WHISPER_LANG = process.env.WHISPER_LANG || "id"; // "id" | "en" | "auto"
const VOICE_EN = process.env.TTS_VOICE_EN || "en-GB-RyanNeural";
const VOICE_ID = process.env.TTS_VOICE_ID || "id-ID-ArdiNeural";
const TIMEZONE = process.env.TZ_NAME || "Asia/Jakarta";

const SYSTEM_PROMPT = [
  "Kamu adalah J.A.R.V.I.S., asisten AI pribadi yang cerdas, tenang, sopan, dan sedikit witty seperti di film Iron Man.",
  "Panggil pengguna dengan 'Sir'.",
  "Jawabanmu akan DIBACAKAN lewat suara, jadi: singkat (1-3 kalimat), natural, tanpa markdown, tanpa bullet, tanpa emoji, tanpa simbol aneh.",
  "Jawab dalam bahasa yang dipakai pengguna (default Bahasa Indonesia).",
  "Kalau tidak tahu, bilang jujur. Jangan mengarang."
].join(" ");

// ---------- Clients (di-init async) ----------
let groq = null;
let toFile = null;
let ai = null;

async function initClients() {
  if (process.env.GROQ_API_KEY) {
    const Groq = (await import("groq-sdk")).default;
    ({ toFile } = await import("groq-sdk/uploads"));
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  } else {
    console.warn("[!] GROQ_API_KEY belum diisi di .env -> transkripsi suara nonaktif");
  }

  if (process.env.GEMINI_API_KEY) {
    const { GoogleGenAI } = await import("@google/genai");
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  } else {
    console.warn("[!] GEMINI_API_KEY belum diisi di .env -> chat AI nonaktif");
  }
}

// ---------- Helpers ----------
function cleanForSpeech(text) {
  return String(text)
    .replace(/[*_#`~>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function pickVoice(text) {
  const idWords =
    /\b(yang|dan|di|ke|dari|untuk|saya|aku|kamu|anda|tidak|bisa|apa|ini|itu|dengan|akan|sudah|ada|mau|tolong|buka|siap|baik|pak|bos|boleh|sekarang|jam|hari|ya|nya|kok|dong|belum|karena|atau|juga)\b/gi;
  const words = text.split(/\s+/).filter(Boolean).length || 1;
  const hits = (text.match(idWords) || []).length;
  const isId = hits >= 2 ? hits / words > 0.12 : hits >= 1 && words < 5;
  return isId
    ? { voice: VOICE_ID, opts: { pitch: "-8Hz", rate: "-5%" } }
    : { voice: VOICE_EN, opts: { pitch: "-15Hz", rate: "-10%" } };
}

const WHISPER_GHOSTS =
  /(terima kasih (telah|sudah) menonton|thanks? for watching|subtitle[sd]? by|amara\.org|jangan lupa subscribe)/i;

// ---------- App ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.type("html").send(HTML);
});

app.get("/api/health", (req, res) => {
  res.json({ groq: !!groq, gemini: !!ai, tts: true, whisper: GROQ_MODEL, gemini_model: GEMINI_MODEL });
});

// ---- Speech-to-Text (Groq Whisper) ----
app.post("/api/transcribe", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
  try {
    if (!groq) return res.status(503).json({ error: "GROQ_API_KEY belum diisi di .env" });

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Audio kosong atau tidak diterima." });
    }

    const contentType = (req.headers["content-type"] || "").split(";")[0].toLowerCase();
    const extensions = {
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/mp4": "mp4",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
    };
    const ext = extensions[contentType];
    if (!ext) return res.status(400).json({ error: "Format audio tidak didukung: " + contentType });

    console.log("[STT] audio", ext, (req.body.length / 1024).toFixed(1) + " KB");

    const file = await toFile(req.body, "rekaman." + ext, { type: contentType });
    const params = { file, model: GROQ_MODEL, response_format: "json" };
    if (WHISPER_LANG !== "auto") params.language = WHISPER_LANG;

    const result = await groq.audio.transcriptions.create(params);
    let text = (result.text || "").trim();
    if (WHISPER_GHOSTS.test(text)) text = "";

    console.log("[STT] ->", text || "(kosong)");
    res.json({ text, model: GROQ_MODEL });
  } catch (err) {
    console.error("[STT] error:", err.message);
    res.status(500).json({
      error: err.status === 413
        ? "Audio terlalu besar untuk diproses."
        : "Groq gagal memproses audio. Cek koneksi, kuota, dan log terminal.",
    });
  }
});

// ---- Otak (Gemini) ----
app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) return res.status(503).json({ error: "GEMINI_API_KEY belum diisi di .env" });

    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "Pesan kosong." });

    const history = Array.isArray(req.body.history) ? req.body.history.slice(-12) : [];
    const contents = [];
    for (const h of history) {
      if (!h || typeof h.text !== "string" || !h.text.trim()) continue;
      contents.push({
        role: h.role === "model" ? "model" : "user",
        parts: [{ text: h.text.slice(0, 2000) }],
      });
    }
    contents.push({ role: "user", parts: [{ text: message.slice(0, 4000) }] });

    const now = new Date().toLocaleString("id-ID", { timeZone: TIMEZONE, dateStyle: "full", timeStyle: "short" });

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT + " Waktu sekarang: " + now + ".",
        temperature: 0.7,
      },
    });

    const reply = (response.text || "").trim() || "Maaf Sir, saya tidak punya jawaban untuk itu.";
    console.log("[AI] ->", reply);
    res.json({ reply });
  } catch (err) {
    console.error("[AI] error:", err.message);
    res.status(500).json({ error: "Gemini error: " + err.message });
  }
});

// ---- Text-to-Speech (Edge TTS) ----
app.post("/api/tts", async (req, res) => {
  try {
    const text = cleanForSpeech(req.body.text || "");
    if (!text) return res.status(400).json({ error: "Text wajib diisi" });

    const { voice, opts } = pickVoice(text);
    const tts = new EdgeTTS();
    const result = await tts.generate(text, voice, opts);

    res.type("audio/mpeg").send(Buffer.from(result.audio));
  } catch (err) {
    console.error("[TTS] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UI (index.html) — sistem terminal sekarang bisa digeser
// ============================================================
const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>J.A.R.V.I.S. — Personal AI Assistant</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800&family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
:root{--bg-deep:#040a14;--bg-panel:rgba(6,18,38,.85);--border-glow:rgba(0,200,255,.25);--border-active:rgba(0,200,255,.6);--cyan:#00d4ff;--cyan-mid:rgba(0,212,255,.4);--magenta:#c850ff;--green:#00ff88;--orange:#ff8c00;--red:#ff3355;--text-primary:#e0f0ff;--text-secondary:rgba(160,200,230,.7);--text-dim:rgba(100,160,210,.5);--font-display:'Orbitron',sans-serif;--font-body:'Rajdhani',sans-serif;--font-mono:'Share Tech Mono',monospace;--navbar-height:56px}
*{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:var(--bg-deep);color:var(--text-primary);font-family:var(--font-body)}body{position:relative}button,input{font:inherit}
.jarvis-app{position:relative;width:100vw;height:100vh;overflow:hidden;background:var(--bg-deep)}
.jarvis-bg{position:absolute;inset:0;background:radial-gradient(ellipse 100% 80% at 50% 50%,rgba(0,30,60,.18),transparent 60%),radial-gradient(ellipse 60% 40% at 50% 55%,rgba(120,0,200,.08),transparent 50%),radial-gradient(circle at 50% 50%,#000a14 0%,#02060e 100%);z-index:0}
.jarvis-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,.4) 70%,rgba(0,0,0,.8) 100%);pointer-events:none;z-index:2}
.scanlines-overlay{position:absolute;inset:0;pointer-events:none;z-index:60;overflow:hidden}.scanlines-overlay:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,200,255,.018) 2px,rgba(0,200,255,.018) 4px)}.scanlines-overlay:after{content:"";position:absolute;top:-100%;left:0;width:100%;height:200%;background:linear-gradient(180deg,transparent,rgba(0,200,255,.035),transparent);animation:scan-line 8s linear infinite}
.jarvis-navbar{position:absolute;top:0;left:0;right:0;height:var(--navbar-height);display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:rgba(4,10,20,.82);border-bottom:1px solid rgba(0,200,255,.12);backdrop-filter:blur(20px);z-index:50}
.nav-left,.nav-logo,.nav-center,.nav-right{display:flex;align-items:center}.nav-left{gap:14px}.nav-logo{gap:10px}.nav-logo-icon{width:36px;height:36px;border-radius:50%;border:2px solid var(--cyan);display:grid;place-items:center;position:relative}.nav-logo-icon:before{content:"";width:14px;height:14px;border-radius:50%;background:radial-gradient(circle,var(--cyan) 30%,transparent 70%);box-shadow:0 0 12px var(--cyan)}.nav-logo-icon:after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1px solid rgba(0,200,255,.3);animation:rotate-slow 10s linear infinite}.nav-title{font:700 18px var(--font-display);letter-spacing:5px}.nav-subtitle{font:9px var(--font-mono);color:var(--text-dim);letter-spacing:2px;margin-top:2px}.nav-center{gap:12px}.nav-status-badge{display:flex;align-items:center;gap:7px;padding:5px 13px;border-radius:20px;font:600 10px var(--font-display);letter-spacing:2px;color:var(--green);border:1px solid rgba(0,255,136,.3);background:rgba(0,255,136,.07)}.status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor;animation:pulse-glow 2s infinite}.nav-right{gap:16px}.nav-clock{font:500 13px var(--font-display);color:var(--text-secondary);letter-spacing:2px}.nav-icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid rgba(0,200,255,.15);background:rgba(0,200,255,.05);display:grid;place-items:center;color:var(--text-secondary);cursor:pointer}.nav-icon-btn:hover{border-color:var(--cyan);color:var(--cyan);box-shadow:0 0 12px rgba(0,200,255,.15)}
.jarvis-panel{position:absolute;background:var(--bg-panel);border:1px solid var(--border-glow);border-radius:12px;backdrop-filter:blur(20px);z-index:10;transition:box-shadow .3s,border-color .3s;animation:panel-in .6s ease-out both;user-select:none;overflow:hidden}.jarvis-panel:hover{border-color:var(--border-active);box-shadow:0 0 20px rgba(0,200,255,.1),inset 0 0 20px rgba(0,200,255,.03)}.jarvis-panel.is-moving{border-color:var(--cyan);box-shadow:0 0 30px rgba(0,200,255,.25);cursor:grabbing!important;z-index:100}
.panel-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(0,200,255,.1);font:600 10px var(--font-display);letter-spacing:2px;color:var(--cyan);user-select:none}.header-dot{width:6px;height:6px;border-radius:50%;background:var(--cyan);box-shadow:0 0 6px var(--cyan);animation:pulse-glow 2s infinite}.panel-body{padding:12px 14px}
.status-widget,.clock-widget,.system-widget{width:240px}.status-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,200,255,.05);font:11px var(--font-mono)}.status-row:last-child{border:0}.status-label{color:var(--text-secondary);display:flex;align-items:center;gap:6px}.status-value{font-weight:500}.online{color:var(--green)}.offline{color:var(--red)}.warning{color:var(--orange)}
.clock-display{text-align:center}.clock-time{font:700 32px var(--font-display);color:var(--cyan);letter-spacing:3px;text-shadow:0 0 20px rgba(0,200,255,.3)}.clock-seconds{font:14px var(--font-display);color:var(--magenta);vertical-align:super;margin-left:3px}.clock-date{font:11px var(--font-mono);color:var(--text-secondary);margin-top:5px;letter-spacing:1px}
.sys-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sys-info-item{text-align:center;padding:9px 4px;background:rgba(0,200,255,.04);border-radius:8px;border:1px solid rgba(0,200,255,.08)}.sys-info-value{font:700 15px var(--font-display);color:var(--cyan);white-space:nowrap}.sys-info-label{font:9px var(--font-mono);color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.command-widget{width:300px;text-align:center}.command-orb-container{width:200px;height:200px;margin:2px auto 0;border-radius:50%;position:relative;cursor:pointer;transition:transform .3s;filter:drop-shadow(0 0 16px rgba(0,200,255,.12))}.command-orb-container:hover{transform:scale(1.04)}.orb-core{position:absolute;inset:18px;border-radius:50%;background:radial-gradient(circle at 38% 35%,rgba(0,120,255,.4),rgba(0,30,80,.55) 35%,rgba(0,5,20,.95) 72%);border:1px solid rgba(0,200,255,.45);box-shadow:inset 0 0 28px rgba(0,200,255,.2),0 0 35px rgba(0,150,255,.12);overflow:hidden}.orb-core:before{content:"";position:absolute;inset:-20%;background:conic-gradient(from 0deg,transparent,rgba(0,212,255,.1),rgba(200,80,255,.55),transparent,rgba(0,212,255,.6),transparent);animation:rotate-slow 6s linear infinite;border-radius:50%}.orb-core:after{content:"";position:absolute;inset:25%;border-radius:50%;background:radial-gradient(circle,rgba(0,220,255,.6),rgba(20,40,130,.2) 45%,transparent 72%);box-shadow:0 0 22px rgba(0,212,255,.6)}.orb-ring{position:absolute;inset:7px;border-radius:50%;border:2px solid transparent;border-top-color:var(--cyan);border-right-color:var(--magenta);animation:rotate-slow 4s linear infinite}.orb-ring.r2{inset:-3px;border-top-color:var(--magenta);border-right-color:var(--cyan);animation-duration:7s;animation-direction:reverse}.orb-ring.r3{inset:29px;border:1px dashed rgba(0,212,255,.45);animation-duration:18s}.orb-glow{position:absolute;inset:-20px;border-radius:50%;background:radial-gradient(circle,rgba(0,200,255,.17),transparent 70%);animation:pulse-glow 3s infinite}.command-widget.listening .orb-core{background:radial-gradient(circle at 38% 35%,rgba(0,255,136,.4),rgba(0,80,80,.5) 40%,rgba(0,5,20,.95) 75%);border-color:rgba(0,255,136,.6);box-shadow:inset 0 0 28px rgba(0,255,136,.2),0 0 38px rgba(0,255,136,.2)}.command-status-text{font:11px var(--font-display);letter-spacing:2px;margin-top:12px;color:var(--text-secondary)}.command-status-text.active{color:var(--green);text-shadow:0 0 10px rgba(0,255,136,.3)}.command-hint{font:10px var(--font-mono);color:var(--text-dim);margin-top:6px}.audio-bars{display:flex;justify-content:center;gap:3px;margin-top:12px;height:32px;align-items:flex-end}.audio-bar{width:4px;min-height:3px;border-radius:2px;background:var(--cyan);height:3px;transition:height .12s}
.terminal-panel{width:420px;height:280px;right:20px;bottom:20px;display:flex;flex-direction:column}.terminal-panel .panel-header{cursor:grab;touch-action:none}.terminal-header-count{margin-left:auto;font:9px var(--font-mono);color:var(--text-dim);letter-spacing:0}.drag-grip{font:13px var(--font-mono);color:var(--text-dim);letter-spacing:0}.terminal-body{flex:1;overflow-y:auto;padding:10px 14px;font:12px/1.7 var(--font-mono);scroll-behavior:smooth;user-select:text}.terminal-line{display:flex;gap:8px;animation:fade-in .3s}.line-type{flex-shrink:0;width:6px;height:6px;border-radius:50%;margin-top:7px;background:var(--cyan);box-shadow:0 0 4px currentColor}.terminal-line.system{color:var(--cyan)}.terminal-line.info{color:var(--text-secondary)}.terminal-line.warning{color:var(--orange)}.terminal-line.error{color:var(--red)}.terminal-line.success{color:var(--green)}.terminal-line.user{color:var(--magenta)}.terminal-line.jarvis{color:var(--cyan)}.terminal-input-row{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid rgba(0,200,255,.1)}.terminal-prompt{font:12px var(--font-mono);color:var(--cyan);white-space:nowrap}.terminal-input{flex:1;min-width:0;background:transparent;border:0;outline:0;font:12px var(--font-mono);color:var(--text-primary);caret-color:var(--cyan);user-select:text}.terminal-input::placeholder{color:var(--text-dim)}
.context-menu{position:fixed;z-index:9999;background:rgba(6,18,38,.97);border:1px solid var(--border-active);border-radius:8px;padding:6px 0;min-width:165px;backdrop-filter:blur(20px);box-shadow:0 8px 32px #0008,0 0 20px #00c8ff1a;animation:fade-in .15s;display:none}.context-menu-item{padding:9px 15px;font:13px var(--font-body);color:var(--text-primary);cursor:pointer}.context-menu-item:hover{background:rgba(0,200,255,.12);color:var(--cyan)}.context-menu-divider{height:1px;background:rgba(0,200,255,.1);margin:4px 0}
#particleCanvas{position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:none}.small-label{color:var(--text-dim);font:9px var(--font-mono);letter-spacing:1px}
@keyframes pulse-glow{0%,100%{opacity:.6}50%{opacity:1}}@keyframes scan-line{0%{transform:translateY(-100%)}100%{transform:translateY(100vh)}}@keyframes fade-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes panel-in{from{opacity:0;translate:0 10px}to{opacity:1;translate:0 0}}@keyframes rotate-slow{from{transform:rotate(0)}to{transform:rotate(360deg)}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@media(max-width:900px){.status-widget{left:12px!important;top:72px!important}.clock-widget{left:12px!important;top:300px!important}.system-widget{left:12px!important;top:440px!important}.status-widget,.clock-widget,.system-widget{width:205px}.command-widget{left:auto!important;right:12px;top:85px!important;transform:none!important;width:240px}.command-orb-container{width:150px;height:150px}.terminal-panel{width:calc(100% - 24px);height:220px;left:12px;right:12px;bottom:12px}.nav-subtitle,.nav-center{display:none}.nav-title{font-size:14px;letter-spacing:3px}.nav-clock{font-size:11px}}
@media(max-width:560px){.jarvis-navbar{padding:0 12px}.nav-logo-icon{width:28px;height:28px}.nav-title{font-size:12px;letter-spacing:2px}.nav-right{gap:8px}.nav-clock{display:none}.status-widget,.clock-widget,.system-widget{width:calc(50% - 18px);left:12px!important}.status-widget{top:70px!important}.clock-widget{top:300px!important}.system-widget{left:auto!important;right:12px;top:300px!important}.command-widget{top:100px!important;right:10px;width:calc(50% - 18px)}.command-orb-container{width:125px;height:125px}.command-hint{font-size:9px}.panel-header{padding:8px 10px;font-size:9px;letter-spacing:1px}.panel-body{padding:9px}.status-row{font-size:9px}.clock-time{font-size:22px}.sys-info-value{font-size:11px}.terminal-panel{height:205px}}
</style>
</head>
<body>
<div class="jarvis-app" id="app">
  <div class="jarvis-bg"></div><canvas id="particleCanvas"></canvas>
  <header class="jarvis-navbar">
    <div class="nav-left"><div class="nav-logo"><div class="nav-logo-icon"></div><div><div class="nav-title">J.A.R.V.I.S.</div><div class="nav-subtitle">PERSONAL AI ASSISTANT</div></div></div></div>
    <div class="nav-center"><div class="nav-status-badge"><span class="status-dot"></span><span id="navStatus">ONLINE</span></div></div>
    <div class="nav-right"><div class="nav-clock" id="navClock">00:00:00</div><button class="nav-icon-btn" id="fullscreenBtn" title="Toggle fullscreen" aria-label="Toggle fullscreen">⛶</button></div>
  </header>
  <div class="jarvis-vignette"></div><div class="scanlines-overlay"></div>
  <section class="jarvis-panel status-widget" id="widget-status" style="left:20px;top:80px">
    <div class="panel-header"><span class="header-dot"></span> STATUS</div><div class="panel-body">
      <div class="status-row"><span class="status-label">▣ System</span><span class="status-value online" id="systemStatus">ONLINE</span></div>
      <div class="status-row"><span class="status-label">◉ J.A.R.V.I.S.</span><span class="status-value online" id="jarvisStatus">ACTIVE</span></div>
      <div class="status-row"><span class="status-label">♩ Microphone</span><span class="status-value offline" id="micStatus">INACTIVE</span></div>
      <div class="status-row"><span class="status-label">⬡ Permissions</span><span class="status-value warning" id="permissionStatus">PENDING</span></div>
      <div class="status-row"><span class="status-label">⌁ API</span><span class="status-value warning" id="apiStatus">CHECKING</span></div>
    </div>
  </section>
  <section class="jarvis-panel clock-widget" id="widget-clock" style="left:20px;top:420px">
    <div class="panel-header"><span class="header-dot"></span> CHRONOS</div><div class="panel-body"><div class="clock-display"><div class="clock-time"><span id="clockHM">00:00</span><span class="clock-seconds" id="clockS">00</span></div><div class="clock-date" id="clockDate">Loading date...</div></div></div>
  </section>
  <section class="jarvis-panel system-widget" id="widget-system" style="left:20px;top:600px">
    <div class="panel-header"><span class="header-dot"></span> SYSTEM INFO</div><div class="panel-body"><div class="sys-info-grid">
      <div class="sys-info-item"><div class="sys-info-value">▰ <span id="battery">87%</span></div><div class="sys-info-label">Battery (sim.)</div></div>
      <div class="sys-info-item"><div class="sys-info-value" style="color:var(--green)">⌁ ON</div><div class="sys-info-label">Wi-Fi (sim.)</div></div>
      <div class="sys-info-item"><div class="sys-info-value" style="color:var(--text-dim)">ᛒ OFF</div><div class="sys-info-label">Bluetooth (sim.)</div></div>
      <div class="sys-info-item"><div class="sys-info-value">◎ LOCAL</div><div class="sys-info-label">Location</div></div>
    </div></div>
  </section>
  <section class="jarvis-panel command-widget" id="widget-command" style="left:50%;top:160px;transform:translateX(-50%)">
    <div class="panel-header"><span class="header-dot"></span> ⚡ J.A.R.V.I.S. CORE</div><div class="panel-body">
      <div class="command-orb-container" id="orbButton" title="Click to activate voice"><div class="orb-glow"></div><div class="orb-ring"></div><div class="orb-ring r2"></div><div class="orb-ring r3"></div><div class="orb-core"></div></div>
      <div class="command-status-text" id="listenText">● CLICK TO ACTIVATE</div><div class="command-hint">Click the orb and talk, or type in the terminal</div>
      <div class="audio-bars" id="audioBars"></div>
    </div>
  </section>
  <section class="jarvis-panel terminal-panel" id="widget-terminal">
    <div class="panel-header" id="terminalHandle" title="Drag to move"><span class="header-dot"></span> ▣ SYSTEM TERMINAL <span class="terminal-header-count" id="lineCount">5 entries</span><span class="drag-grip">⠿</span></div>
    <div class="terminal-body" id="terminalBody"></div>
    <div class="terminal-input-row"><span class="terminal-prompt">jarvis &gt;</span><input id="terminalInput" class="terminal-input" placeholder="Type a command or ask anything..." autocomplete="off" spellcheck="false"></div>
  </section>
  <div class="context-menu" id="contextMenu"><div class="context-menu-item" data-action="move">↕ Move widget</div><div class="context-menu-item" data-action="save">▣ Save position</div><div class="context-menu-divider"></div><div class="context-menu-item" data-action="reset">↺ Reset layout</div></div>
</div>
<script>
(() => {
 const $=id=>document.getElementById(id);
 const body=$('terminalBody'), menu=$('contextMenu');
 let moving=null, moveOffset={x:0,y:0};
 let listening=false, phase='off', micStream=null, audioCtx=null, analyser=null, loopTimer=0;
 let recorder=null, recStart=0, lastVoice=0, noise=0.01, speaking=false, stopSpeech=null;
 let history=[];
 const VAD={minStart:0.035,minStop:0.02,silenceMs:1100,minSpeechMs:450,maxMs:20000};
 const defaults={status:{left:'20px',top:'80px'},clock:{left:'20px',top:'420px'},system:{left:'20px',top:'600px'},command:{left:'50%',top:'160px',transform:'translateX(-50%)'},terminal:{left:'',top:'',right:'',bottom:'',transform:''}};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));

 // ---------- Terminal ----------
 function addLine(type,text){
  const row=document.createElement('div');row.className='terminal-line '+type;
  const dot=document.createElement('span');dot.className='line-type';
  const msg=document.createElement('span');msg.textContent=text;
  row.append(dot,msg);body.append(row);
  while(body.children.length>150)body.removeChild(body.firstChild);
  $('lineCount').textContent=body.children.length+' entries';
  body.scrollTop=body.scrollHeight;
 }
 [
 ['system','╔══════════════════════════════════════════╗'],
 ['system','║   J.A.R.V.I.S. System Initialized       ║'],
 ['system','║   Version 4.0.0 — Online                ║'],
 ['system','╚══════════════════════════════════════════╝'],
 ['info','All subsystems nominal. Awaiting input...']
 ].forEach(x=>addLine(x[0],x[1]));

 function setJarvis(text,cls){$('jarvisStatus').textContent=text;$('jarvisStatus').className='status-value '+cls}
 function setListenText(text,active){$('listenText').textContent=text;$('listenText').classList.toggle('active',!!active)}

 // ---------- Clock ----------
 function tick(){
  const d=new Date(),p=n=>String(n).padStart(2,'0');
  $('navClock').textContent=p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  $('clockHM').textContent=p(d.getHours())+':'+p(d.getMinutes());
  $('clockS').textContent=p(d.getSeconds());
  $('clockDate').textContent=d.toLocaleDateString('en-US',{weekday:'short',year:'numeric',month:'short',day:'numeric'});
 }
 tick();setInterval(tick,1000);

 // ---------- Audio bars ----------
 const bars=$('audioBars');
 for(let i=0;i<24;i++){const b=document.createElement('div');b.className='audio-bar';bars.append(b)}
 function setBar(i,level){const bar=bars.children[i];const dist=Math.abs(i-12)/12;const l=level*(1-dist*.45);bar.style.height=Math.max(3,l*36)+'px';bar.style.opacity=.35+l*.65}
 function setBars(level){for(let i=0;i<bars.children.length;i++)setBar(i,level)}
 setInterval(()=>{if(!speaking)return;for(let i=0;i<bars.children.length;i++)setBar(i,.25+Math.random()*.75)},90);

 // ---------- Local commands ----------
 const siteCommands={google:'https://www.google.com',youtube:'https://www.youtube.com',instagram:'https://www.instagram.com',facebook:'https://www.facebook.com',github:'https://github.com',gmail:'https://mail.google.com',reddit:'https://www.reddit.com',x:'https://x.com',twitter:'https://x.com',linkedin:'https://www.linkedin.com',whatsapp:'https://web.whatsapp.com',telegram:'https://web.telegram.org',discord:'https://discord.com/app',spotify:'https://open.spotify.com',netflix:'https://www.netflix.com',amazon:'https://www.amazon.com',wikipedia:'https://www.wikipedia.org',maps:'https://maps.google.com',stackoverflow:'https://stackoverflow.com',chatgpt:'https://chatgpt.com'};
 function parseCommand(text){
  const t=text.toLowerCase().replace(/\b(dong|ya|aja|saja|please|sir|bos|tolong|deh|jarvis)\b/g,' ').trim();
  const m=t.match(/(?:open|launch|go to|navigate to|search for|show me|play|buka|bukain|bukakan|jalankan|putar)(?: the)?(?: app)?\s+(.+)/i);
  if(!m)return [];
  return m[1].split(/\s*(?:,|\band\b|\bdan\b|\balso\b|\bplus\b|\bthen\b|\blalu\b)\s*/)
   .map(p=>p.trim().replace(/[^a-z0-9]/g,''))
   .filter((n,i,a)=>siteCommands[n]&&a.indexOf(n)===i)
   .map(n=>({name:n,url:siteCommands[n]}));
 }

 // ---------- Speak (Edge TTS dari server) ----------
 function browserSpeak(text){
  return new Promise(resolve=>{
   if(!('speechSynthesis' in window)){resolve();return}
   window.speechSynthesis.cancel();
   const u=new SpeechSynthesisUtterance(text);u.rate=1.05;u.pitch=.8;
   u.onend=u.onerror=()=>resolve();
   window.speechSynthesis.speak(u);
  });
 }
 async function speak(text){
  speaking=true;
  setJarvis('SPEAKING','warning');
  setListenText('● SPEAKING',true);
  try{
   const r=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})});
   if(!r.ok){let m='TTS gagal';try{m=(await r.json()).error||m}catch(e){}throw new Error(m)}
   const url=URL.createObjectURL(await r.blob());
   await new Promise(resolve=>{
    const a=new Audio(url);
    const done=()=>{stopSpeech=null;URL.revokeObjectURL(url);resolve()};
    stopSpeech=()=>{a.pause();done()};
    a.onended=done;a.onerror=done;
    a.play().catch(e=>{addLine('warning','Audio diblokir browser: '+e.message);done()});
   });
  }catch(e){
   addLine('warning','TTS server gagal ('+e.message+'), pakai suara browser.');
   await browserSpeak(text);
  }finally{
   speaking=false;
   setJarvis('ACTIVE','online');
   if(listening)setListenText('● LISTENING',true);else setListenText('● CLICK TO ACTIVATE',false);
   if(!listening)setBars(0);
  }
 }

 // ---------- Otak (Gemini via server) ----------
 async function askJarvis(msg){
  setJarvis('THINKING','warning');
  setListenText('● THINKING...',true);
  let reply='';
  try{
   const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,history:history.slice(-12)})});
   const d=await r.json();
   if(!r.ok)throw new Error(d.error||'Chat gagal');
   reply=d.reply;
  }catch(e){
   addLine('error',e.message);
   setJarvis('ACTIVE','online');
   if(listening)setListenText('● LISTENING',true);else setListenText('● CLICK TO ACTIVATE',false);
   return;
  }
  history.push({role:'user',text:msg},{role:'model',text:reply});
  history=history.slice(-20);
  addLine('jarvis','🤖 '+reply);
  await speak(reply);
 }

 async function handleUserText(text,fromVoice){
  const clean=text.trim();if(!clean)return;
  addLine('user',(fromVoice?'🎤 ':'> ')+clean);
  const low=clean.toLowerCase().replace(/[.!?]+$/,'');
  if(low==='help'||low==='commands'){addLine('info','Commands: open/buka YouTube, Google, GitHub..., clear, time, reset. Selain itu, tanya apa saja ke JARVIS.');return}
  if(low==='clear'){body.innerHTML='';$('lineCount').textContent='0 entries';addLine('success','Terminal cleared.');return}
  if(low==='time'){addLine('jarvis','Local time: '+new Date().toLocaleString());return}
  if(low==='reset'){history=[];addLine('success','Memori percakapan direset.');return}
  const cmds=parseCommand(clean);
  if(cmds.length){
   cmds.forEach(c=>{
    const w=window.open(c.url,'_blank','noopener,noreferrer');
    if(w===null&&false)addLine('warning','Popup diblokir.');
    addLine('success','Opening '+c.name+' — '+c.url);
   });
   const msg='Right away. Opening '+cmds.map(c=>c.name).join(' and ')+'.';
   addLine('jarvis','🤖 '+msg);
   await speak(msg);
   return;
  }
  await askJarvis(clean);
 }

 // input terminal (ketik)
 $('terminalInput').addEventListener('keydown',async e=>{
  if(e.key!=='Enter')return;
  const v=e.target.value;e.target.value='';
  if(!v.trim())return;
  const own=listening&&phase==='idle';
  if(own)phase='busy';
  try{await handleUserText(v,false)}
  finally{if(own&&listening)phase='idle'}
 });

 // ---------- Voice loop (VAD + Whisper) ----------
 function pickMime(){
  const types=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'];
  for(const t of types){if(window.MediaRecorder&&MediaRecorder.isTypeSupported(t))return t}
  return '';
 }
 function beginRecording(now){
  const chunks=[];
  const mt=pickMime();
  let rec;
  try{rec=mt?new MediaRecorder(micStream,{mimeType:mt}):new MediaRecorder(micStream)}
  catch(e){addLine('error','MediaRecorder error: '+e.message);return}
  recorder=rec;rec.discard=false;
  rec.ondataavailable=ev=>{if(ev.data&&ev.data.size>0)chunks.push(ev.data)};
  rec.onstop=async()=>{
   if(rec.discard||!listening)return;
   const mime=rec.mimeType||'audio/webm';
   const speechMs=lastVoice-recStart;
   const blob=new Blob(chunks,{type:mime});
   try{
    if(speechMs<VAD.minSpeechMs||blob.size<1500)return;
    setJarvis('TRANSCRIBING','warning');
    setListenText('● TRANSCRIBING...',true);
    const r=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':mime},body:blob});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Transkripsi gagal');
    const text=(d.text||'').trim();
    if(text.length<2)return;
    await handleUserText(text,true);
   }catch(e){
    addLine('error','Whisper: '+e.message);
   }finally{
    setJarvis('ACTIVE','online');
    if(listening){await sleep(350);phase='idle';setListenText('● LISTENING',true)}
   }
  };
  rec.start();
  phase='recording';recStart=now;lastVoice=now;
  setListenText('● HEARING YOU',true);
 }
 function endRecording(){
  phase='busy';
  if(recorder&&recorder.state==='recording'){try{recorder.stop()}catch(e){}}
 }
 function monitor(){
  if(!listening||!analyser)return;
  const td=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(td);
  let sum=0;for(let i=0;i<td.length;i++){const v=(td[i]-128)/128;sum+=v*v}
  const rms=Math.sqrt(sum/td.length);
  if(!speaking){
   const fd=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(fd);
   let avg=0;for(let i=0;i<fd.length;i++)avg+=fd[i];avg/=fd.length;
   setBars(Math.min(1,avg/255*2.2));
  }
  const now=performance.now();
  if(phase==='idle'){
   noise=noise*0.97+rms*0.03;
   if(rms>Math.max(VAD.minStart,noise*2.5))beginRecording(now);
  }else if(phase==='recording'){
   if(rms>Math.max(VAD.minStop,noise*1.6))lastVoice=now;
   if(now-lastVoice>VAD.silenceMs||now-recStart>VAD.maxMs)endRecording();
  }
 }
 function setListening(on){
  $('widget-command').classList.toggle('listening',on);
  setListenText(on?'● LISTENING':'● CLICK TO ACTIVATE',on);
  $('micStatus').textContent=on?'LISTENING':'INACTIVE';
  $('micStatus').className='status-value '+(on?'online':'offline');
  $('permissionStatus').textContent=on?'GRANTED':'PENDING';
  $('permissionStatus').className='status-value '+(on?'online':'warning');
 }
 async function startListening(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||!window.MediaRecorder){
   addLine('error','Browser tidak mendukung mikrofon (buka lewat localhost atau HTTPS).');return;
  }
  try{
   micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
  }catch(e){
   addLine('error','Microphone error: '+e.message);
   $('permissionStatus').textContent='DENIED';$('permissionStatus').className='status-value offline';
   return;
  }
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  try{await audioCtx.resume()}catch(e){}
  analyser=audioCtx.createAnalyser();analyser.fftSize=1024;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  listening=true;phase='idle';noise=0.01;
  setListening(true);
  loopTimer=setInterval(monitor,60);
  addLine('success','Microphone activated — silakan bicara, saya mendengarkan.');
 }
 function stopListening(){
  listening=false;phase='off';
  clearInterval(loopTimer);
  if(recorder){recorder.discard=true;try{if(recorder.state==='recording')recorder.stop()}catch(e){}}
  if(micStream)micStream.getTracks().forEach(t=>t.stop());
  if(audioCtx){try{audioCtx.close()}catch(e){}}
  micStream=null;audioCtx=null;analyser=null;recorder=null;
  setListening(false);
  if(!speaking)setBars(0);
  addLine('warning','Voice recognition deactivated.');
 }
 $('orbButton').addEventListener('click',()=>{
  if(speaking&&stopSpeech){stopSpeech();return}
  if(listening)stopListening();else startListening();
 });
 $('fullscreenBtn').addEventListener('click',()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();else document.exitFullscreen&&document.exitFullscreen()});

 // ---------- Layout: simpan / pulihkan posisi ----------
 function savePos(el){
  localStorage.setItem('jarvis-pos-'+el.id,JSON.stringify({left:el.style.left,top:el.style.top,right:el.style.right,bottom:el.style.bottom,transform:el.style.transform}));
 }

 // Context menu (move / save / reset) untuk semua widget
 let targetWidget=null;
 document.querySelectorAll('.jarvis-panel').forEach(el=>el.addEventListener('contextmenu',e=>{e.preventDefault();targetWidget=el;menu.style.display='block';menu.style.left=Math.min(e.clientX,innerWidth-180)+'px';menu.style.top=Math.min(e.clientY,innerHeight-135)+'px'}));
 document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.style.display='none'});
 menu.addEventListener('click',e=>{
  const item=e.target.closest('[data-action]');if(!item||!targetWidget)return;
  const action=item.dataset.action;menu.style.display='none';
  if(action==='move'){moving=targetWidget;moving.classList.add('is-moving');const r=moving.getBoundingClientRect();moveOffset.x=e.clientX-r.left;moveOffset.y=e.clientY-r.top;addLine('info','Move mode enabled for '+moving.id+'. Drag the widget, then right-click and save.')}
  if(action==='save'){savePos(targetWidget);targetWidget.classList.remove('is-moving');moving=null;addLine('success','Position saved for '+targetWidget.id)}
  if(action==='reset'){
   document.querySelectorAll('.jarvis-panel').forEach(el=>{
    localStorage.removeItem('jarvis-pos-'+el.id);
    const key=el.id.replace('widget-','');
    if(defaults[key])Object.assign(el.style,defaults[key]);
    el.classList.remove('is-moving');
   });
   moving=null;addLine('info','Widget layout reset.');
  }
 });
 document.addEventListener('mousemove',e=>{if(!moving)return;moving.style.left=(e.clientX-moveOffset.x)+'px';moving.style.top=(e.clientY-moveOffset.y)+'px';moving.style.right='auto';moving.style.bottom='auto';moving.style.transform='none'});
 document.addEventListener('mouseup',()=>{if(moving)moving.classList.remove('is-moving')});
 document.querySelectorAll('.jarvis-panel').forEach(el=>{const saved=localStorage.getItem('jarvis-pos-'+el.id);if(saved){try{Object.assign(el.style,JSON.parse(saved))}catch(e){}}});

 // ---------- System Terminal: geser langsung lewat header ----------
 const term=$('widget-terminal'), handle=$('terminalHandle');
 let drag=null;
 function clampTerminal(){
  if(!term.style.left||term.style.left==='auto')return;
  const w=term.offsetWidth,h=term.offsetHeight;
  const x=Math.max(0,Math.min(parseFloat(term.style.left)||0,innerWidth-w));
  const y=Math.max(56,Math.min(parseFloat(term.style.top)||0,innerHeight-h));
  term.style.left=x+'px';term.style.top=y+'px';
 }
 handle.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  const r=term.getBoundingClientRect();
  drag={id:e.pointerId,dx:e.clientX-r.left,dy:e.clientY-r.top};
  term.style.left=r.left+'px';term.style.top=r.top+'px';
  term.style.right='auto';term.style.bottom='auto';term.style.transform='none';
  term.classList.add('is-moving');
  try{handle.setPointerCapture(e.pointerId)}catch(err){}
  e.preventDefault();
 });
 handle.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  const w=term.offsetWidth,h=term.offsetHeight;
  const x=Math.max(0,Math.min(e.clientX-drag.dx,innerWidth-w));
  const y=Math.max(56,Math.min(e.clientY-drag.dy,innerHeight-h));
  term.style.left=x+'px';term.style.top=y+'px';
 });
 function endDrag(e){
  if(!drag||(e&&e.pointerId!==drag.id))return;
  drag=null;term.classList.remove('is-moving');
  savePos(term);
 }
 handle.addEventListener('pointerup',endDrag);
 handle.addEventListener('pointercancel',endDrag);
 clampTerminal();
 addEventListener('resize',clampTerminal);

 // ---------- Ambient particles ----------
 const canvas=$('particleCanvas'),ctx=canvas.getContext('2d');let particles=[];
 function resize(){canvas.width=innerWidth*devicePixelRatio;canvas.height=innerHeight*devicePixelRatio;canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);particles=Array.from({length:Math.min(180,Math.floor(innerWidth*innerHeight/6500))},()=>({x:Math.random()*innerWidth,y:Math.random()*innerHeight,r:Math.random()*1.5+.3,a:Math.random()*.65+.15,s:Math.random()*.28+.08,p:Math.random()*6.28}))}
 function draw(){ctx.clearRect(0,0,innerWidth,innerHeight);for(const p of particles){p.y-=p.s;p.x+=Math.sin(p.p+=.003)*.15;if(p.y<0)p.y=innerHeight;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(0,200,255,'+(p.a*(.7+.3*Math.sin(p.p)))+')';ctx.shadowBlur=8;ctx.shadowColor='#00d4ff';ctx.fill()}ctx.shadowBlur=0;requestAnimationFrame(draw)}
 addEventListener('resize',resize);resize();draw();

 // Simulated battery display
 let battery=87;setInterval(()=>{if(Math.random()>.7)battery=Math.max(5,battery-1);$('battery').textContent=battery+'%'},30000);

 // ---------- Cek status API server ----------
 fetch('/api/health').then(r=>r.json()).then(h=>{
  const el=$('apiStatus');
  if(h.groq&&h.gemini){el.textContent='CONNECTED';el.className='status-value online';addLine('success','API ready — Whisper: '+h.whisper+' | Gemini: '+h.gemini_model+' | Edge TTS')}
  else{
   el.textContent=(h.groq||h.gemini)?'PARTIAL':'NO KEY';el.className='status-value '+((h.groq||h.gemini)?'warning':'offline');
   if(!h.groq)addLine('warning','GROQ_API_KEY belum diisi — suara (Whisper) nonaktif, tapi terminal tetap jalan.');
   if(!h.gemini)addLine('warning','GEMINI_API_KEY belum diisi — JARVIS belum bisa menjawab.');
  }
 }).catch(()=>{$('apiStatus').textContent='OFFLINE';$('apiStatus').className='status-value offline';addLine('error','Tidak bisa menghubungi server.')});
})();
</script>
</body>
</html>`;

// ---------- Start ----------
initClients()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log("==============================================");
      console.log(" J.A.R.V.I.S. ONLINE -> http://" + HOST + ":" + PORT);
      console.log(" STT   : Groq " + GROQ_MODEL + (groq ? "" : "  (NONAKTIF: tidak ada API key)"));
      console.log(" Otak  : Gemini " + GEMINI_MODEL + (ai ? "" : "  (NONAKTIF: tidak ada API key)"));
      console.log(" Suara : Edge TTS " + VOICE_EN + " / " + VOICE_ID);
      console.log("==============================================");
    });
  })
  .catch((err) => {
    console.error("Gagal start:", err);
    process.exit(1);
  });