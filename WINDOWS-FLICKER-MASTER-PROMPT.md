# Master prompt: find and fix the Windows "fold" flicker in Yab (paste this into Claude Code on the Windows laptop)

You are a fresh Claude Code session on a **Windows** laptop. The project folder (Yab, an Electron + Hono + React app) is open. Nothing is installed or configured yet. Your job: **find the real root cause of a visual flicker that only happens on Windows when the Yab window folds back into its floating widget, prove it with evidence, fix it (Windows-only), and verify the fix.** Do not paper over it with a delay. Do not change the Mac behaviour or the animation's look.

---

## 1. What Yab is (30-second context)

Yab is a local-first file-search app ("RAG over my files"). It runs as an **Electron** app:

- a small floating **widget** (an animated drawer icon, always on top) that the user clicks to expand into
- the main **window** (frameless, transparent, rounded; the UI is a React page served by a local API on `127.0.0.1:4477`).
- Folding the window (minimize / close button in the page, or Ctrl+M / Ctrl+W) shrinks it back into the widget with a **"launch physics" effect**: a snapshot picture of the window ("the card") shrinks into the widget while the widget's drawer is kicked away. It is drawn in a **third window, the overlay** (a transparent, click-through, always-on-top window the size of the display; page = `electron/fx.html` + `electron/fx.js`).
- There is also a **"Simple fade" effect** (menu: right-click the widget -> Open / close effect). It has no overlay and no snapshot.

Everything is plain JS (no TypeScript in `electron/`). The animation itself is finished and approved; do not redesign it.

## 2. THE BUG (exactly what the user sees, on Windows only)

- Fold the window with the launch-physics effect on. **One visible blink/refresh happens in the area of the Yab window** (not the whole screen) right before/as the fold starts, "like a refresh". Then the fold animation plays and settles normally.
- It **does not happen with "Simple fade"** (user confirmed). So it is something in the launch-effect path: `prefold` / snapshot (`capturePage`) / overlay show / swap of window for card / overlay hide.
- It does not happen on the Mac build (display scale 2, different compositor), where the same code was tuned for weeks.
- User's Windows display scale is **125%** (`scaleFactor 1.25`); window was 1035x796 DIP.

## 3. Files you need (read these first)

| File | What it is |
|---|---|
| `electron/main.cjs` | Main process. **All the fold logic is here.** Key functions (search by name): `collapse`, `prefold`, `disarm`, `fxClose`, `snapshotWin`, `snapInfo`, `commitClose`, `fxGeometry`, `ensureOverlay`, `fxEnd`, `fxAbort`, `softHideWidget`/`softShowWidget`, `showWidget`/`hideWidget`, `allSpaces`, `trace`/`watchWin`/`traceSave`; IPC handlers `fx-ready`, `fx-reveal`, `fx-settled`, `fx-done`, `prefold`, `win`. |
| `electron/fx.js`, `electron/fx.html` | The overlay page: builds the card from the snapshot and plays the physics. Look at how the card is sized/positioned (there is already a block that makes the card pixel-exact on fractional display scales: search `m.nat`). |
| `electron/widget.html`, `electron/yab-anim.js` | The widget page and its SVG animation. **Do not modify** (approved). It receives `hold`/`resume`/`restart` messages. |
| `electron/preload.cjs` | IPC bridge (`window.sleepy`). |
| `web/src/App.tsx` | The Windows title-bar buttons (search `winctl`): minimize/close buttons call `prefold` on **pointer down** and `win("minimize")` on click. |
| `scripts/pack-win.sh`, `scripts/pack-mac.sh` | Packaging (bash, run on the Mac). **Do not run these here.** |

## 4. How the fold works today (the sequence you are debugging)

1. **Pointer goes down** on the minimize button (or Ctrl is pressed) -> renderer sends `prefold` -> main `prefold()`:
   arms a fold, calls `fxClose(false, true)` -> `snapshotWin()` does `win.webContents.capturePage()` (the card image) -> sends it to the overlay page, which decodes it and replies `fx-ready`.
2. `fx-ready` handler: `overlay.setOpacity(0); overlay.showInactive()` ("up but invisible so it can paint"). The fold waits armed.
3. **Click** -> `collapse()` -> `commitClose()`: `overlay.setOpacity(1)`; after ~130 ms (Windows value) the real window is hidden (`win.setOpacity(0); win.hide(); win.setOpacity(1)`) and the widget gets `restart`; after ~160 ms the overlay is told `fx-go` and the card shrinks into the widget.
4. Animation ends -> `fx-done` -> `fxEnd("close")`: the widget (soft-hidden = opacity 0 + click-through while the window was open) is soft-shown, the overlay is hidden, the widget `resume`s.

