import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { prisma } from "./prismaClient.js";
import { supabaseAdmin } from "./supabaseClient.js";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();
const DID_CUSTOM_LLM_KEY = process.env.DID_CUSTOM_LLM_KEY || "ray-secret-key-111";
const TRY_RAY_LIMIT = 30;
const TRY_RAY_HISTORY_LIMIT = 10;

const tryRayCounts = new Map();
const tryRayHistories = new Map();
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
  "https://ray-coach.onrender.com",
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

app.use(express.json({ limit: "4mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function getInboundApiKey(req) {
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey) return xApiKey;

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }

  return null;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.text) return part.text;
        return JSON.stringify(part);
      })
      .join("\n");
  }

  if (content == null) return "";
  return String(content);
}
function getTryRayHistory(userId) {
  const cleanUserId = (userId || "anonymous").toString().trim() || "anonymous";
  return tryRayHistories.get(cleanUserId) || [];
}

function saveTryRayTurn(userId, userMessage, assistantReply) {
  const cleanUserId = (userId || "anonymous").toString().trim() || "anonymous";
  const existingHistory = tryRayHistories.get(cleanUserId) || [];

  const updatedHistory = [
    ...existingHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantReply },
  ].slice(-TRY_RAY_HISTORY_LIMIT);

  tryRayHistories.set(cleanUserId, updatedHistory);
}
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

function isScheduleRelatedQuestion(message) {
  const text = (message || "").toLowerCase();
  const keywords = [
    "schedule",
    "timeline",
    "milestone",
    "milestones",
    "dependency",
    "dependencies",
    "predecessor",
    "successor",
    "critical path",
    "task",
    "tasks",
    "owner",
    "resource",
    "start date",
    "finish date",
    "due date",
    "deadline",
    "slip",
    "delay",
    "gantt",
    "sequence",
    "sequencing",
    "csv",
    "upload",
    "plan",
  ];
  return keywords.some((k) => text.includes(k));
}

async function callOpenAI(messages, temperature = 0.4, maxTokens = 500) {
  const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!aiResponse.ok) {
    const text = await aiResponse.text();
    throw new Error(`OpenAI error: ${text}`);
  }

  return aiResponse.json();
}

async function generateElevenLabsAudio(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !text) {
    return null;
  }

  const speechText = cleanTextForSpeech(text);
  if (!speechText) return null;

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
  stability: 0.55,
  similarity_boost: 0.85,
  speed: 1.03,
},
        }),
      }
    );

    if (!ttsRes.ok) {
      console.error("ElevenLabs error:", await ttsRes.text());
      return null;
    }

    const arrayBuffer = await ttsRes.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
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

async function upsertDbUser(externalUserId) {
  return prisma.user.upsert({
    where: { external_user_id: externalUserId },
    update: { last_seen_at: new Date() },
    create: {
      external_user_id: externalUserId,
      last_seen_at: new Date(),
    },
  });
}

async function getOrCreateProjectForUser(dbUserId, projectName) {
  const cleanName = (projectName || "").trim();
  if (!cleanName) return null;

  const existing = await prisma.project.findFirst({
    where: {
      user_id: dbUserId,
      name: cleanName,
    },
  });

  if (existing) return existing;

  return prisma.project.create({
    data: {
      user_id: dbUserId,
      name: cleanName,
      status: "active",
    },
  });
}

function conversationTitleForProject(projectName) {
  return (projectName || "").trim() || "General";
}

async function getOrCreateConversation(dbUserId, projectName, project = null) {
  const title = conversationTitleForProject(projectName);

  let conversation = await prisma.conversation.findFirst({
    where: {
      user_id: dbUserId,
      title,
      status: "active",
    },
    orderBy: { updated_at: "desc" },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        user_id: dbUserId,
        title,
        status: "active",
        ...(project ? { project_id: project.id } : {}),
      },
    });
  } else if (project && !conversation.project_id) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { project_id: project.id },
    });
  }

  return conversation;
}

