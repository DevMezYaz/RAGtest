import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chat, getAccess, getFileInfo, getDrawerList, getHealth, getIndexStatus, getLabels, localSearch, startScan, whyFailed, type Answer, type FileHit, type ResultFile } from "./api";
import { Access } from "./Access";
import { ActionCard } from "./ActionCard";
import { createTurn, type Turn } from "./turn";
import { ModelSettings } from "./ModelSettings";
import { Drawer, type DrawerItem } from "./Drawer";
import { Viewer } from "./Viewer";
import { Words } from "./Words";

interface Msg { role: "user" | "sleepy"; text: string; answer?: Answer }

const SUGGEST = ["find my CV", "show my latest PDFs", "what do my notes say about the communication mix?"];
const win = (a: string) => (window as unknown as { sleepy?: { win(a: string): void } }).sleepy?.win(a);
// the pointer went down on a fold button: the app starts preparing the fold so it can happen the instant the click completes
const prefold = () => (window as unknown as { sleepy?: { prefold?(): void } }).sleepy?.prefold?.();
/** Mosby-style open: the plate flies out of its folder tab and tilts up in 3D (no side-to-side swing), the page rises out of it and the heading wipes in. */
function Slot({ target, note, origin, siblings, onSwitch, onClosed, fresh }: {
  fresh: number; target: ResultFile; note?: string; origin: DOMRect | null; siblings: ResultFile[]; onSwitch: (r: ResultFile) => void; onClosed: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const from = useRef("none");
  // "File opening: Portrait" (widget menu): the chosen folder stays where it is as a landscape slab, then turns clockwise into the portrait frame while the paper slides out
  // (see turn.ts for the whole timeline). The setting is read once when the file opens; reduced-motion users get the classic open.
  const portrait = useRef(typeof document !== "undefined" && document.documentElement.classList.contains("open-portrait")
    && !(typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches));
  const turn = useRef<Turn | null>(null);
  const plate = () => ref.current!.querySelector<HTMLElement>(".viewer-plate")!;
  useLayoutEffect(() => {
    const slot = ref.current!;
    if (portrait.current) {
      slot.classList.add("portrait");   // the portrait layout (frame size, tabs on the right) is on before anything is measured
      if (origin) { turn.current = createTurn(slot, plate(), origin); return () => turn.current?.stop(); }
      // switching to a sibling tab: already upright, so just a short rise/fade with the title in place
      const vh = slot.querySelector<HTMLElement>(".vh");
      if (vh) vh.style.opacity = "1";
      plate().animate([{ opacity: 0, transform: "translateY(3vh)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
      return;
    }
    const el = plate();
    const tab = el.querySelector(".viewer-tab")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    ref.current!.querySelector(".viewer-body")?.animate([{ transform: "translateY(80%)" }, { transform: "none" }], { duration: 1100, delay: origin ? 520 : 150, easing: "cubic-bezier(.2,.9,.25,1.05)", fill: "backwards" });
    ref.current!.querySelector(".viewer-head")?.animate({ opacity: [0, 1] }, { duration: 500, delay: origin ? 760 : 250, fill: "backwards" });
    if (!origin) { el.animate([{ opacity: 0, transform: "translateY(5vh)" }, { opacity: 1, transform: "none" }], { duration: 650, easing: "cubic-bezier(.2,.9,.25,1.05)" }); return; }
    el.style.transformOrigin = `${tab.left - box.left}px ${tab.top - box.top}px`;
    from.current = `translate(${origin.left - tab.left}px, ${origin.top - tab.top}px) scale(${Math.max(origin.width / tab.width, 0.2)})`;
    el.animate([
      { transform: from.current, opacity: 0, offset: 0, easing: "cubic-bezier(.5,0,.3,1)" },
      { transform: "rotateX(40deg) translateY(4vh)", opacity: 1, offset: 0.28, easing: "cubic-bezier(.4,.1,.3,1)" },
      { transform: "rotateX(14deg) translateY(-2vh)", offset: 0.56, easing: "cubic-bezier(.3,.1,.2,1)" },
      { transform: "rotateX(3deg)", offset: 0.82, easing: "cubic-bezier(.2,.8,.2,1)" },
      { transform: "none", opacity: 1, offset: 1 },
    ], { duration: 1600, fill: "both" });
  }, []);
  const close = () => {
    const el = ref.current && plate();
    if (closing.current || !el) return;
    closing.current = true;
    if (turn.current) { turn.current.close(onClosed); return; }   // portrait: the same timeline backwards, then the drawer returns
    if (origin) {
      el.animate([{ transform: "none", opacity: 1 }, { transform: "rotateX(16deg)", opacity: 1, offset: 0.3 }, { transform: from.current, opacity: 0 }],
        { duration: 650, easing: "cubic-bezier(.6,0,.3,1)", fill: "forwards" });
      ref.current!.querySelector(".vh")?.animate({ opacity: [1, 0] }, { duration: 300, fill: "forwards" });
    } else el.animate({ opacity: [1, 0] }, { duration: 300, fill: "forwards" });
    setTimeout(onClosed, origin ? 620 : 280);
  };
  return (
    <div className="viewer-slot" ref={ref}>
      <Viewer target={target} note={note} siblings={siblings} onSwitch={onSwitch} onClose={close} fresh={fresh} />
    </div>
  );
}

/** One chat message. Memoised so typing in the dock doesn't re-render (and re-split) every earlier answer. */
// The floating confirm card can fold down to a small tab that stays on screen; it's still mounted so nothing pressed is lost.
let floatFolded = false;
function FloatCard({ label, children }: { label: string; children: React.ReactNode }) {
  const [folded, setFolded] = useState(floatFolded);
  const set = (v: boolean) => { floatFolded = v; setFolded(v); };
  return (
    <div className={`act-float${folded ? " folded" : ""}`}>
      <button className="act-fold" onClick={() => set(!folded)} aria-label={folded ? "show card" : "minimize card"}>{folded ? `▴ ${label}` : "▾ minimize"}</button>
      <div className="act-float-body">{children}</div>
    </div>
  );
}

const MsgView = memo(function MsgView({ m, onOpen, onMoved, onEdited, canSend, floatAction }: { floatAction?: boolean; m: Msg; onOpen: (f: ResultFile, m: Msg, rect: DOMRect) => void; onMoved: () => void; onEdited: (fileId: number) => void; canSend: boolean }) {
  return (
    <div className={`msg ${m.role}`}>
      {m.role === "sleepy" && <span className="who">yab</span>}
      <p>{m.role === "sleepy" ? <Words text={m.text} /> : m.text}</p>
      {m.answer && m.answer.files.length > 0 && (
        <div className="files">
          {m.answer.files.filter((f, k, all) => all.findIndex((g) => g.file.id === f.file.id && g.page === f.page) === k).map((f) => (
            <button key={`${f.file.id}-${f.page}`} className="file-chip" onClick={(e) => onOpen(f, m, e.currentTarget.getBoundingClientRect())}>
              <b>{f.file.name}</b>
              <span>{f.page ? `p.${f.page}` : f.file.kind}</span>
            </button>
          ))}
        </div>
      )}
      {m.answer?.action && (() => {
        const card = <ActionCard action={m.answer.action} onMoved={onMoved} onEdited={onEdited} canSend={canSend} />;
        // the thread is faded out behind an open file, so the card moves (its state is kept) into the window above the chat box
        return floatAction ? createPortal(<FloatCard label={m.answer.action.type === "edit" ? `edit · ${m.answer.action.name}` : m.answer.action.type === "move" ? "move file" : "email draft"}>{card}</FloatCard>, document.querySelector(".window") ?? document.body) : card;
      })()}
    </div>
  );
});

/** Words to read while the model works, matched to what it is doing, so the 3-5 seconds feel purposeful. */
const PHRASES = {
  think: ["thinking it through…", "reading your question…", "deciding where to look…"],
  files: ["opening the drawer…", "flipping through folders…", "skimming the likely pages…", "checking the details…"],
  answer: ["putting it together…", "writing it up…", "polishing the answer…"],
};

const uid = () => Math.random().toString(36).slice(2);

export function App() {
  const [conv] = useState(uid);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [phase, setPhase] = useState<"think" | "files" | "answer">("think"); // what the model is doing right now
  const [tick, setTick] = useState(0);
  const [scopedBusy, setScopedBusy] = useState(false); // the current question is about the open file, so the drawer stays out of it
  const scopedUsed = useRef(false);                   // this open file was chatted about: its close must not replay the drawer
  const [evidence, setEvidence] = useState<ResultFile[]>([]); // extra cited passages from chat inside the open file
  const [access, setAccess] = useState<string[]>([]);
  useEffect(() => {
    // first run (nothing shared yet): go straight to the folder picker
    getAccess().then((f) => { setAccess(f); if (!f.length) setAccessOpen(true); }).catch(() => {});
  }, []);
  const related = useRef(new Map<number, FileHit>()); // every file the searches touched, for the "related" tabs
  const [relatedFiles, setRelatedFiles] = useState<FileHit[]>([]);
  const [status, setStatus] = useState("");
  const [live, setLive] = useState<FileHit[]>([]);
  const [results, setResults] = useState<ResultFile[]>([]);
  const [open, setOpen] = useState<ResultFile | null>(null);
  const lastAnswer = [...msgs].reverse().find((m) => m.role === "sleepy" && m.answer);
  const lastMode = lastAnswer?.answer?.mode;
  const lastText = lastAnswer?.text;
  const [opening, setOpening] = useState(false);
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const [note, setNote] = useState<string | undefined>();
  const [pool, setPool] = useState<DrawerItem[]>([]);
  // "Infinite drawer" (widget menu): the order the home drawer scrolls through its files, or "off"
  const [infinite, setInfiniteMode] = useState(() => document.documentElement.dataset.infinite ?? "off");
  const [feel, setFeel] = useState(() => document.documentElement.dataset.scrollFeel ?? "balanced");
  const [autoScroll, setAutoScroll] = useState(() => document.documentElement.dataset.autoScroll ?? "off");
  useEffect(() => {
    const f = (e: Event) => setFeel((e as CustomEvent<string>).detail), a = (e: Event) => setAutoScroll((e as CustomEvent<string>).detail);
    window.addEventListener("yab-scrollfeel", f); window.addEventListener("yab-autoscroll", a);
    return () => { window.removeEventListener("yab-scrollfeel", f); window.removeEventListener("yab-autoscroll", a); };
  }, []);
  const [dlist, setDlist] = useState<DrawerItem[]>([]);
  useEffect(() => { const h = (e: Event) => setInfiniteMode((e as CustomEvent<string>).detail); window.addEventListener("yab-infinite", h); return () => window.removeEventListener("yab-infinite", h); }, []);
  useEffect(() => {
    if (infinite === "off") { setDlist([]); return; }
    let live = true;
    getDrawerList(infinite).then((l) => { if (live) setDlist(l.map((x) => ({ id: x.id, name: x.name, kind: x.kind }))); }).catch(() => {});
    return () => { live = false; };
  }, [infinite]);
  const [health, setHealth] = useState<{ files: number; searchable: number; platform?: string; mode?: string } | null>(null);
  const [scan, setScan] = useState<{ running: boolean; text: string }>({ running: false, text: "" });
  const threadRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    getLabels(40).then((l) => setPool(l.map((x) => ({ id: x.id, name: x.name, kind: x.kind })))).catch(() => {});
    getHealth().then(setHealth).catch(() => {});
  }, []);
  useEffect(() => { refresh(); const t = setInterval(() => !busy && refresh(), 60_000); return () => clearInterval(t); }, [refresh, busy]);
  useEffect(() => { const t = threadRef.current; if (t) t.scrollTo({ top: t.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  // poll while a scan runs
  useEffect(() => {
    if (!scan.running) return;
    const t = setInterval(async () => {
      const s = await getIndexStatus();
      if (!s.status.running) { setScan({ running: false, text: "" }); refresh(); }
      else setScan({ running: true, text: `${s.status.phase} ${s.status.processed}/${s.status.found}` });
    }, 1000);
    return () => clearInterval(t);
  }, [scan.running, refresh]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput("");
    const scoped = open; // chatting while a file is open keeps it open and searches inside it
    if (scoped) scopedUsed.current = true;
    setScopedBusy(!!scoped);
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    setPhase("think");
    if (!scoped) setOpen(null);
    setLive([]);
    related.current = new Map();
    setStatus("opening the drawer…");
    let failed = "";
    try {
      await chat(text, conv, (ev) => {
        if (ev.type === "status") { setStatus(ev.text); if (ev.phase) setPhase(ev.phase); }
        else if (ev.type === "hits") {
          setLive(ev.files);
          ev.files.forEach((f) => related.current.has(f.id) || related.current.set(f.id, f));
        }
        else if (ev.type === "final") {
          setMsgs((m) => [...m, { role: "sleepy", text: ev.answer.message, answer: ev.answer }]);
          if (scoped) {
            // working inside one file: update the viewer only, leave the drawer's results exactly as they were
            const here = ev.answer.files.find((f) => f.file.id === scoped.file.id);
            setNote(ev.answer.message);
            setEvidence(ev.answer.files.filter((f) => f.file.id === scoped.file.id));
            setOpen(here ?? scoped);
            // closing the file should leave it pinned in the drawer, unless it is already one of the results
            if (!results.some((r) => r.file.id === scoped.file.id)) { setResults([here ?? scoped]); setRelatedFiles([]); }
            return;
          }
          setEvidence([]);
          setResults(ev.answer.files);
          const exact = new Set(ev.answer.files.map((f) => f.file.id));
          setRelatedFiles(ev.answer.files.length ? [...related.current.values()].filter((f) => !exact.has(f.id)) : []);
        } else if (ev.type === "error") failed = ev.message;
      }, undefined, scoped ? { fileId: scoped.file.id } : undefined);
    } catch (e) {
      failed = (e as Error).message;
    }
    try {
      if (failed && scoped) {
        setNote(`I couldn’t answer that just now (${whyFailed(failed)}).`);
      } else if (failed) {
        const answer = await localSearch(text, whyFailed(failed));
        setMsgs((m) => [...m, { role: "sleepy", text: answer.message, answer }]);
        setResults(answer.files);
        setRelatedFiles([]);
      }
    } catch {
      setMsgs((m) => [...m, { role: "sleepy", text: `Couldn’t reach Yab: ${failed}` }]);
    } finally {
      setBusy(false);
      setStatus("");
      setLive([]);
    }
  };

  // the drawer only animates while the model is actually looking through files, not while it answers from its own head
  const working = busy && !scopedBusy;
  const home = msgs.length === 0;
  const wide = msgs.length <= 1; // home and the very first question
  useEffect(() => { setTick(0); }, [phase]);
  useEffect(() => { if (!busy) return; const t = setInterval(() => setTick((x) => x + 1), 1400); return () => clearInterval(t); }, [busy]);
  const specific = phase === "files" && /^(searching|reading|looking|lining)/.test(status) ? [status] : [];
  const phrases = [...specific, ...PHRASES[phase]];
  const phrase = phrases[tick % phrases.length];

  const drawerResults: DrawerItem[] = useMemo(() => {
    if (working) return live.slice(0, wide ? 8 : 5).map((f, i) => ({ id: f.id, name: f.name, kind: f.kind, rank: i + 1 }));
    // one tab per file (an answer can cite several passages of the same file)
    const exact: DrawerItem[] = [];
    for (const r of results) if (exact.length < 4 && !exact.some((e) => e.id === r.file.id)) exact.push({ id: r.file.id, name: r.file.name, kind: r.file.kind, badge: r.page ? `p.${r.page}` : undefined, rank: exact.length + 1 });
    // related = documents the searches touched; skip code/library noise unless the best match is that kind too
    const docish = new Set(["pdf", "doc", "slides", "sheet"]);
    const near = relatedFiles.filter((f) => !exact.some((e) => e.id === f.id) && (docish.has(f.kind) || exact.some((e) => e.kind === f.kind))).slice(0, Math.min(4, 6 - exact.length))
      .map((f, i) => ({ id: f.id, name: f.name, kind: f.kind, related: true, rank: exact.length + i + 1 }));
    // close relatives sit behind; the best match is the front (bottom) folder
    return [...near.reverse(), ...exact.slice(1).reverse(), ...exact.slice(0, 1)];
  }, [working, live, results, relatedFiles]);

  // the drawer is full on the home screen and while searching; afterwards it shrinks to just the results (or away entirely)
  // Home and the very first question: the whole stack, no limits. After that, while working: a short stack (5 folders,
  // or just the files the search is pulling). Done: only the results. A question about one open file never touches it.
  const hits = Math.min(5, live.length);
  const slotsShown = home || (working && wide) ? 9 : working ? (hits || 5) : drawerResults.length;
  const drawerH = slotsShown >= 9 ? 340 : slotsShown ? slotsShown * 31 + 85 : 0;

  // a file was moved: it has a new path (and id after the rescan), so drop anything pointing at the old one
  // an edit was applied (or undone): the open file reloads itself from disk
  const [fresh, setFresh] = useState(0);
  const lastAction = msgs.reduce((n, m, i) => (m.answer?.action ? i : n), -1); // while a file is open its card floats above the chat box
  const onEdited = useCallback((_id: number) => setFresh((n) => n + 1), []);
  const onMoved = useCallback(() => { setOpen(null); setOpening(false); setResults([]); setRelatedFiles([]); setEvidence([]); setScan({ running: true, text: "starting…" }); }, []);

  const openChip = useCallback((f: ResultFile, m: Msg, rect: DOMRect) => {
    scopedUsed.current = false; setEvidence([]);
    setOrigin(rect); setOpening(true); setResults(m.answer!.files); setNote(m.answer!.mode === "answer" ? m.text : undefined); setOpen(f);
  }, []);

  const pick = async (id: number, rect: DOMRect | null = null) => {
    scopedUsed.current = false; setEvidence([]);
    setOrigin(rect);
    setOpening(true);
    const r = results.find((x) => x.file.id === id);
    if (r) {
      setNote(lastMode === "answer" ? lastText : undefined);
      setOpen(r);
      return;
    }
    // idle tab: open the file straight from the drawer
    try {
      const f = await getFileInfo(id);
      setNote(undefined);
      setOpen({ file: f, page: null, quote: null, reason: null });
    } catch { /* file vanished */ }
  };

  const pickRef = useRef(pick);
  pickRef.current = pick;
  const onPick = useCallback((id: number, rect: DOMRect) => void pickRef.current(id, rect), []);

  const isWin = (window as unknown as { sleepy?: { platform?: string } }).sleepy?.platform === "win32";
  const stats = <span className="stats">{health ? `${health.files.toLocaleString()} files · ${health.searchable.toLocaleString()} readable` : "offline"}</span>;
  return (
    <div className="desk">
      <div className="window">
        <div className="titlebar">
          {isWin ? stats : (
            <span className="lights">
              <button aria-label="hide" onPointerDown={prefold} onClick={() => win("hide")} />
              <button aria-label="minimize" onPointerDown={prefold} onClick={() => win("minimize")} />
              <button aria-label="zoom" onClick={() => win("zoom")} />
            </span>
          )}
          <span className="title">yabandeh</span>
          {isWin ? (
            <span className="winctl">
              <button aria-label="minimize" onPointerDown={prefold} onClick={() => win("minimize")}><svg viewBox="0 0 10 10"><path d="M0 5.5h10" /></svg></button>
              <button aria-label="maximize" onClick={() => win("zoom")}><svg viewBox="0 0 10 10"><rect x=".6" y=".6" width="8.8" height="8.8" /></svg></button>
              <button aria-label="close" className="x" onPointerDown={prefold} onClick={() => win("hide")}><svg viewBox="0 0 10 10"><path d="M.5 .5l9 9M9.5 .5l-9 9" /></svg></button>
            </span>
          ) : stats}
        </div>

        <div className={`stage ${open ? "has-open" : ""}`}>
          <div className="thread" ref={threadRef}>
            {msgs.length === 0 && (
              <div className="hello">
                <p className="serif">Ask for a file, or ask what’s inside one.</p>
                <div className="chips">
                  {SUGGEST.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
                </div>
                {access.length === 0 && <p className="muted">Press <b>Access</b> (bottom left) to choose which folders Yab can read.</p>}
                {health && health.files === 0 && access.length > 0 && <p className="muted">Nothing indexed yet — press “scan folders” below.</p>}
              </div>
            )}
            {msgs.map((m, i) => <MsgView key={i} floatAction={!!open && i === lastAction} m={m} onOpen={openChip} onMoved={onMoved} onEdited={onEdited} canSend={health?.platform === "darwin"} />)}
            {busy && <div className="msg sleepy pending"><span className="who">yab</span><p className="muted" key={phrase}>{phrase}<span className="dots" /></p></div>}
          </div>

          <div className="drawer-holder" style={{ "--drawer-h": `${drawerH}px`, opacity: slotsShown ? 1 : 0 } as React.CSSProperties}>
            <Drawer slots={slotsShown} pool={pool} results={drawerResults} busy={working} collapsed={!!open} activeId={open?.file.id ?? null} onPick={onPick} opening={opening} infinite={infinite} list={dlist} feel={feel} autoScroll={autoScroll} paused={accessOpen || modelOpen} />
          </div>

          {open && (
            <Slot
              key={open.file.id} fresh={fresh} target={open} note={note} origin={origin}
              siblings={results.some((r) => r.file.id === open.file.id) ? [...results, ...evidence] : evidence}
              onSwitch={(r) => { scopedUsed.current = false; setEvidence([]); setOrigin(null); setNote(undefined); setOpen(r); }}
              onClosed={() => { setOpen(null); setOpening(false); setScopedBusy(false); }}
            />
          )}
        </div>

        {modelOpen && <ModelSettings onClose={() => setModelOpen(false)} onSaved={() => { setModelOpen(false); getHealth().then(setHealth).catch(() => {}); }} />}
        {accessOpen && (
          <Access
            onClose={() => setAccessOpen(false)}
            onSaved={(f) => { setAccess(f); setAccessOpen(false); setScan({ running: true, text: "starting…" }); setResults([]); setRelatedFiles([]); }}
          />
        )}

        <form className={`dock ${busy ? "busy" : ""} ${working ? "working" : ""}`} onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <span className="pill">yab’s files</span>
          <div className="row">
            <input
              autoFocus value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
              placeholder={busy ? status : health?.mode === "offline" ? (open ? `search inside ${open.file.name}…` : "search your files by name or content (offline)…") : open ? `ask about ${open.file.name}…` : "ask for a file, or ask what's inside one…"}
            />
            <button type="submit" disabled={busy || !input.trim()}>↵</button>
          </div>
          <div className="foot">
            <span className="foot-l">
            <button type="button" className="link" disabled={scan.running} onClick={() => { void startScan(); setScan({ running: true, text: "starting…" }); }}>
              {scan.running ? `scanning · ${scan.text}` : "scan folders"}
            </button>
            <button type="button" className="access-mini" onClick={() => setAccessOpen(true)} title={access.length ? `reading ${access.map((f) => f.split("/").pop()).join(", ")}` : "nothing shared yet"}>Access</button>
            <button type="button" className="access-mini model-mini" onClick={() => setModelOpen(true)} title="choose the model, set limits and key, see usage">Model</button>
            </span>
            <span className="muted">local index · only matching snippets leave this machine</span>
          </div>
        </form>
      </div>
    </div>
  );
}
