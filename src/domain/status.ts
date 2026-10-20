/**
 * Agent work status model.
 *
 * Built-in seven states are always available.
 * Users may add up to 4 custom states (total max 10).
 *
 * Attention tier (drives stage / seat highlighting):
 * - silent: idle, running, offline — background / no focus steal
 * - attention: needs_auth, needs_input, done (待审核), error —
 *   surfaces on stage. Breath glow is separate: only needs_auth /
 *   needs_input / error (see AgentCard needsIntervention).
 */

export const BUILTIN_STATUSES = [
  'idle',
  'running',
  'needs_auth',
  'needs_input',
  'done',
  'error',
  'offline',
] as const;

export type BuiltinStatus = (typeof BUILTIN_STATUSES)[number];

export type AttentionTier = 'silent' | 'attention';

/** Built-in or custom status id (custom ids are free-form strings). */
export type StatusId = BuiltinStatus | (string & {});

export interface CustomStatusDef {
  id: string;
  label: string;
  /** Defaults to 'attention' if omitted — custom states usually need eyes. */
  attention?: AttentionTier;
}

export const MAX_CUSTOM_STATES = 4;
export const MAX_TOTAL_STATES = 11; // 7 built-in + 4 custom

const BUILTIN_ATTENTION: Record<BuiltinStatus, AttentionTier> = {
  idle: 'silent',
  running: 'silent',
  offline: 'silent',
  needs_auth: 'attention',
  needs_input: 'attention',
  // 完成待审：上舞台提醒，但不打呼吸灯（呼吸灯仅限等授权/等操作/出错）
  done: 'attention',
  error: 'attention',
};

export function isBuiltinStatus(id: string): id is BuiltinStatus {
  return (BUILTIN_STATUSES as readonly string[]).includes(id);
}

export function attentionForStatus(
  status: StatusId,
  customDefs: CustomStatusDef[] = [],
): AttentionTier {
  if (isBuiltinStatus(status)) {
    return BUILTIN_ATTENTION[status];
  }
  const custom = customDefs.find((c) => c.id === status);
  return custom?.attention ?? 'attention';
}

export function validateCustomStatuses(defs: CustomStatusDef[]): void {
  if (defs.length > MAX_CUSTOM_STATES) {
    throw new Error(
      `At most ${MAX_CUSTOM_STATES} custom states (got ${defs.length})`,
    );
  }
  const ids = new Set<string>();
  for (const d of defs) {
    if (!d.id.trim()) throw new Error('Custom status id must be non-empty');
    if (isBuiltinStatus(d.id)) {
      throw new Error(`Custom status id collides with built-in: ${d.id}`);
    }
    if (ids.has(d.id)) throw new Error(`Duplicate custom status id: ${d.id}`);
    ids.add(d.id);
  }
  if (BUILTIN_STATUSES.length + defs.length > MAX_TOTAL_STATES) {
    throw new Error(`Total states cannot exceed ${MAX_TOTAL_STATES}`);
  }
}

export const STATUS_LABELS_ZH: Record<BuiltinStatus, string> = {
  idle: '空闲',
  running: '工作中',
  needs_auth: '等授权',
  needs_input: '等操作',
  done: '完成待审',
  error: '出错',
  offline: '下线',
};

export const STATUS_LABELS_EN: Record<BuiltinStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  needs_auth: 'Needs auth',
  needs_input: 'Needs input',
  done: 'Done (review)',
  error: 'Error',
  offline: 'Offline',
};
