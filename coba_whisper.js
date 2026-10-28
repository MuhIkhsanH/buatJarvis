import "dotenv/config";
import express from "express";
import Groq from "groq-sdk";
import { toFile } from "groq-sdk/uploads";

const app = express();
const PORT = 3000;
const MODEL = "whisper-large-v3";

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY belum ada di file .env");
  process.exit(1);
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Whisper Voice Test</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      max-width: 720px;
      margin: 40px auto;
      padding: 0 18px;
      background: #f5f5f5;
      color: #222;
    }
    h1 { margin-bottom: 6px; }
    .sub { color: #666; margin-top: 0; }
    .panel {
      background: white;
      padding: 22px;
      border-radius: 14px;
      border: 1px solid #ddd;
      margin-top: 20px;
    }
    button {
      border: 0;
      border-radius: 9px;
      padding: 12px 18px;
      font-size: 15px;
      cursor: pointer;
      margin: 5px 5px 5px 0;
    }
    #start { background: #176b43; color: white; }
    #stop { background: #b42318; color: white; }
    #copy { background: #e8e8e8; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    #status { margin-top: 15px; color: #555; }
    #result {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      min-height: 120px;
      padding: 15px;
      background: #fafafa;
      border: 1px solid #ddd;
      border-radius: 9px;
      line-height: 1.6;
    }
    .model {
      display: inline-block;
      background: #e5f3eb;
      color: #176b43;
      padding: 5px 9px;
      border-radius: 6px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <h1>Whisper Voice Test</h1>
  <p class="sub">Rekam suara, lalu ubah menjadi teks.</p>
  <span class="model">Groq · whisper-large-v3</span>

  <section class="panel">
    <h3>Rekaman</h3>
    <button id="start">Mulai merekam</button>
    <button id="stop" disabled>Berhenti</button>
    <p id="status">Siap. Tekan tombol mulai untuk menggunakan mikrofon.</p>
    <audio id="audio" controls hidden></audio>
  </section>

  <section class="panel">
    <h3>Hasil transkripsi</h3>
    <div id="result">Hasil teks akan muncul di sini.</div>
    <button id="copy" disabled>Salin teks</button>
  </section>

<script>
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const audioEl = document.getElementById("audio");
const copyBtn = document.getElementById("copy");

let recorder;
let stream;
let chunks = [];

function setStatus(text) {
  statusEl.textContent = text;
}

startBtn.addEventListener("click", async () => {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Browser tidak menyediakan akses mikrofon.");
    }

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];

    const types = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];

    let options = {};
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        options = { mimeType: type };
        break;
      }
    }

    recorder = new MediaRecorder(stream, options);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());

      const mimeType =
        recorder.mimeType || chunks[0]?.type || "audio/webm";
      const blob = new Blob(chunks, { type: mimeType });

      if (!blob.size) {
        setStatus("Rekaman kosong. Coba rekam lagi.");
        return;
      }

      audioEl.src = URL.createObjectURL(blob);
      audioEl.hidden = false;

      setStatus("Mengirim audio ke Groq...");
      startBtn.disabled = true;
      stopBtn.disabled = true;

      try {
        const response = await fetch("/transcribe", {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: blob
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Transkripsi gagal.");
        }

        resultEl.textContent = data.text || "(Tidak ada teks terdeteksi)";
        copyBtn.disabled = !data.text;
        setStatus("Selesai! Model: " + data.model);
      } catch (error) {
        setStatus("Gagal: " + error.message);
      } finally {
        startBtn.disabled = false;
      }
    };

    recorder.start();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    copyBtn.disabled = true;
    resultEl.textContent = "";
    setStatus("Sedang merekam... Silakan bicara.");
  } catch (error) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    setStatus("Tidak bisa mulai merekam: " + error.message);
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener("click", () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    stopBtn.disabled = true;
    setStatus("Memproses rekaman...");
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(resultEl.textContent);
    setStatus("Teks berhasil disalin.");
  } catch {
    setStatus("Gagal menyalin. Silakan salin teks secara manual.");
  }
});
</script>
</body>
</html>`);
});

app.post(
  "/transcribe",
  express.raw({ type: "*/*", limit: "25mb" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          error: "Audio kosong atau tidak diterima.",
        });
      }

      const contentType = (req.headers["content-type"] || "")
        .split(";")[0]
        .toLowerCase();

      const extensions = {
        "audio/webm": "webm",
        "audio/ogg": "ogg",
        "audio/mp4": "mp4",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
      };

      const extension = extensions[contentType];

      if (!extension) {
        return res.status(400).json({
          error: "Format audio tidak didukung: " + contentType,
        });
      }

      console.log(
        "Menerima audio:",
        extension,
        (req.body.length / 1024).toFixed(1) + " KB"
      );

      const file = await toFile(
        req.body,
        "rekaman." + extension,
        { type: contentType }
      );

      const transcription = await groq.audio.transcriptions.create({
        file,
        model: MODEL,
        language: "id",
        response_format: "json",
      });

      console.log("Transkripsi selesai.");

      res.json({
        text: transcription.text,
        model: MODEL,
      });
    } catch (error) {
      console.error("Transkripsi error:", error.message);

      res.status(500).json({
        error: error.status === 413
          ? "Audio terlalu besar untuk diproses."
          : "Groq gagal memproses audio. Periksa koneksi, kuota, dan log terminal.",
      });
    }
  }
);

app.listen(PORT, "127.0.0.1", () => {
  console.log("Server berjalan di http://127.0.0.1:" + PORT);
  console.log("Model transkripsi:", MODEL);
});
