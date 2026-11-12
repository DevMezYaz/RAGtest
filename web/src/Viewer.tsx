import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { Words } from "./Words";
import { fileColor, fileInk, kindColor } from "./colors";
import { getFileInfo, getPages, openOriginal, rawUrl, type FileHit, type ResultFile } from "./api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Find the longest run of the quote that occurs in `full`; returns [start,end) in `full` or null. */
function locate(full: string, quote: string): [number, number] | null {
  const q = norm(quote);
  if (!q) return null;
  const direct = full.indexOf(q);
  if (direct >= 0) return [direct, direct + q.length];
  const words = q.split(" ");
  for (const size of [14, 10, 7, 5, 4, 3]) {
    if (words.length < size) continue;
    for (let i = 0; i + size <= words.length; i++) {
      const part = words.slice(i, i + size).join(" ");
      const at = full.indexOf(part);
      if (at >= 0) return [at, at + part.length];
    }
  }
  return null;
}

/** Centre `el` inside its own scroll box. (scrollIntoView also scrolls every ancestor and shoves the whole window off-screen.) */
function centreIn(el: HTMLElement | null) {
  const box = el?.closest<HTMLElement>(".viewer-body");
  if (!el || !box) return;
  const e = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  box.scrollTo({ top: Math.max(0, box.scrollTop + (e.top - b.top) - box.clientHeight / 2 + e.height / 2), behavior: "smooth" });
}

/** Marks every text-layer fragment that belongs to any of the quotes. Returns the first one in reading order. */
function highlightSpans(divs: HTMLElement[], quotes: string[]): HTMLElement | null {
  divs.forEach((d) => d.classList.remove("hl"));
  if (!quotes.length) return null;
  const texts = divs.map((d) => norm(d.textContent ?? ""));
  let full = "";
  const ranges: [number, number][] = [];
  texts.forEach((n) => { ranges.push([full.length, full.length + n.length]); full += n + " "; });
  const hit = new Set<number>();
  for (const quote of quotes) {
    const q = " " + norm(quote) + " ";
    // table cells come out of the PDF in odd orders, so match each fragment on its own first…
    let direct = 0;
    texts.forEach((n, i) => { if (n.length >= 4 && q.includes(" " + n + " ")) { hit.add(i); direct++; } });
    // …and fall back to the longest contiguous run when fragments are split mid-phrase
    const run = direct ? null : locate(full, quote);
    if (run) ranges.forEach(([x, y], i) => { if (y > x && x < run[1] && y > run[0] && (texts[i].length >= 4 || q.includes(" " + texts[i] + " "))) hit.add(i); });
  }
  let first: HTMLElement | null = null;
  [...hit].sort((x, y) => x - y).forEach((i) => { divs[i].classList.add("hl"); first ??= divs[i]; });
  return first;
}

function PdfView({ id, ver, page, quotes, dir, onLoaded, maxW = 920 }: { id: number; ver: number; page: number; quotes: string[]; dir: string; onLoaded: (n: number) => void; maxW?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  const [err, setErr] = useState("");
  const quotesKey = quotes.join("\u0001");

  useEffect(() => {
    setDoc(null);
    setErr("");
    const task = pdfjs.getDocument({ url: rawUrl(id, ver) });
    task.promise.then((d) => { setDoc(d); onLoaded(d.numPages); }, (e) => setErr(String(e?.message ?? e)));
    return () => { void task.destroy(); };
  }, [id, ver]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !width || page < 1 || page > doc.numPages) return;
    let dead = false;
    let render: pdfjs.RenderTask | null = null;
    let tl: pdfjs.TextLayer | null = null;
    (async () => {
      try {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min(width - 2, maxW) / base.width;
      const viewport = p.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current!, tb = textBox.current!;
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      c.style.width = `${viewport.width}px`;
      c.style.height = `${viewport.height}px`;
      tb.replaceChildren();
      tb.style.width = `${viewport.width}px`;
      tb.style.height = `${viewport.height}px`;
      tb.style.setProperty("--total-scale-factor", String(scale));
      tb.style.setProperty("--scale-factor", String(scale));
      render = p.render({ canvas: c, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      tl = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: tb, viewport });
      try {
        await Promise.all([render.promise, tl.render()]);
      } catch { return; }
      if (dead) return;
      const first = highlightSpans(tl.textDivs, quotes);
      centreIn(first);
      } catch { /* cancelled or raced by a newer render */ }
    })();
    return () => { dead = true; render?.cancel(); tl?.cancel(); };
  }, [doc, page, width, quotesKey, maxW]);

  return (
    <div className="pdf-wrap" ref={wrap}>
      {err && <div className="empty">couldn’t open this PDF — {err}</div>}
      <div className={`pdf-page turn-${dir}`} key={page}>
        <canvas ref={canvas} />
        <div className="textLayer" ref={textBox} />
      </div>
    </div>
  );
}

