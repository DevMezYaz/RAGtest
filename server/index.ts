import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { ROOT, accessChoice, expand, isOffline, isSensitive, loadConfig, saveConfig, underRoot } from "./config.js";
import { offlineSearch } from "./offline.js";
import { ask } from "./agent.js";
import { activeModel, credits, modelCatalog, provider, saveSettings, settingsView, usageReport } from "./llm.js";
import { executeEmail, executeMove } from "./actions.js";
import { EditSchema, executeEdit, undoEdit } from "./editor.js";
import { aiView, estimate as smartEstimate, saveAi, smartApprove, smartControl, smartMaybeStart } from "./ai.js";
import { OCR_DONE, ocrSupported } from "./ocr.js";
import { db } from "./db.js";
import { accessChanged, purgeOutOfScope, refreshIfStale, requestScan, scan, stats, status } from "./scanner.js";
import { drawerList, findFiles, getFile, getPages, labels, searchContent } from "./search.js";

const PORT = Number(process.env.PORT ?? 4477);
const API_KEY = process.env.SLEEPY_API_KEY;
const app = new Hono();
// a dropped client or a bad file must never take the whole API down
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e));

// DNS-rebinding guard: only answer to localhost host headers unless an API key protects the server.
app.use("*", async (c, next) => {
  if (!API_KEY) {
    const host = (c.req.header("host") ?? "").split(":")[0];
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("forbidden", 403);
  }
  await next();
});

const cfg0 = loadConfig();
app.use("/v1/*", cors({
  origin: (origin) => (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || loadConfig().allowedOrigins.includes(origin) ? origin : null),
  allowHeaders: ["Content-Type", "Authorization"],
}));
app.use("/v1/*", async (c, next) => {
  if (API_KEY && c.req.method !== "OPTIONS") {
    const given = c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("key");
    if (given !== API_KEY) return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/v1/health", (c) => c.json({ ok: true, ...stats(), model: activeModel(), platform: process.platform, mode: isOffline() ? "offline" : "online" }));

// ── chat (SSE): status/hits events while working, then one final event ──
app.post("/v1/chat", async (c) => {
  const { message, conversationId, scope } = await c.req.json<{ message: string; conversationId?: string; scope?: { fileId: number; page?: number } }>();
  if (!message?.trim()) return c.json({ error: "message required" }, 400);
  return streamSSE(c, async (stream) => {
    try {
      // serialise writes and flush them all before the stream closes, or the final event gets dropped
      let q: Promise<unknown> = Promise.resolve();
      if (isOffline()) {
        // Offline mode: the same box, answered from the local index only (no AI model is contacted)
        const send = (ev: { type: string; [k: string]: unknown }) => { q = q.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => {}); };
        send({ type: "status", text: "searching your files…", phase: "files" });
        const a = offlineSearch(message.trim(), 12);
        if (scope?.fileId) a.files = a.files.filter((f) => f.file.id === scope.fileId);
        send({ type: "final", answer: a });
        await q;
        return;
      }
      await ask(message.trim(), conversationId, (ev) => {
        q = q.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => {});
      }, scope);
      await q;
    } catch (e) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: (e as Error).message }) }).catch(() => {});
    }
  });
});

// ── raw retrieval, no LLM ──
app.post("/v1/search", async (c) => {
  const { query, kind, folder, limit, mode } = await c.req.json<{ query: string; kind?: string; folder?: string; limit?: number; mode?: "content" | "names" }>();
  return c.json({
    results: mode === "names" ? findFiles({ query, kind, folder, limit }) : searchContent({ query, kind, folder, limit }),
  });
});

// ── files ──
const fileOr404 = (id: number) => {
  const f = getFile(id);
  const cfg = loadConfig();
  if (!f || isSensitive(f.path, cfg) || !cfg.folders.some((r) => underRoot(f.path, r))) return null;
  return f;
};

/** Opening or reading a file is the trigger: if it changed on disk since it was indexed, re-index it right now. */
const freshFile = async (id: number) => {
  const f = fileOr404(id);
  if (f && (await refreshIfStale(f))) return fileOr404(id);
  return f;
};

app.get("/v1/files/:id", async (c) => {
  const f = await freshFile(Number(c.req.param("id")));
  if (!f) return c.json({ error: "not found" }, 404);
  return c.json({ id: f.id, name: f.name, ext: f.ext, kind: f.kind, folder: f.folderTilde, size: f.size, mtime: f.mtime, pages: f.pages, hasText: !!f.has_text });
});

