import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { HOME_DIR, isOffline, loadConfig, saveConfig } from "./config.js";
import { db } from "./db.js";

export type Provider = "openrouter" | "anthropic";

db.exec(`
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
`);

const ENV_PATH = path.join(HOME_DIR, ".env");
const KEY_VAR: Record<Provider, string> = { openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

export const DEFAULTS = { openrouterModel: "anthropic/claude-haiku-4.5", maxOutputs: { openrouter: 1500, anthropic: 8000 }, maxSteps: 10, maxSheetMB: 10, scanIntervalMin: 15 };

export const MODELS: Record<Provider, { id: string; label: string; note: string; price?: [number, number] }[]> = {
  openrouter: [
    { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", note: "cheapest, fast — good for this", price: [1, 5] },
    { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", note: "smarter, about 3× the cost", price: [3, 15] },
    { id: "anthropic/claude-opus-4.1", label: "Claude Opus 4.1", note: "deepest, about 15× the cost", price: [15, 75] },
  ],
  anthropic: [
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "cheapest, fast" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "balanced" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "deepest" },
  ],
};

const keyFor = (p: Provider) => process.env[KEY_VAR[p]]?.trim() || "";

/** The provider in use: the saved choice if it has a key, otherwise whichever key exists (OpenRouter first). */
export function provider(): Provider {
  const pref = loadConfig().provider;
  if (pref && keyFor(pref)) return pref;
  return keyFor("openrouter") ? "openrouter" : "anthropic";
}

export function activeModel(): string {
  const cfg = loadConfig();
  return provider() === "openrouter" ? cfg.openrouterModel || process.env.OPENROUTER_MODEL || DEFAULTS.openrouterModel : cfg.model;
}

export function limits() {
  const cfg = loadConfig();
  const p = provider();
  return {
    maxOutputTokens: cfg.maxOutputTokens ?? DEFAULTS.maxOutputs[p],
    maxSteps: cfg.maxSteps ?? DEFAULTS.maxSteps,
  };
}

let cached: { sig: string; client: Anthropic } | null = null;
export function client(): Anthropic {
  if (isOffline()) throw new Error("Yab is in Offline mode: no AI model is used");
  const p = provider();
  const key = keyFor(p);
  const sig = `${p}:${key}`;
  if (cached?.sig === sig) return cached.client;
  const c = p === "openrouter"
    ? new Anthropic({ baseURL: "https://openrouter.ai/api", apiKey: key, defaultHeaders: { Authorization: `Bearer ${key}` } })
    : new Anthropic({ apiKey: key || undefined });
  cached = { sig, client: c };
  return c;
}

export const mask = (k: string) => (k ? `${k.slice(0, k.startsWith("sk-or-") ? 6 : 7)}…${k.slice(-4)}` : "");

/** Store a key in .env (so it survives restarts) and in this process. The key itself is never sent back to the UI. */
export function setKey(key: string): Provider {
  const k = key.trim();
  const p: Provider | null = k.startsWith("sk-or-") ? "openrouter" : k.startsWith("sk-ant-") ? "anthropic" : null;
  if (!p || !/^[\w\-]{20,300}$/.test(k)) throw new Error("that doesn't look like an OpenRouter (sk-or-…) or Anthropic (sk-ant-…) key");
  const name = KEY_VAR[p];
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${name}=${k}`;
  text = new RegExp(`^${name}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${name}=.*$`, "m"), line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  process.env[name] = k;
  saveConfig({ provider: p });
  return p;
}

export function recordUsage(model: string, u?: { input_tokens?: number | null; output_tokens?: number | null }, prov?: Provider) {
  if (!u) return;
  db.prepare("INSERT INTO usage(ts, provider, model, input_tokens, output_tokens) VALUES (?,?,?,?,?)")
    .run(Date.now(), prov ?? provider(), model, u.input_tokens ?? 0, u.output_tokens ?? 0);
}

export const priceOf = (model: string): [number, number] | null => {
  for (const list of Object.values(MODELS)) { const m = list.find((x) => x.id === model); if (m?.price) return m.price; }
  return null;
};
const cost = (model: string, i: number, o: number) => { const p = priceOf(model); return p ? (i * p[0] + o * p[1]) / 1e6 : null; };

export function usageReport() {
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day, strftime('%H', ts/1000, 'unixepoch', 'localtime') AS hour,
            model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, COUNT(*) AS n
     FROM usage WHERE ts >= ? GROUP BY day, hour, model`,
  ).all(Date.now() - 15 * 86400_000) as { day: string; hour: string; model: string; i: number; o: number; n: number }[];

  const today = new Date(); const pad = (n: number) => String(n).padStart(2, "0");
  const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = dayKey(today);

  const days = Array.from({ length: 14 }, (_, k) => {
    const d = new Date(today); d.setDate(d.getDate() - (13 - k));
    return { day: dayKey(d), tokens: 0, calls: 0, cost: 0, costKnown: true };
  });
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, tokens: 0 }));
  const byModel = new Map<string, { model: string; tokens: number; calls: number; cost: number | null }>();
  const t = { input: 0, output: 0, calls: 0, cost: 0, costKnown: true };

  for (const r of rows) {
    const c = cost(r.model, r.i, r.o);
    const d = days.find((x) => x.day === r.day);
    if (d) { d.tokens += r.i + r.o; d.calls += r.n; if (c === null) d.costKnown = false; else d.cost += c; }
    if (r.day === todayKey) {
      hours[Number(r.hour)].tokens += r.i + r.o;
      t.input += r.i; t.output += r.o; t.calls += r.n;
      if (c === null) t.costKnown = false; else t.cost += c;
      const m = byModel.get(r.model) ?? { model: r.model, tokens: 0, calls: 0, cost: 0 };
      m.tokens += r.i + r.o; m.calls += r.n; m.cost = c === null || m.cost === null ? null : m.cost + c;
      byModel.set(r.model, m);
    }
  }
  return { today: t, days, hours, byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens) };
}

