// Yab: starts as a small draggable floating icon; clicking it expands the frameless, always-on-top window. Option+Space (Ctrl+Alt+Space on Windows) toggles.
const { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 4477;
const URL = `http://127.0.0.1:${PORT}`;
const WIDGET_W = 220, WIDGET_H = 230;
let win, widget, server, tray;
let scale = 1; // widget size: 1 = 220x230
// the launch effect's feel. These defaults are the tuned values; the menu lets the user change any of them, and "Reset" brings them back.
const DEFAULT_PHYS = { g: 1, speed: 1, spin: 1, kick: 1 };   // gravity, throw speed, turns in the air, how hard the drawer is kicked
let phys = { ...DEFAULT_PHYS };
let flip = false;
let shadow = true;        // the drawer's black shadow under the widget, and the window's hard offset shadow
let aiMode = "online";       // "offline": no AI model is ever contacted, the question box searches the files (by name, content, meaning)
let aiLevel = 2;             // how much the AI model may see: 1 private ... 5 full smart index (2 = how Yab has always worked)
let ocrOn = true;            // read the text in images (screenshots, scans) so it can be searched
let scrollFeel = "balanced"; // how heavy the infinite drawer feels: snappy ... slow
let autoScroll = "off";      // the home screen scrolls by itself: off, vslow, slow, medium, fast, vfast
let infinite = "off"; // the home drawer scrolls endlessly: "off" or the order of the files (random, name, new, old, folder, kind, size)
let keys = {}; // the user's own shortcuts, by action id ("" = switched off); anything missing uses the default
let folderStyle = "flat"; // "flat" (as it is) or "dimensional" (two-panel folders, hover gap, swinging cover)
let openStyle = "classic"; // how a file opens from the drawer: "classic", or "portrait" (the folder turns upright)
let fps = 60;             // how often the widget's idle loop is drawn (60 = every frame) // widget drawn upside down (180°), for a widget sitting at the top of the screen
const SIZES = [["Tiny", 0.3], ["Mini", 0.45], ["Small", 0.65], ["Medium", 1], ["Large", 1.4], ["Extra large", 1.8]];
const PACKED = app.isPackaged;
// One Yab at a time: starting it again (the exe, the Start menu) while it is hidden brings the first one back instead of starting a second copy that would look like nothing happened.
const GOT_LOCK = !PACKED || app.requestSingleInstanceLock();
if (!GOT_LOCK) app.quit();
const HOME = PACKED ? app.getPath("userData") : ROOT; // packaged: config, index and backups live here, not inside the app
const pos = { file: path.join(app.getPath("userData"), "widget.json") };
const readPos = () => { try { return JSON.parse(fs.readFileSync(pos.file, "utf8")); } catch { return null; } };
const winFile = path.join(app.getPath("userData"), "window.json");
const readWin = () => { try { return JSON.parse(fs.readFileSync(winFile, "utf8")); } catch { return null; } };
let saveWinTimer;
const saveWin = () => { clearTimeout(saveWinTimer); saveWinTimer = setTimeout(() => { try { if (win && !win.isMaximized() && win.isVisible()) fs.writeFileSync(winFile, JSON.stringify(win.getBounds())); } catch { /* ignore */ } }, 250); };
const savePos = () => { try { if (widget) { const [x, y] = widget.getPosition(); fs.writeFileSync(pos.file, JSON.stringify({ x, y, scale, fx: fx.on, flip, phys, soft: fx.soft, shadow, fps, openStyle, folderStyle, infinite, scrollFeel, autoScroll, ocr: ocrOn, aiLevel, aiMode, keys })); } } catch { /* ignore */ } };
const wsize = () => ({ width: Math.round(WIDGET_W * scale), height: Math.round(WIDGET_H * scale) });

/** Resize the floating widget around its centre, keeping it on the screen it is on. */
function setScale(v) { scale = v; commit("scale"); }
function resizeWidget() {
  if (!widget) return;
  const b = widget.getBounds(), { width, height } = wsize(), { workArea: a } = screen.getDisplayMatching(b);
  const x = Math.max(a.x, Math.min(Math.round(b.x + b.width / 2 - width / 2), a.x + a.width - width));
  const y = Math.max(a.y, Math.min(Math.round(b.y + b.height / 2 - height / 2), a.y + a.height - height));
  widget.setBounds({ x, y, width, height });
}

const alive = () => fetch(`${URL}/v1/health`).then((r) => r.ok, () => false);

function parseEnv(file) {
  const out = {};
  try { for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* no file */ }
  return out;
}

async function ensureServer() {
  if (await alive()) return;
  if (PACKED) {
    // the bundled server runs on Electron's own node; its data goes to the user's app-data folder
    fs.mkdirSync(HOME, { recursive: true });
    const bundled = path.join(ROOT, ".env"), own = path.join(HOME, ".env");
    if (!fs.existsSync(own) && fs.existsSync(bundled)) fs.copyFileSync(bundled, own);
    server = spawn(process.execPath, [path.join(ROOT, "server", "server.mjs")], {
      cwd: ROOT, stdio: "ignore", windowsHide: true, env: { ...process.env, ...parseEnv(own), ELECTRON_RUN_AS_NODE: "1", YAB_HOME: HOME, PORT: String(PORT) },
    });
  } else {
    // dev: run the API with the system node (better-sqlite3 is built for it, not for Electron's ABI)
    server = spawn("node", ["--env-file-if-exists=.env", path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
      cwd: ROOT, stdio: "inherit", env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
    });
  }
  server.on("exit", () => { server = null; });
  for (let i = 0; i < 80 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 250));
}

// Float on every desktop. By default Electron also turns the app into an "accessory" one for this, which removes its Dock icon (and makes it look like a new Yab starts
// whenever a window comes back); skipTransformProcessType keeps it an ordinary app with its Dock icon.
function allSpaces(w) { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); }
const ICON_PNG = nativeImage.createFromPath(path.join(ROOT, "build", "icon-512.png"));
// Windows wants a real .ico for the taskbar / window icon
const ICON = process.platform === "win32" && fs.existsSync(path.join(ROOT, "build", "yab.ico")) ? nativeImage.createFromPath(path.join(ROOT, "build", "yab.ico")) : ICON_PNG;
if (process.platform === "win32") app.setAppUserModelId("com.royalchains.yab"); // groups the taskbar button + uses our icon, not Electron's

function createWidget() {
  const { workArea } = screen.getPrimaryDisplay();
  const saved = readPos();
  if (saved?.scale) scale = saved.scale;
  if (saved?.fx !== undefined) fx.on = !!saved.fx;
  if (saved?.flip !== undefined) flip = !!saved.flip;
  if (saved?.phys) phys = { ...DEFAULT_PHYS, ...saved.phys };
  if (saved?.soft !== undefined) fx.soft = !!saved.soft;
  if (saved?.shadow !== undefined) shadow = !!saved.shadow;
  if (saved?.fps) fps = saved.fps;
  if (saved?.openStyle) openStyle = saved.openStyle;
  if (saved?.folderStyle) folderStyle = saved.folderStyle;
  if (saved?.infinite) infinite = saved.infinite;
  if (saved?.scrollFeel) scrollFeel = saved.scrollFeel;
  if (saved?.ocr === false) ocrOn = false;
  if (saved?.aiLevel >= 1 && saved?.aiLevel <= 5) aiLevel = saved.aiLevel;
  if (saved?.aiMode === "offline") aiMode = "offline";
  if (saved?.autoScroll) autoScroll = saved.autoScroll;
  if (saved?.keys && typeof saved.keys === "object") keys = saved.keys;
  const { width: ww, height: wh } = wsize();
  const spot = saved && screen.getDisplayMatching({ x: saved.x, y: saved.y, width: ww, height: wh }).workArea.width ? saved
    : { x: workArea.x + workArea.width - ww - 28, y: workArea.y + workArea.height - wh - 28 };
  widget = new BrowserWindow({
    width: ww, height: wh, x: spot.x, y: spot.y, resizable: false, maximizable: false, fullscreenable: false, minimizable: false, minWidth: 30, minHeight: 30,
    frame: false, transparent: true, hasShadow: false, backgroundColor: "#00000000", alwaysOnTop: true, skipTaskbar: false, show: false, icon: ICON, acceptFirstMouse: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },   // keeps drawing while hidden, so it is already at its resting pose when it comes back
  });
  widget.setAlwaysOnTop(true, "floating");
  allSpaces(widget);
  widget.loadFile(path.join(__dirname, "widget.html"));
  widget.webContents.on("did-finish-load", () => { widget?.webContents.send("flip", flip); pushLook(); });
  watchWin(widget, "widget");
  widget.once("ready-to-show", () => { if (!win?.isVisible()) widget.showInactive(); });
  widget.on("closed", () => (widget = null));
}

/** Bring the floating widget back (it can be closed from its own × while the app keeps running in the Dock / taskbar). */
function showWidget() {
  if (win?.isVisible()) return;
  if (widget && widgetSoft) return softShowWidget();
  if (!widget) createWidget(); else widget.showInactive();
}

/** Bring a window in front of other apps' windows and give it focus once, without pinning it: it is not always-on-top, so clicking a window behind it sends Yab back as usual. */
function raise(w) {
  if (!w || w.isDestroyed()) return;
  if (process.platform === "darwin") { try { app.focus({ steal: true }); } catch { /* ignore */ } w.show(); w.focus(); return; }
  w.show();
  w.setAlwaysOnTop(true); w.moveTop(); w.focus();   // Windows refuses plain focus() from a background app; a brief top-most pass gets it to the front, then it is released
  setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false); }, 200);
}

let zoomed = null;
// During the launch effect the widget is not hidden: it stays on screen, fully transparent and click-through, still painting its resting pose. Hiding and re-showing
// a window costs a moment to appear and re-raster, and that gap, as the overlay lifted, was the "refresh" you could see after the close.
let widgetSoft = false;
function softHideWidget() { trace("widget soft-hide"); if (!widget) return; widget.setIgnoreMouseEvents(true); widget.setOpacity(0); widgetSoft = true; }
function softShowWidget() { trace("widget soft-show"); if (!widget) return; widget.setOpacity(1); widget.setIgnoreMouseEvents(false); widgetSoft = false; }
function hideWidget() { if (widgetSoft) softShowWidget(); widget?.hide(); }

function toggleZoom() {
  if (!win) return;
  if (process.platform !== "win32") return win.isMaximized() ? win.unmaximize() : win.maximize();
  // transparent frameless windows can't be maximized on Windows, so fill the work area by hand and remember where it was
  if (zoomed) { win.setBounds(zoomed); zoomed = null; }
  else { zoomed = win.getBounds(); win.setBounds(screen.getDisplayMatching(zoomed).workArea); }
}

