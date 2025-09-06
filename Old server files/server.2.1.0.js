/**
 * server.js — Writing API — v2.1.0
 * ---------------------------------------------------------------
 * Adds Lyra-facing helper endpoints on top of v2.0.0 core:
 *   - /lyra/paste-save
 *   - /lyra/read
 *   - /lyra/read-stream (SSE)
 *   - /lyra/ingest
 *   - /lyra/command
 *   - /lyra/modes
 * See v2.0.0 comments for core design details.
 */

// 01. Imports & App Bootstrap
// ---------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors({ origin: ['http://localhost:3000', '*'] }));

const PORT = process.env.PORT || 3000;
const ALLOW_AUTOCONFIRM = process.env.ALLOW_AUTOCONFIRM === '1';

// 02. In-Memory Data Layer
// ---------------------------------------------------------------
const db = {
  projects: new Map(),
  docs: new Map(),
  trash: { projects: new Map(), docs: new Map() },
};
let DEFAULT_PROJECT_ID = null;

// 03. Utilities & Helpers
// ---------------------------------------------------------------
const makeSlug = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');

const findProjectByName = (name) => {
  if (!name) return null;
  for (const p of db.projects.values()) if (p.name === name) return p;
  return null;
};
const findProjectBySlug = (slug) => {
  if (!slug) return null;
  for (const p of db.projects.values()) if (p.slug === slug) return p;
  return null;
};

function softDeleteProject(proj, who = 'system') {
  if (!proj.deleted_at) {
    proj.deleted_at = new Date().toISOString();
    proj.deleted_by = who;
  }
  db.trash.projects.set(proj.id, { ...proj });
}
function softDeleteDoc(doc, who = 'system') {
  if (!doc.deleted_at) {
    doc.deleted_at = new Date().toISOString();
    doc.deleted_by = who;
  }
  db.trash.docs.set(doc.id, { ...doc });
}
function purgeProject(id) {
  db.trash.projects.delete(id);
  db.projects.delete(id);
}
function purgeDoc(id) {
  db.trash.docs.delete(id);
  db.docs.delete(id);
}

// 04. Project Routes
// ---------------------------------------------------------------
app.post('/projects', (req, res) => {
  const { name, kind = 'book', parent_id = null } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (findProjectByName(name)) return res.status(409).json({ error: 'name already exists' });
  const id = nanoid();
  const now = new Date().toISOString();
  const proj = { id, name, slug: makeSlug(name), kind, parent_id, confirmed: false, require_confirmation: true, blocked: false, created_at: now, updated_at: now };
  db.projects.set(id, proj);
  res.json(proj);
});

app.get('/projects', (req, res) => {
  const { q } = req.query;
  let items = Array.from(db.projects.values()).filter(p => !p.deleted_at);
  if (q) {
    const qlc = String(q).toLowerCase();
    items = items.filter(p => p.name.toLowerCase().includes(qlc) || p.slug.includes(makeSlug(q)));
  }
  res.json(items);
});

app.get('/projects/find', (req, res) => {
  const { name, slug } = req.query;
  const proj = name ? findProjectByName(name) : slug ? findProjectBySlug(slug) : null;
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'not found' });
  res.json(proj);
});

app.post('/projects/:id/confirm', (req, res) => {
  const proj = db.projects.get(req.params.id);
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'not found' });
  proj.confirmed = true; proj.require_confirmation = false; proj.blocked = false;
  proj.updated_at = new Date().toISOString();
  res.json({ ok: true, project: proj });
});

app.post('/projects/confirm', (req, res) => {
  const { name, slug } = req.body || {};
  const proj = name ? findProjectByName(name) : slug ? findProjectBySlug(slug) : null;
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'project not found' });
  proj.confirmed = true; proj.require_confirmation = false; proj.blocked = false;
  proj.updated_at = new Date().toISOString();
  res.json({ ok: true, project: proj });
});

app.patch('/projects/:id', (req, res) => {
  const proj = db.projects.get(req.params.id);
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'not found' });
  const { name, kind, parent_id, confirmed, require_confirmation, blocked } = req.body || {};
  if (name) { proj.name = name; proj.slug = makeSlug(name); }
  if (kind) proj.kind = kind;
  if (typeof parent_id !== 'undefined') proj.parent_id = parent_id;
  if (typeof confirmed !== 'undefined') proj.confirmed = !!confirmed;
  if (typeof require_confirmation !== 'undefined') proj.require_confirmation = !!require_confirmation;
  if (typeof blocked !== 'undefined') proj.blocked = !!blocked;
  proj.updated_at = new Date().toISOString();
  res.json(proj);
});

