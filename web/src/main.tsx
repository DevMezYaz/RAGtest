if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // a reload always starts from the top
if ("sleepy" in window) document.documentElement.classList.add("app");
if ((window as unknown as { sleepy?: { platform?: string } }).sleepy?.platform === "win32") document.documentElement.classList.add("win");
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./folder-dim.css";

createRoot(document.getElementById("root")!).render(<App />);

// the "Shadows" setting (widget menu): the window's hard offset shadow can be switched off
(window as unknown as { sleepy?: { onShadow?: (cb: (v: boolean) => void) => void } }).sleepy?.onShadow?.((v) => document.documentElement.classList.toggle("noshadow", !v));
// "File opening" (widget menu): classic, or portrait (the folder turns upright). ?open=portrait switches it on in a plain browser too.
const setOpenStyle = (v: string) => document.documentElement.classList.toggle("open-portrait", v === "portrait");
if (new URLSearchParams(location.search).get("open") === "portrait") setOpenStyle("portrait");
(window as unknown as { sleepy?: { onOpenStyle?: (cb: (v: string) => void) => void } }).sleepy?.onOpenStyle?.(setOpenStyle);
// "Folder style" (widget menu): flat (default) or dimensional (see folder-dim.css). Reduced-motion users always get flat. ?folder=dim switches it on in a plain browser too.
const setFolderStyle = (v: string) => document.documentElement.classList.toggle("dim3", v === "dimensional" && !matchMedia("(prefers-reduced-motion: reduce)").matches);
if (new URLSearchParams(location.search).get("folder") === "dim") setFolderStyle("dimensional");
(window as unknown as { sleepy?: { onFolderStyle?: (cb: (v: string) => void) => void } }).sleepy?.onFolderStyle?.(setFolderStyle);
// "Infinite drawer" (widget menu): off, or the order the home drawer scrolls through its files. ?infinite=random switches it on in a plain browser too.
const setInfinite = (v: string) => { document.documentElement.dataset.infinite = v; window.dispatchEvent(new CustomEvent("yab-infinite", { detail: v })); };
{ const q = new URLSearchParams(location.search).get("infinite"); if (q) setInfinite(q); }
(window as unknown as { sleepy?: { onInfinite?: (cb: (v: string) => void) => void } }).sleepy?.onInfinite?.(setInfinite);
// "Scroll feel" and "Auto scroll" (widget menu): the weight of the infinite drawer's scrolling, and whether the home screen scrolls by itself (and how fast). ?feel=floaty&auto=slow in a plain browser.
const setScrollFeel = (v: string) => { document.documentElement.dataset.scrollFeel = v; window.dispatchEvent(new CustomEvent("yab-scrollfeel", { detail: v })); };
const setAutoScroll = (v: string) => { document.documentElement.dataset.autoScroll = v; window.dispatchEvent(new CustomEvent("yab-autoscroll", { detail: v })); };
{ const q = new URLSearchParams(location.search); if (q.get("feel")) setScrollFeel(q.get("feel")!); if (q.get("auto")) setAutoScroll(q.get("auto")!); }
{ const sl = (window as unknown as { sleepy?: { onScrollFeel?: (cb: (v: string) => void) => void; onAutoScroll?: (cb: (v: string) => void) => void } }).sleepy; sl?.onScrollFeel?.(setScrollFeel); sl?.onAutoScroll?.(setAutoScroll); }