let creditCache: { at: number; value: { total: number; used: number } | null } = { at: 0, value: null };
export async function credits() {
  if (isOffline()) return null;
  if (provider() !== "openrouter") return null;
  if (Date.now() - creditCache.at < 60_000) return creditCache.value;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${keyFor("openrouter")}` }, signal: AbortSignal.timeout(4000) });
    const j = (await r.json()) as { data?: { total_credits: number; total_usage: number } };
    creditCache = { at: Date.now(), value: j.data ? { total: j.data.total_credits, used: j.data.total_usage } : null };
  } catch { creditCache = { at: Date.now(), value: null }; }
  return creditCache.value;
}

export function settingsView() {
  const p = provider();
  const cfg = loadConfig();
  const k = keyFor(p);
  return {
    provider: p, hasKey: !!k, keyMasked: mask(k),
    otherKey: { openrouter: !!keyFor("openrouter"), anthropic: !!keyFor("anthropic") },
    model: activeModel(), models: MODELS[p],
    maxOutputTokens: limits().maxOutputTokens, maxSteps: limits().maxSteps,
    maxSheetMB: cfg.maxSheetMB ?? DEFAULTS.maxSheetMB, scanIntervalMin: cfg.scanIntervalMin ?? DEFAULTS.scanIntervalMin,
    defaults: { maxOutputTokens: DEFAULTS.maxOutputs[p], maxSteps: DEFAULTS.maxSteps, maxSheetMB: DEFAULTS.maxSheetMB, scanIntervalMin: DEFAULTS.scanIntervalMin },
    chatModelFromConfig: cfg.model,
  };
}

export function saveSettings(p: { model?: string; maxOutputTokens?: number; maxSteps?: number; maxSheetMB?: number; scanIntervalMin?: number; apiKey?: string }) {
  if (p.apiKey) setKey(p.apiKey);
  const patch: Record<string, unknown> = {};
  if (p.model !== undefined) {
    if (!/^[\w.\-:/]{3,100}$/.test(p.model)) throw new Error("model id looks wrong");
    patch[provider() === "openrouter" ? "openrouterModel" : "model"] = p.model;
  }
  if (p.maxOutputTokens !== undefined) patch.maxOutputTokens = Math.max(256, Math.min(16000, Math.round(p.maxOutputTokens)));
  if (p.maxSteps !== undefined) patch.maxSteps = Math.max(2, Math.min(15, Math.round(p.maxSteps)));
  if (p.maxSheetMB !== undefined) patch.maxSheetMB = Math.max(1, Math.min(200, Math.round(p.maxSheetMB)));
  if (p.scanIntervalMin !== undefined) patch.scanIntervalMin = Math.max(1, Math.min(1440, Math.round(p.scanIntervalMin)));
  if (Object.keys(patch).length) saveConfig(patch);
}

export interface ModelGroup { provider: string; models: { id: string; name: string; context: number | null; prompt: number | null; completion: number | null }[] }
let catalogCache: { at: number; groups: ModelGroup[] } | null = null;

/** Every OpenRouter model that can use tools (this app needs them), grouped by provider. Direct-Anthropic keys get Claude only. */
export async function modelCatalog(): Promise<ModelGroup[]> {
  if (isOffline()) return [];
  if (provider() === "anthropic") {
    return [{ provider: "anthropic", models: MODELS.anthropic.map((m) => ({ id: m.id, name: m.label, context: null, prompt: null, completion: null })) }];
  }
  if (catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.groups;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { data: { id: string; name: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }[] };
    const by = new Map<string, ModelGroup>();
    for (const m of j.data) {
      if (!m.supported_parameters?.includes("tools") || m.id.endsWith(":batch")) continue;
      const prov = m.id.split("/")[0].replace(/^~/, "");
      const per = (v?: string) => (v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 1e8) / 100);
      (by.get(prov) ?? by.set(prov, { provider: prov, models: [] }).get(prov)!).models.push({
        id: m.id, name: m.name.replace(/^[^:]+:\s*/, ""), context: m.context_length ?? null, prompt: per(m.pricing?.prompt), completion: per(m.pricing?.completion),
      });
    }
    const groups = [...by.values()].map((g) => ({ ...g, models: g.models.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => (a.provider === "anthropic" ? -1 : b.provider === "anthropic" ? 1 : a.provider.localeCompare(b.provider)));
    if (groups.length) catalogCache = { at: Date.now(), groups };
    return groups;
  } catch {
    return catalogCache?.groups ?? [{ provider: "anthropic", models: MODELS.openrouter.map((m) => ({ id: m.id, name: m.label, context: null, prompt: m.price?.[0] ?? null, completion: m.price?.[1] ?? null })) }];
  }
}
