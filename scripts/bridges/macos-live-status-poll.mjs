#!/usr/bin/env node
/**
 * Live Mac status → public/status + ~/.agent-stage/status
 *
 * Fine / coarse / process-only sources only — never invent fake live APIs.
 * See docs/LIMITATIONS.md for fidelity per agent.
 *
 * Grok Bot: prefer Path A listAgents via GROK_BOT_GATEWAY_* or
 * ~/.agent-stage/grok-gateway.json; else Path B drop meta.source=sand-listAgents
 * (forceVersion grok-official-listagents-v2). Never invent coder-heartbeat.
 * Hermes: gateway.sock status / gateway_state active_agents
 * (forceVersion hermes-official-signal-v1); not desktop-presence alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../..');
const once = process.argv.includes('--once');
const intervalMs =
  Number(
    (() => {
      const i = process.argv.indexOf('--interval');
      return i >= 0 ? process.argv[i + 1] : '2000';
    })(),
  ) || 2000;

function writeSnapshot(agentId, status, summary, vendor, meta = {}) {
  const targets = [
    join(homedir(), '.agent-stage', 'status', `${agentId}.json`),
    join(PROJECT, 'public', 'status', `${agentId}.json`),
  ];
  // Keep observedAt stable when status+summary unchanged so the UI does not re-emit.
  const prev = readJson(targets[0]) || readJson(targets[1]);
  const unchanged =
    prev &&
    prev.schemaVersion === 1 &&
    prev.status === status &&
    prev.summary === summary &&
    prev.vendor === vendor;
  const body = {
    schemaVersion: 1,
    agentId,
    status,
    summary,
    observedAt: unchanged && prev.observedAt ? prev.observedAt : new Date().toISOString(),
    vendor,
    meta: { source: 'macos-live-status-poll', ...meta },
  };
  const text = JSON.stringify(body, null, 2) + '\n';
  for (const out of targets) {
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${process.pid}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, out);
  }
  if (!unchanged) {
    console.log(`[${body.observedAt}] ${agentId} ${status} — ${summary}`);
  }
}

/** Mirror into Vite public/ only — do not clobber an external ~/.agent-stage heartbeat. */
function writePublicOnly(agentId, status, summary, vendor, meta = {}) {
  const body = {
    schemaVersion: 1,
    agentId,
    status,
    summary,
    observedAt: new Date().toISOString(),
    vendor,
    meta: { source: 'macos-live-status-poll', mirrored: true, ...meta },
  };
  const text = JSON.stringify(body, null, 2) + '\n';
  const out = join(PROJECT, 'public', 'status', `${agentId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp.${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, out);
  console.log(`[${body.observedAt}] ${agentId} ${status} — ${summary} (public mirror)`);
}

function psOut() {
  const r = spawnSync('ps', ['-ax', '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
  return r.stdout || '';
}

/**
 * Presence = main GUI/CLI binary whitelist only.
 * Match path fragments exactly; require a boundary after the fragment so
 * ".../MacOS/Hermes" does not hit ".../MacOS/Hermes-Setup".
 * Never match bare brand names, Helpers, crashpad, or CLI shims inside another app.
 */
function appMainRunning(candidates, hay = null) {
  const h = hay ?? psOut();
  if (!candidates || candidates.length === 0) return false;
  for (const frag of candidates) {
    if (!frag) continue;
    // Directory / prefix fragments (trailing slash) match as substrings.
    if (frag.endsWith('/')) {
      if (h.includes(frag)) return true;
      continue;
    }
    let idx = 0;
    while ((idx = h.indexOf(frag, idx)) !== -1) {
      const after = h[idx + frag.length];
      // Boundary: end of argv token — blocks Hermes vs Hermes-Setup
      if (
        after === undefined ||
        after === '\n' ||
        after === '\r' ||
        after === ' ' ||
        after === '\t' ||
        after === '"' ||
        after === "'"
      ) {
        return true;
      }
      idx += 1;
    }
  }
  return false;
}

/** Verified Mac path fragments for each roster agent (Contents/MacOS mains). */
const APP_MAINS = {
  'workbuddy-1': ['WorkBuddy.app/Contents/MacOS/Electron'],
  'codebuddy-1': [
    'CodeBuddy CN.app/Contents/MacOS/Electron',
    'CodeBuddy.app/Contents/MacOS/Electron',
    'CodeBuddy CN.app/Contents/MacOS/CodeBuddy',
    'CodeBuddy.app/Contents/MacOS/CodeBuddy',
  ],
  // Real desktop under ~/.hermes/.../apps/desktop/... — NOT /Applications/Hermes.app (Hermes-Setup)
  'hermes-1': [
    'hermes-agent/apps/desktop/',
    // exact main binary name with boundary (Hermes-Setup will not match)
    'Hermes.app/Contents/MacOS/Hermes',
  ],
  'dsh-1': ['DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'],
  'marvs-1': ['Marvis.app/Contents/MacOS/Marvis'],
  'autoclaw-1': ['AutoClaw.app/Contents/MacOS/AutoClaw'],
  'doubao-1': ['DoubaoWork.app/Contents/MacOS/DoubaoWork'],
  'grok-bot-1': ['Grok Bot.app/Contents/MacOS/Grok Bot'],
  // Never use bare '/bin/claude' — matches Hermes ~/.hermes/node/bin/claude etc.
  'claude-code-1': [
    '@anthropic-ai/claude-code/',
    '/.local/bin/claude',
    '/npm-global/bin/claude',
    'Claude.app/Contents/MacOS/Claude',
  ],
  'codex-1': [
    'codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'Codex.app/Contents/MacOS/Codex',
    'Codex Computer Use.app/Contents/MacOS/SkyComputerUseService',
  ],
};

function sqlite(db, sql) {
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

function httpJson(url, timeoutMs = 1500) {
  try {
    const r = spawnSync(
      'curl',
      ['-sS', '-m', String(timeoutMs / 1000), '-H', 'Accept: application/json', url],
      { encoding: 'utf8', timeout: timeoutMs + 500 },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const t = r.stdout.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return { _raw: t.slice(0, 200) };
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}


function observedAgeMs(obj) {
  if (!obj?.observedAt) return null;
  const t = Date.parse(obj.observedAt);
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

/** Newest mtime age under root for files matching pred(name). */
function newestMatchingAgeMs(root, pred, maxDepth = 6) {
  if (!existsSync(root)) return null;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
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
        else if (pred(e, p) && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return newest ? Date.now() - newest : null;
}

function anySessionLock(root) {
  if (!existsSync(root)) return false;
  let found = false;
  const walk = (dir, depth) => {
    if (found || depth > 6) return;
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
        else if (e.endsWith('.jsonl.lock') && Date.now() - st.mtimeMs < 120_000) found = true;
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return found;
}

function gatewayTraceRecent(logPath, windowMs = 60_000) {
  const age = mtimeAgeMs(logPath);
  if (age == null || age > windowMs) return false;
  try {
    const buf = readFileSync(logPath, 'utf8');
    const tail = buf.slice(-80_000);
    // Prefer lines with AutoClawRequestTrace near end
    const idx = tail.lastIndexOf('AutoClawRequestTrace');
    if (idx < 0) return age < 45_000; // recent log write still counts lightly
    // Parse timestamp on that line if present: 2026-10-20T12:13:58.745+08:00
    const lineStart = tail.lastIndexOf('\n', idx) + 1;
    const line = tail.slice(lineStart, lineStart + 120);
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
    if (m) {
      const t = Date.parse(m[1]);
      if (!Number.isNaN(t) && Date.now() - t < windowMs) return true;
    }
    return age < windowMs;
  } catch {
    return false;
  }
}

function openclawActiveTasks(dbPath) {
  const row = sqlite(
    dbPath,
    "SELECT task_id,status FROM task_runs WHERE ended_at IS NULL AND lower(status) NOT IN ('succeeded','success','failed','error','cancelled','canceled','done','completed') LIMIT 1;",
  );
  return row || null;
}


function liveWorkBuddyInteractive() {
  const dir = join(homedir(), '.workbuddy', 'sessions');
  if (!existsSync(dir)) return null;
  let best = null;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const j = readJson(join(dir, name));
    if (!j || j.kind !== 'interactive' || !j.sessionId) continue;
    if (String(j.sessionId).startsWith('prewarm-')) continue;
    const hb = Number(j.lastHeartbeat || j.updatedAt || 0);
    if (!hb || now - hb > 45_000) continue;
    if (!best || hb > best.hb) best = { sessionId: String(j.sessionId), hb, pid: j.pid };
  }
  return best;
}

function pollWorkBuddy() {
  const id = 'workbuddy-1';
  const vendor = 'workbuddy';
  const db = join(homedir(), '.workbuddy', 'workbuddy.db');
  const appUp = appMainRunning(APP_MAINS['workbuddy-1']);
  if (!existsSync(db)) {
    writeSnapshot(
      id,
      appUp ? 'idle' : 'offline',
      appUp ? 'WorkBuddy：应用在线（无数据库）' : 'WorkBuddy：下线',
      vendor,
    );
    return;
  }

  if (!appUp) {
    writeSnapshot(id, 'offline', 'WorkBuddy：下线', vendor);
    return;
  }

  const runningAuto = sqlite(
    db,
    'SELECT automation_id FROM automation_runtime_state WHERE running=1 LIMIT 1;',
  );
  if (runningAuto) {
    writeSnapshot(id, 'running', `WorkBuddy：自动化运行中（${runningAuto})`, vendor, {
      automationId: runningAuto,
    });
    return;
  }

  const live = liveWorkBuddyInteractive();
  if (live) {
    writeSnapshot(
      id,
      'running',
      `WorkBuddy：工作中（交互会话） (${live.sessionId.slice(0, 8)}…)`,
      vendor,
      { sessionId: live.sessionId, lastHeartbeat: live.hb, pid: live.pid },
    );
    return;
  }

  const pendingCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const pending = sqlite(
    db,
    "SELECT count(*) FROM automation_runs WHERE status='PENDING_REVIEW' " +
      `AND updated_at > ${pendingCutoff} ` +
      "AND COALESCE(result_success, 1) = 1 " +
      "AND IFNULL(json_extract(metadata_json, '$.resultState'), '') NOT IN ('failed','cancelled');",
  );
  if (pending && Number(pending) > 0) {
    writeSnapshot(
      id,
      'needs_input',
      `WorkBuddy：${pending} 个自动化待审`,
      vendor,
    );
    return;
  }

  const row = sqlite(
    db,
    "SELECT status || '|' || COALESCE(title,'') || '|' || COALESCE(last_activity_at,0) FROM sessions WHERE deleted_at IS NULL OR deleted_at='' ORDER BY last_activity_at DESC LIMIT 1;",
  );
  if (!row) {
    writeSnapshot(id, appUp ? 'idle' : 'offline', 'WorkBuddy：无会话', vendor);
    return;
  }
  const [st, title, lastAct] = row.split('|');
  const ageMs = Date.now() - Number(lastAct || 0);
  const low = String(st).toLowerCase();
  let status = 'idle';
  let summary = `WorkBuddy：${st} — ${(title || '').slice(0, 60)}`;
  if (['failed', 'error', 'terminated'].includes(low)) {
    status = 'error';
  } else if (['completed'].includes(low)) {
    status = ageMs < 120_000 ? 'done' : 'idle';
    if (ageMs >= 120_000) summary = `WorkBuddy：空闲（上次：${(title || '').slice(0, 50)})`;
  } else if (['archived'].includes(low)) {
    status = 'idle';
    summary = `WorkBuddy：空闲（上次归档：${(title || '').slice(0, 50)})`;
  } else if (['running', 'working', 'active', 'in_progress', 'busy'].includes(low)) {
    status = 'running';
  } else if (['waiting', 'blocked', 'needs_input', 'pending'].includes(low)) {
    status = 'needs_input';
  }
  if (!appUp) {
    writeSnapshot(id, 'offline', 'WorkBuddy：下线', vendor, {
      sessionStatus: st,
      lastActivityAt: Number(lastAct),
    });
    return;
  }
  writeSnapshot(id, status, summary, vendor, {
    sessionStatus: st,
    lastActivityAt: Number(lastAct),
  });
}

/** Official Hermes busy contract (gateway/status.py derive_gateway_busy).
 * forceVersion hermes-official-signal-v1
 * Prefer live gateway.sock verb=status; fall back to ~/.hermes/gateway_state.json.
 * Busy iff gateway_state in {running,degraded} && active_agents > 0.
 * Corroborate with state.db session_turn_leases (unexpired DurableTurnLease).
 * needs_input: kanban blocked+needs_input; recent pending/{memory,skills} writes only.
 * Gap: in-memory gateway command approvals / LiveSessionStatus.waiting are NOT on the control socket.
 */
const HERMES_OFFICIAL_FORCE = 'hermes-official-signal-v1';
const HERMES_DRAINABLE = new Set(['running', 'degraded']);

function hermesControlStatus() {
  const script = [
    'import json,socket,os,sys',
    'p=os.path.expanduser("~/.hermes/gateway.sock")',
    's=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
    's.settimeout(1.5)',
    'try:',
    ' s.connect(p)',
    'except Exception:',
    ' sys.exit(2)',
    's.sendall(b\'{"verb":"status","protocol":1,"id":1}\\n\')',
    'data=b""',
    'while True:',
    ' chunk=s.recv(65536)',
    ' if not chunk: break',
    ' data+=chunk',
    's.close()',
    'resp=json.loads(data.decode())',
    'if not resp.get("ok"): sys.exit(3)',
    'print(json.dumps(resp.get("result") or {}, default=str))',
  ].join('\n');
  const r = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 1_000_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

function hermesLiveTurnLeases() {
  const db = join(homedir(), '.hermes', 'state.db');
  if (!existsSync(db)) return 0;
  // expires_at is unix epoch seconds (DurableTurnLease).
  const now = Date.now() / 1000;
  const row = sqlite(
    db,
    `SELECT count(*) FROM session_turn_leases WHERE expires_at > ${now};`,
  );
  return Number(row || 0) || 0;
}

function hermesKanbanNeedsInput() {
  const db = join(homedir(), '.hermes', 'kanban.db');
  if (!existsSync(db)) return 0;
  const row = sqlite(
    db,
    "SELECT count(*) FROM tasks WHERE status='blocked' AND block_kind='needs_input';",
  );
  return Number(row || 0) || 0;
}

/** File-backed write approvals (tools/write_approval.py). Skip stale orphans. */
function hermesRecentPendingWrites(maxAgeMs = 24 * 60 * 60 * 1000) {
  const root = join(homedir(), '.hermes', 'pending');
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const sub of ['memory', 'skills']) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    let ents = [];
    try {
      ents = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.endsWith('.json')) continue;
      const age = mtimeAgeMs(join(dir, e));
      if (age != null && age <= maxAgeMs) n += 1;
    }
  }
  return n;
}

function pollHermes() {
  const id = 'hermes-1';
  const hay = psOut();
  const desktopUp = appMainRunning(APP_MAINS['hermes-1'], hay);
  const fileG = readJson(join(homedir(), '.hermes', 'gateway_state.json'));
  const liveG = hermesControlStatus();
  const g = liveG || fileG;
  const signalSource = liveG ? 'gateway.sock:status' : fileG ? 'gateway_state.json' : null;

  // Presence: desktop whitelist only (LIMITATIONS.md). launchd gateway alone ≠ online.
  if (!desktopUp) {
    writeSnapshot(id, 'offline', 'Hermes：下线（桌面已退出）', 'hermes', {
      gateway_state: g ? String(g.gateway_state || '') : null,
      active_agents: g ? Number(g.active_agents || 0) : null,
      desktop: false,
      signalSource,
      forceVersion: HERMES_OFFICIAL_FORCE,
    });
    return;
  }

  if (!g) {
    writeSnapshot(id, 'idle', 'Hermes：空闲（桌面在线，无网关状态）', 'hermes', {
      desktop: true,
      forceVersion: HERMES_OFFICIAL_FORCE,
    });
    return;
  }

  const gs = String(g.gateway_state || '');
  const active = Number(g.active_agents || 0);
  const leases = hermesLiveTurnLeases();
  const kanbanNeed = hermesKanbanNeedsInput();
  const pendingWrites = hermesRecentPendingWrites();
  // Official: derive_gateway_busy(running/degraded && active_agents > 0)
  const officialBusy = HERMES_DRAINABLE.has(gs) && active > 0;
  const turnBusy = leases > 0;
  const profiles = Array.isArray(g.served_profiles) ? g.served_profiles.join(',') : '';

  let status = 'idle';
  let summary = `Hermes：空闲${profiles ? `（配置：${profiles}）` : ''}`;
  if (gs && !HERMES_DRAINABLE.has(gs) && gs !== '') {
    status = 'error';
    summary = `Hermes：网关异常（${gs}）`;
  } else if (kanbanNeed > 0 || pendingWrites > 0) {
    status = 'needs_input';
    if (kanbanNeed > 0 && pendingWrites > 0) {
      summary = `Hermes：等操作（kanban ${kanbanNeed} + 待审写入 ${pendingWrites}）`;
    } else if (kanbanNeed > 0) {
      summary = `Hermes：等操作（kanban needs_input ×${kanbanNeed}）`;
    } else {
      summary = `Hermes：等操作（待审写入 ×${pendingWrites}）`;
    }
  } else if (officialBusy || turnBusy) {
    status = 'running';
    if (officialBusy && turnBusy) {
      summary = `Hermes：工作中（active_agents=${active}，leases=${leases}）`;
    } else if (officialBusy) {
      summary = `Hermes：工作中（active_agents=${active}）`;
    } else {
      summary = `Hermes：工作中（turn lease ×${leases}）`;
    }
  }

  writeSnapshot(id, status, summary, 'hermes', {
    active_agents: active,
    gateway_state: gs,
    updated_at: g.updated_at || null,
    answered_at: g.answered_at || null,
    desktop: true,
    live_leases: leases,
    kanban_needs_input: kanbanNeed,
    pending_writes_24h: pendingWrites,
    official_busy: officialBusy,
    signalSource,
    forceVersion: HERMES_OFFICIAL_FORCE,
  });
}


/** Read last ~maxBytes of a text log via tail -c (fast). */
function readLogTail(logPath, maxBytes = 200_000) {
  try {
    if (!existsSync(logPath)) return '';
    const r = spawnSync('tail', ['-c', String(maxBytes), logPath], {
      encoding: 'utf8',
      maxBuffer: maxBytes + 50_000,
      timeout: 2000,
    });
    if (r.status === 0 && r.stdout != null) return r.stdout;
    const st = statSync(logPath);
    if (st.size < maxBytes * 2) return readFileSync(logPath, 'utf8');
    return '';
  } catch {
    return '';
  }
}

function parseIsoAgeMs(isoOrLocal) {
  if (!isoOrLocal) return null;
  // 2026-10-20T08:24:47.556Z or 2026-10-20T16:05:10.506+08:00 or 2026-10-20 16:26:24
  let s = String(isoOrLocal).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    s = s.replace(' ', 'T');
  }
  // Bare local wall clock → Asia/Shanghai; bare ISO-T (Marvis approvals) → UTC.
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) s += 'Z';
    else s += '+08:00';
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

/**
 * AutoClaw UI chat-turn observability (autoclaw-dev.log).
 * Open turn = enqueued/submit without a later terminal for that turn_id,
 * still within maxAgeMs (long model calls can sit for many minutes).
 */
function autoclawOpenChatTurn(devLogPath, maxAgeMs = 30 * 60_000) {
  const tail = readLogTail(devLogPath, 400_000);
  if (!tail) return null;
  // Per turn: track latest event + whether a terminal outcome was seen.
  // Real AutoClaw events: chat_turn_terminal / summary / persisted / rendered
  // (not "completed"). Prefer ISO j.ts for age — event_at may be timeTicks.
  const turns = new Map();
  const terminal =
    /chat_turn_(terminal|summary|persisted|rendered|completed|complete|finished|failed|cancelled|canceled|aborted|error|done)/i;
  const openish =
    /chat_turn_(enqueued|submit_attempt|submit|dispatched|gateway_ack|stream_started|first_visible|started|running|processing)/i;
  for (const line of tail.split('\n')) {
    if (!line.includes('chat_turn_')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = String(j.message || '');
    if (!msg.startsWith('chat_turn_')) continue;
    const turnId = j.data?.turn_id || j.data?.turnId;
    if (!turnId) continue;
    const age = parseIsoAgeMs(j.ts);
    const prev = turns.get(turnId) || { closed: false, msg: '', age: null };
    if (terminal.test(msg)) prev.closed = true;
    if (age != null && (prev.age == null || age < prev.age)) {
      prev.age = age;
      prev.msg = msg;
    } else if (!prev.msg) {
      prev.msg = msg;
    }
    // Keep closed flag even if a later non-terminal slips in (shouldn't).
    if (terminal.test(msg)) prev.closed = true;
    turns.set(turnId, prev);
  }
  // Newest open (non-closed) turn only — ignore abandoned older enqueues.
  let best = null;
  for (const [id, info] of turns) {
    if (info.closed) continue;
    if (info.age == null || info.age > maxAgeMs) continue;
    if (!openish.test(info.msg)) continue;
    if (!best || info.age < best.ageMs) {
      best = { turnId: id, ageMs: info.age, event: info.msg };
    }
  }
  return best;
}

/**
 * Gateway diagnostic: state=processing with fresh lastProgressAge on a recent line.
 */
function gatewayProcessingRecent(logPath, windowMs = 180_000) {
  const age = mtimeAgeMs(logPath);
  if (age == null) return null;
  const tail = readLogTail(logPath, 120_000);
  if (!tail) return null;
  let best = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('state=processing')) continue;
    const mTs = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
    const lineAge = mTs ? parseIsoAgeMs(mTs[1]) : age;
    if (lineAge == null || lineAge > windowMs) continue;
    const mProg = line.match(/lastProgressAge=(\d+)s/);
    const progressAgeSec = mProg ? Number(mProg[1]) : 0;
    // Stale progress on an old diagnostic should not keep us "running" forever,
    // but gateway only emits these ~every few minutes while processing.
    if (progressAgeSec > 120 && lineAge > 90_000) continue;
    const rec = { lineAgeMs: lineAge, progressAgeSec };
    if (!best || lineAge < best.lineAgeMs) best = rec;
  }
  return best;
}

/**
 * Marvis live work from main.log: [streaming] + office state machine.
 */
function marvisMainLogActivity(logPath) {
  const tail = readLogTail(logPath, 250_000);
  if (!tail) return { streamingAgeMs: null, state: null, stateAgeMs: null };
  let streamingAgeMs = null;
  let state = null;
  let stateAgeMs = null;
  const reTs = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\]/;
  for (const line of tail.split('\n')) {
    const m = line.match(reTs);
    if (!m) continue;
    const age = parseIsoAgeMs(m[1]);
    if (age == null) continue;
    if (line.includes('[streaming]')) {
      streamingAgeMs = age; // last wins
    }
    // Prefer agent state transitions for Marvis office/project avatar
    if (
      (line.includes('workbench:office:agent:Marvis') ||
        line.includes('workbench:project:agent:Marvis')) &&
      line.includes('状态:')
    ) {
      const sm = line.match(/状态:\s*[^→\n]+→\s*([A-Z_]+\/[A-Z_]+)/);
      if (sm) {
        state = sm[1];
        stateAgeMs = age;
      }
    }
  }
  return { streamingAgeMs, state, stateAgeMs };
}

function marvisRecentPendingApproval(userRoot, maxAgeMs = 2 * 60 * 60_000) {
  // pending ask_user / tool confirm created recently → needs_input
  if (!existsSync(userRoot)) return null;
  let users = [];
  try {
    users = readdirSync(userRoot);
  } catch {
    return null;
  }
  for (const u of users) {
    if (u.startsWith('.')) continue;
    const db = join(userRoot, u, 'database', 'data.db');
    if (!existsSync(db)) continue;
    const row = sqlite(
      db,
      "SELECT approval_id, tool_name, status, created_at FROM approvals WHERE lower(status)='pending' ORDER BY created_at DESC LIMIT 5;",
    );
    if (!row) continue;
    // sqlite() returns first row string; re-query via spawn for age check below
    const all = spawnSync(
      'sqlite3',
      [
        db,
        "SELECT created_at || '|' || tool_name || '|' || approval_id FROM approvals WHERE lower(status)='pending' ORDER BY created_at DESC LIMIT 5;",
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    const lines = (all.stdout || '').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [created, tool, id] = line.split('|');
      const age = parseIsoAgeMs(created);
      if (age != null && age < maxAgeMs) {
        return { id, tool, ageMs: age };
      }
    }
  }
  return null;
}

function marvisWorkspaceHot(userRoot, windowMs = 45_000) {
  // Only tool-result artifacts — data.db-wal churns while idle and must not count.
  if (!existsSync(userRoot)) return null;
  const age = newestMatchingAgeMs(
    userRoot,
    (name, p) => p.includes('/.tool-results/') && name.startsWith('call_'),
    8,
  );
  if (age != null && age < windowMs) return age;
  return null;
}

function pollAutoClaw() {
  const id = 'autoclaw-1';
  const health =
    httpJson('http://127.0.0.1:8766/health') || httpJson('http://127.0.0.1:18789/health');
  const bindingsPath = join(
    homedir(),
    'Library/Application Support/autoclaw/im/agent-identity-bindings.json',
  );
  const bindings = readJson(bindingsPath);
  const list = bindings?.bindings || [];
  const statuses = list.map((b) => String(b.status || '').toLowerCase());
  const appUp = appMainRunning(APP_MAINS['autoclaw-1']);
  const ocRoot = join(homedir(), '.openclaw-autoclaw');
  const agentsRoot = join(ocRoot, 'agents');
  const gatewayLog = join(ocRoot, 'logs', 'gateway.log');
  const dbPath = join(ocRoot, 'state', 'openclaw.sqlite');

  // Presence = main app binary. Gateway HTTP alone must not keep seat "idle online".
  if (!appUp) {
    writeSnapshot(id, 'offline', 'AutoClaw：下线', 'autoclaw');
    return;
  }
  if (
    health &&
    (health.ok === false ||
      (health.status && health.status !== 'live' && health.status !== 'ok'))
  ) {
    writeSnapshot(id, 'error', 'AutoClaw：网关异常', 'autoclaw', { health });
    return;
  }
  if (statuses.some((s) => ['error', 'failed'].includes(s))) {
    writeSnapshot(id, 'error', 'AutoClaw：坐席绑定异常', 'autoclaw');
    return;
  }
  if (statuses.some((s) => s === 'offline') && !appUp) {
    writeSnapshot(id, 'offline', 'AutoClaw：下线', 'autoclaw');
    return;
  }

  // Live work signals (bindings stay "ready" while connected — do not treat as idle-only)
  const hasLock = anySessionLock(agentsRoot);
  const sessionAge = newestMatchingAgeMs(
    agentsRoot,
    (name) =>
      (name.endsWith('.jsonl') || name.endsWith('.trajectory.jsonl')) &&
      !name.endsWith('.lock'),
  );
  const devLog = join(ocRoot, 'logs', 'autoclaw-dev.log');
  // Open-turn maxAge is a search window; alone/corroborated caps decide running.
  const openTurn = autoclawOpenChatTurn(devLog, 15 * 60_000);
  const processing = gatewayProcessingRecent(gatewayLog, 90_000);
  const traceHot = gatewayTraceRecent(gatewayLog, 45_000);
  const activeTask = openclawActiveTasks(dbPath);
  // Session jsonl mtime alone is weak (final persist keeps it hot) — keep short.
  const SESSION_HOT_MS = 75_000;

  if (hasLock) {
    writeSnapshot(id, 'running', 'AutoClaw：工作中（会话锁）', 'autoclaw', {
      signal: 'jsonl.lock',
      sessionAgeMs: sessionAge,
    });
    return;
  }
  if (activeTask) {
    writeSnapshot(id, 'running', `AutoClaw：工作中（任务 ${activeTask}）`, 'autoclaw', {
      signal: 'task_runs',
    });
    return;
  }
  if (processing) {
    writeSnapshot(
      id,
      'running',
      `AutoClaw：工作中（网关 processing，进度 ${processing.progressAgeSec}s 前）`,
      'autoclaw',
      { signal: 'gateway.processing', ...processing },
    );
    return;
  }
  // Enqueued-without-terminal is common; alone only ~90s. Corroborate with lock/processing
  // (not bare session mtime — persist after success would false-positive).
  if (openTurn) {
    const alone = openTurn.ageMs < 90_000;
    const corroborated =
      openTurn.ageMs < 10 * 60_000 && (processing || hasLock);
    if (alone || corroborated) {
      writeSnapshot(
        id,
        'running',
        `AutoClaw：工作中（对话回合 ${Math.round(openTurn.ageMs / 1000)}s）`,
        'autoclaw',
        { signal: openTurn.event, turnId: openTurn.turnId, ageMs: openTurn.ageMs },
      );
      return;
    }
  }
  if (sessionAge != null && sessionAge < SESSION_HOT_MS) {
    writeSnapshot(
      id,
      'running',
      `AutoClaw：工作中（会话 ${Math.round(sessionAge / 1000)}s 前有写入）`,
      'autoclaw',
      { signal: 'session.jsonl', sessionAgeMs: sessionAge },
    );
    return;
  }
  if (traceHot) {
    writeSnapshot(id, 'running', 'AutoClaw：工作中（网关请求痕迹）', 'autoclaw', {
      signal: 'AutoClawRequestTrace',
    });
    return;
  }
  if (statuses.some((s) => ['busy', 'running', 'working', 'active'].includes(s))) {
    writeSnapshot(id, 'running', 'AutoClaw：工作中', 'autoclaw');
    return;
  }
  if (statuses.some((s) => ['waiting', 'blocked', 'needs_auth', 'needs_input'].includes(s))) {
    writeSnapshot(id, 'needs_input', 'AutoClaw：等操作', 'autoclaw');
    return;
  }
  const ready = statuses.filter((s) => s === 'ready' || s === 'idle').length;
  writeSnapshot(
    id,
    'idle',
    `AutoClaw：空闲（网关在线，${ready || list.length} 个坐席就绪）`,
    'autoclaw',
    { agents: list.map((b) => ({ id: b.agentId, status: b.status })) },
  );
}

function newestSessionAgeMs(root) {
  if (!existsSync(root)) return null;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
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
        else if (
          (e.includes('session') || e.startsWith('rollout-')) &&
          (e.endsWith('.zstd') || e.endsWith('.jsonl') || e.endsWith('.json'))
        ) {
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return newest ? Date.now() - newest : null;
}

function dshFreshLockAgeMs(root) {
  // Live session.lock touched recently (ignore stale empty leftovers).
  if (!existsSync(root)) return null;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
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
        else if (e === 'session.lock' && st.size > 0 && st.mtimeMs > newest) {
          newest = st.mtimeMs;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return newest ? Date.now() - newest : null;
}


/**
 * DSH near-official busy: newest session*.jsonl.zstd has turn/start without turn/end.
 * Event log is the harness's own turn machine (not presence).
 * forceVersion dsh-stream-openturn-v1 — stream zstd (no spawnSync maxBuffer / ENOBUFS).
 */
const DSH_STREAM_OPENTURN_FORCE = 'dsh-stream-openturn-v1';

function dshOpenTurn(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return null;
  let newestPath = null;
  let newestMs = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
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
        else if (e.endsWith('.jsonl.zstd')) {
          if (st.mtimeMs > newestMs) {
            newestMs = st.mtimeMs;
            newestPath = p;
          }
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(sessionsRoot, 0);
  if (!newestPath) return null;
  const fileAge = Date.now() - newestMs;
  // Stream decompress — live sessions can be >>8MB uncompressed; spawnSync ENOBUFS.
  const open = new Map();
  let lastClosedTurnMs = null;
  const ok = dshScanZstdTurns(newestPath, open, (endTs) => {
    if (Number.isFinite(endTs)) lastClosedTurnMs = endTs;
  });
  if (!ok) return null;
  if (open.size === 0) {
    return {
      open: null,
      lastClosedTurnMs,
      fileAgeMs: fileAge,
      path: newestPath,
    };
  }
  // Open turn with no end — busy. Cap by file age so ancient corrupt logs do not stick.
  if (fileAge > 30 * 60_000) return { open: null, lastClosedTurnMs, fileAgeMs: fileAge, path: newestPath };
  const turnId = [...open.keys()].pop();
  const startMs = open.get(turnId);
  const ageMs =
    startMs != null && Number.isFinite(startMs) ? Date.now() - startMs : fileAge;
  return {
    open: { turnId, ageMs, fileAgeMs: fileAge, path: newestPath },
    lastClosedTurnMs,
    fileAgeMs: fileAge,
    path: newestPath,
  };
}

/** Stream `zstd -dc` in a child Node so line scan never buffers the full ~25MB. */
function dshScanZstdTurns(zstdPath, openMap, onTurnEnd) {
  // Pass path via env — Hermes/node -e argv shapes vary; avoid argv[1] pitfalls.
  const scanner = `
