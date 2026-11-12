// "Search by meaning", entirely on this computer: a small static word-vector model (minishlab/potion-base-8M, MIT licence, ~30 MB, no network and no AI service at run time).
// Every page and every file name is turned into a 256-number vector (the average of its words' vectors); a question is turned into one the same way, and the closest ones win.
// "tax return" finds a page about "income declaration", "photo of the sea" finds an image labelled "beach". It runs in milliseconds and is blended with the ordinary word search.
import fs from "node:fs";
import path from "node:path";
import { HOME_DIR, ROOT } from "./config.js";
import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS vec_pages (page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS vec_files (file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, v BLOB NOT NULL);
`);

const DIM = 256;
const MODEL_DIRS = [path.join(ROOT, "models", "potion-base-8M"), path.join(HOME_DIR, "models", "potion-base-8M")];

interface Model { emb: Float32Array; vocab: Map<string, number>; unk: number }
let model: Model | null | undefined;

function loadModel(): Model | null {
  if (model !== undefined) return model;
  model = null;
  for (const dir of MODEL_DIRS) {
    try {
      const st = path.join(dir, "model.safetensors"), tk = path.join(dir, "tokenizer.json");
      if (!fs.existsSync(st) || !fs.existsSync(tk)) continue;
      const buf = fs.readFileSync(st);
      const headerLen = Number(buf.readBigUInt64LE(0));
      const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString("utf8")) as Record<string, { shape: number[]; data_offsets: [number, number] }>;
      const t = header.embeddings;
      const [a, b] = t.data_offsets, start = 8 + headerLen + a;
      const bytes = buf.subarray(start, 8 + headerLen + b);
      const emb = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));   // a copy: the offset in the file need not be 4-byte aligned
      const tok = JSON.parse(fs.readFileSync(tk, "utf8")) as { model: { vocab: Record<string, number>; unk_token: string } };
      const vocab = new Map(Object.entries(tok.model.vocab));
      if (t.shape[1] !== DIM || emb.length !== t.shape[0] * DIM) continue;
      model = { emb, vocab, unk: vocab.get(tok.model.unk_token) ?? 1 };
      return model;
    } catch { /* try the next place */ }
  }
  return model;
}
export const semanticAvailable = () => !!loadModel();

// BERT-style tokenising: lower-case, strip accents, split on spaces and punctuation, then greedy word-pieces.
const isCjk = (c: number) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2a6df);
function pieces(text: string): string[] {
  const t = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (/\s/.test(ch) || c === 0 || c < 32) flush();
    else if (isCjk(c) || /[\p{P}\p{S}]/u.test(ch)) { flush(); out.push(ch); }
    else cur += ch;
  }
  flush();
  return out;
}
function ids(m: Model, text: string, max = 1200): number[] {
  const res: number[] = [];
  for (const w of pieces(text)) {
    if (res.length >= max) break;
    if (w.length > 100) continue;
    let s = 0;
    const out: number[] = [];
    let bad = false;
    while (s < w.length) {
      let e = w.length, hit = -1;
      for (; e > s; e--) {
        const id = m.vocab.get((s ? "##" : "") + w.slice(s, e));
        if (id !== undefined) { hit = id; break; }
      }
      if (hit < 0) { bad = true; break; }
      out.push(hit); s = e;
    }
    if (!bad) res.push(...out);
  }
  return res;
}

/** The vector for a text (length 1, or all zeros when there is nothing to read). */
export function embed(text: string): Float32Array | null {
  const m = loadModel();
  if (!m) return null;
  const tk = ids(m, text);
  if (!tk.length) return null;
  const v = new Float32Array(DIM);
  for (const id of tk) { const o = id * DIM; for (let i = 0; i < DIM; i++) v[i] += m.emb[o + i]; }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

/** int8 with one scale: 260 bytes a vector. */
function pack(v: Float32Array): Buffer {
  let mx = 0;
  for (let i = 0; i < DIM; i++) mx = Math.max(mx, Math.abs(v[i]));
  const scale = mx / 127 || 1;
  const b = Buffer.alloc(4 + DIM);
  b.writeFloatLE(scale, 0);
  for (let i = 0; i < DIM; i++) b.writeInt8(Math.max(-127, Math.min(127, Math.round(v[i] / scale))), 4 + i);
  return b;
}

// ── indexing ──────────────────────────────────────────────────────────────────────────────────────────────────────
const fileText = (f: { name: string; folder: string; keywords: string }) =>
  `${f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.]+/g, " ")} ${path.basename(f.folder)} ${f.keywords}`.slice(0, 1500);

/** Give a vector to every page and file that has none yet. Returns how many were added. */
export async function embedPending(stop: () => boolean = () => false): Promise<number> {
  if (!loadModel()) return 0;
  let n = 0;
  const insP = db.prepare("INSERT OR REPLACE INTO vec_pages (page_id, v) VALUES (?, ?)");
  const insF = db.prepare("INSERT OR REPLACE INTO vec_files (file_id, v) VALUES (?, ?)");
  for (;;) {
    if (stop()) break;
    const pages = db.prepare("SELECT p.id, p.text FROM pages p LEFT JOIN vec_pages v ON v.page_id = p.id WHERE v.page_id IS NULL LIMIT 400").all() as { id: number; text: string }[];
    if (!pages.length) break;
    db.transaction(() => { for (const p of pages) { const v = embed(p.text.slice(0, 4000)); insP.run(p.id, pack(v ?? new Float32Array(DIM))); } })();   // an empty page gets a zero vector so it is not tried again
    n += pages.length;
    await new Promise((r) => setImmediate(r));   // let the server answer requests in between
  }
  for (;;) {
    if (stop()) break;
    const files = db.prepare("SELECT f.id, f.name, f.folder, f.keywords FROM files f LEFT JOIN vec_files v ON v.file_id = f.id WHERE v.file_id IS NULL LIMIT 800").all() as { id: number; name: string; folder: string; keywords: string }[];
    if (!files.length) break;
    db.transaction(() => { for (const f of files) { const v = embed(fileText(f)); insF.run(f.id, pack(v ?? new Float32Array(DIM))); } })();
    n += files.length;
    await new Promise((r) => setImmediate(r));
  }
  if (n) cache = null;
  return n;
}

// ── searching ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Store { ids: Int32Array; scale: Float32Array; q: Int8Array; n: number }
interface Cache { sig: string; pages: Store; files: Store; pageOwner: Map<number, { file: number; page: number }> }
let cache: Cache | null = null;

function loadStore(sql: string): Store {
  const rows = db.prepare(sql).all() as { id: number; v: Buffer }[];
  const n = rows.length, ids = new Int32Array(n), scale = new Float32Array(n), q = new Int8Array(n * DIM);
  rows.forEach((r, i) => {
    ids[i] = r.id; scale[i] = r.v.readFloatLE(0);
    for (let k = 0; k < DIM; k++) q[i * DIM + k] = r.v.readInt8(4 + k);
  });
  return { ids, scale, q, n };
}
function getCache(): Cache {
  const sig = JSON.stringify([db.prepare("SELECT COUNT(*) a, COALESCE(MAX(page_id),0) b FROM vec_pages").get(), db.prepare("SELECT COUNT(*) a, COALESCE(MAX(file_id),0) b FROM vec_files").get()]);
  if (cache && cache.sig === sig) return cache;
  const owner = new Map<number, { file: number; page: number }>();
  for (const r of db.prepare("SELECT p.id, p.file_id, p.page FROM pages p JOIN vec_pages v ON v.page_id = p.id").all() as { id: number; file_id: number; page: number }[]) owner.set(r.id, { file: r.file_id, page: r.page });
  cache = { sig, pages: loadStore("SELECT page_id AS id, v FROM vec_pages"), files: loadStore("SELECT file_id AS id, v FROM vec_files"), pageOwner: owner };
  return cache;
}

function top(s: Store, q: Float32Array, k: number): { id: number; score: number }[] {
  const best: { id: number; score: number }[] = [];
  let floor = -1;
  for (let i = 0; i < s.n; i++) {
    let d = 0;
    const o = i * DIM;
    for (let j = 0; j < DIM; j++) d += q[j] * s.q[o + j];
    d *= s.scale[i];
    if (best.length < k || d > floor) {
      best.push({ id: s.ids[i], score: d });
      best.sort((a, b) => b.score - a.score);
      if (best.length > k) best.pop();
      floor = best[best.length - 1].score;
    }
  }
  return best;
}

/** The pages and the files whose meaning is closest to the question. */
export function semanticSearch(query: string, k = 30): { pages: { file: number; page: number; score: number }[]; files: { file: number; score: number }[] } {
  const qv = embed(query);
  if (!qv) return { pages: [], files: [] };
  const c = getCache();
  const pages = top(c.pages, qv, k).map((r) => ({ ...c.pageOwner.get(r.id)!, score: r.score })).filter((r) => r.file);
  const files = top(c.files, qv, k).map((r) => ({ file: r.id, score: r.score }));
  return { pages, files };
}

export const forgetFileVector = (fileId: number) => { db.prepare("DELETE FROM vec_files WHERE file_id = ?").run(fileId); };
