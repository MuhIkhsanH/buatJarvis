require("dotenv").config();

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY belum diisi di .env");
  }

  const { GoogleGenAI } = await import("@google/genai");

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  console.log("Menghubungi Gemini 3.1 Flash-Lite...\n");

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite",
    contents: "Perkenalkan dirimu sebagai JARVIS dalam 2 kalimat.",
  });

  console.log("JARVIS:", response.text);
}

main().catch((err) => {
  console.error("Gemini error:", err.message);
  process.exitCode = 1;
});