const { spawn } = require('node:child_process');
const path = process.env.DSH_SCAN_ZSTD;
if (!path) { process.stdout.write(JSON.stringify({ ok: false, err: 'no-path' })); process.exit(0); }
const open = new Map();
let lastClosed = null;
const child = spawn('zstd', ['-dc', path], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
let buf = '';
let errBuf = '';
let killed = false;
const timer = setTimeout(() => {
  killed = true;
  try { child.kill('SIGKILL'); } catch {}
}, 8000);
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { errBuf += c; });
child.stdout.on('data', (chunk) => {
  if (killed) return;
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.includes('turn/')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const turn = j.data && j.data.turn;
    const ts = Number(j.time);
    if (j.type === 'turn/start' && turn != null) {
      open.set(turn, Number.isFinite(ts) ? ts : Date.now());
    } else if (j.type === 'turn/end' && turn != null) {
      open.delete(turn);
      if (Number.isFinite(ts)) lastClosed = ts;
    }
  }
});
child.on('error', (e) => {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  process.exit(0);
});
child.on('close', (code) => {
  clearTimeout(timer);
  if (killed) {
    process.stdout.write(JSON.stringify({ ok: false, err: 'timeout' }));
    process.exit(0);
  }
  // zstd returns 0 on success; treat null/0 as ok. Nonzero with empty open may still be fail.
  if (code !== 0 && code !== null) {
    process.stdout.write(JSON.stringify({ ok: false, code, err: errBuf.slice(0, 200) }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    open: [...open.entries()],
    lastClosed,
  }));
  process.exit(0);
});
`;
  const r = spawnSync(process.execPath, ['-e', scanner], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1_000_000,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH || ''}`,
      DSH_SCAN_ZSTD: zstdPath,
    },
  });
  if (r.error || !r.stdout) return false;
  let parsed;
  try {
    parsed = JSON.parse(String(r.stdout).trim());
  } catch {
    return false;
  }
  if (!parsed?.ok) return false;
  openMap.clear();
  for (const [turn, ts] of parsed.open || []) {
    openMap.set(turn, ts);
  }
  if (typeof onTurnEnd === 'function' && parsed.lastClosed != null) {
    onTurnEnd(parsed.lastClosed);
  }
  return true;
}

