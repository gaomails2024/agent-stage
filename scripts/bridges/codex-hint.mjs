#!/usr/bin/env node
/**
 * Codex bridge stub: writes idle/error snapshot with setup instructions.
 * Real path: wrap `codex exec --json` and map turn.* events (see docs/status-ingest.md).
 *
 * Usage: node scripts/bridges/codex-hint.mjs --id codex-1
 */
import { writeSnapshot } from '../lib/writeSnapshot.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const agentId = arg('id', 'codex-1');
const out = writeSnapshot({
  agentId,
  status: 'idle',
  summary:
    'Codex: use `codex exec --json` pipeline or tail ~/.codex/sessions (see docs)',
  vendor: 'codex',
  meta: {
    next: 'Pipe JSONL turn.started/completed/failed → writeSnapshot',
  },
});
console.log(`wrote stub ${out}`);
