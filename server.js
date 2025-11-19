import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Allow both Wix editor/hosting origins
const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-ai.filesusr.com",
  "https://www-projectpilot-ai.filesusr.com",
  "https://renaeliving.wixsite.com",
  "https://renaeliving-wixsite-com.filesusr.com"
]filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const ok = ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed));
      if (ok) return callback(null, true);
      return callback(new Error("Not allowed by CORS: " + origin));
    },
  })
);



app.get("/", (req, res) => {
  res.send("ProjectPilot backend is running.");
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    // Be defensive: handle missing or non-JSON bodies gracefully
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message : "";

    if (!message) {
      return res
        .status(400)
        .json({ error: "Body must include a 'message' string." });
    }

    const systemPrompt = `
You are "Aero", an AI Project Management Coach for new project managers using the ProjectPilot website.
- Be friendly, clear, and encouraging.
- Explain project management concepts in simple language.
- Use bullet points and short paragraphs.
- When asked for schedules, create concise markdown tables with tasks, owner, duration, dependencies, and notes.
- Focus on practical "what to do next" advice.
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
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI API error:", text);
      return res.status(500).json({ error: "OpenAI API error", detail: text });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim()
      || "I’m not sure how to respond to that.";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ProjectPilot backend listening on port ${PORT}`);
});