function pollDsh() {
  const id = 'dsh-1';
  const hay = psOut();
  const appUp = appMainRunning(APP_MAINS['dsh-1'], hay);
  const sessionsRoot = join(homedir(), '.dsh', 'sessions');
  const age = newestSessionAgeMs(sessionsRoot);
  const lockAge = dshFreshLockAgeMs(sessionsRoot);
  if (!appUp) {
    writeSnapshot(id, 'offline', 'DSH：下线', 'dsh', { ageMs: age });
    return;
  }
  // Near-official: open turn/start without turn/end in session jsonl.zstd
  const scanned = dshOpenTurn(sessionsRoot);
  const open = scanned?.open || null;
  if (open) {
    writeSnapshot(
      id,
      'running',
      `DSH：工作中（回合 ${open.turnId}，${Math.round(open.ageMs / 1000)}s）`,
      'dsh',
      {
        signal: 'turn/open',
        forceVersion: DSH_STREAM_OPENTURN_FORCE,
        ...open,
      },
    );
    return;
  }
  // Heuristic fallback: recent session write (widened; file may not rewrite every 15s)
  if ((age != null && age < 90_000) || (lockAge != null && lockAge < 90_000)) {
    const secs = Math.round((age != null ? age : lockAge) / 1000);
    writeSnapshot(id, 'running', `DSH：工作中（会话 ${secs}s 前有活动）`, 'dsh', {
      signal: 'session.mtime',
      forceVersion: DSH_STREAM_OPENTURN_FORCE,
      ageMs: age,
      lockAgeMs: lockAge,
    });
    return;
  }
  // App up + warm session (or recent closed turn) but no open turn → awaiting user, not idle.
  const closedAge =
    scanned?.lastClosedTurnMs != null && Number.isFinite(scanned.lastClosedTurnMs)
      ? Date.now() - scanned.lastClosedTurnMs
      : null;
  const warm =
    (age != null && age < 45 * 60_000) ||
    (closedAge != null && closedAge < 45 * 60_000);
  if (warm) {
    writeSnapshot(id, 'needs_input', 'DSH：等操作（会话待继续）', 'dsh', {
      signal: 'await-user',
      forceVersion: DSH_STREAM_OPENTURN_FORCE,
      ageMs: age,
      closedAgeMs: closedAge,
    });
    return;
  }
  if (age != null) {
    writeSnapshot(id, 'idle', 'DSH：空闲（应用在线）', 'dsh', {
      signal: 'idle',
      forceVersion: DSH_STREAM_OPENTURN_FORCE,
      ageMs: age,
    });
  } else {
    writeSnapshot(id, 'idle', 'DSH：空闲（应用在线）', 'dsh', {
      signal: 'idle',
      forceVersion: DSH_STREAM_OPENTURN_FORCE,
    });
  }
}