async function getLatestScheduleAnalysis(dbUserId, conversationId = null, projectId = null) {
  let latestAnalysis = null;

  if (projectId) {
    latestAnalysis = await prisma.scheduleAnalysis.findFirst({
      where: {
        user_id: dbUserId,
        project_id: projectId,
      },
      orderBy: { created_at: "desc" },
      include: { uploaded_file: true },
    });
  }

  if (!latestAnalysis && conversationId) {
    latestAnalysis = await prisma.scheduleAnalysis.findFirst({
      where: {
        user_id: dbUserId,
        conversation_id: conversationId,
      },
      orderBy: { created_at: "desc" },
      include: { uploaded_file: true },
    });
  }

  if (!latestAnalysis) {
    latestAnalysis = await prisma.scheduleAnalysis.findFirst({
      where: { user_id: dbUserId },
      orderBy: { created_at: "desc" },
      include: { uploaded_file: true },
    });
  }

  return latestAnalysis;
}

async function getRecentMessages(conversationId, limit = 12) {
  const rows = await prisma.message.findMany({
    where: { conversation_id: conversationId },
    orderBy: { created_at: "desc" },
    take: limit,
  });

  return rows.reverse().map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

async function saveMessage(conversationId, userId, role, content) {
  await prisma.message.create({
    data: {
      conversation_id: conversationId,
      user_id: userId,
      role,
      content,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updated_at: new Date() },
  });
}

async function upsertUserProfileMemory(dbUserId, message) {
  const text = (message || "").trim();
  if (!text) return;

  const patterns = [
    { regex: /i prefer ([^.\n]+)/i, type: "preference", keyPrefix: "prefer" },
    { regex: /i like ([^.\n]+)/i, type: "preference", keyPrefix: "like" },
    { regex: /i dislike ([^.\n]+)/i, type: "preference", keyPrefix: "dislike" },
    { regex: /my role is ([^.\n]+)/i, type: "profile", keyPrefix: "role" },
    { regex: /i work best ([^.\n]+)/i, type: "working_style", keyPrefix: "working_style" },
  ];

  for (const p of patterns) {
    const match = text.match(p.regex);
    if (!match) continue;
    const value = match[1].trim();
    const key = `${p.keyPrefix}:${value.toLowerCase().slice(0, 80)}`;

    const existing = await prisma.userProfileMemory.findFirst({
      where: {
        user_id: dbUserId,
        memory_key: key,
      },
    });

    if (existing) {
      await prisma.userProfileMemory.update({
        where: { id: existing.id },
        data: {
          memory_value: value,
          updated_at: new Date(),
        },
      });
    } else {
      await prisma.userProfileMemory.create({
        data: {
          user_id: dbUserId,
          memory_type: p.type,
          memory_key: key,
          memory_value: value,
          source: "chat",
        },
      });
    }
  }
}

function extractIssueTitle(message) {
  const text = (message || "").trim();
  const patterns = [
    /(?:blocked by|blocked on)\s+(.+)/i,
    /waiting for\s+(.+)/i,
    /delayed because\s+(.+)/i,
    /issue[:\-]?\s+(.+)/i,
    /problem[:\-]?\s+(.+)/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().slice(0, 180);
  }

  if (/blocked|delay|issue|problem|not ready|stuck/i.test(text)) {
    return text.slice(0, 180);
  }

  return null;
}

function extractRiskTitle(message) {
  const text = (message || "").trim();
  const patterns = [
    /risk (?:is|that)?\s+(.+)/i,
    /worried (?:that )?(.+)/i,
    /concerned (?:that )?(.+)/i,
    /might\s+(.+)/i,
    /could\s+(.+)/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().slice(0, 180);
  }

  if (/risk|worried|concern|could|might|slip/i.test(text)) {
    return text.slice(0, 180);
  }

  return null;
}

function extractDateInfo(message) {
  const text = message || "";
  const match = text.match(
    /(?:due by|due on|by|on|meeting on|milestone on)\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/i
  );
  if (!match) return null;

  const parsed = new Date(match[1]);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    title: text.slice(0, 180),
    date_value: parsed,
    date_type: /meeting/i.test(text)
      ? "meeting"
      : /milestone/i.test(text)
      ? "milestone"
      : "deadline",
  };
}

