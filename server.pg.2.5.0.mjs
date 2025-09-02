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