function fade() {
  let o = 0;
  const t = setInterval(() => { o += 0.2; if (!win || o >= 1) { win?.setOpacity(1); clearInterval(t); } else win.setOpacity(o); }, 16);
}

/** The plain effect: the window fades in where the widget was. */
function revealSimple() {
  win.setIgnoreMouseEvents(false); win.setOpacity(0); raise(win); hideWidget(); fade();
}

/** Swap the icon for the full window, anchored on the corner of the screen the icon sits in. */
function expand() {
  if (!win) return create();
  if (fx.busy) return;
  if (win.isVisible()) { raise(win); return; }   // already open: never play the launch again on top of itself
  const place = () => {
    const kept = readWin();
    if (kept && screen.getAllDisplays().some((d) => { const a = d.workArea; return kept.x + 80 < a.x + a.width && kept.x + kept.width - 80 > a.x && kept.y >= a.y - 4 && kept.y + 60 < a.y + a.height; })) { win.setBounds(kept); return; } // where the user last dragged it
    const wb = widget?.getBounds() ?? { x: 0, y: 0, width: WIDGET_W, height: WIDGET_H };
    const { workArea } = screen.getDisplayMatching(wb);
    const [w, h] = win.getSize();
    const right = wb.x + wb.width / 2 > workArea.x + workArea.width / 2, low = wb.y + wb.height / 2 > workArea.y + workArea.height / 2;
    const x = Math.max(workArea.x, Math.min(right ? wb.x + wb.width - w : wb.x, workArea.x + workArea.width - w));
    const y = Math.max(workArea.y, Math.min(low ? wb.y + wb.height - h : wb.y, workArea.y + workArea.height - h));
    win.setPosition(Math.round(x), Math.round(y));
  };
  place();
  if (fxWanted()) fxOpen().then((ok) => { if (!ok) revealSimple(); }); else revealSimple();
}

/** Fold the window back into the widget. */
function saveWinBounds() { if (win && !win.isMaximized() && !zoomed) { try { fs.writeFileSync(winFile, JSON.stringify(win.getBounds())); } catch { /* ignore */ } } }

function collapse() {
  trace(`collapse (armed=${!!fx.armed}, ready=${fx.armed?.ready}, busy=${fx.busy}, fx=${fxWanted()})`);
  if (!win?.isVisible()) return showWidget();
  const a = fx.armed;
  if (a && !a.committed) {                                     // the snapshot was already being prepared when the click landed
    const b = win.getBounds(), same = a.bounds.x === b.x && a.bounds.y === b.y && a.bounds.width === b.width && a.bounds.height === b.height;
    if (same) { saveWinBounds(); if (a.ready) commitClose(a); else a.pending = true; return; }
    disarm(a);                                                 // the window moved or changed size since: start again from scratch
  }
  if (fx.busy) return;
  saveWinBounds();
  const plain = () => { win.hide(); showWidget(); };
  if (fxWanted()) fxClose().then((ok) => { if (!ok) plain(); }); else plain();
}

// ── the launch effect (beta) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Click the widget: the white folder pops out, is thrown like a projectile and unfolds into the window while the drawer, kicked the other way,
// falls off the screen under gravity. Closing plays the same physics backwards. One transparent overlay covers the display for the duration, and
// every position is worked out from where the widget and the window are at that moment, so dragging the widget anywhere (or resizing it) just works.
// Anything unexpected falls back to the plain effect above.
const fx = { busy: false, dir: null, timer: null, hideTimer: null, on: true, snap: "", ack: null, soft: false, run: 0, id: 0, armed: null };   // soft: ease the closing's landing (off = the original time-reversed launch)   // on by default; the menu switches it to the plain fade
let overlay = null;
const fxWanted = () => fx.on;

// While the widget menu is up, a choice only changes what the menu shows (the settings are "staged"); everything is applied together when the menu is left ("Quit settings").
let staging = false;
const dirty = new Set();
function commit(tag) { if (tag) dirty.add(tag); if (!staging) flush(); }
function flush() {
  const d = new Set(dirty); dirty.clear();
  if (d.has("scale")) resizeWidget();
  if (d.has("flip")) widget?.webContents.send("flip", flip);
  if (d.has("ocr")) pushOcr();
  if (d.has("aiMode")) apiCall("PUT", "/v1/ai", { mode: aiMode }).then(() => win?.webContents.reloadIgnoringCache()).catch(() => {});
  pushLook(); savePos(); refreshMenus();
  if (d.has("aiLevel")) void applyAiLevel(aiLevel);
}
function setFx(v) { fx.on = v; commit(); }
/** Tell the widget and the window about the look settings that live in the pages themselves. */
function pushLook() {
  widget?.webContents.send("shadow", shadow); widget?.webContents.send("fps", fps);
  win?.webContents.send("shadow", shadow); win?.webContents.send("openstyle", openStyle); win?.webContents.send("folderstyle", folderStyle); win?.webContents.send("infinite", infinite); win?.webContents.send("scrollfeel", scrollFeel); win?.webContents.send("autoscroll", autoScroll);
}
/** Tell the API server (it keeps the setting in its own config, and reads the images when it is on). */
function pushOcr() { fetch(`http://127.0.0.1:${PORT}/v1/ocr`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: ocrOn }) }).catch(() => {}); }
const apiCall = (method, p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
function setAiMode(v) { aiMode = v; commit("aiMode"); }
/** "AI access": 1 private ... 5 full smart index. Level 5 reads every image and document once; if that is a big job (over a million tokens) the user is asked first. */
function setAiLevel(v) { aiLevel = v; commit("aiLevel"); }
async function applyAiLevel(v) {
  try {
    const r = await apiCall("PUT", "/v1/ai", { level: v });
    if (v === 5 && r.needsConfirm) {
      const e = r.estimate, money = e.priced ? `about $${e.usd.toFixed(2)}` : "the cost depends on the model";
      const opts = { type: "question", buttons: ["Start", "Not now"], defaultId: 0, cancelId: 1, title: "Full smart index", message: "Describe all your files with AI?",
        detail: `Yab will read ${e.images.toLocaleString()} images and ${e.docs.toLocaleString()} documents once, using ${e.ownKey ? "your smart-index key" : "your normal key"} (${e.model}).\n\nAbout ${(e.tokens / 1e6).toFixed(1)} million tokens, ${money}. After this only new files are processed.` };
      const { response } = win?.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response === 0) await apiCall("POST", "/v1/ai/smart", { action: "start", confirm: true });
      else { aiLevel = 4; await apiCall("PUT", "/v1/ai", { level: 4 }); savePos(); refreshMenus(); }
    }
  } catch { /* the server is not up yet: it is told again at start-up */ }
}
function setOcr(v) { ocrOn = v; commit("ocr"); }
function setScrollFeel(v) { scrollFeel = v; commit(); }
function setAutoScroll(v) { autoScroll = v; if (v !== "off" && infinite === "off") infinite = "random"; commit(); }   // on its own it scrolls through the files at random
function setInfinite(v) { infinite = v; commit(); }
function setFolderStyle(v) { folderStyle = v; commit(); }
function setOpenStyle(v) { openStyle = v; commit(); }
function setShadow(v) { shadow = v; fx.snap = ""; commit(); }   // the cached snapshot of the window still has the old shadow in it

// Performance presets: one choice sets all the settings that cost something. "high" is how Yab is tuned by default.
//   high      the full launch effect, every frame, shadows on
//   balanced  the launch effect, shorter and with no spin / a gentler drawer, shadows off, the idle loop at 30 fps
//   low       no launch effect (a plain fade), shadows off, the idle loop at 20 fps
const PRESETS = {
  high: { fx: true, phys: { g: 1, speed: 1, spin: 1, kick: 1 }, soft: false, shadow: true, fps: 60 },
  balanced: { fx: true, phys: { g: 1, speed: 0.75, spin: 0, kick: 0.6 }, soft: false, shadow: false, fps: 30 },
  low: { fx: false, phys: { g: 1, speed: 1, spin: 1, kick: 1 }, soft: false, shadow: false, fps: 20 },
};
function currentPreset() {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (fx.on === p.fx && fx.soft === p.soft && shadow === p.shadow && fps === p.fps && Object.keys(p.phys).every((k) => phys[k] === p.phys[k])) return name;
  }
  return "custom";
}
function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  fx.on = p.fx; phys = { ...p.phys }; fx.soft = p.soft; shadow = p.shadow; fps = p.fps; fx.snap = "";
  commit();
}
function setSoft(v) { fx.soft = v; commit(); }
function setPhys(k, v) { phys = { ...phys, [k]: v }; commit(); }
function setFlip(v) { flip = v; commit("flip"); }

