#!/usr/bin/env bash
# Builds the Windows app: dist-win/Yab-win.zip -> unzip, double-click Yab.exe (nothing to install). Same Electron app as the Mac one:
# floating widget, tray icon, bundled server on Electron's own node. Cross-built from the Mac (the native sqlite module ships a prebuilt win32 binary).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./node_modules/electron/package.json').version")
CACHE="${TMPDIR:-/tmp}/yab-electron-win-$VER.zip"
OUT=dist-win/Yab
RES="$OUT/resources/app"

rm -rf dist-win && mkdir -p "$OUT"
[ -s "$CACHE" ] || curl -fL "https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-win32-x64.zip" -o "$CACHE"
unzip -q "$CACHE" -d "$OUT"
mv "$OUT/electron.exe" "$OUT/Yab.exe"
node scripts/win-icon.mjs "$OUT/Yab.exe" build/yab.ico
rm -f "$OUT/resources/default_app.asar"
npm run build:web >/dev/null

mkdir -p "$RES/electron" "$RES/build" "$RES/server" "$RES/node_modules/better-sqlite3/prebuilds" "$RES/web"
cp electron/main.cjs electron/preload.cjs electron/widget.html electron/yab-anim.js electron/fx.html electron/fx.js electron/keys.html "$RES/electron/"
cp build/icon-512.png build/yab.ico "$RES/build/"
node scripts/get-models.mjs >/dev/null && cp -R models "$RES/models"   # the on-device "search by meaning" model
cp -R web/dist "$RES/web/dist"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ name: "yab", version: "1.3.1", main: "electron/main.cjs" }))' "$RES/package.json"
npx esbuild server/index.ts --bundle --platform=node --target=node22 --format=esm --outfile="$RES/server/server.mjs" \
  --external:better-sqlite3 --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
cp -R node_modules/better-sqlite3/lib node_modules/better-sqlite3/package.json "$RES/node_modules/better-sqlite3/"
cp node_modules/better-sqlite3/prebuilds/win32-x64.node "$RES/node_modules/better-sqlite3/prebuilds/"
for d in $(node -p "Object.keys(require('better-sqlite3/package.json').dependencies||{}).join(' ')"); do cp -R "node_modules/$d" "$RES/node_modules/"; done

# default config: no folders yet (the user picks), nothing that points at this machine
node -e '
const c = require("./sleepy.config.json");
c.folders = [];
c.excludeFolders = c.excludeFolders.filter((e) => !e.includes("RAGtest"));
c.excludeFolders.push("AppData");
require("fs").writeFileSync(process.argv[1], JSON.stringify(c, null, 2));' "$RES/sleepy.config.json"
grep "^OPENROUTER_API_KEY=" .env > "$RES/.env"

cat > "$OUT/READ ME.txt" <<'TXT'
YAB 1.3.1
1. Unzip this folder anywhere (Desktop is fine).
2. Double-click Yab.exe. If Windows says "protected your PC", choose More info > Run anyway.
3. A small floating icon appears (bottom-right). Drag it anywhere; click it to open Yab.
4. First time: press Access and tick the folders Yab may read, then wait for the scan.

Right-click the widget for the settings:
  Performance        High / Balanced / Low. Pick Low on a slow PC (plain fade, lightest).
  AI mode            Online (the AI answers your questions) or Offline (search only: nothing leaves this PC).
  AI access          How much the AI may see, from 1 Private to 5 Full smart index. 2 Balanced is the default.
  Read text in images (OCR)   Screenshots and scans become searchable by what they say (uses Windows' own OCR; needs an OCR language in Windows Settings > Time & language).
  Infinite drawer, Scroll feel, Auto scroll   Scroll the home drawer through all your files.
  Shortcuts          Change any keyboard shortcut. Ctrl+Alt+Space opens and closes Yab from anywhere.
  Resize / hide the widget, shadows, animations, folder style, file opening style.
Access: the Access button has a "Full PC" tick at the top that lets Yab find every file on the computer (it asks you to confirm first).
Widget: hover it for an x (hides it; Yab stays in the tray, and opening Yab again brings it back). To quit: right-click the widget > Quit Yab.
In Offline mode everything stays on this PC. Online, only the snippets or pages needed to answer a question are sent to the AI model.
TXT
sed -i '' 's/$/\r/' "$OUT/READ ME.txt" 2>/dev/null || true
( cd dist-win && zip -qr Yab-win.zip Yab )
du -sh "$OUT" dist-win/Yab-win.zip
