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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseLogAgeMs } from '../lib/logTime.mjs';
import { analyzeCodexRollout } from '../lib/codexRollout.mjs';

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
    // 心跳与 observedAt 分离：状态没变时 observedAt 保持稳定，checkedAt 仍每次前进。
    checkedAt: new Date().toISOString(),
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
  const nowIso = new Date().toISOString();
  const body = {
    schemaVersion: 1,
    agentId,
    status,
    summary,
    observedAt: nowIso,
    checkedAt: nowIso,
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
  // Always read-only: the poller must never take a write lock on another app's DB.
  const r = spawnSync('sqlite3', ['-readonly', db, sql], { encoding: 'utf8', timeout: 5000 });
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


/**
 * WorkBuddy leaves a helper Electron (`sidecar-entry.js`, often ppid 1) after the
 * GUI quits. Matching WorkBuddy.app/.../Electron alone then falsely reports idle.
 * Presence = Electron main without sidecar-entry in argv.
 * forceVersion workbuddy-ignore-sidecar-v1
 */
function workBuddyAppUp(hay = null) {
  // forceVersion workbuddy-ignore-serve-v1
  // Main UI = WorkBuddy Electron with NO script arg. The CLI (`cli/bin/codebuddy
  // --serve|--prewarm`), sidecar-entry.js, daemon-app-server-entry.js and
  // --type= helpers all run through the same binary and may outlive the GUI.
  const h = hay ?? psOut();
  const frag = 'WorkBuddy.app/Contents/MacOS/Electron';
  for (const line of h.split(/\r?\n/)) {
    const idx = line.indexOf(frag);
    if (idx === -1) continue;
    const rest = line.slice(idx + frag.length).trim();
    if (/sidecar-entry|cli\/bin\/codebuddy|--serve|--prewarm|--type=|\.js\b|\.asar/i.test(rest)) continue;
    // any remaining non-flag token (script path) => not the main UI
    if (rest.split(/\s+/).some((t) => t && !t.startsWith('-'))) continue;
    return true;
  }
  return false;
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
  const appUp = workBuddyAppUp(); // main UI only; serve/sidecar heartbeats never count (workbuddy-ignore-serve-v1)
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

  // deleted_at 的语义：NULL 表示未删除；正数才是删除墓碑。
  // 旧写法 `deleted_at=''` 在 INTEGER 列上永远不成立，等于只筛 NULL。
  const rowsRaw = sqlite(
    db,
    "SELECT status || '|' || COALESCE(title,'') || '|' || COALESCE(last_activity_at,0) || '|' || COALESCE(unread,0) " +
      'FROM sessions WHERE deleted_at IS NULL ORDER BY last_activity_at DESC LIMIT 5;',
  );
  if (!rowsRaw) {
    writeSnapshot(id, appUp ? 'idle' : 'offline', 'WorkBuddy：无会话', vendor);
    return;
  }
  const candidates = rowsRaw.split('\n').filter(Boolean).map((line) => {
    const [s, t, la, u] = line.split('|');
    return { status: s, title: t, lastAct: Number(la || 0), unread: Number(u || 0) };
  });

  // 优先取正在运行的会话；其次要人的；再才是最新的一行（可能是 archived）
  const activeRow = candidates.find((c) =>
    ['running', 'working', 'active', 'in_progress', 'busy'].includes(String(c.status).toLowerCase()),
  );
  const waitingRow = candidates.find((c) =>
    ['waiting', 'blocked', 'needs_input', 'pending'].includes(String(c.status).toLowerCase()),
  );
  const errorRow = candidates.find((c) =>
    ['failed', 'error', 'terminated'].includes(String(c.status).toLowerCase()),
  );

  // 最重要的信号：完成任务但你没看（completed + unread）。
  // 这是 WorkBuddy 明确给出的字段，不靠时间窗猜 —— 看板才会"亮着直到你处理"。
  // 旧实现只看"2 分钟内 completed"，结果 2 分钟一到就自己退回空闲，像无端闪一下。
  const unreadDone = candidates.find(
    (c) => String(c.status).toLowerCase() === 'completed' && c.unread > 0,
  );
  if (unreadDone) {
    writeSnapshot(id, 'done', `WorkBuddy：完成待审 — ${(unreadDone.title || '').slice(0, 50)}`, vendor, {
      signal: 'sessions.completed+unread',
      sessionStatus: unreadDone.status,
      unread: unreadDone.unread,
      lastActivityAt: unreadDone.lastAct,
    });
    return;
  }

  const picked = activeRow || waitingRow || errorRow || candidates[0];
  const st = picked.status;
  const title = picked.title;
  const lastAct = picked.lastAct;
  const ageMs = Date.now() - Number(lastAct || 0);
  const low = String(st).toLowerCase();
  let status = 'idle';
  let summary = `WorkBuddy：${st} — ${(title || '').slice(0, 60)}`;
  if (['running', 'working', 'active', 'in_progress', 'busy'].includes(low)) {
    status = 'running'; summary = `WorkBuddy：工作中 — ${(title || '').slice(0, 50)}`;
  } else if (['waiting', 'blocked', 'needs_input', 'pending'].includes(low)) {
    status = 'needs_input'; summary = `WorkBuddy：等操作 — ${(title || '').slice(0, 50)}`;
  } else if (['failed', 'error', 'terminated'].includes(low)) {
    status = 'error'; summary = `WorkBuddy：出错 — ${(title || '').slice(0, 50)}`;
  } else if (['completed'].includes(low)) {
    // 没有 unread 的 completed：只是"上次做完了"，不算待办。
    status = 'idle';
    summary = `WorkBuddy：空闲（上次：${(title || '').slice(0, 50)})`;
  } else if (['archived'].includes(low)) {
    status = 'idle';
    summary = `WorkBuddy：空闲（上次归档：${(title || '').slice(0, 50)})`;
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

/**
 * 本机时区偏移，形如 "+08:00"。用于把日志里的墙上时间解析成正确时刻。
 * 不能写死 +08:00：换台机器就错，而且错的是整整一个时区差。
 */
function localOffsetSuffix() {
  const offMin = -new Date().getTimezoneOffset(); // 东为正
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * 唯一的解析实现放在 scripts/lib/logTime.mjs（与 src/adapters/logTime.ts 同源）。
 * 这里保留一个薄封装，避免调用点改名。
 */
function parseIsoAgeMs(isoOrLocal) {
  return parseLogAgeMs(isoOrLocal);
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
  const appUp = appMainRunning([
    'AutoClaw2.app/Contents/MacOS/AutoClaw',
    'AutoClaw.app/Contents/MacOS/AutoClaw',
  ]);
  if (!appUp) {
    writeSnapshot(id, 'offline', 'AutoClaw：下线', 'autoclaw');
    return;
  }

  // AutoClaw 2.0：所有状态都在 runtime.sqlite 里
  const accountsRoot = join(
    homedir(),
    'Library/Application Support/AutoClaw-official/accounts',
  );
  let dbPath = null;
  try {
    const accounts = readdirSync(accountsRoot).filter(
      (d) => !d.startsWith('.'),
    );
    for (const acct of accounts) {
      const p = join(accountsRoot, acct, 'runtime', 'runtime.sqlite');
      if (existsSync(p)) { dbPath = p; break; }
    }
  } catch { /* ignore */ }

  if (!dbPath) {
    writeSnapshot(id, 'idle', 'AutoClaw：应用在线（无数据库）', 'autoclaw');
    return;
  }

  // 有 run 在跑 → 工作中
  const running = sqlite(
    dbPath,
    "SELECT count(*) FROM work_runs WHERE status='running';",
  );
  if (running && Number(running) > 0) {
    writeSnapshot(id, 'running', `AutoClaw：工作中（${running} 个任务在跑）`, 'autoclaw', {
      signal: 'work_runs.running',
      count: Number(running),
    });
    return;
  }

  // 等你审批 → needs_input
  const waiting = sqlite(
    dbPath,
    "SELECT count(*) FROM work_runs WHERE status='waiting_approval';",
  );
  if (waiting && Number(waiting) > 0) {
    writeSnapshot(id, 'needs_input', `AutoClaw：等审批（${waiting} 个待办）`, 'autoclaw', {
      signal: 'work_runs.waiting_approval',
      count: Number(waiting),
    });
    return;
  }

  // 最近一次会话完成 → done（短窗口）
  const latestRun = sqlite(
    dbPath,
    "SELECT status || '|' || COALESCE(text,'') || '|' || updated_at FROM work_runs ORDER BY updated_at DESC LIMIT 1;",
  );
  if (latestRun) {
    const [st, title, updated] = latestRun.split('|');
    const age = Date.now() - Date.parse(updated);
    if (st === 'completed' && age < 120_000) {
      writeSnapshot(id, 'done', `AutoClaw：完成待审 — ${(title || '').slice(0, 50)}`, 'autoclaw', {
        signal: 'work_runs.completed',
        status: st,
      });
      return;
    }
    if (['failed', 'interrupted'].includes(st) && age < 120_000) {
      writeSnapshot(id, 'error', `AutoClaw：出错 — ${(title || '').slice(0, 50)}`, 'autoclaw', {
        signal: 'work_runs.failed',
        status: st,
      });
      return;
    }
  }

  // 最近有没有活动（sessions / traces mtime）
  const sessionsRoot = join(
    homedir(),
    'Library/Application Support/AutoClaw-official/accounts',
  );
  const sessAge = newestMatchingAgeMs(
    sessionsRoot,
    (name, p) => p.includes('/runtime/traces/') && name.endsWith('.jsonl'),
    5,
  );
  const recentWork = sessAge != null && sessAge < 60_000;
  writeSnapshot(
    id,
    'idle',
    recentWork ? 'AutoClaw：空闲（刚有活动）' : 'AutoClaw：空闲',
    'autoclaw',
    { signal: 'idle', sessionAgeMs: sessAge },
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
      confidence: 'weak',
      reason: '仅凭会话文件 mtime —— 弱证据',
      forceVersion: DSH_STREAM_OPENTURN_FORCE,
      ageMs: age,
      lockAgeMs: lockAge,
    });
    return;
  }
  // 有写入、没 open turn：不算"在等你"。
  // DSH 没有实时"等人输入"的信号可用，45 分钟内动过 ≠ 在等人 —— 用户离开你 11 分钟、
  // 就已经不属于"占用注意力"了。旧实现把它一直顶在 needs_input，是假阳性主力。
  // 现在：45 分钟内完成过 -> done（弱证据），之后 -> idle。
  const closedAge =
    scanned?.lastClosedTurnMs != null && Number.isFinite(scanned.lastClosedTurnMs)
      ? Date.now() - scanned.lastClosedTurnMs
      : null;
  const recentlyClosed = (closedAge != null && closedAge < 120_000);
  if (recentlyClosed) {
    writeSnapshot(id, 'done', 'DSH：完成待审（回合刚关闭）', 'dsh', {
      signal: 'turn/closed-recent',
      confidence: 'weak',
      reason: '最近 2 分钟有回合关闭 —— 待你查看结果',
      forceVersion: DSH_STREAM_OPENTURN_FORCE,
      closedAgeMs: closedAge,
    });
    return;
  }
  // 超过 2 分钟没动 → 空闲。不写 needs_input。
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
        confidence: 'weak',
        reason: '来自 main.log 的时间戳推断 —— 弱证据',
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
      { signal: 'workspace.hot', ageMs: hot, confidence: 'weak', reason: '仅凭工作区文件 mtime —— 弱证据' },
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

const GROK_CODER_ID = process.env.GROK_CODER_AGENT_ID || '';
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
        // Do not put the token in argv (visible via ps). curl reads the header
        // from stdin, which also keeps it out of shell history / process listings.
        '-H',
        '@-',
        '-d',
        JSON.stringify(bodyObj ?? {}),
        url,
      ],
      {
        encoding: 'utf8',
        timeout: timeoutMs + 800,
        input: `Authorization: Bearer ${token}\n`,
      },
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
    (GROK_CODER_ID ? list.find((a) => a?.id === GROK_CODER_ID) : null) ||
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

/**
 * forceVersion grok-desktop-local-v1
 * Grok Bot seat read LOCALLY from Grok Bot.app persistence (no cloud drop).
 * online = desktop-status.json pid alive (or main binary) AND dune-reliability heartbeat < 3m.
 * Roster blob (*.roster.last-roster): needs_input if awaitingUserResponse != null;
 * running if lastActivityAt < 90s; else idle. Never reads secrets files; never logs previews.
 */
const GROK_LOCAL_FORCE = 'grok-desktop-local-v2';
const GROK_APP_DIR = join(homedir(), 'Library/Application Support/Grok Bot');
const GROK_RUNNING_WINDOW_MS = 90_000;
const GROK_HEARTBEAT_MAX_MS = 180_000;
let grokLastGood = null;

function b32DecodeName(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of s.toUpperCase()) {
    const i = alpha.indexOf(ch); if (i < 0) return null;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out).toString('utf8');
}

function grokHeartbeatAgeMs() {
  const dir = join(GROK_APP_DIR, 'dune-reliability', 'sessions');
  let best = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.running.json')) continue;
      const j = readJson(join(dir, f));
      const hb = Number(j?.heartbeatAtMs);
      if (!hb) continue;
      if (j?.pid) { try { process.kill(Number(j.pid), 0); } catch { continue; } }
      const age = Date.now() - hb;
      if (best == null || age < best) best = age;
    }
  } catch { return null; }
  return best;
}

