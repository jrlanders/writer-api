// server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import OpenAI from 'openai'

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cors({ origin: ['http://localhost:3000', '*'] }))

// ====== 🔑 AUTH GUARD (set API_TOKEN in Render) ======
const API_TOKEN = process.env.API_TOKEN
const requireAuth = (req, res, next) => {
  if (!API_TOKEN) return next() // allow all if not set (dev)
  const ok = req.headers.authorization === `Bearer ${API_TOKEN}`
  if (!ok) return res.status(401).json({ error: 'Unauthorized' })
  next()
}
// =====================================================

// ENV
const DB_URL = process.env.DB_URL
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const MODEL_EMBED = process.env.MODEL_EMBED || 'text-embedding-3-small' // 1536-dim
const MODEL_CHAT  = process.env.MODEL_CHAT  || 'gpt-4o'

// Persistent default project (env fallback)
const DEFAULT_PROJECT_ID   = process.env.DEFAULT_PROJECT_ID || null
const DEFAULT_PROJECT_NAME = process.env.DEFAULT_PROJECT_NAME || null

if (!DB_URL || !OPENAI_API_KEY) {
  console.error('Missing DB_URL or OPENAI_API_KEY')
  process.exit(1)
}

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// Build tag / health
const APP_BUILD = '2025-08-28-session-defaults-1.4.4'

// Health checks
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    build: APP_BUILD,
    defaults: {
      inMemory: { id: defaultProjectId, name: defaultProjectName },
      env: { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME }
    }
  });
});

// ---------- Session default project (Option C) ----------
// In-memory session default (set via /set-default-project).
// These are cleared on process restart; resolver also falls back to env defaults above.
let defaultProjectId = null
let defaultProjectName = null

function coerceMeta(m) {
  // only allow plain objects; everything else becomes {}
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
}