/** the effect / flip choices, shared by the widget menu, the Dock menu and the tray */
const effectItems = () => [
  { label: "Performance", submenu: [
    { label: "High (full effects)", type: "radio", checked: currentPreset() === "high", click: () => applyPreset("high") },
    { label: "Balanced", type: "radio", checked: currentPreset() === "balanced", click: () => applyPreset("balanced") },
    { label: "Low (plain fade, lightest)", type: "radio", checked: currentPreset() === "low", click: () => applyPreset("low") },
    { label: "Custom (your own settings)", type: "radio", checked: currentPreset() === "custom", enabled: false },
  ] },
  { label: "Shadows", type: "checkbox", checked: shadow, click: (i) => setShadow(i.checked) },
  { label: "File opening", submenu: [
    { label: "Classic (as it is)", type: "radio", checked: openStyle === "classic", click: () => setOpenStyle("classic") },
    { label: "Portrait (turns upright)", type: "radio", checked: openStyle === "portrait", click: () => setOpenStyle("portrait") },
  ] },
  { label: "Folder style", submenu: [
    { label: "Flat (as it is)", type: "radio", checked: folderStyle === "flat", click: () => setFolderStyle("flat") },
    { label: "Dimensional (two-panel folders)", type: "radio", checked: folderStyle === "dimensional", click: () => setFolderStyle("dimensional") },
  ] },
  { label: "Infinite drawer", submenu: [["Off (as it is)", "off"], ["Random", "random"], ["A to Z", "name"], ["Newest first", "new"], ["Oldest first", "old"], ["By folder", "folder"], ["By type", "kind"], ["Largest first", "size"]]
    .map(([label, v]) => ({ label, type: "radio", checked: infinite === v, click: () => setInfinite(v) })) },
  { label: "AI mode", submenu: [
    { label: "Online: the AI answers your questions (default)", type: "radio", checked: aiMode === "online", click: () => setAiMode("online") },
    { label: "Offline: search only, nothing leaves this computer", type: "radio", checked: aiMode === "offline", click: () => setAiMode("offline") },
  ] },
  { label: "AI access (privacy to smarts)", enabled: aiMode === "online", submenu: [
    ...[["1  Private: snippets only", 1], ["2  Balanced (default)", 2], ["3  Informed: more pages, can look at an image", 3], ["4  Deep: whole documents, several images", 4], ["5  Full smart index: describes every image and document once", 5]]
      .map(([label, v]) => ({ label, type: "radio", checked: aiLevel === v, click: () => setAiLevel(v) })),
    ...(aiLevel === 5 ? [{ type: "separator" }, { label: "Pause smart index", click: () => apiCall("POST", "/v1/ai/smart", { action: "pause" }).catch(() => {}) }, { label: "Resume smart index", click: () => apiCall("POST", "/v1/ai/smart", { action: "resume" }).catch(() => {}) }] : []),
  ] },
  { label: "Read text in images (OCR)", type: "checkbox", checked: ocrOn, click: (i) => setOcr(i.checked) },
  { label: "Scroll feel", submenu: [["Snappy", "snappy"], ["Crisp", "crisp"], ["Balanced (default)", "balanced"], ["Floaty", "floaty"], ["Glide", "glide"], ["Drift (slow, long)", "drift"], ["Slow motion", "slow"]]
    .map(([label, v]) => ({ label, type: "radio", checked: scrollFeel === v, click: () => setScrollFeel(v) })) },
  { label: "Auto scroll (home screen)", submenu: [["Off", "off"], ["Very slow", "vslow"], ["Slow", "slow"], ["Medium", "medium"], ["Fast", "fast"], ["Very fast", "vfast"]]
    .map(([label, v]) => ({ label, type: "radio", checked: autoScroll === v, click: () => setAutoScroll(v) })) },
  { label: "Open / close effect", submenu: [
    { label: "Launch (physics)", type: "radio", checked: fxWanted(), click: () => setFx(true) },
    { label: "Simple fade", type: "radio", checked: !fxWanted(), click: () => setFx(false) },
  ] },
  { label: "Launch physics", submenu: [
    { label: "Soft landing when closing", type: "checkbox", checked: fx.soft, click: (i) => setSoft(i.checked) },
    { type: "separator" },
    { label: "Gravity", submenu: [["Light (floaty)", 0.6], ["Normal", 1], ["Heavy", 1.5]].map(([label, v]) => ({ label, type: "radio", checked: phys.g === v, click: () => setPhys("g", v) })) },
    { label: "Throw speed", submenu: [["Slow", 1.45], ["Normal", 1], ["Fast", 0.7]].map(([label, v]) => ({ label, type: "radio", checked: phys.speed === v, click: () => setPhys("speed", v) })) },
    { label: "Spin in the air", submenu: [["None", 0], ["One turn", 1], ["Two turns", 2]].map(([label, v]) => ({ label, type: "radio", checked: phys.spin === v, click: () => setPhys("spin", v) })) },
    { label: "Drawer kick", submenu: [["Gentle", 0.5], ["Normal", 1], ["Strong", 1.8]].map(([label, v]) => ({ label, type: "radio", checked: phys.kick === v, click: () => setPhys("kick", v) })) },
    { type: "separator" },
    { label: "Reset to defaults", click: () => { phys = { ...DEFAULT_PHYS }; fx.soft = false; commit(); } },
  ] },
  { label: "Flip widget horizontally", type: "checkbox", checked: flip, click: (i) => setFlip(i.checked) },
  { type: "separator" },
  { label: "Shortcuts", submenu: shortcutItems() },
];

// ── shortcuts the user can rebind (widget menu > Shortcuts…) ────────────────────────────────────────────────────────────
const KEY_ACTIONS = [
  // One key opens and closes Yab. Cmd/Ctrl+W works while Yab is in front; set any other combination and it also works from every app (Cmd/Ctrl+W itself is never taken globally: it would break closing tabs everywhere).
  { id: "toggle", label: "Open / close Yab", def: "CmdOrCtrl+W" },
  { id: "focus", label: "Bring Yab to front", def: "Alt+Shift+Space" },   // global: for when the window is buried under other windows (also opens Yab if it is closed)
  { id: "zoom", label: "Maximise / restore", def: "CmdOrCtrl+Shift+M" },
  { id: "widget", label: "Show / hide widget", def: "CmdOrCtrl+Shift+H" },
  { id: "flip", label: "Flip widget horizontally", def: "" },
  { id: "effect", label: "Switch open / close effect", def: "" },
  { id: "reload", label: "Reload", def: "CmdOrCtrl+R" },
];
const acc = (id) => (id in keys ? keys[id] : KEY_ACTIONS.find((a) => a.id === id).def);
const ax = (id) => (acc(id) ? { accelerator: acc(id) } : {});
const RESERVED = ["CmdOrCtrl+Q", "CmdOrCtrl+H", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+X", "CmdOrCtrl+A", "CmdOrCtrl+Z", "CmdOrCtrl+Shift+Z", "CmdOrCtrl+Y", "CmdOrCtrl+Alt+H", "CmdOrCtrl+Plus", "CmdOrCtrl+-", "CmdOrCtrl+0", "CmdOrCtrl+Alt+I", "CmdOrCtrl+Shift+I"];   // owned by the system / the Edit menu
const norm = (a) => a.toLowerCase().replace(/commandorcontrol|cmdorctrl|command|cmd|control|ctrl/g, "mod").split("+").sort().join("+");
const globalOk = {};
const isGlobal = (id) => id === "focus" || (id === "toggle" && !!acc("toggle") && norm(acc("toggle")) !== norm("CmdOrCtrl+W"));
function registerToggle() {
  globalShortcut.unregisterAll();
  for (const [id, fn] of [["toggle", toggle], ["focus", focusYab]]) {
    globalOk[id] = true;
    if (!isGlobal(id)) continue;
    try { globalOk[id] = globalShortcut.register(acc(id), fn); } catch { globalOk[id] = false; }
  }
  if (app.isReady()) refreshMenus();   // a key that is global is left out of the menu (it would fire twice)
}
const menuAx = (id) => (isGlobal(id) && globalOk[id] ? {} : ax(id));
function setKey(id, a) {
  const action = KEY_ACTIONS.find((x) => x.id === id);
  if (!action) return { ok: false, error: "unknown action" };
  if (a) {
    if (!/^F\d{1,2}$/.test(a.split("+").pop()) && a.split("+").length < 2) return { ok: false, error: "use at least one modifier key (Cmd/Ctrl, Shift or Alt)" };
    const last = a.split("+").pop();
    if (!/^(.|F\d{1,2}|Space|Tab|Return|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus)$/.test(last)) return { ok: false, error: "that key combination isn't valid" };
    try { Menu.buildFromTemplate([{ label: "x", submenu: [{ label: "y", accelerator: a }] }]); } catch { return { ok: false, error: "that key combination isn't valid" }; }
    if (RESERVED.some((r) => norm(r) === norm(a))) return { ok: false, error: "that one is used by the system (copy, paste, quit…)" };
    const clash = KEY_ACTIONS.find((x) => x.id !== id && acc(x.id) && norm(acc(x.id)) === norm(a));
    if (clash) return { ok: false, error: `already used by “${clash.label}”` };
  }
  const was = keys[id], had = id in keys;
  if (a === action.def) delete keys[id]; else keys[id] = a;
  if (id === "toggle" || id === "focus") { registerToggle(); if (a && isGlobal(id) && !globalOk[id]) { if (had) keys[id] = was; else delete keys[id]; registerToggle(); return { ok: false, error: "another app already uses that combination" }; } }
  savePos(); refreshMenus();
  return { ok: true };
}
const keyRows = () => KEY_ACTIONS.map((a) => ({ id: a.id, label: a.label, acc: acc(a.id), def: a.def, global: isGlobal(a.id) }));
ipcMain.handle("keys-get", () => ({ rows: keyRows(), platform: process.platform }));
ipcMain.handle("keys-set", (_e, id, a) => ({ ...setKey(id, a), rows: keyRows() }));
ipcMain.handle("keys-reset", () => { keys = {}; registerToggle(); savePos(); refreshMenus(); return { ok: true, rows: keyRows() }; });
let keysWin = null, keysRec = false;
ipcMain.on("keys-rec", (_e, on) => { keysRec = !!on; });
/** A small prompt: press the new keys for one action. */
function openKeys(id) {
  if (keysWin && !keysWin.isDestroyed()) keysWin.close();
  keysWin = new BrowserWindow({
    width: 340, height: 214, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: "Shortcut", icon: ICON, autoHideMenuBar: true, alwaysOnTop: true,
    backgroundColor: "#ececec", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  keysWin.setMenuBarVisibility(false);
  keysRec = true;
  // the keys go to the page from here: the application menu would otherwise act on Cmd+M, Cmd+W… before the page ever saw them
  keysWin.webContents.on("before-input-event", (e, i) => {
    if (!keysRec || i.type !== "keyDown") return;
    e.preventDefault();
    keysWin?.webContents.send("keys-input", { code: i.code, key: i.key, meta: i.meta, control: i.control, alt: i.alt, shift: i.shift });
  });
  keysWin.loadFile(path.join(__dirname, "keys.html"), { query: { id } });
  keysWin.on("closed", () => { keysWin = null; keysRec = false; });
}
const prettyKey = (a) => !a ? "none" : a.split("+").map((p) => ({ CmdOrCtrl: process.platform === "darwin" ? "⌘" : "Ctrl", Control: process.platform === "darwin" ? "⌃" : "Ctrl", Alt: process.platform === "darwin" ? "⌥" : "Alt", Shift: process.platform === "darwin" ? "⇧" : "Shift", Super: "Win" }[p] ?? p)).join(process.platform === "darwin" ? "" : "+");
const shortcutItems = () => [
  ...KEY_ACTIONS.map((a) => ({ label: `${a.label}   ${prettyKey(acc(a.id))}`, click: ends(() => openKeys(a.id)) })),
  { type: "separator" },
  { label: "Restore defaults", click: () => { keys = {}; registerToggle(); savePos(); refreshMenus(); } },
];
const toggleWidget = () => { if (widget?.isVisible() && !widgetSoft) hideWidget(); else showWidget(); };

/** The application menu: it is what gives the shortcuts (it works on Windows too, where this frameless window just doesn't draw the bar). */
function appMenu() {
  const MOD = "CmdOrCtrl", mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: "Yab", submenu: [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { label: "Window", submenu: [
      { id: "toggle", label: "Open / close Yab", ...menuAx("toggle"), click: toggle },
      { id: "zoom", label: "Maximise / restore", ...ax("zoom"), click: toggleZoom },
      { type: "separator" },
      { id: "widget", label: "Show / hide widget", ...ax("widget"), click: toggleWidget },
      { id: "flip", label: "Flip widget horizontally", ...ax("flip"), type: "checkbox", checked: flip, click: (i) => setFlip(i.checked) },
      { id: "effect", label: "Switch open / close effect", ...ax("effect"), click: () => setFx(!fx.on) },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [
      { id: "reload", label: "Reload", ...ax("reload"), click: () => win?.webContents.reloadIgnoringCache() },
      { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }, { type: "separator" }, { role: "toggleDevTools" },
    ] },
  ]);
}

function refreshMenus() {
  Menu.setApplicationMenu(appMenu());
  const base = [{ label: "Show widget", click: showWidget }, { label: "Open Yab", click: expand }, { type: "separator" }, ...effectItems()];
  if (process.platform === "darwin") app.dock?.setMenu(Menu.buildFromTemplate(base));
  else tray?.setContextMenu(Menu.buildFromTemplate([...base, { type: "separator" }, { label: "Quit Yab", click: () => app.quit() }]));
}

// Windows: the overlay is never show()n or hide()den at fold time. DWM plays its window-open transition (a short fade + zoom that ignores setOpacity) on every show(), and that was the
// visible "blink": a faint, slightly offset second copy of the window fading in over the live one just before the fold. So on Windows the overlay is shown once, transparent, when it is
// created; between folds it is only made transparent and parked small and off-screen (opacity / move / resize play no transition). Elsewhere it is hidden as before.
const OV_KEEP = process.platform === "win32";
const OV_PARK = { x: -4000, y: -4000, width: 64, height: 64 };
function ovIdle(o) { if (!o || o.isDestroyed()) return; if (OV_KEEP) { o.setOpacity(0); o.setBounds(OV_PARK); } else o.hide(); }

function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    width: 200, height: 200, show: false, frame: false, transparent: true, hasShadow: false, backgroundColor: "#00000000",
    focusable: false, skipTaskbar: true, resizable: false, movable: false, enableLargerThanScreen: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },   // it is hidden between launches and must still be able to draw its first frame
  });
  watchWin(overlay, "overlay");
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  allSpaces(overlay);
  overlay.loadFile(path.join(__dirname, "fx.html"));
  if (OV_KEEP) overlay.webContents.once("did-finish-load", () => { if (overlay && !overlay.isDestroyed()) { overlay.setOpacity(0); overlay.setBounds(OV_PARK); overlay.showInactive(); } });   // its one and only show
  overlay.on("closed", () => (overlay = null));
  return overlay;
}

