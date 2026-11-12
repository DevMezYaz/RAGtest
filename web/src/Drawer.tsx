import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { fileColor, fileInk } from "./colors";

export interface DrawerItem {
  id: number;
  name: string;
  kind?: string;
  badge?: string; // e.g. "p.4"
  related?: boolean; // a close match rather than the exact answer
  rank?: number; // 1 = best match
}
interface Props {
  pool: DrawerItem[]; // names that cycle on idle tabs
  results: DrawerItem[]; // when present they pull forward into the front slots
  busy: boolean;
  collapsed: boolean;
  activeId: number | null;
  onPick: (id: number, tabRect: DOMRect) => void;
  opening: boolean; // a file is flying out: folders drop away, then rise back
  slots?: number; // how many folders are on show (the front ones); the rest are not rendered at all
  infinite?: string; // "off", or the order the home drawer scrolls through its files (the widget menu)
  list?: DrawerItem[]; // the files in that order
  feel?: string; // how heavy the scrolling feels (the widget menu)
  autoScroll?: string; // "off", or how fast the home screen scrolls by itself
  paused?: boolean; // a panel (Access, Model) is open on top of the drawer: it must not take the scrolling
}

const SLOTS = 9;
// "Scroll feel" (widget menu): the spring behind the infinite drawer (K stiffness, C damping), how many wheel pixels move one folder, and how long it waits before settling
const FEEL: Record<string, { K: number; C: number; px: number; idle: number }> = {
  snappy: { K: 420, C: 38, px: 30, idle: 110 },
  crisp: { K: 320, C: 30, px: 34, idle: 130 },
  balanced: { K: 240, C: 25, px: 36, idle: 150 },
  floaty: { K: 110, C: 14, px: 40, idle: 220 },
  glide: { K: 60, C: 10, px: 44, idle: 300 },
  drift: { K: 30, C: 7, px: 50, idle: 420 },
  slow: { K: 14, C: 5, px: 56, idle: 560 },
};
// "Auto scroll": folders per second
const AUTO: Record<string, number> = { off: 0, vslow: 0.15, slow: 0.35, medium: 0.7, fast: 1.4, vfast: 2.6 };
const TAB_W = 210;
const SHOULDER = 18;
const TAB_H = 22;
const STEP = 31;
const pad = (n: number) => String(n % 1000).padStart(3, "0");
const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const bare = (s: string, n: number) => short(s.replace(/\.[a-z0-9]+$/i, ""), n);

