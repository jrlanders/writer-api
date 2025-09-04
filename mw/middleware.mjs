// mw/middleware.mjs
import express from "express";
import { z } from "zod";

// Exported factory that builds and returns the /mw router
export function makeMiddleware({ baseUrl }) {
  const mw = express.Router();

  // Ensure JSON body parsing for all /mw routes
  mw.use(express.json());

  // ---- quick health probe so you can verify the mount ----
  mw.get("/health", (req, res) => res.json({ ok: true, where: "middleware" }));

  // --------- Schemas ----------
  const structureSchema = z.object({
    act: z.string().min(1),
    section: z.union([z.number(), z.string()]).optional(),
    chapter: z.union([z.number(), z.string()]).optional(),
    scene: z.union([z.number(), z.string()]).optional()
  });

  const saveSceneSchema = z.object({
    project_name: z.string().min(1),
    title: z.string().min(1),
    structure: structureSchema,
    location: z.string().optional(),
    start: z.string().optional(), // ISO string if provided
    end: z.string().optional(),   // ISO string if provided
    tags: z.array(z.string()).optional(),
    notes_append: z.string().optional()
  });

  const enc = (v) => encodeURIComponent(v);

  async function httpJson(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        ...(opts.headers || {})
      }
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave json = null */ }
    return { ok: r.ok, status: r.status, json, text };
  }

  const lyraReadByTitle = async (project_name, title) => {
    const url = `${baseUrl}/lyra/read?project_name=${enc(project_name)}&title=${enc(title)}&ci=true`;
    const { ok, status, json } = await httpJson(url);
    if (status === 404) return null;
    if (!ok) throw new Error(`lyraReadByTitle ${status}`);
    return json.doc || (json.docs && json.docs[0]) || null;
  };

  const lyraReadByStructure = async (project_name, s) => {
    const params = new URLSearchParams();
    params.set("project_name", project_name);
    params.set("doc_type", "scene");
    if (s.act) params.set("meta.act", String(s.act));
    if (s.section != null) params.set("meta.section", String(s.section));
    if (s.chapter != null) params.set("meta.chapter", String(s.chapter));
    if (s.scene != null) params.set("meta.scene", String(s.scene));
    const url = `${baseUrl}/lyra/read?${params.toString()}`;
    const { ok, status, json } = await httpJson(url);
    if (status === 404) return null;
    if (!ok) throw new Error(`lyraReadByStructure ${status}`);
    return json.doc || (json.docs && json.docs[0]) || null;
  };

  const lyraPasteSave = async (payload) => {
    const { ok, status, json, text } = await httpJson(`${baseUrl}/lyra/paste-save`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!ok) throw new Error(`paste-save ${status}: ${text}`);
    return json;
  };

  const makeTocPath = (s) => {
    const parts = [];
    if (s.act) parts.push(`Act ${s.act}`);
    if (s.section != null) parts.push(`Section ${s.section}`);
    if (s.chapter != null) parts.push(`Chapter ${s.chapter}`);
    if (s.scene != null) parts.push(`Scene ${s.scene}`);
    return parts.join(" > ");
  };

  // --------- Endpoints ----------

  // Upsert a scene by title or structure; append notes if provided
  mw.post("/save-scene", async (req, res) => {
    try {
      const args = saveSceneSchema.parse(req.body);
      const { project_name, title, structure, location, start, end, tags = [], notes_append } = args;

      // Resolve existing doc (prefer title; fallback to structure)
      const existing =
        (await lyraReadByTitle(project_name, title)) ||
        (await lyraReadByStructure(project_name, structure));

      const payload = {
        project_name,
        docMode: existing ? "update" : "create",
        ...(existing && { id: existing.id }),
        ...(notes_append && { sceneWriteMode: "append" }),
        payload: {
          doc_type: "scene",
          title,
          ...(notes_append ? { body_md: `\\n${notes_append}` } : {}),
          tags: Array.from(new Set(["scene", ...(structure.act ? [`Act ${structure.act}`] : []), ...tags])),
          meta: {
            structure: {
              act: structure.act,
              ...(structure.section != null ? { section: Number(structure.section) || structure.section } : {}),
              ...(structure.chapter != null ? { chapter: Number(structure.chapter) || structure.chapter } : {}),
              ...(structure.scene != null ? { scene: String(structure.scene) } : {})
            },
            toc_path: makeTocPath(structure),
            ...(location ? { location } : {}),
            ...(start ? { start } : {}),
            ...(end ? { end } : {})
          }
        }
      };

      const result = await lyraPasteSave(payload);
      res.json({
        ok: true,
        mode: existing ? "update" : "create",
        id: result.document_id || existing?.id || null,
        title
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  // List scenes with optional filters
  mw.get("/list-scenes", async (req, res) => {
    try {
      const { project_name, act, section, chapter } = req.query;
      if (!project_name) return res.status(400).json({ ok: false, error: "project_name required" });

      const params = new URLSearchParams({ project_name, doc_type: "scene" });
      if (act) params.set("meta.act", String(act));
      if (section) params.set("meta.section", String(section));
      if (chapter) params.set("meta.chapter", String(chapter));

      const r = await httpJson(`${baseUrl}/lyra/read?${params.toString()}`);
      if (r.status === 404) return res.json({ ok: true, count: 0, scenes: [] });
      if (!r.ok || !r.json) return res.status(502).json({ ok: false, error: `upstream ${r.status}` });

      const docs = r.json.docs || (r.json.doc ? [r.json.doc] : []);
      const scenes = docs.map(d => ({
        id: d.id,
        title: d.title,
        structure: d.meta?.structure || null,
        location: d.meta?.location || null
      }));
      res.json({ ok: true, count: scenes.length, scenes });
    } catch (e) {
      res.status(500).json({ ok: false, error: "list-scenes failed" });
    }
  });

  // Compute a Scenes TOC on the fly (no stored doc required)
  mw.get("/toc/scenes", async (req, res) => {
    try {
      const { project_name } = req.query;
      if (!project_name) return res.status(400).json({ ok: false, error: "project_name required" });

      const r = await httpJson(`${baseUrl}/lyra/read?project_name=${enc(project_name)}&doc_type=scene`);
      if (r.status === 404) return res.json({ ok: true, count: 0, lines: [] });
      if (!r.ok || !r.json) return res.status(502).json({ ok: false, error: `upstream ${r.status}`, body: r.text?.slice(0,400) });

      const docs = r.json.docs || (r.json.doc ? [r.json.doc] : []);
      const ordered = docs.sort((a, b) => {
        const A = a.meta?.structure || {}, B = b.meta?.structure || {};
        const k = x => [x.act || "", x.section || 0, x.chapter || 0, String(x.scene ?? "")];
        return k(A).join("|").localeCompare(k(B).join("|"), "en", { numeric: true });
      });

      const lines = ordered.map(d => {
        const s = d.meta?.structure || {};
        const path = [
          s.act && `Act ${s.act}`,
          s.section != null && `Section ${s.section}`,
          s.chapter != null && `Chapter ${s.chapter}`,
          s.scene != null && `Scene ${s.scene}`
        ].filter(Boolean).join(" > ");
        return `${path} — ${d.title} (${d.id})`;
      });

      res.json({ ok: true, count: lines.length, lines });
    } catch (e) {
      res.status(500).json({ ok: false, error: "toc scenes failed" });
    }
  });

  return mw;
}
