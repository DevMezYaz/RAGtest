import { useEffect, useMemo, useState } from "react";
import { getAi, getModels, getSettings, getUsage, saveAi, saveSettings, type AiView, type ModelGroup, type Settings, type Usage } from "./api";

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const price = (m: { prompt: number | null; completion: number | null }) =>
  m.prompt === null ? "" : m.prompt === 0 && m.completion === 0 ? "free" : `$${+m.prompt.toFixed(2)} / $${+(m.completion ?? 0).toFixed(2)}`;

export function ModelSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [u, setU] = useState<Usage | null>(null);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [model, setModel] = useState("");
  const [maxOut, setMaxOut] = useState(0);
  const [steps, setSteps] = useState(0);
  const [sheetMB, setSheetMB] = useState(0);
  const [every, setEvery] = useState(0);
  const [key, setKey] = useState("");
  const [ai, setAi] = useState<AiView | null>(null);
  const [idxKey, setIdxKey] = useState("");
  const [idxModel, setIdxModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    getSettings().then((x) => { setS(x); setModel(x.model); setMaxOut(x.maxOutputTokens); setSteps(x.maxSteps); setSheetMB(x.maxSheetMB); setEvery(x.scanIntervalMin); setOpen({ [x.model.split("/")[0]]: true }); }).catch(() => setErr("couldn’t load settings"));
    getModels().then((m) => setGroups(m.groups)).catch(() => setErr("couldn’t load the model list"));
    getUsage().then(setU).catch(() => {});
    getAi().then((a) => { setAi(a); setIdxModel(a.index.hasKey ? a.index.model : ""); }).catch(() => {});
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => groups.map((g) => ({ ...g, models: needle ? g.models.filter((m) => `${g.provider} ${m.name} ${m.id}`.toLowerCase().includes(needle)) : g.models })).filter((g) => g.models.length),
    [groups, needle],
  );
  const total = groups.reduce((n, g) => n + g.models.length, 0);

  const save = async () => {
    setSaving(true); setErr("");
    try {
      if (idxKey.trim() || (ai?.index.hasKey && idxModel !== ai.index.model)) await saveAi({ ...(idxKey.trim() ? { indexKey: idxKey.trim() } : {}), ...(idxModel.trim() ? { indexModel: idxModel.trim() } : {}) });
      await saveSettings({ model, maxOutputTokens: maxOut, maxSteps: steps, maxSheetMB: sheetMB, scanIntervalMin: every, ...(key.trim() ? { apiKey: key.trim() } : {}) }); onSaved(); }
    catch (e) { setErr((e as Error).message); setSaving(false); }
  };

  const used = u ? u.today.input + u.today.output : 0;
  return (
    <div className="ac-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ac mm" role="dialog" aria-label="Model">
        <header>
          <h2>Model</h2>
          <button className="close" onClick={onClose} aria-label="close">✕</button>
        </header>
        {u && (
          <p className="mm-usage">
            today {fmt(used)} tokens · {u.today.calls} calls{u.today.costKnown ? ` · ${usd(u.today.cost)}` : ""}{u.credits ? ` · ${usd(Math.max(0, u.credits.total - u.credits.used))} credit left` : ""}
          </p>
        )}

        <div className="mm-body">
          <input className="mm-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={total ? `search ${total} models` : "loading models…"} spellCheck={false} />
          <div className="mm-list">
            {shown.map((g) => {
              const isOpen = needle ? true : !!open[g.provider];
              const has = g.models.some((m) => m.id === model);
              return (
                <div key={g.provider} className="mm-group">
                  <button className={`mm-prov ${has ? "has" : ""}`} onClick={() => setOpen((o) => ({ ...o, [g.provider]: !o[g.provider] }))}>
                    <span className="mm-caret">{isOpen ? "▾" : "▸"}</span>
                    <span>{g.provider}</span>
                    <em>{g.models.length}</em>
                  </button>
                  {isOpen && g.models.map((m) => (
                    <label key={m.id} className={`mm-model ${model === m.id ? "on" : ""}`} title={m.id}>
                      <input type="checkbox" checked={model === m.id} onChange={() => setModel(m.id)} />
                      <span>{m.name}</span>
                      <em>{price(m)}</em>
                    </label>
                  ))}
                </div>
              );
            })}
            {!shown.length && total > 0 && <div className="mm-empty">nothing matches “{q}”</div>}
          </div>

          <div className="mm-fields">
            <label><span>reply length <em>tokens · default {s?.defaults.maxOutputTokens}</em></span>
              <input type="number" min={256} max={16000} step={100} value={maxOut || ""} onChange={(e) => setMaxOut(Number(e.target.value))} /></label>
            <label><span>search steps <em>per question · default {s?.defaults.maxSteps}</em></span>
              <input type="number" min={2} max={15} value={steps || ""} onChange={(e) => setSteps(Number(e.target.value))} /></label>
            <label><span>skip spreadsheets over <em>MB · default {s?.defaults.maxSheetMB} · they are the slowest to index (listed by name, not read)</em></span>
              <input type="number" min={1} max={200} value={sheetMB || ""} onChange={(e) => setSheetMB(Number(e.target.value))} /></label>
            <label><span>re-scan every <em>minutes · default {s?.defaults.scanIntervalMin} · unchanged files are skipped, so it is cheap</em></span>
              <input type="number" min={1} max={1440} value={every || ""} onChange={(e) => setEvery(Number(e.target.value))} /></label>
            <label><span>api key <em>{s?.hasKey ? `using ${s.keyMasked}` : "none set"}</em></span>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="paste a new key to replace it" autoComplete="off" spellCheck={false} /></label>
            <label><span>smart-index key <em>optional · {ai?.index.hasKey ? `using ${ai.index.keyMasked}` : "none: the normal key is used"} · only for the “Full smart index” level, so your main key is not spent on it</em></span>
              <input type="password" value={idxKey} onChange={(e) => setIdxKey(e.target.value)} placeholder="an OpenRouter or Anthropic key with its own limit" autoComplete="off" spellCheck={false} /></label>
            {ai?.index.hasKey && <label><span>smart-index model <em>default Claude Haiku</em></span>
              <input type="text" value={idxModel} onChange={(e) => setIdxModel(e.target.value)} spellCheck={false} /></label>}
          </div>
        </div>

        <footer>
          <span className="muted">{model}</span>
          {err && <span className="ac-err">{err}</span>}
          <button onClick={onClose}>cancel</button>
          <button className="go" disabled={saving || !s} onClick={save}>{saving ? "saving…" : "save"}</button>
        </footer>
      </div>
    </div>
  );
}