Notes: the widget is **never really hidden** while the window is open: it is "soft hidden" via `setOpacity(0)` + `setIgnoreMouseEvents(true)`. All three windows are **transparent frameless** windows.

## 5. Evidence already collected (do not redo, but do re-check on v1.2)

A built-in trace writes `%APPDATA%\yab\fold-trace.txt` after every fold (last fold only). One captured on this exact laptop:

```
    0 ms  prefold
   25 ms  snapshot 1294x994px, window 1035x796 at scale 1.25; corner(1,1) a0 rgb(0,0,0); centre a255 rgb(242,227,12); bottom-right(-3,-3) a0 rgb(0,0,0); right-edge a255 rgb(20,20,20)
  114 ms  overlay page ready (dir=close)
  117 ms  overlay show
  165 ms  collapse (armed=true, ready=true, busy=true, fx=true)
  169 ms  commitClose
  304 ms  window hide
  305 ms  window blur
 1542 ms  fxEnd close
 1542 ms  swap: widget soft=true
 1542 ms  widget soft-show
 1545 ms  overlay hide
```

What this proved: ordering is fine (the overlay is on screen **before** the window hides, so there is no "empty gap"); the snapshot has correct transparency (corners alpha 0); the image is 1294x994 px for a 1035x796 DIP window at 1.25 (so it is **not pixel-identical to the live window**: 1035*1.25=1293.75, 796*1.25=995).

Fixes already tried and **in v1.2** (the user may still see the blink; verify): (a) overlay window made 1 px smaller than the display on Windows and hidden in one step at the end of the close; (b) window leaves 130 ms (not 34) after the card shows, fold starts at 160 ms; (c) in `fx.js`, on fractional scales the card gets the snapshot's natural pixel size and a whole-pixel position in the "resting" pose; (d) single-instance lock, tray notice. Tried before and rejected: showing the overlay only at the click instead of at pointer-down (still blinked).

## 6. Hypotheses to test (ranked; test them, do not assume)

1. **`capturePage()` itself flashes the window on Windows.** It runs at *pointer-down* (prefold), only in the launch effect, never in Simple fade. This matches "only with launch physics" and "blink before it folds". On Windows, capturing a transparent window may force a full re-raster/invalidate that shows as a refresh.
2. **Card vs live window mismatch** at the moment the card covers the window (fractional DPI resampling, ClearType vs grayscale text, 1 px height difference, shadow edge). Fix (c) above targeted this.
3. **`setOpacity` is unreliable on Windows transparent windows** (layered-window behaviour): the "invisible" overlay may actually be visible at opacity 0, or `win.setOpacity(0)/(1)` around `hide()` may flash, or the widget's soft-hide may not hide it. Verify with real pixels, not by trusting `getOpacity()`.
4. **DWM / compositor effects of showing/hiding a display-sized transparent topmost window** (first-show paint delay, flip-model changes). Fix (a) targeted this.
5. **Focus/z-order churn** (`window blur`, activation of another window, taskbar) causing a repaint of the Yab area.
6. GPU/transparency: Chromium transparent-window rendering on this GPU (try launching with `--disable-gpu` or `app.disableHardwareAcceleration()` as an experiment only).

## 7. Setup on this Windows machine (do this first)

1. Check Node: `node -v` must be **22.x** (install Node 22 LTS if not). Check `git --version`.
2. **Delete the copied `node_modules` folder** (it contains Mac binaries) and run `npm install` in the project root (better-sqlite3 needs its Windows prebuilt binary; if it tries to compile, install the VS Build Tools or tell the user).
3. Make a safety net before touching anything: `git init`, `git add -A`, `git commit -m baseline` (the folder is not a git repo). At the end you will produce `git diff` as a patch for the user to copy back to the Mac.
4. The repo's `npm run app` uses `env -u` (Unix only). On Windows use PowerShell:
   ```powershell
   npm run build:web
   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   npx electron .
   ```
   The app starts its own API server (node + tsx) on port 4477. An empty file index is fine for this bug.