/** Both the widget and the window must be on one display for the overlay to cover the whole flight. */
function fxGeometry() {
  if (!widget || !win) return null;
  const wb = widget.getBounds(), b = win.getBounds(), disp = screen.getDisplayMatching(wb), d = disp.bounds;
  const inside = (r) => r.x + r.width / 2 >= d.x && r.x + r.width / 2 <= d.x + d.width && r.y + r.height / 2 >= d.y && r.y + r.height / 2 <= d.y + d.height;
  if (!inside(b) || !inside(wb)) return null;
  const ov = ensureOverlay();
  // Windows treats a topmost window that is exactly the size of the monitor as a full-screen one (the shell and DWM switch the whole screen into / out of a different presentation mode),
  // and everything underneath blinks when it goes away. One pixel short of the display on the right and bottom is invisible here and keeps it an ordinary window.
  ov.setBounds(process.platform === "win32" ? { x: d.x, y: d.y, width: d.width - 1, height: d.height - 1 } : d);
  const ob = ov.getBounds();                       // the OS may not give exactly the display; measure from what we got
  const rel = (r) => ({ x: r.x - ob.x, y: r.y - ob.y, w: r.width, h: r.height });
  return { ov, wb: rel(wb), win: rel(b), screenH: ob.height };
}

function fxEnd(kind) {
  trace(`fxEnd ${kind}`); setTimeout(traceSave, 900);
  clearTimeout(fx.timer);
  const ov = overlay && !overlay.isDestroyed() ? overlay : null;
  if (kind === "close") {
    const w = widget;
    let gone = false;
    // one tick again: the widget (already up and painted, on the same frame) turns on as the overlay turns off; the overlay is hidden for real a moment later
    const swap = () => {
      if (gone) return; gone = true; fx.ack = null;
      trace(`swap: widget soft=${widgetSoft}`);
      if (widgetSoft) softShowWidget();
      w?.webContents.send("resume");                          // the loop carries on from the very frame that was on screen
      // Windows: two changes to the layered overlay in a row (opacity, then hide) are two re-compositions of a display-sized window; one is enough, and the widget under it is already painted
      if (process.platform === "win32") ovIdle(ov);
      else { ov?.setOpacity(0); fx.hideTimer = setTimeout(() => ov?.hide(), 150); }
    };
    if (w && widgetSoft) swap();
    else if (w) {
      // it had been hidden for real (the x): show it, wait until it is on screen and painted, then swap
      w.webContents.send("restart");
      const go = () => setTimeout(swap, 180);
      if (w.isVisible()) go(); else { w.once("show", go); showWidget(); }
      setTimeout(swap, 700);
    } else swap();
  } else ovIdle(ov);
  fx.busy = false; fx.dir = null;
}

