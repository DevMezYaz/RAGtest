// Offline mode: no AI model at all. The same question box, answered from the local index only, as well as that can be done:
//   - the words in the question are searched in the file names and in what is inside the files (text, OCR of images, what a picture shows)
//   - "search by meaning" (semantic.ts) finds pages and names that mean the same thing with different words
//   - small spelling slips in a name are forgiven
//   - "pdf", "excel", "photo", "last week", "october 2025", "yesterday" are understood as filters
// The lists are merged by reciprocal-rank fusion, so a file found in several ways rises to the top.
import { db, type FileRow } from "./db.js";
import { findFiles, getHit, searchContent, type FileHit } from "./search.js";
import { semanticAvailable, semanticSearch } from "./semantic.js";

export interface OfflineAnswer {
  mode: "files" | "none";
  message: string;
  files: { file: FileHit; page: number | null; quote: string | null; reason: string | null }[];
}

const KIND_WORDS: Record<string, string> = {
  pdf: "pdf", pdfs: "pdf", word: "doc", docx: "doc", doc: "doc", docs: "doc", excel: "sheet", xlsx: "sheet", spreadsheet: "sheet", spreadsheets: "sheet", sheet: "sheet", sheets: "sheet", csv: "sheet",
  powerpoint: "slides", pptx: "slides", ppt: "slides", slides: "slides", slide: "slides", presentation: "slides", presentations: "slides", deck: "slides",
  photo: "image", photos: "image", picture: "image", pictures: "image", image: "image", images: "image", screenshot: "image", screenshots: "image", jpg: "image", jpeg: "image", png: "image",
};
const KEEP_WORD = new Set(["screenshot", "screenshots"]);   // these are filters and also words that are in the names
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const FILLER = new Set(["find", "show", "me", "search", "for", "where", "is", "are", "my", "the", "a", "an", "please", "pls", "file", "files", "document", "documents", "of", "from", "about", "with", "get", "give", "look", "looking", "i", "need", "want", "can", "you", "that", "in", "on", "at", "to", "and"]);

export interface Parsed { text: string; kind?: string; after?: number; before?: number; notes: string[] }

export function parseQuery(q: string, now = new Date()): Parsed {
  let s = ` ${q.toLowerCase().replace(/[^\p{L}\p{N}\s\-/]/gu, " ")} `;
  const notes: string[] = [];
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = 86_400_000, today = startOfDay(now);
  let after: number | undefined, before: number | undefined;
  const take = (re: RegExp, f: (m: RegExpExecArray) => void) => { const m = re.exec(s); if (m) { f(m); s = s.replace(re, " "); } };
  take(/\byesterday\b/, () => { after = today - day; before = today; notes.push("yesterday"); });
  take(/\btoday\b/, () => { after = today; notes.push("today"); });
  take(/\blast\s+(\d{1,3})\s+days?\b/, (m) => { after = today - Number(m[1]) * day; notes.push(`last ${m[1]} days`); });
  take(/\b(this|last|past)\s+week\b/, (m) => { const dow = (now.getDay() + 6) % 7, mon = today - dow * day; if (m[1] === "this") after = mon; else { after = mon - 7 * day; before = mon; } notes.push(`${m[1]} week`); });
  take(/\b(this|last|past)\s+month\b/, (m) => {
    const first = new Date(now.getFullYear(), now.getMonth(), 1).getTime(), prev = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    if (m[1] === "this") after = first; else { after = prev; before = first; } notes.push(`${m[1]} month`);
  });
  take(/\b(this|last|past)\s+year\b/, (m) => {
    const first = new Date(now.getFullYear(), 0, 1).getTime(), prev = new Date(now.getFullYear() - 1, 0, 1).getTime();
    if (m[1] === "this") after = first; else { after = prev; before = first; } notes.push(`${m[1]} year`);
  });
  const mre = new RegExp(`\\b(${MONTHS.join("|")})(?:\\s+(20\\d\\d))?\\b`);
  take(mre, (m) => {
    const mi = MONTHS.indexOf(m[1]); let y = m[2] ? Number(m[2]) : now.getFullYear();
    if (!m[2] && new Date(y, mi, 1).getTime() > now.getTime()) y -= 1;   // "october" said in March means last October
    after = new Date(y, mi, 1).getTime(); before = new Date(y, mi + 1, 1).getTime(); notes.push(`${m[1]} ${y}`);
  });
  take(/\b(?:in|from|during)\s+(20\d\d)\b/, (m) => { after = new Date(Number(m[1]), 0, 1).getTime(); before = new Date(Number(m[1]) + 1, 0, 1).getTime(); notes.push(m[1]); });

  let kind: string | undefined;
  const words = s.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    const k = KIND_WORDS[w];
    if (k && !kind) { kind = k; notes.push(k === "doc" ? "Word" : k === "sheet" ? "spreadsheet" : k); if (KEEP_WORD.has(w)) kept.push(w); continue; }
    kept.push(w);
  }
  let text = kept.filter((w) => !FILLER.has(w)).join(" ").trim();
  if (!text) text = kept.filter((w) => !["the", "a", "an", "my", "me"].includes(w)).join(" ").trim();
  return { text: after || before || kind ? text : kept.join(" ").trim() || text, kind, after, before, notes };
}

