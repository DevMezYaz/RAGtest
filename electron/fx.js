// The launch effect, drawn on a transparent overlay that covers the display. Everything is a function of one number, τ (seconds):
//   τ < 0   the white folder finishes popping out of the drawer, the drawer dips ("loading the throw")
//   τ >= 0  the folder is a projectile with real gravity, the drawer gets the opposite kick and falls off the screen
// "open" plays τ forward; "close" plays exactly the same function backwards, so the folder retraces its path and the drawer is pulled back up.
// All positions come from the widget's and the window's bounds at the moment it plays, so a dragged or resized widget just changes the numbers.
(function () {
  const fx = window.sleepy.fx, G = YabAnim.geom, VB = G.VB;
  const stage = document.getElementById("stage");
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const smooth = (u) => u * u * (3 - 2 * u);
  const PRE = 0.14;                                   // the pop / dip before the throw
  const PREC = 0.22;                                  // closing: how long the folder takes to slide down into its slot once everything has settled
  const LAND = 0.2;                                   // closing: the last stretch of the fall is played with the speed easing to zero (see tauAt)
  const SKEW = Math.atan(G.SLOPE) * 180 / Math.PI;    // the drawer is drawn in perspective; the folder straightens out as it grows into the window

  let raf = 0, awaitingGo = null;

  // draw once off-screen at load, so the outlines' wobble is already computed (and cached) before the first launch
  { const warm = document.createElement("div"); warm.style.cssText = "position:absolute;left:-9999px;top:0;width:220px;height:230px"; document.body.appendChild(warm); YabAnim.mount(warm, 0); warm.remove(); }

  fx.onRun(async (m) => {
    cancelAnimationFrame(raf); stage.innerHTML = "";
    // the window snapshot is a big image; decode it BEFORE the overlay says it is ready, so the card never appears blank for a frame and then fills in
    if (m.img) { try { const im = new Image(); im.src = m.img; await Promise.race([im.decode(), new Promise((r) => setTimeout(r, 600))]); if (im.naturalWidth) m.nat = { w: im.naturalWidth, h: im.naturalHeight }; } catch { /* shown undecoded: still fine */ } }
    build(m);
  });
  fx.onGo(() => { if (awaitingGo) { const f = awaitingGo; awaitingGo = null; f(); } });

  function build(m) {
    const { wb, win, screenH, dir, id } = m, open = dir === "open";
    // how the animation's viewBox lands on screen at this widget size (this is what makes the thrown folder follow the widget's size)
    const s = Math.min(wb.w / VB.w, wb.h / VB.h), ox = wb.x + (wb.w - VB.w * s) / 2, oy = wb.y + (wb.h - VB.h * s) / 2;
    const toScreen = ([X, Y]) => [ox + s * (X - VB.x), oy + s * (Y - VB.y)];

    const flip = !!m.flip;                            // the widget is mirrored left-to-right: the art is flipped about its centre, the physics follows
    // each layer is a box that the physics moves, with the art inside it (turned over when flipped)
    const layer = (z) => {
      const d = document.createElement("div"); d.style.cssText = `left:${wb.x}px;top:${wb.y}px;width:${wb.w}px;height:${wb.h}px;z-index:${z}`;
      const inner = document.createElement("div"); inner.style.cssText = `position:absolute;inset:0;transform-origin:50% 50%;transform:${flip ? "scaleX(-1)" : "none"}`;
      d.appendChild(inner); stage.appendChild(d); return { box: d, art: inner };
    };
    const lBack = layer(1), lWhite = layer(2), lFront = layer(3);
    const dBack = lBack.box, dWhite = lWhite.box, dFront = lFront.box;
    const tPose = open ? m.t : 0;                     // the drawer is drawn exactly as the widget (or its resting pose, when closing) shows it
    const w0 = open ? G.whiteOutAt(m.t) : 0;
    YabAnim.mount(lBack.art, tPose, { only: "back", noShadow: m.shadow === false });
    const hWhite = YabAnim.mount(lWhite.art, tPose, { only: "white" });
    YabAnim.mount(lFront.art, tPose, { only: "front" });

    // the card that the folder grows into: a snapshot of the window when closing, a plain sheet when opening
    const card = document.createElement("div");
    card.style.cssText = "z-index:5;opacity:0;box-sizing:border-box;border:2px solid #1b1b1d;border-style:solid;background:#fff center/100% 100% no-repeat;will-change:transform,opacity";
    // with a snapshot the card is exactly the window's own picture, transparent where the window is transparent (its rounded corners, the strip beside its shadow):
    // no backing colour and no clipping of its own, or it would cover pixels the real window does not and show as a cream frame at the swap
    if (m.img) { card.style.backgroundImage = `url(${m.img})`; card.style.border = "0"; card.style.backgroundColor = "transparent"; }
    stage.appendChild(card);

    // ── the physics, all in screen pixels ──
    const P = { g: 1, speed: 1, spin: 1, kick: 1, ...(m.phys || {}) };   // the user's settings; all 1 is the tuned default
    const g = 2.7 * screenH * P.g;                                              // gravity, scaled to the screen so it feels the same on any display
    const Cd = [wb.x + wb.w / 2, wb.y + wb.h / 2];                        // drawer centre
    const Cd0 = [wb.x + wb.w / 2, wb.y + wb.h / 2];
    const C0u = toScreen(G.whiteCenter(1));                               // the folder's centre when fully out (right way up)
    const C0 = flip ? [2 * Cd0[0] - C0u[0], C0u[1]] : C0u;                // mirrored, the folder pops out on the other side of the centre line
    const C1 = [win.x + win.w / 2, win.y + win.h / 2];                    // where the window will be
    const dist = Math.hypot(C1[0] - C0[0], C1[1] - C0[1]);
    // the folder has to turn round if the window is on the opposite side of the drawer to where it popped out: give it a little longer
    const popDir = [C0[0] - Cd[0], C0[1] - Cd[1]], aim = [C1[0] - C0[0], C1[1] - C0[1]];
    const turnsRound = popDir[0] * aim[0] + popDir[1] * aim[1] < 0;
    const Tf = Math.max(0.35, clamp(0.56 + dist / 4200 + (turnsRound ? 0.1 : 0), 0.6, 0.95) * P.speed);   // flight time
    const v0 = [(C1[0] - C0[0]) / Tf, (C1[1] - C0[1]) / Tf - 0.5 * g * Tf];   // launch velocity that lands exactly on the window
    const mr = 0.35 * P.kick;                                             // folder mass / drawer mass (scaled by the kick setting)
    const vd = [-0.1 * P.kick * v0[0], -mr * v0[1]];                               // momentum balance: kicked the opposite way (mostly vertically: sideways, gravity wins quickly)
    const r = [C0[0] - Cd[0], C0[1] - Cd[1]];
    const I = (wb.w * wb.w + wb.h * wb.h) / 12;
    const omega = clamp((r[0] * vd[1] - r[1] * vd[0]) / I, -5, 5);        // the kick is off-centre, so the drawer spins (rad/s)
    const dropTo = screenH - wb.y + 0.7 * Math.max(wb.w, wb.h);          // far enough that the whole drawer, tumbling, is below the screen
    const Tx = Math.max(Tf + 0.3, (-vd[1] + Math.sqrt(vd[1] * vd[1] + 2 * g * dropTo)) / g);   // when it has fallen out of sight
    const Tr = Tf - 0.03;                                                 // when the real window is switched on, underneath the card, exactly as the card lands on it
    const fw = G.white.w * s, fh = G.white.h * s;                         // the folder's size on screen: this is why it follows the widget size
    const spin = (C1[0] >= C0[0] ? 1 : -1) * 2 * Math.PI * P.spin;       // turns in the air (one by default)
    const ZF = 2.0;                                                       // how much bigger the folder gets before it turns into the window

    const soft = !open && !!m.soft;                   // "soft landing" setting: only the closing can use it; off = the plain time-reversed launch
    const pre = soft ? PREC : PRE;
    let lastWo = -1, revealed = false, settled = false;
    const state = (tau) => {
      // drawer
      let dx = 0, dy = 0, th = 0;
      if (tau < 0) dy = soft ? 0 : 7 * s * Math.sin(Math.PI * clamp((tau + PRE) / PRE));   // squats before the throw (the soft landing skips it: it just settles)
      else { dx = vd[0] * tau; dy = vd[1] * tau + 0.5 * g * tau * tau; th = omega * tau; }
      const tf = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) rotate(${th.toFixed(4)}rad)`;
      for (const d of [dBack, dFront]) { d.style.transformOrigin = `${wb.w / 2}px ${wb.h / 2}px`; d.style.transform = tf; }
      // folder lift while it is still in the box
      const wo = tau < 0 ? lerp(w0, 1, ease(clamp((tau + pre) / pre))) : 1;
      if (Math.abs(wo - lastWo) > 1e-4) { hWhite.set("whiteOut", wo); lastWo = wo; }
      // folder as a projectile
      const t = clamp(tau, 0, Tf), u = t / Tf;
      const C = tau < 0 ? C0 : [C0[0] + v0[0] * t, C0[1] + v0[1] * t + 0.5 * g * t * t];
      const rot = spin * ease(u);
      // first half of the flight: the folder itself grows to ZF x and straightens out of its perspective; second half: a plain sheet takes over and grows into the window
      const e1 = smooth(clamp(u / 0.5)), e2 = smooth(clamp((u - 0.5) / 0.5));
      const zf = lerp(1, ZF, e1);
      dWhite.style.zIndex = tau < 0 ? 2 : 4;
      dWhite.style.transformOrigin = `${C0[0] - wb.x}px ${C0[1] - wb.y}px`;
      dWhite.style.transform = `translate(${(C[0] - C0[0]).toFixed(1)}px,${(C[1] - C0[1]).toFixed(1)}px) rotate(${rot.toFixed(4)}rad) scale(${zf.toFixed(4)}) skewY(${((flip ? SKEW : -SKEW) * e1).toFixed(3)}deg)`;   // mirrored art leans the other way, so it is straightened the other way
      // the sheet appears on top, fully opaque and the same size as the folder, so there is never a see-through moment; the folder underneath is then dropped
      const handover = clamp((u - 0.4) / 0.04);
      dWhite.style.opacity = u < 0.46 ? 1 : 0;
      const cw = lerp(fw * ZF, win.w, e2), ch = lerp(fh * ZF, win.h, e2);
      const cardFade = open && tau > Tf + 0.05 ? 0 : 1;   // the card stays fully opaque until the real window is up beneath it, then is simply removed: no cross-fade, so no dip
      const cs = card.style, fill = [lerp(255, 239, e2), lerp(255, 238, e2), lerp(255, 233, e2)].map(Math.round).join(",");
      cs.left = `${(C[0] - cw / 2).toFixed(1)}px`; cs.top = `${(C[1] - ch / 2).toFixed(1)}px`; cs.width = `${cw.toFixed(1)}px`; cs.height = `${ch.toFixed(1)}px`;
      if (!m.img) cs.borderRadius = `${lerp(7 * s * ZF, 14, e2).toFixed(1)}px`; cs.transform = `rotate(${rot.toFixed(4)}rad)`; cs.opacity = (handover * cardFade).toFixed(3);
      if (!m.img) cs.backgroundColor = `rgb(${fill})`; if (!m.img) cs.borderWidth = `${lerp(3.6 * s * ZF, 2, e2).toFixed(2)}px`;
      // On a display with a fractional scale (Windows at 125 % / 150 %) the card, sized in CSS pixels, does not map 1:1 onto the snapshot's pixels, and where it sits on the real window
      // (which is a whole number of device pixels) it is resampled: the text of the window goes slightly soft the moment the card takes over, which reads as a blink. In the pose where
      // the card IS the window, give it the snapshot's own size and a whole-pixel position, so it is the same pixels as the window. (Whole-number scales, like a Mac's, never get here.)
      if (m.img && m.nat && e2 > 0.9995) {
        const d = window.devicePixelRatio || 1;
        if (Math.abs(d - Math.round(d)) > 0.01) {
          cs.width = `${m.nat.w / d}px`; cs.height = `${m.nat.h / d}px`;
          cs.left = `${Math.round(win.x * d) / d}px`; cs.top = `${Math.round(win.y * d) / d}px`; cs.transform = "none";
        }
      }
      if (open && !revealed && tau >= Tr) { revealed = true; fx.reveal(id); }
      if (open && !settled && tau >= Tf + 0.06) { settled = true; fx.settled(id); }   // the window is up and usable: the rest is just the drawer falling away
      return { dx, dy, th, C, wo };
    };

    // Closing is the opening played backwards, but a reversed launch ends in a dead stop (the folder was thrown at ~1000 px/s, the drawer kicked at ~300), which
    // looks like a slam and a bounce. So the last LAND seconds of the fall are eased: tau keeps the same path but its speed falls smoothly to zero on arrival
    // (tau = LAND * (1-u)^2 over 2*LAND seconds has speed 1 at the start, matching the fall before it, and 0 at the end). Then the folder slides down into its slot.
    const land = Math.min(LAND, Tx / 2), flightEnd = Tx - land;
    const tauAt = (el) => {
      if (open) return -PRE + el;
      if (!soft) return Tx - el;                       // standard: exactly the opening, backwards
      if (el < flightEnd) return Tx - el;
      if (el < flightEnd + 2 * land) { const u = (el - flightEnd) / (2 * land); return land * (1 - u) * (1 - u); }
      return -(el - flightEnd - 2 * land);
    };
    const total = soft ? flightEnd + 2 * land + PREC : Tx + PRE;

    const first = open ? -PRE : Tx;
    state(first);
    window.__seek = (tau) => state(tau);              // for the test harness
    window.__catch = () => {                          // measurement: speeds (px/s) of the folder and the drawer over the whole closing, one sample per 1/60 s
      const out = []; let prev = null;
      for (let el = 0; el <= total + 1e-9; el += 1 / 60) { const st = state(tauAt(el)); if (prev) out.push({ el, v: Math.hypot(st.C[0] - prev.C[0], st.C[1] - prev.C[1]) * 60, vd: Math.hypot(st.dx - prev.dx, st.dy - prev.dy) * 60, wo: st.wo }); prev = st; }
      return { total, out };
    };
    window.__fx = { Tf, Tx, PRE, g, v0, vd, omega };
    setTimeout(() => {
      fx.ready(id);
      if (m.debug) return;                             // the test harness drives it by hand
      awaitingGo = () => {
        const t0 = performance.now();
        const tick = (now) => {
          const el = (now - t0) / 1000;
          if (el >= total) { state(open ? Tx : -pre); fx.done(id); return; }
          state(tauAt(el));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      };
    }, 30);
  }
})();
