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

const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-ai.filesusr.com",
  "https://renaeliving.wixsite.com",
  "https://renaeliving-wixsite-com.filesusr.com",
  "https://projectpilot-frontend.onrender.com",
  "https://renaeliving.github.io",
  "https://ray-voice.onrender.com",
  "https://ray-app.onrender.com",
  "https://try-ray.onrender.com",
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

app.get("/", (req, res) => {
  res.send("ProjectPilot backend is running.");
});

function cleanTextForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function generateElevenLabsAudio(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !text) {
    return null;
  }

  const speechText = cleanTextForSpeech(text);

  if (!speechText) {
    return null;
  }

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
          text: speechText,
          model_id: "eleven_flash_v2_5",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.85,
            speed: 1.18,
          },
        }),
      }
    );

    if (!ttsRes.ok) {
      console.error("ElevenLabs error:", await ttsRes.text());
      return null;
    }

    const arrayBuffer = await ttsRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
  } catch (e) {
    console.error("Error calling ElevenLabs:", e);
    return null;
  }
}

async function transcribeAudioBuffer(buffer, filename = "voice.webm", mimeType = "audio/webm") {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY on server.");
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || "audio/webm" });

  form.append("file", blob, filename);
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "en");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("OpenAI transcription error:", text);
    throw new Error("Transcription failed");
  }

  const data = await response.json();
  return (data?.text || "").trim();
}

function ensureProjectSaved(userId, projectName) {
  if (!projectName) return;

  if (!userProjects.has(userId)) {
    userProjects.set(userId, []);
  }

  const existingProjects = userProjects.get(userId);
  if (!existingProjects.includes(projectName)) {
    existingProjects.push(projectName);
    existingProjects.sort((a, b) => a.localeCompare(b));
  }
}

function getScheduleHint(userId, projectName) {
  const savedSchedule = projectName
    ? uploadedSchedules.get(`${userId}::${projectName}`)
    : null;

  if (!savedSchedule) return "";

  return `

The user has uploaded a schedule for project "${projectName}".

Use the uploaded schedule naturally as part of the ongoing conversation when the user asks about:
- schedule quality
- milestones
- dates
- dependencies
- risks
- sequencing
- task ownership
- timeline concerns

Uploaded file name: ${savedSchedule.fileName || "schedule.csv"}
Uploaded at: ${savedSchedule.uploaded_at || "unknown"}

Saved schedule analysis:
${savedSchedule.analysis}

Saved schedule preview:
${savedSchedule.raw_schedule_preview}
`;
}

function getRaySystemPrompt(scheduleHint = "", options = {}) {
  const { voiceMode = false, previewMode = false } = options;

  return `
You are "Ray", an AI Project Management Coach for project managers using the ProjectPilot website.

STYLE RULES:
- Be friendly, clear, warm, and encouraging.
- Explain project management concepts in simple language.
- Use short paragraphs.
- Use bullet points when helpful, but do not overdo them.
- Use markdown when it helps clarity, especially bullets, headings, and simple tables.
- Focus on practical "what do I do next" advice.
- Sound conversational, not robotic.
- Treat short follow-up questions as part of the ongoing conversation unless the user clearly changes topics.
${previewMode ? "- This is a short public preview experience.\n" : ""}${voiceMode ? `- This is voice mode. Keep answers short and natural to say aloud.
- Default to 1 or 2 short sentences unless the user explicitly asks for detail.
- For very simple questions, answer very briefly.\n` : ""}${scheduleHint}
`.trim();
}

