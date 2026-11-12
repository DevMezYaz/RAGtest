import os from "node:os";
import { db, type FileRow } from "./db.js";

const tilde = (p: string) => (p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p).replace(/\\/g, "/");

export interface FileHit {
  id: number; name: string; folder: string; kind: string; pages: number; mtime: number; size: number; hasText: boolean;
}
export interface ContentHit extends FileHit {
  score: number;
  matches: { page: number; snippet: string }[];
}

const toHit = (f: FileRow): FileHit => ({
  id: f.id, name: f.name, folder: tilde(f.folder), kind: f.kind, pages: f.pages, mtime: f.mtime, size: f.size, hasText: !!f.has_text,
});

const STOP = new Set("the a an and or of to in on for with is are was were be what which who whom how do does did my me i you it its this that these those about from at by as any all find show give get need want file files document documents pdf please can could would tell where there their latest newest recent recently last old new open look looking search document docs".split(" "));

export function ftsQuery(q: string, opts: { dropStop?: boolean } = {}): string | null {
  const all = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  let toks = opts.dropStop === false ? all : all.filter((t) => !STOP.has(t) && t.length > 1);
  if (!toks.length) toks = all;
  toks = [...new Set(toks)].slice(0, 12);
  if (!toks.length) return null;
  return toks.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

interface Filters { kind?: string; folder?: string; modifiedAfter?: string; fileId?: number }

function filterSql(f: Filters, params: unknown[]) {
  let sql = "";
  if (f.fileId) { sql += " AND f.id = ?"; params.push(f.fileId); }
  if (f.kind) { sql += " AND f.kind = ?"; params.push(f.kind); }
  if (f.folder) { sql += " AND f.folder LIKE ?"; params.push(`%${f.folder.replace(/^~/, "")}%`); }
  if (f.modifiedAfter) {
    const t = Date.parse(f.modifiedAfter);
    if (!Number.isNaN(t)) { sql += " AND f.mtime >= ?"; params.push(t); }
  }
  return sql;
}

export function searchContent(args: Filters & { query: string; limit?: number }): ContentHit[] {
  const match = ftsQuery(args.query);
  if (!match) return [];
  const params: unknown[] = [match];
  const where = filterSql(args, params);
  const rows = db.prepare(
    `SELECT p.file_id AS fid, p.page AS page, bm25(pages_fts) AS score,
            snippet(pages_fts, 0, '«', '»', ' … ', 28) AS snip
     FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid JOIN files f ON f.id = p.file_id
     WHERE pages_fts MATCH ? ${where} ORDER BY score LIMIT 120`,
  ).all(...params) as { fid: number; page: number; score: number; snip: string }[];

  const by = new Map<number, { score: number; matches: { page: number; snippet: string }[] }>();
  for (const r of rows) {
    const e = by.get(r.fid) ?? { score: Infinity, matches: [] };
    e.score = Math.min(e.score, r.score);
    if (e.matches.length < 3) e.matches.push({ page: r.page, snippet: r.snip.replace(/\s+/g, " ").trim() });
    by.set(r.fid, e);
  }
  // filename / keyword matches nudge ranking
  const nameHits = new Map<number, number>();
  for (const r of db.prepare(
    "SELECT rowid AS id, bm25(files_fts, 8, 2, 3) AS s FROM files_fts WHERE files_fts MATCH ? LIMIT 100",
  ).all(match) as { id: number; s: number }[]) nameHits.set(r.id, r.s);

  const get = db.prepare("SELECT * FROM files WHERE id = ?");
  return [...by.entries()]
    .map(([id, e]) => ({ id, score: e.score + (nameHits.get(id) ?? 0) * 0.5, matches: e.matches }))
    .sort((a, b) => a.score - b.score)
    .slice(0, args.limit ?? 8)
    .map((e) => ({ ...toHit(get.get(e.id) as FileRow), score: Math.round(e.score * 100) / 100, matches: e.matches }));
}

export function findFiles(
  args: Filters & { query?: string; sort?: "recent" | "name" | "size"; limit?: number },
): FileHit[] {
  const limit = args.limit ?? 10;
  const params: unknown[] = [];
  const where = filterSql(args, params);
  const match = args.query ? ftsQuery(args.query) : null;
  if (match) {
    const rows = db.prepare(
      `SELECT f.* FROM files_fts JOIN files f ON f.id = files_fts.rowid
       WHERE files_fts MATCH ? ${where} ORDER BY bm25(files_fts, 8, 2, 3) LIMIT ?`,
    ).all(match, ...params, limit) as FileRow[];
    if (rows.length >= limit || !args.query) return rows.map(toHit);
    // supplement with substring name matches (e.g. "0058" inside IMG_0058)
    const have = new Set(rows.map((r) => r.id));
    const like = db.prepare(
      `SELECT f.* FROM files f WHERE f.name LIKE ? ${where} ORDER BY f.mtime DESC LIMIT ?`,
    ).all(`%${args.query.trim()}%`, ...params, limit) as FileRow[];
    return [...rows, ...like.filter((r) => !have.has(r.id))].slice(0, limit).map(toHit);
  }
  const order = args.sort === "name" ? "f.name COLLATE NOCASE" : args.sort === "size" ? "f.size DESC" : "f.mtime DESC";
  return (db.prepare(`SELECT f.* FROM files f WHERE 1=1 ${where} ORDER BY ${order} LIMIT ?`).all(...params, limit) as FileRow[]).map(toHit);
}

export function getFile(id: number): (FileRow & { folderTilde: string }) | undefined {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
  return f && { ...f, folderTilde: tilde(f.folder) };
}

export function getHit(id: number): FileHit | undefined {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
  return f && toHit(f);
}

export function getPages(id: number, from: number, to: number): { page: number; text: string }[] {
  return db.prepare("SELECT page, text FROM pages WHERE file_id = ? AND page BETWEEN ? AND ? ORDER BY page").all(id, from, to) as {
    page: number; text: string;
  }[];
}

/** File names for the drawer's idle animation. Names only, chosen at random. */
export function labels(n = 40): { id: number; name: string; kind: string }[] {
  const nice = db.prepare(
    "SELECT id, name, kind FROM files WHERE kind IN ('pdf','doc','slides','sheet') OR ext IN ('md','txt','csv') GROUP BY name ORDER BY RANDOM() LIMIT ?",
  ).all(n) as { id: number; name: string; kind: string }[];
  if (nice.length >= n) return nice;
  const rest = db.prepare("SELECT id, name, kind FROM files WHERE kind = 'image' ORDER BY RANDOM() LIMIT ?").all(n - nice.length) as { id: number; name: string; kind: string }[];
  return [...nice, ...rest];
}

/** The drawer's "infinite" scroll: files in a chosen order (labels only). */
export function drawerList(order: string, n = 1500): { id: number; name: string; kind: string }[] {
  const by: Record<string, string> = {
    random: "RANDOM()", name: "name COLLATE NOCASE ASC, id", new: "mtime DESC, id", old: "mtime ASC, id", folder: "folder COLLATE NOCASE ASC, name COLLATE NOCASE ASC, id", kind: "kind ASC, name COLLATE NOCASE ASC, id", size: "size DESC, id",
  };
  // one row per file name (the same name in two folders would show twice), then ordered on that row's own columns
  const sql = `SELECT id, name, kind FROM files WHERE kind IN ('pdf','doc','slides','sheet','text','image') AND id IN (SELECT MAX(id) FROM files GROUP BY name) ORDER BY ${by[order] ?? by.random} LIMIT ?`;
  return db.prepare(sql).all(Math.max(10, Math.min(5000, n))) as { id: number; name: string; kind: string }[];
}
