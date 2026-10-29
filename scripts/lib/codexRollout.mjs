/**
 * Codex rollout → "does this session need a human?".
 *
 * Codex does not emit a stable `approval_request` event in rollout JSONL. What
 * it does emit is the tool call itself: a `function_call` (usually
 * `exec_command` with `sandbox_permissions=require_escalated`) that has no
 * matching `function_call_output` yet. A `request_user_input` call has the
 * same shape.
 *
 * The parser deliberately has no guesses about approval event type names. It
 * only reports calls that are still unresolved, and lets the caller remove
 * calls that Codex has already approved/rejected or started (see poller's
 * logs/thread-history evidence).
 */

const APPROVAL_PERMISSIONS = new Set(['require_escalated', 'require_escalation']);

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tool names arrive in several shapes: `request_user_input`,
 * `functions.request_user_input`, and MCP names such as
 * `mcp__server__request_user_input`. Match the tool segment, not the whole
 * name, while keeping the approval check strict to `sandbox_permissions`.
 */
function toolBaseName(name) {
  const raw = String(name || '').toLowerCase();
  return raw.split(/__|\./).pop() || raw;
}

/** `approval` = user must approve a command; `question` = user must answer a prompt. */
export function humanInputKind(name, args) {
  const tool = toolBaseName(name);
  if (tool === 'request_user_input' || tool === 'elicitation') {
    return 'question';
  }
  if (tool === 'exec_command' || tool === 'shell' || tool === 'exec') {
    const permission = String(args?.sandbox_permissions || '').toLowerCase();
    if (APPROVAL_PERMISSIONS.has(permission)) return 'approval';
  }
  return null;
}

function turnIdOf(payload) {
  return (
    payload?.turn_id ||
    payload?.root_turn_id ||
    payload?.turn_attribution?.turn_id ||
    payload?.internal_chat_message_metadata_passthrough?.turn_id ||
    null
  );
}

/**
 * Parse the tail of one rollout file.
 *
 * @param {string} text
 * @param {{ now?: number, minPendingAgeMs?: number }} opts
 * @returns {{ pending: Array<{callId:string,name:string,kind:string,turnId:string|null,ts:number,ageMs:number}>, openTurns: Array<{turnId:string,startedAt:number}> }}
 */
export function analyzeCodexRollout(text, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const minPendingAgeMs = Number.isFinite(opts.minPendingAgeMs)
    ? Math.max(0, opts.minPendingAgeMs)
    : 0;

  const startedTurns = new Map(); // turn_id -> timestamp
  const completedTurns = new Set();
  const calls = new Map(); // call_id -> { callId, name, kind, turnId, ts }
  const outputs = new Set();

  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      // A poll can land in the middle of an append. Ignore the partial line.
      continue;
    }

    const payload = row?.payload || row;
    const ptype = payload?.type || row?.type;
    const ts = row?.timestamp ? Date.parse(row.timestamp) : NaN;
    const at = Number.isFinite(ts) ? ts : now;
    const turnId = turnIdOf(payload);

    if (ptype === 'task_started' && turnId) {
      if (!startedTurns.has(turnId)) startedTurns.set(turnId, at);
      continue;
    }
    if (ptype === 'task_complete' && turnId) {
      completedTurns.add(turnId);
      continue;
    }

    if (
      ptype === 'function_call_output' ||
      ptype === 'custom_tool_call_output' ||
      ptype === 'item_completed'
    ) {
      // `item_completed` also carries the call id for commandExecution items.
      // Treat it as resolution: a call that finished is not waiting for a human,
      // even if the matching function_call_output line is delayed.
      const callId = payload?.call_id;
      const itemId = payload?.item?.id;
      if (callId) outputs.add(callId);
      if (itemId) outputs.add(itemId);
      continue;
    }

    if (ptype === 'function_call' || ptype === 'custom_tool_call') {
      const callId = payload?.call_id;
      if (!callId) continue;
      const name = payload?.name || payload?.tool_name || payload?.toolName || '';
      const args = parseArgs(payload?.arguments ?? payload?.input);
      const kind = humanInputKind(name, args);
      if (!kind) continue;
      // Keep the first occurrence so the wait clock starts when the call was
      // first written, not when the poller first noticed it.
      if (!calls.has(callId)) {
        calls.set(callId, { callId, name: String(name), kind, turnId, ts: at });
      }
    }
  }

  const pending = [];
  for (const call of calls.values()) {
    if (outputs.has(call.callId)) continue;
    // A completed turn means this call was abandoned/interrupted, not waiting
    // for a human. Do not keep a zombie reminder forever.
    if (call.turnId && completedTurns.has(call.turnId)) continue;
    const ageMs = Math.max(0, now - call.ts);
    if (ageMs < minPendingAgeMs) continue;
    pending.push({ ...call, ageMs });
  }

  const openTurns = [];
  for (const [turnId, startedAt] of startedTurns) {
    if (completedTurns.has(turnId)) continue;
    openTurns.push({ turnId, startedAt });
  }
  openTurns.sort((a, b) => b.startedAt - a.startedAt);
  pending.sort((a, b) => a.ts - b.ts);

  return { pending, openTurns };
}
