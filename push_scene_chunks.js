// run: node push_scene_chunks.js --file ./Scene01.txt --sceneId scn-001 --chapterId ch-010 --project "Shadow of the Crescent" --api https://writer-api-XXXX.onrender.com

import fs from "fs";
import path from "path";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=") || true];
  })
);

const FILE = args.file;
const API  = args.api || process.env.WRITER_API_BASE; // e.g. https://writer-api-XXXX.onrender.com
const PROJECT = args.project || process.env.DEFAULT_PROJECT_NAME || "Shadow of the Crescent";
const CHAPTER_ID = args.chapterId || "ch-unknown";
const SCENE_ID = args.sceneId || "scn-unknown";
const MODEL = process.env.MODEL_CHAT || "gpt-5-thinking";

// ——— tune chunk size here (characters) ———
const MAX = Number(args.max || 12000); // ~12k chars per chunk tends to be safe

if (!FILE || !API) {
  console.error("Usage: node push_scene_chunks.js --file ./Scene01.txt --sceneId scn-001 --chapterId ch-010 --project \"Shadow of the Crescent\" --api https://writer-api-XXXX.onrender.com [--max 12000]");
  process.exit(1);
}

const content = fs.readFileSync(path.resolve(FILE), "utf8");

// split on paragraph boundaries but cap size
function chunkText(text, maxChars) {
  const paras = text.split(/\n\s*\n/g);
  const chunks = [];
  let buf = "";

  for (const p of paras) {
    const candidate = buf ? buf + "\n\n" + p : p;
    if (candidate.length <= maxChars) {
      buf = candidate;
    } else {
      if (buf) chunks.push(buf);
      if (p.length > maxChars) {
        // force-split long paragraph
        for (let i = 0; i < p.length; i += maxChars) {
          chunks.push(p.slice(i, i + maxChars));
        }
        buf = "";
      } else {
        buf = p;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

const chunks = chunkText(content, MAX);

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${t}`);
  }
  return res.json().catch(() => ({}));
}

(async () => {
  console.log(`Pushing scene in ${chunks.length} chunk(s) to ${API}`);
  for (let i = 0; i < chunks.length; i++) {
    const mode = i === 0 ? "overwrite" : "append";
    const body = {
      project: PROJECT,
      chapterId: CHAPTER_ID,
      sceneId: SCENE_ID,
      content: chunks[i],
      chunkIndex: i,
      chunkCount: chunks.length,
      mode,                 // server should overwrite first, then append remainder
      model: MODEL
    };

    // Adjust this path to match your existing route that accepts scene upserts:
    // e.g. /scenes/upsert or /api/scenes
    const endpoint = `${API}/scenes/upsert`;

    console.log(`→ [${i + 1}/${chunks.length}] ${mode} (${chunks[i].length} chars)`);
    const out = await postJSON(endpoint, body);
    if (out?.error) throw new Error(out.error);
  }
  console.log("✅ Done. Scene uploaded cleanly.");
})().catch(err => {
  console.error("❌ Upload failed:", err.message);
  process.exit(1);
});