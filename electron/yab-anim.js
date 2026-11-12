// Yab's widget animation: a hand-drawn marker-style file box with cream folders. The box floats gently; every so often one folder slides up out of
// the box, hovers, and settles back into its slot, while the others shift left and right as if being sorted. Calm, eased, never frantic.
// Pure vector SVG on a transparent background (crisp at any size); the outlines get a slight hand-drawn wobble from an SVG displacement filter.
// The timeline loops every LOOP seconds and every channel is back at rest at both ends, so the loop is seamless.
// YabAnim.mount(el[, freezeAt]) draws it; with freezeAt it draws that one moment and doesn't animate.
(function () {
  const LOOP = 10, INK = "#1b1b1d", SLOPE = 0.227;
  const TAU = Math.PI * 2;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);     // cubic in-out
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);

  /** 0 -> 1 over `up`, held for `hold`, back to 0 over `down` (all starting at t0). */
  const pulse = (t, t0, up, hold, down) => {
    const d = t - t0;
    if (d <= 0) return 0;
    if (d < up) return easeOut(d / up);
    if (d < up + hold) return 1;
    if (d < up + hold + down) return 1 - ease((d - up - hold) / down);
    return 0;
  };
  /** 0 -> 1 -> 0 as one smooth hump */
  const bump = (t, t0, dur) => { const u = (t - t0) / dur; return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * ease(u)); };

  // folders, back to front. d: how far back in the box (0 = front, 1 = back wall); x,y: flat offset (up is negative y); w: width; tab position/width.
  const FOLDERS = [
    { id: "back",   fill: "#8f8f95", d: 0.9,  x: 4,  y: -26, w: 126, tabX: 60, tabW: 0 },
    { id: "yel1",   fill: "#f1d983", d: 0.72, x: 10, y: -42, w: 124, tabX: 70, tabW: 38 },
    { id: "yel2",   fill: "#f8e6a0", d: 0.56, x: 10, y: -34, w: 126, tabX: 64, tabW: 36 },
    { id: "white",  fill: "#ffffff", d: 0.38, x: 12, y: -62, w: 122, tabX: 4,  tabW: 42 },
    { id: "cream1", fill: "#fdf3cd", d: 0.16, x: 6,  y: -32, w: 138, tabX: 44, tabW: 36 },
    { id: "cream2", fill: "#fffae3", d: 0.04, x: 4,  y: -22, w: 140, tabX: 6,  tabW: 36 },
  ];
  const FH = 120;

  const folderPath = (w, tabX, tabW) => {
    const r = 6, ty = 12, tr = 7;
    if (!tabW) return `M0 ${FH} V${ty + r} Q0 ${ty} ${r} ${ty} H${w - r} Q${w} ${ty} ${w} ${ty + r} V${FH} Z`;
    return `M0 ${FH} V${ty + r} Q0 ${ty} ${r} ${ty} H${tabX} L${tabX + 5} ${tr} Q${tabX + 7} 0 ${tabX + 13} 0 H${tabX + tabW - 8} Q${tabX + tabW - 3} 0 ${tabX + tabW} ${ty - 2} L${tabX + tabW + 4} ${ty} H${w - r} Q${w} ${ty} ${w} ${ty + r} V${FH} Z`;
  };

  const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -52 300 314" width="100%" height="100%" style="display:block;overflow:visible" shape-rendering="geometricPrecision">
  <g stroke-linecap="round" stroke-linejoin="round">
    <path data-rough="1" id="shadow" d="M166 238 L268 178 Q282 174 281 185 Q277 192 264 200 L186 244 Q170 249 166 242 Z" fill="${INK}" stroke="${INK}" stroke-width="3"/>
    <g id="box">
      <path data-rough="1" id="interior" d="M11 98 L161 132 L270 72 L120 38 Z" fill="#2c2c30" stroke="${INK}" stroke-width="4"/>
      <g id="folders"></g>
      <g id="frontface" transform="translate(11 98) matrix(1 ${SLOPE} 0 1 0 0)">
        <path data-rough="1" d="M0 0 H150 V100 H0 Z" fill="#fff" stroke="${INK}" stroke-width="4.2"/>
        <path data-rough="1" d="M51.5 40 H78.5 A7.5 7.5 0 0 1 78.5 55 H51.5 A7.5 7.5 0 0 1 51.5 40 Z" fill="${INK}" stroke="${INK}" stroke-width="1"/>
      </g>
      <path data-rough="1" id="rightface" d="M161 132 L270 72 V168 L161 233 Z" fill="#aeaeb2" stroke="${INK}" stroke-width="4.2"/>
    </g>
  </g>
