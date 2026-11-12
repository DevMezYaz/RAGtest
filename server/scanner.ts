import fs from "node:fs/promises";
import path from "node:path";
import { OCR_DONE, ocrBatch, ocrBroken, ocrSupported } from "./ocr.js";
import { embedPending, forgetFileVector } from "./semantic.js";
import { isExcluded, isSensitive, loadConfig, type Config, underRoot } from "./config.js";
import { db } from "./db.js";
import { extOf, extractPages, keywordsFor, kindOf } from "./extract.js";

export interface ScanStatus {
  running: boolean;
  phase: "idle" | "walking" | "indexing" | "reading images" | "done";
  found: number;
  processed: number;
  indexed: number;
  unchanged: number;
  skippedSensitive: number;
  failed: number;
  current: string;
  startedAt: number;
  finishedAt: number;
}

export const status: ScanStatus = {
  running: false, phase: "idle", found: 0, processed: 0, indexed: 0, unchanged: 0,
  skippedSensitive: 0, failed: 0, current: "", startedAt: 0, finishedAt: 0,
};

const PACKAGE_DIR = /\.(app|photoslibrary|xcodeproj|xcworkspace|framework|bundle|lproj|ipynb_checkpoints)$/i;
const MAX_PAGES = 600;

const PROJECT_MARKERS = new Set(["package.json", "pyproject.toml", "requirements.txt", "setup.py", "pom.xml", "build.gradle", "Cargo.toml", "go.mod", "Gemfile", "projectsettings", "composer.json"]);
const DOC_KINDS = new Set(["pdf", "doc", "slides", "sheet"]);

/** Inside a code/game project only real documents (pdf/docx/pptx/xlsx) are indexed, not source, assets or logs. */
async function* walk(dir: string, cfg: Config, inProject = false): AsyncGenerator<{ file: string; size: number; mtime: number }> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  const skip = new Set(cfg.skipExtensions);
  inProject ||= entries.some((e) => PROJECT_MARKERS.has(e.name) || PROJECT_MARKERS.has(e.name.toLowerCase()));
  for (const e of entries) {
    if (e.name.startsWith("~$")) continue;
    const full = path.join(dir, e.name);
    if (isExcluded(full, cfg)) continue;
    if (e.isDirectory()) {
      if (PACKAGE_DIR.test(e.name) || isSensitive(full + path.sep, cfg)) continue;
      yield* walk(full, cfg, inProject);
    } else if (e.isFile()) {
      const ext = extOf(e.name);
      if (skip.has(ext)) continue;
      if (inProject && !DOC_KINDS.has(kindOf(ext))) continue;
      try {
        const st = await fs.stat(full);
        yield { file: full, size: st.size, mtime: Math.floor(st.mtimeMs) };
      } catch { /* vanished */ }
    }
  }
}

const q = {
  byPath: db.prepare("SELECT id, size, mtime FROM files WHERE path = ?"),
  delFile: db.prepare("DELETE FROM files WHERE id = ?"),
  insFile: db.prepare(`INSERT INTO files (path,name,ext,folder,kind,size,mtime,pages,keywords,has_text,error)
                       VALUES (@path,@name,@ext,@folder,@kind,@size,@mtime,@pages,@keywords,@has_text,@error)`),
  insPage: db.prepare("INSERT INTO pages (file_id,page,text) VALUES (?,?,?)"),
  allPaths: db.prepare("SELECT id, path FROM files"),
  upFile: db.prepare(`UPDATE files SET name=@name, ext=@ext, folder=@folder, kind=@kind, size=@size, mtime=@mtime, pages=@pages,
                      keywords=@keywords, has_text=@has_text, error=@error, ocr=0, smart=0 WHERE id=@id`),
  delPages: db.prepare("DELETE FROM pages WHERE file_id = ?"),
};

const store = db.transaction((row: Record<string, unknown>, pages: string[]) => {
  const old = q.byPath.get(row.path) as { id: number } | undefined;
  let id: number | bigint;
  if (old) {
    // keep the id so open viewers, chat chips and the drawer still point at this file (triggers keep FTS in sync)
    q.delPages.run(old.id);
    q.upFile.run({ ...row, id: old.id });
    id = old.id;
  } else id = q.insFile.run(row).lastInsertRowid;
  pages.forEach((t, i) => q.insPage.run(id, i + 1, t));
});

