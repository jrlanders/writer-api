import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import OpenAI from 'openai'

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cors({ origin: ['http://localhost:3000', '*'] }))

// ====== 🔑 AUTH GUARD ======
const API_TOKEN = process.env.API_TOKEN
const requireAuth = (req, res, next) => {
  if (!API_TOKEN) return next(); // allow all if not set (dev mode)
  const ok = req.headers.authorization === `Bearer ${API_TOKEN}`
  if (!ok) return res.status(401).json({ error: 'Unauthorized' })
  next()
}
// ===========================

// ENV
const DB_URL = process.env.DB_URL
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const MODEL_EMBED = process.env.MODEL_EMBED || 'text-embedding-3-small'
const MODEL_CHAT  = process.env.MODEL_CHAT  || 'gpt-4o'

if (!DB_URL || !OPENAI_API_KEY) {
  console.error('Missing DB_URL or OPENAI_API_KEY')
  process.exit(1)
}

const pool = new Pool({
  connectionString: DB_URL,
  // Aiven uses SSL; this avoids cert verify complaints on some hosts
  ssl: { rejectUnauthorized: false }
})
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })


// ✅ ADD THE RESOLVER *HERE* (above routes)
async function resolveProjectId(project_id, project_name) {
  if (project_id) return project_id
  if (!project_name) throw new Error('Need project_id or project_name')
  const { rows } = await pool.query(`SELECT id FROM projects WHERE name = $1`, [project_name])
  if (!rows.length) throw new Error(`Project not found: ${project_name}`)
  return rows[0].id
}

async function retrieveTopK(projectId, query, k = 8) {
  const emb = await openai.embeddings.create({ model: MODEL_EMBED, input: query })
  const vec = emb.data[0].embedding
  const vecStr = `[${vec.map(v => v.toFixed(8)).join(',')}]`
  const sql = `
    SELECT chunk_text, meta
    FROM embeddings
    WHERE project_id = $1
    ORDER BY embedding <-> $2::vector
    LIMIT $3
  `
  const { rows } = await pool.query(sql, [projectId, vecStr, k])
  return rows
}

// ---------- READ: answer questions ----------
app.post('/ask', async (req, res) => {
  try {
    const { question, project_id, project_name = 'My Project', history = [] } = req.body || {}
    if (!question) {
      return res.status(400).json({ error: 'question required' })
    }

    // 🔑 Resolve to a UUID, works with project_id or project_name
    const pid = await resolveProjectId(project_id, project_name)

    // Fetch context
    const ctx = await retrieveTopK(pid, question, 8)
    const contextBlock = ctx.map((r, i) => `[${i + 1}] ${r.chunk_text}`).join('\n\n')

    // Build chat messages
    const messages = [
      { role: 'system', content: `You are James's private writing assistant for "${project_name}". Use only the provided context. Maintain continuity and Writing-from-the-Middle.` },
      ...history,
      { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${question}` }
    ]

    // Ask OpenAI
    const resp = await openai.chat.completions.create({
      model: MODEL_CHAT,
      messages,
      temperature: 0.7
    })

    res.json({ answer: resp.choices[0].message.content, used_context: ctx })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e) })
  }
})

// ---------- READ (streaming): ChatGPT-style typing ----------
app.post('/ask-stream', async (req, res) => {
  try {
    const { question, project_id, project_name='My Project', history=[] } = req.body || {}
    if (!question || !project_id) return res.status(400).json({ error: 'question & project_id required' })

    const ctx = await retrieveTopK(project_id, question, 8)
    const contextBlock = ctx.map((r,i)=>`[${i+1}] ${r.chunk_text}`).join('\n\n')

    res.writeHead(200, {
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache',
      'Connection':'keep-alive',
      'Access-Control-Allow-Origin':'*'
    })

    const messages = [
      { role:'system', content:`You are James's private writing assistant for "${project_name}". Use only the provided context. Maintain continuity and Writing-from-the-Middle.` },
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
    res.write(`data:${JSON.stringify({ error:String(e) })}\n\n`)
    res.end()
  }
})

// ---------- WRITE: save a new doc + embed ----------
app.post('/ingest', requireAuth, async (req, res) => {
  try {
    const { project_id: rawId, project_name, doc_type, title, body_md, tags = [] } = req.body || {}

    const project_id = await resolveProjectId({ project_id: rawId, project_name })
    if (!project_id || !doc_type || !title || !body_md) {
      return res.status(400).json({ error: 'project_id OR project_name, plus doc_type, title, body_md required' })
    }

    // Resolve to UUID (works with name or id)
    const pid = await resolveProjectId(project_id, project_name)

    // Insert the document
    const insertDocSQL = `
      INSERT INTO documents (project_id, doc_type, title, body_md, tags, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5, now(), now())
      RETURNING id
    `
    const { rows } = await pool.query(insertDocSQL, [pid, doc_type, title, body_md, tags])
    const doc_id = rows[0].id

    // Chunk text (simple: split on blank lines)
    const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    const chunks = paragraphs.length ? paragraphs : [body_md]

    // Embed in small batches
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16)
      const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch })
      for (let j = 0; j < batch.length; j++) {
        const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]` // pgvector literal
        await pool.query(
          `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
           VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
          [pid, doc_id, i + j + 1, batch[j], vecStr, JSON.stringify({ title, doc_type })]
        )
      }
    }

    res.json({ ok: true, document_id: doc_id })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e) })
  }
})

