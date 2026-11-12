// "File opening: Portrait" — one master timeline (like a single GSAP timeline), driven by requestAnimationFrame so that closing is exactly the same timeline played backwards
// and the hold can stretch while the file is still loading. Only transform and opacity are animated (plus the title's text scramble).
//
// What happens (t = 0 at the click):
//   0.0–0.6  the page text fades and the other folders drop away (those are the existing CSS / drawer animations); the chosen folder STAYS: here it is the plate,
//            standing in for it as a plain landscape slab (the final portrait frame turned -90deg about its top-right corner, so only its top band and tab show)
//   0.3–0.5  hold (short; it stretches, up to 2.6 s in all, while the file is still loading)
//   0.5–1.2  ROTATE: the slab turns clockwise 90deg as one rigid group about that corner (which also travels to its final place), with a mid-turn rotateX/rotateY
//            of 8 / -6deg that returns to 0. Power3 in-out. The paper starts tucked in the folder and slides out during the first half of the turn.
//            The folder's tab ends on the right edge, its label reading top-to-bottom.
//   1.1–1.55 the document title is revealed above the sheet with a text scramble (it then stays, and shrinks as the page is scrolled, like classic)
//   0.1–0.5  the sibling tabs fade in with the slab (present before the turn, like classic)
// Closing plays all of that backwards (a little faster), then the drawer comes back.

const c01 = (v: number) => Math.min(1, Math.max(0, v));
const seg = (m: number, a: number, d: number) => c01((m - a) / d);
const power3InOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const power2Out = (u: number) => 1 - (1 - u) * (1 - u);

const T_HOLD_END = 0.5, T_ROT = 0.7;                 // rotation 0.5 -> 1.2
const T_TITLE = 1.1, D_TITLE = 0.45;
const T_TABS = 0.1, D_TAB = 0.4;                     // sibling tabs fade in with the slab, there before the turn
const T_END = 1.8;
const MAX_WAIT = 2.6;                                // seconds of total waiting for the file to load before the turn goes ahead anyway
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface Turn { close: (done: () => void) => void; stop: () => void }

