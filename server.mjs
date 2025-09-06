import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  createOrUpdateDoc,
  readDocs,
  searchDocs,
  exportProject,
  ingestDocs
} from "./db.pg.mjs";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Lyra Writer API" });
});

// Read docs
app.get("/lyra/read", async (req, res) => {
  try {
    const { project_name, id, title, doc_type, tags, ci } = req.query;
    const result = await readDocs({
      project_name,
      id,
      title,
      doc_type,
      tags,
      ci
    });
    res.json(result);
  } catch (err) {
    console.error("❌ /lyra/read error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create or update docs (formerly paste-save)
app.post("/lyra/paste-save", async (req, res) => {
  try {
    const { project_name, docMode, sceneWriteMode, id, payload } = req.body;
    const result = await createOrUpdateDoc(
      project_name,
      payload,
      docMode,
      sceneWriteMode,
      id
    );
    res.json({ success: true, result });
  } catch (err) {
    console.error("❌ /lyra/paste-save error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Batch ingest
app.post("/lyra/ingest", async (req, res) => {
  try {
    const { project_name, docs } = req.body;
    const result = await ingestDocs(project_name, docs);
    res.json({ success: true, result });
  } catch (err) {
    console.error("❌ /lyra/ingest error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Search
app.get("/search", async (req, res) => {
  try {
    const { project_name, q, limit } = req.query;
    const result = await searchDocs(project_name, q, limit);
    res.json(result);
  } catch (err) {
    console.error("❌ /search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Export
app.get("/export", async (req, res) => {
  try {
    const { project_name } = req.query;
    const result = await exportProject(project_name);
    res.json(result);
  } catch (err) {
    console.error("❌ /export error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Lyra Writer API running on http://localhost:${PORT}`);
});