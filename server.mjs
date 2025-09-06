// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import {
  createDoc,
  updateDoc,
  readDocs,
  searchDocs,
  exportProject,
} from "./db.pg.mjs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Health Check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// --- Read ---
app.get("/lyra/read", async (req, res) => {
  try {
    const docs = await readDocs(req.query);
    res.json(docs);
  } catch (err) {
    console.error("❌ Read error:", err);
    res.status(500).json({ error: "Failed to read docs" });
  }
});

// --- Search ---
app.get("/search", async (req, res) => {
  try {
    const results = await searchDocs(req.query);
    res.json(results);
  } catch (err) {
    console.error("❌ Search error:", err);
    res.status(500).json({ error: "Failed to search docs" });
  }
});

// --- Paste-Save (create/update single doc) ---
app.post("/lyra/paste-save", async (req, res) => {
  try {
    const { project_name, docMode, sceneWriteMode, id, payload } = req.body;

    if (docMode === "update" && id) {
      const updated = await updateDoc(project_name, id, payload, sceneWriteMode);
      res.json({ status: "updated", doc: updated });
    } else {
      const created = await createDoc(project_name, payload);
      res.json({ status: "created", doc: created });
    }
  } catch (err) {
    console.error("❌ Paste-Save error:", err);
    res.status(500).json({ error: "Failed to save doc" });
  }
});

// --- Ingest (batch create/update multiple docs) ---
app.post("/lyra/ingest", async (req, res) => {
  try {
    const { project_name, docs } = req.body;
    if (!Array.isArray(docs)) {
      return res.status(400).json({ error: "docs must be an array" });
    }

    const results = [];
    for (const doc of docs) {
      try {
        if (doc.docMode === "update" && doc.id) {
          const updated = await updateDoc(
            project_name,
            doc.id,
            doc.payload,
            doc.sceneWriteMode
          );
          results.push({ id: doc.id, status: "updated" });
        } else {
          const created = await createDoc(project_name, doc.payload);
          results.push({ id: created.id, status: "created" });
        }
      } catch (innerErr) {
        console.error(`❌ Ingest error for doc ${doc.id || "new"}:`, innerErr);
        results.push({
          id: doc.id || null,
          status: "error",
          message: innerErr.message,
        });
      }
    }

    res.json({ status: "ok", results });
  } catch (err) {
    console.error("❌ Ingest error:", err);
    res.status(500).json({ error: "Failed to ingest docs" });
  }
});

// --- Export ---
app.get("/export", async (req, res) => {
  try {
    const data = await exportProject(req.query.project_name);
    res.json(data);
  } catch (err) {
    console.error("❌ Export error:", err);
    res.status(500).json({ error: "Failed to export project" });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🚀 Lyra API running on port ${PORT}`);
});