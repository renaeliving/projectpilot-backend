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

// ===============================
//  SIMPLE MEMORY STORE (TEMP)
// ===============================
const userSchedules = new Map();

// ===============================
//  MIDDLEWARE
// ===============================
app.use(cors());
app.use(express.json());

// ===============================
//  HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("ProjectPilot backend running.");
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
The user has uploaded a project schedule.
Here is your previous analysis:

${userSchedule.analysis}

You MUST reference specific tasks, dates, and issues when relevant.
` : `
The user has NOT uploaded a schedule yet.
If they ask about schedules, guide them to upload a CSV file.
`}

CRITICAL RULES:
- NEVER give vague answers
- ALWAYS be specific if schedule exists

UPLOAD REQUIREMENTS:
If user asks about uploading a schedule, you MUST say:

Yes — you can upload your schedule as a CSV file.

At a minimum, please include:
- Task Name
- Start Date
- Finish Date
- Dependencies or Predecessors
- Resources

If you want deeper analysis, include:
- Duration
- Task ID
- Successors
- Milestones
- Baseline dates
- Percent complete
- Constraints
- Critical path indicators

The more complete the export, the more specific the feedback will be.

DO NOT say:
- "it just needs to be a CSV"
- "nope"
`.trim();

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      })
    });

    const data = await aiResponse.json();
    const reply = data?.choices?.[0]?.message?.content || "No response.";

    res.json({ reply });

  } catch (err) {
    console.error(err);
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
        skip_empty_lines: true
      });
    } catch (e) {
      return res.status(400).json({
        error: "Could not parse CSV."
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: "CSV contains no data." });
    }

    const trimmed = records.slice(0, 120);

    const headers = Object.keys(trimmed[0]);

    const compactCsv = [
      headers.join(","),
      ...trimmed.map(row =>
        headers.map(h =>
          (row[h] || "").toString().replace(/,/g, ";")
        ).join(",")
      )
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

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    const data = await aiResponse.json();
    const analysis = data?.choices?.[0]?.message?.content || "No analysis.";

    // SAVE TO MEMORY
    userSchedules.set(userId, {
      uploadedAt: new Date().toISOString(),
      analysis
    });

    console.log("Saved schedule for user:", userId);

    res.json({ analysis });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ====================================================================================
//  D-ID CUSTOM LLM ENDPOINT (PHASE 2)
// ====================================================================================
app.post("/api/did-llm", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("D-ID payload:", JSON.stringify(body, null, 2));

    const messages = body.messages || [];

    const lastUserMessage =
      [...messages].reverse().find(m => m.role === "user")?.content || "";

    const systemPrompt = `
You are Ray, an expert project management coach.

Be clear, practical, and specific.
Do not give generic answers.
`.trim();

    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: lastUserMessage }
        ]
      })
    });

    const data = await aiResponse.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      "I'm not sure how to respond.";

    return res.json({
      id: "ray-response",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4.1-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply
          },
          finish_reason: "stop"
        }
      ]
    });

  } catch (err) {
    console.error("D-ID LLM error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`ProjectPilot backend running on port ${PORT}`);
});
