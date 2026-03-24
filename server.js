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
//  SIMPLE MEMORY STORE (TEMP)
// ===============================
const userSchedules = new Map();

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

function buildSystemPrompt(userSchedule) {
  return `
You are Ray, an expert project management coach.

${userSchedule ? `
USER CONTEXT:
The user has uploaded a project schedule.
Here is your previous analysis:

${userSchedule.analysis}

When relevant, reference specific tasks, dates, dependencies, and issues from this analysis.
` : `
USER CONTEXT:
The user has not uploaded a schedule yet.
If they ask about schedule analysis, guide them to upload a CSV.
`}

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
- If schedule context exists, use it.
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

// NEW DEBUG ROUTE
app.get("/api/debug-schedule/:userId", (req, res) => {
  const userId = req.params.userId;
  const saved = userSchedules.get(userId) || null;
  res.json({ userId, saved });
});

// ====================================================================================
//  OPENAI-COMPATIBLE ENDPOINTS FOR D-ID
//  Base URL to use in D-ID:
//  https://projectpilot-backend-zkad.onrender.com/api/openai
// ====================================================================================

// Models endpoint (main)
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

// Optional alias if D-ID tries /v1/models
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

// Chat completions endpoint (main)
app.post("/api/openai/chat/completions", async (req, res) => {
  try {
    const apiKey = getInboundApiKey(req);

    console.log("OpenAI-compatible auth received:", apiKey ? "yes" : "no");

    if (apiKey !== DID_CUSTOM_LLM_KEY) {
      console.log("Unauthorized OpenAI-compatible request");
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
    console.log("OpenAI-compatible payload:", JSON.stringify(body, null, 2));

    const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
    const userId = body.user || body.userId || "anonymous";
    const userSchedule = userSchedules.get(userId);

    const systemPrompt = buildSystemPrompt(userSchedule);

    const forwardedMessages = [
      { role: "system", content: systemPrompt },
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

// Optional alias if D-ID tries /v1/chat/completions
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
    const userSchedule = userSchedules.get(userId);

    const systemPrompt = buildSystemPrompt(userSchedule);

    const forwardedMessages = [
      { role: "system", content: systemPrompt },
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
//  EXISTING CHAT ENDPOINT (CURRENT UI)
// ====================================================================================
app.post("/api/chat", async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";
    const message = req.body?.message || "";
    const userSchedule = userSchedules.get(userId);

    console.log("Chat request userId:", userId);
    console.log("Chat has schedule:", !!userSchedule);
    if (userSchedule?.analysis) {
      console.log("Chat schedule preview:", userSchedule.analysis.slice(0, 300));
    }

    const systemPrompt = buildSystemPrompt(userSchedule);

    const data = await callOpenAI(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      0.4
    );

    const reply = data?.choices?.[0]?.message?.content || "No response.";

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

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

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

    userSchedules.set(userId, {
      uploadedAt: new Date().toISOString(),
      analysis,
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
//  LEGACY SINGLE-ENDPOINT D-ID ROUTE (can keep for debugging)
// ====================================================================================
app.post("/api/did-llm", async (req, res) => {
  try {
    const apiKey = getInboundApiKey(req);

    console.log("Legacy D-ID auth received:", apiKey ? "yes" : "no");

    if (apiKey !== DID_CUSTOM_LLM_KEY) {
      console.log("Unauthorized legacy D-ID request");
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
    console.log("Legacy D-ID payload:", JSON.stringify(body, null, 2));

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    const data = await callOpenAI(
      [
        {
          role: "system",
          content:
            "You are Ray, an expert project management coach. Be clear, practical, and specific.",
        },
        { role: "user", content: normalizeMessageContent(lastUserMessage) },
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

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`ProjectPilot backend running on port ${PORT}`);
});