5. For a baseline of what the user actually runs, also use the packaged v1.2 (`Yab-v1.2-win.zip` unzipped -> `Yab.exe`); its data lives in `%APPDATA%\yab`. The dev run's trace file goes to the same folder (userData name is `yab`), so **close one before testing the other**.
6. Useful test switches (PowerShell `$env:NAME=1` before `npx electron .`): `YAB_FOLD=1` (scripted fold cycles with timings), `YAB_FXTEST`, `YAB_PRESET`, `YAB_KEYTEST` (see the `run*Test` functions at the bottom of `main.cjs`). Many were written for Mac and use `capturePage` for screenshots; do not trust them as evidence of what the *screen* shows.

## 8. How to capture real evidence (the part that matters)

Pixels on screen are the truth, not Electron's own screenshots.

1. Install/use **ffmpeg** (`winget install Gyan.FFmpeg`) and record the desktop at 60 fps while folding:
   ```powershell
   ffmpeg -f gdigrab -framerate 60 -draw_mouse 0 -i desktop -t 6 -c:v libx264 -preset ultrafast -crf 14 fold.mp4
   ```
   Start recording, fold the window once with a click on the in-page minimize button (a scripted click is fine, e.g. via `ipcMain.emit("win", {}, "minimize")` with a prefold ~150 ms before), then extract frames around the event: `ffmpeg -i fold.mp4 -vf "select='between(n,0,200)'" -vsync 0 f_%04d.png`.
   (Alternatives: Xbox Game Bar Win+Alt+R, or OBS.)
2. Read the frames yourself (you can view images) and **find the exact frame(s) where the Yab area changes unexpectedly**. Cross-reference frame time with `fold-trace.txt` timestamps (add more `trace()` points if needed; `watchWin` already logs show/hide/focus/blur for window, overlay and widget).
3. Compute an objective measure if useful: per-frame pixel difference inside the Yab window rectangle (PIL/numpy) between consecutive frames. A clean fold should show **no change** until the card starts moving.

## 9. Isolation experiments (add temporary env switches in `main.cjs`, then remove them)

Run each against the same recording method and compare:

- A. `YAB_NOSNAP=1`: skip `capturePage` entirely (use a plain/cached card). If the blink disappears -> hypothesis 1.
- B. Take the snapshot **earlier** (e.g. when the window finishes opening, or on a timer) and reuse it at fold time so nothing is captured at pointer-down.
- C. `YAB_NOOV=1`: at fold just `win.hide()` + show widget (no overlay) to see the baseline of the window hide itself.
- D. Overlay "invisible" state via **off-screen position or `hide()`** instead of `setOpacity(0)` (hypothesis 3).
- E. Launch with `--disable-gpu` / `app.disableHardwareAcceleration()` (hypothesis 6).
- F. Vary display scale (100% / 125% / 150%) in Windows Settings and see whether the blink changes (hypothesis 2).
- G. Keep the real window visible under the card for longer (e.g. 300 ms) and see whether the blink moves with it.

## 10. Rules

- **Root cause first.** Show the evidence (frames + trace) that identifies it, then fix. No "just add a delay" unless the evidence shows timing is truly the cause, and then explain why.
- **Windows-only changes**: gate with `process.platform === "win32"`. The Mac fold path (tuned and approved) must behave identically. Do not edit `yab-anim.js` or `widget.html`. Do not change the look/timing of the animation itself (rotation, shrink, drawer kick).
- Keep fixes small and local; keep or improve the existing `trace()` instrumentation (it is cheap).
- **Do not repackage** (`scripts/pack-*.sh` run on the Mac). Test with `npx electron .` and the packaged v1.2 for baseline.
- Remove any temporary env switches/logging you added unless they are genuinely useful (and cheap).
- Be honest in your report: say what is proven, what is probable, and what you could not verify.

## 11. Deliverables

1. **Root cause**, with evidence: the frame numbers/timestamps from the recording, the trace excerpt, and which experiment isolated it.
2. **The fix** (Windows-gated) and a **before/after recording comparison** (frame diffs or described frames) showing the blink gone at 125% scale, and preferably also at 100% and 150%.
3. A **patch**: run `git diff baseline > yab-windows-fix.patch` (or `git format-patch`) and list the changed files, so the user can copy them back to the Mac project at `electron/` and repack as v1.3. Also give a 5-line summary the user can paste to the Mac session.
4. A list of anything suspicious you noticed but did not change.

Start with section 7 (setup), then reproduce on the packaged v1.2 and capture a baseline recording **before changing any code**.
