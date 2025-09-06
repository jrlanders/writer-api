// db.pg.mjs
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Helper: query wrapper ---
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// --- Create Doc ---
export async function createDoc(project_name, payload, topLevel = {}) {
  const id = payload.id || uuidv4();

  // Normalize optional fields — only pass if present
  const doc_type = payload.doc_type;
  const title = payload.title;
  const body = payload.body_md || "";
  const tags =
    payload.tags || topLevel.tags ? JSON.stringify(payload.tags || topLevel.tags) : null;
  const meta =
    payload.meta || topLevel.meta ? JSON.stringify(payload.meta || topLevel.meta) : null;

  const result = await query(
    `
    INSERT INTO writing.misc (id, book_id, doc_type, title, body, tags, meta)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, DEFAULT), COALESCE($7, DEFAULT))
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        body = EXCLUDED.body,
        tags = COALESCE(EXCLUDED.tags, writing.misc.tags),
        meta = COALESCE(EXCLUDED.meta, writing.misc.meta)
    RETURNING *;
    `,
    [
      id,
      "00000000-0000-0000-0000-000000000001", // default book_id
      doc_type,
      title,
      body,
      tags,
      meta,
    ]
  );

  return result.rows[0];
}

// --- Update Doc ---
export async function updateDoc(project_name, id, payload, sceneWriteMode) {
  let updateSql = `UPDATE writing.misc SET `;
  const fields = [];
  const values = [];
  let i = 1;

  if (payload.title) {
    fields.push(`title = $${i++}`);
    values.push(payload.title);
  }
  if (payload.body_md) {
    if (sceneWriteMode === "append") {
      fields.push(`body = COALESCE(body, '') || $${i++}`);
    } else {
      fields.push(`body = $${i++}`);
    }
    values.push(payload.body_md);
  }
  if (payload.tags) {
    fields.push(`tags = $${i++}`);
    values.push(JSON.stringify(payload.tags));
  }
  if (payload.meta) {
    fields.push(`meta = $${i++}`);
    values.push(JSON.stringify(payload.meta));
  }

  if (fields.length === 0) return null;

  updateSql += fields.join(", ") + ` WHERE id = $${i} RETURNING *`;
  values.push(id);

  const result = await query(updateSql, values);
  return result.rows[0];
}

// --- Create or Update Doc ---
export async function createOrUpdateDoc(id, request) {
  const { project_name, docMode, sceneWriteMode, payload, ...topLevel } = request;

  if (docMode === "update") {
    return updateDoc(project_name, id, payload, sceneWriteMode);
  }
  return createDoc(project_name, payload, topLevel);
}

// --- Read Docs ---
export async function readDocs(filters = {}) {
  let sql = `SELECT * FROM writing.misc WHERE 1=1`;
  const values = [];
  let i = 1;

  if (filters.doc_type) {
    sql += ` AND doc_type = $${i++}`;
    values.push(filters.doc_type);
  }
  if (filters.title) {
    sql += ` AND title ILIKE $${i++}`;
    values.push(filters.title);
  }

  const result = await query(sql, values);
  return result.rows;
}

// --- Search Docs ---
export async function searchDocs(filters = {}) {
  const q = filters.q || "";
  const result = await query(
    `
    SELECT * FROM writing.misc
    WHERE title ILIKE $1 OR body ILIKE $1
    ORDER BY updated_at DESC
    `,
    [`%${q}%`]
  );
  return result.rows;
}

// --- Export Project ---
export async function exportProject(project_name) {
  const result = await query(
    `SELECT * FROM writing.misc ORDER BY updated_at DESC`,
    []
  );
  return { docs: result.rows };
}