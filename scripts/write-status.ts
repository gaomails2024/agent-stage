/**
 * Write a protocol v1 status snapshot.
 * Usage:
 *   pnpm exec tsx scripts/write-status.ts --id demo --status needs_input --summary "hi" --out public/status/demo.json
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const id = arg('id', 'demo')!;
const status = arg('status', 'running')!;
const summary = arg('summary', '');
const out =
  arg('out') ??
  resolve(
    process.env.AGENT_STAGE_HOME ?? `${process.env.HOME}/.agent-stage`,
    'status',
    `${id}.json`,
  );

const body = {
  schemaVersion: 1 as const,
  agentId: id,
  status,
  summary: summary || undefined,
  observedAt: new Date().toISOString(),
  vendor: arg('vendor', 'manual'),
};

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
renameSync(tmp, out);
console.log(`wrote ${out}`);
