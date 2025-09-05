import { v4 as uuidv4, validate as uuidValidate } from "uuid";
import express from "express";
import db from "./db.pg.mjs";

const router = express.Router();

//
// --- Validation Middleware ---
//
function validateUUID(field) {
  return (req, res, next) => {
    const value = req.params[field] || req.body[field];
    if (value && !uuidValidate(value)) {
      return res.status(400).json({ error: `Invalid UUID for ${field}` });
    }
    next();
  };
}

function requireFields(fields) {
  return (req, res, next) => {
    for (const f of fields) {
      if (!req.body[f]) {
        return res.status(400).json({ error: `Missing required field: ${f}` });
      }
    }
    next();
  };
}

function normalizeBody(req, res, next) {
  if (req.body.body_md && !req.body.body) {
    req.body.body = req.body.body_md;
    delete req.body.body_md;
  }
  next();
}

//
// --- Utility Queries ---
//
async function query(sql, params) {
  const { rows } = await db.query(sql, params);
  return rows;
}

//
// --- Series ---
//
router.get("/series", async (req, res) => {
  res.json(await query("SELECT * FROM writing.series ORDER BY created_at"));
});

router.post("/series", requireFields(["title"]), async (req, res) => {
  const id = uuidv4();
  await query(
    `INSERT INTO writing.series (id, title, synopsis) VALUES ($1, $2, $3)`,
    [id, req.body.title, req.body.synopsis || null]
  );
  res.json({ id });
});

//
// --- Books ---
//
router.get("/books", async (req, res) => {
  res.json(await query("SELECT * FROM writing.books ORDER BY created_at"));
});

router.post(
  "/books",
  requireFields(["series_id", "title"]),
  validateUUID("series_id"),
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.books (id, series_id, title, synopsis) VALUES ($1, $2, $3, $4)`,
      [id, req.body.series_id, req.body.title, req.body.synopsis || null]
    );
    res.json({ id });
  }
);

//
// --- Acts / Sections / Chapters / Scenes ---
//
router.get("/acts/:book_id", validateUUID("book_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.acts WHERE book_id=$1", [req.params.book_id])
  );
});

router.post(
  "/acts",
  requireFields(["book_id", "act_number"]),
  validateUUID("book_id"),
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.acts (id, book_id, act_number, synopsis)
       VALUES ($1, $2, $3, $4)`,
      [id, req.body.book_id, req.body.act_number, req.body.synopsis || null]
    );
    res.json({ id });
  }
);

// Sections
router.get("/sections/:act_id", validateUUID("act_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.sections WHERE act_id=$1", [req.params.act_id])
  );
});

router.post(
  "/sections",
  requireFields(["act_id", "section_number"]),
  validateUUID("act_id"),
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.sections (id, act_id, section_number, name, synopsis)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        req.body.act_id,
        req.body.section_number,
        req.body.name || null,
        req.body.synopsis || null,
      ]
    );
    res.json({ id });
  }
);

// Chapters
router.get("/chapters/:section_id", validateUUID("section_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.chapters WHERE section_id=$1", [
      req.params.section_id,
    ])
  );
});

router.post(
  "/chapters",
  requireFields(["section_id", "chapter_number"]),
  validateUUID("section_id"),
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.chapters (id, section_id, chapter_number, title, synopsis)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.body.section_id, req.body.chapter_number, req.body.title || null, req.body.synopsis || null]
    );
    res.json({ id });
  }
);

// Scenes
router.get("/scenes/:chapter_id", validateUUID("chapter_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.scenes WHERE chapter_id=$1", [
      req.params.chapter_id,
    ])
  );
});

router.post(
  "/scenes",
  requireFields(["chapter_id", "scene_number", "title"]),
  [validateUUID("chapter_id"), normalizeBody],
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.scenes (id, chapter_id, scene_number, title, synopsis, body, start_datetime, end_datetime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        req.body.chapter_id,
        req.body.scene_number,
        req.body.title,
        req.body.synopsis || null,
        req.body.body || "",
        req.body.start_datetime || null,
        req.body.end_datetime || null,
      ]
    );
    res.json({ id });
  }
);

//
// --- Characters ---
//
router.get("/characters/:book_id", validateUUID("book_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.characters WHERE book_id=$1", [
      req.params.book_id,
    ])
  );
});

router.post(
  "/characters",
  requireFields(["book_id", "name"]),
  [validateUUID("book_id"), normalizeBody],
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.characters (id, book_id, name, biography, aliases)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.body.book_id, req.body.name, req.body.body || "", req.body.aliases || []]
    );
    res.json({ id });
  }
);

//
// --- Concepts / Lore / Artifacts / Index ---
//
router.get("/concepts/:book_id", validateUUID("book_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.concepts WHERE book_id=$1", [
      req.params.book_id,
    ])
  );
});

router.post(
  "/concepts",
  requireFields(["book_id", "title"]),
  [validateUUID("book_id"), normalizeBody],
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.concepts (id, book_id, doc_type, title, body, tags, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        req.body.book_id,
        req.body.doc_type || "concept",
        req.body.title,
        req.body.body || "",
        req.body.tags || [],
        req.body.meta || {},
      ]
    );
    res.json({ id });
  }
);

//
// --- Misc ---
//
router.get("/misc/:book_id", validateUUID("book_id"), async (req, res) => {
  res.json(
    await query("SELECT * FROM writing.misc WHERE book_id=$1", [req.params.book_id])
  );
});

router.post(
  "/misc",
  requireFields(["book_id", "doc_type", "title"]),
  [validateUUID("book_id"), normalizeBody],
  async (req, res) => {
    const id = uuidv4();
    await query(
      `INSERT INTO writing.misc (id, book_id, doc_type, title, body, tags, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        req.body.book_id,
        req.body.doc_type,
        req.body.title,
        req.body.body || "",
        req.body.tags || [],
        req.body.meta || {},
      ]
    );
    res.json({ id });
  }
);

//
// --- Search ---
//
router.get("/search", async (req, res) => {
  const q = `%${req.query.q || ""}%`;
  const results = await query(
    `
    SELECT 'concept' AS type, id, title, body FROM writing.concepts WHERE title ILIKE $1 OR body ILIKE $1
    UNION
    SELECT 'character', id, name, biography FROM writing.characters WHERE name ILIKE $1 OR biography ILIKE $1
    UNION
    SELECT 'misc', id, title, body FROM writing.misc WHERE title ILIKE $1 OR body ILIKE $1
    LIMIT 50
    `,
    [q]
  );
  res.json(results);
});

export default router;