async function saveIssueIfNeeded(dbUserId, conversationId, message, projectId = null) {
  const title = extractIssueTitle(message);
  if (!title) return;

  const existing = await prisma.issue.findFirst({
    where: {
      user_id: dbUserId,
      conversation_id: conversationId,
      title,
    },
    orderBy: { created_at: "desc" },
  });

  if (existing) {
    await prisma.issue.update({
      where: { id: existing.id },
      data: {
        last_discussed_at: new Date(),
        updated_at: new Date(),
      },
    });
  } else {
    await prisma.issue.create({
      data: {
        user_id: dbUserId,
        conversation_id: conversationId,
        ...(projectId ? { project_id: projectId } : {}),
        title,
        description: message,
      },
    });
  }
}

async function saveRiskIfNeeded(dbUserId, conversationId, message, projectId = null) {
  const title = extractRiskTitle(message);
  if (!title) return;

  const existing = await prisma.risk.findFirst({
    where: {
      user_id: dbUserId,
      conversation_id: conversationId,
      title,
    },
    orderBy: { created_at: "desc" },
  });

  if (existing) {
    await prisma.risk.update({
      where: { id: existing.id },
      data: {
        last_discussed_at: new Date(),
        updated_at: new Date(),
      },
    });
  } else {
    await prisma.risk.create({
      data: {
        user_id: dbUserId,
        conversation_id: conversationId,
        ...(projectId ? { project_id: projectId } : {}),
        title,
        description: message,
      },
    });
  }
}

async function saveKeyDateIfNeeded(dbUserId, conversationId, message, projectId = null) {
  const info = extractDateInfo(message);
  if (!info) return;

  const existing = await prisma.keyDate.findFirst({
    where: {
      user_id: dbUserId,
      conversation_id: conversationId,
      title: info.title,
      date_value: info.date_value,
    },
  });

  if (!existing) {
    await prisma.keyDate.create({
      data: {
        user_id: dbUserId,
        conversation_id: conversationId,
        ...(projectId ? { project_id: projectId } : {}),
        title: info.title,
        date_type: info.date_type,
        date_value: info.date_value,
      },
    });
  }
}

async function saveMemoryArtifacts(dbUserId, conversationId, message, reply, projectId = null) {
  await Promise.allSettled([
    upsertUserProfileMemory(dbUserId, message),
    saveIssueIfNeeded(dbUserId, conversationId, message, projectId),
    saveRiskIfNeeded(dbUserId, conversationId, message, projectId),
    saveKeyDateIfNeeded(dbUserId, conversationId, message, projectId),
  ]);

  await prisma.memorySummary.create({
    data: {
      user_id: dbUserId,
      conversation_id: conversationId,
      summary_type: "chat_turn",
      summary: `${message}\n\nAssistant reply:\n${reply}`.slice(0, 4000),
      source_range: "latest_turn",
    },
  });
}

