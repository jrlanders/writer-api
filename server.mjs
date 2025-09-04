// server.mjs — Writer API v2.6.3-pg (stable)
// - Single Express app
// - dotenv config
// - Robust DB boot that adapts to different db.pg.mjs exports
// - Middleware at /mw
// - Diagnostics at /__diag
// - Projects, Docs, Lyra helpers, Search, Read-stream, Export
// - Docs table auto-detect: supports `docs` or legacy `documents`

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

// mount middleware early
app.use('/mw', makeMiddleware({ baseUrl: SELF_BASE }));

// health
app.get('/health', (_req, res) => res.json({ ok: true, version: '2.6.3-pg', db: 'postgres' }));

/** ----- DB bootstrap (adapts to different export styles) ----- */
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

// docs table detector
let DOCS_TABLE = 'docs';
async function detectDocsTable() {
  if (!db?._pool) return 'docs';
  const r = await db._pool.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_name in ('docs','documents')
    order by table_name`);
  DOCS_TABLE = r.rows[0]?.table_name || 'docs';
  return DOCS_TABLE;
}

/** ----- Diagnostics ----- */
app.get('/__diag', async (_req, res) => {
  try {
    const dbh = (app.locals && app.locals.db) || db || null;
    const info = {
      has_db: !!dbh,
      has_pool: !!(dbh && dbh._pool),
      methods: dbh ? Object.keys(dbh).filter(k => typeof dbh[k] === 'function').slice(0, 50) : []
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
    res.json({ ok: true, info, tables, docs_table: DOCS_TABLE });
  } catch (e) {
    console.error('diag error', e);
    res.status(500).json({ ok: false, error: 'diag failed' });
  }
});

/** ================= Projects ================= */
// list
app.get('/projects', async (_req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    if (dbh.listProjects) {
      const list = await dbh.listProjects();
      return res.json(list);
    }
    const { rows } = await dbh._pool.query(
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

// create
app.post('/projects', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { name, kind = 'book', parent_id = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    if (dbh.findProjectByName && dbh.createProject) {
      const existing = await dbh.findProjectByName(name);
      if (existing) return res.status(409).json({ error: 'name already exists', id: existing.id });
      const proj = await dbh.createProject({
        id: genId(),
        name,
        slug: makeSlug(name),
        kind,
        parent_id
      });
      return res.json(proj);
    }

    const exists = await dbh._pool.query(
      `select id from projects where lower(name)=lower($1) and deleted_at is null limit 1`,
      [name]
    );
    if (exists.rows[0]) return res.status(409).json({ error: 'name already exists', id: exists.rows[0].id });
    const insert = await dbh._pool.query(
      `insert into projects (id, name, slug, kind, parent_id, confirmed, require_confirmation, blocked)
       values ($1,$2,$3,$4,$5,false,true,false)
       returning *`,
      [genId(), name, makeSlug(name), kind, parent_id]
    );
    res.json(insert.rows[0]);
  } catch (e) {
    console.error('POST /projects failed', e);
    res.status(500).json({ error: 'create failed' });
  }
});

// confirm by id|name|slug
app.post('/projects/confirm', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { id, name, slug } = req.body || {};
    let proj = null;

    if (id && dbh.getProjectById) proj = await dbh.getProjectById(id);
    else if (name && dbh.findProjectByName) proj = await dbh.findProjectByName(name);
    else if (slug && dbh.findProjectBySlug) proj = await dbh.findProjectBySlug(slug);

    if (!proj) {
      let r;
      if (id) r = await dbh._pool.query(`select * from projects where id=$1 limit 1`, [id]);
      else if (name) r = await dbh._pool.query(`select * from projects where lower(name)=lower($1) limit 1`, [name]);
      else if (slug) r = await dbh._pool.query(`select * from projects where slug=$1 limit 1`, [slug]);
      proj = r?.rows?.[0] || null;
    }
    if (!proj) return res.status(404).json({ error: 'project not found' });

    if (dbh.confirmProject) {
      const c = await dbh.confirmProject(proj.id);
      return res.json({ ok: true, project: c });
    }
    const upd = await dbh._pool.query(
      `update projects set confirmed=true, require_confirmation=false where id=$1 returning *`,
      [proj.id]
    );
    res.json({ ok: true, project: upd.rows[0] });
  } catch (e) {
    console.error('POST /projects/confirm failed', e);
    res.status(500).json({ error: 'confirm failed' });
  }
});

/** ================= Documents ================= */
// create
app.post('/doc', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name, doc_type, title, body_md = '', tags = [], meta = {} } = req.body || {};
    if (!project_name || !doc_type || !title) return res.status(400).json({ error: 'project_name, doc_type, title required' });

    // find project
    let proj = dbh.findProjectByName ? await dbh.findProjectByName(project_name) : null;
    if (!proj) {
      const r = await dbh._pool.query(`select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
      proj = r.rows[0];
    }
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
      return res.status(412).json({ error: 'project not confirmed' });

    if (dbh.createDoc) {
      const doc = await dbh.createDoc({ id: genId(), project_id: proj.id, doc_type, title, body_md, tags, meta });
      return res.json(doc);
    }
    const tname = await detectDocsTable();
    const ins = await dbh._pool.query(
      `insert into ${tname} (id, project_id, doc_type, title, body_md, tags, meta)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [genId(), proj.id, doc_type, title, body_md, JSON.stringify(tags), JSON.stringify(meta)]
    );
    res.json(ins.rows[0]);
  } catch (e) {
    console.error('doc create failed', e);
    res.status(500).json({ error: 'doc create failed' });
  }
});

// list
app.get('/doc', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name } = req.query;
    if (!project_name) return res.status(400).json({ error: 'project_name required' });

    let proj = dbh.findProjectByName ? await dbh.findProjectByName(project_name) : null;
    if (!proj) {
      const r = await dbh._pool.query(`select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
      proj = r.rows[0];
    }
    if (!proj) return res.status(404).json({ error: 'project not found' });

    if (dbh.listDocs) {
      const docs = await dbh.listDocs({ project_id: proj.id });
      return res.json(docs);
    }
    const tname = await detectDocsTable();
    const { rows } = await dbh._pool.query(
      `select id, project_id, doc_type, title, body_md, tags, meta, created_at, updated_at, deleted_at
         from ${tname}
        where project_id=$1 and deleted_at is null
        order by updated_at desc
        limit 500`,
      [proj.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('doc list failed', e);
    res.status(500).json({ error: 'doc list failed' });
  }
});