app.post('/projects/set-default', (req, res) => {
  const { name, id } = req.body || {};
  let proj = null;
  if (id) proj = db.projects.get(id);
  else if (name) proj = findProjectByName(name);
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'project not found' });
  DEFAULT_PROJECT_ID = proj.id;
  res.json({ ok: true, default_project_id: DEFAULT_PROJECT_ID });
});

// 05. Middlewares
// ---------------------------------------------------------------
function resolveProjectId(req, res, next) {
  let { project_id, project_name } = req.body || {};
  const headerProjectId = req.header('x-project-id');
  let proj = null;
  if (project_id) proj = db.projects.get(project_id);
  else if (project_name) proj = findProjectByName(project_name);
  else if (headerProjectId) proj = db.projects.get(headerProjectId);
  else if (DEFAULT_PROJECT_ID) proj = db.projects.get(DEFAULT_PROJECT_ID);
  if (!proj || proj.deleted_at) return res.status(400).json({ error: 'project resolution failed' });
  req.project = proj;
  next();
}

function requireConfirmedProject(req, res, next) {
  const p = req.project;
  if (p.blocked) return res.status(403).json({ error: 'project is blocked' });
  if (p.require_confirmation && !p.confirmed) {
    if (ALLOW_AUTOCONFIRM) {
      p.confirmed = true; p.require_confirmation = false; p.blocked = false; p.updated_at = new Date().toISOString();
      return next();
    }
    return res.status(412).json({
      error: 'project not confirmed',
      hint: 'POST /projects/confirm with {"name":"<project name>"} or /projects/:id/confirm',
      project: { id: p.id, name: p.name }
    });
  }
  next();
}

// 06. Document Routes
// ---------------------------------------------------------------
app.post('/doc', resolveProjectId, requireConfirmedProject, (req, res) => {
  const { doc_type, title, body_md = '', tags = [], meta = {} } = req.body || {};
  if (!doc_type || !title) return res.status(400).json({ error: 'doc_type and title required' });
  const id = nanoid();
  const now = new Date().toISOString();
  const doc = { id, project_id: req.project.id, doc_type, title, body_md, tags, meta, created_at: now, updated_at: now };
  db.docs.set(id, doc);
  res.json(doc);
});

app.get('/doc', resolveProjectId, (req, res) => {
  const items = Array.from(db.docs.values()).filter(d => d.project_id === req.project.id && !d.deleted_at);
  res.json(items);
});

// 07. Safe Delete & Restore
// ---------------------------------------------------------------
app.delete('/doc/:id', (req, res) => {
  const { id } = req.params;
  const { purge = 'false' } = req.query;
  const confirmTitle = req.header('x-confirm-title');
  const doc = db.docs.get(id);
  if (!doc) {
    if (purge === 'true' && db.trash.docs.has(id)) { purgeDoc(id); return res.json({ ok: true, purged: true }); }
    return res.status(404).json({ error: 'doc not found' });
  }
  if (confirmTitle && confirmTitle !== doc.title) return res.status(412).json({ error: 'confirmation title mismatch', expected: doc.title });
  softDeleteDoc(doc, 'api');
  if (purge === 'true') purgeDoc(id);
  res.json({ ok: true, deleted: true, purged: purge === 'true' });
});

app.delete('/projects/:id', (req, res) => {
  const { id } = req.params;
  const { cascade = 'false', purge = 'false' } = req.query;
  const confirmName = req.header('x-confirm-name');
  const proj = db.projects.get(id);
  if (!proj) {
    if (purge === 'true' && db.trash.projects.has(id)) { purgeProject(id); return res.json({ ok: true, purged: true }); }
    return res.status(404).json({ error: 'project not found' });
  }
  if (!confirmName || confirmName !== proj.name) {
    return res.status(412).json({ error: 'confirmation required', hint: 'Send header x-confirm-name with exact project name', expected: proj.name });
  }
  const children = Array.from(db.docs.values()).filter(d => d.project_id === proj.id && !d.deleted_at);
  if (children.length > 0 && cascade !== 'true') {
    return res.status(409).json({ error: 'project has documents', count: children.length, hint: 'Retry with ?cascade=true' });
  }
  if (cascade === 'true') { for (const d of children) softDeleteDoc(d, 'cascade'); }
  softDeleteProject(proj, 'api');
  if (purge === 'true') {
    for (const [docId, d] of db.trash.docs.entries()) if (d.project_id === proj.id) db.trash.docs.delete(docId);
    purgeProject(id);
  }
  res.json({ ok: true, deleted: true, purged: purge === 'true', cascaded_docs: cascade === 'true' ? children.length : 0 });
});

