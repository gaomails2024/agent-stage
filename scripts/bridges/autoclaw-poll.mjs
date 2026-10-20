#!/usr/bin/env node
/**
 * AutoClaw (crew) → StatusSnapshotV1
 * Tries: crew agents status --json | crew board --json | crew health --json | crew status
 *
 * Usage:
 *   node scripts/bridges/autoclaw-poll.mjs --id autoclaw-1 --once
 *   AUTOCLAW_ROOT=~/autoclaw node scripts/bridges/autoclaw-poll.mjs --id autoclaw-1
 */
import { spawnSync } from 'node:child_process';
import { writeSnapshot } from '../lib/writeSnapshot.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const agentId = arg('id', 'autoclaw-1');
const root = process.env.AUTOCLAW_ROOT || arg('root', '');
const intervalMs = Number(arg('interval', '3000')) || 3000;
const once = process.argv.includes('--once');

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: root || undefined,
    timeout: 8000,
  });
  return {
    ok: r.status === 0,
    out: (r.stdout || '') + (r.stderr || ''),
    code: r.status,
  };
}

function tryJson(cmds) {
  for (const [bin, args] of cmds) {
    const r = run(bin, args);
    if (!r.ok) continue;
    const line = r.out.trim().split('\n').find((l) => l.startsWith('{') || l.startsWith('['));
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      try {
        return JSON.parse(r.out);
      } catch {
        /* continue */
      }
    }
  }
  return null;
}

function mapFromJson(data) {
  // Best-effort across crew health / agents status / board shapes
  const text = JSON.stringify(data).toLowerCase();
  if (text.includes('"unhealthy"') || text.includes('"error"')) {
    return { status: 'error', summary: 'AutoClaw: unhealthy/error' };
  }
  if (
    text.includes('"waiting"') ||
    text.includes('"paused"') ||
    text.includes('needs') ||
    text.includes('"blocked"')
  ) {
    return { status: 'needs_input', summary: 'AutoClaw: waiting / blocked' };
  }
  if (
    text.includes('"running"') ||
    text.includes('"active"') ||
    text.includes('"busy"')
  ) {
    return { status: 'running', summary: 'AutoClaw: agents active' };
  }
  if (text.includes('"healthy"') || text.includes('"idle"')) {
    return { status: 'idle', summary: 'AutoClaw: healthy/idle' };
  }
  return { status: 'running', summary: 'AutoClaw: status received' };
}

function tick() {
  const data = tryJson([
    ['crew', ['agents', 'status', '--json']],
    ['python3', ['-m', 'crew', 'agents', 'status', '--json']],
    ['crew', ['board', '--json']],
    ['crew', ['health', '--json']],
    ['python3', ['-m', 'crew', 'health', '--json']],
  ]);

  let status = 'idle';
  let summary = 'AutoClaw: CLI not found (install crew / set AUTOCLAW_ROOT)';
  let meta = {};

  if (data) {
    const m = mapFromJson(data);
    status = m.status;
    summary = m.summary;
    meta = { rawKeys: Object.keys(data).slice(0, 12) };
  } else {
    const plain = run('crew', ['status']);
    if (plain.ok || plain.out) {
      const t = plain.out.toLowerCase();
      if (t.includes('running') || t.includes('active')) {
        status = 'running';
        summary = 'AutoClaw: status (text)';
      } else if (t.includes('not running') || t.includes('stopped')) {
        status = 'idle';
        summary = 'AutoClaw: daemon stopped';
      } else {
        status = 'idle';
        summary = 'AutoClaw: crew status (see meta)';
      }
      meta = { text: plain.out.slice(0, 200) };
    }
  }

  const out = writeSnapshot({
    agentId,
    status,
    summary,
    vendor: 'autoclaw',
    meta,
  });
  console.log(`[${new Date().toISOString()}] ${status} → ${out}`);
}

tick();
if (!once) setInterval(tick, intervalMs);