// Open the original file with the OS. PDFs jump to a page by going through a browser's PDF viewer (#page=N);
// Preview/Acrobat have no reliable page argument. ?app=default forces the normal handler (Preview, Word, …).
app.post("/v1/files/:id/open", (c) => {
  const f = fileOr404(Number(c.req.param("id")));
  if (!f) return c.json({ error: "not found" }, 404);
  const page = Math.max(1, Math.floor(Number(c.req.query("page"))) || 1);
  const run = (cmd: string, args: string[]) => spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  let how = "default app";
  if (process.platform === "darwin") {
    const browser = ["/Applications/Google Chrome.app", "/Applications/Safari.app", "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"].find((a) => fs.existsSync(a));
    if (f.kind === "pdf" && page > 1 && browser && c.req.query("app") !== "default") {
      run("open", ["-a", browser, `file://${encodeURI(f.path)}#page=${page}`]);
      how = `${path.basename(browser, ".app")}, page ${page}`;
    } else run("open", [f.path]);
  } else if (process.platform === "win32") {
    if (f.kind === "pdf" && page > 1 && c.req.query("app") !== "default") {
      // Edge ships with Windows and honours #page=N in its PDF viewer
      run("cmd", ["/c", "start", "", "msedge", `file:///${encodeURI(f.path.replace(/\\/g, "/")).replace(/&/g, "%26")}#page=${page}`]);
      how = `Edge, page ${page}`;
    } else run("cmd", ["/c", "start", "", f.path]);
  }
  else run("xdg-open", [f.path]);
  return c.json({ ok: true, how });
});

app.get("/v1/files/:id/pages", async (c) => {
  const f = await freshFile(Number(c.req.param("id")));
  if (!f) return c.json({ error: "not found" }, 404);
  const from = Number(c.req.query("from") ?? 1);
  const to = Number(c.req.query("to") ?? from);
  return c.json({ pages: getPages(f.id, from, Math.min(to, from + 20)) });
});

const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};
app.get("/v1/files/:id/raw", async (c) => {
  const f = await freshFile(Number(c.req.param("id")));
  if (!f) return c.json({ error: "not found" }, 404);
  const type = MIME[f.ext];
  if (!type) return c.json({ error: "no preview for this type" }, 415);
  const st = await fs.promises.stat(f.path).catch(() => null);
  if (!st) return c.json({ error: "file missing" }, 410);
  return new Response(Readable.toWeb(fs.createReadStream(f.path)) as ReadableStream, {
    headers: { "content-type": type, "content-length": String(st.size), "cache-control": "private, no-cache" },
  });
});

app.get("/v1/drawer", (c) => c.json({ labels: drawerList(String(c.req.query("order") ?? "random"), Number(c.req.query("n") ?? 1500)) }));
app.get("/v1/labels", (c) => c.json({ labels: labels(Number(c.req.query("n") ?? 40)) }));

// ── index ──
app.post("/v1/index/scan", async (c) => {
  const body = await c.req.json<{ folders?: string[] }>().catch(() => ({}) as { folders?: string[] });
  if (!status.running) void scan(body.folders);
  return c.json({ started: !status.running, status });
});
app.get("/v1/index/status", (c) => c.json({ status, ...stats() }));

app.get("/v1/config", (c) => c.json(loadConfig()));
app.put("/v1/config", async (c) => {
  const patch = await c.req.json();
  const allowed = ["excludeFolders", "sensitivePatterns", "allowedOrigins"] as const;
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => (allowed as readonly string[]).includes(k)));
  return c.json(saveConfig(clean));
});

