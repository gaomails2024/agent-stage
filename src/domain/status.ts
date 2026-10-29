/**
 * Agent work status model.
 *
 * Built-in seven states are always available.
 * Users may add up to 4 custom states (total max 10).
 *
 * Attention tier (drives stage / seat highlighting):
 * - silent: idle, running, offline — background / no focus steal
 * - attention: needs_auth, needs_input, done (MVP: 待审核), error —
 *   needs human eyes; done is treated as attention for MVP so completed
 *   work awaiting review still surfaces on stage.
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
  // MVP: treat done as awaiting review → attention. Documented for later toggle.
  done: 'attention',
  error: 'attention',
};

export function isBuiltinStatus(id: string): id is BuiltinStatus {
  return (BUILTIN_STATUSES as readonly string[]).includes(id);
}

/**
 * 只有"明确知道要人"的状态才算 attention。
 *
 * 认不出来的状态一律 silent —— 这样 vendor 随手写的 busy / working / Running
 * 不会抢舞台。默认值的方向必须偏向"不打扰"，否则一个拼错的词就能让看板失真。
 */
export function attentionForStatus(
  status: StatusId,
  customDefs: CustomStatusDef[] = [],
): AttentionTier {
  if (isBuiltinStatus(status)) {
    return BUILTIN_ATTENTION[status];
  }
  const custom = customDefs.find((c) => c.id === status);
  return custom?.attention ?? 'silent';
}

/**
 * 紧急度排序：数字越小越急。
 * needs_auth（卡死，必须给凭据才能继续）> needs_input（等人决策）
 * > error（已失败，需要处理）> done（完成待审）> 其它自定义。
 */
export function priorityForStatus(
  status: StatusId,
  customDefs: CustomStatusDef[] = [],
): number {
  switch (status) {
    case 'needs_auth':
      return 0;
    case 'needs_input':
      return 1;
    case 'error':
      return 2;
    case 'done':
      return 3;
    case 'offline':
      return 90;
    default:
      break;
  }
  if (isBuiltinStatus(status)) return 80; // idle / running
  const custom = customDefs.find((c) => c.id === status);
  return custom?.attention === 'attention' ? 10 : 80;
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
