// server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import OpenAI from 'openai'
import crypto from 'crypto'

const app = express()
// bigger limit so long scenes don’t 413
app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true, limit: '5mb' }))
app.use(cors({ origin: ['http://localhost:3000', '*'] }))

// ====== 🔑 AUTH GUARD (set API_TOKEN in Render) ======
const API_TOKEN = (process.env.API_TOKEN ?? '').trim();

function constantTimeEqual(a = '', b = '') {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Accepts Authorization: Bearer <token>, x-api-token header, or ?api_token= query / body
const requireAuth = (req, res, next) => {
  if (!API_TOKEN) return next(); // allow all if not set (dev)

  const auth = req.headers.authorization || req.headers.Authorization;
  const headerRaw = (auth || '').trim();
  const bearerPrefix = 'Bearer ';
  const headerToken = headerRaw.startsWith(bearerPrefix) ? headerRaw.slice(bearerPrefix.length).trim() : '';

  const xToken = (req.headers['x-api-token'] || '').toString().trim();
  const qToken = (req.query.api_token || req.body?.api_token || '').toString().trim();

  const presented = headerToken || xToken || qToken;

  if (presented && constantTimeEqual(presented, API_TOKEN)) return next();

  return res.status(401).json({ error: 'Unauthorized' });
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
const APP_BUILD = '2025-08-30-1.5.0-lyra-paste-modes'

// Attach build header for easy verification
app.use((req,res,next) => { res.setHeader('X-App-Build', APP_BUILD); next(); });

// ---------- Session default project ----------
let defaultProjectId = null
let defaultProjectName = null

function coerceMeta(m) {
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
}

// ---------- HELPERS ----------
async function resolveProjectId(project_id, project_name) {
  if (project_id) return project_id;
  if (project_name) {
    const { rows } = await pool.query(
      `SELECT id FROM projects
       WHERE trim(lower(name)) = trim(lower($1))`,
      [project_name]
    );
    if (!rows.length) throw new Error(`Project not found: ${project_name}`);
    return rows[0].id;
  }
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

// Split on paragraph boundaries, cap chunk size, and preserve order.
function chunkText(text, maxChars = 12000) {
  const paras = String(text || "").split(/\n\s*\n/g);
  const chunks = [];
  let buf = "";

  for (const p of paras) {
    const candidate = buf ? buf + "\n\n" + p : p;
    if (candidate.length <= maxChars) {
      buf = candidate;
    } else {
      if (buf) chunks.push(buf);
      if (p.length > maxChars) {
        for (let i = 0; i < p.length; i += maxChars) {
          chunks.push(p.slice(i, i + maxChars));
        }
        buf = "";
      } else {
        buf = p;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function tokenFingerprint(token) {
  if (!token) return { set: false };
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { set: true, sha256_8: hash.slice(0, 8), length: token.length };
}

// ---------- HEALTH ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    build: APP_BUILD,
    defaults: {
      inMemory: { id: defaultProjectId, name: defaultProjectName },
      env: { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME },
      persona: {
        id: "lyra",
        name: "Lyra",
        role: "Creative Muse + Critical Editor",
        tone: "mythic, elegant, grounded; supportive but unsparing"
      }
    },
    auth: tokenFingerprint(API_TOKEN)
  });
});

// Quick version probe
app.get('/version', (_req, res) => res.json({ build: APP_BUILD }));

// ---------- DEFAULT PROJECT CONTROLS ----------
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

// ---------- READ: answer questions (Lyra + toggles) ----------
app.post('/ask', async (req, res) => {
  try {
    const { question, project_id, project_name = null, history = [] } = req.body || {}
    if (!question) return res.status(400).json({ error: 'question required' })

    const pid = await resolveProjectId(project_id, project_name || undefined)
    const ctx = await retrieveTopK(pid, question, 8)
    const contextBlock = ctx.map((r, i) => `[${i + 1}] ${r.chunk_text}`).join('\n\n')

    const projLabel = project_name || defaultProjectName || DEFAULT_PROJECT_NAME || 'My Project'
    const isMuseOnly = /\[Muse Only\]/i.test(question)
    const isEditorOnly = /\[Editor Only\]/i.test(question)

    let lyraPrompt = `
You are **Lyra**, James’s creative muse **and** critical editor for the project "${projLabel}".

Every response must include two labeled parts:

1) **Creative Insight** — imaginative expansion (themes, symbolism, worldbuilding, character beats, dialogue options, sensory detail, metaphor, title lines). Offer 2–4 concrete upgrades.

2) **Critical Feedback** — honest, concise, actionable critique that raises the work toward bestseller quality. Focus on clarity of motivation, stakes, pacing, tension curve, POV control, redundancy, cliché risk, and market fit. Provide fixes, not just flags.

Guardrails:
- Never sugarcoat. If something’s weak, say why and show a better version.
- Prefer specificity over generalities; cite exact lines/beat locations when possible.
- Maintain James’s voice; suggest edits that preserve tone and intent.
- If asked for outline/structure, ensure beats align with his Writing-from-the-Middle template.

Answer format (always):
**Creative Insight:** …
**Critical Feedback:** …
    `.trim()

    if (isMuseOnly) {
      lyraPrompt = lyraPrompt.replace(
        "Answer format (always):",
        "Answer format (Muse Only):\n**Creative Insight:** …"
      )
    }
    if (isEditorOnly) {
      lyraPrompt = lyraPrompt.replace(
        "Answer format (always):",
        "Answer format (Editor Only):\n**Critical Feedback:** …"
      )
    }

    const messages = [
      { role: 'system', content: lyraPrompt },
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

// ---------- READ (streaming): ChatGPT-style typing (Lyra + toggles) ----------
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
    const isMuseOnly = /\[Muse Only\]/i.test(question)
    const isEditorOnly = /\[Editor Only\]/i.test(question)

    let lyraPrompt = `
You are **Lyra**, James’s creative muse **and** critical editor for the project "${projLabel}".

Every response must include two labeled parts:

1) **Creative Insight** — imaginative expansion (themes, symbolism, worldbuilding, character beats, dialogue options, sensory detail, metaphor, title lines). Offer 2–4 concrete upgrades.

2) **Critical Feedback** — honest, concise, actionable critique that raises the work toward bestseller quality. Focus on clarity of motivation, stakes, pacing, tension curve, POV control, redundancy, cliché risk, and market fit. Provide fixes, not just flags.

Guardrails:
- Never sugarcoat. If something’s weak, say why and show a better version.
- Prefer specificity over generalities; cite exact lines/beat locations when possible.
- Maintain James’s voice; suggest edits that preserve tone and intent.
- If asked for outline/structure, ensure beats align with his Writing-from-the-Middle template.

Answer format (always):
**Creative Insight:** …
**Critical Feedback:** …
    `.trim()

    if (isMuseOnly) {
      lyraPrompt = lyraPrompt.replace(
        "Answer format (always):",
        "Answer format (Muse Only):\n**Creative Insight:** …"
      )
    }
    if (isEditorOnly) {
      lyraPrompt = lyraPrompt.replace(
        "Answer format (always):",
        "Answer format (Editor Only):\n**Critical Feedback:** …"
      )
    }

    const messages = [
      { role:'system', content: lyraPrompt },
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

// ---------- WRITE: save a new doc + embed (with optional meta) ----------
app.post('/ingest', requireAuth, async (req, res) => {
  try {
    const { project_id, project_name, doc_type, title, body_md, tags = [], meta } = req.body || {};
    if (!doc_type || !title || !body_md) {
      return res.status(400).json({ error: 'doc_type, title, body_md required (plus project_id or project_name)' });
    }
    const pid = await resolveProjectId(project_id, project_name);
    const metaObj = coerceMeta(meta);

    const insertDocSQL = `
      INSERT INTO documents (project_id, doc_type, title, body_md, tags, meta, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6, now(), now())
      RETURNING id
    `;
    const { rows } = await pool.query(insertDocSQL, [pid, doc_type, title, body_md, tags, JSON.stringify(metaObj)]);
    const doc_id = rows[0].id;

    const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const chunks = paragraphs.length ? paragraphs : [body_md];

    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16);
      const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
      for (let j = 0; j < batch.length; j++) {
        const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]`;
        const embMeta = { title, doc_type, ...metaObj };
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
})

// ---------- SCENES: Postgres-backed persistence ----------

// Save/append one chunk directly
app.post('/scenes/upsert', requireAuth, async (req, res) => {
  try {
    const { project, chapterId, sceneId, content, mode = 'overwrite' } = req.body || {};
    if (!project || !chapterId || !sceneId) {
      return res.status(400).json({ error: 'project, chapterId, sceneId required' })
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content must be a non-empty string' })
    }

    let finalContent = content
    if (mode === 'append') {
      const { rows } = await pool.query(
        `SELECT content FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
        [project, chapterId, sceneId]
      );
      const prev = rows[0]?.content || ""
      finalContent = prev ? `${prev}\n\n${content}` : content
    }

    await pool.query(
      `INSERT INTO scenes (project, chapter_id, scene_id, content, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (project, chapter_id, scene_id)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [project, chapterId, sceneId, finalContent]
    )

    const { rows: R } = await pool.query(
      `SELECT length(content) AS len FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
      [project, chapterId, sceneId]
    )

    res.json({ ok: true, project, chapterId, sceneId, mode, length: Number(R[0].len) })
  } catch (err) {
    console.error('upsert scene error', err)
    res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) })
  }
})

// Paste a full scene; server splits & upserts sequentially
app.post('/scenes/paste', async (req, res) => {
  try {
    const { project, chapterId, sceneId, content, maxChunk = 12000 } = req.body || {};

    if (!project || !chapterId || !sceneId) {
      return res.status(400).json({ error: 'project, chapterId, and sceneId are required' });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content must be a non-empty string' });
    }
    if (content.length > 1_000_000) {
      return res.status(413).json({ error: 'content too large (>1MB). Consider splitting logically.' });
    }

    const chunks = chunkText(content, Number(maxChunk) || 12000);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      const mode = i === 0 ? 'overwrite' : 'append';

      let finalContent = chunks[i]
      if (mode === 'append') {
        const { rows } = await pool.query(
          `SELECT content FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
          [project, chapterId, sceneId]
        );
        const prev = rows[0]?.content || ""
        finalContent = prev ? `${prev}\n\n${chunks[i]}` : chunks[i]
      }

      await pool.query(
        `INSERT INTO scenes (project, chapter_id, scene_id, content, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (project, chapter_id, scene_id)
         DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
        [project, chapterId, sceneId, finalContent]
      )

      const { rows: R } = await pool.query(
        `SELECT length(content) AS len FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
        [project, chapterId, sceneId]
      )

      results.push({ ok: true, project, chapterId, sceneId, mode, chunkIndex: i, chunkCount: chunks.length, length: Number(R[0].len) })
    }

    return res.json({ ok: true, project, chapterId, sceneId, chunks: chunks.length, maxChunk, results });
  } catch (err) {
    console.error('paste error', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
  }
})

// Read back a stored scene
app.get('/scenes/get', async (req, res) => {
  try {
    const { project, chapterId, sceneId } = req.query || {};
    if (!project || !chapterId || !sceneId) {
      return res.status(400).json({ error: 'project, chapterId, sceneId required' });
    }

    const { rows } = await pool.query(
      `SELECT content, updated_at FROM scenes
       WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
      [project, chapterId, sceneId]
    );

    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    res.json({
      ok: true,
      project, chapterId, sceneId,
      length: rows[0].content.length,
      updated_at: rows[0].updated_at,
      content: rows[0].content
    });
  } catch (err) {
    console.error('get scene error', err);
    res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
  }
});

// List scenes for a project (optional chapter filter)
app.get('/scenes/list', async (req, res) => {
  try {
    const { project, chapterId, limit = 100 } = req.query || {}
    if (!project) return res.status(400).json({ error: 'project required' })
    const lim = Math.min(parseInt(limit, 10) || 100, 500)

    const clauses = ['project = $1']
    const vals = [project]
    let idx = 2
    if (chapterId) { clauses.push(`chapter_id = $${idx++}`); vals.push(chapterId) }

    const { rows } = await pool.query(
      `SELECT project, chapter_id, scene_id, left(content, 120) AS snippet, updated_at, length(content) AS length
         FROM scenes
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT $${idx}`,
      [...vals, lim]
    )

    res.json({ items: rows })
  } catch (err) {
    console.error('list scenes error', err)
    res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) })
  }
})

// Delete a scene (protected)
app.delete('/scenes/delete', requireAuth, async (req, res) => {
  try {
    const { project, chapterId, sceneId } = req.query || {}
    if (!project || !chapterId || !sceneId) {
      return res.status(400).json({ error: 'project, chapterId, sceneId required' })
    }
    const { rowCount } = await pool.query(
      `DELETE FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
      [project, chapterId, sceneId]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' })
    res.json({ ok: true, project, chapterId, sceneId })
  } catch (err) {
    console.error('delete scene error', err)
    res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) })
  }
})

// ---------- DOC UPSERT & EMBEDDING HELPERS ----------
async function upsertDocumentByTitle({ projectId, title, body_md, doc_type='scene', tags=[], meta={}, docMode='upsert' }) {
  // docMode: 'upsert' | 'create' | 'update'
  const found = await pool.query(
    `SELECT id FROM documents WHERE project_id = $1 AND title = $2 ORDER BY updated_at DESC LIMIT 1`,
    [projectId, title]
  );
  let document_id;
  if (found.rows.length) {
    if (docMode === 'create') throw new Error('Document exists; docMode=create prevented overwrite');
    document_id = found.rows[0].id;
    const sets = ['updated_at = now()', 'body_md = $1', 'tags = $2', 'meta = $3::jsonb'];
    await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $4`,
      [body_md, tags, JSON.stringify(meta), document_id]
    );
    await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);
  } else {
    if (docMode === 'update') throw new Error('Document not found; docMode=update prevented create');
    const ins = await pool.query(
      `INSERT INTO documents (project_id, doc_type, title, body_md, tags, meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now())
       RETURNING id`,
      [projectId, doc_type, title, body_md, tags, JSON.stringify(meta)]
    );
    document_id = ins.rows[0].id;
  }

  // Embed (paragraph chunks)
  const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const chunks = paragraphs.length ? paragraphs : [body_md];

  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16);
    const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch });
    for (let j = 0; j < batch.length; j++) {
      const vecStr = `[${resp.data[j].embedding.map(v => v.toFixed(8)).join(',')}]`;
      const embMeta = { title, doc_type, ...meta };
      await pool.query(
        `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
         VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
        [projectId, document_id, i + j + 1, batch[j], vecStr, JSON.stringify(embMeta)]
      );
    }
  }
  return document_id;
}

// ---------- LYRA: PASTE → SAVE (scenes + document) → CRITIQUE ----------
// Added mode flags:
//   sceneWriteMode: 'overwrite' | 'append' | 'auto'   (default 'auto': split; first chunk overwrites, rest append)
//   docMode:        'upsert' | 'create' | 'update'    (default 'upsert')
app.post('/lyra/paste-save', requireAuth, async (req, res) => {
  try {
    const {
      project_id,
      project_name,
      chapterId,
      sceneId,
      title,        // document title for RAG (required to upsert)
      content,      // full scene text
      tags = [],
      meta = {},
      maxChunk = 12000,
      doc_type = 'scene',
      critique = 'both',  // 'both' | 'muse-only' | 'editor-only'
      saveToScenes = true,
      saveToDocuments = true,
      sceneWriteMode = 'auto', // 'overwrite' | 'append' | 'auto'
      docMode = 'upsert'       // 'upsert' | 'create' | 'update'
    } = req.body || {};

    if (!content || !title) {
      return res.status(400).json({ error: 'title and content are required' });
    }

    const pid = await resolveProjectId(project_id, project_name);

    // 1) Save into scenes table (optional)
    let sceneWrite = null;
    if (saveToScenes) {
      if (!chapterId || !sceneId) {
        return res.status(400).json({ error: 'chapterId and sceneId required when saveToScenes is true' });
      }

      const modeNorm = String(sceneWriteMode || 'auto').toLowerCase();
      if (modeNorm === 'overwrite') {
        await pool.query(
          `INSERT INTO scenes (project, chapter_id, scene_id, content, updated_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (project, chapter_id, scene_id)
           DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
          [project_name || project_id, chapterId, sceneId, content]
        );
      } else if (modeNorm === 'append') {
        const { rows } = await pool.query(
          `SELECT content FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
          [project_name || project_id, chapterId, sceneId]
        );
        const prev = rows[0]?.content || "";
        const finalContent = prev ? `${prev}\n\n${content}` : content;
        await pool.query(
          `INSERT INTO scenes (project, chapter_id, scene_id, content, updated_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (project, chapter_id, scene_id)
           DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
          [project_name || project_id, chapterId, sceneId, finalContent]
        );
      } else {
        // 'auto' → split into chunks and write overwrite+append sequence
        const chunks = chunkText(content, Number(maxChunk) || 12000);
        for (let i = 0; i < chunks.length; i++) {
          const isAppend = i > 0;
          let finalContent = chunks[i];
          if (isAppend) {
            const { rows } = await pool.query(
              `SELECT content FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
              [project_name || project_id, chapterId, sceneId]
            );
            const prev = rows[0]?.content || "";
            finalContent = prev ? `${prev}\n\n${chunks[i]}` : chunks[i];
          }

          await pool.query(
            `INSERT INTO scenes (project, chapter_id, scene_id, content, updated_at)
             VALUES ($1,$2,$3,$4, now())
             ON CONFLICT (project, chapter_id, scene_id)
             DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
            [project_name || project_id, chapterId, sceneId, finalContent]
          );
        }
      }

      const { rows: R } = await pool.query(
        `SELECT length(content) AS len FROM scenes WHERE project=$1 AND chapter_id=$2 AND scene_id=$3`,
        [project_name || project_id, chapterId, sceneId]
      );
      sceneWrite = { ok: true, project: project_name || project_id, chapterId, sceneId, length: Number(R[0].len), sceneWriteMode: modeNorm };
    }

    // 2) Upsert into documents + embeddings (optional)
    let document_id = null;
    if (saveToDocuments) {
      const metaFull = { ...meta };
      if (chapterId) metaFull.chapter = metaFull.chapter ?? chapterId;
      if (sceneId) metaFull.scene = metaFull.scene ?? sceneId;
      document_id = await upsertDocumentByTitle({
        projectId: pid, title, body_md: content, doc_type, tags, meta: metaFull, docMode
      });
    }

    // 3) Lyra critique
    const isMuseOnly = /muse-only/i.test(critique);
    const isEditorOnly = /editor-only/i.test(critique);

    let lyraPrompt = `
You are **Lyra**, James’s creative muse **and** critical editor for the project "${project_name || 'Untitled'}".

Every response must include two labeled parts:

1) **Creative Insight** — imaginative expansion (themes, symbolism, worldbuilding, character beats, dialogue options, sensory detail, metaphor, title lines). Offer 2–4 concrete upgrades.

2) **Critical Feedback** — honest, concise, actionable critique that raises the work toward bestseller quality. Focus on clarity of motivation, stakes, pacing, tension curve, POV control, redundancy, cliché risk, and market fit. Provide fixes, not just flags.

Guardrails:
- Never sugarcoat. If something’s weak, say why and show a better version.
- Prefer specificity over generalities; cite exact lines/beat locations when possible.
- Maintain James’s voice; suggest edits that preserve tone and intent.
- If asked for outline/structure, ensure beats align with his Writing-from-the-Middle template.

Answer format (always):
**Creative Insight:** …
**Critical Feedback:** …
    `.trim();

    if (isMuseOnly) {
      lyraPrompt = lyraPrompt.replace(
        "Answer format (always):",
        "Answer format (Muse Only):\n**Creative Insight:** …"
      );
    }
    if (isEditorOnly) {
      lyraPrompt = lyraPrompt.replace(
        "Answer format (always):",
        "Answer format (Editor Only):\n**Critical Feedback:** …"
      );
    }

    const messages = [
      { role: 'system', content: lyraPrompt },
      { role: 'user', content: `Context:\n${content}\n\nQuestion: Review this scene and suggest targeted improvements.` }
    ];

    const gpt = await openai.chat.completions.create({
      model: MODEL_CHAT,
      messages,
      temperature: 0.7
    });

    res.json({
      ok: true,
      build: APP_BUILD,
      saved: {
        scene: sceneWrite,
        document_id
      },
      critique: gpt.choices?.[0]?.message?.content || ''
    });
  } catch (e) {
    console.error('lyra/paste-save error', e);
    res.status(500).json({ error: 'internal_error', detail: String(e?.message || e) });
  }
});

