// db.pg.mjs
import pg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Low-level helper ---
export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// --- READ docs ---
export async function readDocs({ project_name, doc_type, title, id, tags }) {
  let where = [];
  let params = [];
  let idx = 1;

  if (doc_type) {
    where.push(`doc_type = $${idx++}`);
    params.push(doc_type);
  }
  if (title) {
    where.push(`title ILIKE $${idx++}`);
    params.push(`%${title}%`);
  }
  if (id) {
    where.push(`id = $${idx++}`);
    params.push(id);
  }
  if (tags && tags.length) {
    where.push(`tags @> $${idx++}`);
    params.push(JSON.stringify(tags));
  }

  const sql = `
    SELECT id, doc_type, title, body, tags, meta, created_at, updated_at
    FROM writing.concepts
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC
    LIMIT 50
  `;

  const result = await query(sql, params);
  return result.rows;
}

// --- SEARCH docs ---
export async function searchDocs({ project_name, q }) {
  const sql = `
    SELECT id, doc_type, title, body, tags, meta
    FROM writing.concepts
    WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,'')) @@ plainto_tsquery($1)
    ORDER BY updated_at DESC
    LIMIT 50
  `;
  const result = await query(sql, [q]);
  return result.rows;
}

// --- SAVE doc (create/update) ---
export async function saveDoc({ project_name, docMode, sceneWriteMode, id, payload }) {
  const {
    doc_type,
    title,
    body_md,
    tags = [],
    meta = {},
  } = payload;

  const docId = id || uuidv4();

  if (docMode === "update") {
    if (sceneWriteMode === "append") {
      // Append to body
      const sql = `
        UPDATE writing.concepts
        SET body = coalesce(body, '') || $1,
            updated_at = now()
        WHERE id = $2
        RETURNING *
      `;
      const result = await query(sql, [`\n${body_md || ""}`, docId]);
      return result.rows[0];
    } else {
      // Overwrite update
      const sql = `
        UPDATE writing.concepts
        SET title = $1,
            body = $2,
            tags = $3,
            meta = $4,
            updated_at = now()
        WHERE id = $5
        RETURNING *
      `;
      const result = await query(sql, [title, body_md, JSON.stringify(tags), JSON.stringify(meta), docId]);
      return result.rows[0];
    }
  } else {
    // CREATE new doc
    const sql = `
      INSERT INTO writing.concepts (id, book_id, doc_type, title, body, tags, meta)
      VALUES ($1, (SELECT id FROM writing.books LIMIT 1), $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          body = EXCLUDED.body,
          tags = EXCLUDED.tags,
          meta = EXCLUDED.meta,
          updated_at = now()
      RETURNING *
    `;
    const result = await query(sql, [docId, doc_type, title, body_md, JSON.stringify(tags), JSON.stringify(meta)]);
    return result.rows[0];
  }
}

// --- EXPORT all docs for a project ---
export async function exportProject({ project_name }) {
  const sql = `
    SELECT id, doc_type, title, body, tags, meta, created_at, updated_at
    FROM writing.concepts
    ORDER BY updated_at DESC
  `;
  const result = await query(sql);
  return result.rows;
}