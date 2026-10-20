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
  vendor?: string;
  sessionId?: string;
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
  return (
    o.schemaVersion === 1 &&
    typeof o.agentId === 'string' &&
    typeof o.status === 'string' &&
    o.status.length > 0
  );
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
