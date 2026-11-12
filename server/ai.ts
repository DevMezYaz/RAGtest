// "AI access" (widget menu): how much of the user's files the AI model may see, from 1 (private) to 5 (full smart index), plus the level-5 pass itself:
// a short AI description of every image and a short summary of every document, written once and stored on this computer, so photos and scans with no text become findable.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { HOME_DIR, isOffline, isSensitive, loadConfig, saveConfig } from "./config.js";
import { db } from "./db.js";
import { forgetFileVector } from "./semantic.js";
import { activeModel, client, mask, MODELS, priceOf, provider, recordUsage, type Provider } from "./llm.js";

export const LEVEL_NAMES = ["", "Private", "Balanced", "Informed", "Deep", "Full smart index"];
export const aiLevel = () => Math.min(5, Math.max(1, Math.round(loadConfig().aiLevel ?? 2)));

/** What each level lets the model do in a conversation. `steps` adds to the user's own step setting (default 10). */
export function levelCaps(level = aiLevel()) {
  const base = loadConfig().maxSteps ?? 10;
  switch (level) {
    case 1: return { pages: 0, steps: 4, images: 0, imagesFreely: false };
    case 3: return { pages: 6, steps: Math.min(15, base + 4), images: 1, imagesFreely: false };
    case 4: case 5: return { pages: 20, steps: Math.min(20, base + 10), images: 4, imagesFreely: true };
    default: return { pages: 3, steps: base, images: 0, imagesFreely: false };
  }
}

const IMG_MAX = 5 * 1024 * 1024;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const imageMime = (ext: string) => MIME[ext.toLowerCase().replace(".", "")] ?? null;

/** An image as the model would receive it, or why it can't be sent. Sensitive-looking files never are. */
export function imageForModel(file: { path: string; ext: string; size: number }): { ok: true; media_type: string; data: string } | { ok: false; why: string } {
  const cfg = loadConfig();
  if (isSensitive(file.path, cfg)) return { ok: false, why: "that file looks sensitive and is never sent" };
  const mt = imageMime(file.ext);
  if (!mt) return { ok: false, why: `this image format (${file.ext}) can't be shown to the model` };
  if (file.size > IMG_MAX) return { ok: false, why: "that image is too large to send (over 5 MB)" };
  try { return { ok: true, media_type: mt, data: fs.readFileSync(file.path).toString("base64") }; } catch { return { ok: false, why: "the file couldn't be read" }; }
}

// ── the separate key for the smart index ────────────────────────────────────────────────────────────────────────────────
const ENV_PATH = path.join(HOME_DIR, ".env");
const indexKey = () => process.env.INDEX_API_KEY?.trim() || "";
const keyProvider = (k: string): Provider => (k.startsWith("sk-or-") ? "openrouter" : "anthropic");

export function setIndexKey(key: string) {
  const k = key.trim();
  if (k && (!/^[\w\-]{20,300}$/.test(k) || !(k.startsWith("sk-or-") || k.startsWith("sk-ant-")))) throw new Error("that doesn't look like an OpenRouter (sk-or-…) or Anthropic (sk-ant-…) key");
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const re = /^INDEX_API_KEY=.*\n?/m;
  text = k ? (re.test(text) ? text.replace(re, `INDEX_API_KEY=${k}\n`) : `${text.replace(/\n*$/, "\n")}INDEX_API_KEY=${k}\n`) : text.replace(re, "");
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  if (k) process.env.INDEX_API_KEY = k; else delete process.env.INDEX_API_KEY;
}

/** Who pays for the smart-index pass: its own key if one is set, otherwise the normal one. */
function target(): { c: Anthropic; model: string; prov: Provider; own: boolean } {
  const k = indexKey(), cfg = loadConfig();
  if (!k) return { c: isOffline() ? (null as unknown as Anthropic) : client(), model: activeModel(), prov: provider(), own: false };   // offline: nothing is ever sent, this only prices the estimate
  const prov = keyProvider(k);
  const c = prov === "openrouter"
    ? new Anthropic({ baseURL: "https://openrouter.ai/api", apiKey: k, defaultHeaders: { Authorization: `Bearer ${k}` } })
    : new Anthropic({ apiKey: k });
  const model = cfg.indexModel || (prov === "openrouter" ? "anthropic/claude-haiku-4.5" : MODELS.anthropic[0].id);
  return { c, model, prov, own: true };
}

