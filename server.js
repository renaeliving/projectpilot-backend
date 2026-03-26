// ===============================
//  IMPORTS
// ===============================
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { prisma } from "./prismaClient.js";
import { supabaseAdmin } from "./supabaseClient.js";

// ===============================
//  CONFIG
// ===============================
const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DID_CUSTOM_LLM_KEY = process.env.DID_CUSTOM_LLM_KEY || "ray-secret-key-111";

// ===============================
//  MIDDLEWARE
// ===============================
app.use(
  cors({
    origin: "*",
  })
);
app.use(express.json({ limit: "2mb" }));

// ===============================
//  HELPERS
// ===============================
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

function isScheduleRelatedQuestion(message) {
  if (!message) return false;

  const text = message.toLowerCase();

  const scheduleTerms = [
    "schedule",
    "task",
    "tasks",
    "milestone",
    "milestones",
    "dependency",
    "dependencies",
    "predecessor",
    "predecessors",
    "successor",
    "successors",
    "timeline",
    "deadline",
    "deadlines",
    "date",
    "dates",
    "finish date",
    "start date",
    "critical path",
    "deliverable",
    "deliverables",
    "resource",
    "resources",
    "owner",
    "activity",
    "activities",
    "project plan"
  ];

  return scheduleTerms.some((term) => text.includes(term));
}