/** ================= Lyra helpers ================= */
// batch ingest
app.post('/lyra/ingest', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name, docs = [] } = req.body || {};
    if (!project_name || !Array.isArray(docs) || docs.length === 0) {
      return res.status(400).json({ error: 'project_name and docs[] required' });
    }

    let proj = dbh.findProjectByName ? await dbh.findProjectByName(project_name) : null;
    if (!proj) {
      const r = await dbh._pool.query(`select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
      proj = r.rows[0];
    }
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
      return res.status(412).json({ error: 'project not confirmed' });

    const tname = await detectDocsTable();
    const results = [];
    for (const item of docs) {
      const { id, doc_type, title, body_md = '', tags = [], meta = {} } = item || {};
      if (!doc_type || !title) { results.push({ ok: false, error: 'doc_type and title required' }); continue; }

      if (id) {
        const r = await dbh._pool.query(`select * from ${tname} where id=$1 and project_id=$2 and deleted_at is null limit 1`, [id, proj.id]);
        const ex = r.rows[0];
        if (ex) {
          const upd = await dbh._pool.query(
            `update ${tname} set doc_type=$2, title=$3, body_md=$4, tags=$5, meta=$6, updated_at=now()
             where id=$1 returning id`,
            [id, doc_type, title, body_md, JSON.stringify(tags), JSON.stringify(meta)]
          );
          results.push({ ok: true, id: upd.rows[0].id, mode: 'update' });
          continue;
        }
      }
      const ins = await dbh._pool.query(
        `insert into ${tname} (id, project_id, doc_type, title, body_md, tags, meta)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [genId(), proj.id, doc_type, title, body_md, JSON.stringify(tags), JSON.stringify(meta)]
      );
      results.push({ ok: true, id: ins.rows[0].id, mode: 'create' });
    }
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error('ingest failed', e);
    res.status(500).json({ error: 'ingest failed' });
  }
});

