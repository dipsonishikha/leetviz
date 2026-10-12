#!/usr/bin/env bash
# Downloads the Pyodide runtime into vendor/pyodide.
# Chrome MV3 extensions may not load remote code, so Python must ship inside the extension.
set -euo pipefail
VERSION="${PYODIDE_VERSION:-0.27.7}"
BASE="https://cdn.jsdelivr.net/pyodide/v${VERSION}/full"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/pyodide"
mkdir -p "$DEST"
for f in pyodide.js pyodide.asm.js pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  echo "fetching $f"
  curl -fsSL "$BASE/$f" -o "$DEST/$f"
done
echo "Pyodide $VERSION ready in $DEST"
