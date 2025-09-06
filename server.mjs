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
app.use(express.json());

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

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Read documents (preferred route)
app.get("/lyra/read", async (req, res) => {
  try {
    const docs = await lyraRead(req.query);
    res.json(docs);
  } catch (err) {
    console.error("❌ /lyra/read error", err);
    res.status(500).json({ error: err.message });
  }
});

// Alias: GET /doc → same as /lyra/read
app.get("/doc", async (req, res) => {
  try {
    const docs = await lyraRead(req.query);
    res.json(docs);
  } catch (err) {
    console.error("❌ /doc error", err);
    res.status(500).json({ error: err.message });
  }
});

// Search documents
app.get("/search", async (req, res) => {
  try {
    const results = await searchDocs(req.query);
    res.json(results);
  } catch (err) {
    console.error("❌ /search error", err);
    res.status(500).json({ error: err.message });
  }
});

// Paste-save (create or update, with auto-split for big scenes)
app.post("/lyra/paste-save", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.payload) {
      return res.status(400).json({ error: "Invalid request: missing payload" });
    }

    const baseId = payload.id || uuidv4();
    const bodyText = payload.payload.body_md || "";

    // If scene is too large, split into multiple docs
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

    // Normal save (no split)
    const id = baseId;
    const result = await createOrUpdateDoc(id, payload);
    res.json({ id, result });
  } catch (err) {
    console.error("❌ /lyra/paste-save error", err);
    res.status(500).json({ error: err.message });
  }
});

// Alias: POST /doc → same as /lyra/paste-save
app.post("/doc", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.payload) {
      return res.status(400).json({ error: "Invalid request: missing payload" });
    }

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
    console.error("❌ /doc POST error", err);
    res.status(500).json({ error: err.message });
  }
});

// Export all docs
app.get("/export", async (req, res) => {
  try {
    const data = await exportProject(req.query.project_name);
    res.json(data);
  } catch (err) {
    console.error("❌ /export error", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Lyra API running on port ${PORT}`);
});