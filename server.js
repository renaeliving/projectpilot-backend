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

const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-frontend.onrender.com",
  "https://renaeliving.wixsite.com",
  "https://renaeliving-wixsite-com.filesusr.com",
  "https://projectpilot-ai.filesusr.com"
].filter(Boolean);

// ===============================
//  TEMP MEMORY STORE
// ===============================
const userSchedules = new Map();

// ===============================
//  HELPERS
// ===============================
function guessTaskFields(row) {
  const keys = Object.keys(row);
  const findKey = (candidates) =>
    keys.find((k) => candidates.some((c) => k.toLowerCase().includes(c)));

  return {
    idKey: findKey(["id", "task id", "activity id", "wbs"]),
    nameKey: findKey(["task name", "task", "activity name", "activity", "name"]),
    startKey: findKey(["start"]),
    finishKey: findKey(["finish", "end"]),
    ownerKey: findKey(["owner", "resource", "assignee", "responsible"]),
    percentKey: findKey(["%", "percent", "complete"]),
    predecessorKey: findKey(["predecessor", "dependency", "depends"]),
  };
}

function buildTaskSummary(records) {
  if (!records?.length) return [];

  const fields = guessTaskFields(records[0]);

  return records.slice(0, 50).map((row, index) => ({
    rowNumber: index + 1,
    id: fields.idKey ? row[fields.idKey] : "",
    task: fields.nameKey ? row[fields.nameKey] : "",
    start: fields.startKey ? row[fields.startKey] : "",
    finish: fields.finishKey ? row[fields.finishKey] : "",
    owner: fields.ownerKey ? row[fields.ownerKey] : "",
    percentComplete: fields.percentKey ? row[fields.percentKey] : "",
    predecessors: fields.predecessorKey ? row[fields.predecessorKey] : "",
  }));
}

function formatTaskSummaryForPrompt(taskSummary) {
  if (!taskSummary?.length) return "No task-level summary available.";

  return taskSummary
    .map(
      (t) =>
        `Row ${t.rowNumber}: ` +
        `ID=${t.id || "n/a"} | ` +
        `Task=${t.task || "n/a"} | ` +
        `Start=${t.start || "n/a"} | ` +
        `Finish=${t.finish || "n/a"} | ` +
        `Owner=${t.owner || "n/a"} | ` +
        `% Complete=${t.percentComplete || "n/a"} | ` +
        `Predecessors=${t.predecessors || "n/a"}`
    )
    .join("\n");
}

// ===============================
//  MIDDLEWARE
// ===============================
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
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

// ===============================
//  CHAT ENDPOINT
// ===============================
app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const userId = req.body?.userId || "anonymous";
    const userSchedule = userSchedules.get(userId);

    let message = "";
    if (typeof req.body?.message === "string") {
      message = req.body.message.trim();
    } else if (typeof req.body?.text === "string") {
      message = req.body.text.trim();
    }

    if (!message) {
      return res.json({
        reply: "Hi, I’m Ray. Tell me about your project.",
        audioBase64: null
      });
    }

    const systemPrompt = `
You are Ray, an expert project management coach.

STYLE:
- Be clear, helpful, friendly, and practical.
- Use short paragraphs and bullet points.
- When the user asks about their schedule, answer with task-level specificity whenever possible.
- Mention actual task names, likely dependencies, sequencing concerns, and next-step recommendations.
- Do not claim to know details that are not present in the uploaded schedule.

SCHEDULE CONTEXT:
${
  userSchedule
    ? `
The user HAS uploaded a project schedule.

Uploaded at:
${userSchedule.uploadedAt}

Overall schedule analysis:
${userSchedule.analysis}

Task-level summary:
${formatTaskSummaryForPrompt(userSchedule.taskSummary)}

When the user asks about schedule risks, priorities, delays, sequencing, critical work, handoffs, or next steps, use this uploaded schedule context first.
`
    : `
The user has NOT uploaded a schedule yet.
If they ask about their actual project schedule, tell them to upload a CSV schedule so you can analyze specific tasks and dependencies.
`
}
`.trim();

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
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to respond to that.";

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
        } else {
          console.error("ElevenLabs error:", await ttsRes.text());
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

// ===============================
//  FILE UPLOAD — CSV SCHEDULE ANALYSIS
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";
    console.log("Schedule upload from user:", userId);

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
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
        error: "Could not parse CSV. Ensure it's a valid exported schedule."
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: "CSV contains no data." });
    }

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
    const taskSummary = buildTaskSummary(records);

    const systemPrompt = `
You are Ray, an expert PM coach.
You will be given a project schedule in CSV form.

Return:
1. A 2-4 sentence overall assessment.
2. A markdown table with the top 8-12 schedule risks.
3. A short section called "Most Important Tasks to Watch" listing 5-8 specific task names or rows from the schedule that appear most important, risky, or dependency-heavy.

Use this markdown table format for the risks:

| ID | Risk | Why it matters | Suggested mitigation | Likelihood | Impact |
`.trim();

    const userPrompt = `
Here is the project schedule (CSV):

${compactCsv}
`.trim();

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
    const analysis =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I could not generate an analysis.";

    userSchedules.set(userId, {
      uploadedAt: new Date().toISOString(),
      analysis,
      rawRows: records.slice(0, 20),
      taskSummary
    });

    console.log("Saved schedule for user:", userId);

    return res.json({
      analysis,
      previewTasks: taskSummary.slice(0, 10)
    });
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
