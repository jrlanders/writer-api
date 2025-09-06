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

  const tags = payload.tags || topLevel.tags || [];
  const meta = payload.meta || topLevel.meta || {};

  const result = await query(
    `
    INSERT INTO writing.misc (id, book_id, doc_type, title, body, tags, meta)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        body = EXCLUDED.body,
        tags = EXCLUDED.tags,
        meta = EXCLUDED.meta
    RETURNING *;
    `,
    [
      id,
      "00000000-0000-0000-0000-000000000001", // default book_id
      payload.doc_type,
      payload.title,
      payload.body_md || "",
      JSON.stringify(tags),
      JSON.stringify(meta),
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

// --- Read Docs (with merge of parts) ---
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

  sql += ` ORDER BY updated_at ASC`;

  const result = await query(sql, values);
  const rows = result.rows;

  // --- Merge "(Part N)" docs ---
  const merged = {};
  for (const row of rows) {
    const baseTitle = row.title.replace(/\(Part \d+\)$/, "").trim();

    if (!merged[baseTitle]) {
      merged[baseTitle] = { ...row, body: row.body || "" };
    } else {
      merged[baseTitle].body += "\n\n" + (row.body || "");
      merged[baseTitle].updated_at =
        row.updated_at > merged[baseTitle].updated_at ? row.updated_at : merged[baseTitle].updated_at;
    }
  }

  return Object.values(merged);
}

// --- Search Docs (with merge) ---
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

  const rows = result.rows;
  const merged = {};
  for (const row of rows) {
    const baseTitle = row.title.replace(/\(Part \d+\)$/, "").trim();

    if (!merged[baseTitle]) {
      merged[baseTitle] = { ...row, body: row.body || "" };
    } else {
      merged[baseTitle].body += "\n\n" + (row.body || "");
    }
  }

  return Object.values(merged);
}

// --- Export Project (with merge) ---
export async function exportProject(project_name) {
  const result = await query(`SELECT * FROM writing.misc ORDER BY updated_at DESC`, []);
  const rows = result.rows;

  const merged = {};
  for (const row of rows) {
    const baseTitle = row.title.replace(/\(Part \d+\)$/, "").trim();

    if (!merged[baseTitle]) {
      merged[baseTitle] = { ...row, body: row.body || "" };
    } else {
      merged[baseTitle].body += "\n\n" + (row.body || "");
    }
  }

  return { docs: Object.values(merged) };
}