async function getDbUserByExternalUserId(externalUserId) {
  if (!externalUserId) return null;

  return prisma.user.findUnique({
    where: { external_user_id: externalUserId },
  });
}
function extractUserProfileMemories(message) {
  if (!message) return [];

  const text = message.trim();
  const lower = text.toLowerCase();
  const memories = [];

  const patterns = [
    {
      type: "like",
      regex: /\b(i like|i enjoy|i love)\s+(.+)$/i,
      keyPrefix: "like",
    },
    {
      type: "dislike",
      regex: /\b(i dislike|i do not like|i hate)\s+(.+)$/i,
      keyPrefix: "dislike",
    },
    {
      type: "interest",
      regex: /\b(i am interested in|i'm interested in|my interests include)\s+(.+)$/i,
      keyPrefix: "interest",
    },
    {
      type: "skill",
      regex: /\b(i am good at|i'm good at|my skills include|i have experience in)\s+(.+)$/i,
      keyPrefix: "skill",
    },
    {
      type: "knowledge_area",
      regex: /\b(i know a lot about|i know about|i am knowledgeable about|i'm knowledgeable about)\s+(.+)$/i,
      keyPrefix: "knowledge",
    },
    {
      type: "working_style",
      regex: /\b(i prefer to work|i work best|my working style is)\s+(.+)$/i,
      keyPrefix: "working_style",
    },
    {
      type: "preference",
      regex: /\b(i prefer|i usually prefer)\s+(.+)$/i,
      keyPrefix: "preference",
    },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match && match[2]) {
      const value = match[2].trim().replace(/[.]+$/, "");
      if (value.length > 1) {
        memories.push({
          memory_type: pattern.type,
          memory_key: `${pattern.keyPrefix}:${value.toLowerCase().slice(0, 80)}`,
          memory_value: value,
          confidence: 0.9,
          source: "chat_message",
        });
      }
    }
  }

  if (
    lower.includes("my name is ") ||
    lower.includes("i am ") ||
    lower.includes("i'm ")
  ) {
    // We are not storing generic identity claims here yet.
    // Core identity stays in users; profile memory is for preferences/context.
  }

  return memories;
}
function extractIssuesFromMessage(message) {
  if (!message) return [];

  const text = message.trim();
  const lower = text.toLowerCase();
  const issues = [];

  const issueTriggers = [
    "blocked",
    "stuck",
    "issue",
    "problem",
    "delay",
    "delayed",
    "late",
    "waiting on",
    "waiting for",
    "hasn't",
    "have not",
    "unable to",
    "can't",
    "cannot",
    "not ready",
    "missing",
    "failed",
    "failure"
  ];

  const looksLikeIssue = issueTriggers.some(trigger => lower.includes(trigger));

  if (!looksLikeIssue) {
    return issues;
  }

  let title = text.replace(/[.]+$/, "").trim();
  if (title.length > 120) {
    title = title.slice(0, 120).trim();
  }

  issues.push({
    title,
    description: text,
    status: "open",
    severity: "medium",
    owner: null,
    target_date: null,
  });

  return issues;
}
function extractRisksFromMessage(message) {
  if (!message) return [];

  const text = message.trim();
  const lower = text.toLowerCase();
  const risks = [];

  const riskTriggers = [
    "risk",
    "at risk",
    "might",
    "may",
    "could",
    "concern",
    "worried",
    "worry",
    "possible",
    "potential",
    "chance",
    "likely to",
    "unlikely to",
    "slip",
    "miss the deadline",
    "miss the date",
    "not finish in time",
    "won't finish in time",
    "may not",
    "might not"
  ];

  const looksLikeRisk = riskTriggers.some(trigger => lower.includes(trigger));

  if (!looksLikeRisk) {
    return risks;
  }

  let title = text.replace(/[.]+$/, "").trim();
  if (title.length > 120) {
    title = title.slice(0, 120).trim();
  }

  let likelihood = "medium";
  let impact = "medium";
  let severity = "medium";

  if (
    lower.includes("high risk") ||
    lower.includes("serious risk") ||
    lower.includes("major risk")
  ) {
    likelihood = "high";
    impact = "high";
    severity = "high";
  }

  risks.push({
    title,
    description: text,
    owner: null,
    status: "open",
    likelihood,
    impact,
    severity,
    mitigation: null,
    contingency_plan: null,
  });

  return risks;
}
function extractKeyDatesFromMessage(message) {
  if (!message) return [];

  const text = message.trim();
  const lower = text.toLowerCase();
  const keyDates = [];

  const datePatterns = [
    /\bby\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/,
    /\bon\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/,
    /\bdue\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/,
  ];

  let matchedDateText = null;

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      matchedDateText = match[1].trim();
      break;
    }
  }

  const keyDateTriggers = [
    "milestone",
    "deadline",
    "deliverable",
    "meeting",
    "go-live",
    "golive",
    "review",
    "workshop",
    "cutover",
    "uat",
    "training",
    "launch",
    "due",
    "by ",
    "on "
  ];

  const looksLikeKeyDate = keyDateTriggers.some(trigger => lower.includes(trigger));

  if (!looksLikeKeyDate || !matchedDateText) {
    return keyDates;
  }

  const parsedDate = new Date(matchedDateText);
  if (Number.isNaN(parsedDate.getTime())) {
    return keyDates;
  }

  let dateType = "deadline";
  if (lower.includes("milestone")) dateType = "milestone";
  else if (lower.includes("meeting")) dateType = "meeting";
  else if (lower.includes("deliverable")) dateType = "deliverable";
  else if (lower.includes("review")) dateType = "review";

  let title = text.replace(/[.]+$/, "").trim();
  if (title.length > 120) {
    title = title.slice(0, 120).trim();
  }

  keyDates.push({
    date_type: dateType,
    title,
    date_value: parsedDate,
    actual_date: null,
    outcome: null,
    status: "planned",
    notes: text,
  });

  return keyDates;
}
async function getLatestScheduleAnalysisForExternalUserId(externalUserId) {
  const dbUser = await getDbUserByExternalUserId(externalUserId);
  if (!dbUser) return { dbUser: null, latestAnalysis: null };

  const latestAnalysis = await prisma.scheduleAnalysis.findFirst({
    where: { user_id: dbUser.id },
    orderBy: { created_at: "desc" },
  });

  return { dbUser, latestAnalysis };
}

function buildSystemPrompt(latestAnalysis, useScheduleContext = false) {
  return `
You are Ray, an expert project management coach.

${
  useScheduleContext && latestAnalysis
    ? `
USER CONTEXT:
The user has uploaded a project schedule.
Here is the latest saved schedule analysis:

${latestAnalysis.analysis}

Use this schedule context only when the user's question is actually about the schedule, tasks, dates, milestones, issues, dependencies, owners, deliverables, or project timing.
If the user's question is general and not about the schedule, answer normally and do not force the schedule into the response.
`
    : `
USER CONTEXT:
The user may or may not have uploaded a schedule.
If their question is about schedule analysis, dates, milestones, dependencies, deliverables, risks, or project timing, you can use saved schedule context if available.
If their question is general or unrelated, answer normally without forcing schedule context into the answer.
`
}

UPLOAD REQUIREMENTS:
If the user asks about uploading a schedule, you MUST explain all of this clearly:

Yes — you can upload your schedule as a CSV file.

At a minimum, please include:
- Task Name
- Start Date
- Finish Date
- Dependencies or Predecessors
- Resources

If you want deeper analysis, it also helps to include:
- Duration
- Task ID
- Successors
- Milestones
- Baseline dates
- Percent complete
- Constraints
- Critical path indicators
- Owner or team

The more complete the export, the more specific and useful the feedback will be.

CRITICAL RULES:
- Never give vague answers.
- Never say "it just needs to be a CSV."
- Be specific, practical, and direct.
- Only use saved schedule context when it is relevant to the user's question.
`.trim();
}

