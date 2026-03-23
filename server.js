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
const DID_CUSTOM_LLM_KEY = process.env.DID_CUSTOM_LLM_KEY || "ray-secret-key-111";

// ===============================
//  MEMORY STORE
// ===============================
const userSchedules = new Map();

// ===============================
//  MIDDLEWARE
// ===============================
app.use(cors({ origin: "*" }));
app.use(express.json());

// ===============================
//  HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("ProjectPilot backend running.");
});

// ===============================
//  DEBUG ROUTE
// ===============================
app.get("/api/did-llm", (req, res) => {
  res.send("D-ID LLM endpoint is live. Use POST.");
});

// ===============================
//  REQUIRED: MODELS ENDPOINT
// ===============================
app.get("/models", (req, res) => {
  res.json({
    data: [
      {
        id: "gpt-4.1-mini",
        object: "model",
        owned_by: "projectpilot"
      }
    ]
  });
});

// ====================================================================================
//  CHAT ENDPOINT
// ====================================================================================
app.post("/api/chat", async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";
    const message = req.body?.message || "";

    const userSchedule = userSchedules.get(userId);

    const systemPrompt = `
You are Ray, an expert project management coach.

USER CONTEXT:
${userSchedule ? `
The user uploaded a schedule. Use this analysis:

${userSchedule.analysis}
` : `
No schedule uploaded yet.
`}

Be specific. Never vague.
`.trim();

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      })
    });

    const data = await aiResponse.json();

    res.json({
      reply: data.choices[0].message.content
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ====================================================================================
//  FILE UPLOAD
// ====================================================================================
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const csvText = req.file.buffer.toString("utf-8");

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true
    });

    const trimmed = records.slice(0, 120);
    const headers = Object.keys(trimmed[0]);

    const compactCsv = [
      headers.join(","),
      ...trimmed.map(r =>
        headers.map(h => (r[h] || "").replace(/,/g, ";")).join(",")
      )
    ].join("\n");

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "Analyze this schedule and be very specific with tasks, dates, and risks."
          },
          {
            role: "user",
            content: compactCsv
          }
        ]
      })
    });

    const data = await aiResponse.json();
    const analysis = data.choices[0].message.content;

    userSchedules.set(userId, {
      uploadedAt: new Date().toISOString(),
      analysis
    });

    res.json({ analysis });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ====================================================================================
//  D-ID CUSTOM LLM
// ====================================================================================
app.post("/api/did-llm", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];

    if (apiKey !== DID_CUSTOM_LLM_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const messages = req.body?.messages || [];

    const lastUserMessage =
      [...messages].reverse().find(m => m.role === "user")?.content || "";

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are Ray, a project coach." },
          { role: "user", content: lastUserMessage }
        ]
      })
    });

    const data = await aiResponse.json();

    res.json({
      content: data.choices[0].message.content
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "LLM error" });
  }
});

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`ProjectPilot backend running on port ${PORT}`);
});