// ── what the pass would cost ────────────────────────────────────────────────────────────────────────────────────────────
const TOK_IMAGE = 1500, TOK_DOC = 2200, TOK_OUT = 150;
const IMG_SQL = "kind = 'image' AND smart = 0 AND size >= 6000 AND size <= 5242880";
const DOC_SQL = "kind IN ('pdf','doc','slides','sheet','text') AND smart = 0 AND has_text = 1";
export function estimate() {
  const images = (db.prepare(`SELECT COUNT(*) n FROM files WHERE ${IMG_SQL}`).get() as { n: number }).n;
  const docs = (db.prepare(`SELECT COUNT(*) n FROM files WHERE ${DOC_SQL}`).get() as { n: number }).n;
  const inTok = images * TOK_IMAGE + docs * TOK_DOC, outTok = (images + docs) * TOK_OUT;
  const t = target(), price = priceOf(t.model) ?? [1, 5];
  const usd = (inTok * price[0] + outTok * price[1]) / 1e6;
  return { images, docs, tokens: inTok + outTok, usd, model: t.model, ownKey: t.own, priced: !!priceOf(t.model), needsConfirm: inTok + outTok > 1_000_000 };
}

// ── the pass ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const smart = { running: false, paused: false, total: 0, done: 0, current: "", error: "" };
let cancel = false;
const taken = new Set<number>();   // files a worker is busy with, so the three workers never describe the same one twice

const IMG_PROMPT = "Describe this image for a search index in one to three plain sentences. Say what kind of thing it is (for example a bank statement, receipt, chart, chat screenshot, photo of people, product, document scan), and name any visible text, brand, bank, person or place that matters. No preface.";
const DOC_PROMPT = "Summarise this document for a search index: two plain sentences saying what it is and what it is about, then a line starting with 'Key terms:' listing up to eight important names, organisations, products or topics, comma separated. No preface.";

const saveImage = db.transaction((id: number, desc: string) => {
  const f = db.prepare("SELECT keywords FROM files WHERE id = ?").get(id) as { keywords: string } | undefined;
  if (!f) return;
  const old = db.prepare("SELECT text FROM pages WHERE file_id = ? AND page = 1").get(id) as { text: string } | undefined;
  db.prepare("DELETE FROM pages WHERE file_id = ?").run(id);
  const text = `${old?.text?.trim() ? old.text.trim() + "\n\n" : ""}[AI description] ${desc}`;
  db.prepare("INSERT INTO pages (file_id,page,text) VALUES (?,?,?)").run(id, 1, text.slice(0, 20000));
  db.prepare("UPDATE files SET smart = 1, has_text = 1, pages = 1, keywords = ? WHERE id = ?").run(`${f.keywords} ${desc.slice(0, 300)}`.trim().slice(0, 1500), id);
  forgetFileVector(id);
});
const saveDoc = db.transaction((id: number, summary: string) => {
  const f = db.prepare("SELECT keywords FROM files WHERE id = ?").get(id) as { keywords: string } | undefined;
  if (!f) return;
  db.prepare("UPDATE files SET smart = 1, keywords = ? WHERE id = ?").run(`${f.keywords} ${summary}`.trim().slice(0, 1500), id);
  forgetFileVector(id);
});
const markDone = (id: number) => db.prepare("UPDATE files SET smart = 1 WHERE id = ?").run(id);

async function ask(t: ReturnType<typeof target>, content: Anthropic.ContentBlockParam[]): Promise<string> {
  const res = await t.c.messages.create({ model: t.model, max_tokens: 260, messages: [{ role: "user", content }] });
  recordUsage(t.model, res.usage, t.prov);
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").replace(/<(thinking|think|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "").replace(/\s+/g, " ").trim();
}

