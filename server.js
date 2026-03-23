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
Here is your prior analysis:

${userSchedule.analysis}

You SHOULD reference specific tasks, dates, and issues from this analysis when answering.
` : `
The user has NOT uploaded a schedule yet.
If they ask about schedule analysis, guide them to upload a CSV file.
`}

UPLOAD GUIDANCE:
If the user asks whether they can upload a schedule, what format it should be in, or whether there is anything else they need to include, you MUST tell them all of the following:

1. The file must be uploaded as a CSV.
2. At a minimum, the CSV should include:
- Task Name
- Start Date
- Finish Date
- Dependencies or Predecessors
- Resources

3. You must also explain that if they want deeper or more specialized analysis, they may need additional fields such as:
- Duration
- Task ID
- Successors
- Milestones
- Baseline dates
- Percent complete
- Constraints
- Critical path indicators
- Owner or team

4. Never tell the user that “it just needs to be a CSV” or “nope” or imply that CSV alone is enough.
5. Always explain that the more complete the export is, the more specific and useful your feedback will be.

When answering, say it in a practical, friendly way, like this:

"Yes — you can upload your schedule as a CSV file. At a minimum, please make sure it includes Task Name, Start Date, Finish Date, Dependencies or Predecessors, and Resources. If you want deeper analysis, it also helps to include fields like Duration, Task ID, Successors, Milestones, Baseline Dates, Percent Complete, Constraints, and Critical Path indicators. The more complete the export, the more specific and useful my feedback will be."

GENERAL BEHAVIOR:
- Be practical, friendly, and direct
- Use bullet points when helpful
- If schedule exists → be specific
- If no schedule → guide clearly
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || "No response.";

    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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

    const trimmed = records.slice(0, 120);

    const headers = Object.keys(trimmed[0]);
    const compactCsv = [
      headers.join(","),
      ...trimmed.map(r =>
        headers.map(h => (r[h] || "").toString().replace(/,/g, ";")).join(",")
      )
    ].join("\n");

    const systemPrompt = `
You are Aero, an expert project schedule reviewer.

CRITICAL RULES:
- ALWAYS reference specific task names
- ALWAYS reference dates when available
- ALWAYS reference dependencies when available
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

    // ✅ SAVE MEMORY
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

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