function grokReadRoster() {
  const dir = join(GROK_APP_DIR, 'sand-client-persistence');
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.blob')) continue;
      const key = b32DecodeName(f.slice(0, -5));
      if (!key || !key.endsWith('.roster.last-roster')) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const rows = j?.value?.rows;
      return Array.isArray(rows) ? rows : null;
    }
  } catch { return null; }
  return null;
}

function grokReplyWaiting(r) {
  if (!r?.hasUnread) return false;
  const mid = String(r.lastMessageId || r.newestEntryId || '');
  // turn ids: t<N>u = user message, t<N>s<M> = agent output
  return /s\d+$/.test(mid) || (!!mid && !/u$/.test(mid));
}

function grokCloudDrop() {
  const p = join(homedir(), '.agent-stage', 'status', 'grok-bot.json');
  const d = readJson(p);
  if (!d || d.schemaVersion !== 1) return null;
  if (!/sand-listAgents/i.test(String(d?.meta?.source || ''))) return null;
  const t = Date.parse(d.observedAt || '');
  if (!t) return null;
  const age = Date.now() - t;
  if (age < -60_000 || age > 390_000) return { stale: true, ageMs: age };
  return { stale: false, ageMs: age, status: String(d.status), running: d.meta?.runningAgents || [], awaiting: d.meta?.awaitingAgents || [] };
}

