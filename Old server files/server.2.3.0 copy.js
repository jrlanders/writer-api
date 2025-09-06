/**
 * server.js — Writing API — v2.3.0
 * ---------------------------------------------------------------
 * Additions over v2.2.0:
 *   - Tag & meta filters for /doc and /lyra/read
 *     * tag=<t> (repeatable) or tags=a,b,c
 *     * tagsMode=all|any   (default: all)
 *     * meta.<k>=<v> (repeatable) — all meta filters must match
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

// Title normalizer: lowercase, collapse internal whitespace, trim
const normalizeTitle = (s) => String(s || '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

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

// Soft-delete helpers
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

// Mapper: DB row -> API doc (future-proofing if DB schema differs)
function mapDoc(row) {
  if (!row) return null;
  const {
    id, project_id, doc_type, title, body_md, tags, meta,
    created_at, updated_at, deleted_at
  } = row;
  return {
    id, project_id, doc_type, title, body_md, tags, meta, created_at, updated_at,
    deleted: !!deleted_at
  };
}

// CamelCase alias shim: let clients send projectName/docType/bodyMd
function camelCaseAliasShim(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    const b = req.body;
    // Project aliases
    if (!b.project_name && b.projectName) b.project_name = b.projectName;
    if (!b.project_id && b.projectId) b.project_id = b.projectId;
    // Doc aliases
    if (b.payload && typeof b.payload === 'object') {
      const p = b.payload;
      if (!p.doc_type && p.docType) p.doc_type = p.docType;
      if (!p.body_md && p.bodyMd) p.body_md = p.bodyMd;
    }
    if (!b.docMode && b.mode) b.docMode = b.mode;
    if (!b.sceneWriteMode && b.writeMode) b.sceneWriteMode = b.writeMode;
  }
  next();
}
app.use(camelCaseAliasShim);

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
  // Also support query param project_name for GET routes
  if (!project_name && req.query && req.query.project_name) project_name = req.query.project_name;

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
    return res.status(412).json({ error: 'project not confirmed', hint: 'POST /projects/confirm with {"name":"<project name>"} or /projects/:id/confirm', project: { id: p.id, name: p.name } });
  }
  next();
}

// Helper: parse tag params into array and apply mode
function applyTagFilter(items, query) {
  const tagsMode = (query.tagsMode || 'all').toLowerCase(); // 'all' or 'any'
  // Collect tags from ?tag=... (repeatable) and/or ?tags=a,b
  let wanted = [];
  if (Array.isArray(query.tag)) wanted = wanted.concat(query.tag);
  else if (query.tag) wanted.push(query.tag);
  if (query.tags) {
    wanted = wanted.concat(String(query.tags).split(',').map(s => s.trim()).filter(Boolean));
  }
  wanted = Array.from(new Set(wanted)); // unique

  if (wanted.length === 0) return items;

  return items.filter(d => {
    const docTags = Array.isArray(d.tags) ? d.tags : [];
    if (tagsMode === 'any') {
      return wanted.some(t => docTags.includes(t));
    } else {
      // all
      return wanted.every(t => docTags.includes(t));
    }
  });
}

// Helper: parse meta.* filters (all must match)
function applyMetaFilter(items, query) {
  const metaPairs = Object.entries(query)
    .filter(([k]) => k.startsWith('meta.'))
    .map(([k, v]) => [k.slice(5), v]);
  if (metaPairs.length === 0) return items;

  return items.filter(d => {
    const m = d.meta || {};
    return metaPairs.every(([mk, mv]) => String(m[mk]) === String(mv));
  });
}

// 06. Document Routes
// ---------------------------------------------------------------
// Create
app.post('/doc', resolveProjectId, requireConfirmedProject, (req, res) => {
  const { doc_type, title, body_md = '', tags = [], meta = {} } = req.body || {};
  if (!doc_type || !title) return res.status(400).json({ error: 'doc_type and title required' });
  const id = nanoid();
  const now = new Date().toISOString();
  const doc = { id, project_id: req.project.id, doc_type, title, body_md, tags, meta, created_at: now, updated_at: now };
  db.docs.set(id, doc);
  res.json(mapDoc(doc));
});

// List by project with optional filters: title, doc_type, ci=true, tags, meta.*
app.get('/doc', resolveProjectId, (req, res) => {
  const { title, doc_type, ci = 'false' } = req.query;
  let items = Array.from(db.docs.values()).filter(d => d.project_id === req.project.id && !d.deleted_at);

  if (title) {
    if (ci === 'true') {
      const nt = normalizeTitle(title);
      items = items.filter(d => normalizeTitle(d.title) === nt);
    } else {
      items = items.filter(d => d.title === title);
    }
  }
  if (doc_type) items = items.filter(d => d.doc_type === doc_type);

  items = applyTagFilter(items, req.query);
  items = applyMetaFilter(items, req.query);

  res.json(items.map(mapDoc));
});

// Read one by id
app.get('/doc/:id', resolveProjectId, (req, res) => {
  const doc = db.docs.get(req.params.id);
  if (!doc || doc.project_id !== req.project.id || doc.deleted_at) return res.status(404).json({ error: 'doc not found' });
  res.json(mapDoc(doc));
});

// Update by id (supports overwrite/append to body_md via ?append=true)
app.patch('/doc/:id', resolveProjectId, requireConfirmedProject, (req, res) => {
  const doc = db.docs.get(req.params.id);
  if (!doc || doc.project_id !== req.project.id || doc.deleted_at) return res.status(404).json({ error: 'doc not found' });

  const { doc_type, title, body_md, tags, meta } = req.body || {};
  const { append = 'false' } = req.query;

  if (doc_type) doc.doc_type = doc_type;
  if (title) doc.title = title;
  if (Array.isArray(tags)) doc.tags = tags;
  if (meta && typeof meta === 'object') doc.meta = meta;
  if (typeof body_md === 'string') {
    if (append === 'true') doc.body_md = (doc.body_md || '') + '\n' + body_md;
    else doc.body_md = body_md;
  }

  doc.updated_at = new Date().toISOString();
  res.json(mapDoc(doc));
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
  res.json({ ok: true, restored: true, doc: mapDoc(restored) });
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
  res.json({ ok: true, version: '2.3.0', defaults: { project_id: DEFAULT_PROJECT_ID }, toggles: { ALLOW_AUTOCONFIRM } });
});

// 09. Lyra-Facing Helper Endpoints
// ---------------------------------------------------------------
app.post('/lyra/paste-save', resolveProjectId, requireConfirmedProject, (req, res) => {
  const { docMode = 'create', sceneWriteMode = 'overwrite', id, payload = {} } = req.body || {};
  const { doc_type, title, body_md = '', tags = [], meta = {} } = payload;
  if (!doc_type || !title) return res.status(400).json({ error: 'doc_type and title required' });

  if (docMode === 'update') {
    if (!id) return res.status(400).json({ error: 'id is required for update' });
    const existing = db.docs.get(id);
    if (!existing || existing.project_id !== req.project.id) return res.status(404).json({ error: 'doc not found in this project' });
    existing.doc_type = doc_type;
    existing.title = title;
    existing.tags = tags;
    existing.meta = meta;
    if (sceneWriteMode === 'append') existing.body_md = (existing.body_md || '') + '\\n' + body_md;
    else existing.body_md = body_md;
    existing.updated_at = new Date().toISOString();
    return res.json({ ok: true, mode: 'update', doc: mapDoc(existing) });
  }

  const newId = nanoid();
  const now = new Date().toISOString();
  const doc = { id: newId, project_id: req.project.id, doc_type, title, body_md, tags, meta, created_at: now, updated_at: now };
  db.docs.set(newId, doc);
  return res.json({ ok: true, mode: 'create', doc: mapDoc(doc) });
});

app.get('/lyra/read', resolveProjectId, (req, res) => {
  const { id, title, doc_type, ci = 'false' } = req.query;
  const metaFilters = Object.fromEntries(Object.entries(req.query).filter(([k]) => k.startsWith('meta.')).map(([k, v]) => [k.slice(5), v]));

  // Build initial set
  let candidates = Array.from(db.docs.values()).filter(d => d.project_id === req.project.id && !d.deleted_at);

  // ID takes precedence
  if (id) {
    const doc = db.docs.get(id);
    if (!doc || doc.project_id !== req.project.id || doc.deleted_at) return res.status(404).json({ error: 'doc not found' });
    return res.json({ ok: true, doc: mapDoc(doc) });
  }

  // Title / type filters
  if (title) {
    if (ci === 'true') {
      const nt = normalizeTitle(title);
      candidates = candidates.filter(d => normalizeTitle(d.title) === nt);
    } else {
      candidates = candidates.filter(d => d.title === title);
    }
  }
  if (doc_type) candidates = candidates.filter(d => d.doc_type === doc_type);

  // Tags filter (same semantics as /doc)
  candidates = applyTagFilter(candidates, req.query);

  // Meta filters
  for (const [mk, mv] of Object.entries(metaFilters)) {
    candidates = candidates.filter(d => d.meta && String(d.meta[mk]) === String(mv));
  }

  if (candidates.length === 0) return res.status(404).json({ error: 'no matches' });
  if (candidates.length === 1) return res.json({ ok: true, doc: mapDoc(candidates[0]) });
  return res.json({ ok: true, docs: candidates.map(mapDoc) });
});

app.get('/lyra/read-stream', resolveProjectId, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event, data) => { res.write(`event: ${event}\\n`); res.write(`data: ${JSON.stringify(data)}\\n\\n`); };

  const { id, title, doc_type, ci = 'false' } = req.query;
  let candidates = Array.from(db.docs.values()).filter(d => d.project_id === req.project.id && !d.deleted_at);

  if (id) {
    const doc = db.docs.get(id);
    if (!doc || doc.project_id !== req.project.id || doc.deleted_at) { send('error', { error: 'doc not found' }); return res.end(); }
    candidates = [doc];
  } else {
    if (title) {
      if (ci === 'true') {
        const nt = normalizeTitle(title);
        candidates = candidates.filter(d => normalizeTitle(d.title) === nt);
      } else {
        candidates = candidates.filter(d => d.title === title);
      }
    }
    if (doc_type) candidates = candidates.filter(d => d.doc_type === doc_type);
    candidates = applyTagFilter(candidates, req.query);
    candidates = applyMetaFilter(candidates, req.query);
  }

  if (candidates.length === 0) { send('error', { error: 'no matches' }); return res.end(); }
  const doc = candidates[0];
  send('start', { id: doc.id, title: doc.title });
  const text = String(doc.body_md || '');
  const chunkSize = 256; let idx = 0;
  const interval = setInterval(() => {
    if (idx >= text.length) { clearInterval(interval); send('done', { bytes: text.length }); res.end(); return; }
    const chunk = text.slice(idx, idx + chunkSize); idx += chunkSize; send('delta', { chunk });
  }, 25);
});

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
      existing.doc_type = doc_type; existing.title = title; existing.body_md = body_md; existing.tags = tags; existing.meta = meta; existing.updated_at = new Date().toISOString();
      results.push({ ok: true, id: existing.id, mode: 'update' });
    } else {
      const newId = nanoid(); const now = new Date().toISOString();
      const doc = { id: newId, project_id: req.project.id, doc_type, title, body_md, tags, meta, created_at: now, updated_at: now };
      db.docs.set(newId, doc);
      results.push({ ok: true, id: newId, mode: 'create' });
    }
  }
  res.json({ ok: true, count: results.length, results });
});

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

app.get('/lyra/modes', (req, res) => {
  res.json({
    ok: true,
    version: '2.3.0',
    modes: {
      read: { route: '/lyra/read', stream: '/lyra/read-stream' },
      write: { route: '/lyra/paste-save' },
      ingest: { route: '/lyra/ingest' },
      commands: { route: '/lyra/command', commands: ['/confirm-project'] }
    }
  });
});

// 10. Server Start
// ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Writing API v2.3.0 listening on :${PORT}`);
});