// ── spelling slips ───────────────────────────────────────────────────────────────────────────────────────────────────
function dist(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2: number[] = [], prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);   // swapped letters count as one slip
      cur[j] = v; best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n];
}
let nameTokens: { sig: number; rows: { id: number; toks: string[]; mtime: number; kind: string }[] } | null = null;
function names() {
  const sig = (db.prepare("SELECT COUNT(*) n, COALESCE(MAX(id),0) m FROM files").get() as { n: number; m: number });
  const key = sig.n * 1_000_003 + sig.m;
  if (nameTokens?.sig === key) return nameTokens.rows;
  const rows = (db.prepare("SELECT id, name, kind, mtime FROM files").all() as { id: number; name: string; kind: string; mtime: number }[])
    .map((r) => ({ id: r.id, kind: r.kind, mtime: r.mtime, toks: (r.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1) }));
  nameTokens = { sig: key, rows };
  return rows;
}
function fuzzyNames(text: string, ok: (r: { kind: string; mtime: number }) => boolean, limit: number): { id: number; score: number }[] {
  const q = (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 4);
  if (!q.length) return [];
  const out: { id: number; score: number }[] = [];
  for (const r of names()) {
    if (!ok(r)) continue;
    let hit = 0;
    for (const t of q) {
      const max = t.length >= 8 ? 2 : 1;
      if (r.toks.some((n) => n === t || dist(t, n, max) <= max)) hit++;
    }
    if (hit && hit / q.length >= 0.5) out.push({ id: r.id, score: hit / q.length });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── the search ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const K = 60;
const clean = (s: string) => s.replace(/[«»]/g, "").replace(/\s+/g, " ").trim();

export function offlineSearch(query: string, limit = 12): OfflineAnswer {
  const p = parseQuery(query);
  const rowOf = db.prepare("SELECT kind, mtime FROM files WHERE id = ?");
  const pass = (r: { kind: string; mtime: number }) => (!p.kind || r.kind === p.kind) && (!p.after || r.mtime >= p.after) && (!p.before || r.mtime < p.before);
  const passId = (id: number) => { const r = rowOf.get(id) as { kind: string; mtime: number } | undefined; return !!r && pass(r); };
  const score = new Map<number, number>();
  const why = new Map<number, string>();
  const best = new Map<number, { page: number | null; quote: string | null }>();
  const add = (id: number, rank: number, w: number, reason: string) => { score.set(id, (score.get(id) ?? 0) + w / (K + rank)); if (!why.has(id)) why.set(id, reason); };

  if (!p.text) {
    // only filters ("pdfs from last week"): the newest matching files
    const hits = findFiles({ kind: p.kind, modifiedAfter: p.after ? new Date(p.after).toISOString() : undefined, limit: 60 }).filter((h) => (!p.before || h.mtime < p.before)).slice(0, limit);
    return answer(query, p, hits.map((h) => ({ file: h, page: null, quote: null, reason: "matches the filter" })));
  }

  const after = p.after ? new Date(p.after).toISOString() : undefined;
  searchContent({ query: p.text, kind: p.kind, modifiedAfter: after, limit: 60 }).filter((h) => !p.before || h.mtime < p.before).forEach((h, i) => {
    add(h.id, i, 1.0, "matching text");
    if (h.matches[0]) best.set(h.id, { page: h.matches[0].page, quote: clean(h.matches[0].snippet) });
  });
  findFiles({ query: p.text, kind: p.kind, modifiedAfter: after, limit: 60 }).filter((h) => !p.before || h.mtime < p.before).forEach((h, i) => add(h.id, i, 1.3, "name matches"));
  // a file whose name holds every word asked for is very probably the one
  const toks = (p.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  if (toks.length) for (const r of names()) if (pass(r) && toks.every((t) => r.toks.some((n) => n.includes(t)))) score.set(r.id, (score.get(r.id) ?? 0) + 0.03);

  let sem = false;
  if (semanticAvailable()) {
    const s = semanticSearch(p.text, 40);
    s.files.filter((f) => f.score > 0.2 && passId(f.file)).forEach((f, i) => { add(f.file, i, 0.8, "similar meaning"); sem = true; });
    const seen = new Set<number>();
    s.pages.filter((f) => f.score > 0.25 && passId(f.file)).forEach((f, i) => {
      if (seen.has(f.file)) return; seen.add(f.file);
      add(f.file, seen.size - 1, 0.9, "similar meaning");
      if (!best.has(f.file)) best.set(f.file, { page: f.page, quote: null });
      sem = true;
    });
  }
  if (score.size < 5) fuzzyNames(p.text, pass, 20).forEach((f, i) => add(f.id, i, 0.7, "close spelling"));

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const files = ranked.map(([id]) => {
    const file = getHit(id)!;
    const b = best.get(id);
    return { file, page: b?.page ?? null, quote: b?.quote ?? null, reason: why.get(id) ?? null };
  }).filter((f) => f.file);
  void sem;
  return answer(query, p, files);
}

function answer(query: string, p: Parsed, files: OfflineAnswer["files"]): OfflineAnswer {
  const filt = p.notes.length ? ` (${p.notes.join(", ")})` : "";
  if (!files.length) return { mode: "none", message: `Nothing in your files matches “${query.trim()}”${filt}. Try other words, a part of the name, or check which folders Yab can read under Access.`, files: [] };
  return { mode: "files", message: files.length === 1 ? `Found one file${filt}:` : `Found ${files.length} files${filt}, best first:`, files };
}

/** Extra candidates for the AI's own search, from the meaning index, when the word search came back thin. */
export function semanticExtras(query: string, have: Set<number>, max = 4): { file: FileRow; page: number; text: string }[] {
  if (!semanticAvailable()) return [];
  const out: { file: FileRow; page: number; text: string }[] = [];
  const seen = new Set(have);
  const get = db.prepare("SELECT * FROM files WHERE id = ?"), pg = db.prepare("SELECT text FROM pages WHERE file_id = ? AND page = ?");
  for (const r of semanticSearch(query, 20).pages) {
    if (r.score < 0.3 || seen.has(r.file)) continue;
    seen.add(r.file);
    const f = get.get(r.file) as FileRow | undefined, t = pg.get(r.file, r.page) as { text: string } | undefined;
    if (f && t) out.push({ file: f, page: r.page, text: t.text });
    if (out.length >= max) break;
  }
  return out;
}