function pollGrokBot() {
  const id = 'grok-bot-1';
  // Prefer the official listAgents gateway when ops configured it. This path
  // was previously dead code, so a valid gateway was silently ignored.
  const official = pollGrokBotFromGateway();
  if (official) {
    writeSnapshot(id, official.status, official.summary, 'grok-bot', official.meta);
    return;
  }
  const hay = psOut();
  const up = appMainRunning(APP_MAINS['grok-bot-1'], hay);
  const desk = grokDesktopAppAlive();
  const hbAge = grokHeartbeatAgeMs();
  const online = (desk === true || up) && hbAge != null && hbAge < GROK_HEARTBEAT_MAX_MS;
  const base = { source: 'grok-desktop-local', forceVersion: GROK_LOCAL_FORCE, heartbeatAgeMs: hbAge };
  if (!online) {
    writeSnapshot(id, 'offline', 'Grok Bot：下线', 'grok-bot', { ...base, signal: 'offline', desktopStatusAlive: desk, appMain: up });
    return;
  }
  let rows = grokReadRoster();
  let rosterSignal = 'roster.last-roster';
  if (rows) grokLastGood = { rows, at: Date.now() };
  else if (grokLastGood && Date.now() - grokLastGood.at < 10 * 60_000) {
    rows = grokLastGood.rows;
    rosterSignal = 'roster.last-good';
  } else {
    grokLastGood = null;
    rows = [];
    rosterSignal = 'roster-unavailable';
  }
  const nm = (r) => r?.name || r?.id;
  const awaitingLocal = rows.filter((r) => r?.awaitingUserResponse != null);
  const doneRows = rows.filter((r) => !r?.isGroup && grokReplyWaiting(r));
  const cloud = grokCloudDrop();
  const cloudFresh = cloud && !cloud.stale;

  let status = 'idle', names = [];
  let confidence = 'certain';
  let reason = '';
  if (awaitingLocal.length || (cloudFresh && cloud.status === 'needs_input')) {
    status = 'needs_input';
    names = [...new Set([...awaitingLocal.map(nm), ...(cloudFresh ? cloud.awaiting : [])])];
    reason = awaitingLocal.length ? '本地 roster awaitingUserResponse 非空' : '云端 drop needs_input';
  } else if (cloudFresh && cloud.status === 'running') {
    status = 'running'; names = cloud.running;
    reason = '云端 drop running（listAgents）';
  } else if (doneRows.length) {
    status = 'done'; names = doneRows.map(nm);
    // "有未读的助手消息"≠"完成待审"：它只是常态的未读，不能当强证据。
    // 之前它一直把 Grok 顶在 attention 上（配合旧状态机还会每 2 秒闪一次）。
    confidence = 'weak';
    reason = '本地 roster 有未读助手回复 —— 只是未读，不等于完成待审';
  }
  const usedCloud = cloudFresh && (status === 'running' || (status === 'needs_input' && !awaitingLocal.length));
  const summary = grokStatusZh(status) + (names.length ? `（${names.join('、')}）` : '');
  writeSnapshot(id, status, summary, 'grok-bot', {
    ...base,
    source: usedCloud ? 'grok-desktop-local+sand-listAgents' : 'grok-desktop-local',
    signal: rosterSignal,
    confidence,
    reason: reason || undefined,
    agents: names,
    cloudDrop: cloud ? { stale: cloud.stale, ageMs: cloud.ageMs, status: cloud.status ?? null } : null,
    awaitingLocal: awaitingLocal.map((r) => ({ name: nm(r), awaitingUserResponse: r.awaitingUserResponse })),
    replyWaiting: doneRows.map(nm),
  });
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
      confidence: 'weak',
      reason: '日志尾部 agentState 推断 —— 弱证据',
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
      { signal: 'projects.jsonl', ageMs: hot, confidence: 'weak', reason: '仅凭转录文件 mtime —— 弱证据' },
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

function codexRecentRollouts(maxAgeMs = 12 * 60 * 60_000, limit = 12) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const found = [];
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
        else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) {
          const ageMs = Date.now() - st.mtimeMs;
          if (ageMs <= maxAgeMs) found.push({ path: p, ageMs, mtimeMs: st.mtimeMs });
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit);
}