export async function indexOne(file: string, size: number, mtime: number, cfg: Config) {
  const ext = extOf(file);
  const kind = kindOf(ext);
  let pages: string[] = [];
  let error: string | null = null;
  // very large spreadsheets are the slowest thing to read (about 1 MB a second) and are usually raw data dumps: they are listed by name but not read
  const tooBigSheet = kind === "sheet" && size > (cfg.maxSheetMB ?? 10) * 1024 * 1024;
  if (kind !== "image" && kind !== "other" && !tooBigSheet && size <= cfg.maxFileMB * 1024 * 1024) {
    try {
      pages = (await extractPages(file, ext)).slice(0, MAX_PAGES);
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
    }
  }
  const textual = pages.some((p) => p.trim().length > 0);
  store(
    {
      path: file, name: path.basename(file), ext, folder: path.dirname(file), kind, size, mtime,
      pages: pages.length, keywords: keywordsFor(pages, file), has_text: textual ? 1 : 0, error,
    },
    pages.map((p) => (p.trim() ? p : " ")),
  );
  return !error;
}

const inflight = new Map<string, Promise<boolean>>();
/**
 * Event-based freshness: called whenever a file is opened or read. If it changed on disk since it was indexed
 * (edited in Word/Preview/Excel, or by Sleepy itself), re-index just that file now. Returns true when it changed.
 */
export async function refreshIfStale(f: { path: string; size: number; mtime: number }): Promise<boolean> {
  let st;
  try { st = await fs.stat(f.path); } catch { return false; }
  const mtime = Math.floor(st.mtimeMs);
  if (st.size === f.size && mtime === f.mtime) return false;
  let p = inflight.get(f.path);
  if (!p) {
    p = indexOne(f.path, st.size, mtime, loadConfig()).then(() => true, () => false).finally(() => inflight.delete(f.path));
    inflight.set(f.path, p);
  }
  return p;
}

let queued = false;
let epoch = 0;   // bumped when the shared folders change: a scan that started before it stops reading and a fresh one takes over
/** The shared folders changed: stop whatever scan is running (a new one is queued by the caller). */
export function accessChanged() { epoch++; }
/** Forget, right now, every file that is no longer inside a shared folder (or is sensitive): nothing outside the new scope may stay searchable while the next scan runs. */
export function purgeOutOfScope(): number {
  const cfg = loadConfig();
  let n = 0;
  db.transaction(() => {
    for (const r of q.allPaths.all() as { id: number; path: string }[]) {
      if (!cfg.folders.some((f) => underRoot(r.path, f)) || isSensitive(r.path, cfg)) { q.delFile.run(r.id); n++; }
    }
  })();
  return n;
}

/** Start a scan now, or right after the one in progress (used when access changes mid-scan). */
export function requestScan() {
  if (status.running) { queued = true; return; }
  void scan();
}

