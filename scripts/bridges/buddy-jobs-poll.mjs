#!/usr/bin/env node
/**
 * Poll WorkBuddy / CodeBuddy Jobs API → ~/.agent-stage/status/<id>.json
 *
 * Usage:
 *   WORKBUDDY_BASE_URL=http://127.0.0.1:8080 \
 *   WORKBUDDY_TOKEN=secret \
 *   node scripts/bridges/buddy-jobs-poll.mjs --vendor workbuddy --id wb-1 --once
 *
 *   CODEBUDDY_BASE_URL=http://127.0.0.1:8080 CODEBUDDY_TOKEN=... \
 *   node scripts/bridges/buddy-jobs-poll.mjs --vendor codebuddy --id cb-1
 *
 * Requires: codebuddy --serve (or WorkBuddy serve). Header X-CodeBuddy-Request: 1.
 */
import { writeSnapshot } from '../lib/writeSnapshot.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const vendor = arg('vendor', 'workbuddy');
const agentId = arg('id', vendor === 'codebuddy' ? 'codebuddy-1' : 'workbuddy-1');
const jobId = arg('job');
const intervalMs = Number(arg('interval', '2000')) || 2000;
const once = process.argv.includes('--once');

const baseUrl = (
  process.env[
    vendor === 'codebuddy' ? 'CODEBUDDY_BASE_URL' : 'WORKBUDDY_BASE_URL'
  ] ||
  arg('base', 'http://127.0.0.1:8080')
).replace(/\/$/, '');

const token =
  process.env[
    vendor === 'codebuddy' ? 'CODEBUDDY_TOKEN' : 'WORKBUDDY_TOKEN'
  ] || '';

function mapJob(job) {
  const state = String(job.state ?? '').toLowerCase();
  const live = String(job.status ?? '').toLowerCase();
  const tempo = String(job.tempo ?? '').toLowerCase();
  const name = String(job.name || job.id || 'job');
  if (state === 'blocked' || live === 'waiting' || tempo === 'blocked') {
    return { status: 'needs_input', summary: `${name}: waiting / blocked` };
  }
  if (state === 'failed') return { status: 'error', summary: `${name}: failed` };
  if (state === 'done') return { status: 'done', summary: `${name}: done` };
  if (state === 'working' || live === 'busy' || tempo === 'active') {
    return { status: 'running', summary: `${name}: working` };
  }
  if (state === 'stopped' || live === 'stopped' || live === 'idle') {
    return { status: 'idle', summary: `${name}: idle/stopped` };
  }
  return { status: 'idle', summary: `${name}: no active job` };
}

function pick(jobs) {
  if (jobId) {
    const hit = jobs.find(
      (j) => j.id === jobId || j.shortId === jobId || j.sessionId === jobId,
    );
    if (hit) return hit;
  }
  const rank = (j) => {
    const s = mapJob(j).status;
    return { needs_input: 0, error: 1, done: 2, running: 3, idle: 4 }[s] ?? 5;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b))[0] || null;
}

function unwrap(json) {
  if (Array.isArray(json)) return json;
  if (json?.data && Array.isArray(json.data)) return json.data;
  if (Array.isArray(json?.data?.jobs)) return json.data.jobs;
  if (json?.data && (json.data.id || json.data.state)) return [json.data];
  if (json?.id || json?.state) return [json];
  return [];
}

async function tick() {
  const headers = {
    'X-CodeBuddy-Request': '1',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const path = jobId
    ? `/api/v1/jobs/${encodeURIComponent(jobId)}`
    : `/api/v1/jobs?all=1`;
  let status = 'idle';
  let summary = `${vendor}: unreachable`;
  let meta = {};
  let sessionId;
  try {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    if (res.status === 401 || res.status === 403) {
      status = 'needs_auth';
      summary = `${vendor}: auth ${res.status} — set TOKEN`;
    } else if (!res.ok) {
      status = 'error';
      summary = `${vendor}: HTTP ${res.status}`;
    } else {
      const jobs = unwrap(await res.json());
      const job = pick(jobs);
      if (!job) {
        status = 'idle';
        summary = `${vendor}: no jobs (start --serve + a job)`;
      } else {
        const m = mapJob(job);
        status = m.status;
        summary = m.summary;
        sessionId = job.sessionId;
        meta = { jobId: job.id, state: job.state, status: job.status };
      }
    }
  } catch (e) {
    status = 'error';
    summary = `${vendor}: ${e instanceof Error ? e.message : e}`;
  }
  const out = writeSnapshot({
    agentId,
    status,
    summary,
    vendor,
    sessionId,
    meta,
  });
  console.log(`[${new Date().toISOString()}] ${status} → ${out}`);
}

await tick();
if (!once) {
  setInterval(() => {
    void tick();
  }, intervalMs);
}