async function callOpenAI(messages, temperature = 0.4) {
  const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature,
      messages,
    }),
  });

  if (!aiResponse.ok) {
    const text = await aiResponse.text();
    throw new Error(`OpenAI error: ${text}`);
  }

  return aiResponse.json();
}

// ===============================
//  HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("ProjectPilot backend running.");
});

// ===============================
//  DEBUG ROUTES
// ===============================
app.get("/api/did-llm", (req, res) => {
  res.send("Legacy D-ID endpoint is live. Use POST, not GET.");
});

app.get("/api/openai", (req, res) => {
  res.send("OpenAI-compatible base is live.");
});

app.get("/api/debug-schedule/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    const dbUser = await prisma.user.findUnique({
      where: { external_user_id: userId },
    });

    if (!dbUser) {
      return res.json({ userId, saved: null });
    }

    const latestAnalysis = await prisma.scheduleAnalysis.findFirst({
      where: { user_id: dbUser.id },
      orderBy: { created_at: "desc" },
    });

    res.json({
      userId,
      saved: latestAnalysis || null,
    });
  } catch (err) {
    console.error("Debug schedule error:", err);
    res.status(500).json({ error: "Debug lookup failed" });
  }
});

// ====================================================================================
//  OPENAI-COMPATIBLE ENDPOINTS FOR D-ID (legacy compatibility)
// ====================================================================================
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

app.post("/api/openai/chat/completions", async (req, res) => {
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
    const userId = body.user || body.userId || "anonymous";

    const latestUserMessage =
      [...incomingMessages].reverse().find((m) => m?.role === "user")?.content || "";

    const normalizedLatestUserMessage = normalizeMessageContent(latestUserMessage);
    const shouldUseScheduleContext = isScheduleRelatedQuestion(normalizedLatestUserMessage);

    const { latestAnalysis } = await getLatestScheduleAnalysisForExternalUserId(userId);
    const systemPrompt = buildSystemPrompt(latestAnalysis, shouldUseScheduleContext);

    const forwardedMessages = [
      { role: "system", content: systemPrompt },
      ...(shouldUseScheduleContext && latestAnalysis?.analysis
        ? [
            {
              role: "system",
              content: `SAVED SCHEDULE ANALYSIS FOR THIS USER:

${latestAnalysis.analysis}`,
            },
          ]
        : []),
      ...(shouldUseScheduleContext && latestAnalysis?.raw_schedule_preview
        ? [
            {
              role: "system",
              content: `RAW SCHEDULE CSV PREVIEW FOR THIS USER:

${latestAnalysis.raw_schedule_preview}

Use this raw schedule preview to answer with specific task names, dates, dependencies, and risks whenever possible.
If this data is present and the user is asking a schedule-related question, do not say you cannot see the uploaded schedule.`,
            },
          ]
        : []),
      ...incomingMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({
          role: m.role,
          content: normalizeMessageContent(m.content),
        })),
    ];

    const data = await callOpenAI(forwardedMessages, 0.4);
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
});

app.post("/api/openai/v1/chat/completions", async (req, res) => {
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
    const userId = body.user || body.userId || "anonymous";

    const latestUserMessage =
      [...incomingMessages].reverse().find((m) => m?.role === "user")?.content || "";

    const normalizedLatestUserMessage = normalizeMessageContent(latestUserMessage);
    const shouldUseScheduleContext = isScheduleRelatedQuestion(normalizedLatestUserMessage);

    const { latestAnalysis } = await getLatestScheduleAnalysisForExternalUserId(userId);
    const systemPrompt = buildSystemPrompt(latestAnalysis, shouldUseScheduleContext);

    const forwardedMessages = [
      { role: "system", content: systemPrompt },
      ...(shouldUseScheduleContext && latestAnalysis?.analysis
        ? [
            {
              role: "system",
              content: `SAVED SCHEDULE ANALYSIS FOR THIS USER:

${latestAnalysis.analysis}`,
            },
          ]
        : []),
      ...(shouldUseScheduleContext && latestAnalysis?.raw_schedule_preview
        ? [
            {
              role: "system",
              content: `RAW SCHEDULE CSV PREVIEW FOR THIS USER:

${latestAnalysis.raw_schedule_preview}

Use this raw schedule preview to answer with specific task names, dates, dependencies, and risks whenever possible.
If this data is present and the user is asking a schedule-related question, do not say you cannot see the uploaded schedule.`,
            },
          ]
        : []),
      ...incomingMessages
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({
          role: m.role,
          content: normalizeMessageContent(m.content),
        })),
    ];

    const data = await callOpenAI(forwardedMessages, 0.4);
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
    console.error("OpenAI-compatible v1 chat error:", err);
    return res.status(500).json({
      error: {
        message: err.message || "Server error",
        code: "500",
        type: "ServerError",
        status: 500,
      },
    });
  }
});