/** Cross-fades between the previous and the current label. */
function Label({ text, instant }: { text: string; instant?: boolean }) {
  const [state, setState] = useState({ cur: text, prev: "" });
  useEffect(() => {
    setState((s) => (s.cur === text ? s : { cur: text, prev: instant ? "" : s.cur }));
    const t = setTimeout(() => setState((s) => ({ ...s, prev: "" })), 650);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span className="lbl">
      {state.prev && <span className="out" key={"o" + state.prev}>{state.prev}</span>}
      <span className={state.prev ? "in" : ""} key={state.cur}>{state.cur}</span>
    </span>
  );
}

const TabShape = () => {
  const w = TAB_W + SHOULDER * 2;
  const s = SHOULDER;
  const edge = `M0,${TAB_H} C${s / 2},${TAB_H} ${s / 2},0 ${s},0 H${s + TAB_W} C${s + TAB_W + s / 2},0 ${s + TAB_W + s / 2},${TAB_H} ${w},${TAB_H}`;
  return (
    <svg width={w} height={TAB_H + 2} viewBox={`0 0 ${w} ${TAB_H + 2}`} aria-hidden>
      <path d={`${edge} V${TAB_H + 2} H0 Z`} className="tab-fill" />
      <path d={edge} className="tab-line" />
    </svg>
  );
};

const rnd = (n: number) => Math.floor(Math.random() * n);
const X0 = [0.04, 0.66, 0.2, 0.52, 0.0, 0.78, 0.3, 0.6, 0.1];

export const Drawer = memo(function Drawer({ pool, results, busy, collapsed, activeId, onPick, opening, slots = SLOTS, infinite = "off", list = [], feel = "balanced", autoScroll = "off", paused = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const wasOpening = useRef(false);
  useEffect(() => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>(".folder:not(.leaving)") ?? [])];
    if (opening) {
      els.forEach((el, i) => el.animate([{ translate: "0 0", opacity: 1 }, { translate: "0 340px", opacity: 0 }], {
        id: "drop", duration: 560, delay: (els.length - i) * 42, easing: "cubic-bezier(.6,0,.9,.45)", fill: "both",
      }));
    } else if (wasOpening.current) {
      els.forEach((el, i) => {
        el.getAnimations().filter((a) => a.id === "drop").forEach((a) => a.cancel());
        el.animate([{ translate: "0 260px", opacity: 0 }, { translate: "0 0", opacity: 1 }], {
          duration: 800, delay: i * 50, easing: "cubic-bezier(.2,.9,.25,1.05)", fill: "backwards",
        });
      });
    }
    wasOpening.current = opening;
  }, [opening]);

  const [fill, setFill] = useState(() => Array.from({ length: SLOTS }, (_, i) => ({ item: null as DrawerItem | null, x: X0[i] })));
  const [hover, setHover] = useState<number | null>(null);
  // ── infinite drawer (widget menu): two-finger / wheel scrolling runs the home drawer through its files, endlessly, then it settles back into the normal home arrangement ──
  // While scrolling, a second layer of folders (class "inf") stands exactly where the home folders are; the home layer is hidden underneath and takes over again when it settles.
  const canScroll = !paused && infinite !== "off" && list.length >= SLOTS && results.length === 0 && !busy && !collapsed && slots >= SLOTS;
  const [anchor, setAnchor] = useState(0);          // the absolute index of the file in the first slot, as settled
  const [scr, setScr] = useState<{ base: number } | null>(null);
  const [snap, setSnap] = useState(false);
  const inf = useRef({ list, override: new Map<number, { item: DrawerItem; x: number }>(), pos: 0, target: 0, vel: 0, anchor: 0, origin: null as number | null, fill: null as typeof fill | null, active: false, cfg: { ...FEEL.balanced, auto: 0 } });
  inf.current.list = list; inf.current.fill = fill;
  inf.current.cfg = { ...(FEEL[feel] ?? FEEL.balanced), auto: AUTO[autoScroll] ?? 0 };
  const xAt = (i: number) => { const h = (Math.imul(i + 7, 2654435761) >>> 0) / 4294967296; return i % 2 ? 0.5 + h * 0.5 : h * 0.5; };
  const itemAt = (i: number) => {
    const o = inf.current.override.get(i);
    if (o) return o;
    const l = inf.current.list, n = l.length, j = i - (inf.current.origin ?? inf.current.anchor + SLOTS);   // list[0] sits at `origin`: the stream is one continuous run, both ways
    return n ? { item: l[((j % n) + n) % n], x: xAt(i) } : null;
  };
  // An ordered drawer organises the home folders itself the moment it is chosen: they relabel (the usual cross-fade, the tabs glide to their places) into the first files of that order.
  // A random one just carries on from the home screen.
  useEffect(() => {
    const st = inf.current;
    st.override.clear(); st.origin = null;
    if (infinite === "off" || infinite === "random" || list.length < SLOTS) return;
    st.origin = st.anchor;
    setFill(Array.from({ length: SLOTS }, (_, k) => ({ item: list[k % list.length], x: xAt(st.anchor + k) })));
  }, [infinite, list]);
  useEffect(() => {
    if (!canScroll) return;
    const el = root.current, holder = el?.parentElement;
    if (!el || !holder) return;
    const st = inf.current;
    let raf = 0, lastWheel = 0, settling = false, last = 0, base = 0, inside = false;
    const apply = () => {
      const b = Math.floor(st.pos), f = st.pos - b;
      if (b !== base) { base = b; flushSync(() => setScr({ base: b })); }
      el.style.setProperty("--f", f.toFixed(4));
      el.style.setProperty("--v", Math.max(-1, Math.min(1, st.vel / 9)).toFixed(3));   // the tabs lean a little with the speed
    };
    /** Hand the folders that are on show back to the home layer, exactly as they stand. */
    const commit = () => {
      const P = Math.round(st.pos);
      const vis = Array.from({ length: SLOTS }, (_, k) => { const it = itemAt(P + k); return { item: it ? it.item : null, x: it ? it.x : 0.5 }; });
      st.anchor = P; st.active = false; settling = false; st.vel = 0;
      setSnap(true);
      setFill(vis);
      setAnchor(P);
      setScr(null);
      el.style.removeProperty("--f"); el.style.removeProperty("--v");
      requestAnimationFrame(() => requestAnimationFrame(() => setSnap(false)));
    };
    const autoGoing = (now: number) => st.cfg.auto > 0 && !inside && now - lastWheel > 1200;   // the home screen scrolls by itself (never under the pointer, never against your fingers)
    const tick = (now: number) => {
      raf = 0;
      const dt = Math.min(0.033, (now - (last || now - 16)) / 1000); last = now;
      if (autoGoing(now)) { settling = false; st.target += st.cfg.auto * dt; }
      else if (!settling && now - lastWheel > st.cfg.idle) { settling = true; st.target = Math.round(st.target); }
      // a spring: it follows the fingers with some weight (the "scroll feel" setting) and settles with a little overshoot
      st.vel += ((st.target - st.pos) * st.cfg.K - st.vel * st.cfg.C) * dt;
      st.pos += st.vel * dt;
      if (settling && Math.abs(st.target - st.pos) < 0.004 && Math.abs(st.vel) < 0.06) { st.pos = st.target; apply(); commit(); return; }
      apply();
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (infinite === "random") {              // the home folders are random picks: they stay as they are, and the run continues after them
        st.override.clear();
        const f = st.fill ?? [];
        for (let k = 0; k < SLOTS; k++) if (f[k]?.item) st.override.set(st.anchor + k, { item: f[k].item!, x: f[k].x });
        st.origin = st.anchor + SLOTS;
      }
      st.pos = st.target = base = st.anchor; st.vel = 0; st.active = true; settling = false; last = 0;
      flushSync(() => setScr({ base: st.anchor }));
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;            // pinch / zoom is not ours
      const r = holder.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;   // the system's own direction (natural scrolling or not) is kept
      if (!st.active) start();
      settling = false; lastWheel = performance.now();
      st.target += dy / st.cfg.px;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    // the pointer over the drawer stops the automatic scrolling (you are about to pick something): it eases to the nearest folder
    const onMove = (e: PointerEvent) => {
      const r = holder.getBoundingClientRect();
      const now = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (now === inside) return;
      inside = now;
      if (inside && st.active && st.cfg.auto > 0) { st.target = Math.round(st.pos + st.vel * 0.3); settling = true; lastWheel = 0; }
    };
    const onBlur = () => { inside = false; };
    // automatic scrolling: (re)starts whenever the home screen is still and the pointer is away
    const auto = setInterval(() => {
      if (st.cfg.auto > 0 && !st.active && !inside && !document.hidden) start();
    }, 400);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("wheel", onWheel); window.removeEventListener("pointermove", onMove); window.removeEventListener("blur", onBlur);
      clearInterval(auto); cancelAnimationFrame(raf);
      if (st.active) commit();   // the home screen changed under it (a search, a file opening): what was on show stays, no jump
    };
  }, [canScroll, infinite]);

  const poolRef = useRef(pool);
  poolRef.current = pool;

  // Only the front `slots` folders exist. Folders that drop out of that range stay a moment and fade, so a long
  // loading stack settles into the results instead of vanishing.
  const from = SLOTS - Math.max(0, Math.min(SLOTS, slots));
  const top0 = slots >= SLOTS ? 0 : 24; // room above the first tab for lift and bounce
  const [leaveFrom, setLeaveFrom] = useState<number | null>(null);
  const prevFrom = useRef(from);
  useEffect(() => {
    if (from > prevFrom.current) {
      setLeaveFrom(prevFrom.current);
      prevFrom.current = from;
      const t = setTimeout(() => setLeaveFrom(null), 750);
      return () => clearTimeout(t);
    }
    prevFrom.current = from;
    setLeaveFrom(null);
  }, [from]);
  const renderFrom = leaveFrom !== null ? Math.min(from, leaveFrom) : from;

  // seed labels once the pool arrives
  useEffect(() => {
    if (!pool.length) return;
    setFill((f) => f.map((s, i) => (s.item ? s : { ...s, item: pool[(i * 7) % pool.length] })));
  }, [pool.length > 0]);

  // keep tabs gliding and relabelling on the home screen (faster while the model works).
  // once there are results the drawer holds still so they can be browsed.
  const still = results.length > 0;
  useEffect(() => {
    if (still) return;
    if (infinite !== "off" && list.length >= SLOTS && (infinite !== "random" || (AUTO[autoScroll] ?? 0) > 0)) return;   // an ordered drawer (or a self-scrolling one: no other motion) keeps its order once it has settled; a random one just carries on
    const t = setInterval(() => {
      const p = poolRef.current;
      if (!p.length || document.hidden) return;
      setFill((f) => {
        const i = from + rnd(Math.max(1, SLOTS - from));
        const next = [...f];
        const odd = i % 2;
        next[i] = { item: p[rnd(p.length)], x: odd ? 0.5 + Math.random() * 0.5 : Math.random() * 0.5 };
        if (busy) {
          const j = from + ((i - from + 3 + rnd(3)) % Math.max(1, SLOTS - from));
          next[j] = { ...next[j], x: Math.random() };
        }
        return next;
      });
    }, busy ? 380 : 1700);
    return () => clearInterval(t);
  }, [busy, still, from, infinite, list.length >= SLOTS, autoScroll]);

  const shown = results.slice(0, Math.max(0, SLOTS - from));
  const firstResult = SLOTS - shown.length;

  return (
    <div
      ref={root}
      className={`drawer ${collapsed ? "collapsed" : ""} ${busy ? "busy" : ""} ${scr ? "scrolling" : ""} ${infinite !== "off" && list.length >= SLOTS ? "inf-on" : ""} ${snap ? "snap" : ""}`}
      style={{ height: (SLOTS - from) * STEP + 120 }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHover(Math.max(from, Math.min(SLOTS - 1, Math.floor((e.clientY - r.top - top0) / STEP) + from)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: SLOTS - renderFrom }, (_, k) => {
        const i = renderFrom + k;
        const leaving = i < from;
        const r = i - firstResult;
        const res = r >= 0 ? shown[r] : null;
        const item = res ?? fill[i].item;
        const x = res ? (r % 2 ? 0.62 : 0.06) : fill[i].x;
        const hot = !!res && (activeId ? res.id === activeId : res.rank === 1 || (res.rank === undefined && r === 0));
        // dock-style magnification: the folder under the cursor lifts, its neighbours follow
        const lift = hover === null || collapsed || leaving ? 0 : -15 * Math.exp(-((i - hover) ** 2) / 2.6);
        const style = {
          top: (i - from) * STEP + top0,
          zIndex: i + 1,
          "--x": x,
          "--n": Math.max(r, 0),
          "--i": i,
          "--side": r % 2 ? 1 : -1,
          "--lift": `${lift.toFixed(1)}px`,
          ...(item ? { "--c": fileColor(item.id), "--tt": fileInk(item.id) } : {}),
        } as CSSProperties;
        const out = collapsed && !!item && item.id === activeId;
        return (
          <div
            key={res ? `r${res.id}` : `f${i}`}
            className={`folder ${res ? "result" : "filler"} ${hot ? "hot" : ""} ${out ? "out" : ""} ${leaving ? "leaving" : ""} ${res?.related ? "related" : res ? "exact" : ""}`}
            style={style}
          >
            <div className="body" />
            {!res && (infinite === "off" ? (i === 2 || i === 6) : ((anchor + i) % 4 + 4) % 4 === 2) && item && (
              <div className="divider" style={{ left: fill[i].x < 0.5 ? "74%" : "7%" }}>
                <span>{item.name.charAt(0).toUpperCase()}</span>
                <span>{pad(item.id)}</span>
              </div>
            )}
            <div
              className="strip"
              onClick={item && !leaving ? (e) => onPick(item.id, (e.currentTarget.parentElement!.querySelector(".tab") as HTMLElement).getBoundingClientRect()) : undefined}
              role="button"
              aria-label={item ? `open ${item.name}` : undefined}
            />
            <div className="tabx" style={{ pointerEvents: "none" }}>
            <div className="tab">
              <TabShape />
              <div className="tab-text" style={{ left: SHOULDER + 8, right: SHOULDER + 8 }}>
                <span className="num">{res ? pad(res.rank ?? r + 1) : item ? pad(item.id) : "···"}</span>
                {item ? <Label text={bare(item.name, res?.badge ? 17 : 24)} instant={snap} /> : <span className="lbl" />}
                {res?.badge && <span className="badge">{res.badge}</span>}
              </div>
            </div>
            </div>
          </div>
        );
      })}
      {scr && Array.from({ length: SLOTS + 2 }, (_, n) => {
        const i = scr.base - 1 + n, k = i - scr.base, it = itemAt(i);
        if (!it) return null;
        const style = { top: k * STEP + top0, zIndex: k + 3, "--x": it.x, "--k": k, "--d": i % 2 ? 1 : -1, "--c": fileColor(it.item.id), "--tt": fileInk(it.item.id) } as CSSProperties;
        return (
          <div key={`s${i}`} className="folder filler inf" style={style}>
            <div className="body" />
            {((i % 4) + 4) % 4 === 2 && (
              <div className="divider" style={{ left: it.x < 0.5 ? "74%" : "7%" }}><span>{it.item.name.charAt(0).toUpperCase()}</span><span>{pad(it.item.id)}</span></div>
            )}
            <div className="strip" role="button" aria-label={`open ${it.item.name}`}
              onClick={(e) => onPick(it.item.id, (e.currentTarget.parentElement!.querySelector(".tab") as HTMLElement).getBoundingClientRect())} />
            <div className="tabx" style={{ pointerEvents: "none" }}>
              <div className="tab">
                <TabShape />
                <div className="tab-text" style={{ left: SHOULDER + 8, right: SHOULDER + 8 }}>
                  <span className="num">{pad(it.item.id)}</span>
                  <span className="lbl"><span>{bare(it.item.name, 24)}</span></span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});
