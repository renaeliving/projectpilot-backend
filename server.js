app.post("/api/chat", async (req, res) => {
  try {
    const userId = req.body?.userId || "anonymous";
    const projectName = req.body?.projectName || "";
    const message = req.body?.message || "";

    const dbUser = await prisma.user.upsert({
      where: { external_user_id: userId },
      update: { last_seen_at: new Date() },
      create: {
        external_user_id: userId,
        last_seen_at: new Date(),
      },
    });

    const project = await getOrCreateProjectForUser(dbUser.id, projectName);

    let conversation = await prisma.conversation.findFirst({
      where: {
        user_id: dbUser.id,
        status: "active",
        project_id: project?.id || null,
      },
      orderBy: { updated_at: "desc" },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          user_id: dbUser.id,
          project_id: project?.id || null,
          title: "Ray conversation",
          status: "active",
        },
      });
    }

    const shouldUseScheduleContext = isScheduleRelatedQuestion(message);
    const { latestAnalysis } = await getLatestScheduleAnalysisForUserProject(
      userId,
      projectName
    );

    console.log("Chat request userId:", userId);
    console.log("Project name:", projectName);
    console.log("Use schedule context:", shouldUseScheduleContext);
    console.log("Chat has schedule:", !!latestAnalysis);

    const recentMessages = await prisma.message.findMany({
      where: {
        conversation_id: conversation.id,
      },
      orderBy: {
        created_at: "asc",
      },
      take: 12,
    });

    const conversationHistory = recentMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    const systemPrompt = `
You are Ray, a friendly, conversational AI project coach.

STYLE RULES:
- Sound natural, warm, and human.
- Carry the conversation forward like a real person would.
- If the user asks a short follow-up, assume they are continuing the current topic unless there is strong evidence they changed subjects.
- When the user asks a follow-up like "how do you identify them?" or "what about that?", use the recent conversation to infer what "them" or "that" refers to.
- Do not ask unnecessary clarification questions if the meaning is reasonably clear from the prior messages.
- Only ask for clarification when the reference is genuinely ambiguous.
- Be practical, supportive, and easy to talk to.
- Avoid sounding robotic, overly formal, or repetitive.
- Use short paragraphs.
- Use bullets when helpful, but do not overdo them.
- Focus on useful project management guidance and clear next steps.

SCHEDULE CONTEXT RULES:
${
  shouldUseScheduleContext && latestAnalysis
    ? `
The user has uploaded a project schedule.
Use the saved schedule analysis only when the user's question is actually about the schedule, tasks, dates, milestones, issues, dependencies, owners, deliverables, or project timing.
If the user's question is general and not about the schedule, answer normally and do not force the schedule into the response.
`
    : `
Use saved schedule context only if it is relevant to the user's question.
If the user's question is general or unrelated, answer normally without forcing schedule context into the answer.
`
}

UPLOAD REQUIREMENTS:
If the user asks about uploading a schedule, explain clearly that CSV upload works best when it includes:
- Task Name
- Start Date
- Finish Date
- Dependencies or Predecessors
- Resources

If available, deeper analysis is even better with:
- Duration
- Task ID
- Successors
- Milestones
- Baseline dates
- Percent complete
- Constraints
- Critical path indicators
- Owner or team

Be specific, practical, and direct.
`.trim();

    const data = await callOpenAI(
      [
        { role: "system", content: systemPrompt },
        ...(shouldUseScheduleContext && latestAnalysis?.analysis
          ? [
              {
                role: "system",
                content: `SAVED SCHEDULE ANALYSIS FOR THIS USER:\n\n${latestAnalysis.analysis}`,
              },
            ]
          : []),
        ...(shouldUseScheduleContext && latestAnalysis?.raw_schedule_preview
          ? [
              {
                role: "system",
                content: `RAW SCHEDULE CSV PREVIEW FOR THIS USER:\n\n${latestAnalysis.raw_schedule_preview}\n\nUse this raw schedule preview to answer with specific task names, dates, dependencies, and risks whenever possible.\nIf this data is present and the user is asking a schedule-related question, do not say you cannot see the uploaded schedule.`,
              },
            ]
          : []),
        ...conversationHistory,
        { role: "user", content: message },
      ],
      0.5
    );

    const reply = data?.choices?.[0]?.message?.content?.trim() || "No response.";

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
    for (const issue of extractedIssues) {
      await prisma.issue.create({
        data: {
          user_id: dbUser.id,
          project_id: project?.id || null,
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
    for (const risk of extractedRisks) {
      await prisma.risk.create({
        data: {
          user_id: dbUser.id,
          project_id: project?.id || null,
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
    for (const keyDate of extractedKeyDates) {
      await prisma.keyDate.create({
        data: {
          user_id: dbUser.id,
          project_id: project?.id || null,
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