// paste-save (create/update + append mode)
app.post('/lyra/paste-save', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name, docMode = 'create', sceneWriteMode = 'overwrite', id, payload = {} } = req.body || {};
    const { doc_type, title, body_md = '', tags = [], meta = {} } = payload || {};
    if (!project_name || !doc_type || !title) return res.status(400).json({ error: 'project_name, doc_type, title required' });

    const rproj = await dbh._pool.query(`select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
    const proj = rproj.rows[0];
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (proj.require_confirmation && !proj.confirmed && !ALLOW_AUTOCONFIRM)
      return res.status(412).json({ error: 'project not confirmed' });

    const tname = await detectDocsTable();

    if (docMode === 'update') {
      if (!id) return res.status(400).json({ error: 'id required for update' });
      const rex = await dbh._pool.query(`select * from ${tname} where id=$1 and project_id=$2 and deleted_at is null limit 1`, [id, proj.id]);
      const ex = rex.rows[0];
      if (!ex) return res.status(404).json({ error: 'doc not found' });

      const nextBody = sceneWriteMode === 'append' ? (ex.body_md || '') + '\n' + body_md : body_md;
      const upd = await dbh._pool.query(
        `update ${tname} set doc_type=$2, title=$3, body_md=$4, tags=$5, meta=$6, updated_at=now()
         where id=$1 returning *`,
        [id, doc_type, title, nextBody, JSON.stringify(tags), JSON.stringify(meta)]
      );
      return res.json({ ok: true, mode: 'update', doc: upd.rows[0] });
    }

    const ins = await dbh._pool.query(
      `insert into ${tname} (id, project_id, doc_type, title, body_md, tags, meta)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [genId(), proj.id, doc_type, title, body_md, JSON.stringify(tags), JSON.stringify(meta)]
    );
    res.json({ ok: true, mode: 'create', doc: ins.rows[0] });
  } catch (e) {
    console.error('paste-save failed', e);
    res.status(500).json({ error: 'paste-save failed' });
  }
});

// read (by id/title/doc_type/tags)
app.get('/lyra/read', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name, id, title, doc_type, ci = 'false' } = req.query || {};
    if (!project_name) return res.status(400).json({ error: 'project_name required' });

    const rproj = await dbh._pool.query(`select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
    const proj = rproj.rows[0];
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const tname = await detectDocsTable();

    // by id
    if (id) {
      const q = `select * from ${tname} where id=$1 and project_id=$2 and deleted_at is null limit 1`;
      const { rows } = await dbh._pool.query(q, [id, proj.id]);
      const d = rows[0];
      return d ? res.json({ ok: true, doc: d }) : res.status(404).json({ error: 'doc not found' });
    }

    const params = [proj.id];
    const where = [`project_id = $1`, `deleted_at is null`];
    if (doc_type) { params.push(doc_type); where.push(`doc_type = $${params.length}`); }
    if (title && ci !== 'true') { params.push(title); where.push(`title = $${params.length}`); }

    const { rows } = await dbh._pool.query(
      `select * from ${tname} where ${where.join(' and ')} order by updated_at desc limit 500`,
      params
    );

    // ci exact
    let docs = rows;
    if (title && ci === 'true') {
      const nt = String(title).toLowerCase().replace(/\s+/g, ' ').trim();
      docs = rows.filter(d => String(d.title).toLowerCase().replace(/\s+/g, ' ').trim() === nt);
    }

    // tags filter
    const q = req.query || {};
    const wantTags = (q.tags ? String(q.tags).split(',').map(s => s.trim()).filter(Boolean) : []);
    if (wantTags.length) {
      const mode = (q.tagsMode || 'all').toLowerCase();
      docs = docs.filter(d => {
        const t = Array.isArray(d.tags) ? d.tags : [];
        return mode === 'any' ? wantTags.some(x => t.includes(x)) : wantTags.every(x => t.includes(x));
      });
    }

    // meta.*
    const metaPairs = Object.entries(q).filter(([k]) => k.startsWith('meta.'));
    if (metaPairs.length) {
      docs = docs.filter(d => metaPairs.every(([k, v]) => String(d.meta?.[k.slice(5)] ?? '') === String(v)));
    }

    if (!docs.length) return res.status(404).json({ error: 'no matches' });
    if (docs.length === 1) return res.json({ ok: true, doc: docs[0] });
    res.json({ ok: true, docs });
  } catch (e) {
    console.error('lyra/read failed', e);
    res.status(500).json({ error: 'read failed' });
  }
});

/** ================= Full-text search ================= */
app.get('/search', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name, q, limit = 25 } = req.query || {};
    if (!project_name || !q) return res.status(400).json({ error: 'project_name and q required' });

    const rproj = await dbh._pool.query(`select id from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
    const proj = rproj.rows[0];
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const hard = Math.min(parseInt(limit, 10) || 25, 200);
    const tname = await detectDocsTable();

    const tsCheck = await dbh._pool.query(`
      select column_name from information_schema.columns
      where table_schema='public' and table_name=$1 and column_name='ts'`, [tname]);

    let sql, args;
    if (tsCheck.rows[0]) {
      sql = `select id, project_id, doc_type, title, left(body_md,800) as body_md, tags, meta, created_at, updated_at
             from ${tname}
             where project_id=$1 and deleted_at is null
               and ts @@ plainto_tsquery('english', $2)
             order by ts_rank(ts, plainto_tsquery('english', $2)) desc, updated_at desc
             limit $3`;
      args = [proj.id, q, hard];
    } else {
      sql = `select id, project_id, doc_type, title, left(body_md,800) as body_md, tags, meta, created_at, updated_at
             from ${tname}
             where project_id=$1 and deleted_at is null
               and (lower(title) like $2 or lower(body_md) like $2)
             order by updated_at desc
             limit $3`;
      args = [proj.id, `%${String(q).toLowerCase()}%`, hard];
    }
    const { rows } = await dbh._pool.query(sql, args);
    res.json(rows);
  } catch (e) {
    console.error('search failed', e);
    res.status(500).json({ error: 'search failed' });
  }
});