// ====================================================================================
//  EXISTING CHAT ENDPOINT
// ====================================================================================
app.post("/api/chat", async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";
    const message = req.body?.message || "";

    const dbUser = await prisma.user.upsert({
      where: { external_user_id: userId },
      update: { last_seen_at: new Date() },
      create: {
        external_user_id: userId,
        last_seen_at: new Date(),
      },
    });

    let conversation = await prisma.conversation.findFirst({
      where: {
        user_id: dbUser.id,
        status: "active",
      },
      orderBy: { updated_at: "desc" },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          user_id: dbUser.id,
          title: "Ray conversation",
          status: "active",
        },
      });
    }

    const shouldUseScheduleContext = isScheduleRelatedQuestion(message);
    const { latestAnalysis } = await getLatestScheduleAnalysisForExternalUserId(userId);

    console.log("Chat request userId:", userId);
    console.log("Use schedule context:", shouldUseScheduleContext);
    console.log("Chat has schedule:", !!latestAnalysis);

    const systemPrompt = buildSystemPrompt(latestAnalysis, shouldUseScheduleContext);

    const data = await callOpenAI(
      [
        { role: "system", content: systemPrompt },
        ...(shouldUseScheduleContext && latestAnalysis?.analysis
          ? [
              {
                role: "system",
                content: `SAVED SCHEDULE ANALYSIS FOR THIS USER:

${latestAnalysis.analysis}`,
              },
            ]
          : []),
        ...(shouldUseScheduleContext && latestAnalysis?.raw_schedule_preview
          ? [
              {
                role: "system",
                content: `RAW SCHEDULE CSV PREVIEW FOR THIS USER:

${latestAnalysis.raw_schedule_preview}

Use this raw schedule preview to answer with specific task names, dates, dependencies, and risks whenever possible.
If this data is present and the user is asking a schedule-related question, do not say you cannot see the uploaded schedule.`,
              },
            ]
          : []),
        { role: "user", content: message },
      ],
      0.4
    );

    const reply = data?.choices?.[0]?.message?.content || "No response.";
const extractedProfileMemories = extractUserProfileMemories(message);

for (const memory of extractedProfileMemories) {
  await prisma.userProfileMemory.upsert({
    where: {
      user_id_memory_key: {
        user_id: dbUser.id,
        memory_key: memory.memory_key,
      },
    },
    update: {
      memory_type: memory.memory_type,
      memory_value: memory.memory_value,
      confidence: memory.confidence,
      source: memory.source,
      updated_at: new Date(),
    },
    create: {
      user_id: dbUser.id,
      memory_type: memory.memory_type,
      memory_key: memory.memory_key,
      memory_value: memory.memory_value,
      confidence: memory.confidence,
      source: memory.source,
    },
  });
}
    const extractedIssues = extractIssuesFromMessage(message);
    
console.log("Extracted issues:", extractedIssues);
for (const issue of extractedIssues) {
  await prisma.issue.create({
    data: {
      user_id: dbUser.id,
      conversation_id: conversation.id,
      title: issue.title,
      description: issue.description,
      owner: issue.owner,
      status: issue.status,
      severity: issue.severity,
      target_date: issue.target_date,
      first_seen_at: new Date(),
      last_discussed_at: new Date(),
    },
  });
}
const extractedRisks = extractRisksFromMessage(message);
console.log("Extracted risks:", extractedRisks);

