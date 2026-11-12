const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("sleepy", {
  platform: process.platform,
  keys: { get: () => ipcRenderer.invoke("keys-get"), set: (id, a) => ipcRenderer.invoke("keys-set", id, a), reset: () => ipcRenderer.invoke("keys-reset"), rec: (on) => ipcRenderer.send("keys-rec", on), onInput: (cb) => ipcRenderer.on("keys-input", (_e, i) => cb(i)) },
  win: (action) => ipcRenderer.send("win", action),
  prefold: () => ipcRenderer.send("prefold"),   // the pointer went down on a fold button: get the snapshot ready
  widget: (msg) => ipcRenderer.send("widget", msg),
  onShadow: (cb) => ipcRenderer.on("shadow", (_e, v) => cb(v)),
  onScrollFeel: (cb) => ipcRenderer.on("scrollfeel", (_e, v) => cb(v)),
  onAutoScroll: (cb) => ipcRenderer.on("autoscroll", (_e, v) => cb(v)),
  onInfinite: (cb) => ipcRenderer.on("infinite", (_e, v) => cb(v)),
  onFolderStyle: (cb) => ipcRenderer.on("folderstyle", (_e, v) => cb(v)),
  onOpenStyle: (cb) => ipcRenderer.on("openstyle", (_e, v) => cb(v)),
  onFps: (cb) => ipcRenderer.on("fps", (_e, n) => cb(n)),
  onFlip: (cb) => ipcRenderer.on("flip", (_e, v) => cb(v)),
  widgetPainted: () => ipcRenderer.send("widget-painted"),
  onResume: (cb) => ipcRenderer.on("resume", () => cb()),
  onRestart: (cb) => ipcRenderer.on("restart", () => cb()),
  // the launch effect: the overlay page draws it, main coordinates the windows
  fx: {
    onRun: (cb) => ipcRenderer.on("fx", (_e, m) => cb(m)),
    onGo: (cb) => ipcRenderer.on("fx-go", () => cb()),
    ready: (id) => ipcRenderer.send("fx-ready", id),
    reveal: (id) => ipcRenderer.send("fx-reveal", id),
    settled: (id) => ipcRenderer.send("fx-settled", id),
    done: (id) => ipcRenderer.send("fx-done", id),
  },
});
