/**
 * server.mjs — Writing API (v2.6.1-pg)
 *
 * Postgres-backed persistence using db.pg.mjs. Includes:
 *  - Projects: create/list/confirm
 *  - Docs: create/list
 *  - Lyra helpers: /lyra/modes, /lyra/ingest, /lyra/paste-save, /lyra/read, /lyra/command
 *  - Extras: /search (FTS + fallback), /read-stream (SSE), /export (project dump)
 *
 * Notes:
 *  - Ensure DATABASE_URL is set on your service (and PGSSL=1 for SSL providers).
 *  - CORS_ORIGIN may be a comma-separated list; '*' allowed for dev.
 */

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

// --- your internal modules ---
import { initDb } from "./db.pg.mjs";   // example: your DB bootstrap
// import { otherHelpers } from "./whatever.mjs";

// server.mjs
// --- new middleware import ---
import { makeMiddleware } from './middleware.mjs';

// --- app setup ---
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());


// ... your existing routes ...


// app.listen(...)

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const SELF_BASE = `http://127.0.0.1:${PORT}`;
const ALLOW_AUTOCONFIRM = process.env.ALLOW_AUTOCONFIRM === '1';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:3000,*')
  .split(',').map(s => s.trim()).filter(Boolean);

const makeSlug = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');
const genId = () => (typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------
app.use("/mw", makeMiddleware({ baseUrl: SELF_BASE }));
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

// CamelCase alias shim for old clients
function camelCaseAliasShim(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    const b = req.body;
    if (!b.project_name && b.projectName) b.project_name = b.projectName;
    if (!b.project_id && b.projectId) b.project_id = b.projectId;
    if (b.payload && typeof b.payload === 'object') {
      const p = b.payload;
      if (!p.doc_type && p.docType) p.doc_type = p.docType;
      if (!p.body_md && p.bodyMd) p.body_md = p.bodyMd;
    }
  }
  next();
}
app.use(camelCaseAliasShim);

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '2.6.1-pg', db: 'postgres' });
});

// -----------------------------------------------------------------------------
/** Project routes */
// -----------------------------------------------------------------------------

// Create a new project
app.post('/projects', async (req, res) => {
  try {
    const { name, kind = 'book', parent_id = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const existing = await db.findProjectByName(name);
    if (existing) return res.status(409).json({ error: 'name already exists', id: existing.id });
    const proj = await db.createProject({ id: genId(), name, slug: makeSlug(name), kind, parent_id });
    res.json(proj);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'create failed' });
  }
});

// List all projects
app.get('/projects', async (_req, res) => {
  try { res.json(await db.listProjects()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'list failed' }); }
});

// Find project by name or slug
app.get('/projects/find', async (req, res) => {
  try {
    const { name, slug } = req.query;
    const proj = name ? await db.findProjectByName(name) : slug ? await db.findProjectBySlug(slug) : null;
    if (!proj) return res.status(404).json({ error: 'not found' });
    res.json(proj);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'find failed' });
  }
});

// Confirm a project (by id param or body.name/slug/id)
app.post('/projects/:id/confirm', async (req, res) => {
  try {
    const proj = await db.confirmProject(req.params.id);
    if (!proj) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, project: proj });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'confirm failed' });
  }
});
app.post('/projects/confirm', async (req, res) => {
  try {
    const { id, name, slug } = req.body || {};
    let proj = null;
    if (id) proj = await db.getProjectById(id);
    else if (name) proj = await db.findProjectByName(name);
    else if (slug) proj = await db.findProjectBySlug(slug);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const confirmed = await db.confirmProject(proj.id);
    res.json({ ok: true, project: confirmed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'confirm failed' });
  }
});

app.get('/counts', async (req, res) => {
  try {
    const { project_name } = req.query;
    if (!project_name) return res.status(400).json({ error: 'project_name required' });
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const { rows } = await db._pool.query(
      `select doc_type, count(*)::int as count
         from docs
        where project_id = $1 and deleted_at is null
        group by doc_type
        order by doc_type`,
      [proj.id]
    );
    res.json({ ok: true, project_id: proj.id, counts: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'counts failed' });
  }
});
// -----------------------------------------------------------------------------
/** Document routes */
// -----------------------------------------------------------------------------

// Create a new doc within a project
app.post('/doc', async (req, res) => {
  try {
    const { project_name, doc_type, title, body_md, tags, meta } = req.body || {};
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
      return res.status(412).json({ error: 'project not confirmed' });
    const doc = await db.createDoc({ id: genId(), project_id: proj.id, doc_type, title, body_md, tags, meta });
    res.json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'doc create failed' });
  }
});

// List all docs within a project (basic; use /lyra/read for filters)
app.get('/doc', async (req, res) => {
  try {
    const { project_name } = req.query;
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const docs = await db.listDocs({ project_id: proj.id });
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'doc list failed' });
  }
});

// -----------------------------------------------------------------------------
/** Lyra helper routes */
// -----------------------------------------------------------------------------

// Modes descriptor
app.get('/lyra/modes', (_req, res) => {
  res.json({
    ok: true,
    version: '2.6.1-pg',
    modes: {
      read: { route: '/lyra/read' },
      write: { route: '/lyra/paste-save' },
      ingest: { route: '/lyra/ingest' },
      commands: { route: '/lyra/command', commands: ['/confirm-project'] }
    }
  });
});