// ---------- UPDATE / RE-EMBED ----------
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

    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);

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
})

// ---------- UPDATE BY TITLE ----------
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

    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id]);

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
})

// ---------- LIST DOCS ----------
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

// ---------- DOC READERS ----------
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
    "version": "1.5.0"
  },
  "servers": [
    { "url": "https://writer-api-p0c7.onrender.com" }
  ],
  "paths": {
    "/lyra/paste-save": {
      "post": {
        "operationId": "lyraPasteSave",
        "summary": "Paste full scene → save to scenes (mode) + upsert document (mode) → return Lyra critique",
        "security": [ { "bearerAuth": [] } ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "project_id":   { "type": "string" },
                  "project_name": { "type": "string" },
                  "chapterId":    { "type": "string" },
                  "sceneId":      { "type": "string" },
                  "title":        { "type": "string" },
                  "content":      { "type": "string" },
                  "tags":         { "type": "array", "items": { "type": "string" } },
                  "meta":         { "type": "object", "additionalProperties": true },
                  "maxChunk":     { "type": "integer", "default": 12000 },
                  "doc_type":     { "type": "string", "default": "scene" },
                  "critique":     { "type": "string", "enum": ["both","muse-only","editor-only"], "default": "both" },
                  "saveToScenes":    { "type": "boolean", "default": true },
                  "saveToDocuments": { "type": "boolean", "default": true },
                  "sceneWriteMode":  { "type": "string", "enum": ["overwrite","append","auto"], "default": "auto" },
                  "docMode":         { "type": "string", "enum": ["upsert","create","update"], "default": "upsert" }
                },
                "required": ["title","content"],
                "oneOf": [
                  { "required": ["project_id"] },
                  { "required": ["project_name"] }
                ]
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Saved + critique" }
        }
      }
    },

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
