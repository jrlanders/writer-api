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

// --- Helper: chunk text ---
function chunkText(text, size = 10000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// --- Create Doc ---
export async function createDoc(project_name, payload, topLevel = {}) {
  const id = payload.id || uuidv4();

  // ✅ Normalize tags and meta from payload or top-level
  const tags = payload.tags || topLevel.tags || [];
  const meta = payload.meta || topLevel.meta || {};
  const body = payload.body_md || "";

  // Insert into misc (metadata only)
  const result = await query(
    `
    INSERT INTO writing.misc (id, book_id, doc_type, title, body, tags, meta)
    VALUES ($1, $2, $3, $4, NULL, $5, $6)
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        tags = EXCLUDED.tags,
        meta = EXCLUDED.meta
    RETURNING *;
    `,
    [
      id,
      "00000000-0000-0000-0000-000000000001", // default book_id
      payload.doc_type,
      payload.title,
      JSON.stringify(tags),
      JSON.stringify(meta),
    ]
  );

  // If this is a scene, chunk and save body into scene_parts
  if (payload.doc_type === "scene" && body) {
    const chunks = chunkText(body);

    // Clear existing parts if any
    await query(`DELETE FROM writing.scene_parts WHERE scene_id = $1`, [id]);

    // Insert chunks
    for (let i = 0; i < chunks.length; i++) {
      await query(
        `
        INSERT INTO writing.scene_parts (scene_id, part_number, body)
        VALUES ($1, $2, $3)
        `,
        [id, i + 1, chunks[i]]
      );
    }
  }

  return result.rows[0];
}

// --- Update Doc ---
export async function updateDoc(project_name, id, payload, sceneWriteMode) {
  const fields = [];
  const values = [];
  let i = 1;

  if (payload.title) {
    fields.push(`title = $${i++}`);
    values.push(payload.title);
  }
  if (payload.tags) {
    fields.push(`tags = $${i++}`);
    values.push(JSON.stringify(payload.tags));
  }
  if (payload.meta) {
    fields.push(`meta = $${i++}`);
    values.push(JSON.stringify(payload.meta));
  }

  let updateSql = `UPDATE writing.misc SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`;
  values.push(id);

  const result = await query(updateSql, values);

  // --- Handle body updates for scenes ---
  if (payload.body_md) {
    if (sceneWriteMode === "append") {
      // Append new chunk
      const { rows } = await query(
        `SELECT COALESCE(MAX(part_number),0)+1 as next_part FROM writing.scene_parts WHERE scene_id = $1`,
        [id]
      );
      const nextPart = rows[0].next_part;
      await query(
        `INSERT INTO writing.scene_parts (scene_id, part_number, body) VALUES ($1, $2, $3)`,
        [id, nextPart, payload.body_md]
      );
    } else {
      // Overwrite
      await query(`DELETE FROM writing.scene_parts WHERE scene_id = $1`, [id]);
      const chunks = chunkText(payload.body_md);
      for (let j = 0; j < chunks.length; j++) {
        await query(
          `INSERT INTO writing.scene_parts (scene_id, part_number, body) VALUES ($1, $2, $3)`,
          [id, j + 1, chunks[j]]
        );
      }
    }
  }

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
  const docs = result.rows;

  // If scene, pull parts and assemble body
  for (const doc of docs) {
    if (doc.doc_type === "scene") {
      const parts = await query(
        `SELECT body FROM writing.scene_parts WHERE scene_id = $1 ORDER BY part_number`,
        [doc.id]
      );
      doc.body = parts.rows.map(r => r.body).join("");
    }
  }

  return docs;
}

// --- Search Docs ---
export async function searchDocs(filters = {}) {
  const q = filters.q || "";

  // Search both misc and scene_parts
  const result = await query(
    `
    SELECT m.*, string_agg(sp.body, '' ORDER BY sp.part_number) as body
    FROM writing.misc m
    LEFT JOIN writing.scene_parts sp ON m.id = sp.scene_id
    WHERE m.title ILIKE $1 OR sp.body ILIKE $1
    GROUP BY m.id
    ORDER BY m.updated_at DESC
    `,
    [`%${q}%`]
  );

  return result.rows;
}

// --- Export Project ---
export async function exportProject(project_name) {
  const result = await query(`SELECT * FROM writing.misc ORDER BY updated_at DESC`, []);
  const docs = result.rows;

  for (const doc of docs) {
    if (doc.doc_type === "scene") {
      const parts = await query(
        `SELECT body FROM writing.scene_parts WHERE scene_id = $1 ORDER BY part_number`,
        [doc.id]
      );
      doc.body = parts.rows.map(r => r.body).join("");
    }
  }

  return { docs };
}