function fxAbort() {
  trace("fxAbort"); setTimeout(traceSave, 300);
  const dir = fx.dir;
  ovIdle(overlay); fx.busy = false; fx.dir = null; clearTimeout(fx.timer);
  if (dir === "close") { win?.hide(); win?.setOpacity(1); showWidget(); widget?.webContents.send("resume"); } else if (win) revealSimple();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A short record of what the windows did during the last fold (written to <app data>/fold-trace.txt), so a glitch seen on another computer can be read from the real order of events.
const traceLog = []; let traceT0 = 0;
const trace = (m) => { const n = Date.now(); if (!traceLog.length || n - traceT0 > 6000) { traceLog.length = 0; traceT0 = n; } traceLog.push(`${String(n - traceT0).padStart(5)} ms  ${m}`); if (traceLog.length > 80) traceLog.shift(); };
const traceSave = () => { try { fs.writeFileSync(path.join(app.getPath("userData"), "fold-trace.txt"), traceLog.join("\n") + "\n"); } catch { /* ignore */ } };
const watchWin = (w, name) => { for (const ev of ["show", "hide", "focus", "blur", "minimize", "restore"]) w.on(ev, () => trace(`${name} ${ev}`)); };
/** A picture of the window as it looks right now, for the card that folds into / grows out of the folder (an invisible show if it is hidden). */
/** What the snapshot card is made of (size, display scale, transparency at the corners): written to the trace. */
function snapInfo(i) {
  try {
    const sz = i.getSize(), bm = i.toBitmap(), px = (x, y) => { const o = (y * sz.width + x) * 4; return `a${bm[o + 3]} rgb(${bm[o + 2]},${bm[o + 1]},${bm[o]})`; };
    const b = win.getBounds(), sf = screen.getDisplayMatching(b).scaleFactor;
    trace(`snapshot ${sz.width}x${sz.height}px, window ${b.width}x${b.height} at scale ${sf}; corner(1,1) ${px(1, 1)}; centre ${px(sz.width >> 1, sz.height >> 1)}; bottom-right(-3,-3) ${px(sz.width - 3, sz.height - 3)}; right-edge ${px(sz.width - 5, sz.height >> 1)}`);
  } catch (e) { trace("snapshot info failed: " + e.message); }
}
async function snapshotWin() {
  const was = win.isVisible();
  if (!was) { win.setOpacity(0); win.showInactive(); await sleep(160); }
  let img = "";
  try { img = await Promise.race([win.webContents.capturePage().then((i) => { snapInfo(i); return i.toDataURL(); }), sleep(450).then(() => "")]); } catch { /* plain card */ }
  if (!was) { win.hide(); win.setOpacity(1); }
  return img;
}

async function fxOpen(debug) {
  const g = fxGeometry();
  if (!g || fx.busy || !widget?.isVisible()) return false;
  clearTimeout(fx.hideTimer); clearTimeout(fx.timer); fx.busy = true; fx.dir = "open"; const id = (fx.id = ++fx.run);
  let t = 0;
  try { t = await widget.webContents.executeJavaScript("window.__anim?.clock?.() ?? 0"); } catch { /* start from the resting pose */ }
  if (!fx.snap) fx.snap = await snapshotWin();
  const img = fx.snap;   // the window as it was when it was last folded away: the card that unfolds into it shows the real home screen, not a blank sheet
  g.ov.webContents.send("fx", { id, dir: "open", wb: g.wb, win: g.win, screenH: g.screenH, t, img, flip, phys, soft: fx.soft, shadow, debug });
  fx.timer = setTimeout(fxAbort, 4000);
  return true;
}

async function fxClose(debug, hold) {
  const g = fxGeometry();
  if (!g || fx.busy) return false;
  clearTimeout(fx.hideTimer); clearTimeout(fx.timer); fx.busy = true; fx.dir = "close"; const id = (fx.id = ++fx.run);
  // a snapshot of the window becomes the card that shrinks into the folder (kept, so the next opening can use it too)
  const img = await snapshotWin();
  if (id !== fx.id) return false;                                // disarmed / replaced while the snapshot was being taken
  if (img) fx.snap = img;
  g.ov.webContents.send("fx", { id, dir: "close", wb: g.wb, win: g.win, screenH: g.screenH, t: 0, img, flip, phys, soft: fx.soft, shadow, debug });
  if (!hold) fx.timer = setTimeout(fxAbort, 4000);
  return true;
}

// ── fold prepared in advance ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Building the snapshot card takes ~150 ms, which used to be dead time between the click and anything happening. The pointer going down on a fold button (or Cmd/Ctrl
// being pressed) is the warning, so the snapshot is prepared then, the overlay waits invisible, and the click only has to flip the switch.
function prefold() {
  trace("prefold");
  if (!fxWanted() || !win?.isVisible() || fx.busy || fx.armed || !widget) return;
  const a = (fx.armed = { ready: false, committed: false, pending: false, bounds: win.getBounds(), timer: null });
  a.timer = setTimeout(() => disarm(a), 1500);                 // nothing came of it: drop it (the window may have changed since)
  fxClose(false, true).then((ok) => { if (!ok && fx.armed === a) { clearTimeout(a.timer); fx.armed = null; } });
}
function disarm(a) {
  if (fx.armed !== a || a.committed) return;
  clearTimeout(a.timer); fx.armed = null; fx.id = ++fx.run;   // a late "ready" from the abandoned run is ignored
  clearTimeout(fx.timer); ovIdle(overlay); fx.busy = false; fx.dir = null;
}

/** The overlay is up (invisible) with the card standing exactly on the window. Switch: overlay on first, window off a couple of frames later (never a gap), then play. */
function commitClose(a) {
  trace("commitClose");
  if (a) { a.committed = true; clearTimeout(a.timer); fx.armed = null; }
  clearTimeout(fx.timer); fx.timer = setTimeout(fxAbort, 4000);
  overlay.setOpacity(1); trace("overlay opacity 1");
  // Windows composes a see-through window that was shown at opacity 0 late: its first visible frame can arrive a few frames after setOpacity(1). If the real window leaves
  // before that, there is a gap (the "blink" before the fold). There the window stays a little longer under the (identical) card, and the fold starts after it has gone.
  const leave = process.platform === "win32" ? 130 : 34, go = process.platform === "win32" ? 160 : 50;
  setTimeout(() => { if (win) { win.setOpacity(0); win.hide(); win.setOpacity(1); } widget?.webContents.send("restart"); }, leave);
  setTimeout(() => overlay?.webContents.send("fx-go"), go);
}

// the overlay has drawn its first frame in the exact pose of what it replaces: put it on screen, swap the real window out, then let it play
ipcMain.on("fx-ready", (_e, id) => {
  trace(`overlay page ready (dir=${fx.dir})`);
  if (id !== fx.id || !fx.busy || !overlay) return;
  clearTimeout(fx.hideTimer);
  overlay.setOpacity(0); if (!OV_KEEP || !overlay.isVisible()) overlay.showInactive();           // up but invisible: it gets a moment to paint before it takes over (Windows: already up, see OV_KEEP)
  const a = fx.armed;
  if (a && !a.committed) { a.ready = true; if (a.pending) commitClose(a); return; }   // a prepared fold waits for the click
  if (fx.dir === "close") { setTimeout(() => commitClose(null), 50); return; }
  // Opening: the hand-over of the drawer is ONE tick: the overlay turns on and the widget turns off together. Never both on screen at once (two identical drawings
  // stacked make the anti-aliased edges heavier and the white shapes glow, and they snap back when one leaves) and never neither (a blink).
  setTimeout(() => { overlay.setOpacity(1); softHideWidget(); }, 50);
  setTimeout(() => {
    // switch the real window on now, fully transparent and click-through, so it has already painted when the card lands on it
    if (win) { win.setIgnoreMouseEvents(true); win.setOpacity(0); win.showInactive(); }
    overlay?.webContents.send("fx-go");
  }, 80);
});
// the card has landed exactly on the window: make the window opaque beneath it (the overlay removes the card a moment later, with no cross-fade)
ipcMain.on("fx-reveal", (_e, id) => { if (id === fx.id && fx.busy && fx.dir === "open" && win) { win.setOpacity(1); win.setIgnoreMouseEvents(false); raise(win); fx.busy = false; } });   // the window is up and usable from here: a fold started now just takes over from the opening
// the window is up and usable (the drawer is still falling away behind it): clicks on its buttons must work now, not 0.3 s later
ipcMain.on("fx-settled", (_e, id) => { if (id === fx.id && fx.dir === "open") fx.busy = false; });
ipcMain.on("widget-painted", () => { const f = fx.ack; fx.ack = null; f?.(); });
ipcMain.on("fx-done", (_e, id) => { if (id === fx.id) fxEnd(fx.dir); });
ipcMain.on("prefold", () => prefold());

function create() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(1010, workArea.width - 40), h = Math.min(780, workArea.height - 40);
  win = new BrowserWindow({
    width: w, height: h, minWidth: 620, minHeight: 520,
    x: workArea.x + Math.round((workArea.width - w) / 2), y: workArea.y + Math.round((workArea.height - h) / 2),
    icon: ICON,
    frame: false, transparent: true, hasShadow: false, backgroundColor: "#00000000",
    show: false, fullscreenable: false, acceptFirstMouse: true,   // an ordinary window: clicking another app brings that app forward (only the widget floats above everything)
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  allSpaces(win);
  watchWin(win, "window");
  win.loadURL(URL);
  win.webContents.on("did-finish-load", () => win?.webContents.invalidate()); // repaint the transparent window from scratch
  win.webContents.on("before-input-event", (e, i) => {
    // Cmd/Ctrl going down is the warning for Cmd+M / Cmd+W: prepare the fold now. Any other key means it was something else (copy, paste...): drop it, the window is about to change.
    if (i.type === "keyDown") {
      if (i.key === "Meta" || i.key === "Control") prefold();
      else if (fx.armed && !fx.armed.committed && !fx.armed.pending && !["m", "w"].includes(i.key.toLowerCase())) disarm(fx.armed);
    }
  });
  win.webContents.on("did-finish-load", () => { win?.webContents.send("shadow", shadow); win?.webContents.send("openstyle", openStyle); win?.webContents.send("folderstyle", folderStyle); win?.webContents.send("infinite", infinite); win?.webContents.send("scrollfeel", scrollFeel); win?.webContents.send("autoscroll", autoScroll); });
  win.webContents.on("render-process-gone", async () => { await ensureServer(); win?.loadURL(URL); });
  win.once("ready-to-show", () => expand());
  win.on("moved", saveWin); win.on("resized", saveWin);
  win.on("closed", () => (win = null));
  if (process.env.SLEEPY_SMOKE) {
    win.webContents.on("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 2500));
      fs.writeFileSync(process.env.SLEEPY_SMOKE, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

const toggle = () => {
  if (!win) return expand();
  if (!win.isVisible()) return expand();
  // Cmd/Ctrl going down has already prepared the fold (the window counts as "busy" until it is used or dropped): that prepared fold is exactly what this press asks for
  const prepared = fx.armed && !fx.armed.committed;
  if (fx.busy && !prepared) return;        // mid launch / fold: extra presses are ignored instead of stacking effects
  collapse();
};
/** Pull the open window to the front (a window buried under others); closed, it just opens. */
function focusYab() {
  if (fx.busy) return;
  if (win?.isVisible()) raise(win); else expand();
}

ipcMain.on("win", (_e, action) => {
  if (!win) return;
  if (action === "hide" || action === "minimize") collapse();
  if (action === "zoom") toggleZoom();
});

// the icon: dragged by hand (a drag region would swallow the click), so a press that barely moves is a click
let drag = null;
// The widget menu stays up while settings are changed: a native menu always closes after a click, so after every setting it is shown again in the same place. It ends when "Quit settings"
// is chosen, when something else is chosen (open, hide, quit, a shortcut prompt), or when you click away from it.
let menuStay = false, lastMenu = null, menuPops = 0;
const ends = (fn) => Object.assign(fn, { ends: true });
function keepOpen(items) {
  return items.map((it) => {
    const n = { ...it };
    if (n.submenu) n.submenu = keepOpen(n.submenu);
    if (n.click && !n.click.ends) { const c = n.click; n.click = (...a) => { menuStay = true; return c(...a); }; }
    return n;
  });
}
function showWidgetMenu(x, y) {
  if (!widget) return;
  staging = true;   // from the first showing until the menu is left, choices are staged
  menuStay = false; menuPops++;
  lastMenu = Menu.buildFromTemplate(keepOpen([
    { label: "Open Yab", click: ends(expand) },
    { label: "Hide widget", click: ends(() => hideWidget()) },
    ...effectItems(),
    { label: "Resize widget", submenu: SIZES.map(([label, v]) => ({ label, type: "radio", checked: Math.abs(scale - v) < 0.01, click: () => setScale(v) })) },
    { type: "separator" },
    { label: "Quit settings", click: ends(() => {}) },
    { label: "Quit Yab", click: ends(() => app.quit()) },
  ]));
  lastMenu.popup({ window: widget, x, y, callback: () => {
    if (menuStay && widget) { menuStay = false; setTimeout(() => showWidgetMenu(x, y), 40); return; }
    staging = false; flush();   // the menu was left (Quit settings, an action, or a click away): apply everything chosen
  } });
}
ipcMain.on("widget", (e, msg) => {
  if (!widget || e.sender !== widget.webContents) return;
  if (msg.type === "down") { const b = widget.getBounds(); drag = { x: b.x, y: b.y, w: b.width, h: b.height, sx: msg.sx, sy: msg.sy, moved: false }; }
  else if (msg.type === "move" && drag) {
    const dx = msg.sx - drag.sx, dy = msg.sy - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) widget.setBounds({ x: Math.round(drag.x + dx), y: Math.round(drag.y + dy), width: drag.w, height: drag.h }); // always the same size: setPosition makes the window creep bigger on scaled Windows displays
  } else if ((msg.type === "up" || msg.type === "cancel") && drag) { const d = drag, moved = d.moved; drag = null; if (moved) { widget.setBounds({ ...widget.getBounds(), width: d.w, height: d.h }); savePos(); } else if (msg.type === "up") expand(); }
  else if (msg.type === "menu") {
    const cp = screen.getCursorScreenPoint(), wb = widget.getBounds();
    showWidgetMenu(Math.round(cp.x - wb.x), Math.round(cp.y - wb.y));
  } else if (msg.type === "close") { drag = null; hideWidget(); hiddenNotice(); } // × on the widget: hide it, the app stays in the Dock / taskbar
});

// Windows: with the widget and the window both hidden there is no taskbar button, only the tray icon (which Windows tucks into the overflow). Say so once, so it doesn't look like the app quit.
let noticed = false;
function hiddenNotice() {
  if (process.platform !== "win32" || noticed || win?.isVisible() || !tray) return;
  noticed = true;
  try { tray.displayBalloon({ title: "Yab is still running", content: "Click the Yab icon in the tray (or open Yab again) to bring the widget back.", iconType: "info" }); } catch { /* ignore */ }
}
app.on("second-instance", () => { if (win?.isVisible()) raise(win); else if (widget?.isVisible() && !widgetSoft) expand(); else showWidget(); });

app.whenReady().then(async () => {
  if (!GOT_LOCK) return;
  nativeTheme.themeSource = "light"; // the UI is light-only; ignore the desktop dark theme
  app.setName("Yab");
  if (process.platform === "darwin" && !ICON.isEmpty()) app.dock?.setIcon(ICON);
  // the Dock / taskbar icon is the app's own icon; the menu on it brings the widget or the window back
  if (process.platform !== "darwin") { tray = new Tray(ICON_PNG.resize({ width: 32, height: 32 })); tray.setToolTip("Yab"); tray.on("click", () => (win?.isVisible() ? raise(win) : showWidget())); }
  refreshMenus();
  await ensureServer();
  if (!ocrOn) pushOcr();   // the server reads images unless told otherwise
  if (aiLevel !== 2) apiCall("PUT", "/v1/ai", { level: aiLevel }).catch(() => {});
  if (aiMode === "offline") apiCall("PUT", "/v1/ai", { mode: "offline" }).catch(() => {});
  createWidget();
  refreshMenus();
  // warm the launch overlay up so the first launch is instant, but only after the widget has had a few seconds of undisturbed first frames (building a second window at the same moment made the first loops stutter)
  if (fxWanted()) setTimeout(() => { if (fxWanted() && !fx.busy) ensureOverlay(); }, 4000);
  if (process.env.SLEEPY_SMOKE) create();
  if (process.env.YAB_TEST) runTest();
  if (process.env.YAB_FXTEST) runFxTest();
  if (process.env.YAB_HANDOFF) runHandoffTest();
  if (process.env.YAB_ALIGN) runAlignTest();
  if (process.env.YAB_CATCH) runCatchTest();
  if (process.env.YAB_SHARP) runSharpTest();
  if (process.env.YAB_FOLD) runFoldTest();
  if (process.env.YAB_FOLD2) runFold2Test();
  if (process.env.YAB_CARD) runCardTest();
  if (process.env.YAB_PRESET) runPresetTest();
  if (process.env.YAB_CPU) runCpuTest();
  if (process.env.YAB_KEYTEST) runKeyTest();
  if (process.env.YAB_MENUTEST) runMenuTest();
  registerToggle(); // the show / hide hotkey (Alt+Space by default; on Windows that is the system window menu, so Ctrl+Alt+Space there)
});
// clicking the Dock icon: show the window if it is up, else bring the widget back (expand it if it is already showing)
app.on("activate", () => { if (win?.isVisible()) raise(win); else if (widget?.isVisible()) expand(); else showWidget(); });
app.on("window-all-closed", () => {});
app.on("will-quit", () => { globalShortcut.unregisterAll(); server?.kill(); });

// YAB_TEST=1: drive the icon with synthetic mouse events and report what happened
async function runTest() {
  const log = (...a) => console.log("[test]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  const fire = (t, x, y) => widget.webContents.executeJavaScript(`document.body.dispatchEvent(new PointerEvent(${JSON.stringify("pointer" + t.slice(5))},{pointerId:1,button:0,buttons:${t === "mouseup" ? 0 : 1},screenX:${x},screenY:${y},bubbles:true}))`);
  const b0 = widget.getBounds(); log("widget visible", widget.isVisible(), "at", b0.x, b0.y, "size", b0.width, b0.height, "main visible", !!win?.isVisible());
  await fire("mousedown", 500, 500); await fire("mousemove", 450, 420); await fire("mouseup", 450, 420); await sleep(200);
  const b1 = widget.getBounds(); log("after drag", b1.x, b1.y, "(moved", b1.x - b0.x, b1.y - b0.y, ") size", b1.width + "x" + b1.height, "main visible", !!win?.isVisible());
  await fire("mousedown", 500, 500); await fire("mouseup", 500, 500); await sleep(1500);
  log("after click: main visible", !!win?.isVisible(), "widget visible", widget.isVisible(), "main at", JSON.stringify(win?.getBounds()));
  await sleep(3000);
  fs.writeFileSync(process.env.YAB_TEST_SHOT, (await win.webContents.capturePage()).toPNG());
  win.setPosition(210, 140); await sleep(500);                       // the user drags the window somewhere
  ipcMain.emit("win", {}, "hide"); await sleep(250);
  try { fs.writeFileSync(process.env.YAB_TEST_SHOT + ".genie.png", (await win.webContents.capturePage()).toPNG()); } catch {}
  await sleep(4300);
  fs.writeFileSync(process.env.YAB_TEST_SHOT + ".widget.png", (await widget.webContents.capturePage()).toPNG());
  log("collapsed: main visible", win.isVisible(), "widget visible", widget.isVisible(), "widget size", JSON.stringify(widget.getBounds()));
  log("saved file:", fs.existsSync(winFile) ? fs.readFileSync(winFile, "utf8") : "none");
  await fire("mousedown", 5, 5); await fire("mouseup", 5, 5); await sleep(800);
  log("re-expanded at", JSON.stringify(win.getBounds()), "(dragged to 210,140)");
  ipcMain.emit("win", {}, "hide"); await sleep(1300);
  log("widget before close:", widget.isVisible());
  await widget.webContents.executeJavaScript('document.getElementById("x").click()'); await sleep(300);
  log("after × : widget visible", widget.isVisible(), "main visible", win.isVisible(), "app still running, windows alive:", BrowserWindow.getAllWindows().length);
  app.emit("activate"); await sleep(600);
  log("after Dock click: widget visible", widget.isVisible());
  for (const [name, v] of SIZES) { setScale(v); await sleep(150); const b = widget.getBounds(); log("resize", name, v, "->", b.width + "x" + b.height, "at", b.x, b.y); }
  setScale(1.4); await sleep(100); log("saved scale:", fs.readFileSync(pos.file, "utf8"));
  app.quit();
}

// YAB_FXTEST=1: play the launch effect from two widget positions/sizes, capture frames of the overlay, and check the windows end up right
async function runFxTest() {
  const log = (...a) => console.log("[fx]", ...a);
  const out = process.env.YAB_FXTEST_DIR;
  fx.on = true; ensureOverlay();
  overlay.webContents.on("console-message", (_e, level, msg, line, src) => log("overlay console:", msg, src && src.split("/").pop() + ":" + line));
  for (const ev of ["fx-ready", "fx-reveal", "fx-done"]) ipcMain.on(ev, () => log("ipc", ev, "dir", fx.dir));
  await sleep(2500);
  create(); await sleep(5000);                                          // creating the window opens it, which is itself a launch from the default spot
  log("first launch from the default spot: window visible", win.isVisible(), "widget visible", widget.isVisible(), "overlay visible", overlay.isVisible(), "busy", fx.busy);
  Menu.buildFromTemplate([...effectItems()]); log("menu template ok; main window always-on-top:", win.isAlwaysOnTop(), "; shortcuts:", Menu.getApplicationMenu().items.flatMap((i) => i.submenu?.items ?? []).filter((i) => i.accelerator).map((i) => i.accelerator).join(" "));
  collapse(); await sleep(3000);
  log("first fold: window visible", win.isVisible(), "widget visible", widget.isVisible(), "overlay visible", overlay.isVisible(), "busy", fx.busy);
  const spots = [{ name: "br", x: 1180, y: 520, scale: 1 }, { name: "tl", x: 60, y: 60, scale: 0.65 }, { name: "brF", x: 1180, y: 520, scale: 1, flip: true }, { name: "tlF", x: 60, y: 60, scale: 0.65, flip: true }, { name: "tlP", x: 60, y: 60, scale: 0.65, phys: { g: 1.5, speed: 0.7, spin: 2, kick: 1.8 } }];
  for (const sp of spots) {
    flip = !!sp.flip; widget.webContents.send("flip", flip); phys = { ...DEFAULT_PHYS, ...(sp.phys || {}) };
    widget.setBounds({ x: sp.x, y: sp.y, width: Math.round(WIDGET_W * sp.scale), height: Math.round(WIDGET_H * sp.scale) }); scale = sp.scale; widget.showInactive(); await sleep(700);
    win.setBounds({ x: 330, y: 40, width: 1010, height: 741 });
    if (sp.flip) fs.writeFileSync(`${out}/widget-${sp.name}.png`, (await widget.webContents.capturePage()).toPNG());
    for (const dir of ["open", "close"]) {
      if (dir === "close") { win.setOpacity(1); win.show(); await sleep(500); }
      const ok = dir === "open" ? await fxOpen(true) : await fxClose(true);
      if (!ok) { log("refused", sp.name, dir); continue; }
      await sleep(1200);
      const p = await overlay.webContents.executeJavaScript("window.__fx"); if (dir === "open") log(sp.name, "Tf", p.Tf.toFixed(2), "Tx", p.Tx.toFixed(2), "omega", p.omega.toFixed(2), "v0", p.v0.map((v) => Math.round(v)));
      const taus = [-0.14, -0.07, 0, 0.1, 0.2, 0.3, 0.4, 0.5, p.Tf - 0.05, p.Tf + 0.05, p.Tf + 0.2, p.Tx - 0.25];
      for (const [i, tau] of taus.entries()) {
        await overlay.webContents.executeJavaScript(`window.__seek(${tau})`); await sleep(160);
        fs.writeFileSync(`${out}/${sp.name}-${dir}-${String(i).padStart(2, "0")}.png`, (await overlay.webContents.capturePage()).toPNG());
      }
      fxAbort(); await sleep(300);
    }
    // the real thing, in real time
    win.hide(); widget.showInactive(); await sleep(400);
    expand(); await sleep(2300);
    if (sp.name === "br") { log("Cmd+M"); Menu.getApplicationMenu().getMenuItemById("fold").click(); await sleep(2200); log("after Cmd+M: window visible", win.isVisible(), "widget visible", widget.isVisible()); expand(); await sleep(2300); }
    log(sp.name, "real open: window visible", win.isVisible(), "opacity", win.getOpacity(), "widget visible", widget.isVisible(), "overlay visible", overlay.isVisible(), "busy", fx.busy);
    collapse(); await sleep(2300);
    log(sp.name, "real close: window visible", win.isVisible(), "widget visible", widget.isVisible(), "overlay visible", overlay.isVisible(), "busy", fx.busy);
  }
  app.quit();
}


// YAB_HANDOFF=1: a few open / close cycles with a timeline of what happens to the widget and the overlay around the end of the close
async function runHandoffTest() {
  const ev = []; let t0 = 0; const T = () => Date.now() - t0;
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500); collapse(); await sleep(3000);
  const wrap = (obj, name, label) => { const o = obj[name].bind(obj); obj[name] = (...a) => { ev.push([T(), label + (a.length && typeof a[0] !== "object" ? "(" + a[0] + ")" : "")]); return o(...a); }; };
  wrap(widget, "hide", "widget.hide"); wrap(widget, "showInactive", "widget.showInactive"); wrap(widget, "setOpacity", "widget.setOpacity"); wrap(overlay, "hide", "overlay.hide"); wrap(overlay, "setOpacity", "overlay.setOpacity"); wrap(win, "setOpacity", "win.setOpacity"); wrap(overlay, "showInactive", "overlay.show");
  const ws = widget.webContents, send = ws.send.bind(ws); ws.send = (ch, ...a) => { if (["restart", "resume"].includes(ch)) ev.push([T(), "widget<-" + ch]); return send(ch, ...a); };
  for (let i = 1; i <= 2; i++) {
    ev.length = 0; t0 = Date.now(); expand(); await sleep(2600);
    console.log(`[handoff] cycle ${i} OPEN: ` + ev.map(([t, e]) => `${t}ms ${e}`).join(" | "));
    ev.length = 0; t0 = Date.now(); collapse(); await sleep(2400);
    console.log(`[handoff] cycle ${i}: window visible=${win.isVisible()} widget visible=${widget.isVisible()} opacity=${widget.getOpacity()} soft=${widgetSoft} overlay visible=${overlay.isVisible()} busy=${fx.busy}`);
    console.log("[handoff]   " + ev.map(([t, e]) => `${t}ms ${e}`).join(" | "));
  }
  app.quit();
}

// YAB_ALIGN=1 (measurement only): does the overlay draw the drawer exactly where the widget draws it, at the end of a close?
async function runAlignTest() {
  const log = (...a) => console.log("[align]", ...a);
  const { execFileSync } = require("node:child_process");
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500); collapse(); await sleep(3000);
  const spots = [{ x: 1180, y: 520, scale: 1 }, { x: 300, y: 200, scale: 0.65 }];
  const bboxOf = (png) => JSON.parse(execFileSync("python3", ["-c", `
import sys,json
from PIL import Image
im=Image.open(sys.argv[1]).convert("RGBA"); a=im.split()[3].point(lambda v:255 if v>40 else 0); print(json.dumps(a.getbbox()))`, png]).toString());
  for (const sp of spots) {
    widget.setBounds({ x: sp.x, y: sp.y, width: Math.round(WIDGET_W * sp.scale), height: Math.round(WIDGET_H * sp.scale) }); scale = sp.scale; widget.showInactive(); await sleep(700);
    win.setBounds({ x: 330, y: 40, width: 1010, height: 741 }); win.setOpacity(1); win.show(); await sleep(500);
    const disp = screen.getDisplayMatching(widget.getBounds()).bounds;
    const before = (ensureOverlay(), overlay.getBounds());
    await fxClose(true); await sleep(1200);
    const ob = overlay.getBounds();
    log("display bounds", JSON.stringify(disp), "| overlay asked:", JSON.stringify(disp), "got after show:", JSON.stringify(ob), "| display scale", screen.getDisplayMatching(ob).scaleFactor);
    const wbd = widget.getBounds(), K = screen.getDisplayMatching(wbd).scaleFactor;
    fs.writeFileSync(`${process.env.YAB_FXTEST_DIR}/align-widget.png`, (await widget.webContents.capturePage()).toPNG());
    const p = await overlay.webContents.executeJavaScript("window.__fx");
    await overlay.webContents.executeJavaScript(`window.__seek(${-0.14})`); await sleep(250);
    fs.writeFileSync(`${process.env.YAB_FXTEST_DIR}/align-overlay.png`, (await overlay.webContents.capturePage()).toPNG());
    const bw = bboxOf(`${process.env.YAB_FXTEST_DIR}/align-widget.png`), bo = bboxOf(`${process.env.YAB_FXTEST_DIR}/align-overlay.png`);
    // both to screen coordinates (DIP)
    const sw = [wbd.x + bw[0] / K, wbd.y + bw[1] / K, wbd.x + bw[2] / K, wbd.y + bw[3] / K], so = [ob.x + bo[0] / K, ob.y + bo[1] / K, ob.x + bo[2] / K, ob.y + bo[3] / K];
    log(`widget ${wbd.width}x${wbd.height} at (${wbd.x},${wbd.y}): drawer on screen (widget) ${sw.map((v) => v.toFixed(1))}  (overlay) ${so.map((v) => v.toFixed(1))}  -> difference ${sw.map((v, i) => (so[i] - v).toFixed(1))}`);
    log("end-of-close speeds at the catch (px/s): drawer", Math.hypot(...p.vd).toFixed(0), "folder", Math.hypot(...p.v0).toFixed(0), "| drawer spin", p.omega.toFixed(2), "rad/s");
    fxAbort(); await sleep(500);
  }
  app.quit();
}

// YAB_CATCH=1 (measurement only): speeds of the folder and the drawer through the end of the closing
async function runCatchTest() {
  const log = (...a) => console.log("[catch]", ...a);
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500); collapse(); await sleep(3000);
  for (const sp of [{ x: 1180, y: 520, scale: 1, soft: false }, { x: 1180, y: 520, scale: 1, soft: true }]) {
    fx.soft = sp.soft;
    widget.setBounds({ x: sp.x, y: sp.y, width: Math.round(WIDGET_W * sp.scale), height: Math.round(WIDGET_H * sp.scale) }); scale = sp.scale; widget.showInactive(); await sleep(700);
    win.setBounds({ x: 330, y: 40, width: 1010, height: 741 }); win.setOpacity(1); win.show(); await sleep(500);
    await fxClose(true); await sleep(1200);
    const r = await overlay.webContents.executeJavaScript("window.__catch()");
    const o = r.out, last = o.slice(-40);
    log(`soft landing ${sp.soft ? "ON " : "OFF"}: closing lasts ${r.total.toFixed(2)} s. speed (px/s) folder / drawer over the last 40 frames (every 4th):`);
    log("   " + last.filter((_, i) => i % 4 === 0).map((x) => `${x.v.toFixed(0)}/${x.vd.toFixed(0)}`).join("  "));
    const peak = Math.max(...o.map((x) => x.v)), accJump = Math.max(...o.slice(1).map((x, i) => Math.abs(x.v - o[i].v)));
    log(`   peak folder speed ${peak.toFixed(0)}; biggest speed change in one frame ${accJump.toFixed(0)} px/s; final speeds ${o[o.length - 1].v.toFixed(1)} / ${o[o.length - 1].vd.toFixed(1)}`);
    fxAbort(); await sleep(500);
  }
  app.quit();
}

// YAB_SHARP=1 (measurement only): is the drawer drawn by the overlay as crisp as the one the widget draws itself?
async function runSharpTest() {
  const log = (...a) => console.log("[sharp]", ...a);
  const { execFileSync } = require("node:child_process");
  const out = process.env.YAB_FXTEST_DIR;
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500); collapse(); await sleep(3000);
  widget.setBounds({ x: 1180, y: 520, width: WIDGET_W, height: WIDGET_H }); scale = 1; widget.showInactive(); await sleep(700);
  win.setBounds({ x: 330, y: 40, width: 1010, height: 741 }); win.setOpacity(1); win.show(); await sleep(500);
  // the widget on its own, standing on its resting frame
  await widget.webContents.executeJavaScript("window.__anim.hold(0)"); await sleep(300);
  fs.writeFileSync(`${out}/sharp-widget.png`, (await widget.webContents.capturePage()).toPNG());
  await fxClose(true); await sleep(1200);
  const cap = async (name) => { await sleep(250); fs.writeFileSync(`${out}/sharp-${name}.png`, (await overlay.webContents.capturePage()).toPNG()); };
  await overlay.webContents.executeJavaScript("window.__seek(-0.14)"); await cap("overlay-rest");
  // same picture, same instant, but with the sort of sub-pixel offset and tiny turn the drawer has while it is moving
  await overlay.webContents.executeJavaScript(`document.querySelectorAll("#stage > div").forEach((d) => { if (d.style.zIndex === "1" || d.style.zIndex === "3") { d.style.transformOrigin = "50% 50%"; d.style.transform = "translate(0.37px,0.41px) rotate(0.004rad)"; } })`); await cap("overlay-moving");
  const score = (f, box) => JSON.parse(execFileSync("python3", ["-c", `
import sys,json
from PIL import Image, ImageFilter
import numpy as np
im=Image.open(sys.argv[1]).convert("RGBA"); a=np.array(im)
alpha=a[...,3]>40; ys,xs=np.where(alpha)
x0,x1,y0,y1=xs.min(),xs.max(),ys.min(),ys.max()
g=np.array(im.convert("L"),dtype=float)[y0:y1,x0:x1]
lap=g[1:-1,1:-1]*4-g[:-2,1:-1]-g[2:,1:-1]-g[1:-1,:-2]-g[1:-1,2:]
# share of dark-outline pixels that sit on a hard edge (the softer the picture, the more of the line is mid-grey)
mid=((g>60)&(g<190)).mean()
print(json.dumps({"lapvar":round(float(lap.var()),1),"midgrey_share":round(float(mid),4),"w":int(x1-x0),"h":int(y1-y0)}))`, f]).toString());
  for (const n of ["widget", "overlay-rest", "overlay-moving"]) log(n.padEnd(15), JSON.stringify(score(`${out}/sharp-${n}.png`)));
  fxAbort(); await sleep(300); app.quit();
}

// YAB_FOLD=1 (measurement only): what happens, and when, between clicking minimise and the overlay taking over
async function runFoldTest() {
  const ev = []; let t0 = 0; const T = () => Date.now() - t0;
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500);
  const wrapWC = (wc, name, label) => { const o = wc[name].bind(wc); wc[name] = (...a) => { ev.push([T(), label + " start"]); const r = o(...a); if (r?.then) return r.then((x) => { ev.push([T(), label + " done"]); return x; }); return r; }; };
  wrapWC(win.webContents, "capturePage", "capturePage(window)");
  const w2 = (obj, name, label) => { const o = obj[name].bind(obj); obj[name] = (...a) => { ev.push([T(), label + (a.length && typeof a[0] !== "object" ? "(" + a[0] + ")" : "")]); return o(...a); }; };
  w2(overlay, "setOpacity", "overlay.setOpacity"); w2(overlay, "showInactive", "overlay.show"); w2(win, "setOpacity", "win.setOpacity"); w2(win, "hide", "win.hide");
  ipcMain.on("fx-ready", () => ev.push([T(), "overlay page: ready"]));
  const send = overlay.webContents.send.bind(overlay.webContents); overlay.webContents.send = (ch, ...a) => { ev.push([T(), "-> overlay: " + ch]); return send(ch, ...a); };
  for (let i = 1; i <= 3; i++) {
    ev.length = 0; t0 = Date.now(); collapse(); await sleep(2600);
    console.log(`[fold] cycle ${i}: ` + ev.filter(([t]) => t < 700).map(([t, e]) => `${t}ms ${e}`).join(" | "));
    expand(); await sleep(2800);
  }
  app.quit();
}

// YAB_CARD=1 (measurement only): is the card that stands in for the window the same shape as the window?
async function runCardTest() {
  const log = (...a) => console.log("[card]", ...a);
  const { execFileSync } = require("node:child_process");
  const out = process.env.YAB_FXTEST_DIR;
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500);
  const b = win.getBounds(); const K = 2;
  fs.writeFileSync(`${out}/card-window.png`, (await win.webContents.capturePage()).toPNG());       // the live window, as the snapshot sees it
  await fxClose(true); await sleep(1200);
  const p = await overlay.webContents.executeJavaScript("window.__fx");
  await overlay.webContents.executeJavaScript(`window.__seek(${p.Tx})`); await sleep(300);          // the very first frame of the closing: the card standing exactly on the window
  fs.writeFileSync(`${out}/card-overlay.png`, (await overlay.webContents.capturePage()).toPNG());
  const res = JSON.parse(execFileSync("python3", ["-c", `
import sys,json
import numpy as np
from PIL import Image
w=np.array(Image.open(sys.argv[1]).convert("RGBA"))
o=np.array(Image.open(sys.argv[2]).convert("RGBA"))
b=json.loads(sys.argv[3]); K=int(sys.argv[4])
crop=o[b["y"]*K:(b["y"]+b["height"])*K, b["x"]*K:(b["x"]+b["width"])*K]
h=min(crop.shape[0],w.shape[0]); wd=min(crop.shape[1],w.shape[1]); crop=crop[:h,:wd]; w=w[:h,:wd]
wa=w[...,3]>20; ca=crop[...,3]>20
extra=ca & ~wa                      # the card covers it, the real window does not
missing=wa & ~ca
diff=np.abs(w[...,:3].astype(int)-crop[...,:3].astype(int)).sum(axis=2)
both=wa&ca
print(json.dumps({"window_px":int(wa.sum()),"card_px":int(ca.sum()),"card_covers_but_window_does_not":int(extra.sum()),"window_covers_but_card_does_not":int(missing.sum()),"mean_colour_error_where_both":round(float(diff[both].mean()),2) if both.any() else None}))`, `${out}/card-window.png`, `${out}/card-overlay.png`, JSON.stringify(b), String(K)]).toString());
  log(`window ${b.width}x${b.height}:`, JSON.stringify(res));
  fxAbort(); await sleep(300); app.quit();
}