function pollMarvis() {
  const id = 'marvs-1';
  const appUp = appMainRunning(APP_MAINS['marvs-1']);
  if (!appUp) {
    writeSnapshot(id, 'offline', 'Marvis：下线', 'marvs');
    return;
  }

  const userRoot = join(
    homedir(),
    'Library/Application Support/com.tencent.mac.marvis/MarvisData/User',
  );
  const mainLog = join(homedir(), 'Library/Logs/com.tencent.mac.marvis/main.log');
  const pending = marvisRecentPendingApproval(userRoot);
  if (pending) {
    writeSnapshot(id, 'needs_input', `Marvis：等操作（${pending.tool || '审批'}）`, 'marvs', {
      signal: 'approvals.pending',
      ...pending,
    });
    return;
  }

  const act = marvisMainLogActivity(mainLog);
  const waitingState =
    act.state &&
    /WAITING|ASK_USER|NEED_INPUT|PENDING_APPROVAL|AWAITING/i.test(act.state) &&
    act.stateAgeMs != null &&
    act.stateAgeMs < 15 * 60_000;
  if (waitingState) {
    writeSnapshot(id, 'needs_input', `Marvis：等操作（${act.state}）`, 'marvs', {
      signal: 'main.log.state.waiting',
      state: act.state,
      stateAgeMs: act.stateAgeMs,
    });
    return;
  }
  const workingState =
    act.state &&
    /TASK_EXECUTING|WORKING|THINKING|TOOL|STREAMING/i.test(act.state) &&
    act.stateAgeMs != null &&
    act.stateAgeMs < 90_000;
  const streamingHot = act.streamingAgeMs != null && act.streamingAgeMs < 25_000;
  if (streamingHot || workingState) {
    const secs = Math.round((act.streamingAgeMs ?? act.stateAgeMs) / 1000);
    writeSnapshot(
      id,
      'running',
      streamingHot
        ? `Marvis：工作中（流式输出 ${secs}s 前）`
        : `Marvis：工作中（${act.state}，${secs}s 前）`,
      'marvs',
      {
        signal: streamingHot ? 'main.log.streaming' : 'main.log.state',
        state: act.state,
        streamingAgeMs: act.streamingAgeMs,
        stateAgeMs: act.stateAgeMs,
      },
    );
    return;
  }

  const hot = marvisWorkspaceHot(userRoot, 45_000);
  if (hot != null) {
    writeSnapshot(
      id,
      'running',
      `Marvis：工作中（工作区 ${Math.round(hot / 1000)}s 前有写入）`,
      'marvs',
      { signal: 'workspace.hot', ageMs: hot },
    );
    return;
  }

  // KB health is not a work signal — only annotate idle when app is up.
  const kb = httpJson('http://127.0.0.1:5151/health');
  const kbNote = kb && kb.ok ? '知识库正常' : '应用在线';
  writeSnapshot(id, 'idle', `Marvis：空闲（${kbNote}）`, 'marvs', {
    signal: 'idle',
    state: act.state,
    stateAgeMs: act.stateAgeMs,
  });
}


