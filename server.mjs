/**
 * server.pg.2.5.0.mjs — Writing API with Postgres persistence
 */

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import db from './db.pg.mjs';

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOW_AUTOCONFIRM = process.env.ALLOW_AUTOCONFIRM === '1';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:3000,*')
  .split(',').map(s => s.trim()).filter(Boolean);

const genId = () => crypto.randomUUID();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (CORS_ORIGIN.includes('*') || CORS_ORIGIN.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

// Projects
app.post('/projects', async (req, res) => {
  const { name, kind = 'book' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = await db.findProjectByName(name);
  if (existing) return res.status(409).json({ error: 'name already exists', id: existing.id });
  const proj = await db.createProject({ id: genId(), name, slug: name.toLowerCase().replace(/\s+/g,'-'), kind });
  res.json(proj);
});

app.get('/projects', async (_req, res) => {
  res.json(await db.listProjects());
});

app.post('/projects/confirm', async (req, res) => {
  const { name } = req.body || {};
  const proj = await db.findProjectByName(name);
  if (!proj) return res.status(404).json({ error: 'not found' });
  const confirmed = await db.confirmProject(proj.id);
  res.json({ ok: true, project: confirmed });
});

// Docs
app.post('/doc', async (req, res) => {
  const { project_name, doc_type, title, body_md, tags, meta } = req.body;
  const proj = await db.findProjectByName(project_name);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
    return res.status(412).json({ error: 'project not confirmed' });
  const doc = await db.createDoc({ id: genId(), project_id: proj.id, doc_type, title, body_md, tags, meta });
  res.json(doc);
});

app.get('/doc', async (req, res) => {
  const { project_name } = req.query;
  const proj = await db.findProjectByName(project_name);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  const docs = await db.listDocs({ project_id: proj.id });
  res.json(docs);
});

// Health
app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '2.5.0-pg', db: 'postgres' });
});

// Boot
(async () => {
  await db.init();
  app.listen(PORT, () => console.log(`Server v2.5.0-pg on :${PORT}`));
})();



{marker}
// -----------------------------------------------------------------------------
// Full-Text Search endpoint (/search)
// Requires: a generated `ts` column on `docs` and a GIN index (docs_fts_idx).
// Falls back to substring matching if direct FTS isn't available.
// -----------------------------------------------------------------------------
app.get('/search', async (req, res) => {
  try {
    const { project_name, q, limit = 25 } = req.query;
    if (!project_name || !q) return res.status(400).json({ error: 'project_name and q required' });

    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const hardLimit = Math.min(parseInt(limit, 10) || 25, 200);

    if (db._pool && typeof db._pool.query === 'function') {
      const { rows } = await db._pool.query(
        `select id, project_id, doc_type, title, left(body_md, 800) as body_md, tags, meta, created_at, updated_at
           from docs
          where project_id = $1
            and deleted_at is null
            and ts @@ plainto_tsquery('english', $2)
          order by ts_rank(ts, plainto_tsquery('english', $2)) desc, updated_at desc
          limit $3`,
        [proj.id, q, hardLimit]
      );
      return res.json(rows.map(r => ({ ...r, tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags || '[]') })));
    }

    let docs = await db.listDocs({ project_id: proj.id });
    const needle = String(q).toLowerCase();
    docs = docs.filter(d => (d.title || '').toLowerCase().includes(needle) ||
                            (d.body_md || '').toLowerCase().includes(needle))
               .slice(0, hardLimit);
    return res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'search failed' });
  }
});

// -----------------------------------------------------------------------------
// Streaming reader (/read-stream) — Server-Sent Events
// Usage:
//   GET /read-stream?project_name=...&id=<docId>
//   or GET /read-stream?project_name=...&title=...&ci=true
// -----------------------------------------------------------------------------
app.get('/read-stream', async (req, res) => {
  try {
    const { project_name, id, title, ci = 'false' } = req.query;
    if (!project_name) return res.status(400).json({ error: 'project_name required' });
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });

    let doc = null;
    if (id) {
      const d = await db.getDocById(id);
      if (d && d.project_id === proj.id && !d.deleted_at) doc = d;
    } else if (title) {
      let list = await db.listDocs({ project_id: proj.id, title: (ci !== 'true') ? title : undefined });
      if (ci === 'true') {
        const nt = String(title).toLowerCase().replace(/\s+/g, ' ').trim();
        list = list.filter(d => String(d.title).toLowerCase().replace(/\s+/g, ' ').trim() === nt);
      }
      doc = list[0] || null;
    } else {
      return res.status(400).json({ error: 'id or title required' });
    }
    if (!doc) return res.status(404).json({ error: 'doc not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { id: doc.id, title: doc.title });
    const text = String(doc.body_md || '');
    const chunkSize = 512;
    let idx = 0;

    const interval = setInterval(() => {
      if (idx >= text.length) {
        clearInterval(interval);
        send('done', { bytes: text.length });
        res.end();
        return;
      }
      const chunk = text.slice(idx, idx + chunkSize);
      idx += chunkSize;
      send('delta', { chunk });
    }, 20);
  } catch (e) {
    console.error(e);
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'read-stream failed' })}\n\n`);
      res.end();
    } catch { /* noop */ }
  }
});

// -----------------------------------------------------------------------------
// Project export (/export) — download JSON of the whole project
//   GET /export?project_name=...
// -----------------------------------------------------------------------------
app.get('/export', async (req, res) => {
  try {
    const { project_name } = req.query;
    if (!project_name) return res.status(400).json({ error: 'project_name required' });
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const docs = await db.listDocs({ project_id: proj.id });

    const filename = `${(proj.slug || proj.name || 'project').toLowerCase().replace(/[^a-z0-9-]+/g,'-')}-export.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.write('{"project":');
    res.write(JSON.stringify(proj));
    res.write(',"docs":[');
    for (let i = 0; i < docs.length; i++) {
      if (i > 0) res.write(',');
      res.write(JSON.stringify(docs[i]));
    }
    res.write(']}');
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'export failed' });
  }
});

// Alias for Lyra parity (optional): /lyra/read-stream -> /read-stream
app.get('/lyra/read-stream', (req, res, next) => (req.url = req.url.replace('/lyra/read-stream', '/read-stream'), next()), (req, res) => {});