function buildSystemPrompt({ latestAnalysis, voiceMode = false, previewMode = false, useScheduleContext = false }) {
  const scheduleBlock =
    latestAnalysis && useScheduleContext
      ? `
USER CONTEXT:
The user has uploaded a project schedule.
Use the saved analysis and raw schedule preview when the question is about schedule, milestones, dates, dependencies, risks, sequencing, task ownership, or timeline concerns.

Saved analysis:
${latestAnalysis.analysis}

Raw schedule preview:
${latestAnalysis.raw_schedule_preview || ""}
`
      : `
USER CONTEXT:
Use general project coaching unless the user specifically asks about their uploaded schedule.
`;

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
${previewMode ? "- This is a short public preview experience.\n" : ""}${voiceMode ? "- This is voice mode. Keep answers short and natural to say aloud.\n- Default to 1 or 2 short sentences unless the user explicitly asks for detail.\n- For very simple questions, answer very briefly.\n" : ""}${scheduleBlock}
`.trim();
}

async function runRayChat({ externalUserId, projectName, message, includeAudio = true, voiceMode = false }) {
  const dbUser = await upsertDbUser(externalUserId || "anonymous");
  const project = await getOrCreateProjectForUser(dbUser.id, projectName);
  const conversation = await getOrCreateConversation(dbUser.id, projectName, project);
  const latestAnalysis = await getLatestScheduleAnalysis(
    dbUser.id,
    conversation.id,
    project?.id || null
  );
  const useScheduleContext = isScheduleRelatedQuestion(message);
  const priorMessages = await getRecentMessages(conversation.id, 12);

  const messages = [
    {
      role: "system",
      content: buildSystemPrompt({
        latestAnalysis,
        voiceMode,
        previewMode: false,
        useScheduleContext,
      }),
    },
    ...priorMessages,
    { role: "user", content: message },
  ];

  const data = await callOpenAI(
    messages,
    voiceMode ? 0.35 : 0.5,
    voiceMode ? 90 : 500
  );

  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    "I’m not sure how to respond to that.";

  await saveMessage(conversation.id, dbUser.id, "user", message);
  await saveMessage(conversation.id, dbUser.id, "assistant", reply);
  await saveMemoryArtifacts(
    dbUser.id,
    conversation.id,
    message,
    reply,
    project?.id || null
  );

  const result = { reply };

  if (includeAudio) {
    result.audioBase64 = await generateElevenLabsAudio(reply);
  }

  return result;
}

app.get("/", (req, res) => {
  res.send("ProjectPilot backend is running.");
});

app.get("/api/test-supabase", async (req, res) => {
  try {
    const dbTest = await prisma.$queryRaw`select now() as current_time`;
    const { data, error } = await supabaseAdmin.storage.listBuckets();

    if (error) {
      throw new Error(`Supabase storage error: ${error.message}`);
    }

    res.json({
      ok: true,
      database: dbTest,
      buckets: data,
    });
  } catch (err) {
    console.error("Supabase test error:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.get("/api/debug-schedule/:userId", async (req, res) => {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { external_user_id: req.params.userId },
    });

    if (!dbUser) {
      return res.json({ userId: req.params.userId, saved: null });
    }

    const latestAnalysis = await prisma.scheduleAnalysis.findFirst({
      where: { user_id: dbUser.id },
      orderBy: { created_at: "desc" },
    });

    res.json({
      userId: req.params.userId,
      saved: latestAnalysis || null,
    });
  } catch (err) {
    console.error("Debug schedule error:", err);
    res.status(500).json({ error: "Debug lookup failed" });
  }
});

app.get("/api/projects", async (req, res) => {
  try {
    const userId = (req.query.userId || "").toString().trim();

    if (!userId) {
      return res.status(400).json({ error: "Missing userId." });
    }

    const dbUser = await prisma.user.findUnique({
      where: { external_user_id: userId },
    });

    if (!dbUser) {
      return res.json({ projects: [] });
    }

    const projects = await prisma.project.findMany({
      where: { user_id: dbUser.id },
      orderBy: { updated_at: "desc" },
      select: {
        id: true,
        name: true,
        updated_at: true,
      },
    });

    return res.json({ projects });
  } catch (err) {
    console.error("Project list error:", err);
    return res.status(500).json({ error: "Could not load projects." });
  }
});

app.post("/api/try-ray", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const body = req.body || {};
    const userId = (body.userId || "anonymous").toString().trim();
    const message = (body.message || "").toString().trim();
    const includeAudio = body.includeAudio !== false;
    const voiceMode = !!body.voiceMode;

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const currentCount = tryRayCounts.get(userId) || 0;

    if (currentCount >= TRY_RAY_LIMIT) {
      return res.json({
        reply: `You’ve used your ${TRY_RAY_LIMIT} free Try Ray questions. Please sign up for full Ray access to continue.`,
        limitReached: true,
        audioBase64: null,
        remainingQuestions: 0,
      });
    }

    const systemPrompt = buildSystemPrompt({
      latestAnalysis: null,
      previewMode: true,
      voiceMode,
      useScheduleContext: false,
    });

    const priorTryRayMessages = getTryRayHistory(userId);

const data = await callOpenAI(
  [
    { role: "system", content: systemPrompt },
    ...priorTryRayMessages,
    { role: "user", content: message },
  ],
  voiceMode ? 0.35 : 0.5,
  voiceMode ? 90 : 350
);

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to respond to that.";

    const newCount = currentCount + 1;
tryRayCounts.set(userId, newCount);
saveTryRayTurn(userId, message, reply);

    let audioBase64 = null;
    if (includeAudio) {
      audioBase64 = await generateElevenLabsAudio(reply);
    }

    return res.json({
      reply,
      audioBase64,
      limitReached: newCount >= TRY_RAY_LIMIT,
      remainingQuestions: Math.max(0, TRY_RAY_LIMIT - newCount),
    });
  } catch (err) {
    console.error("Try Ray error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.post("/api/try-ray-voice", upload.single("audio"), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const userId = (req.body?.userId || "anonymous").toString().trim();
    const currentCount = tryRayCounts.get(userId) || 0;

    if (currentCount >= TRY_RAY_LIMIT) {
      return res.json({
        reply: `You’ve used your ${TRY_RAY_LIMIT} free Try Ray questions. Please sign up for full Ray access to continue.`,
        transcript: "",
        limitReached: true,
        remainingQuestions: 0,
      });
    }

    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({ error: "No audio uploaded." });
    }

    const transcript = await transcribeAudioBuffer(
      req.file.buffer,
      req.file.originalname || "voice.webm",
      req.file.mimetype || "audio/webm"
    );

    const systemPrompt = buildSystemPrompt({
      latestAnalysis: null,
      previewMode: true,
      voiceMode: true,
      useScheduleContext: false,
    });

  const priorTryRayMessages = getTryRayHistory(userId);

const data = await callOpenAI(
  [
    { role: "system", content: systemPrompt },
    ...priorTryRayMessages,
    { role: "user", content: transcript },
  ],
  0.35,
  90
);

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to respond to that.";

    const newCount = currentCount + 1;
tryRayCounts.set(userId, newCount);
saveTryRayTurn(userId, transcript, reply);

    return res.json({
      transcript,
      reply,
      limitReached: newCount >= TRY_RAY_LIMIT,
      remainingQuestions: Math.max(0, TRY_RAY_LIMIT - newCount),
    });
  } catch (err) {
    console.error("Try Ray voice error:", err);
    return res.status(500).json({ error: "Try Ray voice failed", detail: err.message });
  }
});

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
      externalUserId: userId,
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
      externalUserId: userId,
      projectName,
      message,
      includeAudio,
      voiceMode,
    });

    return res.json(result);
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const externalUserId = (req.body?.userId || "anonymous").toString().trim();
    const projectName = (req.body?.projectName || "").toString().trim();

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    if (!projectName) {
      return res.status(400).json({ error: "Project name is required." });
    }

    const dbUser = await upsertDbUser(externalUserId);
    const project = await getOrCreateProjectForUser(dbUser.id, projectName);
    const conversation = await getOrCreateConversation(dbUser.id, projectName, project);

    const uploadedFile = await prisma.uploadedFile.create({
      data: {
        user_id: dbUser.id,
        conversation_id: conversation.id,
        ...(project ? { project_id: project.id } : {}),
        filename: req.file.originalname,
        storage_path: `pending/${Date.now()}-${req.file.originalname}`,
        file_type: "schedule",
        mime_type: req.file.mimetype || "text/csv",
        size_bytes: req.file.size || 0,
      },
    });

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

    const data = await callOpenAI(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      0.3,
      900
    );

    const analysis =
      data?.choices?.[0]?.message?.content?.trim() || "No analysis returned.";

    const rawSchedulePreview = compactCsv.slice(0, 6000);

    await prisma.scheduleAnalysis.create({
      data: {
        user_id: dbUser.id,
        conversation_id: conversation.id,
        uploaded_file_id: uploadedFile.id,
        ...(project ? { project_id: project.id } : {}),
        analysis,
        raw_schedule_preview: rawSchedulePreview,
        analysis_version: "v1",
      },
    });

    const assistantMessage = `I reviewed your uploaded schedule for "${projectName}".\n\n${analysis}`;

    await saveMessage(conversation.id, dbUser.id, "assistant", assistantMessage);

    const audioBase64 = await generateElevenLabsAudio(assistantMessage);

    return res.json({
      success: true,
      reply: assistantMessage,
      analysis,
      audioBase64,
      projectName,
      fileName: req.file.originalname || "schedule.csv",
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed", detail: err.message });
  }
});

app.get("/api/openai/models", (req, res) => {
  const apiKey = getInboundApiKey(req);

  if (apiKey !== DID_CUSTOM_LLM_KEY) {
    return res.status(401).json({
      error: {
        message: "Unauthorized",
        code: "401",
        type: "Unauthorized",
        status: 401,
      },
    });
  }

  return res.json({
    object: "list",
    data: [
      {
        id: "gpt-4.1-mini",
        object: "model",
        owned_by: "projectpilot",
      },
    ],
  });
});

app.get("/api/openai/v1/models", (req, res) => {
  const apiKey = getInboundApiKey(req);

  if (apiKey !== DID_CUSTOM_LLM_KEY) {
    return res.status(401).json({
      error: {
        message: "Unauthorized",
        code: "401",
        type: "Unauthorized",
        status: 401,
      },
    });
  }

  return res.json({
    object: "list",
    data: [
      {
        id: "gpt-4.1-mini",
        object: "model",
        owned_by: "projectpilot",
      },
    ],
  });
});

async function handleLegacyOpenAICompat(req, res) {
  try {
    const apiKey = getInboundApiKey(req);

    if (apiKey !== DID_CUSTOM_LLM_KEY) {
      return res.status(401).json({
        error: {
          message: "Unauthorized",
          code: "401",
          type: "Unauthorized",
          status: 401,
        },
      });
    }

    const body = req.body || {};
    const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
    const userId = (body.user || body.userId || "anonymous").toString();

    const dbUser = await upsertDbUser(userId);
    const latestAnalysis = await getLatestScheduleAnalysis(dbUser.id, null, null);

    const forwardedMessages = [
      {
        role: "system",
        content: buildSystemPrompt({
          latestAnalysis,
          voiceMode: false,
          previewMode: false,
          useScheduleContext: true,
        }),
      },
      ...incomingMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({
          role: m.role,
          content: normalizeMessageContent(m.content),
        })),
    ];

    const data = await callOpenAI(forwardedMessages, 0.4, 500);
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I'm not sure how to respond.";

    return res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4.1-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply,
          },
          finish_reason: "stop",
        },
      ],
    });
  } catch (err) {
    console.error("OpenAI-compatible chat error:", err);
    return res.status(500).json({
      error: {
        message: err.message || "Server error",
        code: "500",
        type: "ServerError",
        status: 500,
      },
    });
  }
}

app.post("/api/openai/chat/completions", handleLegacyOpenAICompat);
app.post("/api/openai/v1/chat/completions", handleLegacyOpenAICompat);

app.post("/api/did-llm", async (req, res) => {
  try {
    const apiKey = getInboundApiKey(req);

    if (apiKey !== DID_CUSTOM_LLM_KEY) {
      return res.status(401).json({
        error: {
          message: "Unauthorized",
          code: "401",
          type: "Unauthorized",
          status: 401,
        },
      });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userId = (body.user || body.userId || "anonymous").toString();

    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    const dbUser = await upsertDbUser(userId);
    const latestAnalysis = await getLatestScheduleAnalysis(dbUser.id, null, null);

    const data = await callOpenAI(
      [
        {
          role: "system",
          content: buildSystemPrompt({
            latestAnalysis,
            voiceMode: false,
            previewMode: false,
            useScheduleContext: true,
          }),
        },
        { role: "user", content: normalizeMessageContent(lastUserMessage) },
      ],
      0.4,
      500
    );

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I'm not sure how to respond.";

    return res.json({
      content: reply,
    });
  } catch (err) {
    console.error("Legacy D-ID LLM error:", err);
    res.status(500).json({
      error: {
        message: err.message || "Server error",
        code: "500",
        type: "ServerError",
        status: 500,
      },
    });
  }
});

app.listen(PORT, () => {
  console.log(`ProjectPilot backend listening on port ${PORT}`);
});