export function createTurn(slot: HTMLElement, plate: HTMLElement, origin: DOMRect): Turn {
  const paper = plate.querySelector<HTMLElement>(".vpaper");
  const vh = slot.querySelector<HTMLElement>(".vh");
  const letters = vh ? [...vh.querySelectorAll<HTMLElement>(".vl")] : [];
  const finals = letters.map((l) => l.textContent ?? "");
  const tabs = [...plate.querySelectorAll<HTMLElement>(".vt:not(.cur)")];

  // geometry: the plate is already laid out in its final place (the portrait layout CSS is on); measure it, then make it tall for the turn
  const sr = slot.getBoundingClientRect();
  const r = plate.getBoundingClientRect();
  const hBig = Math.max(r.height, sr.width + 40);     // as tall as the screen is wide, so turned on its side it is a full-width slab
  const pivot = { x: r.right, y: r.top };             // the plate's top-right corner: the slab's top-left corner when lying down
  const slab = { x: sr.left, y: origin.bottom - 2 };            // where that corner sits at the start: the left edge, on the chosen folder's band (the slab spans the width)
  const dx0 = slab.x - pivot.x, dy0 = slab.y - pivot.y;
  plate.style.transformOrigin = "100% 0";
  plate.style.willChange = "transform";

  const ready = () => {
    const b = slot.querySelector(".viewer-body");
    if (!b) return true;
    const cv = b.querySelector<HTMLCanvasElement>(".pdf-page canvas");
    return !!(cv && cv.width > 0) || !!b.querySelector("article.paper:not(:has(.muted))") || !!b.querySelector(".img-wrap img") || !!b.querySelector(".empty");
  };

  // "Folder style: Dimensional": the lighter front cover of the folder. It covers the slab while it holds, then swings away faster than the turn and uncovers the paper.
  let cover: HTMLElement | null = null;
  if (document.documentElement.classList.contains("dim3")) {
    cover = document.createElement("div");
    cover.className = "viewer-front";
    plate.appendChild(cover);
  }

  let tall = false;
  const setTall = (on: boolean) => {
    if (on === tall) return;
    tall = on;
    plate.style.flex = on ? "none" : "";
    plate.style.height = on ? `${hBig}px` : "";
  };

  const scramble = (u: number) => {
    letters.forEach((l, i) => {
      const f = finals[i];
      const done = c01((u - (i / Math.max(1, letters.length)) * 0.6) / 0.4) >= 1;
      l.textContent = done || f === " " || f === " " ? f : CHARS[Math.floor(Math.random() * CHARS.length)];
    });
  };

  /** Put everything where it belongs at master time m. */
  const update = (m: number) => {
    const eR = power3InOut(seg(m, T_HOLD_END, T_ROT));
    const tilt = Math.sin(Math.PI * seg(m, T_HOLD_END, T_ROT));
    const turning = eR < 1;
    setTall(turning);
    plate.style.transform = turning
      ? `translate(${(dx0 * (1 - eR)).toFixed(1)}px, ${(dy0 * (1 - eR)).toFixed(1)}px) rotate(${(-90 * (1 - eR)).toFixed(2)}deg) rotateX(${(8 * tilt).toFixed(2)}deg) rotateY(${(-6 * tilt).toFixed(2)}deg)`
      : "none";
    plate.style.opacity = String(power2Out(c01(m / 0.3)));
    if (paper) paper.style.transform = `translateX(${(-96 * (1 - power2Out(seg(m, T_HOLD_END, T_ROT * 0.62)))).toFixed(1)}%)`;
    if (vh) {
      const s = seg(m, T_TITLE, D_TITLE);
      vh.style.opacity = s > 0 ? "1" : "0";
      if (s > 0 && s < 1) scramble(s); else letters.forEach((l, i) => { if (l.textContent !== finals[i]) l.textContent = finals[i]; });
    }
    if (cover) {
      const k = power3InOut(seg(m, T_HOLD_END + 0.1, T_ROT * 0.6));
      cover.style.transform = k > 0 ? `translate(${(-k * 45).toFixed(1)}%, ${(-k * 130).toFixed(1)}%) rotate(${(k * 70).toFixed(1)}deg)` : "";
      cover.style.visibility = k >= 1 ? "hidden" : "";
    }
    const tu = power2Out(seg(m, T_TABS, D_TAB));
    tabs.forEach((el) => { el.style.opacity = tu < 1 ? String(tu) : ""; });
  };

  let m = 0, dir = 1, speed = 1, last = performance.now(), raf = 0, stopped = false;
  const t0 = performance.now();
  let closed: (() => void) | null = null;
  update(0);
  const tick = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);   // a long frame must not skip the motion
    last = now;
    m += dir * speed * dt;
    if (dir > 0) {
      // the hold stretches while the file is still loading
      if (m >= T_HOLD_END && !ready() && (now - t0) / 1000 < MAX_WAIT) m = T_HOLD_END;
      if (m >= T_END) { m = T_END; update(m); return; }
    } else if (m <= T_HOLD_END) {
      // back to the plain slab: it stays on the folder's band for a moment while the drawer comes back
      update(T_HOLD_END);
      const done = closed;
      plate.animate({ opacity: [1, 0] }, { duration: 360, fill: "forwards" });
      setTimeout(() => done?.(), 300);
      return;
    }
    update(m);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  // test hook: jump to an exact moment of the timeline (used to check the frames)
  (window as unknown as { __yabTurn?: { seek: (t: number) => void } }).__yabTurn = { seek: (t) => { stopped = true; cancelAnimationFrame(raf); update(t); } };

  return {
    close(done) {
      closed = done; dir = -1; speed = 1.7;
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    },
    stop() { stopped = true; cancelAnimationFrame(raf); cover?.remove(); },
  };
}
