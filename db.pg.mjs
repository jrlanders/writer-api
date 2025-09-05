// db.pg.mjs
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Helpers ---
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

function normalizeRow(row, doc_type) {
  return {
    id: row.id,
    doc_type,
    title: row.title,
    body: row.body,
    tags: row.tags || [],
    meta: row.meta || {},
    project_id: row.book_id ?? row.project_id ?? null,
  };
}

// --- Core API ---
export async function createDoc(doc) {
  const { id, project_id, doc_type, title, body, tags = [], meta = {} } = doc;
  switch (doc_type) {
    case "character":
      await query(
        `INSERT INTO writing.characters (id, book_id, name, biography, aliases)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [id, project_id, title, body, JSON.stringify(tags)]
      );
      return { ok: true, id };

    case "concept":
    case "lore":
    case "artifact":
    case "index":
      await query(
        `INSERT INTO writing.concepts (id, book_id, doc_type, title, body, tags, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [id, project_id, doc_type, title, body, JSON.stringify(tags), meta]
      );
      return { ok: true, id };

    case "scene":
      await query(
        `INSERT INTO writing.scenes (id, chapter_id, scene_number, title, body, synopsis, start_datetime, end_datetime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [
          id,
          meta.chapter_id,
          meta.scene_number,
          title,
          body,
          meta.synopsis || null,
          meta.start || null,
          meta.end || null,
        ]
      );
      return { ok: true, id };

    case "misc":
    case "toc":
    case "template":
    case "section":
    case "deleted":
      await query(
        `INSERT INTO writing.misc (id, book_id, doc_type, title, body, tags, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [id, project_id, doc_type, title, body, JSON.stringify(tags), meta]
      );
      return { ok: true, id };

    default:
      throw new Error(`Unsupported doc_type: ${doc_type}`);
  }
}

export async function updateDoc(id, doc) {
  const { doc_type, title, body, tags = [], meta = {} } = doc;
  switch (doc_type) {
    case "character":
      await query(
        `UPDATE writing.characters
         SET name=$2, biography=$3, aliases=$4, updated_at=now()
         WHERE id=$1`,
        [id, title, body, JSON.stringify(tags)]
      );
      return { ok: true, id };

    case "concept":
    case "lore":
    case "artifact":
    case "index":
      await query(
        `UPDATE writing.concepts
         SET title=$2, body=$3, tags=$4, meta=$5, updated_at=now()
         WHERE id=$1`,
        [id, title, body, JSON.stringify(tags), meta]
      );
      return { ok: true, id };

    case "scene":
      await query(
        `UPDATE writing.scenes
         SET title=$2, body=$3, synopsis=$4, start_datetime=$5, end_datetime=$6, updated_at=now()
         WHERE id=$1`,
        [
          id,
          title,
          body,
          meta.synopsis || null,
          meta.start || null,
          meta.end || null,
        ]
      );
      return { ok: true, id };

    case "misc":
    case "toc":
    case "template":
    case "section":
    case "deleted":
      await query(
        `UPDATE writing.misc
         SET title=$2, body=$3, tags=$4, meta=$5, updated_at=now()
         WHERE id=$1`,
        [id, title, body, JSON.stringify(tags), meta]
      );
      return { ok: true, id };

    default:
      throw new Error(`Unsupported doc_type: ${doc_type}`);
  }
}

export async function listDocs() {
  const results = [];

  const chars = await query("SELECT * FROM writing.characters");
  results.push(...chars.map((r) => normalizeRow(r, "character")));

  const concepts = await query("SELECT * FROM writing.concepts");
  results.push(...concepts.map((r) => normalizeRow(r, r.doc_type || "concept")));

  const scenes = await query("SELECT * FROM writing.scenes");
  results.push(...scenes.map((r) => normalizeRow(r, "scene")));

  const misc = await query("SELECT * FROM writing.misc");
  results.push(...misc.map((r) => normalizeRow(r, r.doc_type || "misc")));

  return results;
}

export async function getDoc(id) {
  const all = await listDocs();
  return all.find((d) => d.id === id) || null;
}

export async function deleteDoc(id) {
  await query("DELETE FROM writing.characters WHERE id=$1", [id]);
  await query("DELETE FROM writing.concepts WHERE id=$1", [id]);
  await query("DELETE FROM writing.scenes WHERE id=$1", [id]);
  await query("DELETE FROM writing.misc WHERE id=$1", [id]);
  return { ok: true, id };
}

export async function searchDocs(term) {
  const sql = `
    SELECT id, 'character' as doc_type, name as title, biography as body, aliases as tags, '{}'::jsonb as meta
    FROM writing.characters WHERE name ILIKE $1 OR biography ILIKE $1
    UNION ALL
    SELECT id, doc_type, title, body, tags, meta
    FROM writing.concepts WHERE title ILIKE $1 OR body ILIKE $1
    UNION ALL
    SELECT id, 'scene' as doc_type, title, body, '{}'::jsonb as tags, '{}'::jsonb as meta
    FROM writing.scenes WHERE title ILIKE $1 OR body ILIKE $1
    UNION ALL
    SELECT id, doc_type, title, body, tags, meta
    FROM writing.misc WHERE title ILIKE $1 OR body ILIKE $1
  `;
  return query(sql, [`%${term}%`]);
}

export async function exportAll() {
  return listDocs();
}