</svg>`;

  // the white folder: the one that pops out of the box (and, in the launch effect, is thrown)
  const WHITE = FOLDERS.find((f) => f.id === "white");
  const whiteOutAt = (t) => pulse(((t % LOOP) + LOOP) % LOOP, 0.7, 1.1, 0.9, 1.1);
  /** centre of the white folder in viewBox coordinates when it is lifted by `out` (0 = in its slot, 1 = fully out) */
  const whiteCenter = (out) => [11 + 109 * WHITE.d + WHITE.x + WHITE.w / 2, 98 - 60 * WHITE.d - 58 * out + (WHITE.y + FH / 2) + SLOPE * (WHITE.x + WHITE.w / 2)];

  /**
   * opts.only: "back" | "white" | "front" draws just that layer (the launch effect stacks them so the folder can leave the box on its own).
   * The returned handle has set(name, value) for overriding the white folder's lift (whiteOut), plus clock()/restart() for the live loop.
   */
  // The hand-drawn wobble. It used to be an SVG displacement filter, but a filter works in screen space: as the drawer moved, its outlines slid through a fixed noise field
  // and rippled every frame (read as jitter / a "refresh"). Here the wobble is baked into the outline geometry once, so it is part of each shape and moves rigidly with it.
  const wob = (x, y, k) => 0.42 * (0.6 * Math.sin(x * 0.19 + y * 0.11 + k * 1.7) + 0.4 * Math.sin(x * 0.07 - y * 0.23 + k * 4.1)) + 0.16 * Math.sin(x * 0.55 + y * 0.41 + k * 2.3);   // about the strength of the old filter's visible effect
  const roughCache = new Map();   // the wobble depends only on the outline, so each outline is computed once per page
  function roughen(path) {
    const d0 = path.getAttribute("d");
    let d = roughCache.get(d0);
    if (!d) {
      const closed = /z\s*$/i.test(d0.trim()), L = path.getTotalLength(), n = Math.max(8, Math.ceil(L / 2.2)), out = [];
      for (let i = 0; i < (closed ? n : n + 1); i++) { const pt = path.getPointAtLength((L * i) / n); out.push(`${(pt.x + wob(pt.x, pt.y, 0)).toFixed(2)} ${(pt.y + wob(pt.x, pt.y, 1)).toFixed(2)}`); }
      d = `M${out.join(" L")}${closed ? " Z" : ""}`;
      roughCache.set(d0, d);
    }
    path.setAttribute("d", d);
  }

  function mount(el, freezeAt, opts = {}) {
    el.innerHTML = SVG;
    el.querySelectorAll("[data-rough]").forEach(roughen);
    const folders = el.querySelector("#folders"), box = el.querySelector("#box"), shadow = el.querySelector("#shadow");
    const ov = {}, nodes = {};
    for (const f of FOLDERS) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.innerHTML = `<path d="${folderPath(f.w, f.tabX, f.tabW)}" fill="${f.fill}" stroke="${INK}" stroke-width="3.6"/>`;
      folders.appendChild(g);
      roughen(g.firstChild);
      nodes[f.id] = g;
    }

    if (opts.only) {
      const o = opts.only, show = (n, v) => { if (n) n.style.display = v ? "" : "none"; };
      show(shadow, o === "back" && !opts.noShadow); show(el.querySelector("#interior"), o === "back");
      show(el.querySelector("#frontface"), o === "front"); show(el.querySelector("#rightface"), o === "front");
      for (const f of FOLDERS) show(nodes[f.id], o === "white" ? f.id === "white" : f.id === "cream1" || f.id === "cream2" ? o === "front" : o === "back");
    }

    if (opts.noShadow && !opts.only) shadow.style.display = "none";

    let last = 0;
    const draw = (time) => {
      last = time;
      const t = ((time % LOOP) + LOOP) % LOOP, f2 = (v) => v.toFixed(2);
      // the whole box breathes: a slow float with a little rotation (two full cycles per loop)
      const fl = Math.sin((TAU * t) / 5);
      box.setAttribute("transform", `translate(0 ${f2(-3.2 * fl)}) rotate(${f2(1.1 * Math.sin((TAU * t) / 5 + 0.9))} 150 150)`);
      shadow.setAttribute("transform", `translate(${f2(3 * fl)} 0) scale(${f2(1 + 0.02 * fl)} 1)`);

      // the three things that happen, calmly one after another
      const out1 = ov.whiteOut ?? pulse(t, 0.7, 1.1, 0.9, 1.1);   // the tall white folder slides up, hovers, slides back down
      const shiftA = bump(t, 4.3, 2.0), shiftB = bump(t, 4.7, 2.0), shiftC = bump(t, 5.1, 1.8);   // sorting: the front folders slide sideways
      const out2 = pulse(t, 7.2, 0.9, 0.5, 1.0);   // a yellow folder from the back pops up and settles

      const mv = {
        white: { dx: 0, dy: -58 * out1, rot: 2.2 * out1 * Math.sin((TAU * t) / 1.8) },
        cream2: { dx: 15 * shiftA, dy: 0, rot: 0 },
        cream1: { dx: -11 * shiftB, dy: 0, rot: 0 },
        yel2: { dx: 9 * shiftC, dy: -5 * shiftC, rot: 0 },
        yel1: { dx: 0, dy: -40 * out2, rot: -1.6 * out2 * Math.sin((TAU * t) / 1.5) },
        back: { dx: 0, dy: 0, rot: 0 },
      };
      for (const f of FOLDERS) {
        const m = mv[f.id], hov = f.id === "white" ? 2.2 * out1 * Math.sin((TAU * t) / 2.2) : 0;
        nodes[f.id].setAttribute("transform", `translate(${f2(11 + 109 * f.d)} ${f2(98 - 60 * f.d + m.dy + hov)}) matrix(1 ${SLOPE} 0 1 0 0) translate(${f2(f.x + m.dx)} ${f.y}) rotate(${f2(m.rot)} ${f.w / 2} ${FH / 2})`);
      }
    };

    const set = (k, v) => { ov[k] = v; draw(last); };
    draw(freezeAt ?? 0);
    if (freezeAt != null) return { draw, set };
    let t0 = performance.now(), held = null, minGap = 0, lastDraw = 0;
    // the frame-rate cap: on a slow PC the idle loop is drawn less often (the performance presets set it); 0 = every frame the display offers
    const loop = (now) => { if (held == null && now - lastDraw >= minGap - 1.5) { lastDraw = now; draw(((performance.now() - t0) / 1000) % LOOP); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    return {
      setFps: (n) => { minGap = n >= 60 || !n ? 0 : 1000 / n; },
      setShadow: (on) => { shadow.style.display = on ? "" : "none"; },
      draw, set, clock: () => (held ?? ((performance.now() - t0) / 1000)) % LOOP,
      restart: () => { t0 = performance.now(); },
      hold: (t) => { held = t; draw(t); },                       // stand still on one frame (while the launch overlay is still covering the widget)
      resume: () => { held = null; t0 = performance.now(); },    // and carry on from the start of the loop
    };
  }

  window.YabAnim = {
    mount, pose: () => ({}), LOOP,
    geom: { VB: { x: 0, y: -52, w: 300, h: 314 }, SLOPE, white: { w: WHITE.w, h: FH }, whiteOutAt, whiteCenter },
  };
})();