/** ================= Streaming read ================= */
app.get('/read-stream', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name, id, title, ci = 'false' } = req.query || {};
    if (!project_name) return res.status(400).json({ error: 'project_name required' });

    const rproj = await dbh._pool.query(`select id from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
    const proj = rproj.rows[0];
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const tname = await detectDocsTable();

    let doc = null;
    if (id) {
      const r = await dbh._pool.query(`select * from ${tname} where id=$1 and project_id=$2 and deleted_at is null limit 1`, [id, proj.id]);
      doc = r.rows[0] || null;
    } else if (title) {
      const r = await dbh._pool.query(`select * from ${tname} where project_id=$1 and deleted_at is null order by updated_at desc limit 500`, [proj.id]);
      const rows = r.rows;
      const nt = String(title).toLowerCase().replace(/\s+/g, ' ').trim();
      const list = (ci === 'true')
        ? rows.filter(d => String(d.title).toLowerCase().replace(/\s+/g, ' ').trim() === nt)
        : rows.filter(d => d.title === title);
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
    console.error('read-stream failed', e);
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'read-stream failed' })}\n\n`);
      res.end();
    } catch {}
  }
});

/** ================= Export ================= */
app.get('/export', async (req, res) => {
  try {
    const dbh = app.locals?.db;
    if (!dbh) return res.status(500).json({ error: 'db not ready' });

    const { project_name } = req.query || {};
    if (!project_name) return res.status(400).json({ error: 'project_name required' });

    const rproj = await dbh._pool.query(`select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [project_name]);
    const proj = rproj.rows[0];
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const tname = await detectDocsTable();
    const { rows } = await dbh._pool.query(
      `select * from ${tname} where project_id=$1 and deleted_at is null order by updated_at desc`,
      [proj.id]
    );

    const filename = `${(proj.slug || proj.name || 'project').toLowerCase().replace(/[^a-z0-9-]+/g,'-')}-export.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.write('{"project":');
    res.write(JSON.stringify(proj));
    res.write(',"docs":[');
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) res.write(',');
      res.write(JSON.stringify(rows[i]));
    }
    res.write(']}');
    res.end();
  } catch (e) {
    console.error('export failed', e);
    res.status(500).json({ error: 'export failed' });
  }
});

/** ----- Boot ----- */
(async () => {
  try {
    db = await resolveDbHandle();
    if (db && typeof db.init === 'function') await db.init();
    app.locals.db = db;
    await detectDocsTable();
    app.listen(PORT, () => {
      console.log(`Server v2.6.3-pg on :${PORT}`);
    });
  } catch (e) {
    console.error('Boot failure:', e);
    process.exit(1);
  }
})();
