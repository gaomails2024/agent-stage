#!/usr/bin/env node
/**
 * Hermes Agent API → StatusSnapshotV1
 * GET $HERMES_BASE_URL/api/sessions (Bearer API_SERVER_KEY)
 *
 * Usage:
 *   HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_API_KEY=... \
 *   node scripts/bridges/hermes-poll.mjs --id hermes-1 --once
 */
import { writeSnapshot } from '../lib/writeSnapshot.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const agentId = arg('id', 'hermes-1');
const base = (process.env.HERMES_BASE_URL || arg('base', 'http://127.0.0.1:8642')).replace(/\/$/, '');
const key = process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
const intervalMs = Number(arg('interval', '2500')) || 2500;
const once = process.argv.includes('--once');

async function tick() {
  let status = 'idle';
  let summary = 'Hermes: unreachable (start API server)';
  let meta = {};
  try {
    const headers = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${base}/api/sessions?limit=20`, { headers });
    if (res.status === 401 || res.status === 403) {
      status = 'needs_auth';
      summary = 'Hermes: set HERMES_API_KEY';
    } else if (!res.ok) {
      status = 'error';
      summary = `Hermes: HTTP ${res.status}`;
    } else {
      const json = await res.json();
      const list = Array.isArray(json)
        ? json
        : Array.isArray(json?.sessions)
          ? json.sessions
          : Array.isArray(json?.data)
            ? json.data
            : [];
      meta = { count: list.length };
      if (!list.length) {
        status = 'idle';
        summary = 'Hermes: no sessions';
      } else {
        // Heuristic: look for active / running fields
        const blob = JSON.stringify(list).toLowerCase();
        if (blob.includes('running') || blob.includes('"active"')) {
          status = 'running';
          summary = `Hermes: ${list.length} session(s), activity`;
        } else if (blob.includes('failed') || blob.includes('error')) {
          status = 'error';
          summary = 'Hermes: failed session present';
        } else {
          status = 'idle';
          summary = `Hermes: ${list.length} session(s)`;
        }
      }
    }
  } catch (e) {
    status = 'error';
    summary = `Hermes: ${e instanceof Error ? e.message : e}`;
  }
  const out = writeSnapshot({
    agentId,
    status,
    summary,
    vendor: 'hermes',
    meta,
  });
  console.log(`[${new Date().toISOString()}] ${status} → ${out}`);
}

await tick();
if (!once) setInterval(() => void tick(), intervalMs);