async function runRayChat({ userId, projectName, message, includeAudio = true, voiceMode = false }) {
  ensureProjectSaved(userId, projectName);

  const historyKey = `${userId}::${projectName || "general"}`;
  const priorMessages = chatHistories.get(historyKey) || [];
  const scheduleHint = getScheduleHint(userId, projectName);

  const messages = [
    { role: "system", content: getRaySystemPrompt(scheduleHint, { voiceMode }) },
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
      temperature: voiceMode ? 0.35 : 0.5,
      max_tokens: voiceMode ? 90 : 500,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("OpenAI chat error:", text);
    throw new Error("OpenAI chat failed");
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

  const result = { reply };

  if (includeAudio) {
    result.audioBase64 = await generateElevenLabsAudio(reply);
  }

  return result;
}

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
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const body = req.body || {};
    const userId = (body.userId || "anonymous").toString().trim();
    const message = (body.message || "").toString().trim();

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const currentCount = tryRayCounts.get(userId) || 0;
    const includeAudio = body.includeAudio !== false;
    const voiceMode = !!body.voiceMode;

    if (currentCount >= 30) {
      return res.json({
        reply: "You’ve used your 10 free Try Ray questions. Please sign up for full Ray access to continue.",
        limitReached: true,
        audioBase64: null,
      });
    }

    const systemPrompt = getRaySystemPrompt("", {
      previewMode: true,
      voiceMode,
    });

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
        temperature: voiceMode ? 0.35 : 0.5,
        max_tokens: voiceMode ? 90 : 350,
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

    let audioBase64 = null;
    if (includeAudio) {
      audioBase64 = await generateElevenLabsAudio(reply);
    }

    return res.json({
      reply,
      audioBase64,
      limitReached: newCount >= 10,
      remainingQuestions: Math.max(0, 30 - newCount),
    });
  } catch (err) {
    console.error("Try Ray error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ===============================
// SPEAK ONLY ENDPOINT
// ===============================
app.post("/api/speak", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();

    if (!text) {
      return res.status(400).json({ error: "Text is required." });
    }

    const audioBase64 = await generateElevenLabsAudio(text);
    return res.json({ audioBase64 });
  } catch (err) {
    console.error("Speak error:", err);
    return res.status(500).json({ error: "Speak failed", detail: err.message });
  }
});

// ===============================
// VOICE CHAT ENDPOINT
// ===============================
app.post("/api/voice-chat", upload.single("audio"), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const userId = (req.body?.userId || "anonymous").toString().trim();
    const projectName = (req.body?.projectName || "").toString().trim();

    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({ error: "No audio uploaded." });
    }

    const transcript = await transcribeAudioBuffer(
      req.file.buffer,
      req.file.originalname || "voice.webm",
      req.file.mimetype || "audio/webm"
    );

    if (!transcript) {
      return res.status(400).json({ error: "Could not transcribe audio." });
    }

    const result = await runRayChat({
      userId,
      projectName,
      message: transcript,
      includeAudio: false,
      voiceMode: true,
    });

    return res.json({
      transcript,
      reply: result.reply,
    });
  } catch (err) {
    console.error("Voice chat error:", err);
    return res.status(500).json({ error: "Voice chat failed", detail: err.message });
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
        headers.map((h) => String(row[h] ?? "").replace(/,/g, ";")).join(",")
      ),
    ].join("\n");

    const systemPrompt = `
You are Ray, an expert project schedule reviewer.

CRITICAL RULES:
- Always reference specific task names when available.
- Always reference dates when available.
- Always reference dependencies when available.
- Never be vague.
- Write the response like Ray is speaking directly to the user in the chat.
- Use markdown when it helps clarity, especially headings, bullets, and simple tables.

Identify:
1. Overall assessment
2. Specific schedule issues
3. Top risks
4. Recommended actions

End with 2-3 suggestions for what the user could ask next.
Use clear headings and practical advice.
`.trim();

    const userPrompt = `
Analyze this project schedule CSV for project "${projectName}":

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

    ensureProjectSaved(userId, projectName);

    const uploadKey = `${userId}::${projectName}`;
    const uploadedAt = new Date().toISOString();

    uploadedSchedules.set(uploadKey, {
      analysis,
      raw_schedule_preview: compactCsv,
      records: trimmed,
      fileName: req.file.originalname || "schedule.csv",
      uploaded_at: uploadedAt,
    });

    const historyKey = `${userId}::${projectName || "general"}`;
    const priorMessages = chatHistories.get(historyKey) || [];
    const assistantMessage = `I reviewed your uploaded schedule for "${projectName}".\n\n${analysis}`;

    const updatedHistory = [
      ...priorMessages,
      { role: "assistant", content: assistantMessage },
    ].slice(-12);

    chatHistories.set(historyKey, updatedHistory);

    const audioBase64 = await generateElevenLabsAudio(assistantMessage);

    return res.json({
      success: true,
      reply: assistantMessage,
      audioBase64,
      projectName,
      fileName: req.file.originalname || "schedule.csv",
      uploadedAt,
    });
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
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
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

    const includeAudio = body.includeAudio !== false;
    const voiceMode = !!body.voiceMode;

    if (!message) {
      return res.json({
        reply: "Hi, I’m Ray. Tell me about your project and I’ll help you think through risks, priorities, and next steps.",
        audioBase64: null,
      });
    }

    const result = await runRayChat({
      userId,
      projectName,
      message,
      includeAudio,
      voiceMode,
    });

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ProjectPilot backend listening on port ${PORT}`);
});
