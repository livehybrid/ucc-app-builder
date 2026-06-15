#!/usr/bin/env bash
# Build the standalone React SPA and stage it INTO the native Splunk app so the app
# page can mount the full rich UI (welcome screen, wizard, AI chat, GitHub, Monaco).
# Vite emits hashed names into dist/; we copy them to fixed app.js/app.css under the
# app's appserver/static/ui so a Splunk dashboard page can reference them statically.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"      # repo root
cd "$HERE"
echo "==> vite build (SPA)"
npm run build
UI="$HERE/splunk-app/ucc-app/appserver/static/ui"
mkdir -p "$UI"
cp dist/assets/*.js  "$UI/app.js"
cp dist/assets/*.css "$UI/app.css"
echo "==> staged SPA -> $UI"
ls -la "$UI"