export async function scan(folders?: string[]) {
  if (status.running) return;
  const cfg = loadConfig();
  const roots = folders?.length ? folders : cfg.folders;
  Object.assign(status, {
    running: true, phase: "walking", found: 0, processed: 0, indexed: 0, unchanged: 0,
    skippedSensitive: 0, failed: 0, current: "", startedAt: Date.now(), finishedAt: 0,
  });
  const mine = epoch;
  try {
    const seen = new Set<string>();
    const todo: { file: string; size: number; mtime: number }[] = [];
    for (const root of roots) {
      for await (const f of walk(root, cfg)) {
        if (epoch !== mine) break;
        status.found++;
        if (isSensitive(f.file, cfg)) { status.skippedSensitive++; continue; }
        seen.add(f.file);
        const known = q.byPath.get(f.file) as { size: number; mtime: number } | undefined;
        if (known && known.size === f.size && known.mtime === f.mtime) { status.unchanged++; status.processed++; continue; }
        todo.push(f);
      }
    }
    status.phase = "indexing";
    let i = 0;
    const worker = async () => {
      while (i < todo.length && epoch === mine) {
        const f = todo[i++];
        status.current = path.basename(f.file);
        const ok = await indexOne(f.file, f.size, f.mtime, cfg).catch(() => false);
        ok ? status.indexed++ : status.failed++;
        status.processed++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    if (epoch === mine) await readImages(cfg, () => epoch !== mine);
    if (epoch === mine) await embedPending(() => epoch !== mine).catch(() => {});   // search by meaning: a vector for every new page and file name

    // drop files that vanished, moved out of scope, or are now considered sensitive
    // (a scan that was cut short by an access change has not seen every file, so it only removes what is out of scope; the scan that follows does the rest)
    const stale = epoch !== mine, now = loadConfig();
    const rootSet = roots.map((r) => (r.endsWith(path.sep) ? r : r + path.sep));
    for (const r of q.allPaths.all() as { id: number; path: string }[]) {
      const inScope = now.folders.some((f) => underRoot(r.path, f));
      if (!inScope || isSensitive(r.path, now) || (!stale && !seen.has(r.path) && rootSet.some((p) => r.path.startsWith(p)))) q.delFile.run(r.id);
    }
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('optimize')");
  } finally {
    Object.assign(status, { running: false, phase: "done", current: "", finishedAt: Date.now() });
    if (queued) { queued = false; void scan(); } else void import("./ai.js").then((m) => m.smartMaybeStart()).catch(() => {});
  }
}

/** Read the text in images that have not been read yet (newest first), so screenshots and scans can be searched by what they say. */
const ocrQ = {
  todo: db.prepare(`SELECT id, path, name FROM files WHERE kind = 'image' AND ocr < ${OCR_DONE} AND size >= 6000 AND size <= 40000000 ORDER BY mtime DESC LIMIT ?`),
  left: db.prepare(`SELECT COUNT(*) n FROM files WHERE kind = 'image' AND ocr < ${OCR_DONE} AND size >= 6000 AND size <= 40000000`),
  tiny: db.prepare(`UPDATE files SET ocr = ${OCR_DONE} WHERE kind = 'image' AND ocr < ${OCR_DONE} AND (size < 6000 OR size > 40000000)`),
  done: db.prepare(`UPDATE files SET ocr = ${OCR_DONE}, has_text = @has, pages = @pages, keywords = @keywords WHERE id = @id`),
  file: db.prepare("SELECT path, keywords FROM files WHERE id = ?"),
};
const saveOcr = db.transaction((id: number, text: string, labels: string[]) => {
  const t = text.replace(/\u0000/g, "").trim();
  const seen = labels.length ? `[image shows] ${labels.join(", ")}` : "";   // what the picture shows (a Mac's Vision labels): searchable like any other text, so "beach" finds a beach photo
  const body = [t, seen].filter(Boolean).join("\n\n");
  q.delPages.run(id);
  const f = ocrQ.file.get(id) as { path: string; keywords: string };
  if (t.length >= 3 || seen) {
    q.insPage.run(id, 1, body.slice(0, 20000));
    ocrQ.done.run({ id, has: 1, pages: 1, keywords: keywordsFor([body], f.path) });
  } else ocrQ.done.run({ id, has: 0, pages: 0, keywords: f.keywords });
  forgetFileVector(id);
});
async function readImages(cfg: Config, stop: () => boolean) {
  if (cfg.ocr === false || !ocrSupported() || ocrBroken()) return;
  ocrQ.tiny.run();   // icons and enormous files are not worth reading
  let total = (ocrQ.left.get() as { n: number }).n, doneN = 0;
  if (!total) return;
  status.phase = "reading images"; status.found = total; status.processed = 0;   // the progress now counts images
  while (!stop()) {
    const batch = ocrQ.todo.all(12) as { id: number; path: string; name: string }[];
    if (!batch.length) break;
    status.current = `${batch[0].name}  (${doneN + 1} of ${total})`;
    let texts: ({ text: string; labels: string[] } | null)[];
    try { texts = await ocrBatch(batch.map((b) => b.path)); }
    catch (e) { console.warn("[ocr] unavailable:", (e as Error).message); return; }   // the recognizer itself failed: leave these images for a later scan
    batch.forEach((b, i) => saveOcr(b.id, texts[i]?.text ?? "", texts[i]?.labels ?? []));
    doneN += batch.length;
    status.processed = doneN;
  }
}

export function stats() {
  const r = db.prepare("SELECT COUNT(*) files, COALESCE(SUM(has_text),0) searchable, COALESCE(SUM(pages),0) pages FROM files").get() as {
    files: number; searchable: number; pages: number;
  };
  return r;
}