// ── model settings + usage ──
app.get("/v1/settings", (c) => c.json(settingsView()));
app.put("/v1/settings", async (c) => {
  try { saveSettings(await c.req.json()); return c.json(settingsView()); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get("/v1/models", async (c) => c.json({ provider: provider(), groups: await modelCatalog() }));

// ── actions Claude proposed; each runs only because the user pressed its confirm button ──
app.post("/v1/actions/move", async (c) => {
  try {
    const { fileId, to } = await c.req.json<{ fileId: number; to: string }>();
    return c.json({ ok: true, ...executeMove(Number(fileId), String(to)) });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 400); }
});
app.post("/v1/actions/email", async (c) => {
  try {
    const b = await c.req.json<{ to: string; subject: string; body: string; fileId?: number | null; attach?: boolean; via?: "send" | "mail" | "mailto" }>();
    const message = await executeEmail({ to: b.to, subject: b.subject, body: b.body, fileId: b.fileId, attach: b.attach }, b.via === "mailto" ? "mailto" : b.via === "mail" ? "mail" : "send");
    return c.json({ ok: true, message });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 400); }
});
app.post("/v1/actions/edit", async (c) => {
  try {
    const { fileId, edits } = await c.req.json<{ fileId: number; edits: unknown }>();
    return c.json({ ok: true, ...(await executeEdit(Number(fileId), EditSchema.array().parse(edits))) });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 400); }
});
app.post("/v1/actions/edit/undo", async (c) => {
  try {
    const { fileId, undo } = await c.req.json<{ fileId: number; undo: string }>();
    return c.json({ ok: true, message: await undoEdit(Number(fileId), String(undo)) });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 400); }
});

app.get("/v1/usage", async (c) => c.json({ ...usageReport(), credits: await credits() }));

// ── folder access: browse the machine's folders and choose which ones Sleepy may read ──
// A ticked folder includes everything beneath it. Browsing is limited to the home folder and mounted volumes.
const HOME = os.homedir();
// always forward slashes on the wire so the UI can split paths the same way on Windows and macOS
const homeRel = (p: string) => (p === HOME ? "~" : p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p).replace(/\\/g, "/");
const insideAllowedArea = (p: string) => {
  let real: string;
  try { real = fs.realpathSync(p); } catch { return false; }
  return real === HOME || real.startsWith(HOME + path.sep) || real.startsWith("/Volumes/");
};
const BROWSE_SKIP = new Set(["Library", "Applications", "node_modules", "venv", "__pycache__", "site-packages", "Pods", "DerivedData",
  "AppData", "Application Data", "Local Settings", "Cookies", "NetHood", "PrintHood", "Recent", "SendTo", "Start Menu", "Templates", "My Documents", "IntelGraphicsProfiles"]);

app.get("/v1/folders", (c) => {
  const cfg = loadConfig();
  const at = c.req.query("path") ? expand(c.req.query("path")!) : HOME;
  if (!path.isAbsolute(at) || !insideAllowedArea(at)) return c.json({ error: "outside the home folder" }, 403);
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && safeIsDir(path.join(dir, d.name)))) && !d.name.startsWith(".") && !BROWSE_SKIP.has(d.name))
        .map((d) => path.join(dir, d.name))
        .filter((p) => !isSensitive(p, cfg) && insideAllowedArea(p))
        .map((p) => ({ name: path.basename(p), path: homeRel(p) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return null; }
  };
  const safeIsDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const folders = list(at);
  if (folders === null) return c.json({ error: "can't read this folder (macOS may need permission)" }, 403);
  // at the top level, put the usual places first and add mounted drives
  if (at === HOME) {
    const first = ["Desktop", "Documents", "Downloads"];
    folders.sort((a, b) => (first.indexOf(a.name) + 1 || 99) - (first.indexOf(b.name) + 1 || 99) || a.name.localeCompare(b.name));
    for (const v of list("/Volumes") ?? []) if (!folders.some((f) => f.path === v.path)) folders.push({ name: `${v.name} (drive)`, path: v.path });
  }
  return c.json({ path: homeRel(at), folders });
});

