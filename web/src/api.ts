export interface FileHit {
  id: number; name: string; folder: string; kind: string; pages: number; mtime: number; size: number; hasText: boolean;
}
export interface ResultFile { file: FileHit; page: number | null; quote: string | null; reason: string | null }
export interface EditOp { op: string; [k: string]: unknown }
export type Action =
  | { type: "edit"; fileId: number; name: string; ext: string; edits: EditOp[]; lines: string[]; note: string | null }
  | { type: "move"; fileId: number; name: string; from: string; to: string }
  | { type: "email"; fileId: number | null; name: string | null; to: string; subject: string; body: string; attach: boolean };
export interface Answer { mode: "answer" | "files" | "none"; message: string; files: ResultFile[]; action?: Action }
export type AgentEvent =
  | { type: "status"; text: string; phase?: "think" | "files" | "answer" }
  | { type: "hits"; files: FileHit[] }
  | { type: "final"; answer: Answer }
  | { type: "error"; message: string };

// Point at another origin (and add a key) when embedding Sleepy in a different app.
const BASE = (import.meta.env.VITE_SLEEPY_URL as string | undefined) ?? "";
export const rawUrl = (id: number, ver?: number) => `${BASE}/v1/files/${id}/raw${ver ? `?v=${ver}` : ""}`;

export async function chat(message: string, conversationId: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, scope?: { fileId: number; page?: number }) {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, conversationId, scope }), signal,
  });
  if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

const j = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(BASE + url, init);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
};
export const getLabels = (n = 40) => j<{ labels: { id: number; name: string; kind: string }[] }>(`/v1/labels?n=${n}`).then((r) => r.labels);
export const getDrawerList = (order: string, n = 4000) => j<{ labels: { id: number; name: string; kind: string }[] }>(`/v1/drawer?order=${encodeURIComponent(order)}&n=${n}`).then((r) => r.labels);
export const getPages = (id: number, from: number, to = from) => j<{ pages: { page: number; text: string }[] }>(`/v1/files/${id}/pages?from=${from}&to=${to}`).then((r) => r.pages);
export const getFileInfo = (id: number) => j<FileHit & { ext: string }>(`/v1/files/${id}`);
export const getHealth = () => j<{ files: number; searchable: number; pages: number; platform?: string; mode?: string }>("/v1/health");
export const getIndexStatus = () => j<{ status: { running: boolean; phase: string; processed: number; found: number; current: string }; files: number }>("/v1/index/status");
export const startScan = () => j("/v1/index/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

/** Keyword-only fallback (no Claude): used when the chat endpoint is unavailable. */
export async function localSearch(query: string, reason = ""): Promise<Answer> {
  const post = (mode: "content" | "names") =>
    j<{ results: (FileHit & { matches?: { page: number; snippet: string }[] })[] }>("/v1/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, mode, limit: 6 }),
    }).then((r) => r.results);
  const [content, names] = await Promise.all([post("content"), post("names")]);
  const seen = new Set<number>();
  const files: ResultFile[] = [];
  // file-name matches first: "find my resume" should surface files called resume, not pages that happen to say "find"
  for (const r of [...names, ...content]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    files.push({ file: r, page: r.matches?.[0]?.page ?? null, quote: null, reason: null });
  }
  return {
    mode: "files",
    message: files.length ? `${reason ? `The model didn’t answer (${reason}), so` : "These are"} plain keyword matches, file names first.${reason ? " You can pick another model under Model." : ""}` : `Nothing matched those words${reason ? ` — and the model didn’t answer (${reason})` : ""}.`,
    files: files.slice(0, 8),
  };
}

export const openOriginal = (id: number, page?: number, useDefault = false) =>
  j<{ ok: boolean; how: string }>(`/v1/files/${id}/open?page=${page ?? 1}${useDefault ? "&app=default" : ""}`, { method: "POST" });

