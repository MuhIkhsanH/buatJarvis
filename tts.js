
const express = require("express");
const { EdgeTTS } = require("@andresaya/edge-tts");

const app = express();
const tts = new EdgeTTS();

app.use(express.json());

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <title>JARVIS TTS</title>
    </head>
    <body>
      <h1>JARVIS TTS</h1>
      <textarea id="text">Yes sir. How may I assist you?</textarea>
      <button id="speak">Speak</button>
      <p id="status">Ready</p>
      <audio id="audio" controls></audio>

      <script>
        const text = document.getElementById("text");
        const status = document.getElementById("status");
        const audio = document.getElementById("audio");

        document.getElementById("speak").onclick = async () => {
          status.textContent = "Generating...";

          try {
            const response = await fetch("/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: text.value })
            });

            if (!response.ok) {
              throw new Error(await response.text());
            }

            audio.src = URL.createObjectURL(await response.blob());
            await audio.play();
            status.textContent = "JARVIS ONLINE";
          } catch (err) {
            status.textContent = "ERROR: " + err.message;
          }
        };
      </script>
    </body>
    </html>
  `);
});

app.post("/tts", async (req, res) => {
  try {
    const { text } = req.body;

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text wajib diisi" });
    }

    const result = await tts.generate(
      text.trim(),
      "en-GB-RyanNeural",
      {
        pitch: "-15Hz",
        rate: "-10%"
      }
    );

    res.type("audio/mpeg").send(Buffer.from(result.audio));
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("JARVIS: http://localhost:3000");
  console.log("Endpoint: POST http://localhost:3000/tts");
});