app.post('/doc/:id/restore', (req, res) => {
  const { id } = req.params;
  const snap = db.trash.docs.get(id);
  if (!snap) return res.status(404).json({ error: 'not found in trash' });
  const restored = { ...snap }; delete restored.deleted_at; delete restored.deleted_by;
  db.docs.set(id, restored); db.trash.docs.delete(id);
  res.json({ ok: true, restored: true, doc: restored });
});

app.post('/projects/:id/restore', (req, res) => {
  const { id } = req.params;
  const snap = db.trash.projects.get(id);
  if (!snap) return res.status(404).json({ error: 'not found in trash' });
  const restored = { ...snap }; delete restored.deleted_at; delete restored.deleted_by;
  db.projects.set(id, restored); db.trash.projects.delete(id);
  res.json({ ok: true, restored: true, project: restored });
});

// 08. Diagnostics & Health
// ---------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '2.1.0', defaults: { project_id: DEFAULT_PROJECT_ID }, toggles: { ALLOW_AUTOCONFIRM } });
});

// 09. Lyra-Facing Helper Endpoints
// ---------------------------------------------------------------
/**
 * POST /lyra/paste-save
 * A convenience wrapper Lyra can call to create/update a document.
 * Payload:
 * {
 *   "project_name": "...",              // or pass x-project-id header
 *   "docMode": "create" | "update",     // default: create
 *   "sceneWriteMode": "overwrite"|"append", // when updating body
 *   "id": "<doc_id>",                   // required if update by id
 *   "payload": {                        // same shape as /doc
 *     "doc_type": "scene|chapter|concept|character",
 *     "title": "...",
 *     "body_md": "...",
 *     "tags": ["A","B"],
 *     "meta": {"act":1,"section":3,"chapter":11,"scene":1}
 *   }
 * }
 */
app.post('/lyra/paste-save', resolveProjectId, requireConfirmedProject, (req, res) => {
  const { docMode = 'create', sceneWriteMode = 'overwrite', id, payload = {} } = req.body || {};
  const { doc_type, title, body_md = '', tags = [], meta = {} } = payload;

  if (!doc_type || !title) return res.status(400).json({ error: 'doc_type and title required' });

  if (docMode === 'update') {
    if (!id) return res.status(400).json({ error: 'id is required for update' });
    const existing = db.docs.get(id);
    if (!existing || existing.project_id !== req.project.id) {
      return res.status(404).json({ error: 'doc not found in this project' });
    }
    // Update fields
    existing.doc_type = doc_type;
    existing.title = title;
    existing.tags = tags;
    existing.meta = meta;
    if (sceneWriteMode === 'append') {
      existing.body_md = (existing.body_md || '') + '\n' + body_md;
    } else {
      existing.body_md = body_md;
    }
    existing.updated_at = new Date().toISOString();
    return res.json({ ok: true, mode: 'update', doc: existing });
  }

  // Create
  const newId = nanoid();
  const now = new Date().toISOString();
  const doc = { id: newId, project_id: req.project.id, doc_type, title, body_md, tags, meta, created_at: now, updated_at: now };
  db.docs.set(newId, doc);
  return res.json({ ok: true, mode: 'create', doc });
});

/**
 * GET /lyra/read
 * Fetch a doc by id, or by (title, doc_type, meta.*).
 * Query params:
 *   id=<doc_id>
 *   title=<title>
 *   doc_type=<type>
 *   meta.key=value (repeatable)
 *   project_name=<name> (or use x-project-id header)
 */
app.get('/lyra/read', resolveProjectId, (req, res) => {
  const { id, title, doc_type } = req.query;
  const metaFilters = Object.fromEntries(Object.entries(req.query).filter(([k]) => k.startsWith('meta.')).map(([k, v]) => [k.slice(5), v]));

  let candidates = Array.from(db.docs.values()).filter(d => d.project_id === req.project.id && !d.deleted_at);

  if (id) {
    const doc = db.docs.get(id);
    if (!doc || doc.project_id !== req.project.id || doc.deleted_at) return res.status(404).json({ error: 'doc not found' });
    return res.json({ ok: true, doc });
  }
  if (title) candidates = candidates.filter(d => d.title === title);
  if (doc_type) candidates = candidates.filter(d => d.doc_type === doc_type);
  for (const [mk, mv] of Object.entries(metaFilters)) {
    candidates = candidates.filter(d => d.meta && String(d.meta[mk]) === String(mv));
  }

  if (candidates.length === 0) return res.status(404).json({ error: 'no matches' });
  if (candidates.length === 1) return res.json({ ok: true, doc: candidates[0] });
  return res.json({ ok: true, docs: candidates });
});

/**
 * GET /lyra/read-stream
 * Server-Sent Events stream to simulate "ChatGPT-style typing"
 * Query params same as /lyra/read (id, title, doc_type, meta.*)
 */
