// ===============================
//  FILE UPLOAD — CSV SCHEDULE ANALYSIS
// ===============================
app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  ...
});


// ====================================================================================
//  NEW: D-ID CUSTOM LLM ENDPOINT (PHASE 2)
// ====================================================================================
app.post("/api/did-llm", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("D-ID payload:", JSON.stringify(body, null, 2));

    const messages = body.messages || [];
    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    const systemPrompt = `
You are Ray, an expert project management coach.
Be helpful, specific, and practical.
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
          { role: "user", content: lastUserMessage }
        ]
      }),
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
