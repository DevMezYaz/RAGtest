import { ARCH, FOLDERS } from "./data.js";
import { art } from "./art.js";

/** All timings in one place so the choreography is easy to tune (ms). */
const T = {
  dropStagger: 45, drop: 560, titleFade: 380,
  flyDelay: 430, fly: 650,
  swing: 1500, paperRise: 1150, paperDelay: 380,
  headingDelay: 950, letterStagger: 42, letter: 520, tabsDelay: 1300,
  scrollP: 0.28, // fraction of viewport height over which the big heading shrinks into the sticky bar
};
const EASE_IN = "cubic-bezier(.6,0,.9,.45)", EASE_IO = "cubic-bezier(.7,0,.2,1)", POP = "cubic-bezier(.2,.9,.25,1.05)";

const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (a) => a.finished.catch(() => {});

const landing = $("#landing"), drawer = $("#drawer"), titleEl = $("#title"), subEl = $("#sub");
const flyer = $("#flyer"), detail = $("#detail"), heading = $("#heading"), scrollEl = $("#scroll");
const sheet = $("#sheet"), paper = $("#paper"), rtabs = $("#rtabs");
let busy = false, view = "landing", io = null;

/* ───────── landing stack ───────── */
const folderEls = FOLDERS.map((f, i) => {
  const el = document.createElement("div");
  el.className = "folder";
  el.style.cssText = `top:calc(${i} * var(--step)); z-index:${i + 1}; --c:${f.color}`;
  el.innerHTML = `<div class="fb"></div><div class="rl">${f.right} ›</div>`;
  f.tabs.forEach((t) => {
    const b = document.createElement("div");
    b.className = "tab";
    b.dataset.id = t.id;
    b.textContent = t.label;
    b.style.cssText = `left:${t.x}%; --c:${t.color}; --ink2:${t.ink ?? "#fff"}`;
    b.addEventListener("click", () => open(t.id, b, el));
    el.append(b);
  });
  drawer.append(el);
  return el;
});

/* ───────── landing → detail ───────── */
async function open(id, tab, folderEl) {
  if (busy || view !== "landing") return;
  busy = true;
  const a = ARCH[id];
  const own = folderEls.indexOf(folderEl);

  // 1 · everything else drops out of the bottom, front folders first; the heading dims away
  const drops = [];
  folderEls.forEach((el, i) => {
    if (i === own) return;
    drops.push(el.animate([{ transform: "none" }, { transform: "translateY(75vh)" }], {
      duration: T.drop, delay: (folderEls.length - i) * T.dropStagger, easing: EASE_IN, fill: "forwards",
    }));
  });
  folderEl.querySelectorAll(".tab").forEach((t) => t !== tab && t.animate([{ transform: "none" }, { transform: "translateY(60vh)" }], { duration: T.drop, easing: EASE_IN, fill: "forwards" }));
  folderEl.querySelector(".rl").animate({ opacity: [1, 0] }, { duration: 250, fill: "forwards" });
  [titleEl, subEl].forEach((e) => e.animate({ opacity: [1, 0.18, 0] }, { duration: T.titleFade + 200, fill: "forwards", easing: "ease-out" }));
  await wait(T.flyDelay);

  // 2 · the folder body detaches and flattens into the full-width plate
  const fb = folderEl.querySelector(".fb").getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  const to = { left: vw * 0.008, top: vh * 0.24, width: vw * 0.984, height: vh * 0.76 };
  Object.assign(flyer.style, { left: fb.left + "px", top: fb.top + "px", width: fb.width + "px", height: fb.height + "px" });
  flyer.style.setProperty("--c", a.color);
  flyer.innerHTML = `<div class="ft" style="${tab.dataset.id === "pei" ? "color:#111" : ""}">${a.name}</div>`;
  flyer.hidden = false;
  folderEl.style.visibility = "hidden";
  await done(flyer.animate([
    { left: fb.left + "px", top: fb.top + "px", width: fb.width + "px", height: fb.height + "px" },
    { left: to.left + "px", top: to.top + "px", width: to.width + "px", height: to.height + "px" },
  ], { duration: T.fly, easing: EASE_IO, fill: "forwards" }));

  // 3 · swap in the real sheet (same rect, same colour → invisible), then swing it up
  render(a, true);
  detail.hidden = false;
  flyer.hidden = true;
  view = "detail";
  document.body.classList.add("in-detail");
  await swing();
  sheet.classList.remove("intro");
  paper.style.transform = "";
  busy = false;
  armScroll();
}

function swing() {
  const kf = [
    { transform: "rotateX(0) rotateZ(0) translateY(0)", offset: 0, easing: "cubic-bezier(.5,0,.3,1)" },
    { transform: "rotateX(40deg) rotateZ(3deg) translateY(4vh)", offset: 0.27, easing: "cubic-bezier(.4,.1,.3,1)" },
    { transform: "rotateX(14deg) rotateZ(-24deg) translateY(-3vh)", offset: 0.55, easing: "cubic-bezier(.3,.1,.2,1)" },
    { transform: "rotateX(3deg) rotateZ(-6deg) translateY(0)", offset: 0.8, easing: "cubic-bezier(.2,.8,.2,1)" },
    { transform: "none", offset: 1 },
  ];
  const s = sheet.animate(kf, { duration: T.swing, fill: "both" });
  paper.animate([{ transform: "translateY(82vh)" }, { transform: "translateY(0)" }], { duration: T.paperRise, delay: T.paperDelay, easing: POP, fill: "both" });
  revealHeading(T.headingDelay);
  rtabs.animate([{ transform: "translateX(110%)" }, { transform: "none" }], { duration: 700, delay: T.tabsDelay, easing: POP, fill: "both" });
  return done(s);
}

