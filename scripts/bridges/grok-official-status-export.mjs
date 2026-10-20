#!/usr/bin/env node
/**
 * Grok Bot official status exporter (host gateway).
 * forceVersion: grok-official-listagents-v2
 *
 * Reads gateway JSON from GROK_GATEWAY_JSON (default: ~/.agent-stage/grok-gateway-host.json)
 * expecting { port, token, scheme? }, then calls:
 *   GET  /health
 *   POST /api/listAgents
 * Maps busy using desktop UI semantics (not /health.isBusy alone).
 * Prints drop JSON to stdout; optionally writes a runtime file.
 * NEVER includes gateway token in output.
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../..');
/** Optional: GROK_CODER_AGENT_ID to prefer a specific agent; else match name "Coder". */
const CODER_ID = process.env.GROK_CODER_AGENT_ID || '';
const GATEWAY_PATH =
  process.env.GROK_GATEWAY_JSON ||
  join(homedir(), '.agent-stage', 'grok-gateway-host.json');
const OUT_RUNTIME =
  process.env.GROK_OFFICIAL_OUT ||
  join(PROJECT, '.runtime', 'grok-bot-official.json');
const OUT_TMP = join(PROJECT, '.runtime', 'grok-bot-official.tmp.json');
const FORCE_VERSION = 'grok-official-listagents-v2';

function loadGateway() {
  const raw = JSON.parse(readFileSync(GATEWAY_PATH, 'utf8'));
  const port = Number(raw.port);
  const token = String(raw.token || '');
  const scheme = String(raw.scheme || 'http');
  const host = '127.0.0.1';
  if (!port || !token) throw new Error('gateway.json missing port/token');
  return { baseUrl: `${scheme}://${host}:${port}`, token, port };
}

async function fetchJson(url, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}

function activityTool(agent) {
  const a = agent?.currentActivity;
  if (!a) return null;
  if (typeof a === 'string') return a.slice(0, 120);
  if (typeof a === 'object') {
    const t = a.tool || a.toolName || a.name || a.type || a.kind;
    return t != null ? String(t).slice(0, 120) : null;
  }
  return null;
}

/** Desktop UI: needs_input iff awaitingUserResponse!=null;
 *  running iff !isGroup && awaiting==null && (isRunning||isRunningTurn||isComposingMessage).
 */
function agentBusyFlags(a) {
  const awaiting = a?.awaitingUserResponse != null;
  const running =
    !a?.isGroup &&
    !awaiting &&
    !!(a?.isRunning || a?.isRunningTurn || a?.isComposingMessage);
  return { awaiting, running };
}

function pickCoder(agents) {
  return (
    (CODER_ID ? agents.find((a) => a?.id === CODER_ID) : null) ||
    agents.find((a) => a?.name === 'Coder') ||
    null
  );
}

function mapStatus(agents, health) {
  const list = Array.isArray(agents) ? agents : [];
  const coder = pickCoder(list);
  const coderFlags = coder ? agentBusyFlags(coder) : { awaiting: false, running: false };

  let anyAwaiting = coderFlags.awaiting;
  let anyRunning = coderFlags.running;
  for (const a of list) {
    if (a === coder) continue;
    const f = agentBusyFlags(a);
    if (f.awaiting) anyAwaiting = true;
    if (f.running) anyRunning = true;
  }

  // Priority: needs_input > running > idle.
  // Do NOT promote on health.isBusy alone (temporal overlay can be stale/false).
  let status = 'idle';
  if (coderFlags.awaiting || anyAwaiting) status = 'needs_input';
  else if (coderFlags.running || anyRunning) status = 'running';

  const summary =
    status === 'needs_input'
      ? 'Grok Bot：等操作'
      : status === 'running'
        ? 'Grok Bot：工作中'
        : 'Grok Bot：空闲';

  return {
    status,
    summary,
    coder,
    coderFlags,
    host: {
      isBusy: health?.isBusy === true,
      activeAgentId: health?.activeAgentId ?? null,
    },
  };
}

function buildDrop(mapped) {
  const coder = mapped.coder;
  return {
    schemaVersion: 1,
    agentId: 'grok-bot',
    status: mapped.status,
    summary: mapped.summary,
    observedAt: new Date().toISOString(),
    vendor: 'grok-bot',
    meta: {
      source: 'sand-listAgents',
      signal: 'host-gateway',
      forceVersion: FORCE_VERSION,
      coder: {
        id: coder?.id ?? null,
        name: coder?.name ?? 'Coder',
        isRunningTurn: !!coder?.isRunningTurn,
        isRunning: !!coder?.isRunning,
        isComposingMessage: !!coder?.isComposingMessage,
        awaitingUserResponse: coder?.awaitingUserResponse ?? null,
        activityTool: activityTool(coder),
      },
      host: mapped.host,
    },
  };
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

async function main() {
  const gw = loadGateway();
  const health = await fetchJson(`${gw.baseUrl}/health`);
  const raw = await fetchJson(`${gw.baseUrl}/api/listAgents`, {
    method: 'POST',
    token: gw.token,
    body: {},
  });
  const agents = Array.isArray(raw) ? raw : raw?.agents || [];
  const mapped = mapStatus(agents, health);
  const drop = buildDrop(mapped);
  const text = JSON.stringify(drop, null, 2) + '\n';
  process.stdout.write(text);
  try {
    writeAtomic(OUT_RUNTIME, text);
  } catch {
    /* optional */
  }
  try {
    writeAtomic(OUT_TMP, text);
  } catch {
    /* optional */
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
