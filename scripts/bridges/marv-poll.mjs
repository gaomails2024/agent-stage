#!/usr/bin/env node
/**
 * Marv / Marvs (agentmarv) → StatusSnapshotV1
 * Tries: marv status --all | marv health | marv status
 *
 * Usage: node scripts/bridges/marv-poll.mjs --id marvs-1 --once
 */
import { spawnSync } from 'node:child_process';
import { writeSnapshot } from '../lib/writeSnapshot.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const agentId = arg('id', 'marvs-1');
const intervalMs = Number(arg('interval', '3000')) || 3000;
const once = process.argv.includes('--once');
const bin = arg('bin', process.env.MARV_BIN || 'marv');

function run(args) {
  return spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 });
}

function tick() {
  let status = 'idle';
  let summary = 'Marv: CLI not found (npm i -g agentmarv)';
  const attempts = [['status', '--all'], ['health'], ['status']];
  let outText = '';
  for (const args of attempts) {
    const r = run(args);
    outText = ((r.stdout || '') + (r.stderr || '')).trim();
    if (outText) break;
  }
  if (outText) {
    const t = outText.toLowerCase();
    if (t.includes('auth') || t.includes('login') || t.includes('api key')) {
      status = 'needs_auth';
      summary = 'Marv: needs auth';
    } else if (
      t.includes('waiting') ||
      t.includes('approval') ||
      t.includes('confirm')
    ) {
      status = 'needs_input';
      summary = 'Marv: needs input';
    } else if (t.includes('error') || t.includes('failed')) {
      status = 'error';
      summary = 'Marv: error';
    } else if (
      t.includes('running') ||
      t.includes('busy') ||
      t.includes('active')
    ) {
      status = 'running';
      summary = 'Marv: running';
    } else if (t.includes('idle') || t.includes('ready') || t.includes('ok')) {
      status = 'idle';
      summary = 'Marv: idle/ready';
    } else {
      status = 'running';
      summary = 'Marv: status ok';
    }
  }
  const path = writeSnapshot({
    agentId,
    status,
    summary,
    vendor: 'marvs',
    meta: { snippet: outText.slice(0, 240) },
  });
  console.log(`[${new Date().toISOString()}] ${status} → ${path}`);
}

tick();
if (!once) setInterval(tick, intervalMs);
