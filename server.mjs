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
// ✅ Allow large scenes up to ~20MB
app.use(express.json({ limit: "20mb" }));

// --- Helper: split long docs into parts ---
function splitBodyText(text, maxLen = 10000) {
  if (!text || text.length <= maxLen) return [text];
  const parts = [];
  for (let i = 0; i < text.length; i += maxLen) {
    parts.push(text.slice(i, i + maxLen));
  }
  return parts;
}

// --- Helper: reassemble parts back into one ---
function mergeDocs(docs) {
  const grouped = {};
  for (const doc of docs) {
    // Detect part suffix: id-partN
    const baseId = doc.id.split("-part")[0];
    if (!grouped[baseId]) {
      grouped[baseId] = { ...doc, body: "" };
    }
    grouped[baseId].body += doc.body || "";
  }
  return Object.values(grouped);
}

// --- HEALTH ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- READ ---
app.get("/lyra/read", async (req, res) => {
  try {
    const docs = await lyraRead(req.query);
    const merged = mergeDocs(docs);
    res.json(merged);
  } catch (err) {
    console.error("❌ /lyra/read error", err);
    res.status(500).json({ error: "Failed to read docs", details: err.message });
  }
});

// Alias: GET /doc
app.get("/doc", async (req, res) => {
  try {
    const docs = await lyraRead(req.query);
    const merged = mergeDocs(docs);
    res.json(merged);
  } catch (err) {
    console.error("❌ /doc error", err);
    res.status(500).json({ error: "Failed to read docs", details: err.message });
  }
});

// --- SEARCH ---
app.get("/search", async (req, res) => {
  try {
    const results = await searchDocs(req.query);
    const merged = mergeDocs(results);
    res.json(merged);
  } catch (err) {
    console.error("❌ /search error", err);
    res.status(500).json({ error: "Search failed", details: err.message });
  }
});

// --- PASTE-SAVE ---
app.post("/lyra/paste-save", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.payload) {
      return res.status(400).json({ error: "Invalid request: missing payload" });
    }

    const id = payload.id || uuidv4();
    const bodyText = payload.payload.body_md || "";
    const parts = splitBodyText(bodyText);

    let result;
    if (parts.length === 1) {
      result = await createOrUpdateDoc(id, payload);
    } else {
      console.log(`✂️ Splitting doc ${id} into ${parts.length} parts due to size`);
      let lastResult;
      for (let i = 0; i < parts.length; i++) {
        const partPayload = {
          ...payload,
          payload: {
            ...payload.payload,
            body_md: parts[i],
            title: i === 0 ? payload.payload.title : `${payload.payload.title} (Part ${i + 1})`,
          },
        };
        lastResult = await createOrUpdateDoc(id + `-part${i + 1}`, partPayload);
      }
      result = lastResult;
    }

    res.json({ id, result, parts: parts.length });
  } catch (err) {
    console.error("❌ /lyra/paste-save error", err);
    res.status(500).json({ error: "Failed to save document", details: err.message });
  }
});

// Alias: POST /doc
app.post("/doc", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.payload) {
      return res.status(400).json({ error: "Invalid request: missing payload" });
    }

    const id = payload.id || uuidv4();
    const bodyText = payload.payload.body_md || "";
    const parts = splitBodyText(bodyText);

    let result;
    if (parts.length === 1) {
      result = await createOrUpdateDoc(id, payload);
    } else {
      console.log(`✂️ Splitting doc ${id} into ${parts.length} parts due to size`);
      let lastResult;
      for (let i = 0; i < parts.length; i++) {
        const partPayload = {
          ...payload,
          payload: {
            ...payload.payload,
            body_md: parts[i],
            title: i === 0 ? payload.payload.title : `${payload.payload.title} (Part ${i + 1})`,
          },
        };
        lastResult = await createOrUpdateDoc(id + `-part${i + 1}`, partPayload);
      }
      result = lastResult;
    }

    res.json({ id, result, parts: parts.length });
  } catch (err) {
    console.error("❌ /doc POST error", err);
    res.status(500).json({ error: "Failed to save document", details: err.message });
  }
});

// --- EXPORT ---
app.get("/export", async (req, res) => {
  try {
    const data = await exportProject(req.query.project_name);
    const merged = mergeDocs(data.docs);
    res.json({ docs: merged });
  } catch (err) {
    console.error("❌ /export error", err);
    res.status(500).json({ error: "Failed to export project", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Lyra API running on port ${PORT}`);
});