async function runSmart() {
  if (smart.running) return;
  smart.running = true; smart.error = ""; cancel = false; taken.clear();
  const t = target();
  const e = estimate();
  smart.total = e.images + e.docs; smart.done = 0;
  try {
    const worker = async () => {
      for (;;) {
        while (smart.paused && !cancel) await new Promise((r) => setTimeout(r, 500));
        if (cancel) return;
        // images first (they are what had no text at all), newest first; a file another worker has already taken is skipped
        const img = (db.prepare(`SELECT id, path, ext, size, name FROM files WHERE ${IMG_SQL} ORDER BY mtime DESC LIMIT 8`).all() as { id: number; path: string; ext: string; size: number; name: string }[]).find((r) => !taken.has(r.id));
        const doc = img ? undefined : (db.prepare(`SELECT id, path, name FROM files WHERE ${DOC_SQL} ORDER BY mtime DESC LIMIT 8`).all() as { id: number; path: string; name: string }[]).find((r) => !taken.has(r.id));
        const f = img ?? doc;
        if (!f) return;
        taken.add(f.id);
        smart.current = f.name;
        try {
          if (img) {
            const pic = imageForModel(img);
            if (!pic.ok) markDone(img.id);
            else {
              const d = await ask(t, [{ type: "image", source: { type: "base64", media_type: pic.media_type as "image/png", data: pic.data } }, { type: "text", text: IMG_PROMPT }]);
              d ? saveImage(img.id, d) : markDone(img.id);
            }
          } else if (doc) {
            if (isSensitive(doc.path, loadConfig())) markDone(doc.id);
            else {
              const pages = db.prepare("SELECT text FROM pages WHERE file_id = ? ORDER BY page LIMIT 3").all(doc.id) as { text: string }[];
              const body = pages.map((p) => p.text).join("\n").slice(0, 5000);
              const s = body.trim().length > 40 ? await ask(t, [{ type: "text", text: `${DOC_PROMPT}\n\nFile name: ${doc.name}\n\n${body}` }]) : "";
              s ? saveDoc(doc.id, s) : markDone(doc.id);
            }
          }
          smart.done++; taken.delete(f.id);
        } catch (err) {
          const m = (err as Error).message || "";
          // a refused key, no credit, rate limits: stop and say so; the pass can be resumed later
          taken.delete(f.id);
          if (/401|403|402|429|credit|authent|rate|invalid|overload|ENOTFOUND|fetch failed/i.test(m)) { smart.error = m.slice(0, 160); cancel = true; return; }
          markDone(f.id); smart.done++;   // something wrong with this one file: skip it
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    smart.running = false; smart.current = "";
    if (!smart.error && !cancel) saveConfig({ smartApproved: false });
  }
}

/** Start the pass if level 5 is on and the work is small enough (or the user already approved this big one). Called after every scan and when level 5 is chosen. */
export function smartMaybeStart(): { started: boolean; needsConfirm: boolean } {
  if (isOffline() || aiLevel() !== 5 || smart.running) return { started: false, needsConfirm: false };
  const e = estimate();
  if (!e.images && !e.docs) return { started: false, needsConfirm: false };
  if (e.needsConfirm && !loadConfig().smartApproved) return { started: false, needsConfirm: true };
  smart.paused = false;
  void runSmart();
  return { started: true, needsConfirm: false };
}
export function smartApprove() { saveConfig({ smartApproved: true }); return smartMaybeStart(); }
export function smartControl(action: "pause" | "resume" | "cancel") {
  if (action === "pause") smart.paused = true;
  else if (action === "resume") { smart.paused = false; if (!smart.running) smartMaybeStart(); }
  else { cancel = true; smart.paused = false; }
}

export function aiView() {
  const k = indexKey();
  return {
    mode: isOffline() ? "offline" : "online", level: aiLevel(), levelName: LEVEL_NAMES[aiLevel()], smart: { ...smart }, estimate: estimate(),
    index: { hasKey: !!k, keyMasked: mask(k), model: target().model, provider: k ? keyProvider(k) : provider() },
  };
}

export function saveAi(p: { level?: number; indexKey?: string; indexModel?: string; mode?: "online" | "offline" }) {
  if (p.indexKey !== undefined) setIndexKey(p.indexKey);
  const patch: Record<string, unknown> = {};
  if (p.mode === "online" || p.mode === "offline") { patch.aiMode = p.mode; if (p.mode === "offline") smartControl("cancel"); }
  if (p.level !== undefined) { patch.aiLevel = Math.min(5, Math.max(1, Math.round(p.level))); if (patch.aiLevel !== aiLevel()) patch.smartApproved = false; }
  if (p.indexModel !== undefined) { if (p.indexModel && !/^[\w.\-:/]{3,100}$/.test(p.indexModel)) throw new Error("model id looks wrong"); patch.indexModel = p.indexModel; }
  if (Object.keys(patch).length) saveConfig(patch);
  if (p.level !== undefined && p.level < 5) smartControl("cancel");
}
