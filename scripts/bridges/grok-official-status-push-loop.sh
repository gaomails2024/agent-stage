#!/usr/bin/env bash
# Box-side loop: refresh .runtime/grok-bot-official.json every 20s.
# Does NOT push to Mac (no Mac Shell from bash). Pair with agent routine for Path B.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/.runtime/grok-bot-official.json"
mkdir -p "$ROOT/.runtime"
while true; do
  node "$ROOT/scripts/bridges/grok-official-status-export.mjs" >/dev/null 2>&1 || true
  # keep a tiny heartbeat stamp without secrets
  if [[ -f "$OUT" ]]; then
    touch "$OUT" 2>/dev/null || true
  fi
  sleep 20
done
