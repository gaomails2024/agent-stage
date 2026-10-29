#!/usr/bin/env bash
# Create a clean archive for copying Agent Stage to a Mac.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="agent-stage-mac-${STAMP}"
OUT_DIR="${PACK_OUT_DIR:-$ROOT}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/agent-stage-pack.XXXXXX")"
DEST="$STAGE/$NAME"

mkdir -p "$DEST"
# Prefer tar copy with excludes (no rsync required)
tar -C "$ROOT" \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.git \
  --exclude=src-tauri/target \
  --exclude=src-tauri/gen \
  --exclude='_probe*.ts' \
  --exclude=.box-agent \
  --exclude=.box-agent-scratch \
  --exclude='*.bak' \
  --exclude='*.bak-*' \
  --exclude='*.tar.gz' \
  --exclude='*.zip' \
  -cf - . | tar -C "$DEST" -xf -

mkdir -p "$OUT_DIR"
TAR="$OUT_DIR/${NAME}.tar.gz"
ZIP="$OUT_DIR/${NAME}.zip"

tar -C "$STAGE" -czf "$TAR" "$NAME"

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -qr "$ZIP" "$NAME")
  echo "ZIP=$ZIP"
else
  ZIP=""
fi

rm -rf "$STAGE"
echo "TAR=$TAR"
ls -lh "$TAR" ${ZIP:+"$ZIP"} 2>/dev/null || true
