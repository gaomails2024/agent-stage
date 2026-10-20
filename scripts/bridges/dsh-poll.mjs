#!/usr/bin/env node
/**
 * DeepSeek Harness (dsh) — best-effort bridge.
 * Full fidelity needs a DSH plugin listening to agent/status.
 * This script: check `dsh --help` / recent session files presence → coarse status.
 *
 * Usage: node scripts/bridges/dsh-poll.mjs --id dsh-1 --once
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeSnapshot } from '../lib/writeSnapshot.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const agentId = arg('id', 'dsh-1');
const intervalMs = Number(arg('interval', '4000')) || 4000;
const once = process.argv.includes('--once');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');

function recentSessionActivity() {
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return null;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p, depth + 1);
        else if (e.includes('session') && (e.endsWith('.zstd') || e.endsWith('.jsonl'))) {
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return newest || null;
}

function tick() {
  const help = spawnSync('dsh', ['--help'], { encoding: 'utf8', timeout: 5000 });
  let status = 'idle';
  let summary = 'DSH: CLI not found';
  if (help.status === 0 || (help.stdout || '').includes('dsh')) {
    const mtime = recentSessionActivity();
    const age = mtime ? Date.now() - mtime : null;
    if (age != null && age < 30_000) {
      status = 'running';
      summary = 'DSH: recent session activity (<30s)';
    } else if (age != null && age < 300_000) {
      status = 'idle';
      summary = 'DSH: session quiet';
    } else {
      status = 'idle';
      summary = 'DSH: installed, no recent session write';
    }
  }
  const out = writeSnapshot({
    agentId,
    status,
    summary,
    vendor: 'dsh',
    meta: {
      note: 'Prefer a DSH plugin on agent/status for reliable mapping',
    },
  });
  console.log(`[${new Date().toISOString()}] ${status} → ${out}`);
}

tick();
if (!once) setInterval(tick, intervalMs);