/**
 * Grok Bot status must be automatic (this board is a live aggregator).
 * Presence = main app binary. Optional: desktop-status.json pid still alive.
 * Do NOT trust long-lived manual heartbeats — assistants must not "clock out".
 * If the Grok Bot app itself later writes a fresh status drop (&lt;90s), accept it.
 */
function grokDesktopAppAlive() {
  const p = join(
    homedir(),
    'Library/Application Support/Grok Bot/desktop-status.json',
  );
  const j = readJson(p);
  if (!j || !j.pid) return null;
  try {
    process.kill(Number(j.pid), 0);
    return true;
  } catch {
    return false;
  }
}

const GROK_CODER_ID = '6998917b-4975-4b02-9ce8-ea42f3764ab9';
const GROK_OFFICIAL_FORCE = 'grok-official-listagents-v2';

/** Optional Path A: ops-provided gateway (env or ~/.agent-stage/grok-gateway.json). Never scrape sealed app secrets. */
function resolveGrokGatewayFromOps() {
  const envUrl = process.env.GROK_BOT_GATEWAY_URL || process.env.AGENT_STAGE_GROK_GATEWAY_URL;
  const envTok = process.env.GROK_BOT_GATEWAY_TOKEN || process.env.AGENT_STAGE_GROK_GATEWAY_TOKEN;
  if (envUrl && envTok) {
    return { gatewayUrl: String(envUrl).replace(/\/$/, ''), gatewayToken: String(envTok), via: 'env' };
  }
  const p = join(homedir(), '.agent-stage', 'grok-gateway.json');
  const j = readJson(p);
  if (j?.gatewayUrl && j?.gatewayToken) {
    return {
      gatewayUrl: String(j.gatewayUrl).replace(/\/$/, ''),
      gatewayToken: String(j.gatewayToken),
      via: 'agent-stage-file',
    };
  }
  return null;
}