function TextView({ id, ver, page, quotes, kind, dir }: { id: number; ver: number; page: number; quotes: string[]; kind: string; dir: string }) {
  const [text, setText] = useState<string | null>(null);
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let dead = false;
    setText(null);
    getPages(id, page).then((p) => !dead && setText(p[0]?.text ?? ""));
    return () => { dead = true; };
  }, [id, page, ver]);
  useEffect(() => { if (text) centreIn(markRef.current); }, [text, quotes.join("\u0001")]);

  const parts = (() => {
    if (!text) return null;
    const spans: [number, number][] = [];
    for (const quote of quotes) {
      const words = norm(quote).split(" ").filter(Boolean);
      search: for (const size of [words.length, 14, 10, 7, 5, 4, 3]) {
        if (words.length < size) continue;
        for (let i = 0; i + size <= words.length; i++) {
          const esc = words.slice(i, i + size).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          const m = new RegExp(`(${esc.join("[^\\p{L}\\p{N}]+")})`, "iu").exec(text);
          if (m) { spans.push([m.index, m.index + m[1].length]); break search; }
        }
      }
    }
    if (!spans.length) return [text];
    spans.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]);
    }
    const out: React.ReactNode[] = [];
    let at = 0;
    merged.forEach(([x, y], k) => {
      out.push(text.slice(at, x), <mark key={k} ref={k === 0 ? markRef : undefined} className="hl">{text.slice(x, y)}</mark>);
      at = y;
    });
    out.push(text.slice(at));
    return out;
  })();

  return (
    <div className="text-wrap">
      <article key={page} className={`paper turn-${dir} ${kind === "sheet" || kind === "text" ? "mono" : ""}`}>{parts ?? <span className="muted">…</span>}</article>
    </div>
  );
}

export { kindColor };

interface ViewerProps {
  fresh?: number; // bumped when Sleepy itself edited the file
  target: ResultFile;
  note?: string;
  siblings?: ResultFile[];
  onSwitch?: (r: ResultFile) => void;
  onClose: () => void;
}

