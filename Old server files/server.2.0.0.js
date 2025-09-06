/**
 * server.js — Writing API — v2.0.0
 * ---------------------------------------------------------------
 * Purpose:
 *   A small, robust Express API for multi-project writing workflows
 *   (series & books), with explicit project confirmation gates,
 *   project-scoped document routes, safe delete/restore, and
 *   developer-friendly diagnostics.
 *
 * Why v2.0.0?
 *   - Fixes the "/confirm-project" loop by adding authoritative,
 *     idempotent server routes for confirmation.
 *   - Adds deterministic project resolution + gating middleware.
 *   - Adds soft-delete + purge deletes with name/title confirmation.
 *   - Bumps body size limits to support long scenes.
 *   - Thoroughly commented + organized for maintainability.
 *
 * Table of Contents
 *   01. Imports & App Bootstrap
 *   02. In-Memory Data Layer (swap for real DB/ORM)
 *   03. Utilities & Helpers (slugs, lookups, soft-delete)
 *   04. Project Routes
 *       4.1  Create
 *       4.2  List/Search
 *       4.3  Find (by name/slug)
 *       4.4  Confirm (by :id)
 *       4.5  Confirm (by name/slug)
 *       4.6  Update
 *       4.7  Set Default
 *   05. Middlewares
 *       5.1  resolveProjectId
 *       5.2  requireConfirmedProject
 *   06. Document Routes
 *       6.1  Create
 *       6.2  List (by project)
 *   07. Safe Delete & Restore
 *       7.1  Delete Doc (soft/purge)
 *       7.2  Delete Project (name-confirm, cascade, purge)
 *       7.3  Restore Doc
 *       7.4  Restore Project
 *   08. Diagnostics & Health
 *   09. Server Start
 *   10. Integration Notes & TODOs
 * ---------------------------------------------------------------
 */

// 01. Imports & App Bootstrap
// ---------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid'); // You may swap for uuid if preferred.

const app = express();

// Larger payloads for long scenes/chapters; modern, built-in parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS — allow local dev + wildcard (tighten in production)
app.use(cors({ origin: ['http://localhost:3000', '*'] }));

// Port handling
const PORT = process.env.PORT || 3000;

// Feature toggles / config
const ALLOW_AUTOCONFIRM = process.env.ALLOW_AUTOCONFIRM === '1';


// 02. In-Memory Data Layer (swap for real DB/ORM)
// ---------------------------------------------------------------
// For demo/dev use only. Replace with Prisma/Sequelize/Knex/Mongoose/etc.
const db = {
  projects: new Map(), // id -> project
  docs: new Map(),     // id -> doc
  trash: {             // soft-deleted snapshots
    projects: new Map(), // id -> project snapshot
    docs: new Map(),     // id -> doc snapshot
  },
};

// Optional default project preference (per server instance)
let DEFAULT_PROJECT_ID = null;


// 03. Utilities & Helpers (slugs, lookups, soft-delete)
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

// Soft-delete helpers (store snapshot in trash, allow restore)
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
// 4.1 Create a project (kind = 'series' | 'book')
app.post('/projects', (req, res) => {
  const { name, kind = 'book', parent_id = null } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  // Basic uniqueness by name for this demo layer
  if (findProjectByName(name)) return res.status(409).json({ error: 'name already exists' });

  const id = nanoid();
  const now = new Date().toISOString();
  const proj = {
    id,
    name,
    slug: makeSlug(name),
    kind,            // 'series' or 'book'
    parent_id,       // nullable; series -> books
    confirmed: false,
    require_confirmation: true,
    blocked: false,
    created_at: now,
    updated_at: now,
  };
  db.projects.set(id, proj);
  return res.json(proj);
});

// 4.2 List / search projects
app.get('/projects', (req, res) => {
  const { q } = req.query;
  let items = Array.from(db.projects.values()).filter(p => !p.deleted_at);
  if (q) {
    const qlc = String(q).toLowerCase();
    items = items.filter(p => p.name.toLowerCase().includes(qlc) || p.slug.includes(makeSlug(q)));
  }
  return res.json(items);
});

// 4.3 Find one project by exact name or slug
app.get('/projects/find', (req, res) => {
  const { name, slug } = req.query;
  const proj = name ? findProjectByName(name) : slug ? findProjectBySlug(slug) : null;
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'not found' });
  return res.json(proj);
});

// 4.4 Confirm by :id (authoritative, idempotent)
app.post('/projects/:id/confirm', (req, res) => {
  const proj = db.projects.get(req.params.id);
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'not found' });

  proj.confirmed = true;
  proj.require_confirmation = false;
  proj.blocked = false;
  proj.updated_at = new Date().toISOString();

  return res.json({ ok: true, project: proj });
});

