import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import { parse } from "csv-parse/sync";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();

// Simple in-memory stores
const tryRayCounts = new Map();
const userProjects = new Map();
const uploadedSchedules = new Map();
const chatHistories = new Map();


// Allow Wix + Render + GitHub Pages frontend origins
const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-ai.filesusr.com",
  "https://renaeliving.wixsite.com",
  "https://renaeliving-wixsite-com.filesusr.com",
  "https://projectpilot-frontend.onrender.com",
  "https://renaeliving.github.io"
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      const ok = ALLOWED_ORIGINS.some((allowed) => origin === allowed);
      if (ok) return callback(null, true);

      return callback(new Error("Not allowed by CORS: " + origin));
    },
  })
);

app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

app.get("/", (req, res) => {
  res.send("ProjectPilot backend is running.");
});

// ===============================
// PROJECT LIST
// ===============================
app.get("/api/projects", (req, res) => {
  try {
    const userId = (req.query.userId || "").toString().trim();

    if (!userId) {
      return res.status(400).json({ error: "Missing userId." });
    }

    const projects = userProjects.get(userId) || [];

    return res.json({
      projects: projects.map((name) => ({
        id: name,
        name,
        updated_at: new Date().toISOString(),
      })),
    });
  } catch (err) {
    console.error("Project list error:", err);
    return res.status(500).json({ error: "Could not load projects." });
  }
});

// ===============================
// TRY RAY DEMO ENDPOINT
// ===============================
app.post("/api/try-ray", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const body = req.body || {};
    const userId = (body.userId || "anonymous").toString().trim();
    const message = (body.message || "").toString().trim();

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const currentCount = tryRayCounts.get(userId) || 0;

    if (currentCount >= 10) {
      return res.json({
        reply:
          "You’ve used your 10 free Try Ray questions. Please sign up for full Ray access to continue.",
        limitReached: true,
      });
    }

    const systemPrompt = `
You are Ray, a friendly AI project coach giving a short public preview.

STYLE RULES:
- Be warm, clear, practical, and conversational.
- Answer like a real coach, not like a stiff help desk.
- Help with project risks, priorities, planning, timelines, and next steps.
- Keep responses useful and easy to understand.
- If a user asks a short follow-up, assume they are continuing the same topic unless it is clearly a new one.
- This is a short public preview experience.
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI API error:", text);
      return res.status(500).json({ error: "OpenAI API error", detail: text });
    }

    const data = await response.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to respond to that.";

    const newCount = currentCount + 1;
    tryRayCounts.set(userId, newCount);

    return res.json({
      reply,
      limitReached: newCount >= 10,
      remainingQuestions: Math.max(0, 10 - newCount),
    });
  } catch (err) {
    console.error("Try Ray error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ===============================
// UPLOAD SCHEDULE
// ===============================
app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const userId = (req.body?.userId || "anonymous").toString().trim();
    const projectName = (req.body?.projectName || "").toString().trim();

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    if (!projectName) {
      return res.status(400).json({ error: "Project name is required." });
    }

    const csvText = req.file.buffer.toString("utf-8");

    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
      });
    } catch (e) {
      return res.status(400).json({ error: "Could not parse CSV." });
    }

    if (!records.length) {
      return res.status(400).json({ error: "CSV contains no data." });
    }

    const trimmed = records.slice(0, 120);
    const headers = Object.keys(trimmed[0] || {});

    const compactCsv = [
      headers.join(","),
      ...trimmed.map((row) =>
        headers
          .map((h) => String(row[h] ?? "").replace(/,/g, ";"))
          .join(",")
      ),
    ].join("\n");

    const systemPrompt = `
You are Ray, an expert project schedule reviewer.

CRITICAL RULES:
- Always reference specific task names when available.
- Always reference dates when available.
- Always reference dependencies when available.
- Never be vague.

Identify:
1. Overall assessment
2. Specific schedule issues
3. Top risks
4. Recommended actions

Use clear headings and practical advice.
`.trim();

    const userPrompt = `
Analyze this project schedule CSV:

${compactCsv}
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI upload analysis error:", text);
      return res.status(500).json({ error: "OpenAI API error", detail: text });
    }

    const data = await response.json();
    const analysis =
      data?.choices?.[0]?.message?.content?.trim() || "No analysis returned.";

    if (!userProjects.has(userId)) {
      userProjects.set(userId, []);
    }

    const existingProjects = userProjects.get(userId);
    if (!existingProjects.includes(projectName)) {
      existingProjects.push(projectName);
      existingProjects.sort((a, b) => a.localeCompare(b));
    }

    uploadedSchedules.set(`${userId}::${projectName}`, {
      analysis,
      raw_schedule_preview: compactCsv,
      uploaded_at: new Date().toISOString(),
    });

    return res.json({ analysis });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed", detail: err.message });
  }
});

