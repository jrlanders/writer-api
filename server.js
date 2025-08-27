import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import OpenAI from 'openai'

const app = express()
app.use(express.json({ limit: '2mb' }))

// CORS: update the list with your UI origin when you deploy a frontend
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

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

async function retrieveTopK(projectId, query, k = 8) {
  // get query embedding
  const emb = await openai.embeddings.create({ model: MODEL_EMBED, input: query })
  const vec = emb.data[0].embedding
  // pgvector literal string and cast to vector
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

// Basic JSON (non-streaming) endpoint
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

// Optional: SSE streaming version (uncomment to use on the UI)
// app.post('/ask', async (req, res) => {
//   try {
//     const { question, project_id, project_name = 'My Project', history = [] } = req.body || {}
//     if (!question || !project_id) return res.status(400).json({ error: 'question & project_id required' })
//
//     const ctx = await retrieveTopK(project_id, question, 8)
//     const contextBlock = ctx.map((r, i) => `[${i + 1}] ${r.chunk_text}`).join('\n\n')
//
//     const messages = [
//       { role: 'system', content: `You are James's private writing assistant for "${project_name}". Use only the provided context. Maintain continuity and Writing-from-the-Middle.` },
//       ...history,
//       { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${question}` }
//     ]
//
//     res.writeHead(200, {
//       'Content-Type': 'text/event-stream',
//       'Cache-Control': 'no-cache',
//       'Connection': 'keep-alive',
//       'Access-Control-Allow-Origin': '*'
//     })
//
//     const stream = await openai.chat.completions.create({ model: MODEL_CHAT, messages, temperature: 0.7, stream: true })
//     for await (const chunk of stream) {
//       const delta = chunk?.choices?.[0]?.delta?.content || ''
//       if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
//     }
//     res.write(`data: ${JSON.stringify({ done: true, used_context: ctx })}\n\n`)
//     res.end()
//   } catch (e) {
//     res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`)
//     res.end()
//   }
// })
// Streaming endpoint (Server-Sent Events)
app.post('/ask-stream', async (req, res) => {
  try {
    const { question, project_id, project_name='My Project', history=[] } = req.body || {}
    if (!question || !project_id) {
      return res.status(400).json({ error: 'question & project_id required' })
    }

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
      model: process.env.MODEL_CHAT || 'gpt-4o',
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

const PORT = process.env.PORT || 8787
app.listen(PORT, () => console.log(`API running on :${PORT}`))