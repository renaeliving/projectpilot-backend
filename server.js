import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();

console.log("ELEVENLABS_API_KEY present:", !!ELEVENLABS_API_KEY);
console.log("ELEVENLABS_VOICE_ID present:", !!ELEVENLABS_VOICE_ID);


// Allow both Wix editor/hosting origins
const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-ai.filesusr.com",
  "https://www-projectpilot-ai.filesusr.com",
  "https://renaeliving.wixsite.com",
  "https://renaeliving-wixsite-com.filesusr.com"
].filter(Boolean);


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
app.use(express.json());


app.get("/", (req, res) => {
  res.send("ProjectPilot backend is running.");
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const body = req.body || {};
    let message = "";

    if (typeof body.message === "string") {
      message = body.message.trim();
    } else if (typeof body.text === "string") {
      // fallback if the frontend ever sends { text: "..." } instead
      message = body.text.trim();
    }

    // If no message, just send a friendly default reply instead of 400
    if (!message) {
      return res.json({
        reply:
          "Hi, I’m Aero. Tell me about your project and I’ll help you build a schedule, identify risks, and figure out what to do next.",
        audioBase64: null,
      });
    }

    // ... call OpenAI using `message` ...


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

///////////////////////////////////////////////////////
// 🔊 ELEVENLABS TEXT-TO-SPEECH (AERO'S VOICE)
///////////////////////////////////////////////////////
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
  console.log("Skipping ElevenLabs TTS. HasKey:", !!ELEVENLABS_API_KEY, "HasVoice:", !!ELEVENLABS_VOICE_ID);
}

return res.json({ reply, audioBase64 });

///////////////////////////////////////////////////////
// RETURN BOTH TEXT AND AUDIO TO THE FRONTEND
///////////////////////////////////////////////////////
return res.json({ reply, audioBase64 });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ProjectPilot backend listening on port ${PORT}`);
});