// ===============================
// MAIN RAY CHAT ENDPOINT
// ===============================
app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const body = req.body || {};
    const userId = (body.userId || "anonymous").toString().trim();
    const projectName = (body.projectName || "").toString().trim();

    let message = "";
    if (typeof body.message === "string") {
      message = body.message.trim();
    } else if (typeof body.text === "string") {
      message = body.text.trim();
    }

    if (!message) {
      return res.json({
        reply:
          "Hi, I’m Ray. Tell me about your project and I’ll help you think through risks, priorities, and next steps.",
        audioBase64: null,
      });
    }

    if (projectName) {
      if (!userProjects.has(userId)) {
        userProjects.set(userId, []);
      }
      const existingProjects = userProjects.get(userId);
      if (!existingProjects.includes(projectName)) {
        existingProjects.push(projectName);
        existingProjects.sort((a, b) => a.localeCompare(b));
      }
    }

    const savedSchedule = projectName
      ? uploadedSchedules.get(`${userId}::${projectName}`)
      : null;

    const scheduleHint = savedSchedule
      ? `

The user has uploaded a schedule for project "${projectName}".
Use this saved schedule analysis only if the question is about schedule, milestones, dates, dependencies, risks, tasks, owners, or timeline details.

Saved schedule analysis:
${savedSchedule.analysis}
`
      : "";

const systemPrompt = `
You are "Ray", an AI Project Management Coach for project managers using the ProjectPilot website.

STYLE RULES:
- Be friendly, clear, warm, and encouraging.
- Explain project management concepts in simple language.
- Use short paragraphs.
- Use bullet points when helpful, but do not overdo them.
- Focus on practical "what do I do next" advice.
- Sound conversational, not robotic.
- Treat short follow-up questions as part of the ongoing conversation unless the user clearly changes topics.
${scheduleHint}
`.trim();

const historyKey = `${userId}::${projectName || "general"}`;
const priorMessages = chatHistories.get(historyKey) || [];

const messages = [
  { role: "system", content: systemPrompt },
  ...priorMessages,
  { role: "user", content: message },
];

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.5,
  }),
});

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI API error:", text);
      return res.status(500).json({ error: "OpenAI API error", detail: text });
    }

    const data = await response.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to respond to that.";

    const updatedHistory = [
  ...priorMessages,
  { role: "user", content: message },
  { role: "assistant", content: reply },
].slice(-12);

chatHistories.set(historyKey, updatedHistory);

    let audioBase64 = null;

    if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
      console.log("Calling ElevenLabs TTS with reply length:", reply.length);
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
                similarity_boost: 0.85,
              },
            }),
          }
        );

        if (ttsRes.ok) {
          const arrayBuffer = await ttsRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          audioBase64 = buffer.toString("base64");
        } else {
          console.error("ElevenLabs error:", await ttsRes.text());
        }
      } catch (e) {
        console.error("Error calling ElevenLabs:", e);
      }
    } else {
      console.log(
        "Skipping ElevenLabs TTS. HasKey:",
        !!ELEVENLABS_API_KEY,
        "HasVoice:",
        !!ELEVENLABS_VOICE_ID
      );
    }

    return res.json({ reply, audioBase64 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ProjectPilot backend listening on port ${PORT}`);
});