export interface FolderNode { name: string; path: string }
export const listFolders = (path?: string) => j<{ path: string; folders: FolderNode[] }>(`/v1/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`).then((r) => r.folders);
export const getAccessFull = () => j<{ folders: string[]; fullPc: boolean; fullPcConfirmed?: boolean }>("/v1/access");
/** The folders the user ticked; "Full PC" stands in for the whole computer. */
export const getAccess = () => getAccessFull().then((r) => (r.fullPc ? ["Full PC", ...r.folders] : r.folders));
export const saveAccess = (folders: string[], fullPc = false, confirm = false) =>
  j<{ folders: string[]; fullPc: boolean }>("/v1/access", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folders, fullPc, confirm }) });

export interface Settings {
  provider: "openrouter" | "anthropic"; hasKey: boolean; keyMasked: string; model: string;
  models: { id: string; label: string; note: string; price?: [number, number] }[];
  maxOutputTokens: number; maxSteps: number; maxSheetMB: number; scanIntervalMin: number; defaults: { maxOutputTokens: number; maxSteps: number; maxSheetMB: number; scanIntervalMin: number };
}
export interface Usage {
  today: { input: number; output: number; calls: number; cost: number; costKnown: boolean };
  days: { day: string; tokens: number; calls: number; cost: number; costKnown: boolean }[];
  hours: { hour: number; tokens: number }[];
  byModel: { model: string; tokens: number; calls: number; cost: number | null }[];
  credits: { total: number; used: number } | null;
}
export const getSettings = () => j<Settings>("/v1/settings");
export const getUsage = () => j<Usage>("/v1/usage");
export const saveSettings = (p: { model?: string; maxOutputTokens?: number; maxSteps?: number; maxSheetMB?: number; scanIntervalMin?: number; apiKey?: string }) =>
  fetch(BASE + "/v1/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })
    .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`); return d as Settings; });

export interface ModelGroup { provider: string; models: { id: string; name: string; context: number | null; prompt: number | null; completion: number | null }[] }
export const getModels = () => j<{ provider: string; groups: ModelGroup[] }>("/v1/models");

const post = async <T,>(url: string, body: unknown): Promise<T> => {
  const r = await fetch(BASE + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok || d.ok === false) throw new Error(d.error ?? `failed (${r.status})`);
  return d as T;
};
export const doEdit = (fileId: number, edits: EditOp[]) => post<{ undo: string; message: string }>("/v1/actions/edit", { fileId, edits });
export const undoEdit = (fileId: number, undo: string) => post<{ message: string }>("/v1/actions/edit/undo", { fileId, undo });
export const doMove = (fileId: number, to: string) => post<{ to: string }>("/v1/actions/move", { fileId, to });
export const doEmail = (a: { to: string; subject: string; body: string; fileId: number | null; attach: boolean; via: "send" | "mail" | "mailto" }) =>
  post<{ message: string }>("/v1/actions/email", a);

/** A short, honest reason for a failed model call (instead of blaming one particular vendor). */
export const whyFailed = (m: string) =>
  /401|authenticat|api key|apiKey|x-api-key/i.test(m) ? "the API key was rejected or is missing"
  : /402|credit|insufficient/i.test(m) ? "out of credits"
  : /429|rate.?limit/i.test(m) ? "the model is rate-limited right now"
  : /404|not_found|no endpoints|deprecated/i.test(m) ? "that model isn’t available"
  : /Failed to fetch|NetworkError|ECONN/i.test(m) ? "can’t reach the Yab server"
  : m.replace(/^\d{3}\s*/, "").replace(/[{}"]/g, "").slice(0, 90);

export interface AiView {
  level: number; levelName: string;
  smart: { running: boolean; paused: boolean; total: number; done: number; current: string; error: string };
  estimate: { images: number; docs: number; tokens: number; usd: number; model: string; ownKey: boolean; priced: boolean; needsConfirm: boolean };
  index: { hasKey: boolean; keyMasked: string; model: string; provider: string };
}
export const getAi = () => j<AiView>("/v1/ai");
export const saveAi = (p: { level?: number; indexKey?: string; indexModel?: string }) =>
  fetch(BASE + "/v1/ai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })
    .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? `save failed (${r.status})`); return d as AiView; });
