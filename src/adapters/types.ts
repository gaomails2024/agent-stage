import type { AdapterConfig } from '../domain/agent';
import type { AgentStatusUpdate } from '../domain/updates';
import type { StatusId } from '../domain/status';

export type { AdapterConfig };

export type EmitFn = (update: AgentStatusUpdate) => void;

export interface AgentAdapter {
  readonly type: string;
  start(emit: EmitFn): void | Promise<void>;
  stop(): void | Promise<void>;
}

/**
 * On-disk / HTTP ingest snapshot (protocol v1).
 * Writers: vendor hooks, bridge scripts, or adapters that translate foreign events.
 * Reader: FileStatusAdapter.
 */
export interface StatusSnapshotV1 {
  schemaVersion: 1;
  /** Should match roster agent id (adapter may remap). */
  agentId: string;
  status: StatusId;
  summary?: string;
  /** ISO-8601 observation time */
  observedAt?: string;
  /**
   * Last successful source check (ISO).
   * Pollers set this on every tick. Absence means the source is event-driven
   * (hooks), so age alone must not be treated as offline.
   */
  checkedAt?: string;
  vendor?: string;
  sessionId?: string;
  /** Poll-backed sources heartbeat via checkedAt; event sources omit it. */
  polled?: boolean;
  meta?: Record<string, unknown>;
}

export type StatusSnapshot = StatusSnapshotV1;

/** Optional NDJSON event line (future EventLogAdapter). */
export interface StatusEventV1 {
  schemaVersion: 1;
  op: 'upsert' | 'clear';
  agentId: string;
  status?: StatusId;
  summary?: string;
  observedAt?: string;
  vendor?: string;
  meta?: Record<string, unknown>;
}

export function isStatusSnapshot(v: unknown): v is StatusSnapshotV1 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 1) return false;
  if (typeof o.agentId !== 'string' || o.agentId.length === 0) return false;
  if (typeof o.status !== 'string' || o.status.length === 0) return false;
  // observedAt 会被直接喂给 new Date()，非法值会在渲染期抛 RangeError，
  // 所以必须在入口拦掉（有测试守着）。
  if (o.observedAt !== undefined && o.observedAt !== null) {
    if (typeof o.observedAt !== 'string') return false;
    if (!isUsableTimestamp(o.observedAt)) return false;
  }
  if (o.checkedAt !== undefined && o.checkedAt !== null) {
    if (typeof o.checkedAt !== 'string') return false;
    if (!isUsableTimestamp(o.checkedAt)) return false;
  }
  if (o.polled !== undefined && typeof o.polled !== 'boolean') return false;
  return true;
}

/** 能被 Date.parse 正确解析、且落在合理区间的时间字符串 */
export function isUsableTimestamp(text: string): boolean {
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return false;
  // 1970~2100 之外视为脏数据（纯数字毫秒串等会被 Date.parse 误解）
  return t > 0 && t < 4_102_444_800_000;
}


export function parseStatusSnapshot(text: string): StatusSnapshotV1 | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isStatusSnapshot(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Default status dir relative to AGENT_STAGE_HOME or ~/.agent-stage */
export const STATUS_DIR_NAME = 'status';
export const DEFAULT_AGENT_STAGE_HOME = '~/.agent-stage';

export function defaultStatusRelPath(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${STATUS_DIR_NAME}/${safe}.json`;
}