// 4.5 Confirm by name OR slug (authoritative, idempotent)
app.post('/projects/confirm', (req, res) => {
  const { name, slug } = req.body || {};
  const proj = name ? findProjectByName(name) : slug ? findProjectBySlug(slug) : null;
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'project not found' });

  proj.confirmed = true;
  proj.require_confirmation = false;
  proj.blocked = false;
  proj.updated_at = new Date().toISOString();

  return res.json({ ok: true, project: proj });
});

// 4.6 Update project (flags/metadata)
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
  return res.json(proj);
});

// 4.7 Set default project (for convenience; per-process)
app.post('/projects/set-default', (req, res) => {
  const { name, id } = req.body || {};
  let proj = null;
  if (id) proj = db.projects.get(id);
  else if (name) proj = findProjectByName(name);
  if (!proj || proj.deleted_at) return res.status(404).json({ error: 'project not found' });

  DEFAULT_PROJECT_ID = proj.id;
  return res.json({ ok: true, default_project_id: DEFAULT_PROJECT_ID });
});


// 05. Middlewares
// ---------------------------------------------------------------
// 5.1 Resolve active project from body, header, or default
function resolveProjectId(req, res, next) {
  let { project_id, project_name } = req.body || {};
  const headerProjectId = req.header('x-project-id');

  let proj = null;
  if (project_id) proj = db.projects.get(project_id);
  else if (project_name) proj = findProjectByName(project_name);
  else if (headerProjectId) proj = db.projects.get(headerProjectId);
  else if (DEFAULT_PROJECT_ID) proj = db.projects.get(DEFAULT_PROJECT_ID);

  if (!proj || proj.deleted_at) {
    return res.status(400).json({ error: 'project resolution failed' });
  }

  req.project = proj; // attach for downstream
  return next();
}

// 5.2 Gate writes behind confirmation; allows optional auto-confirm in dev
function requireConfirmedProject(req, res, next) {
  const p = req.project;
  if (p.blocked) {
    return res.status(403).json({ error: 'project is blocked' });
  }
  if (p.require_confirmation && !p.confirmed) {
    if (ALLOW_AUTOCONFIRM) {
      // Dev convenience: flip flags on first write if enabled
      p.confirmed = true;
      p.require_confirmation = false;
      p.blocked = false;
      p.updated_at = new Date().toISOString();
      return next();
    }
    return res.status(412).json({
      error: 'project not confirmed',
      hint: 'POST /projects/confirm with {"name":"<project name>"} or /projects/:id/confirm',
      project: { id: p.id, name: p.name }
    });
  }
  return next();
}


// 06. Document Routes (project-scoped)
// ---------------------------------------------------------------
// 6.1 Create a document (scene/chapter/concept/etc.)
app.post('/doc', resolveProjectId, requireConfirmedProject, (req, res) => {
  const { doc_type, title, body_md = '', tags = [], meta = {} } = req.body || {};
  if (!doc_type || !title) return res.status(400).json({ error: 'doc_type and title required' });

  const id = nanoid();
  const now = new Date().toISOString();
  const doc = {
    id,
    project_id: req.project.id,
    doc_type,
    title,
    body_md,
    tags,
    meta,
    created_at: now,
    updated_at: now,
  };
  db.docs.set(id, doc);
  return res.json(doc);
});

// 6.2 List documents for the active project
app.get('/doc', resolveProjectId, (req, res) => {
  const items = Array.from(db.docs.values())
    .filter(d => d.project_id === req.project.id && !d.deleted_at);
  return res.json(items);
});


// 07. Safe Delete & Restore
// ---------------------------------------------------------------
// 7.1 Delete a doc (soft by default; purge optional). Optional title confirm.
app.delete('/doc/:id', (req, res) => {
  const { id } = req.params;
  const { purge = 'false' } = req.query;
  const confirmTitle = req.header('x-confirm-title'); // optional safety

  const doc = db.docs.get(id);

  if (!doc) {
    // Idempotent: if in trash and purge requested, purge it
    if (purge === 'true' && db.trash.docs.has(id)) {
      purgeDoc(id);
      return res.json({ ok: true, purged: true });
    }
    return res.status(404).json({ error: 'doc not found' });
  }

  if (confirmTitle && confirmTitle !== doc.title) {
    return res.status(412).json({ error: 'confirmation title mismatch', expected: doc.title });
  }

  softDeleteDoc(doc, 'api');
  if (purge === 'true') purgeDoc(id);

  return res.json({ ok: true, deleted: true, purged: purge === 'true' });
});

