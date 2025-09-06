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

// --- Helper: split oversized text ---
function splitText(text, maxLen = 8000) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}

// --- Helper: merge split docs ---
function mergeParts(rows) {
  const grouped = {};

  for (const row of rows) {
    const baseId = row.id.includes("-p") ? row.id.split("-p")[0] : row.id;

    if (!grouped[baseId]) {
      grouped[baseId] = { ...row, id: baseId, body: "" };
    }

    grouped[baseId].body += row.body || "";
  }

  return Object.values(grouped);
}

// --- Create Doc ---
export async function createDoc(project_name, payload, topLevel = {}) {
  const id = payload.id || uuidv4();

  const tags = payload.tags || topLevel.tags || [];
  const meta = payload.meta || topLevel.meta || {};
  const body = payload.body_md || "";

  // ✅ Oversized: split into parts
  if (body.length > 8000) {
    const parts = splitText(body);
    const savedParts = [];

    for (let idx = 0; idx < parts.length; idx++) {
      const partId = `${id}-p${idx + 1}`;
      const partResult = await query(
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
          partId,
          "00000000-0000-0000-0000-000000000001",
          payload.doc_type,
          `${payload.title} (Part ${idx + 1})`,
          parts[idx],
          JSON.stringify(tags),
          JSON.stringify(meta),
        ]
      );
      savedParts.push(partResult.rows[0]);
    }

    return { id, parts: savedParts.length, results: savedParts };
  }

  // ✅ Normal insert
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
      "00000000-0000-0000-0000-000000000001",
      payload.doc_type,
      payload.title,
      body,
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

  // ✅ Merge split docs into full scenes
  return mergeParts(result.rows);
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

  // ✅ Merge split docs so search results show full scenes
  return mergeParts(result.rows);
}

// --- Export Project ---
export async function exportProject(project_name) {
  const result = await query(
    `SELECT * FROM writing.misc ORDER BY updated_at DESC`,
    []
  );

  // ✅ Merge split docs so export has whole docs
  return { docs: mergeParts(result.rows) };
}