app.post('/set-default-project', requireAuth, async (req, res) => {
  try {
    const { project_id, project_name } = req.body || {}
    if (!project_id && !project_name) {
      return res.status(400).json({ error: 'project_id or project_name required' })
    }
    if (project_id) {
      defaultProjectId = project_id
      defaultProjectName = null
    } else {
      // verify it exists (case-insensitive)
      const { rows } = await pool.query(`SELECT id FROM projects WHERE lower(name) = lower($1)`, [project_name])
      if (!rows.length) return res.status(404).json({ error: `Project not found: ${project_name}` })
      defaultProjectName = project_name
      defaultProjectId = null
    }
    res.json({ ok: true, defaultProjectId, defaultProjectName })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post('/clear-default-project', requireAuth, (_req, res) => {
  defaultProjectId = null
  defaultProjectName = null
  res.json({ ok: true, message: 'Default project cleared' })
})

async function resolveProjectId(project_id, project_name) {
  if (project_id) return project_id;
  if (project_name) {
    // case/trim/space-insensitive
    const { rows } = await pool.query(
      `SELECT id FROM projects
       WHERE trim(lower(name)) = trim(lower($1))`,
      [project_name]
    );
    if (!rows.length) throw new Error(`Project not found: ${project_name}`);
    return rows[0].id;
  }
  // fall back to in-memory / env defaults (your existing logic)
  if (defaultProjectId) return defaultProjectId;
  if (defaultProjectName) {
    const { rows } = await pool.query(
      `SELECT id FROM projects
       WHERE trim(lower(name)) = trim(lower($1))`,
      [defaultProjectName]
    );
    if (!rows.length) throw new Error(`Default project not found: ${defaultProjectName}`);
    return rows[0].id;
  }
  throw new Error('Need project_id or project_name (no default set)');
}

async function retrieveTopK(projectId, query, k = 8) {
  const emb = await openai.embeddings.create({ model: MODEL_EMBED, input: query })
  const vec = emb.data[0].embedding
  const vecStr = `[${vec.map(v => v.toFixed(8)).join(',')}]`
  const { rows } = await pool.query(
    `SELECT chunk_text, meta
       FROM embeddings
      WHERE project_id = $1
      ORDER BY embedding <-> $2::vector
      LIMIT $3`,
    [projectId, vecStr, k]
  )
  return rows
}

// ---------- PROJECTS ----------
app.post('/project', requireAuth, async (req, res) => {
  try {
    const { name, description = null } = req.body || {}
    if (!name) return res.status(400).json({ error: 'name required' })
    const look = await pool.query(`SELECT id FROM projects WHERE lower(name) = lower($1)`, [name])
    if (look.rows.length) return res.json({ project_id: look.rows[0].id, name })
    const ins = await pool.query(
      `INSERT INTO projects (name, description) VALUES ($1,$2) RETURNING id`,
      [name, description]
    )
    res.json({ project_id: ins.rows[0].id, name })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.get('/projects', requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, created_at
         FROM projects
        ORDER BY created_at DESC`
    )
    res.json({ items: rows })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ---------- READ: answer questions ----------
app.post('/ask', async (req, res) => {
  try {
    const { question, project_id, project_name = null, history = [] } = req.body || {}
    if (!question) return res.status(400).json({ error: 'question required' })

    const pid = await resolveProjectId(project_id, project_name || undefined)
    const ctx = await retrieveTopK(pid, question, 8)
    const contextBlock = ctx.map((r, i) => `[${i + 1}] ${r.chunk_text}`).join('\n\n')

    const projLabel = project_name || defaultProjectName || DEFAULT_PROJECT_NAME || 'My Project'
    const messages = [
      { role: 'system', content: `You are James's private writing assistant for "${projLabel}". Use only the provided context. Maintain continuity and Writing-from-the-Middle.` },
      ...history,
      { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${question}` }
    ]

    const resp = await openai.chat.completions.create({
      model: MODEL_CHAT,
      messages,
      temperature: 0.7
    })
    res.json({ answer: resp.choices[0].message.content, used_context: ctx })
  } catch (e) {
    const code = e.statusCode || 500
    res.status(code).json({ error: String(e.message || e) })
  }
})

// ---------- READ (streaming): ChatGPT-style typing ----------
app.post('/ask-stream', async (req, res) => {
  try {
    const { question, project_id, project_name = null, history = [] } = req.body || {}
    if (!question) return res.status(400).json({ error: 'question required' })

    const pid = await resolveProjectId(project_id, project_name || undefined)
    const ctx = await retrieveTopK(pid, question, 8)
    const contextBlock = ctx.map((r,i)=>`[${i+1}] ${r.chunk_text}`).join('\n\n')

    res.writeHead(200, {
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache',
      'Connection':'keep-alive',
      'Access-Control-Allow-Origin':'*'
    })

    const projLabel = project_name || defaultProjectName || DEFAULT_PROJECT_NAME || 'My Project'
    const messages = [
      { role:'system', content:`You are James's private writing assistant for "${projLabel}". Use only the provided context. Maintain continuity and Writing-from-the-Middle.` },
      ...history,
      { role:'user', content:`Context:\n${contextBlock}\n\nQuestion: ${question}` }
    ]

    const stream = await openai.chat.completions.create({
      model: MODEL_CHAT,
      messages, temperature: 0.7, stream: true
    })

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || ''
      if (delta) res.write(`data:${JSON.stringify({ delta })}\n\n`)
    }
    res.write(`data:${JSON.stringify({ done:true, used_context: ctx })}\n\n`)
    res.end()
  } catch (e) {
    res.write(`data:${JSON.stringify({ error:String(e.message || e) })}\n\n`)
    res.end()
  }
})

// ---------- WRITE: save a new doc + embed ----------
// ---------- WRITE: save a new doc + embed (with optional meta) ----------
app.post('/ingest', requireAuth, async (req, res) => {
  try {
    const { project_id, project_name, doc_type, title, body_md, tags = [], meta } = req.body || {};
    if (!doc_type || !title || !body_md) {
      return res.status(400).json({ error: 'doc_type, title, body_md required (plus project_id or project_name)' });
    }
    const pid = await resolveProjectId(project_id, project_name);
    const metaObj = coerceMeta(meta);

    // Insert the document (note: includes meta)
    const insertDocSQL = `
      INSERT INTO documents (project_id, doc_type, title, body_md, tags, meta, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6, now(), now())
      RETURNING id
    `;
    const { rows } = await pool.query(insertDocSQL, [pid, doc_type, title, body_md, tags, JSON.stringify(metaObj)]);
    const doc_id = rows[0].id;

    // Chunk text (simple: split on blank lines)
    const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const chunks = paragraphs.length ? paragraphs : [body_md];

    // Embed in small batches
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16);
      const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
      for (let j = 0; j < batch.length; j++) {
        const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]`;
        const embMeta = { title, doc_type, ...metaObj }; // doc meta + basics
        await pool.query(
          `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
           VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
          [pid, doc_id, i + j + 1, batch[j], vecStr, JSON.stringify(embMeta)]
        );
      }
    }

    res.json({ ok: true, document_id: doc_id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- WRITE: update an existing doc (and re-embed if body changed) ----------
app.post('/update', requireAuth, async (req, res) => {
  try {
    const { document_id, project_id, project_name, title, body_md, tags, meta } = req.body || {};
    if (!document_id || (!title && !body_md && !tags && !meta)) {
      return res.status(400).json({ error: 'document_id and one of title/body_md/tags/meta required (plus project_id or project_name)' });
    }
    const pid = await resolveProjectId(project_id, project_name);

    const sets = [];
    const vals = [];
    let idx = 1;

    if (title)   { sets.push(`title = $${idx++}`);        vals.push(title); }
    if (body_md) { sets.push(`body_md = $${idx++}`);      vals.push(body_md); }
    if (tags)    { sets.push(`tags = $${idx++}`);         vals.push(tags); }
    if (meta)    { sets.push(`meta = $${idx++}::jsonb`);  vals.push(JSON.stringify(coerceMeta(meta))); }

    sets.push(`updated_at = now()`);
    vals.push(pid, document_id);

    const { rowCount } = await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE project_id = $${idx++} AND id = $${idx}`,
      vals
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Document not found for this project' });

    // If body changed, re-embed
    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);

      // fetch latest doc_type + title + meta so embeddings meta stays in sync
      const docQ = await pool.query(
        `SELECT title, doc_type, meta FROM documents WHERE id = $1`,
        [document_id]
      );
      const current = docQ.rows[0] || {};
      const embTitle = title ?? current.title ?? '(updated)';
      const embDocType = current.doc_type || 'update';
      const embMetaBase = coerceMeta(meta ?? current.meta);

      const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
      const chunks = paragraphs.length ? paragraphs : [body_md];

      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
        for (let j = 0; j < batch.length; j++) {
          const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]`;
          const embMeta = { title: embTitle, doc_type: embDocType, ...embMetaBase };
          await pool.query(
            `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
             VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
            [pid, document_id, i + j + 1, batch[j], vecStr, JSON.stringify(embMeta)]
          );
        }
      }
    }

    res.json({ ok: true, document_id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- WRITE: update by title (avoids needing the UUID) ----------
app.post('/update-by-title', requireAuth, async (req, res) => {
  try {
    const { project_id, project_name, title, body_md, tags, meta } = req.body || {};
    if (!title || (!body_md && !tags && !meta)) {
      return res.status(400).json({ error: 'title and one of body_md/tags/meta required (plus project_id or project_name)' });
    }
    const pid = await resolveProjectId(project_id, project_name);

    const found = await pool.query(
      `SELECT id FROM documents WHERE project_id = $1 AND title = $2 ORDER BY updated_at DESC LIMIT 1`,
      [pid, title]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Document not found' });

    const document_id = found.rows[0].id;

    const sets = [];
    const vals = [];
    let idx = 1;

    if (body_md) { sets.push(`body_md = $${idx++}`);      vals.push(body_md); }
    if (tags)    { sets.push(`tags = $${idx++}`);         vals.push(tags); }
    if (meta)    { sets.push(`meta = $${idx++}::jsonb`);  vals.push(JSON.stringify(coerceMeta(meta))); }

    sets.push(`updated_at = now()`);
    vals.push(pid, document_id);

    await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE project_id = $${idx++} AND id = $${idx}`,
      vals
    );

    // If body changed, re-embed
    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);

      // read back fresh doc for consistent embedding meta
      const docQ = await pool.query(
        `SELECT title, doc_type, meta FROM documents WHERE id = $1`,
        [document_id]
      );
      const current = docQ.rows[0] || {};
      const embTitle = current.title || title;
      const embDocType = current.doc_type || 'update';
      const embMetaBase = coerceMeta(meta ?? current.meta);

      const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
      const chunks = paragraphs.length ? paragraphs : [body_md];

      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
        for (let j = 0; j < batch.length; j++) {
          const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]`;
          const embMeta = { title: embTitle, doc_type: embDocType, ...embMetaBase };
          await pool.query(
            `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
             VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
            [pid, document_id, i + j + 1, batch[j], vecStr, JSON.stringify(embMeta)]
          );
        }
      }
    }

    res.json({ ok: true, document_id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- LIST DOCS (filters) ----------
app.get('/list-docs', async (req, res) => {
  try {
    const { project_id, project_name, doc_type, q } = req.query
    const pid = await resolveProjectId(project_id, project_name)
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100)

    const clauses = ['project_id = $1']
    const vals = [pid]
    let idx = 2
    if (doc_type) { clauses.push(`doc_type = $${idx++}`); vals.push(doc_type) }
    if (q)        { clauses.push(`(title ILIKE $${idx} OR tags::text ILIKE $${idx})`); vals.push(`%${q}%`); idx++ }

    const { rows } = await pool.query(
      `SELECT id, title, doc_type, tags, created_at, updated_at
         FROM documents
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT $${idx}`,
      [...vals, limit]
    )
    res.json({ items: rows })
  } catch (e) {
    const code = e.statusCode || 500
    res.status(code).json({ error: String(e.message || e) })
  }
})

// ---------- READ: get one doc by UUID ----------
app.get('/doc', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id (document UUID) required' })
    const { rows } = await pool.query(
      `SELECT id, project_id, title, doc_type, tags, body_md, created_at, updated_at
         FROM documents
        WHERE id = $1
        LIMIT 1`,
      [id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Document not found' })
    res.json(rows[0])
  } catch (e) {
    const code = e.statusCode || 500
    res.status(code).json({ error: String(e.message || e) })
  }
})

// ---------- READ: get latest doc by title (by project name or id) ----------
app.get('/doc-by-title', async (req, res) => {
  try {
    const { project_id, project_name, title } = req.query
    if (!title) return res.status(400).json({ error: 'title required' })
    const pid = await resolveProjectId(project_id, project_name)
    const { rows } = await pool.query(
      `SELECT id, project_id, title, doc_type, tags, body_md, created_at, updated_at
         FROM documents
        WHERE project_id = $1 AND title = $2
        ORDER BY updated_at DESC
        LIMIT 1`,
      [pid, title]
    )
    if (!rows.length) return res.status(404).json({ error: 'Document not found' })
    res.json(rows[0])
  } catch (e) {
    const code = e.statusCode || 500
    res.status(code).json({ error: String(e.message || e) })
  }
})

// ---------- OpenAPI 3.1.0 for GPT Actions ----------
app.get('/openapi.json', (_req, res) => {
  res.json(
  {
  "openapi": "3.1.0",
  "info": {
    "title": "Writer Brain API",
    "version": "1.4.5"
  },
  "servers": [
    { "url": "https://writer-api-p0c7.onrender.com" }
  ],
  "paths": {
    "/ask": {
      "post": {
        "operationId": "askProject",
        "summary": "Retrieve an answer using RAG",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["question"],
                "properties": {
                  "question": { "type": "string" },
                  "project_id": { "type": "string" },
                  "project_name": { "type": "string" },
                  "history": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "role": { "type": "string", "enum": ["system", "user", "assistant"] },
                        "content": { "type": "string" }
                      },
                      "required": ["role", "content"]
                    }
                  }
                }
              }
            }
          }
        },
        "responses": { "200": { "description": "Answer JSON" } }
      }
    },

    "/ingest": {
      "post": {
        "operationId": "ingestDoc",
        "summary": "Create a new document and embed it",
        "security": [ { "bearerAuth": [] } ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "project_id":   { "type": "string", "description": "UUID of project" },
                  "project_name": { "type": "string", "description": "Human-friendly name if you don't have the UUID" },
                  "doc_type":     { "type": "string", "example": "artifact", "description": "character | chapter | scene | concept | artifact | location | ..." },
                  "title":        { "type": "string" },
                  "body_md":      { "type": "string" },
                  "tags":         { "type": "array", "items": { "type": "string" } },
                  "meta":         { "type": "object", "additionalProperties": true }
                },
                "required": ["doc_type","title","body_md"],
                "oneOf": [
                  { "required": ["project_id"] },
                  { "required": ["project_name"] }
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Ingested",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": { "type": "boolean" },
                    "document_id": { "type": "string", "format": "uuid" }
                  }
                }
              }
            }
          }
        }
      }
    },

    "/update": {
      "post": {
        "operationId": "updateDoc",
        "summary": "Update an existing document by UUID and re-embed",
        "security": [ { "bearerAuth": [] } ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "project_id":   { "type": "string", "description": "UUID of project" },
                  "project_name": { "type": "string", "description": "Human-friendly name if you don't have the UUID" },
                  "document_id":  { "type": "string", "format": "uuid" },
                  "title":        { "type": "string" },
                  "body_md":      { "type": "string" },
                  "tags":         { "type": "array", "items": { "type": "string" } },
                  "meta":         { "type": "object", "additionalProperties": true }
                },
                "required": ["document_id"],
                "oneOf": [
                  { "required": ["project_id","document_id"] },
                  { "required": ["project_name","document_id"] }
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": { "type": "boolean" },
                    "document_id": { "type": "string", "format": "uuid" }
                  }
                }
              }
            }
          }
        }
      }
    },

    "/update-by-title": {
      "post": {
        "operationId": "updateDocByTitle",
        "summary": "Update a document by title (no UUID) and re-embed",
        "security": [ { "bearerAuth": [] } ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "project_id":   { "type": "string", "description": "UUID of project" },
                  "project_name": { "type": "string", "description": "Human-friendly project name" },
                  "title":        { "type": "string", "description": "Document title to update" },
                  "body_md":      { "type": "string" },
                  "tags":         { "type": "array", "items": { "type": "string" } },
                  "meta":         { "type": "object", "additionalProperties": true }
                },
                "required": ["title"],
                "oneOf": [
                  { "required": ["project_id","title"] },
                  { "required": ["project_name","title"] }
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": { "type": "boolean" },
                    "document_id": { "type": "string", "format": "uuid" }
                  }
                }
              }
            }
          }
        }
      }
    },

    "/doc": {
      "get": {
        "operationId": "getDoc",
        "summary": "Get a single document by UUID (returns full body_md)",
        "parameters": [
          { "in": "query", "name": "id", "required": true, "schema": { "type": "string", "format": "uuid" } }
        ],
        "responses": { "200": { "description": "Document" } }
      }
    },

    "/doc-by-title": {
      "get": {
        "operationId": "getDocByTitle",
        "summary": "Get latest doc by title (by project name or id)",
        "parameters": [
          { "in": "query", "name": "project_id", "required": false, "schema": { "type": "string" } },
          { "in": "query", "name": "project_name", "required": false, "schema": { "type": "string" } },
          { "in": "query", "name": "title", "required": true, "schema": { "type": "string" } }
        ],
        "responses": { "200": { "description": "Document" } }
      }
    },

    "/list-docs": {
      "get": {
        "operationId": "listDocs",
        "summary": "List recent docs in a project",
        "parameters": [
          { "in": "query", "name": "project_id",   "required": false, "schema": { "type": "string" } },
          { "in": "query", "name": "project_name", "required": false, "schema": { "type": "string" } },
          { "in": "query", "name": "doc_type",     "required": false, "schema": { "type": "string" }, "description": "Filter by doc_type (e.g., character, note, chapter)" },
          { "in": "query", "name": "q",            "required": false, "schema": { "type": "string" }, "description": "Search in title or tags (ILIKE)" },
          { "in": "query", "name": "limit",        "required": false, "schema": { "type": "integer", "default": 25, "minimum": 1, "maximum": 100 } }
        ],
        "responses": { "200": { "description": "Document list" } }
      }
    },

    "/projects": {
      "get": {
        "operationId": "listProjects",
        "summary": "List all projects",
        "security": [ { "bearerAuth": [] } ],
        "responses": { "200": { "description": "Projects" } }
      }
    },

    "/project": {
      "post": {
        "operationId": "createOrGetProject",
        "summary": "Create or get a project by name",
        "security": [ { "bearerAuth": [] } ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["name"],
                "properties": {
                  "name": { "type": "string" },
                  "description": { "type": "string" }
                }
              }
            }
          }
        },
        "responses": { "200": { "description": "Project id" } }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    },
    "schemas": {}
  }
})
})

// ---- Start ----
const PORT = process.env.PORT || 8787
app.listen(PORT, () => console.log(`API running on :${PORT}`))