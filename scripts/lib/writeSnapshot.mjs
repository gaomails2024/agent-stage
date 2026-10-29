import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function agentStageHome() {
  return process.env.AGENT_STAGE_HOME || join(homedir(), '.agent-stage');
}

export function statusPathFor(agentId) {
  const safe = String(agentId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(agentStageHome(), 'status', `${safe}.json`);
}

/** Atomic write of StatusSnapshotV1 */
export function writeSnapshot(partial) {
  const agentId = partial.agentId;
  if (!agentId) throw new Error('agentId required');
  const out = partial.outPath || statusPathFor(agentId);
  const body = {
    schemaVersion: 1,
    agentId,
    status: partial.status || 'idle',
    summary: partial.summary,
    observedAt: partial.observedAt || new Date().toISOString(),
    checkedAt: partial.checkedAt || new Date().toISOString(),
    vendor: partial.vendor,
    sessionId: partial.sessionId,
    meta: partial.meta,
  };
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  renameSync(tmp, out);
  return out;
}
