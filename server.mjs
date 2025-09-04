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
