#!/usr/bin/env bash
# Build the UCC App Builder Splunk app WITH the Splunk Agent SDK advisor deps.
#
# Why this exists: the advisor uses splunklib.ai (Splunk Agent SDK), which ships
# in splunk-sdk 3.0.0 — NOT on public PyPI (max is 2.1.1), so splunklib is
# vendored under ucc-app/lib/splunklib. The other agent deps (langchain/langgraph/
# pydantic/mcp) ARE on PyPI but include COMPILED extensions (pydantic_core, etc.)
# that must match the TARGET runtime: Splunk 10.4 = CPython 3.13 on linux x86_64.
# ucc-gen installs with the BUILD host's python (3.10 here), so we re-install the
# agent deps as cp313 manylinux wheels into the output lib after ucc-gen.
#
# Usage:  bash deploy/build_agent_app.sh [output_dir]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # splunk-app/
REPO="$(cd "$HERE/.." && pwd)"                     # repo root
OUT="${1:-/tmp/ucc_app_builder_build}"
PYVER="3.13"
PLAT="manylinux2014_x86_64"

# Build the SPA bundle FRESH into appserver/static/ui so the package never ships a stale
# UI. The bundle is a build artifact (NOT committed) — ucc-gen below copies appserver/
# static verbatim, so it must exist first. Install JS deps if a clean checkout lacks them.
echo "==> build SPA UI (vite) -> appserver/static/ui"
if [ ! -d "$REPO/node_modules" ]; then
  ( cd "$REPO" && npm ci )
fi
bash "$HERE/deploy/build_ui.sh"

echo "==> ucc-gen build"
ucc-gen build --source "$HERE/ucc-app" -o "$OUT"
APPLIB="$OUT/ucc_app_builder/lib"

echo "==> installing agent deps as cp${PYVER//./} manylinux wheels (target runtime: Splunk py3.13)"
python3 -m pip install --target "$APPLIB" --upgrade --no-compile \
  --python-version "$PYVER" --only-binary=:all: --platform "$PLAT" --implementation cp \
  langchain langchain-openai langgraph pydantic pydantic-core uuid-utils "mcp>=1.27.0"

# The UCC Configuration-page REST handler (+ our advisor/proxy handlers that read it)
# run under Splunk's PERSISTENT-handler python, which is 3.9 here — and import
# solnlib -> urllib3. The cp313 step above pulls urllib3 2.x, whose module-level
# `bytes | str` union annotations crash on 3.9 (TypeError: unsupported operand |).
# Pin the pure-python urllib3 1.26 (works on BOTH 3.9 and the 3.13 agent subprocess).
echo "==> pinning urllib3<2 (pure-python; 3.9 persistent-handler compatibility)"
# pip --target --upgrade does NOT delete files removed between versions, so wipe the
# 2.x urllib3 first (its 2.x-only modules like _base_connection.py use 3.10+ union
# syntax and would linger and crash on 3.9).
rm -rf "$APPLIB/urllib3" "$APPLIB"/urllib3-*.dist-info
python3 -m pip install --target "$APPLIB" --no-compile "urllib3<2"

# AppInspect hygiene on the vendored agent stack (so the build is as cert-clean as a
# compiled-dependency app can be — only check_aarch64_compatibility remains, inherent to
# shipping x86_64 wheels for the Splunk Agent SDK stack):
APPDIR="$OUT/ucc_app_builder"
#  - check_reload_trigger_for_all_custom_confs: EVERY custom conf needs a [triggers]
#    reload entry. Ours are tools.conf and ucc_app_builder_settings.conf.
#    ucc-gen may already emit a [triggers] stanza (e.g. reload.<restRoot>_settings for
#    the Configuration page) — so ensure EACH custom conf's reload entry exists rather
#    than skipping when [triggers] is merely present (else reload.tools goes missing).
if grep -q '^\[triggers\]' "$APPDIR/default/app.conf"; then
  grep -q '^reload\.tools' "$APPDIR/default/app.conf" || sed -i '/^\[triggers\]/a reload.tools = simple' "$APPDIR/default/app.conf"
  grep -q '^reload\.ucc_app_builder_settings' "$APPDIR/default/app.conf" || sed -i '/^\[triggers\]/a reload.ucc_app_builder_settings = simple' "$APPDIR/default/app.conf"
else
  printf '\n[triggers]\nreload.ucc_app_builder_settings = simple\nreload.tools = simple\n' >> "$APPDIR/default/app.conf"
fi
#  - check_for_compiled_python: strip __pycache__ / *.pyc from the WHOLE package (wheels in
#    lib/, AND any bin/ bytecode left by local py_compile checks — AppInspect fails on either).
find "$APPDIR" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "$APPDIR" -type f -name '*.pyc' -delete 2>/dev/null || true
#  - check_for_bin_files: NO bundled library file should carry execute bits (dlopen
#    needs read, not execute; wheels also ship +x helper scripts like tqdm/completion.sh).
#    Strip execute from every file under lib/ (directories keep +x for traversal).
find "$APPDIR/lib" -type f -exec chmod a-x {} + 2>/dev/null || true
#  - check_that_extracted_splunk_app_does_not_contain_prohibited_directories_or_files:
#    strip prohibited hidden files shipped inside wheels (e.g. openai's lib/.keep) and
#    macOS cruft (the older AppInspect packaging checks reject these).
find "$APPDIR" -type f \( -name '.keep' -o -name '.DS_Store' \) -delete 2>/dev/null || true
find "$APPDIR" -type d -name '__MACOSX' -prune -exec rm -rf {} + 2>/dev/null || true
#  - check_that_splunk_app_package_does_not_contain_files_outside_of_app: AppInspect
#    rejects group/other-WRITABLE files & directories. ucc-gen + pip leave dirs 0775
#    and files group-writable under a 002 umask, so normalise the WHOLE package to
#    Splunk's recommended perms (dirs 0755, files 0644 — 0644 also preserves the
#    no-execute-on-libs guarantee; Splunk runs scripts via the interpreter, so
#    nothing in the package needs the execute bit).
find "$APPDIR" -type d -exec chmod 755 {} + 2>/dev/null || true
find "$APPDIR" -type f -exec chmod 644 {} + 2>/dev/null || true

echo "==> done: $OUT/ucc_app_builder"
echo "    verify on Splunk py3.13:"
echo "    SPLUNK_HOME=/opt/splunk LD_LIBRARY_PATH=/opt/splunk/lib PYTHONPATH=$APPLIB:$OUT/ucc_app_builder/bin /opt/splunk/bin/python3 -c 'import splunklib.ai; print(\"ok\")'"