// YAB_FOLD2=1: the situations that matter for minimising
async function runFold2Test() {
  const ev = []; let t0 = 0; const T = () => Date.now() - t0, log = (...a) => console.log("[fold2]", ...a);
  fx.on = true; ensureOverlay(); await sleep(2500);
  create(); await sleep(3500);
  const w2 = (obj, name, label) => { const o = obj[name].bind(obj); obj[name] = (...a) => { ev.push([T(), label + (a.length && typeof a[0] !== "object" ? "(" + a[0] + ")" : "")]); return o(...a); }; };
  w2(overlay, "setOpacity", "overlay.opacity"); w2(overlay, "showInactive", "overlay.show"); w2(overlay, "hide", "overlay.hide"); w2(win, "hide", "win.hide");
  const send = overlay.webContents.send.bind(overlay.webContents); overlay.webContents.send = (ch, ...a) => { if (ch === "fx-go") ev.push([T(), "go"]); return send(ch, ...a); };
  const show = () => ev.map(([t, e]) => `${t}ms ${e}`).join(" | ");
  const state = () => `window visible=${win.isVisible()} widget=${widget.isVisible()} (opacity ${widget.getOpacity()}) overlay=${overlay.isVisible()} busy=${fx.busy} armed=${!!fx.armed}`;
  // 1. a plain fold, no warning
  ev.length = 0; t0 = Date.now(); collapse(); await sleep(2600); log("1 plain fold:      ", show()); log("   ->", state());
  expand(); await sleep(2800);
  // 2. prepared: the pointer goes down, the click lands 120 ms later
  prefold(); await sleep(120); ev.length = 0; t0 = Date.now(); collapse(); await sleep(2600); log("2 prepared fold:   ", show()); log("   ->", state());
  expand(); await sleep(2800);
  // 3. prepared but abandoned
  prefold(); await sleep(1900); log("3 abandoned arm:   ", state());
  ev.length = 0; t0 = Date.now(); collapse(); await sleep(2600); log("   then a plain fold works:", state());
  // 4. minimise straight after opening (before the drawer has finished falling), prepared and not
  for (const prepared of [false, true]) {
    expand(); for (let i = 0; i < 100 && !(win.isVisible() && win.getOpacity() === 1 && !fx.busy); i++) await sleep(10);   // as soon as the window is really up
    await sleep(40);
    log(`4 minimise right after opening (${prepared ? "prepared" : "plain"}): before click ->`, state());
    if (prepared) { prefold(); await sleep(100); }
    ev.length = 0; t0 = Date.now(); collapse(); await sleep(2800);
    log("   fold:", show()); log("   ->", state());
  }
  app.quit();
}