app.get('/lyra/read-stream', resolveProjectId, (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Helper to send an SSE message
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Find the doc (reuse /lyra/read logic minimally)
  const { id, title, doc_type } = req.query;
  const metaFilters = Object.fromEntries(Object.entries(req.query).filter(([k]) => k.startsWith('meta.')).map(([k, v]) => [k.slice(5), v]));
  let candidates = Array.from(db.docs.values()).filter(d => d.project_id === req.project.id && !d.deleted_at);
  if (id) {
    const doc = db.docs.get(id);
    if (!doc || doc.project_id !== req.project.id || doc.deleted_at) { send('error', { error: 'doc not found' }); return res.end(); }
    candidates = [doc];
  } else {
    if (title) candidates = candidates.filter(d => d.title === title);
    if (doc_type) candidates = candidates.filter(d => d.doc_type === doc_type);
    for (const [mk, mv] of Object.entries(metaFilters)) {
      candidates = candidates.filter(d => d.meta && String(d.meta[mk]) === String(mv));
    }
  }

  if (candidates.length === 0) { send('error', { error: 'no matches' }); return res.end(); }
  const doc = candidates[0];
  send('start', { id: doc.id, title: doc.title });

  // Stream the body in chunks to simulate typing
  const text = String(doc.body_md || '');
  const chunkSize = 256; // characters per chunk
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
  }, 25); // 25ms between chunks = smooth typing UX
});

/**
 * POST /lyra/ingest
 * Bulk upsert of docs.
 * Payload: { project_name?, docs: [ { id?, doc_type, title, body_md, tags, meta } ] }
 */
app.post('/lyra/ingest', resolveProjectId, requireConfirmedProject, (req, res) => {
  const { docs = [] } = req.body || {};
  if (!Array.isArray(docs) || docs.length === 0) return res.status(400).json({ error: 'docs array required' });

  const results = [];
  for (const item of docs) {
    const { id, doc_type, title, body_md = '', tags = [], meta = {} } = item || {};
    if (!doc_type || !title) { results.push({ ok: false, error: 'doc_type and title required' }); continue; }
    if (id && db.docs.has(id)) {
      const existing = db.docs.get(id);
      if (existing.project_id !== req.project.id) { results.push({ ok: false, error: 'doc belongs to different project', id }); continue; }
      existing.doc_type = doc_type;
      existing.title = title;
      existing.body_md = body_md;
      existing.tags = tags;
      existing.meta = meta;
      existing.updated_at = new Date().toISOString();
      results.push({ ok: true, id: existing.id, mode: 'update' });
    } else {
      const newId = nanoid();
      const now = new Date().toISOString();
      const doc = { id: newId, project_id: req.project.id, doc_type, title, body_md, tags, meta, created_at: now, updated_at: now };
      db.docs.set(newId, doc);
      results.push({ ok: true, id: newId, mode: 'create' });
    }
  }

  res.json({ ok: true, count: results.length, results });
});

/**
 * POST /lyra/command
 * Accepts a slash-like command and executes server actions.
 * Payload: { command: "/confirm-project", args: { project_name?: "...", slug?: "...", id?: "..." } }
 */
app.post('/lyra/command', (req, res) => {
  const { command, args = {} } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });

  switch (command) {
    case '/confirm-project': {
      const { project_name, slug, id } = args;
      let proj = null;
      if (id) proj = db.projects.get(id);
      else if (project_name) proj = findProjectByName(project_name);
      else if (slug) proj = findProjectBySlug(slug);
      if (!proj || proj.deleted_at) return res.status(404).json({ error: 'project not found' });
      proj.confirmed = true; proj.require_confirmation = false; proj.blocked = false; proj.updated_at = new Date().toISOString();
      return res.json({ ok: true, project: proj });
    }
    default:
      return res.status(400).json({ error: 'unknown command', command });
  }
});

/**
 * GET /lyra/modes
 * Simple enumeration Lyra/UI can use to decide UX.
 */
app.get('/lyra/modes', (req, res) => {
  res.json({
    ok: true,
    version: '2.1.0',
    modes: {
      read: { route: '/lyra/read', stream: '/lyra/read-stream' },
      write: { route: '/lyra/paste-save' },
      ingest: { route: '/lyra/ingest' },
      commands: { route: '/lyra/command', commands: ['/confirm-project'] }
    }
  });
});

// 10. Health (again) & Server Start
// ---------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '2.1.0', defaults: { project_id: DEFAULT_PROJECT_ID }, toggles: { ALLOW_AUTOCONFIRM } });
});

app.listen(PORT, () => {
  console.log(`Writing API v2.1.0 listening on :${PORT}`);
});
