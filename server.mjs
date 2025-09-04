// server.mjs — cleaned and patched

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

import * as DB from './db.pg.mjs';
import { makeMiddleware } from './mw/middleware.mjs';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SELF_BASE = `http://127.0.0.1:${PORT}`;
const ALLOW_AUTOCONFIRM = process.env.ALLOW_AUTOCONFIRM === '1';

// helpers
const makeSlug = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');
const genId = () => (typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));

// mount middleware
app.use('/mw', makeMiddleware({ baseUrl: SELF_BASE }));

// health
app.get('/health', (_req, res) => res.json({ ok: true, version: '2.6.1-pg', db: 'postgres' }));

// --- DB bootstrap (supports multiple export styles) ---
let db;
async function resolveDbHandle() {
  if (typeof DB.initDb === 'function') return await DB.initDb();
  if (typeof DB.init === 'function') return await DB.init();
  if (typeof DB.default === 'function') return await DB.default();
  if (DB.default && typeof DB.default.initDb === 'function') return await DB.default.initDb();
  if (DB.default && typeof DB.default.init === 'function') return await DB.default.init();
  if (DB.default && (DB.default.query || DB.default._pool)) return DB.default;
  if (DB.query || DB._pool) return DB;
  throw new Error('db.pg.mjs does not expose an initializer or ready handle.');
}

// --- Projects routes (add above the boot block) ---

// List projects
app.get('/projects', async (_req, res) => {
  try {
    if (app.locals?.db?.listProjects) {
      const list = await app.locals.db.listProjects();
      return res.json(list);
    }
    const db = app.locals.db;
    const { rows } = await db._pool.query(
      `select id, name, slug, kind, parent_id, confirmed, require_confirmation, blocked,
              created_at, updated_at, deleted_at
         from projects
        where deleted_at is null
        order by created_at desc`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /projects failed', e);
    res.status(500).json({ error: 'list failed' });
  }
});

// Create a project (idempotent by name)
app.post('/projects', async (req, res) => {
  try {
    const { name, kind = 'book', parent_id = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const db = app.locals.db;
    if (db.findProjectByName && db.createProject) {
      const existing = await db.findProjectByName(name);
      if (existing) return res.status(409).json({ error: 'name already exists', id: existing.id });
      const proj = await db.createProject({
        id: crypto.randomUUID(),
        name,
        slug: name.toLowerCase().trim().replace(/\s+/g, '-'),
        kind,
        parent_id
      });
      return res.json(proj);
    }

    // SQL fallback
    const exists = await db._pool.query(
      `select id from projects where lower(name)=lower($1) and deleted_at is null limit 1`,
      [name]
    );
    if (exists.rows[0]) return res.status(409).json({ error: 'name already exists', id: exists.rows[0].id });
    const insert = await db._pool.query(
      `insert into projects (id, name, slug, kind, parent_id, confirmed, require_confirmation, blocked)
       values ($1,$2,$3,$4,$5,false,true,false)
       returning *`,
      [crypto.randomUUID(), name, name.toLowerCase().trim().replace(/\s+/g, '-'), kind, parent_id]
    );
    res.json(insert.rows[0]);
  } catch (e) {
    console.error('POST /projects failed', e);
    res.status(500).json({ error: 'create failed' });
  }
});

// Confirm a project by id OR name OR slug (any one)
app.post('/projects/confirm', async (req, res) => {
  try {
    const { id, name, slug } = req.body || {};
    const db = app.locals.db;

    let proj = null;
    if (id && db.getProjectById) proj = await db.getProjectById(id);
    else if (name && db.findProjectByName) proj = await db.findProjectByName(name);
    else if (slug && db.findProjectBySlug) proj = await db.findProjectBySlug(slug);

    if (!proj) {
      // SQL fallback find
      let r;
      if (id) r = await db._pool.query(`select * from projects where id=$1 limit 1`, [id]);
      else if (name) r = await db._pool.query(`select * from projects where lower(name)=lower($1) limit 1`, [name]);
      else if (slug) r = await db._pool.query(`select * from projects where slug=$1 limit 1`, [slug]);
      proj = r?.rows?.[0] || null;
    }
    if (!proj) return res.status(404).json({ error: 'project not found' });

    if (db.confirmProject) {
      const c = await db.confirmProject(proj.id);
      return res.json({ ok: true, project: c });
    }

    const upd = await db._pool.query(
      `update projects set confirmed=true, require_confirmation=false where id=$1 returning *`,
      [proj.id]
    );
    res.json({ ok: true, project: upd.rows[0] });
  } catch (e) {
    console.error('POST /projects/confirm failed', e);
    res.status(500).json({ error: 'confirm failed' });
  }
});

// --- Diagnostics route ---
app.get('/__diag', async (req, res) => {
  try {
    const dbh = (app.locals && app.locals.db) || db || null;
    const info = {
      has_db: !!dbh,
      has_pool: !!(dbh && dbh._pool),
      methods: dbh ? Object.keys(dbh).filter(k => typeof dbh[k] === 'function') : []
    };
    let tables = [];
    if (dbh && dbh._pool) {
      const q = `select table_schema, table_name
                 from information_schema.tables
                 where table_schema='public'
                 order by table_name`;
      const { rows } = await dbh._pool.query(q);
      tables = rows.map(r => `${r.table_schema}.${r.table_name}`);
    }
    res.json({ ok: true, info, tables });
  } catch (e) {
    console.error('diag error', e);
    res.status(500).json({ ok: false, error: 'diag failed' });
  }
});

// TODO: add project/doc/search routes with SQL fallbacks as needed...

// --- Boot ---
(async () => {
  try {
    db = await resolveDbHandle();
    if (db && typeof db.init === 'function') await db.init();
    if (app && app.locals) app.locals.db = db;
    app.listen(PORT, () => {
      console.log(`Server v2.6.1-pg on :${PORT}`);
    });
  } catch (e) {
    console.error('Boot failure:', e);
    process.exit(1);
  }
})();
