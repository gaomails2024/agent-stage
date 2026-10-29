#!/usr/bin/env node
/**
 * Detect running Mac agent apps → StatusSnapshotV1 into public/status + ~/.agent-stage/status
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../..');
const once = process.argv.includes('--once');
const intervalMs = Number((() => {
  const i = process.argv.indexOf('--interval');
  return i >= 0 ? process.argv[i + 1] : '2500';
})()) || 2500;

const AGENTS = [
  { id: 'workbuddy-1', name: 'WorkBuddy', vendor: 'workbuddy', patterns: ['WorkBuddy.app/Contents/MacOS/Electron', 'WorkBuddy.app/Contents/MacOS/WorkBuddy'] },
  { id: 'autoclaw-1', name: 'AutoClaw', vendor: 'autoclaw', patterns: ['AutoClaw.app/Contents/MacOS/AutoClaw'] },
  { id: 'dsh-1', name: 'DeepSeek Harness', vendor: 'dsh', patterns: ['DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'] },
  { id: 'hermes-1', name: 'Hermes', vendor: 'hermes', patterns: ['hermes gateway run', 'hermes-agent', '/.hermes/'] },
  { id: 'marvs-1', name: 'Marvis', vendor: 'marvs', patterns: ['Marvis.app/Contents/MacOS/Marvis', 'MarvisAgent'] },
  { id: 'codebuddy-1', name: 'CodeBuddy', vendor: 'codebuddy', patterns: ['CodeBuddy CN.app/Contents/MacOS', 'CodeBuddy.app/Contents/MacOS'] },
  { id: 'openclaw-1', name: 'OpenClaw', vendor: 'autoclaw', patterns: ['openclaw'] },
];

function psText() {
  const r = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', maxBuffer: 20_000_000 });
  return r.stdout || '';
}

function writeSnapshot(agentId, status, summary, vendor, publicDir) {
  const nowIso = new Date().toISOString();
  const body = {
    schemaVersion: 1,
    agentId,
    status,
    summary,
    observedAt: nowIso,
    checkedAt: nowIso,
    vendor,
    meta: { source: 'macos-running-poll' },
  };
  const text = JSON.stringify(body, null, 2) + '\n';
  for (const out of [
    join(homedir(), '.agent-stage', 'status', `${agentId}.json`),
    join(publicDir, `${agentId}.json`),
  ]) {
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${process.pid}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, out);
  }
}

function tick() {
  const text = psText();
  const publicDir = join(PROJECT, 'public', 'status');
  for (const a of AGENTS) {
    const running = a.patterns.some((p) => text.includes(p));
    if (!running) {
      // 这个轮询器只有 presence 能力。绝不能把 done/needs_input/error 覆盖成 idle。
      continue;
    }
    writeSnapshot(a.id, 'running', `${a.name}: process running`, a.vendor, publicDir);
    console.log(`[${new Date().toISOString()}] ${a.id} running`);
  }
}

tick();
if (!once) setInterval(tick, intervalMs);