function httpJsonPost(url, token, bodyObj, timeoutMs = 2000) {
  try {
    const r = spawnSync(
      'curl',
      [
        '-sS',
        '-m',
        String(timeoutMs / 1000),
        '-X',
        'POST',
        '-H',
        'Accept: application/json',
        '-H',
        'Content-Type: application/json',
        '-H',
        `Authorization: Bearer ${token}`,
        '-d',
        JSON.stringify(bodyObj ?? {}),
        url,
      ],
      { encoding: 'utf8', timeout: timeoutMs + 800 },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const t = r.stdout.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function grokAgentBusyFlags(a) {
  const awaiting = a?.awaitingUserResponse != null;
  const running =
    !a?.isGroup &&
    !awaiting &&
    !!(a?.isRunning || a?.isRunningTurn || a?.isComposingMessage);
  return { awaiting, running };
}

function mapGrokListAgentsStatus(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const coder =
    list.find((a) => a?.id === GROK_CODER_ID) ||
    list.find((a) => a?.name === 'Coder') ||
    null;
  let anyAwaiting = false;
  let anyRunning = false;
  const coderFlags = coder ? grokAgentBusyFlags(coder) : { awaiting: false, running: false };
  anyAwaiting = coderFlags.awaiting;
  anyRunning = coderFlags.running;
  for (const a of list) {
    if (a === coder) continue;
    const f = grokAgentBusyFlags(a);
    if (f.awaiting) anyAwaiting = true;
    if (f.running) anyRunning = true;
  }
  // Desktop semantics; do not use /health.isBusy alone.
  let status = 'idle';
  if (coderFlags.awaiting || anyAwaiting) status = 'needs_input';
  else if (coderFlags.running || anyRunning) status = 'running';
  const summary =
    status === 'needs_input'
      ? 'Grok Bot：等操作'
      : status === 'running'
        ? 'Grok Bot：工作中'
        : 'Grok Bot：空闲';
  return { status, summary, coder };
}

function grokStatusZh(st, fallback) {
  if (st === 'running') return 'Grok Bot：工作中';
  if (st === 'needs_input') return 'Grok Bot：等操作';
  if (st === 'needs_auth') return 'Grok Bot：需登录';
  if (st === 'done') return 'Grok Bot：已完成';
  if (st === 'error') return 'Grok Bot：异常';
  if (st === 'idle') return 'Grok Bot：空闲';
  return fallback || `Grok Bot：${st}`;
}

function pollGrokBotFromGateway() {
  const gw = resolveGrokGatewayFromOps();
  if (!gw) return null;
  const raw = httpJsonPost(`${gw.gatewayUrl}/api/listAgents`, gw.gatewayToken, {});
  if (!raw) return null;
  const agents = Array.isArray(raw) ? raw : raw.agents;
  if (!Array.isArray(agents)) return null;
  const mapped = mapGrokListAgentsStatus(agents);
  return {
    ...mapped,
    meta: {
      source: 'sand-listAgents',
      signal: 'host-gateway',
      forceVersion: GROK_OFFICIAL_FORCE,
      via: gw.via,
      coder: {
        id: mapped.coder?.id ?? GROK_CODER_ID,
        isRunningTurn: !!mapped.coder?.isRunningTurn,
        isRunning: !!mapped.coder?.isRunning,
        isComposingMessage: !!mapped.coder?.isComposingMessage,
        awaitingUserResponse: mapped.coder?.awaitingUserResponse ?? null,
      },
    },
  };
}

function pollGrokBot() {
  const id = 'grok-bot-1';
  const hay = psOut();
  const up = appMainRunning(APP_MAINS['grok-bot-1'], hay);
  const desk = grokDesktopAppAlive();
  const online = up || desk === true;

  // Path A: direct listAgents when ops gateway is configured and reachable.
  if (online) {
    const live = pollGrokBotFromGateway();
    if (live) {
      writeSnapshot(id, live.status, live.summary, 'grok-bot', live.meta);
      return;
    }
  }

  // Path B (interim): official listAgents drop. TTL 6.5m aligns with @every 5m push routine.
  const hbPath = join(homedir(), '.agent-stage', 'status', 'grok-bot.json');
  const drop = readJson(hbPath);
  const dropAge = (() => {
    const m = mtimeAgeMs(hbPath);
    const o = observedAgeMs(drop);
    if (m == null) return o;
    if (o == null) return m;
    return Math.min(m, o);
  })();
  const src = String(drop?.meta?.source || drop?.source || '');
  const isOfficialListAgents = /sand-listAgents/i.test(src);
  const dropTtlMs = isOfficialListAgents ? 390_000 : 90_000;
  const autoDrop =
    drop?.schemaVersion === 1 &&
    drop?.status &&
    dropAge != null &&
    dropAge < dropTtlMs &&
    src &&
    !/coder-heartbeat|manual|assistant/i.test(src) &&
    /grok|sand|desktop|app/i.test(src);

  if (online && autoDrop) {
    const st = String(drop.status);
    const zh = grokStatusZh(st, drop.summary);
    writeSnapshot(id, st, zh, 'grok-bot', {
      ...(drop.meta || {}),
      heartbeatAgeMs: dropAge,
      mirroredFrom: 'grok-bot.json',
      // Keep host-gateway when official exporter wrote it; else mark drop mirror.
      signal: drop?.meta?.signal === 'host-gateway' ? 'host-gateway' : 'app-status-drop',
      forceVersion: drop?.meta?.forceVersion || GROK_OFFICIAL_FORCE,
    });
    return;
  }

  writeSnapshot(
    id,
    online ? 'idle' : 'offline',
    online
      ? 'Grok Bot：空闲（应用在线；细忙碌待官方状态信号）'
      : 'Grok Bot：下线',
    'grok-bot',
    { signal: online ? 'app-main' : 'offline', desktopStatusAlive: desk },
  );
}

function codeBuddySessionBusy() {
  // Near-official: codebuddy-sessions.vscdb ItemTable status (Completed/Running/…)
  const db = join(
    homedir(),
    'Library/Application Support/CodeBuddy CN/codebuddy-sessions.vscdb',
  );
  if (!existsSync(db)) return null;
  const r = spawnSync(
    'sqlite3',
    [db, 'SELECT key, value FROM ItemTable;'],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 8_000_000 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  let best = null;
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('|')) continue;
    const i = line.indexOf('|');
    const raw = line.slice(i + 1);
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    const st = String(j.status || '').toLowerCase();
    const updated = Number(j.updatedAt || j.createdAt || 0);
    if (!st) continue;
    if (['completed', 'archived', 'failed', 'error', 'terminated', 'cancelled', 'canceled'].includes(st)) {
      continue;
    }
    const rec = {
      status: st,
      title: String(j.title || j.customTitle || '').slice(0, 60),
      updatedAt: updated,
      conversationId: j.conversationId,
    };
    if (!best || updated > best.updatedAt) best = rec;
  }
  return best;
}

function codeBuddyAutomationBusy() {
  const db = join(
    homedir(),
    'Library/Application Support/CodeBuddy CN/automations/automations.db',
  );
  if (!existsSync(db)) return null;
  const row = sqlite(
    db,
    "SELECT status || '|' || COALESCE(thread_title,'') || '|' || updated_at FROM automation_runs WHERE lower(status) NOT IN ('completed','done','failed','error','cancelled','canceled','archived') ORDER BY updated_at DESC LIMIT 1;",
  );
  if (!row) return null;
  const [st, title, updated] = row.split('|');
  return { status: String(st).toLowerCase(), title, updatedAt: Number(updated || 0) };
}

/** Parse ChatResyncBridge agentState= from newest coding-copilot log (observed: none|idle|…). */
function codeBuddyAgentStateFromLog() {
  const logsRoot = join(homedir(), 'Library/Application Support/CodeBuddy CN/logs');
  if (!existsSync(logsRoot)) return null;
  let newest = null;
  let newestMs = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
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
        else if (e.endsWith('.log') && p.includes('coding-copilot') && st.mtimeMs > newestMs) {
          newestMs = st.mtimeMs;
          newest = p;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(logsRoot, 0);
  if (!newest || Date.now() - newestMs > 10 * 60_000) return null;
  const tail = readLogTail(newest, 120_000);
  let last = null;
  let lastEvent = null;
  for (const line of tail.split('\n')) {
    const m = line.match(/agentState=([a-zA-Z0-9_]+)/);
    if (m) last = m[1].toLowerCase();
    const e = line.match(/stateEvent=([a-zA-Z0-9_]+)/);
    if (e) lastEvent = e[1].toLowerCase();
  }
  if (!last) return null;
  return { agentState: last, stateEvent: lastEvent, logAgeMs: Date.now() - newestMs };
}

function pollCodeBuddy(hay) {
  const id = 'codebuddy-1';
  const appUp = appMainRunning(APP_MAINS['codebuddy-1'], hay);
  if (!appUp) {
    writeSnapshot(id, 'offline', 'CodeBuddy：下线', 'codebuddy');
    return;
  }

  // Do NOT probe :8080 — on this Mac it is often Docker, not CodeBuddy serve.
  const auto = codeBuddyAutomationBusy();
  if (auto && ['running', 'working', 'active', 'busy', 'in_progress', 'pending_review', 'waiting', 'blocked'].includes(auto.status)) {
    const st = ['waiting', 'blocked', 'pending_review', 'needs_input'].includes(auto.status)
      ? 'needs_input'
      : 'running';
    writeSnapshot(
      id,
      st,
      st === 'needs_input'
        ? `CodeBuddy：等操作（自动化 ${auto.status}）`
        : `CodeBuddy：工作中（自动化）`,
      'codebuddy',
      { signal: 'automations.db', ...auto },
    );
    return;
  }

  const sess = codeBuddySessionBusy();
  if (sess) {
    const st = ['waiting', 'blocked', 'needs_input', 'pending'].includes(sess.status)
      ? 'needs_input'
      : 'running';
    writeSnapshot(
      id,
      st,
      st === 'needs_input'
        ? `CodeBuddy：等操作（${sess.status}）`
        : `CodeBuddy：工作中（${sess.status}${sess.title ? ' — ' + sess.title : ''}）`,
      'codebuddy',
      { signal: 'codebuddy-sessions.vscdb', ...sess },
    );
    return;
  }

  const logSt = codeBuddyAgentStateFromLog();
  if (logSt && !['none', 'idle', 'stop', 'stopped'].includes(logSt.agentState)) {
    writeSnapshot(id, 'running', `CodeBuddy：工作中（agentState=${logSt.agentState}）`, 'codebuddy', {
      signal: 'coding-copilot.log',
      ...logSt,
    });
    return;
  }

  writeSnapshot(id, 'idle', 'CodeBuddy：空闲（应用在线）', 'codebuddy', {
    signal: 'app-main',
    agentState: logSt?.agentState || null,
  });
}

/**
 * True only for a real Claude Code / Claude.app process — not Hermes/WB embeds.
 * Interactive = Claude.app, or a TTY-backed claude session, or live /tmp/cc-socks.
 * Ignore leftover daemon / bg-pty-host / bg-spare (they outlive closed sessions).
 */
function claudeCodeSocksAlive() {
  const dir = '/tmp/cc-socks';
  if (!existsSync(dir)) return false;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    const m = /^(\d+)\.sock$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH / EPERM — treat as not a usable live session
    }
  }
  return false;
}

function claudeCodePsLines() {
  const r = spawnSync('ps', ['-ax', '-o', 'tty=,command='], {
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
  return (r.stdout || '').split('\n');
}

function claudeCodeMainRunning(_hay) {
  const helper =
    /\bdaemon run\b|--bg-pty-host|--bg-spare|\bbg-pty-host\b|\bbg-spare\b/;
  const deny =
    /WorkBuddy\.app|CodeBuddy|hermes-agent|Hermes\.app|QClaw|openclaw|autoclaw|DoubaoWork|Marvis\.app/i;

  for (const raw of claudeCodePsLines()) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const ttyName = m[1];
    const line = m[2];
    if (!line || deny.test(line) || helper.test(line)) continue;

    if (line.includes('Claude.app/Contents/MacOS/Claude')) {
      const frag = 'Claude.app/Contents/MacOS/Claude';
      const idx = line.indexOf(frag);
      const after = line[idx + frag.length];
      if (
        after === undefined ||
        after === ' ' ||
        after === '\t' ||
        after === '\n' ||
        after === '"' ||
        after === "'"
      ) {
        return true;
      }
      continue;
    }

    // Interactive CLI must have a real tty (not ??)
    if (ttyName === '??' || ttyName === '-') continue;
    const isClaudeBin =
      line.includes('@anthropic-ai/claude-code/') ||
      /(^|\s|\/)claude(\.exe)?(\s|$)/.test(line);
    if (!isClaudeBin) continue;
    if (line.includes('--session-id') || /\bclaude(\.exe)?\s*$/.test(line.trim())) {
      return true;
    }
  }

  if (claudeCodeSocksAlive()) return true;
  return false;
}

function claudeAgentsJson() {
  // Official CLI: `claude agents --json` lists interactive + background sessions.
  const r = spawnSync('claude', ['agents', '--json'], {
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 2_000_000,
    env: process.env,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const t = r.stdout.trim();
  if (!t.startsWith('[')) return null;
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function claudeProjectTranscriptHot(windowMs = 20_000) {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  const age = newestMatchingAgeMs(root, (name) => name.endsWith('.jsonl'), 5);
  if (age != null && age < windowMs) return age;
  return null;
}

function pollClaudeCode(hay) {
  const id = 'claude-code-1';
  const up = claudeCodeMainRunning(hay);
  // Hook-written file takes precedence if fresh (never poller's own snapshot)
  const hookPath = join(homedir(), '.agent-stage', 'status', 'claude-code-1.json');
  const hook = readJson(hookPath);
  const age = mtimeAgeMs(hookPath);
  if (
    up &&
    hook?.status &&
    age != null &&
    age < 180_000 &&
    hook.meta?.source !== 'macos-live-status-poll'
  ) {
    writePublicOnly(id, hook.status, hook.summary || 'Claude Code：hooks', 'claude-code', {
      ...(hook.meta || {}),
      via: 'hook-file',
      ageMs: age,
    });
    return;
  }
  if (!up) {
    writeSnapshot(id, 'offline', 'Claude Code：下线', 'claude-code');
    return;
  }

  const agents = claudeAgentsJson();
  if (agents && agents.length > 0) {
    // Any listed session = live work (CLI documents active interactive + background).
    const names = agents
      .map((a) => a?.name || a?.id || a?.sessionId || '')
      .filter(Boolean)
      .slice(0, 3);
    writeSnapshot(
      id,
      'running',
      `Claude Code：工作中（${agents.length} 个会话${names.length ? '：' + names.join(',') : ''}）`,
      'claude-code',
      { signal: 'claude agents --json', count: agents.length },
    );
    return;
  }

  const hot = claudeProjectTranscriptHot(20_000);
  if (hot != null) {
    writeSnapshot(
      id,
      'running',
      `Claude Code：工作中（转录 ${Math.round(hot / 1000)}s 前有写入）`,
      'claude-code',
      { signal: 'projects.jsonl', ageMs: hot },
    );
    return;
  }

  writeSnapshot(
    id,
    'idle',
    'Claude Code：空闲（进程在；细等操作需 hooks）',
    'claude-code',
    { signal: 'app-main' },
  );
}

function codexNewestRollout() {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;
  let newest = null;
  let newestMs = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
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
        else if (e.startsWith('rollout-') && e.endsWith('.jsonl') && st.mtimeMs > newestMs) {
          newestMs = st.mtimeMs;
          newest = p;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return newest ? { path: newest, ageMs: Date.now() - newestMs } : null;
}

/** Official rollout events: task_started without later task_complete for that turn_id. */
function codexOpenTask(rolloutPath, maxFileAgeMs = 30 * 60_000) {
  if (!rolloutPath || !existsSync(rolloutPath)) return null;
  const age = mtimeAgeMs(rolloutPath);
  if (age == null || age > maxFileAgeMs) return null;
  let text = '';
  try {
    // Tail last ~400KB via Read of full file if small; else spawn tail.
    const st = statSync(rolloutPath);
    if (st.size <= 500_000) text = readFileSync(rolloutPath, 'utf8');
    else {
      const r = spawnSync('tail', ['-c', '400000', rolloutPath], {
        encoding: 'utf8',
        maxBuffer: 500_000,
        timeout: 2000,
      });
      text = r.stdout || '';
    }
  } catch {
    return null;
  }
  const open = new Map(); // turn_id -> ts
  let needsInput = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = j.payload || j;
    const ptype = payload.type || j.type;
    const turnId = payload.turn_id || payload.root_turn_id;
    const ts = j.timestamp ? Date.parse(j.timestamp) : NaN;
    if (ptype === 'task_started' && turnId) {
      open.set(turnId, Number.isNaN(ts) ? Date.now() : ts);
    } else if (ptype === 'task_complete' && turnId) {
      open.delete(turnId);
    } else if (
      /permission|approval|elicitation|needs_input|waiting_for_user/i.test(String(ptype)) ||
      payload?.approval_status === 'pending'
    ) {
      needsInput = { type: ptype, turnId, ageMs: Number.isNaN(ts) ? age : Date.now() - ts };
    }
  }
  if (needsInput && needsInput.ageMs != null && needsInput.ageMs < 10 * 60_000) {
    return { kind: 'needs_input', ...needsInput, fileAgeMs: age };
  }
  if (open.size === 0) return null;
  const turnId = [...open.keys()].pop();
  const start = open.get(turnId);
  return {
    kind: 'running',
    turnId,
    ageMs: start ? Date.now() - start : age,
    fileAgeMs: age,
  };
}

function pollCodex(hay) {
  const id = 'codex-1';
  const up = appMainRunning(APP_MAINS['codex-1'], hay);
  if (!up) {
    writeSnapshot(id, 'offline', 'Codex：下线', 'codex');
    return;
  }

  const rollout = codexNewestRollout();
  const open = rollout ? codexOpenTask(rollout.path) : null;
  if (open?.kind === 'needs_input') {
    writeSnapshot(id, 'needs_input', 'Codex：等操作（权限/审批）', 'codex', {
      signal: 'rollout.permission',
      ...open,
    });
    return;
  }
  if (open?.kind === 'running') {
    writeSnapshot(
      id,
      'running',
      `Codex：工作中（回合 ${String(open.turnId).slice(0, 8)}…，${Math.round(open.ageMs / 1000)}s）`,
      'codex',
      { signal: 'rollout.task_started', ...open },
    );
    return;
  }

  const sessions = join(homedir(), '.codex');
  const age = existsSync(sessions) ? newestSessionAgeMs(sessions) : null;
  if (age != null && age < 60_000) {
    writeSnapshot(id, 'running', `Codex：工作中（${Math.round(age / 1000)}s 前有活动）`, 'codex', {
      signal: 'session.mtime',
      ageMs: age,
    });
    return;
  }
  writeSnapshot(id, 'idle', 'Codex：空闲（进程在）', 'codex', {
    signal: 'app-main',
    rolloutAgeMs: rollout?.ageMs ?? null,
  });
}


function doubaoOpenCodingExecution() {
  // Near-official: coding/snapshot execution without endedAtMs = in-flight agent run.
  const root = join(
    homedir(),
    'Library/Application Support/DoubaoWork/coding/snapshot',
  );
  if (!existsSync(root)) return null;
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 8) return;
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
        if (st.isDirectory()) {
          walk(p, depth + 1);
          continue;
        }
        if (!e.endsWith('.json')) continue;
        const j = readJson(p);
        const ex = j?.execution;
        if (!ex || !ex.startedAtMs) continue;
        if (ex.endedAtMs) continue;
        const ageMs = Date.now() - Number(ex.startedAtMs);
        if (ageMs > 6 * 60 * 60_000) continue; // abandon stuck snapshots
        const rec = {
          ageMs,
          agentType: ex.agentType,
          conversationId: ex.conversationId,
          path: p,
        };
        if (!best || ageMs < best.ageMs) best = rec;
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return best;
}

function doubaoTrajectoryOpen(windowMs = 120_000) {
  // Near-official: trajectory.jsonl last assistant message still has tool_calls pending.
  const root = join(
    homedir(),
    'Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.sessions',
  );
  if (!existsSync(root)) return null;
  let newest = null;
  let newestMs = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
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
        else if (e === 'trajectory.jsonl' && st.mtimeMs > newestMs) {
          newestMs = st.mtimeMs;
          newest = p;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  if (!newest) return null;
  const ageMs = Date.now() - newestMs;
  if (ageMs > windowMs) return { hot: false, ageMs };
  let text = '';
  try {
    text = readFileSync(newest, 'utf8');
  } catch {
    return { hot: true, ageMs, path: newest };
  }
  const lines = text.trim().split('\n').filter(Boolean);
  if (!lines.length) return { hot: true, ageMs, path: newest };
  let last;
  try {
    last = JSON.parse(lines[lines.length - 1]);
  } catch {
    return { hot: true, ageMs, path: newest };
  }
  const dangling =
    last?.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
  return { hot: true, dangling, ageMs, path: newest, role: last?.role };
}

function doubaoAgentInfraActive() {
  const dir = join(
    homedir(),
    'Library/Application Support/DoubaoWork/sdk_storage/log/agent_infra',
  );
  if (!existsSync(dir)) return null;
  let newest = null;
  let newestMs = 0;
  for (const e of readdirSync(dir)) {
    if (!e.startsWith('agent_infra_') || !e.endsWith('.log')) continue;
    const p = join(dir, e);
    try {
      const st = statSync(p);
      if (st.mtimeMs > newestMs) {
        newestMs = st.mtimeMs;
        newest = p;
      }
    } catch {
      /* skip */
    }
  }
  if (!newest || Date.now() - newestMs > 90_000) return null;
  const tail = readLogTail(newest, 40_000);
  // active_task_count>0 or invoke without matching shutdown recently
  const m = [...tail.matchAll(/active_task_count=(\d+)/g)].pop();
  if (m && Number(m[1]) > 0) {
    return { activeTaskCount: Number(m[1]), ageMs: Date.now() - newestMs };
  }
  if (/agent_infra invoke, method=/i.test(tail) && !/agent_infra shutdown requested/i.test(tail.slice(-2000))) {
    // recent invoke without shutdown in last 2k — weak
    if (Date.now() - newestMs < 45_000) {
      return { activeTaskCount: null, ageMs: Date.now() - newestMs, weak: true };
    }
  }
  return null;
}

function pollDoubao(hay) {
  const id = 'doubao-1';
  // 豆包工作 = DoubaoWork main only (not Doubao chatbot / ByteDance noise)
  const up = appMainRunning(APP_MAINS['doubao-1'], hay);
  if (!up) {
    writeSnapshot(id, 'offline', '豆包：下线', 'doubao');
    return;
  }

  const openEx = doubaoOpenCodingExecution();
  if (openEx) {
    writeSnapshot(
      id,
      'running',
      `豆包：工作中（coding 执行中 ${Math.round(openEx.ageMs / 1000)}s）`,
      'doubao',
      { signal: 'coding.snapshot.open', ...openEx },
    );
    return;
  }

  const traj = doubaoTrajectoryOpen(120_000);
  if (traj?.dangling || (traj?.hot && traj.ageMs < 30_000)) {
    writeSnapshot(
      id,
      'running',
      traj.dangling
        ? `豆包：工作中（轨迹待工具结果，${Math.round(traj.ageMs / 1000)}s）`
        : `豆包：工作中（轨迹 ${Math.round(traj.ageMs / 1000)}s 前有写入）`,
      'doubao',
      { signal: traj.dangling ? 'trajectory.tool_calls' : 'trajectory.mtime', ...traj },
    );
    return;
  }

  const infra = doubaoAgentInfraActive();
  if (infra && !infra.weak) {
    writeSnapshot(id, 'running', '豆包：工作中（agent_infra 活跃）', 'doubao', {
      signal: 'agent_infra',
      ...infra,
    });
    return;
  }

  writeSnapshot(id, 'idle', '豆包：空闲（应用在线）', 'doubao', {
    signal: 'app-main',
    trajectoryAgeMs: traj?.ageMs ?? null,
  });
}

function tick() {
  const hay = psOut();
  pollWorkBuddy();
  pollCodeBuddy(hay);
  pollHermes();
  pollDsh();
  pollGrokBot();
  pollMarvis();
  pollAutoClaw();
  pollDoubao(hay);
  pollClaudeCode(hay);
  pollCodex(hay);
}

tick();
if (!once) setInterval(tick, intervalMs);
