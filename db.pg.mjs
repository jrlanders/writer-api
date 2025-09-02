/**
 * db.pg.mjs — Postgres persistence adapter for Writing API
 * Requires: process.env.DATABASE_URL
 * Tables: projects, docs
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '0' ? false : { rejectUnauthorized: false }
});

export async function init() {
  await pool.query(`
    create table if not exists projects (
      id uuid primary key,
      name text unique not null,
      slug text unique not null,
      kind text not null default 'book',
      parent_id uuid,
      confirmed boolean not null default false,
      require_confirmation boolean not null default true,
      blocked boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );
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
      deleted_at timestamptz
    );
  `);
}

function q(s, params) { return pool.query(s, params); }

// ----- Projects -----
export async function createProject({ id, name, slug, kind, parent_id }) {
  const res = await q(
    `insert into projects (id,name,slug,kind,parent_id)
     values ($1,$2,$3,$4,$5)
     returning *`,
    [id, name, slug, kind ?? 'book', parent_id ?? null]
  );
  return res.rows[0];
}

export async function listProjects() {
  const res = await q(`select * from projects where deleted_at is null order by created_at asc`);
  return res.rows;
}

export async function getProjectById(id) {
  const res = await q(`select * from projects where id=$1`, [id]);
  return res.rows[0] ?? null;
}

export async function findProjectByName(name) {
  const res = await q(`select * from projects where name=$1 and deleted_at is null`, [name]);
  return res.rows[0] ?? null;
}

export async function findProjectBySlug(slug) {
  const res = await q(`select * from projects where slug=$1 and deleted_at is null`, [slug]);
  return res.rows[0] ?? null;
}

export async function confirmProject(id) {
  const res = await q(
    `update projects set confirmed=true, require_confirmation=false, blocked=false, updated_at=now()
     where id=$1 and deleted_at is null returning *`,
    [id]
  );
  return res.rows[0] ?? null;
}

// ----- Docs -----
export async function createDoc({ id, project_id, doc_type, title, body_md, tags, meta }) {
  const res = await q(
    `insert into docs (id, project_id, doc_type, title, body_md, tags, meta)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [id, project_id, doc_type, title, body_md ?? '', JSON.stringify(tags ?? []), JSON.stringify(meta ?? {})]
  );
  return res.rows[0];
}

export async function getDocById(id) {
  const res = await q(`select * from docs where id=$1`, [id]);
  return res.rows[0] ?? null;
}

export async function updateDoc(id, fields) {
  const allowed = ['doc_type','title','body_md','tags','meta'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (k in fields) {
      let v = fields[k];
      if (k === 'tags' || k === 'meta') v = JSON.stringify(v ?? (k==='tags'?[]:{}));
      sets.push(`${k}=$${i++}`); vals.push(v);
    }
  }
  if (sets.length === 0) return getDocById(id);
  vals.push(id);
  const res = await q(`update docs set ${sets.join(', ')}, updated_at=now() where id=$${i} returning *`, vals);
  return res.rows[0] ?? null;
}

export async function listDocs({ project_id }) {
  const res = await q(`select * from docs where project_id=$1 and deleted_at is null order by created_at asc`, [project_id]);
  return res.rows;
}

export default {
  init,
  createProject, listProjects, getProjectById, findProjectByName, findProjectBySlug, confirmProject,
  createDoc, getDocById, updateDoc, listDocs
};