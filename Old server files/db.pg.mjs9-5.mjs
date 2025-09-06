// db.pg.mjs — Postgres adapter (Aiven/Render friendly)
// - Uses process.env.DB_URL or DATABASE_URL
// - SSL required (no-verify allowed via connection string if set)
// - Exposes initDb() returning { _pool, ...helpers }
// - Creates minimal schema if missing: projects, docs (or uses documents table if it exists)

import pg from 'pg';
const { Pool } = pg;

const CONNECTION_STRING = process.env.DB_URL || process.env.DATABASE_URL;
if (!CONNECTION_STRING) {
  console.warn('[db] WARNING: DB_URL / DATABASE_URL is not set. The server will boot but DB will be unavailable.');
}

// Helper: run a query with simple logging
async function q(pool, text, params=[]) {
  // console.log('[db] SQL:', text, params);
  return pool.query(text, params);
}

async function ensureSchema(pool) {
  // Check if "documents" exists (legacy), else create "docs"
  const t = await q(pool, `
    select table_name from information_schema.tables
    where table_schema='public' and table_name in ('documents','docs') order by table_name`);
  const haveDocuments = t.rows.some(r => r.table_name === 'documents');
  const haveDocs = t.rows.some(r => r.table_name === 'docs');

  // projects
  await q(pool, `
    create table if not exists projects (
      id uuid primary key,
      name text not null,
      slug text not null,
      kind text not null default 'book',
      parent_id uuid,
      confirmed boolean not null default false,
      require_confirmation boolean not null default true,
      blocked boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );
  `);

  if (!haveDocuments && !haveDocs) {
    await q(pool, `
      create table if not exists docs (
        id uuid primary key,
        project_id uuid not null references projects(id) on delete cascade,
        doc_type text not null,
        title text not null,
        body_md text not null default '',
        tags jsonb not null default '[]'::jsonb,
        meta jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        ts tsvector
      );
    `);
    // trigger to keep ts in sync
    await q(pool, `
      create or replace function docs_tsv_update() returns trigger as $$
      begin
        new.ts := to_tsvector('english', coalesce(new.title,'') || ' ' || coalesce(new.body_md,''));
        return new;
      end
      $$ language plpgsql;
    `);
    await q(pool, `
      drop trigger if exists trg_docs_tsv on docs;
      create trigger trg_docs_tsv before insert or update on docs
      for each row execute procedure docs_tsv_update();
    `);
  }
}

function sqlDocsTableName(hasDocuments) {
  return hasDocuments ? 'documents' : 'docs';
}

export async function initDb() {
  if (!CONNECTION_STRING) {
    return {
      _pool: null,
      ready: false,
      // helpers that throw meaningful errors
      async listProjects() { throw new Error('No DB_URL configured'); }
    };
  }

  const pool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: CONNECTION_STRING.includes('sslmode=') ? undefined : { rejectUnauthorized: false }
  });

  // Prove connectivity
  await q(pool, 'select 1');

  await ensureSchema(pool);

  // Detect table preference
  const t = await q(pool, `
    select table_name from information_schema.tables
    where table_schema='public' and table_name in ('documents','docs') order by table_name`);
  const hasDocuments = t.rows.some(r => r.table_name === 'documents');
  const DOCS = sqlDocsTableName(hasDocuments);

  // ------- helpers -------
  async function findProjectByName(name) {
    const r = await q(pool, `select * from projects where lower(name)=lower($1) and deleted_at is null limit 1`, [name]);
    return r.rows[0] || null;
  }
  async function findProjectBySlug(slug) {
    const r = await q(pool, `select * from projects where slug=$1 and deleted_at is null limit 1`, [slug]);
    return r.rows[0] || null;
  }
  async function getProjectById(id) {
    const r = await q(pool, `select * from projects where id=$1 and deleted_at is null limit 1`, [id]);
    return r.rows[0] || null;
  }
  async function listProjects() {
    const r = await q(pool, `
      select id, name, slug, kind, parent_id, confirmed, require_confirmation, blocked, created_at, updated_at, deleted_at
      from projects where deleted_at is null order by created_at desc`);
    return r.rows;
  }
  async function createProject({ id, name, slug, kind='book', parent_id=null }) {
    const r = await q(pool, `
      insert into projects (id,name,slug,kind,parent_id,confirmed,require_confirmation,blocked)
      values ($1,$2,$3,$4,$5,false,true,false)
      returning *`,
      [id, name, slug, kind, parent_id]);
    return r.rows[0];
  }
  async function confirmProject(id) {
    const r = await q(pool, `
      update projects set confirmed=true, require_confirmation=false where id=$1 returning *`, [id]);
    return r.rows[0] || null;
  }

  async function listDocs({ project_id, title, doc_type }) {
    const params = [project_id];
    const where = [`project_id=$1`, `deleted_at is null`];
    if (doc_type) { params.push(doc_type); where.push(`doc_type = $${params.length}`); }
    if (title) { params.push(title); where.push(`title = $${params.length}`); }
    const r = await q(pool, `
      select * from ${DOCS} where ${where.join(' and ')}
      order by updated_at desc limit 500`, params);
    return r.rows;
  }
  async function createDoc(doc) {
    const { id, project_id, doc_type, title, body_md='', tags=[], meta={} } = doc;
    const r = await q(pool, `
      insert into ${DOCS} (id, project_id, doc_type, title, body_md, tags, meta)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [id, project_id, doc_type, title, body_md, JSON.stringify(tags), JSON.stringify(meta)]);
    return r.rows[0];
  }
  async function getDocById(id) {
    const r = await q(pool, `select * from ${DOCS} where id=$1 and deleted_at is null limit 1`, [id]);
    return r.rows[0] || null;
  }
  async function updateDoc(id, fields) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'tags' || k === 'meta') {
        sets.push(`${k} = $${i++}`);
        vals.push(JSON.stringify(v));
      } else {
        sets.push(`${k} = $${i++}`);
        vals.push(v);
      }
    }
    sets.push(`updated_at = now()`);
    vals.push(id);
    const sql = `update ${DOCS} set ${sets.join(', ')} where id = $${i} returning *`;
    const r = await q(pool, sql, vals);
    return r.rows[0];
  }

  return {
    _pool: pool,
    DOCS_TABLE: DOCS,
    // helpers
    findProjectByName,
    findProjectBySlug,
    getProjectById,
    listProjects,
    createProject,
    confirmProject,
    listDocs,
    createDoc,
    getDocById,
    updateDoc,

    // optional init (no-op; server calls it if present)
    async init() { /* no-op */ },
  };
}

export default { initDb };