// "AI access" (widget menu): how much the model may see (1 private … 5 full smart index) and the optional separate key / model for the smart-index pass
app.get("/v1/ai", (c) => c.json(aiView()));
app.put("/v1/ai", async (c) => {
  try {
    const body = await c.req.json<{ level?: number; indexKey?: string; indexModel?: string }>();
    saveAi(body);
    const started = body.level === 5 ? smartMaybeStart() : { started: false, needsConfirm: false };
    return c.json({ ...aiView(), ...started });
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.post("/v1/ai/smart", async (c) => {
  const { action, confirm } = await c.req.json<{ action: "start" | "pause" | "resume" | "cancel"; confirm?: boolean }>();
  if (action === "start") { const r = confirm ? smartApprove() : smartMaybeStart(); return c.json({ ...aiView(), ...r }); }
  smartControl(action);
  return c.json(aiView());
});
app.get("/v1/ai/estimate", (c) => c.json(smartEstimate()));
// "Read text in images" (widget menu): on by default
app.get("/v1/ocr", (c) => { const cfg = loadConfig(); const left = db.prepare("SELECT COUNT(*) n FROM files WHERE kind = 'image' AND ocr < ?").get(OCR_DONE) as { n: number }; return c.json({ on: cfg.ocr !== false, supported: ocrSupported(), imagesLeft: left.n }); });
app.put("/v1/ocr", async (c) => {
  const { on } = await c.req.json<{ on: boolean }>();
  saveConfig({ ocr: !!on });
  if (on) requestScan();
  return c.json({ on: !!on });
});
app.get("/v1/access", (c) => { const a = accessChoice(); return c.json({ folders: a.folders.map(homeRel), fullPc: a.fullPc, fullPcConfirmed: a.fullPcConfirmed }); });
app.put("/v1/access", async (c) => {
  const { folders, fullPc, confirm } = await c.req.json<{ folders: string[]; fullPc?: boolean; confirm?: boolean }>();
  if (!Array.isArray(folders)) return c.json({ error: "folders must be a list" }, 400);
  // Full PC reads every file on the computer: it cannot be switched on by accident or by a stray request; the user has to have accepted the warning
  if (fullPc && !confirm && !accessChoice().fullPcConfirmed) return c.json({ error: "Full PC access needs your confirmation first" }, 400);
  const cfg = loadConfig();
  const abs = [...new Set(folders.map((f) => path.resolve(expand(String(f)))))];
  for (const f of abs) {
    let ok = false;
    try { ok = fs.statSync(f).isDirectory() && insideAllowedArea(f) && !isSensitive(f, cfg); } catch { /* missing */ }
    if (!ok) return c.json({ error: `not allowed: ${homeRel(f)}` }, 400);
  }
  // a ticked folder already includes its subfolders, so drop any that sit under another ticked one
  const top = abs.filter((f) => !abs.some((o) => o !== f && f.startsWith(o + path.sep)));
  saveConfig({ folders: top.map(homeRel), fullPc: !!fullPc, ...(fullPc ? { fullPcConfirmed: true } : {}) });
  accessChanged();                      // a scan already running stops reading the old list
  const dropped = purgeOutOfScope();    // what is no longer shared is gone from the index right now, not when the next scan ends
  requestScan();
  return c.json({ folders: top.map(homeRel), fullPc: !!fullPc, scanning: true, dropped });
});

// ── built UI (production) ──
const DIST = path.join(ROOT, "web", "dist");
if (fs.existsSync(DIST)) {
  app.get("*", (c) => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const file = path.join(DIST, rel);
    const missing = !file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory();
    // a missing asset must 404 (not fall back to the page), or a stale tab gets HTML where it expects a script
    if (missing && path.extname(c.req.path)) return c.text("not found", 404);
    const noCache = { "cache-control": "no-cache" };
    if (missing) return c.html(fs.readFileSync(path.join(DIST, "index.html"), "utf8"), 200, noCache);
    const ext = path.extname(file).slice(1);
    const types: Record<string, string> = { js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml", mjs: "text/javascript", woff2: "font/woff2" };
    // hashed build assets never change; the page itself must always be revalidated so a reload picks up a rebuild
    const cache = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(fs.readFileSync(file), { headers: { "content-type": types[ext] ?? "application/octet-stream", "cache-control": cache } });
  });
}

serve({ fetch: app.fetch, port: PORT, hostname: API_KEY ? "0.0.0.0" : "127.0.0.1" }, () => {
  console.log(`yab api  http://localhost:${PORT}  (${stats().files} files indexed)`);
  if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY) console.log(`chat via ${provider()} · ${activeModel()}`);
  else console.warn("⚠ no OPENROUTER_API_KEY or ANTHROPIC_API_KEY set — search works, chat will fail");
  // incremental re-scan (unchanged files are skipped by size+mtime, so this is cheap)
  // the gap is read each time, so changing it in the settings takes effect from the next cycle
  const tick = () => setTimeout(() => { if (!status.running) void scan(); tick(); }, Math.max(1, loadConfig().scanIntervalMin ?? 15) * 60_000).unref();
  tick();
});