/* heading letters wipe in left→right with a short vertical scan, like the reference's glitchy reveal */
function revealHeading(delay = 0) {
  [...heading.querySelectorAll(".ch")].forEach((c, i) => {
    c.animate([
      { opacity: 0, clipPath: "inset(0 0 100% 0)", transform: "translateY(35%)" },
      { opacity: 1, clipPath: "inset(0 0 55% 0)", transform: "translateY(12%)", offset: 0.5 },
      { opacity: 1, clipPath: "inset(0)", transform: "none" },
    ], { duration: T.letter, delay: delay + i * T.letterStagger, easing: "cubic-bezier(.3,.8,.3,1)", fill: "both" });
  });
}

/* ───────── detail rendering ───────── */
function render(a, intro) {
  detail.style.setProperty("--c", a.color);
  detail.style.setProperty("--p", 0);
  sheet.classList.toggle("intro", !!intro);
  heading.innerHTML = [...a.name.toUpperCase()].map((ch) => (ch === " " ? '<span class="ch sp"></span>' : `<span class="ch">${ch}</span>`)).join("");
  const [p1, p2] = a.projects;
  const nx = ARCH[a.next];
  paper.innerHTML = `
    <div class="lede-row">
      <div>
        <div class="portrait">${art.portrait()}</div>
        <div class="facts"><b>Born</b>${a.born}<br /><b style="margin-top:.5vw">Died</b>${a.died}</div>
      </div>
      <div><p class="lede">${a.intro}</p><p class="body2">${a.body}</p></div>
    </div>
    <div class="collage">
      <div class="qblock reveal" style="--d:.05s"><p>${a.quote}</p><p>${a.quoteBody}</p></div>
      <div class="card pink reveal" style="--r:-1.2deg;--d:.1s"><h3 class="ctitle">${p1.title} (${p1.year})</h3><p class="ctext">${p1.text}</p></div>
      <div class="card photo p1 reveal" style="--r:1deg;--d:.2s"><i class="clip"></i>${art[p1.art]()}</div>
      <div class="card film reveal" style="--r:1.6deg;--d:.15s">
        <div class="play"><i>▶</i><span>${a.film}</span></div><div class="thumb">${art.film()}</div>
      </div>
      <div class="card yellow reveal" style="--r:-1deg;--d:.1s"><h3 class="ctitle">${p2.title} (${p2.year})</h3><p class="ctext">${p2.text}</p></div>
      <div class="card photo p2 reveal" style="--r:1.8deg;--d:.25s">${art[p2.art]()}</div>
      <div class="card next reveal" data-next="${a.next}" style="--r:1.2deg;--d:.2s"><h3 class="ctitle">${nx.name}</h3><p class="ctext">Organic &amp; Daily Modernism</p><span class="btn">Next →</span></div>
    </div>`;
  const cur = `<div class="rt cur" style="--tc:${a.color};${a.color === "#f2e30c" ? "--ti:#111" : ""}">${a.name}</div>`;
  const other = `<div class="rt" data-go="${a.next}" style="--tc:${nx.color};${nx.color === "#f2e30c" ? "--ti:#111" : ""}">${nx.name}</div>`;
  rtabs.innerHTML = cur + other;
  rtabs.querySelector("[data-go]").onclick = () => goto(a.next);
  paper.querySelector("[data-next]").onclick = () => goto(a.next);
}

function armScroll() {
  scrollEl.style.overflowY = "auto";
  io?.disconnect();
  io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { root: scrollEl, threshold: 0.12 });
  paper.querySelectorAll(".reveal").forEach((n) => io.observe(n));
}
scrollEl.addEventListener("scroll", () => {
  const p = Math.min(scrollEl.scrollTop / (innerHeight * T.scrollP), 1);
  detail.style.setProperty("--p", p.toFixed(3));
}, { passive: true });

async function goto(id) {
  if (busy) return;
  busy = true;
  await done(detail.animate({ opacity: [1, 0] }, { duration: 260, fill: "forwards" }));
  scrollEl.scrollTop = 0;
  render(ARCH[id], false);
  armScroll();
  detail.getAnimations().forEach((x) => x.cancel());
  detail.animate({ opacity: [0, 1] }, { duration: 320, fill: "both" });
  revealHeading(80);
  busy = false;
}

/* ───────── back to the landing ───────── */
async function home() {
  if (view !== "detail" || busy) return;
  busy = true;
  await done(detail.animate({ opacity: [1, 0] }, { duration: 380, fill: "forwards" }));
  detail.hidden = true;
  detail.getAnimations().forEach((x) => x.cancel());
  scrollEl.scrollTop = 0; scrollEl.style.overflowY = "";
  [sheet, paper, rtabs, ...heading.querySelectorAll(".ch")].forEach((n) => n.getAnimations().forEach((x) => x.cancel()));
  landing.querySelectorAll("*").forEach((n) => n.getAnimations().forEach((x) => x.cancel()));
  folderEls.forEach((el) => (el.style.visibility = ""));
  view = "landing";
  document.body.classList.remove("in-detail");
  folderEls.forEach((el, i) => el.animate([{ transform: "translateY(55vh)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 700, delay: i * 70, easing: POP, fill: "both" }));
  [titleEl, subEl].forEach((e) => e.animate({ opacity: [0, 1] }, { duration: 600, delay: 250, fill: "both" }));
  await wait(900);
  busy = false;
}
$("#home").addEventListener("click", (e) => { e.preventDefault(); void home(); });
addEventListener("keydown", (e) => e.key === "Escape" && void home());

// tiny hook for automated comparison: /mosby.html?open=flw
const q = new URLSearchParams(location.search).get("open");
if (q) setTimeout(() => document.querySelector(`.tab[data-id="${q}"]`)?.click(), 300);