function readRolloutTail(rolloutPath, maxBytes = 2_000_000) {
  try {
    const st = statSync(rolloutPath);
    if (st.size <= maxBytes) return readFileSync(rolloutPath, 'utf8');
    const r = spawnSync('tail', ['-c', String(maxBytes), rolloutPath], {
      encoding: 'utf8',
      maxBuffer: maxBytes + 10_000,
      timeout: 2000,
    });
    return r.stdout || '';
  } catch {
    return null;
  }
}

function readRolloutFrom(rolloutPath, offset, maxBytes = 2_000_000) {
  try {
    const st = statSync(rolloutPath);
    const floor = Number.isFinite(offset) && offset >= 0 && offset < st.size
      ? Math.max(0, Math.floor(offset) - 1024)
      : 0;
    // A single turn can exceed maxBytes. We need the *end* of the turn (where
    // approvals are pending), not its beginning.
    const start = Math.max(floor, st.size - maxBytes);
    const length = Math.min(maxBytes, st.size - start);
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    const fd = openSync(rolloutPath, 'r');
    try {
      const read = readSync(fd, buf, 0, length, start);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Parsing a multi-MB rollout every 2s would burn CPU for nothing. Cache by
 * (size, mtime, offset); while a turn waits for approval the file is quiet, so
 * we reuse the previous parse until Codex appends something.
 */
const codexRolloutCache = new Map();

function codexAnalyzeRollout(rolloutPath, offset, now) {
  let st;
  try {
    st = statSync(rolloutPath);
  } catch {
    return null;
  }
  const sig = `${st.size}|${Math.floor(st.mtimeMs)}|${offset ?? ''}`;
  let entry = codexRolloutCache.get(rolloutPath);
  if (!entry || entry.sig !== sig) {
    const text =
      offset != null
        ? readRolloutFrom(rolloutPath, offset, 50_000_000)
        : readRolloutTail(rolloutPath, 50_000_000);
    if (!text) return null;
    entry = { sig, parsed: analyzeCodexRollout(text, { now }) };
    codexRolloutCache.set(rolloutPath, entry);
    if (codexRolloutCache.size > 32) {
      const oldest = codexRolloutCache.keys().next().value;
      if (oldest) codexRolloutCache.delete(oldest);
    }
  }
  // Recompute ages from the cached timestamps; otherwise a cached "waiting
  // 3s" would stay 3s forever after the file goes quiet.
  return {
    pending: entry.parsed.pending.map((call) => ({
      ...call,
      ageMs: Math.max(0, now - call.ts),
    })),
    openTurns: entry.parsed.openTurns.map((turn) => ({
      ...turn,
      ageMs: Math.max(0, now - turn.startedAt),
    })),
  };
}

function newestCodexDb(prefix) {
  const root = join(homedir(), '.codex');
  if (!existsSync(root)) return null;
  let newest = null;
  let newestMs = 0;
  try {
    for (const e of readdirSync(root)) {
      if (!e.startsWith(prefix) || !e.endsWith('.sqlite')) continue;
      const p = join(root, e);
      try {
        const mtime = statSync(p).mtimeMs;
        if (mtime > newestMs) {
          newestMs = mtime;
          newest = p;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return null;
  }
  return newest;
}

function safeSqlCallId(callId) {
  return String(callId || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function rolloutThreadId(rolloutPath) {
  const m = String(rolloutPath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return m ? m[1] : null;
}

/**
 * Authoritative "this Codex turn is still running" from Codex's own history DB,
 * plus the byte offset where the turn starts. Falls back to null when the DB is
 * unavailable so callers can use rollout inspection.
 */
function codexInProgressTurns() {
  const db = newestCodexDb('thread_history_');
  if (!db) return null;
  const out = sqlite(
    db,
    "SELECT thread_id || '|' || turn_id || '|' || COALESCE(rollout_byte_offset,'') || '|' || COALESCE(started_at,'') FROM thread_turns WHERE status='inProgress' ORDER BY started_at DESC;",
  );
  if (out === null) return null;
  const rows = out
    .split('\n')
    .map((line) => line.split('|'))
    .filter((parts) => parts.length >= 4 && parts[0] && parts[1])
    .map(([threadId, turnId, offset, startedAt]) => ({
      threadId,
      turnId,
      rolloutByteOffset: offset === '' ? null : Number(offset),
      startedAt: startedAt === '' ? null : Number(startedAt) * 1000,
    }));
  // Resolve the rollout path from Codex's own thread index. The filename scan
  // below is time/limit based, so a prompt left waiting for >12h (or a busy
  // machine with many newer sessions) would otherwise be invisible even
  // though Codex still has the turn inProgress.
  const paths = codexThreadRolloutPaths(rows.map((row) => row.threadId));
  return rows.map((row) => ({ ...row, rolloutPath: paths.get(row.threadId) || null }));
}

/** `threads.rollout_path` is the authoritative session → file mapping. */
function codexThreadRolloutPaths(threadIds) {
  const out = new Map();
  const ids = [...new Set(threadIds)]
    .map((id) => String(id || ''))
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return out;
  const db = newestCodexDb('state_');
  if (!db) return out;
  const list = ids.map((id) => `'${id}'`).join(',');
  const rows = sqlite(
    db,
    `SELECT id || '|' || rollout_path FROM threads WHERE id IN (${list});`,
  );
  if (!rows) return out;
  const sessionsRoot = join(homedir(), '.codex', 'sessions') + '/';
  for (const line of rows.split('\n')) {
    const [id, path] = line.split('|');
    // Never follow an arbitrary path from a possibly-corrupted DB.
    if (id && path && path.startsWith(sessionsRoot) && path.endsWith('.jsonl')) {
      out.set(id, path);
    }
  }
  return out;
}

function codexTurnRollout(rollouts, threadId, knownPath = null) {
  const byId = rollouts.find((r) => rolloutThreadId(r.path) === threadId);
  if (byId) return byId;
  if (!knownPath) return null;
  try {
    const st = statSync(knownPath);
    return { path: knownPath, ageMs: Date.now() - st.mtimeMs, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Codex logged the user's approve/reject decision for this call. */
function codexApprovalDecided(callId, sinceMs) {
  const id = safeSqlCallId(callId);
  if (!id) return false;
  const db = newestCodexDb('logs_');
  if (!db) return false;
  // Logs may rotate; only look back far enough to cover this specific wait.
  const since = Math.max(0, Math.floor((sinceMs - 5_000) / 1000));
  const out = sqlite(
    db,
    `SELECT count(*) FROM logs WHERE ts >= ${since} AND feedback_log_body LIKE '%operation="exec_approval"%' AND feedback_log_body LIKE '%id: "${id}"%';`,
  );
  return out !== null && Number(out) > 0;
}

/** Codex actually started/finished this call (auto-approved rule or approval done). */
function codexCallStarted(callId) {
  const id = safeSqlCallId(callId);
  if (!id) return false;
  const db = newestCodexDb('thread_history_');
  if (!db) return false;
  const out = sqlite(
    db,
    `SELECT count(*) FROM thread_items WHERE item_id = '${id}' AND (started_at_ms IS NOT NULL OR completed_at_ms IS NOT NULL);`,
  );
  return out !== null && Number(out) > 0;
}

/**
 * Any unresolved escalated tool call across recent Codex threads.
 * `task_complete` and a matching output clear it; a logged approval decision
 * or a recorded command start clears it too, so long approved commands are
 * not reported as "waiting for you".
 */
function codexPendingHumanInput(rollouts) {
  const now = Date.now();
  const inProgress = codexInProgressTurns();
  const candidates = [];
  const seen = new Set();
  const addCandidate = (rollout, turn = null) => {
    if (!rollout?.path || seen.has(rollout.path)) return;
    seen.add(rollout.path);
    candidates.push({ rollout, turn });
  };
  if (inProgress && inProgress.length > 0) {
    for (const turn of inProgress) {
      const rollout = codexTurnRollout(rollouts, turn.threadId, turn.rolloutPath);
      if (!rollout) continue;
      addCandidate(rollout, turn);
    }
  }
  // Always also inspect recent rollouts: the history DB can lag a new turn by
  // a few seconds, and the whole point is that a prompt must not be missed in
  // that window. Files already covered by an inProgress turn are skipped.
  const recent = rollouts.slice(0, inProgress === null ? 12 : 8);
  for (const rollout of recent) addCandidate(rollout, null);

  const waiting = [];
  for (const { rollout, turn } of candidates) {
    const parsed = codexAnalyzeRollout(rollout.path, turn?.rolloutByteOffset ?? null, now);
    if (!parsed) continue;
    for (const call of parsed.pending) {
      // A call from an older turn is not this turn's approval prompt.
      if (call.turnId && turn?.turnId && call.turnId !== turn.turnId) continue;
      if (call.kind === 'approval') {
        // Only command approvals are cleared by "Codex started it". A question
        // stays unanswered until its own output/turn completion arrives.
        if (codexApprovalDecided(call.callId, call.ts)) continue;
        if (codexCallStarted(call.callId)) continue;
      }
      waiting.push({ ...call, rolloutPath: rollout.path, fileAgeMs: rollout.ageMs });
    }
  }
  // Oldest first: if two Codex windows are waiting, report the one that has
  // been ignored longest instead of whichever file happened to be scanned first.
  waiting.sort((a, b) => a.ts - b.ts);
  return waiting[0] || null;
}

function codexNewestOpenTurn(rollouts) {
  const now = Date.now();
  const inProgress = codexInProgressTurns();
  if (inProgress && inProgress.length > 0) {
    // A stale inProgress row can survive a hard kill. Skip dead rows and pick
    // the newest turn whose *own* rollout is still being written; an unrelated
    // fresh session must not keep a dead turn looking alive either.
    for (const turn of inProgress) {
      const rollout = codexTurnRollout(rollouts, turn.threadId, turn.rolloutPath);
      if (!rollout || rollout.ageMs >= 30 * 60_000) continue;
      return {
        turnId: turn.turnId,
        startedAt: turn.startedAt ?? now,
        ageMs: turn.startedAt ? Math.max(0, now - turn.startedAt) : 0,
        fileAgeMs: rollout.ageMs,
        rolloutPath: rollout.path,
      };
    }
  }
  let best = null;
  for (const rollout of rollouts) {
    // A turn without task_complete can be a killed session. Do not let an old
    // rollout pin "running" forever; a live turn keeps writing its file.
    if (rollout.ageMs >= 30 * 60_000) continue;
    const parsed = codexAnalyzeRollout(rollout.path, null, now);
    if (!parsed) continue;
    const { openTurns } = parsed;
    const turn = openTurns[0];
    if (turn && (!best || turn.startedAt > best.startedAt)) {
      best = {
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        ageMs: Math.max(0, now - turn.startedAt),
        fileAgeMs: rollout.ageMs,
        rolloutPath: rollout.path,
      };
    }
  }
  return best;
}

function pollCodex(hay) {
  const id = 'codex-1';
  const up = appMainRunning(APP_MAINS['codex-1'], hay);
  if (!up) {
    writeSnapshot(id, 'offline', 'Codex：下线', 'codex');
    return;
  }

  const rollouts = codexRecentRollouts();
  const rollout = rollouts[0] || null;
  const waiting = codexPendingHumanInput(rollouts);
  if (waiting) {
    const what = waiting.kind === 'question' ? '回答' : '审批';
    writeSnapshot(id, 'needs_input', `Codex：等你${what}（已等 ${Math.round(waiting.ageMs / 1000)}s）`, 'codex', {
      signal: `rollout.pending_${waiting.kind}`,
      callId: waiting.callId,
      tool: waiting.name,
      turnId: waiting.turnId,
      ageMs: waiting.ageMs,
      fileAgeMs: waiting.fileAgeMs,
    });
    return;
  }
  const open = codexNewestOpenTurn(rollouts);
  if (open) {
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
      confidence: 'weak',
      reason: '仅凭会话目录 mtime —— 弱证据',
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
      confidence: 'weak',
      reason: 'agent_infra 日志 active_task_count —— 弱证据',
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
  const polls = [
    ['workbuddy-1', () => pollWorkBuddy()],
    ['codebuddy-1', () => pollCodeBuddy(hay)],
    ['hermes-1', () => pollHermes()],
    ['dsh-1', () => pollDsh()],
    ['grok-bot-1', () => pollGrokBot()],
    ['marvs-1', () => pollMarvis()],
    ['autoclaw-1', () => pollAutoClaw()],
    ['doubao-1', () => pollDoubao(hay)],
    ['claude-code-1', () => pollClaudeCode(hay)],
    ['codex-1', () => pollCodex(hay)],
  ];
  for (const [id, poll] of polls) {
    try {
      poll();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ${id} poll failed: ${e?.stack || e}`);
    }
  }
}

tick();
if (!once) setInterval(tick, intervalMs);
