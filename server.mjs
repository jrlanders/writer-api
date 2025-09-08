// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

import {
  readDocs as lyraRead,
  searchDocs,
  createOrUpdateDoc,
  exportProject,
} from "./db.pg.mjs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // ✅ raise JSON body size limit

// --- Helper: split oversized text ---
function splitText(text, maxLen = 8000) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}

// --- Normalize incoming request ---
function normalizeRequest(body) {
  if (!body) return null;
  if (body.payload) return body; // already wrapped
  return { ...body, payload: { ...body } };
}

// --- Validate request structure ---
function validateRequest(reqBody) {
  if (!reqBody || typeof reqBody !== "object") return "Missing request body";
  if (!reqBody.payload || typeof reqBody.payload !== "object") return "Missing payload object";
  if (!reqBody.payload.doc_type) return "Missing payload.doc_type";
  if (!reqBody.payload.title) return "Missing payload.title";
  return null;
}

// --- Word count helper ---
function countWords(text) {
  if (!text) return 0;
  return text
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .split(" ")
    .filter(Boolean).length;
}

// --- Routes ---

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Read documents
app.get("/lyra/read", async (req, res) => {
  try {
    const docs = await lyraRead(req.query);
    res.json(docs);
  } catch (err) {
    console.error("❌ /lyra/read error", err);
    res.status(500).json({ error: err.message });
  }
});

// Alias: GET /doc
app.get("/doc", async (req, res) => {
  try {
    const docs = await lyraRead(req.query);
    res.json(docs);
  } catch (err) {
    console.error("❌ /doc error", err);
    res.status(500).json({ error: err.message });
  }
});

// Search
app.get("/search", async (req, res) => {
  try {
    const results = await searchDocs(req.query);
    res.json(results);
  } catch (err) {
    console.error("❌ /search error", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Core save handler ---
async function handleSave(req, res) {
  try {
    const normalized = normalizeRequest(req.body);
    const validationError = validateRequest(normalized);
    if (validationError) {
      return res.status(400).json({ error: `Invalid request: ${validationError}` });
    }

    const payload = normalized;
    const baseId = payload.id || uuidv4();
    const bodyText = payload.payload.body_md || "";

    if (bodyText.length > 8000) {
      const parts = splitText(bodyText);
      const savedParts = [];
      for (let idx = 0; idx < parts.length; idx++) {
        const partPayload = {
          ...payload,
          id: `${baseId}-p${idx + 1}`,
          payload: {
            ...payload.payload,
            title: `${payload.payload.title} (Part ${idx + 1})`,
            body_md: parts[idx],
          },
        };
        const result = await createOrUpdateDoc(partPayload.id, partPayload);
        savedParts.push(result);
      }
      return res.json({ id: baseId, parts: savedParts.length, results: savedParts });
    }

    const id = baseId;
    const result = await createOrUpdateDoc(id, payload);
    res.json({ id, result });
  } catch (err) {
    console.error("❌ Save error", err);
    res.status(500).json({ error: err.message });
  }
}

// Save routes
app.post("/lyra/paste-save", handleSave);
app.post("/doc", handleSave);

// Export
app.get("/export", async (req, res) => {
  try {
    const data = await exportProject(req.query.project_name);
    res.json(data);
  } catch (err) {
    console.error("❌ /export error", err);
    res.status(500).json({ error: err.message });
  }
});

// --- New Stats Endpoint ---
app.get("/stats", async (req, res) => {
  try {
    const allDocs = await lyraRead({});
    const scenes = allDocs.filter(d => d.doc_type === "scene");

    const perScene = scenes.map(s => ({
      id: s.id,
      title: s.title,
      word_count: countWords(s.body),
    }));

    const totalWordCount = perScene.reduce((sum, s) => sum + s.word_count, 0);

    res.json({
      total_docs: allDocs.length,
      total_scenes: scenes.length,
      total_word_count: totalWordCount,
      per_scene: perScene,
    });
  } catch (err) {
    console.error("❌ /stats error", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Lyra API running on port ${PORT}`);
});