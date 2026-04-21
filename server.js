// ===============================
// IMPORTS
// ===============================
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { prisma } from "./prismaClient.js";
import { supabaseAdmin } from "./supabaseClient.js";

// ===============================
// CONFIG
// ===============================
const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(express.json({ limit: "4mb" }));

// ===============================
// CORS
// ===============================
const ALLOWED_ORIGINS = [
  "https://projectpilot.ai",
  "https://www.projectpilot.ai",
  "https://projectpilot-frontend.onrender.com",
  "https://ray-app.onrender.com",
  "https://try-ray.onrender.com"
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);

// ===============================
// FILE UPLOAD
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ===============================
// USER
// ===============================
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

// ===============================
// PROJECT (RESTORED)
// ===============================
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

// ===============================
// CONVERSATION (UPDATED)
// ===============================
async function getOrCreateConversation(dbUserId, projectName, project = null) {
  const title = projectName || "General";

  let conversation = await prisma.conversation.findFirst({
    where: { user_id: dbUserId, title },
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
  }

  return conversation;
}

// ===============================
// CHAT
// ===============================
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message, projectName } = req.body;

    const dbUser = await upsertDbUser(userId || "anonymous");
    const project = await getOrCreateProjectForUser(dbUser.id, projectName);
    const conversation = await getOrCreateConversation(dbUser.id, projectName, project);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are Ray, an AI project coach." },
          { role: "user", content: message },
        ],
      }),
    });

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || "No response.";

    await prisma.message.create({
      data: {
        user_id: dbUser.id,
        conversation_id: conversation.id,
        content: message,
        role: "user",
      },
    });

    await prisma.message.create({
      data: {
        user_id: dbUser.id,
        conversation_id: conversation.id,
        content: reply,
        role: "assistant",
      },
    });

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ===============================
// FILE UPLOAD (UPDATED)
// ===============================
app.post("/api/upload-schedule", upload.single("schedule"), async (req, res) => {
  try {
    const externalUserId = req.body.userId || "anonymous";
    const projectName = req.body.projectName;

    const dbUser = await upsertDbUser(externalUserId);
    const project = await getOrCreateProjectForUser(dbUser.id, projectName);
    const conversation = await getOrCreateConversation(dbUser.id, projectName, project);

    const uploadedFile = await prisma.uploadedFile.create({
      data: {
        user_id: dbUser.id,
        conversation_id: conversation.id,
        ...(project ? { project_id: project.id } : {}),
        filename: req.file.originalname,
        storage_path: "pending",
        file_type: "schedule",
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
      },
    });

    const csvText = req.file.buffer.toString("utf-8");

    const analysis = "Schedule uploaded and processed.";

    await prisma.scheduleAnalysis.create({
      data: {
        user_id: dbUser.id,
        conversation_id: conversation.id,
        uploaded_file_id: uploadedFile.id,
        ...(project ? { project_id: project.id } : {}),
        analysis,
      },
    });

    res.json({ success: true, reply: analysis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ===============================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
