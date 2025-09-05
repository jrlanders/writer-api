// server.mjs
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import {
  createDoc,
  updateDoc,
  listDocs,
  getDoc,
  deleteDoc,
  searchDocs,
  exportAll,
} from "./db.pg.mjs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// --- Routes ---

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// List all docs
app.get("/docs", async (req, res) => {
  try {
    const docs = await listDocs();
    res.json(docs);
  } catch (err) {
    console.error("Error listing docs:", err);
    res.status(500).json({ error: "Failed to list docs" });
  }
});

// Get one doc
app.get("/docs/:id", async (req, res) => {
  try {
    const doc = await getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (err) {
    console.error("Error getting doc:", err);
    res.status(500).json({ error: "Failed to fetch doc" });
  }
});

// Create a new doc
app.post("/docs", async (req, res) => {
  try {
    const result = await createDoc(req.body);
    res.json(result);
  } catch (err) {
    console.error("Error creating doc:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update a doc
app.put("/docs/:id", async (req, res) => {
  try {
    const result = await updateDoc(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    console.error("Error updating doc:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a doc
app.delete("/docs/:id", async (req, res) => {
  try {
    const result = await deleteDoc(req.params.id);
    res.json(result);
  } catch (err) {
    console.error("Error deleting doc:", err);
    res.status(500).json({ error: "Failed to delete doc" });
  }
});

// Search docs
app.get("/search", async (req, res) => {
  try {
    const term = req.query.q;
    if (!term) return res.status(400).json({ error: "Missing query param q" });
    const results = await searchDocs(term);
    res.json(results);
  } catch (err) {
    console.error("Error searching docs:", err);
    res.status(500).json({ error: "Failed to search" });
  }
});

// Export all docs
app.get("/export", async (req, res) => {
  try {
    const all = await exportAll();
    res.json(all);
  } catch (err) {
    console.error("Error exporting docs:", err);
    res.status(500).json({ error: "Failed to export" });
  }
});

// Import docs (bulk load)
app.post("/import", async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Expected an array of docs" });
    }

    const results = [];
    for (const doc of req.body) {
      try {
        const result = await createDoc(doc);
        results.push({ id: doc.id || null, status: "ok", result });
      } catch (err) {
        console.error("Error importing doc:", doc.title || doc.id, err);
        results.push({ id: doc.id || null, status: "error", error: err.message });
      }
    }

    res.json({ imported: results.length, results });
  } catch (err) {
    console.error("Error importing docs:", err);
    res.status(500).json({ error: "Failed to import" });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});