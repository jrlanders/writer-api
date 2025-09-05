// server.mjs
import express from "express";
import bodyParser from "body-parser";
import {
  readDocs,
  searchDocs,
  exportProject,
  saveDoc,
} from "./db.pg.mjs"; // assumes db.pg.mjs exports these

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// --- Health Check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Lyra API" });
});

// --- READ (by title, id, tags, or doc_type) ---
app.get("/lyra/read", async (req, res) => {
  try {
    const { project_name, id, title, doc_type, tags, ci } = req.query;
    const docs = await readDocs({
      project_name,
      id,
      title,
      doc_type,
      tags,
      ci: ci === "true",
    });
    res.json(docs);
  } catch (err) {
    console.error("❌ Error in /lyra/read:", err);
    res.status(500).json({ error: "Failed to read docs" });
  }
});

// --- SEARCH (full-text) ---
app.get("/lyra/search", async (req, res) => {
  try {
    const { project_name, q, limit } = req.query;
    const results = await searchDocs({
      project_name,
      q,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    res.json(results);
  } catch (err) {
    console.error("❌ Error in /lyra/search:", err);
    res.status(500).json({ error: "Failed to search docs" });
  }
});

// --- EXPORT (all docs for a project) ---
app.get("/export", async (req, res) => {
  try {
    const { project_name } = req.query;
    const json = await exportProject({ project_name });
    res.setHeader("Content-Type", "application/json");
    res.send(json);
  } catch (err) {
    console.error("❌ Error in /export:", err);
    res.status(500).json({ error: "Failed to export project" });
  }
});

// --- WRITE (create/update/append) ---
app.post("/lyra/paste-save", async (req, res) => {
  try {
    const {
      project_name,
      docMode = "create",
      sceneWriteMode = "overwrite",
      id,
      payload,
    } = req.body;

    if (!project_name || !payload?.doc_type || !payload?.title) {
      return res
        .status(400)
        .json({ error: "Missing required fields: project_name, doc_type, title" });
    }

    const result = await saveDoc({
      project_name,
      docMode,
      sceneWriteMode,
      id,
      payload,
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error("❌ Error in /lyra/paste-save:", err);
    res.status(500).json({ error: "Failed to save doc" });
  }
});

// --- Fallback ---
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.url}` });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🚀 Lyra API server running on port ${PORT}`);
});