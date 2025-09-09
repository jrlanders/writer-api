// server.mjs force
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
function splitText(text, maxLen = 50000) {
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
  return { ...body, payload: { ...body } }; // auto-wrap
}

// --- Validate request structure ---
function validateRequest(reqBody) {
  if (!reqBody || typeof reqBody !== "object") return "Missing request body";
  if (!reqBody.payload || typeof reqBody.payload !== "object") return "Missing payload object";
  if (!reqBody.payload.doc_type) return "Missing payload.doc_type";
  if (!reqBody.payload.title) return "Missing payload.title";
  return null; // valid
}

// --- Routes ---

// Health check
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

    // Oversized scenes → split
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

// Paste-save routes
app.post("/lyra/paste-save", handleSave);
app.post("/doc", handleSave);

// --- Bulk ingest (batch of docs) ---
app.post("/lyra/ingest-batch", async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Request body must be an array of docs" });
    }

    const results = [];
    for (const rawDoc of req.body) {
      try {
        // Auto-wrap into payload if not already wrapped
        const doc = rawDoc.payload ? rawDoc : {
          docMode: "create",
          payload: {
            doc_type: rawDoc.doc_type,
            title: rawDoc.title,
            body_md: rawDoc.body_md || "",
            tags: rawDoc.tags || [],
            meta: rawDoc.meta || {}
          },
          id: rawDoc.id || uuidv4()
        };

        const validationError = validateRequest(doc);
        if (validationError) {
          results.push({ title: doc?.payload?.title || "unknown", error: validationError });
          continue;
        }

        const id = doc.id || uuidv4();
        const bodyText = doc.payload.body_md || "";

        if (bodyText.length > 8000) {
          const parts = splitText(bodyText);
          const savedParts = [];
          for (let idx = 0; idx < parts.length; idx++) {
            const partPayload = {
              ...doc,
              id: `${id}-p${idx + 1}`,
              payload: {
                ...doc.payload,
                title: `${doc.payload.title} (Part ${idx + 1})`,
                body_md: parts[idx],
              },
            };
            const result = await createOrUpdateDoc(partPayload.id, partPayload);
            savedParts.push(result);
          }
          results.push({ title: doc.payload.title, parts: savedParts.length, results: savedParts });
        } else {
          const result = await createOrUpdateDoc(id, doc);
          results.push({ title: doc.payload.title, result });
        }
      } catch (err) {
        console.error("❌ Ingest error for doc", rawDoc?.title, err);
        results.push({ title: rawDoc?.title || "unknown", error: err.message });
      }
    }

    res.json({
      success: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      results,
    });
  } catch (err) {
    console.error("❌ /lyra/ingest-batch error", err);
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

// --- Hard Reset: Lyra Index ---
app.post("/lyra/refresh", async (req, res) => {
  try {
    console.log("🧹 Clearing Lyra index...");
    const data = await exportProject(req.query.project_name || "default");
    console.log(`🔄 Rebuilt Lyra index with ${data.docs.length} docs`);
    res.json({ success: true, count: data.docs.length });
  } catch (err) {
    console.error("❌ /lyra/refresh error", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Lyra API running on port ${PORT}`);
});