// Ingest (batch create/update)
app.post('/lyra/ingest', async (req, res) => {
  try {
    const { project_name, docs = [] } = req.body || {};
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
      return res.status(412).json({ error: 'project not confirmed' });

    if (!Array.isArray(docs) || docs.length === 0) {
      return res.status(400).json({ error: 'docs array required' });
    }

    const results = [];
    for (const item of docs) {
      const { id, doc_type, title, body_md = '', tags = [], meta = {} } = item || {};
      if (!doc_type || !title) { results.push({ ok: false, error: 'doc_type and title required' }); continue; }

      if (id) {
        const existing = await db.getDocById(id);
        if (existing && existing.project_id === proj.id) {
          const updated = await db.updateDoc(id, { doc_type, title, body_md, tags, meta });
          results.push({ ok: true, id: updated.id, mode: 'update' });
          continue;
        }
      }
      const created = await db.createDoc({ id: genId(), project_id: proj.id, doc_type, title, body_md, tags, meta });
      results.push({ ok: true, id: created.id, mode: 'create' });
    }
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ingest failed' });
  }
});

// Paste-save (single create/update; supports append)
app.post('/lyra/paste-save', async (req, res) => {
  try {
    const { project_name, docMode = 'create', sceneWriteMode = 'overwrite', id, payload = {} } = req.body || {};
    const { doc_type, title, body_md = '', tags = [], meta = {} } = payload;
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
      return res.status(412).json({ error: 'project not confirmed' });

    if (docMode === 'update') {
      if (!id) return res.status(400).json({ error: 'id required for update' });
      const existing = await db.getDocById(id);
      if (!existing || existing.project_id !== proj.id) return res.status(404).json({ error: 'doc not found' });

      const updates = {
        doc_type, title, tags, meta,
        body_md: sceneWriteMode === 'append'
          ? (existing.body_md || '') + '\n' + body_md
          : body_md
      };
      const updated = await db.updateDoc(existing.id, updates);
      return res.json({ ok: true, mode: 'update', doc: updated });
    }

    const created = await db.createDoc({ id: genId(), project_id: proj.id, doc_type, title, body_md, tags, meta });
    res.json({ ok: true, mode: 'create', doc: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'paste-save failed' });
  }
});

// Lyra read (by id/title + tag/meta filters)
app.get('/lyra/read', async (req, res) => {
  try {
    const { project_name, id, title, doc_type, ci = 'false' } = req.query || {};
    const proj = await db.findProjectByName(project_name);
    if (!proj) return res.status(404).json({ error: 'project not found' });

    if (id) {
      const d = await db.getDocById(id);
      if (!d || d.project_id !== proj.id || d.deleted_at) return res.status(404).json({ error: 'doc not found' });
      return res.json({ ok: true, doc: d });
    }

    let docs = await db.listDocs({ project_id: proj.id, title: title && ci !== 'true' ? title : undefined, doc_type });
    if (title && ci === 'true') {
      const nt = String(title).toLowerCase().replace(/\s+/g, ' ').trim();
      docs = docs.filter(d => String(d.title).toLowerCase().replace(/\s+/g, ' ').trim() === nt);
    }

    const q = req.query || {};
    const wantTags = (q.tags ? String(q.tags).split(',').map(s => s.trim()).filter(Boolean) : []);
    if (wantTags.length) {
      const mode = (q.tagsMode || 'all').toLowerCase();
      docs = docs.filter(d => {
        const t = Array.isArray(d.tags) ? d.tags : [];
        return mode === 'any' ? wantTags.some(x => t.includes(x)) : wantTags.every(x => t.includes(x));
      });
    }

    const metaPairs = Object.entries(q).filter(([k]) => k.startsWith('meta.'));
    if (metaPairs.length) {
      docs = docs.filter(d => metaPairs.every(([k, v]) => String(d.meta?.[k.slice(5)] ?? '') === String(v)));
    }

    if (!docs.length) return res.status(404).json({ error: 'no matches' });
    if (docs.length === 1) return res.json({ ok: true, doc: docs[0] });
    res.json({ ok: true, docs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'read failed' });
  }
});

// Lyra commands (confirm-project wrapper)
app.post('/lyra/command', async (req, res) => {
  try {
    const { command, args = {} } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });

    if (command === '/confirm-project') {
      const { id, project_name, slug } = args;
      let proj = null;
      if (id) proj = await db.getProjectById(id);
      else if (project_name) proj = await db.findProjectByName(project_name);
      else if (slug) proj = await db.findProjectBySlug(slug);
      if (!proj) return res.status(404).json({ error: 'project not found' });
      const confirmed = await db.confirmProject(proj.id);
      return res.json({ ok: true, project: confirmed });
    }

    return res.status(400).json({ error: 'unknown command', command });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'command failed' });
  }
});

// -----------------------------------------------------------------------------
/** Extras: /search (FTS), /read-stream (SSE), /export */
// -----------------------------------------------------------------------------

// Full-Text Search (FTS) with fallback
app.get('/search', async (req, res) => {
  try {
    const { project_name, q, limit = 25 } = req.query || {};
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
      return res.json(rows.map(r => ({
        ...r,
        tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags || '[]')
      })));
    }

    let docs = await db.listDocs({ project_id: proj.id });
    const needle = String(q).toLowerCase();
    docs = docs.filter(d => (d.title || '').toLowerCase().includes(needle) ||
                            (d.body_md || '').toLowerCase().includes(needle))
               .slice(0, hardLimit);
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'search failed' });
  }
});

// Streaming reader (SSE)
app.get('/read-stream', async (req, res) => {
  try {
    const { project_name, id, title, ci = 'false' } = req.query || {};
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
// Alias for Lyra parity
app.get('/lyra/read-stream', (req, res, next) => (req.url = req.url.replace('/lyra/read-stream', '/read-stream'), next()), (req, res) => {});

// Export project (stream JSON)
app.get('/export', async (req, res) => {
  try {
    const { project_name } = req.query || {};
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

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
(async () => {
  await db.init();
  app.listen(PORT, () => console.log(`Server v2.6.1-pg on :${PORT}`));
})();
