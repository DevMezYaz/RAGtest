#!/usr/bin/env bash
# Builds dist-mac/Yab.app (+ Yab-mac.zip): Electron with the Yab icon/name, the bundled server and web UI.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && PB=darwin-arm64 || PB=darwin-x64
APP=dist-mac/Yab.app
RES="$APP/Contents/Resources/app"

mkdir -p dist-mac && rm -rf "$APP" dist-mac/Yab-mac.zip
cp -R node_modules/electron/dist/Electron.app "$APP"
npm run build:web >/dev/null

# rename the bundle's executable + metadata, swap the icon
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Yab"
cp build/yab.icns "$APP/Contents/Resources/electron.icns"
P="$APP/Contents/Info.plist"
for kv in "CFBundleName Yab" "CFBundleDisplayName Yab" "CFBundleExecutable Yab" "CFBundleIdentifier com.royalchains.yab"; do
  set -- $kv; /usr/libexec/PlistBuddy -c "Set :$1 $2" "$P" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$P"
done
/usr/libexec/PlistBuddy -c "Set :LSApplicationCategoryType public.app-category.productivity" "$P" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.productivity" "$P"
# the helper apps keep Electron's names; they're internal

# the app itself
mkdir -p "$RES/electron" "$RES/build" "$RES/server" "$RES/node_modules/better-sqlite3/prebuilds"
cp electron/main.cjs electron/preload.cjs electron/widget.html electron/yab-anim.js electron/fx.html electron/fx.js electron/keys.html "$RES/electron/"
node scripts/get-models.mjs >/dev/null && cp -R models "$RES/models"   # the on-device "search by meaning" model
cp build/icon-512.png "$RES/build/"
cp -R web/dist "$RES/web" 2>/dev/null || { mkdir -p "$RES/web" && cp -R web/dist "$RES/web/"; }
[ -d "$RES/web/dist" ] || { rm -rf "$RES/web" && mkdir -p "$RES/web" && cp -R web/dist "$RES/web/dist"; }
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ name: "yab", version: "1.3.1", main: "electron/main.cjs" }))' "$RES/package.json"
npx esbuild server/index.ts --bundle --platform=node --target=node22 --format=esm --outfile="$RES/server/server.mjs" \
  --external:better-sqlite3 --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
cp -R node_modules/better-sqlite3/lib node_modules/better-sqlite3/package.json "$RES/node_modules/better-sqlite3/"
cp "node_modules/better-sqlite3/prebuilds/$PB.node" "$RES/node_modules/better-sqlite3/prebuilds/"
for d in $(node -p "Object.keys(require('better-sqlite3/package.json').dependencies||{}).join(' ')"); do cp -R "node_modules/$d" "$RES/node_modules/"; done

# default config: no folders yet (the user picks), nothing that points at this machine
node -e '
const c = require("./sleepy.config.json");
c.folders = [];
c.excludeFolders = c.excludeFolders.filter((e) => !e.includes("RAGtest"));
require("fs").writeFileSync(process.argv[1], JSON.stringify(c, null, 2));' "$RES/sleepy.config.json"
grep "^OPENROUTER_API_KEY=" .env > "$RES/.env"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "signed (ad-hoc)"
( cd dist-mac && ditto -c -k --keepParent Yab.app Yab-mac.zip )
du -sh "$APP" dist-mac/Yab-mac.zip
