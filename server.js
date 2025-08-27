import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import OpenAI from 'openai'

const app = express()
app.use(express.json({ limit: '2mb' }))

// CORS: widen or lock down later
app.use(cors({ origin: ['http://localhost:3000', '*'] }))

// ENV
const DB_URL = process.env.DB_URL
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const MODEL_EMBED = process.env.MODEL_EMBED || 'text-embedding-3-small' // 1536-dim
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
    if (!question || !project_id) return res.status(400).json({ error: 'question & project_id required' })

    const ctx = await retrieveTopK(project_id, question, 8)
    const contextBlock = ctx.map((r, i) => `[${i + 1}] ${r.chunk_text}`).join('\n\n')

    const messages = [
      { role: 'system', content: `You are James's private writing assistant for "${project_name}". Use only the provided context. Maintain continuity and Writing-from-the-Middle.` },
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
app.post('/ingest', async (req, res) => {
  try {
    const { project_id, doc_type, title, body_md, tags = [] } = req.body || {}
    if (!project_id || !doc_type || !title || !body_md) {
      return res.status(400).json({ error: 'project_id, doc_type, title, body_md required' })
    }

    // Insert the document
    const insertDocSQL = `
      INSERT INTO documents (project_id, doc_type, title, body_md, tags, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5, now(), now())
      RETURNING id
    `
    const { rows } = await pool.query(insertDocSQL, [project_id, doc_type, title, body_md, tags])
    const doc_id = rows[0].id

    // Chunk text (simple: split on blank lines; you can swap to your fancier chunker later)
    const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    const chunks = paragraphs.length ? paragraphs : [body_md]

    // Embed in small batches
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16)
      const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch })
      for (let j = 0; j < batch.length; j++) {
        const vec = resp.data[j].embedding
        await pool.query(
          `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [project_id, doc_id, i + j + 1, batch[j], vec, JSON.stringify({ title, doc_type })]
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
app.post('/update', async (req, res) => {
  try {
    const { document_id, project_id, title, body_md, tags } = req.body || {}
    if (!document_id || !project_id || (!title && !body_md && !tags)) {
      return res.status(400).json({ error: 'document_id, project_id and at least one of title/body_md/tags required' })
    }

    // Build dynamic UPDATE
    const sets = []
    const vals = []
    let idx = 1
    if (title)   { sets.push(`title = $${idx++}`);   vals.push(title) }
    if (body_md) { sets.push(`body_md = $${idx++}`); vals.push(body_md) }
    if (tags)    { sets.push(`tags = $${idx++}`);    vals.push(tags) }
    sets.push(`updated_at = now()`)
    vals.push(project_id, document_id)

    await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE project_id = $${idx++} AND id = $${idx}`,
      vals
    )

    // If body changed, re-embed
    if (body_md) {
      await pool.query(`DELETE FROM embeddings WHERE document_id = $1`, [document_id])

      const paragraphs = body_md.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
      const chunks = paragraphs.length ? paragraphs : [body_md]

      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16)
        const resp = await openai.embeddings.create({ model: MODEL_EMBED, input: batch })
        for (let j = 0; j < batch.length; j++) {
          const vec = resp.data[j].embedding
          await pool.query(
            `INSERT INTO embeddings (project_id, document_id, chunk_no, chunk_text, embedding, meta)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
            [project_id, document_id, i + j + 1, batch[j], vec, JSON.stringify({ title: title ?? '(updated)', doc_type: 'update' })]
          )
        }
      }
    }

    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e) })
  }
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => console.log(`API running on :${PORT}`))