// 7.2 Delete a project (requires name confirm; supports cascade & purge)
app.delete('/projects/:id', (req, res) => {
  const { id } = req.params;
  const { cascade = 'false', purge = 'false' } = req.query;
  const confirmName = req.header('x-confirm-name'); // REQUIRED for safety

  const proj = db.projects.get(id);
  if (!proj) {
    // Idempotent: allow purge of an already-trashed project
    if (purge === 'true' && db.trash.projects.has(id)) {
      purgeProject(id);
      return res.json({ ok: true, purged: true });
    }
    return res.status(404).json({ error: 'project not found' });
  }

  if (!confirmName || confirmName !== proj.name) {
    return res.status(412).json({
      error: 'confirmation required',
      hint: 'Send header x-confirm-name with the exact project name',
      expected: proj.name
    });
  }

  const children = Array.from(db.docs.values())
    .filter(d => d.project_id === proj.id && !d.deleted_at);

  if (children.length > 0 && cascade !== 'true') {
    return res.status(409).json({
      error: 'project has documents',
      count: children.length,
      hint: 'Retry with ?cascade=true to delete project and its docs'
    });
  }

  if (cascade === 'true') {
    for (const d of children) softDeleteDoc(d, 'cascade');
  }

  softDeleteProject(proj, 'api');

  if (purge === 'true') {
    // Clean up trashed docs for this project
    for (const [docId, d] of db.trash.docs.entries()) {
      if (d.project_id === proj.id) db.trash.docs.delete(docId);
    }
    purgeProject(id);
  }

  return res.json({
    ok: true,
    deleted: true,
    purged: purge === 'true',
    cascaded_docs: cascade === 'true' ? children.length : 0
  });
});

// 7.3 Restore a doc from trash
app.post('/doc/:id/restore', (req, res) => {
  const { id } = req.params;
  const snap = db.trash.docs.get(id);
  if (!snap) return res.status(404).json({ error: 'not found in trash' });

  const restored = { ...snap };
  delete restored.deleted_at;
  delete restored.deleted_by;

  db.docs.set(id, restored);
  db.trash.docs.delete(id);
  return res.json({ ok: true, restored: true, doc: restored });
});

// 7.4 Restore a project from trash (does NOT auto-restore docs)
app.post('/projects/:id/restore', (req, res) => {
  const { id } = req.params;
  const snap = db.trash.projects.get(id);
  if (!snap) return res.status(404).json({ error: 'not found in trash' });

  const restored = { ...snap };
  delete restored.deleted_at;
  delete restored.deleted_by;

  db.projects.set(id, restored);
  db.trash.projects.delete(id);
  return res.json({ ok: true, restored: true, project: restored });
});


// 08. Diagnostics & Health
// ---------------------------------------------------------------
app.get('/health', (req, res) => {
  return res.json({
    ok: true,
    version: '2.0.0',
    defaults: {
      project_id: DEFAULT_PROJECT_ID,
    },
    toggles: {
      ALLOW_AUTOCONFIRM,
    }
  });
});


// 09. Server Start
// ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Writing API v2.0.0 listening on :${PORT}`);
});


// 10. Integration Notes & TODOs
// ---------------------------------------------------------------
/**
 * Integration Notes:
 * - Replace in-memory Maps with your DB:
 *   - Introduce Project and Document tables/collections.
 *   - Persist: confirmed, require_confirmation, blocked, deleted_at/by.
 *   - Add unique index on (user_id, project.name) if multi-tenant.
 *   - Index docs.project_id for fast project queries.
 *
 * - Client (Lyra) behavior:
 *   - Always pass project_name or x-project-id on writes.
 *   - On HTTP 412 from /doc: call POST /projects/confirm then retry.
 *   - Use DELETE routes with x-confirm-name or x-confirm-title when deleting.
 *
 * - Security:
 *   - Tighten CORS in production (whitelist exact domains).
 *   - Add authentication & authorization; stamp created_by/updated_by/deleted_by.
 *   - Consider rate limiting for public endpoints.
 *
 * - Dev convenience:
 *   - Set ALLOW_AUTOCONFIRM=1 in env to auto-confirm on first write.
 *
 * - Series/Book hierarchy:
 *   - Create a 'series' project (kind='series'), then 'book' projects
 *     with parent_id referencing the series id.
 *
 * - Future Extensions:
 *   - PATCH /doc/:id for updates; GET /doc/:id for reads.
 *   - Pagination & filtering on /doc list.
 *   - Trash listing endpoints for UX.
 *   - Webhooks or event log for sync.
 */
