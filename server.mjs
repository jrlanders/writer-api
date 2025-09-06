// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import {
  createOrUpdateDoc,
  lyraRead,
  searchDocs,
  exportProject,
} from "./db.pg.mjs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "writer-api" });
});

// --- Lyra Read ---
app.get("/lyra/read", async (req, res) => {
  try {
    const { project_name, id, title, doc_type, tags, ci } = req.query;
    const result = await lyraRead({
      project_name,
      id,
      title,
      doc_type,
      tags,
      ci,
    });
    res.json(result);
  } catch (err) {
    console.error("Error in /lyra/read:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Lyra Search ---
app.get("/search", async (req, res) => {
  try {
    const { project_name, q, limit } = req.query;
    const result = await searchDocs(project_name, q, limit ? Number(limit) : 10);
    res.json(result);
  } catch (err) {
    console.error("Error in /search:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Paste-Save (create or update) ---
app.post("/lyra/paste-save", async (req, res) => {
  try {
    const { project_name, docMode = "create", id, sceneWriteMode, payload } = req.body;

    const result = await createOrUpdateDoc(project_name, {
      docMode,
      id,
      sceneWriteMode,
      payload,
    });

    res.json(result);
  } catch (err) {
    console.error("Error in /lyra/paste-save:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Export ---
app.get("/export", async (req, res) => {
  try {
    const { project_name } = req.query;
    const result = await exportProject(project_name);
    res.json(result);
  } catch (err) {
    console.error("Error in /export:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Writer API server running on port ${PORT}`);
});