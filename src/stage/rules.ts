/**
 * Stage / seat attention rules (M0 logic; M1 wires full UI).
 *
 * - Main stage normally shows Dashboard.
 * - On attention: agent may go on stage; max 2 on stage, FIFO.
 * - After escalationTimeoutMs (default 120s) without clear:
 *   leave stage, keep seatHighlight, set stageDismissed (no auto re-promote).
 * - minStageDwellMs (default 120s): once on stage for attention, do not leave
 *   the same tick the alert appeared; stay until status leaves needs_* AND
 *   minimum dwell has elapsed (or escalation demotes).
 */

import type { AgentRuntimeState } from '../domain/updates';
import { attentionForStatus, type CustomStatusDef, type StatusId } from '../domain/status';

export const DEFAULT_ESCALATION_TIMEOUT_MS = 120_000;
/** Minimum time an attention agent stays on stage before a silent status can clear it. */
export const DEFAULT_MIN_STAGE_DWELL_MS = 120_000;
export const MAX_ON_STAGE = 2;

export interface StageSnapshot {
  /** Agent ids currently on main stage (0–2), FIFO order */
  onStageIds: string[];
  /** Agent ids with seat highlight (attention and/or post-timeout) */
  seatHighlightIds: string[];
  /** true → show Dashboard placeholder instead of character focus */
  showDashboard: boolean;
}

export interface ApplyUpdateInput {
  prev: AgentRuntimeState | undefined;
  agentId: string;
  status: StatusId;
  summary?: string;
  now?: Date;
  customStatuses?: CustomStatusDef[];
  /** Current ordered list of agents on stage (FIFO) */
  stageQueue: string[];
  escalationTimeoutMs?: number;
  /** Min ms on stage before silent status may demote (default 120s) */
  minStageDwellMs?: number;
}

export interface ApplyUpdateResult {
  runtime: AgentRuntimeState;
  /** Updated FIFO stage queue after this event */
  stageQueue: string[];
}

/**
 * Pure transition for one status update against stage rules.
 */
export function applyStatusUpdate(input: ApplyUpdateInput): ApplyUpdateResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const custom = input.customStatuses ?? [];
  const attention = attentionForStatus(input.status, custom);

  let stageQueue = [...input.stageQueue];
  const wasOnStage = input.prev?.onStage ?? false;
  let onStage = wasOnStage;
  let seatHighlight = input.prev?.seatHighlight ?? false;
  let attentionSince = input.prev?.attentionSince ?? null;
  // Fresh attention clears timeout-dismissal so agent can queue again
  let stageDismissed =
    attention === 'attention' ? false : (input.prev?.stageDismissed ?? false);
  const minDwell = input.minStageDwellMs ?? DEFAULT_MIN_STAGE_DWELL_MS;

  // Offline is absolute: never breathe, never stay/promote on stage.
  if (input.status === 'offline') {
    stageQueue = stageQueue.filter((id) => id !== input.agentId);
    onStage = false;
    seatHighlight = false;
    attentionSince = null;
    stageDismissed = false;
  } else if (attention === 'attention') {
    seatHighlight = true;
    if (!attentionSince || input.prev?.attention === 'silent') {
      attentionSince = nowIso;
    }

    if (!onStage && !stageDismissed) {
      if (stageQueue.length < MAX_ON_STAGE) {
        if (!stageQueue.includes(input.agentId)) {
          stageQueue.push(input.agentId);
        }
        onStage = true;
      } else if (!stageQueue.includes(input.agentId)) {
        onStage = false;
      }
    }
  } else {
    // Silent: only leave stage after minimum dwell (never same tick as promote)
    const sinceMs = attentionSince
      ? new Date(attentionSince).getTime()
      : null;
    const elapsed =
      sinceMs != null ? now.getTime() - sinceMs : Number.POSITIVE_INFINITY;
    const holdOnStage =
      wasOnStage &&
      Boolean(input.prev?.attention === 'attention' || input.prev?.onStage) &&
      elapsed < minDwell &&
      elapsed >= 0;

    if (holdOnStage) {
      // Keep stage slot + seat pulse; status text may already be idle/running
      onStage = true;
      seatHighlight = true;
      if (!stageQueue.includes(input.agentId)) {
        stageQueue.push(input.agentId);
      }
      // Keep attentionSince so escalation / dwell clocks continue
    } else {
      stageQueue = stageQueue.filter((id) => id !== input.agentId);
      onStage = false;
      seatHighlight = false;
      attentionSince = null;
      stageDismissed = false;
    }
  }

  const runtime: AgentRuntimeState = {
    agentId: input.agentId,
    status: input.status,
    summary: input.summary ?? input.prev?.summary ?? '',
    attention,
    updatedAt: nowIso,
    onStage,
    seatHighlight,
    attentionSince,
    stageDismissed,
  };

  return { runtime, stageQueue };
}

/**
 * After a slot frees, promote earliest-waiting attention agents (not on stage).
 * Skips agents dismissed by timeout until they get a new status update.
 */
export function promoteWaiting(
  runtimes: Map<string, AgentRuntimeState>,
  stageQueue: string[],
  maxOnStage: number = MAX_ON_STAGE,
): { runtimes: Map<string, AgentRuntimeState>; stageQueue: string[] } {
  const next = new Map(runtimes);
  let queue = [...stageQueue];

  const waiting = [...next.values()]
    .filter(
      (r) =>
        r.attention === 'attention' &&
        !r.onStage &&
        !r.stageDismissed &&
        !queue.includes(r.agentId),
    )
    .sort((a, b) => {
      const ta = a.attentionSince ?? a.updatedAt;
      const tb = b.attentionSince ?? b.updatedAt;
      return ta.localeCompare(tb);
    });

  for (const w of waiting) {
    if (queue.length >= maxOnStage) break;
    queue.push(w.agentId);
    next.set(w.agentId, { ...w, onStage: true, seatHighlight: true });
  }

  return { runtimes: next, stageQueue: queue };
}

/**
 * Periodic tick: demote timed-out stage occupants, then promote waiters.
 */
export function tickTimeouts(
  runtimes: Map<string, AgentRuntimeState>,
  stageQueue: string[],
  now: Date = new Date(),
  escalationTimeoutMs: number = DEFAULT_ESCALATION_TIMEOUT_MS,
): { runtimes: Map<string, AgentRuntimeState>; stageQueue: string[] } {
  let queue = [...stageQueue];
  const next = new Map(runtimes);

  for (const id of [...queue]) {
    const r = next.get(id);
    if (!r?.attentionSince) continue;
    const elapsed = now.getTime() - new Date(r.attentionSince).getTime();
    if (elapsed >= escalationTimeoutMs) {
      queue = queue.filter((x) => x !== id);
      next.set(id, {
        ...r,
        onStage: false,
        seatHighlight: true,
        stageDismissed: true,
      });
    }
  }

  return promoteWaiting(next, queue);
}

export function snapshotStage(
  runtimes: Map<string, AgentRuntimeState>,
  stageQueue: string[],
): StageSnapshot {
  const onStageIds = stageQueue.filter((id) => runtimes.get(id)?.onStage);
  const seatHighlightIds = [...runtimes.values()]
    .filter((r) => r.seatHighlight)
    .map((r) => r.agentId);

  return {
    onStageIds,
    seatHighlightIds,
    showDashboard: onStageIds.length === 0,
  };
}