for (const risk of extractedRisks) {
  await prisma.risk.create({
    data: {
      user_id: dbUser.id,
      conversation_id: conversation.id,
      title: risk.title,
      description: risk.description,
      owner: risk.owner,
      status: risk.status,
      likelihood: risk.likelihood,
      impact: risk.impact,
      severity: risk.severity,
      mitigation: risk.mitigation,
      contingency_plan: risk.contingency_plan,
      first_seen_at: new Date(),
      last_discussed_at: new Date(),
    },
  });
}
    const extractedKeyDates = extractKeyDatesFromMessage(message);
console.log("Extracted key dates:", extractedKeyDates);

for (const keyDate of extractedKeyDates) {
  await prisma.keyDate.create({
    data: {
      user_id: dbUser.id,
      conversation_id: conversation.id,
      date_type: keyDate.date_type,
      title: keyDate.title,
      date_value: keyDate.date_value,
      actual_date: keyDate.actual_date,
      outcome: keyDate.outcome,
      status: keyDate.status,
      notes: keyDate.notes,
    },
  });
}
    await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        user_id: dbUser.id,
        role: "user",
        content: message,
      },
    });

    await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        user_id: dbUser.id,
        role: "assistant",
        content: reply,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updated_at: new Date() },
    });

    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ====================================================================================
//  FILE UPLOAD — CSV SCHEDULE ANALYSIS
// ====================================================================================
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";

    const dbUser = await prisma.user.upsert({
      where: { external_user_id: userId },
      update: { last_seen_at: new Date() },
      create: {
        external_user_id: userId,
        last_seen_at: new Date(),
      },
    });

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const uploadedFile = await prisma.uploadedFile.create({
      data: {
        user_id: dbUser.id,
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
      return res.status(400).json({
        error: "Could not parse CSV.",
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: "CSV contains no data." });
    }

    const trimmed = records.slice(0, 120);
    const headers = Object.keys(trimmed[0]);

    const compactCsv = [
      headers.join(","),
      ...trimmed.map((row) =>
        headers
          .map((h) => (row[h] || "").toString().replace(/,/g, ";"))
          .join(",")
      ),
    ].join("\n");

    const systemPrompt = `
You are Aero, an expert project schedule reviewer.

CRITICAL RULES:
- ALWAYS reference specific task names
- ALWAYS reference dates
- ALWAYS reference dependencies
- NEVER be vague

You must identify:
- Date issues
- Dependency issues
- Delivery risks

FORMAT:

1. Overall Assessment

2. Specific Schedule Issues
| Task Name | Issue Type | What Looks Wrong | Why It Matters | Fix |

3. Top Risks
| Risk | Tasks | Why | Mitigation | Likelihood | Impact |
`.trim();

    const userPrompt = `
Analyze this schedule:

${compactCsv}
`.trim();

    const data = await callOpenAI(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      0.3
    );

    const analysis = data?.choices?.[0]?.message?.content || "No analysis.";
    const rawSchedulePreview = compactCsv.slice(0, 6000);

    await prisma.scheduleAnalysis.create({
      data: {
        user_id: dbUser.id,
        uploaded_file_id: uploadedFile.id,
        analysis,
        raw_schedule_preview: rawSchedulePreview,
        analysis_version: "v1",
      },
    });

    console.log("Saved schedule for user:", userId);
    console.log("Saved analysis preview:", analysis.slice(0, 300));

    res.json({ analysis });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ====================================================================================
//  LEGACY SINGLE-ENDPOINT D-ID ROUTE
// ====================================================================================
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
    const userId = body.user || body.userId || "anonymous";

    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    const normalizedLastUserMessage = normalizeMessageContent(lastUserMessage);
    const shouldUseScheduleContext = isScheduleRelatedQuestion(normalizedLastUserMessage);

    const { latestAnalysis } = await getLatestScheduleAnalysisForExternalUserId(userId);

    const data = await callOpenAI(
      [
        {
          role: "system",
          content: buildSystemPrompt(latestAnalysis, shouldUseScheduleContext),
        },
        ...(shouldUseScheduleContext && latestAnalysis?.analysis
          ? [
              {
                role: "system",
                content: `SAVED SCHEDULE ANALYSIS FOR THIS USER:

${latestAnalysis.analysis}`,
              },
            ]
          : []),
        { role: "user", content: normalizedLastUserMessage },
      ],
      0.4
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

// ====================================================================================
//  SUPABASE TEST ROUTE
// ====================================================================================
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

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`ProjectPilot backend running on port ${PORT}`);
});