// YAB_PRESET=1: the performance presets and the shadow switch
async function runPresetTest() {
  const log = (...a) => console.log("[preset]", ...a);
  create(); await sleep(5000); collapse(); await sleep(3000);
  widget.setBounds({ x: 1180, y: 520, width: WIDGET_W, height: WIDGET_H }); scale = 1; widget.showInactive(); await sleep(600);
  const fpsMeasure = () => widget.webContents.executeJavaScript(`new Promise((res) => { let n = 0; const mo = new MutationObserver(() => { n++; }); mo.observe(document.querySelector("#box"), { attributes: true }); setTimeout(() => { mo.disconnect(); res(n); }, 1000); })`);
  const looks = async () => ({
    widgetShadowShown: await widget.webContents.executeJavaScript('document.querySelector("#shadow").style.display !== "none"'),
    windowShadow: await win.webContents.executeJavaScript('getComputedStyle(document.querySelector(".window")).boxShadow !== "none"'),
  });
  for (const name of ["low", "balanced", "high"]) {
    applyPreset(name); await sleep(400);
    const f = await fpsMeasure(), l = await looks();
    log(`${name.padEnd(8)} -> detected "${currentPreset()}", launch effect ${fx.on ? "ON" : "off (fade)"}, physics ${JSON.stringify(phys)}, soft landing ${fx.soft}, widget shadow ${l.widgetShadowShown}, window shadow ${l.windowShadow}, widget loop measured at ${f} fps`);
    // a real open and close with these settings
    expand(); await sleep(fx.on ? 2800 : 900);
    const opened = `window visible=${win.isVisible()} opacity=${win.getOpacity()}`;
    collapse(); await sleep(fx.on ? 2800 : 900);
    log(`           open: ${opened} | after fold: window visible=${win.isVisible()} widget visible=${widget.isVisible()} opacity=${widget.getOpacity()} overlay=${overlay?.isVisible()} busy=${fx.busy}`);
  }
  // shadows by hand, and the preset reads "custom" once something is changed
  setShadow(false); await sleep(300); let l = await looks(); log(`shadows OFF -> widget ${l.widgetShadowShown}, window ${l.windowShadow}, preset now "${currentPreset()}"`);
  setShadow(true); await sleep(300); l = await looks(); log(`shadows ON  -> widget ${l.widgetShadowShown}, window ${l.windowShadow}, preset now "${currentPreset()}"`);
  setPhys("g", 1.5); log(`after changing gravity by hand -> preset "${currentPreset()}"`); setPhys("g", 1);
  log("menu builds:", Menu.buildFromTemplate(effectItems()).items.map((i) => i.label).join(" | "));
  app.quit();
}

