// ===============================
//  IMPORTS
// ===============================
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import { parse } from "csv-parse/sync";

// ===============================
//  CONFIG
// ===============================
const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();

// Allowed domains for CORS (Wix + Render)
const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-frontend.onrender.com",
  "https://renaeliving.wixsite.com",
  "https://renaeliving-wixsite-com.filesusr.com",
  "https://projectpilot-ai.filesusr.com"
].filter(Boolean);

// ===============================
//  MIDDLEWARE
// ===============================
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // SSR or server-to-server
      const ok = ALLOWED_ORIGINS.includes(origin);
      return ok ? cb(null, true) : cb(new Error("CORS blocked: " + origin));
    },
  })
);

app.use(express.json());

// ===============================
//  HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("ProjectPilot backend is running.");
});

// ====================================================================================
//  CHAT ENDPOINT — AERO RESPONDS USING OPENAI (+ optional ElevenLabs TTS)
// ====================================================================================
app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    let message = "";
    if (typeof req.body?.message === "string") {
      message = req.body.message.trim();
    }

    if (!message) {
      return res.json({
        reply: "Hi, I’m Aero! Tell me about your project.",
        audioBase64: null
      });
    }

    const systemPrompt = `
You are Aero, an expert project management coach.
Be clear, helpful, friendly, and provide practical advice.
Use bullet points and short paragraphs.
When helpful, generate small simple schedule tables in markdown.
`.trim();

    // ---- OpenAI Request ----
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      }),
    });

    if (!aiResponse.ok) {
      const text = await aiResponse.text();
      console.error("OpenAI error:", text);
      return res.status(500).json({ error: "OpenAI API failed", detail: text });
    }

    const data = await aiResponse.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to respond to that.";

    // ====================================================================================
    //  ELEVENLABS TTS (OPTIONAL)
    // ====================================================================================
    let audioBase64 = null;

    if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
      try {
        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": ELEVENLABS_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text: reply,
              model_id: "eleven_multilingual_v2",
              voice_settings: {
                stability: 0.6,
                similarity_boost: 0.85
              },
            }),
          }
        );

        if (ttsRes.ok) {
          const buffer = Buffer.from(await ttsRes.arrayBuffer());
          audioBase64 = buffer.toString("base64");
        }
      } catch (e) {
        console.error("ElevenLabs error:", e);
      }
    }

    return res.json({ reply, audioBase64 });
  } catch (err) {
    console.error("Chat server error:", err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ====================================================================================
//  FILE UPLOAD — CSV SCHEDULE ANALYSIS
// ====================================================================================

// In-memory file storage (max 5 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // Parse CSV
    const csvText = req.file.buffer.toString("utf-8");

    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
      });
    } catch (e) {
      return res.status(400).json({
        error: "Could not parse CSV. Ensure it's a valid exported schedule."
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: "CSV contains no data." });
    }

    // Limit rows sent to OpenAI
    const MAX_ROWS = 120;
    const trimmed = records.slice(0, MAX_ROWS);

    const headers = Object.keys(trimmed[0]);
    const headerLine = headers.join(",");

    const rows = trimmed.map((row) =>
      headers.map((h) =>
        (row[h] ?? "")
          .toString()
          .replace(/[\n\r]+/g, " ")
          .replace(/,/g, ";")
      ).join(",")
    );

    const compactCsv = [headerLine, ...rows].join("\n");

    // OpenAI prompt
    const systemPrompt = `
You are Aero, an expert PM coach.
You will be given a project schedule in CSV form.

Return:
1. A 2–4 sentence overall assessment.
2. A markdown table with the top 8–12 risks:

| ID | Risk | Why it matters | Suggested mitigation | Likelihood | Impact |
`.trim();

    const userPrompt = `
Here is the project schedule (CSV):

${compactCsv}
`.trim();

    // ---- OpenAI Analysis Call ----
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
      }),
    });

    if (!aiResponse.ok) {
      const text = await aiResponse.text();
      console.error("OpenAI schedule error:", text);
      return res.status(500).json({
        error: "OpenAI schedule analysis error",
        detail: text
      });
    }

    const data = await aiResponse.json();
    const analysis = data?.choices?.[0]?.message?.content?.trim() ||
      "I could not generate an analysis.";

    return res.json({ analysis });
  } catch (err) {
    console.error("Schedule upload error:", err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`ProjectPilot backend running on port ${PORT}`);
});