export function Viewer({ target, note, siblings = [], onSwitch, onClose, fresh = 0 }: ViewerProps) {
  const root = useRef<HTMLElement>(null);
  const [noteOpen, setNoteOpen] = useState(true);
  // The note always sits in one of three places: the top-left corner (small, floating), a banner on top, or a banner at the bottom.
  type Dock = "corner" | "top" | "bottom";
  const [dock, setDock] = useState<Dock>(() => { try { const v = localStorage.getItem("sleepy.noteDock"); return v === "top" || v === "bottom" ? v : "corner"; } catch { return "corner"; } });
  const [dragZone, setDragZone] = useState<Dock | null>(null); // the zone under the pointer while dragging
  const noteRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const flip = useRef<DOMRect | null>(null);
  const [full, setFull] = useState(false); // pop-out reader, like a Drive preview
  const bodyRef = useRef<HTMLDivElement>(null);
  const f: FileHit = target.file;
  const [ext, setExt] = useState("");
  const [total, setTotal] = useState(f.pages);
  const [ver, setVer] = useState(f.mtime); // the file's modified time as last shown; a newer one means it was edited
  const verRef = useRef(ver);
  verRef.current = ver;
  const [page, setPage] = useState(target.page ?? 1);
  // every relevant passage on this page, from this answer and its siblings
  const quotes = [...new Set([target, ...siblings.filter((r) => r.file.id === f.id)]
    .filter((r) => r.quote && r.page === page).map((r) => r.quote as string))];
  const last = useRef(page);
  const dir = page >= last.current ? "next" : "prev";
  useEffect(() => { last.current = page; }, [page]);

  useEffect(() => { setPage(target.page ?? 1); setTotal(f.pages); }, [f.id, target.page, target.quote]);
  useEffect(() => setNoteOpen(true), [note]);

  const zoneAt = (x: number, y: number): Dock => {
    const r = paperRef.current!.getBoundingClientRect();
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    return fy > 0.55 ? "bottom" : fx < 0.4 ? "corner" : "top";
  };
  const slide = (el: HTMLElement, from: DOMRect) => {
    const to = el.getBoundingClientRect();
    el.animate({ translate: [`${from.left - to.left}px ${from.top - to.top}px`, "0 0"] }, { duration: 420, easing: "cubic-bezier(.2,.9,.25,1.05)" });
  };
  const startDrag = (e: React.PointerEvent) => {
    const el = noteRef.current;
    if (!el) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    setDragZone(dock);
    const move = (ev: PointerEvent) => { el.style.translate = `${ev.clientX - sx}px ${ev.clientY - sy}px`; setDragZone(zoneAt(ev.clientX, ev.clientY)); };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const target = zoneAt(ev.clientX, ev.clientY);
      const from = el.getBoundingClientRect();
      el.style.translate = "";
      setDragZone(null);
      if (target === dock) slide(el, from);          // dropped back where it was: glide home
      else { flip.current = from; try { localStorage.setItem("sleepy.noteDock", target); } catch { /* ignore */ } setDock(target); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // after the dock changes, glide from where it was dropped into its new place
  useLayoutEffect(() => {
    const from = flip.current, el = noteRef.current;
    if (!from || !el) return;
    flip.current = null;
    slide(el, from);
  }, [dock]);
  // Freshness is event-driven: opening the file, coming back to this window (after editing it in Word/Preview/Excel), or an edit
  // made from chat. The server re-reads a changed file on this call; the page below then reloads it.
  useEffect(() => {
    const check = () => getFileInfo(f.id).then((i) => {
      setExt(i.ext);
      if (i.mtime !== verRef.current) { setVer(i.mtime); setTotal(i.pages); setPage((p) => Math.min(p, Math.max(1, i.pages))); }
    }).catch(() => {});
    check();
    const onVisible = () => { if (!document.hidden) check(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", onVisible); };
  }, [f.id, fresh]);

  const go = useCallback((n: number) => setPage((p) => Math.max(1, Math.min(total || 1, n === 0 ? p : n))), [total]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight") go(page + 1);
      if (e.key === "ArrowLeft") go(page - 1);
      if (e.key === "Escape") (full ? setFull(false) : onClose());
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [page, go, onClose, full]);

  const isImage = f.kind === "image" && ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
  const unit = f.kind === "slides" ? "slide" : f.kind === "sheet" ? "sheet" : f.kind === "pdf" ? "page" : "part";
  const showNav = f.kind === "pdf" || (f.hasText && total > 0);

  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); root.current?.style.setProperty("--p", "0"); }, [page, f.id]);
  const color = fileColor(f.id);
  const title = f.name.replace(/\.[a-z0-9]+$/i, "");
  const shown = title.length > 40 ? title.slice(0, 39) + "…" : title;
  const others = siblings.filter((r) => r.file.id !== f.id).slice(0, 5);

  const doc = (maxW: number) =>
    f.kind === "pdf" ? (
      <PdfView id={f.id} ver={ver} page={page} quotes={quotes} dir={dir} onLoaded={(n) => setTotal(n)} maxW={maxW} />
    ) : isImage ? (
      <div className="img-wrap"><img src={rawUrl(f.id, ver)} alt={f.name} /></div>
    ) : f.hasText ? (
      <TextView id={f.id} ver={ver} page={page} quotes={quotes} kind={f.kind} dir={dir} />
    ) : (
      <div className="empty">
        <p>No in-app preview for this {f.kind === "other" ? "file type" : "file"}.</p>
        <p className="muted">{f.folder}/{f.name}</p>
      </div>
    );
  const pager = showNav && (
    <span className="pager">
      <button onClick={() => go(page - 1)} disabled={page <= 1} aria-label="previous">‹</button>
      <span>{unit} <input value={page} onChange={(e) => go(Number(e.target.value) || page)} size={3} /> / {total || "–"}</span>
      <button onClick={() => go(page + 1)} disabled={page >= total} aria-label="next">›</button>
    </span>
  );
  const popOut = () => { window.getSelection()?.removeAllRanges(); setFull(true); };
  const windowEl = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".window") ?? document.body : null;

  return (
    <section className="viewer" ref={root} style={{ "--fc": color, "--n": shown.length, "--p": 0 } as React.CSSProperties}>
      <h2 className="vh" title={f.name}>
        {[...shown].map((ch, k) => <span className="vl" key={k} style={{ "--k": k } as React.CSSProperties}>{ch === " " ? "\u00a0" : ch}</span>)}
      </h2>
      <div className="viewer-plate">
        <div className="viewer-tab">
          <svg width="100%" height="26" preserveAspectRatio="none" viewBox="0 0 300 26" aria-hidden>
            <path d="M0,26 C12,26 12,0 24,0 H276 C288,0 288,26 300,26 V28 H0 Z" style={{ fill: "var(--fc)" }} />
          </svg>
          <div className="viewer-tab-text" style={{ color: fileInk(f.id) }}>
            <span className="num">{String(f.id % 1000).padStart(3, "0")}</span>
            <span className="kp">{f.kind}{f.pages ? ` · ${f.pages} ${f.kind === "pdf" ? "pp" : "parts"}` : ""}</span>
            <span className="tt">{shown}</span>
          </div>
        </div>
        <div className="viewer-card">
          <div className="vpaper" ref={paperRef}>
            <header className="viewer-head">
              <button
                className="path" title={`Open the original${f.kind === "pdf" ? ` at page ${page}` : ""} (⇧-click: default app)`}
                onClick={(e) => { void openOriginal(f.id, page, e.shiftKey).catch(() => {}); }}
              >{f.folder}/{f.name} ↗</button>
              {pager}
              <button className="close" onClick={onClose} aria-label="close">close ✕</button>
            </header>
            {note && (<>
              <div className={`note-corner ${noteOpen ? "" : "folded"}`}>
                <button className="note-fold" onClick={() => setNoteOpen(true)} aria-label="unfold the note" title="unfold the note" tabIndex={noteOpen ? -1 : 0} />
              </div>
              <div className={`note-slot dock-${dock} ${noteOpen ? "" : "folded"} ${dragZone ? "dragging" : ""}`}>
                <div className="note-wrap">
                  <div className="note" ref={noteRef} onDoubleClick={(e) => { e.stopPropagation(); setNoteOpen(false); }} title="double-click to fold into the corner">
                    <div className="note-grip" onPointerDown={startDrag} title="drag to the corner, the top or the bottom"><i /><i /><i /></div>
                    <b>yab</b> <Words key={note} text={note} step={22} />
                    {target.page && page !== target.page && <button className="link" onClick={() => setPage(target.page!)}>→ back to p.{target.page}</button>}
                  </div>
                </div>
              </div>
              {dragZone && (
                <div className="note-zones" aria-hidden>
                  <div className={`z corner ${dragZone === "corner" ? "on" : ""}`}>corner</div>
                  <div className={`z top ${dragZone === "top" ? "on" : ""}`}>top</div>
                  <div className={`z bottom ${dragZone === "bottom" ? "on" : ""}`}>bottom</div>
                </div>
              )}
            </>)}
            <div
              className="viewer-body" ref={bodyRef} onDoubleClick={popOut}
              onScroll={(e) => root.current?.style.setProperty("--p", String(Math.min(e.currentTarget.scrollTop / 150, 1)))}
            >
              {!full && doc(920)}
            </div>
          </div>
          <nav className="vtabs">
            <div className="vt cur" style={{ "--ci": fileInk(f.id) } as React.CSSProperties} title={f.name}><span className="k">{f.kind}</span><span className="tt">{shown}</span></div>
            {others.map((r) => (
              <button key={r.file.id} className="vt" style={{ "--tc": fileColor(r.file.id), color: fileInk(r.file.id) } as React.CSSProperties} onClick={() => onSwitch?.(r)} title={r.file.name}>
                {r.file.name.replace(/\.[a-z0-9]+$/i, "")}
              </button>
            ))}
          </nav>
        </div>
      </div>
      {full && windowEl && createPortal(
        <div className="fv" onMouseDown={(e) => e.target === e.currentTarget && setFull(false)}>
          <header className="fv-bar">
            <span className="fv-name" title={f.name}>{f.name}</span>
            {pager}
            <button className="fv-btn" onClick={(e) => { void openOriginal(f.id, page, e.shiftKey).catch(() => {}); }} title="Open the original file (⇧-click: default app)">open original ↗</button>
            <button className="fv-btn" onClick={() => setFull(false)} aria-label="close full view">✕</button>
          </header>
          <div className="viewer-body fv-body">{doc(1400)}</div>
        </div>,
        windowEl,
      )}
    </section>
  );
}