// YAB_CPU=1 (measurement only): what the widget's page costs while it cannot be seen
async function runCpuTest() {
  const log = (...a) => console.log("[cpu]", ...a);
  create(); await sleep(6000);                                         // the window is open; the widget is invisible underneath
  const wpid = widget.webContents.getOSProcessId();
  const cpu = async (label) => {
    app.getAppMetrics(); await sleep(4000);                            // percentCPUUsage is since the previous call
    const mm = app.getAppMetrics(), w = mm.find((x) => x.pid === wpid);
    const gpu = mm.filter((x) => x.type === "GPU").reduce((s, x) => s + x.cpu.percentCPUUsage, 0);
    log(`${label.padEnd(42)} widget renderer CPU: ${w ? w.cpu.percentCPUUsage.toFixed(1) : "?"}%   GPU process: ${gpu.toFixed(1)}%`);
  };
  await cpu("window open, widget invisible underneath");
  collapse(); await sleep(3000);
  await cpu("widget showing (the normal idle loop)");
  hideWidget(); await sleep(500);
  await cpu("widget hidden with the x");
  app.quit();
}

// YAB_KEYTEST=1 (measurement only): the shortcut rules
async function runKeyTest() {
  const log = (...a) => console.log("[keys]", ...a), saveKeys = JSON.stringify(keys);
  const t = (id, a) => { const r = setKey(id, a); log(`${id} -> ${JSON.stringify(a)}:`, r.ok ? "ok" : "refused: " + r.error); };
  t("open", "CmdOrCtrl+O"); t("open", "CmdOrCtrl+Shift+O"); t("fold", "CmdOrCtrl+O"); t("fold", "M"); t("fold", "CmdOrCtrl+C"); t("fold", "CmdOrCtrl+Banana");
  t("close", ""); t("toggle", "Control+Alt+Y"); t("toggle", "Alt+Space");
  const items = Menu.getApplicationMenu().items.flatMap((i) => i.submenu.items);
  log("menu now:", items.filter((i) => i.label).map((i) => `${i.label}=${i.accelerator || "-"}`).join(" | "));
  log("global registered:", globalShortcut.isRegistered(acc("toggle")), acc("toggle"));
  keys = JSON.parse(saveKeys); registerToggle(); savePos(); refreshMenus();
  if (process.env.YAB_KEYSHOT) {   // the prompt itself: open it for one action, send a key from main, take a picture, check what was saved
    openKeys("fold"); await sleep(1200);
    fs.writeFileSync(process.env.YAB_KEYSHOT, (await keysWin.webContents.capturePage()).toPNG());
    keysWin.webContents.send("keys-input", { code: "KeyJ", key: "j", meta: true, control: false, alt: false, shift: true }); await sleep(600);
    log("after the key:", acc("fold"), "window closed:", !keysWin);
    log("menu item:", JSON.stringify(shortcutItems().map((i) => i.label)));
    keys = JSON.parse(saveKeys); savePos(); refreshMenus();
  }
  app.quit();
}

// YAB_MENUTEST=1 (measurement only): the widget menu comes back after a setting is picked, applies them all only when it is left
async function runMenuTest() {
  const log = (...a) => console.log("[menu]", ...a), before = { shadow, openStyle, scale };
  const saved = () => JSON.parse(fs.readFileSync(pos.file, "utf8"));
  await sleep(2500);
  const find = (menu, label) => { for (const it of menu.items) { if (it.label === label) return it; if (it.submenu) { const r = find(it.submenu, label); if (r) return r; } } };
  const s0 = saved();
  showWidgetMenu(10, 10); await sleep(400);
  find(lastMenu, "Shadows").click({ checked: !before.shadow });                  // a setting is chosen
  lastMenu.closePopup(); await sleep(400);
  log("after one setting: menu shown", menuPops, "times (expect 2); menu now shows shadow =", find(lastMenu, "Shadows").checked, "; saved file still has shadow =", saved().shadow, "(expect unchanged:", s0.shadow + ")");
  find(lastMenu, "Portrait (turns upright)").click();
  lastMenu.closePopup(); await sleep(400);
  log("after a second setting: shown", menuPops, "times (expect 3); saved file still has openStyle =", saved().openStyle, "(was", s0.openStyle + ")");
  find(lastMenu, "Quit settings").click();
  lastMenu.closePopup(); await sleep(600);
  log("after Quit settings: shown", menuPops, "times (expect 3); saved shadow =", saved().shadow, "(expect", !before.shadow + "), openStyle =", saved().openStyle, "(expect portrait)");
  showWidgetMenu(10, 10); await sleep(300); const n = menuPops; lastMenu.closePopup(); await sleep(400);
  log("a click away closes it:", menuPops === n ? "yes" : "no");
  setShadow(before.shadow); setOpenStyle(before.openStyle); setScale(before.scale);
  app.quit();
}