// ---------- WRITE: update an existing doc (and re-embed if body changed) ----------
app.post('/update', requireAuth, async (req, res) => {
  try {
    const { document_id, project_id: rawId, project_name, title, body_md, tags } = req.body || {}

    const project_id = await resolveProjectId({ project_id: rawId, project_name })
    if (!document_id || !project_id || (!title && !body_md && !tags)) {
      return res.status(400).json({ error: 'document_id, project_id/project_name and at least one of title/body_md/tags required' })
    }

    // Resolve to UUID (works with name or id)
    const pid = await resolveProjectId(project_id, project_name)

    // Build dynamic UPDATE
    const sets = []
    const vals = []
    let idx = 1
    if (title)   { sets.push(`title = $${idx++}`);   vals.push(title) }
    if (body_md) { sets.push(`body_md = $${idx++}`); vals.push(body_md) }
    if (tags)    { sets.push(`tags = $${idx++}`);    vals.push(tags) }
    sets.push(`updated_at = now()`)
    vals.push(pid, document_id)

    // Apply update
    const { rowCount } = await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE project_id = $${idx++} AND id = $${idx}`,
      vals
    )
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Document not found for this project' })
    }

    // If body changed, re-embed
    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id])

      const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
      const chunks = paragraphs.length ? paragraphs : [body_md]

      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16)
        const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch })
        for (let j = 0; j < batch.length; j++) {
          const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]`
          await pool.query(
            `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
             VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
            [pid, document_id, i + j + 1, batch[j], vecStr, JSON.stringify({ title: title ?? '(updated)', doc_type: 'update' })]
          )
        }
      }
    }

    res.json({ ok: true, document_id })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e) })
  }
})

// Update a doc by title (avoids needing the UUID)
app.post('/update-by-title', requireAuth, async (req, res) => {
  try {
    const { project_id, title, body_md, tags } = req.body || {};
    if (!project_id || !title || (!body_md && !tags)) {
      return res.status(400).json({ error: 'project_id, title and at least one of body_md/tags required' });
    }

    const { rows } = await pool.query(
      `SELECT id FROM documents WHERE project_id = $1 AND title = $2 ORDER BY updated_at DESC LIMIT 1`,
      [project_id, title]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });

    const document_id = rows[0].id;

    // Reuse your /update logic by calling the DB directly here:
    const sets = [];
    const vals = [];
    let idx = 1;
    if (body_md) { sets.push(`body_md = $${idx++}`); vals.push(body_md); }
    if (tags)    { sets.push(`tags = $${idx++}`);    vals.push(tags); }
    sets.push(`updated_at = now()`);
    vals.push(project_id, document_id);

    await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE project_id = $${idx++} AND id = $${idx}`,
      vals
    );

    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);

      const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
      const chunks = paragraphs.length ? paragraphs : [body_md];

      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
        for (let j = 0; j < batch.length; j++) {
          const vec = resp.data[j].embedding;
          const vecStr = `[${vec.map(v => v.toFixed(8)).join(',')}]`;
          await pool.query(
            `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
             VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
            [project_id, document_id, i + j + 1, batch[j], vecStr, JSON.stringify({ title, doc_type: 'update' })]
          );
        }
      }
    }

    res.json({ ok: true, document_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// List recent docs for a project (optional helper)
app.get('/list-docs', async (req, res) => {
  try {
    const project_id = req.query.project_id;
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
    if (!project_id) return res.status(400).json({ error: 'project_id required' });

    const { rows } = await pool.query(
      `SELECT id, title, doc_type, tags, created_at, updated_at
       FROM documents
       WHERE project_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [project_id, limit]
    );
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
app.post('/update-by-title', requireAuth, async (req, res) => {
  try {
    const { project_id, title, body_md, tags } = req.body || {};
    if (!project_id || !title || (!body_md && !tags)) {
      return res.status(400).json({ error: 'project_id, title and at least one of body_md/tags required' });
    }

    const { rows } = await pool.query(
      `SELECT id FROM documents WHERE project_id = $1 AND title = $2 ORDER BY updated_at DESC LIMIT 1`,
      [project_id, title]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });

    const document_id = rows[0].id;

    const sets = []; const vals = []; let idx = 1;
    if (body_md) { sets.push(`body_md = $${idx++}`); vals.push(body_md); }
    if (tags)    { sets.push(`tags = $${idx++}`);    vals.push(tags); }
    sets.push(`updated_at = now()`); vals.push(project_id, document_id);

    await pool.query(`UPDATE documents SET ${sets.join(', ')} WHERE project_id = $${idx++} AND id = $${idx}`, vals);

    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);
      const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
      const chunks = paragraphs.length ? paragraphs : [body_md];
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
        for (let j = 0; j < batch.length; j++) {
          const vec = resp.data[j].embedding;
          const vecStr = `[${vec.map(v => v.toFixed(8)).join(',')}]`;
          await pool.query(
            `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
             VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
            [project_id, document_id, i + j + 1, batch[j], vecStr, JSON.stringify({ title, doc_type: 'update' })]
          );
        }
      }
    }
    res.json({ ok: true, document_id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/list-docs', async (req, res) => {
  try {
    const { project_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const { rows } = await pool.query(
      `SELECT id, title, doc_type, tags, created_at, updated_at
       FROM documents WHERE project_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [project_id, limit]
    );
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/openapi.json', (_req, res) => {
  res.json({
    openapi: "3.1.0",
    info: { title: "Writer Brain API", version: "1.0.0" },
    servers: [{ url: "https://writer-api-p0c7.onrender.com" }],
    paths: {
      "/ask": {
        post: {
          operationId: "askProject",
          summary: "Retrieve an answer using RAG",
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: {
                type: "object",
                required: ["question","project_id"],
                properties: {
                  question: { type: "string" },
                  project_id: { type: "string" },
                  project_name: { type: "string" },
                  history: {
                    type: "array",
                    items: { type:"object", properties:{ role:{type:"string"}, content:{type:"string"} } }
                  }
                }
              }
            }}
          },
          responses: { "200": { description: "Answer JSON" } }
        }
      },
      "/ingest": {
        post: {
          operationId: "ingestDoc",
          summary: "Create a new document and embed it",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: {
                type: "object",
                required: ["project_id","doc_type","title","body_md"],
                properties: {
                  project_id: { type: "string" },
                  doc_type: { type: "string" },
                  title: { type: "string" },
                  body_md: { type: "string" },
                  tags: { type: "array", items: { type: "string" } }
                }
              }
            }}
          },
          responses: { "200": { description: "Ingested" } }
        }
      },
      "/update": {
        post: {
          operationId: "updateDoc",
          summary: "Update an existing document by UUID and re-embed",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: {
                type: "object",
                required: ["document_id","project_id"],
                properties: {
                  document_id: { type: "string" },
                  project_id: { type: "string" },
                  title: { type: "string" },
                  body_md: { type: "string" },
                  tags: { type: "array", items: { type: "string" } }
                }
              }
            }}
          },
          responses: { "200": { description: "Updated" } }
        }
      },
      "/update-by-title": {
        post: {
          operationId: "updateDocByTitle",
          summary: "Update a document by title (no UUID) and re-embed",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: {
                type: "object",
                required: ["project_id","title"],
                properties: {
                  project_id: { type: "string" },
                  title: { type: "string" },
                  body_md: { type: "string" },
                  tags: { type: "array", items: { type: "string" } }
                }
              }
            }}
          },
          responses: { "200": { description: "Updated" } }
        }
      },
      "/list-docs": {
        get: {
          operationId: "listDocs",
          summary: "List recent docs in a project",
          parameters: [
            { in: "query", name: "project_id", required: true, schema: { type: "string" } },
            { in: "query", name: "limit", required: false, schema: { type: "integer", default: 25 } }
          ],
          responses: { "200": { description: "Document list" } }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
      }
    }
  });
});
// ---------- GPT Actions spec ----------
app.get('/openapi.json', (_req, res) => {
  res.json({
    openapi: "3.0.3",
    info: { title: "Writer Brain API", version: "1.0.0" },
    servers: [{ url: "https://writer-api-p0c7.onrender.com" }],
    paths: {
      "/ask": {
        post: {
          operationId: "askProject",
          summary: "Retrieve an answer using RAG",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["question", "project_id"],
                  properties: {
                    question: { type: "string" },
                    project_id: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Answer JSON",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      answer: { type: "string" },
                      used_context: { type: "array", items: { type: "object" } }
                    }
                  }
                }
              }
            }
          }
        }
      }
      // … add /ingest, /update, etc. same way
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      },
      schemas: {}
    }
  });
});
const PORT = process.env.PORT || 8787
app.listen(PORT, () => console.log(`API running on :${PORT}`))