/**
 * 舞台规则：只回答"谁现在需要人"。
 *
 * 四条不变量：
 *
 * I1 不能漏   —— 需要人时一定进坐席高亮；舞台前 N 名一定有人。
 * I2 不能假   —— 弱证据（confidence=weak）或认不出的状态，不占注意力。
 * I3 不自动消失 —— 舞台可以超时下台，但**坐席必须继续亮着、继续计时**，
 *               信息不会丢。真正的结束只有一种：状态变安静了。
 * I4 一眼可判 —— 紧急度优先，同级按等待时长。
 *
 * 关于"超时下台"：
 *   舞台是稀缺资源（最多 2 个位置），所以等太久的人要让位给新来的。
 *   但让位 ≠ 消失：seatHighlight 保留，等待时长继续累加，坐席上照常提示。
 *   这正是"限时下台"和"自己消失"的区别 —— 前者腾地方，后者丢信息。
 */

import type { AgentRuntimeState } from '../domain/updates';
import {
  attentionForStatus,
  priorityForStatus,
  type AttentionTier,
  type CustomStatusDef,
  type StatusId,
} from '../domain/status';

/** 舞台上最多同时显示几个。超出的仍在坐席高亮，不会丢。 */
export const MAX_ON_STAGE = 2;

/**
 * 上台后多久让位下台（毫秒）。下台后坐席继续高亮。
 * 这是"别一直占着舞台"，不是"这事不用管了"。
 */
export const DEFAULT_STAGE_TIMEOUT_MS = 60_000;

/**
 * 状态已经解除后，舞台卡至少留到这一轮动画播完。
 * 素材实测 6.0s（普通）/ 8.0s（美色），留 10s 覆盖解码和最后一次轮询。
 * 这是纯视觉收尾，不算"还在等你"。
 */
export const MIN_STAGE_SETTLE_MS = 10_000;
/** 一次入场至少停留这么久；期间新告警可以排队，但不能把动画砍断。 */
export const MIN_STAGE_DWELL_MS = MIN_STAGE_SETTLE_MS;

export interface StageSnapshot {
  /** 舞台上的 agent，已按"最急、等最久"排好序 */
  onStageIds: string[];
  /** 所有需要人、但没占舞台的 agent（坐席高亮，含超时让位的） */
  seatHighlightIds: string[];
  /** 是否需要人（用于 UI 判断显示 Dashboard 还是聚焦角色） */
  showDashboard: boolean;
  /** 等待中的 agent 数（含舞台上的） */
  waitingCount: number;
  /** 已经等太久、让出舞台但仍需处理的 agent */
  timedOutIds: string[];
  /** 真实告警已解除、只剩收尾动画的 agent（不参与等待计数） */
  settlingIds: string[];
  /** 最近一次入场、还在最短停留保护期内的 agent */
  protectedIds: string[];
}

export interface DeriveInput {
  prev?: AgentRuntimeState;
  agentId: string;
  status: StatusId;
  summary?: string;
  confidence?: 'certain' | 'weak';
  reason?: string;
  /** 上报时间；非法的 observedAt 不要传进来，统一在解析层拦掉 */
  now?: Date;
  /** 数据自带的观测时间；比 now 还新、或早到不合理时会被忽略 */
  observedAt?: Date;
  /** 数据源自带的最近一次成功检查时间 */
  checkedAt?: Date;
  polled?: boolean;
  customStatuses?: CustomStatusDef[];
}

/** observedAt 最多能比现在早多久 —— 再早说明是陈旧数据，按"刚看到"处理。 */
const MAX_OBSERVED_SKEW_MS = 10 * 60_000;

function safeIso(date: Date | undefined): string | null {
  if (!date) return null;
  const t = date.getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * 计算一条更新后的 runtime。纯函数，不碰任何全局状态。
 */
export function deriveRuntime(input: DeriveInput): AgentRuntimeState {
  const now = input.now ?? new Date();
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const custom = input.customStatuses ?? [];

  const status = input.status;
  const declared = attentionForStatus(status, custom);
  const confidence = input.confidence ?? 'certain';

  // I2：弱证据降级为 silent —— 只展示，不占注意力。
  const attention: AttentionTier =
    declared === 'attention' && confidence === 'certain' ? 'attention' : 'silent';
  const waiting = attention === 'attention';

  const prev = input.prev;
  const wasOnStage = Boolean(prev?.onStage || prev?.stageEnteredAt);

  // ---- 等待起点：只在"从不需要人 → 需要人"时设置 ----
  // 同一状态重复上报、或 attention 之间互转（done→error），都不重置，
  // 否则人等的时间会被轮询悄悄清零。
  let attentionSince = prev?.attentionSince ?? null;
  const wasWaiting = prev?.attention === 'attention';
  if (!waiting) {
    attentionSince = null;
  } else if (!wasWaiting || !attentionSince) {
    const observed = input.observedAt;
    const observedMs = observed ? observed.getTime() : NaN;
    const usableObserved =
      Number.isFinite(observedMs) && observedMs <= nowMs && nowMs - observedMs <= MAX_OBSERVED_SKEW_MS;
    attentionSince = safeIso(usableObserved ? new Date(observedMs) : new Date(nowMs));
  }

  const statusChanged = prev?.status !== status;

  // ---- 超时让位：上台起算，超时就撤下舞台，但坐席保留 ----
  // 状态真正变化时重新计时（新的等待是新一轮），同状态重复上报则保持。
  let stageSince = prev?.stageSince ?? null;
  if (!waiting) {
    stageSince = null;
  } else if (statusChanged) {
    stageSince = nowIso;
  } else if (!stageSince) {
    stageSince = attentionSince ?? nowIso;
  }

  // ---- 收尾动画：真实告警刚解除时，至少把已经开始的这一轮播完 ----
  // 从"真正上台"起算；公告解除时若还没满一轮，就保留到满一轮为止。
  // 它只是视觉收尾：等待数、坐席高亮、注意力全部按真实状态算。
  const entryMs = prev?.stageEnteredAt ? Date.parse(prev.stageEnteredAt) : NaN;
  const previousSettleMs = prev?.stageSettlingUntil
    ? Date.parse(prev.stageSettlingUntil)
    : NaN;
  let stageSettlingUntil: string | null = null;
  if (!waiting && status !== 'offline' && wasOnStage) {
    const wantedMs = Number.isFinite(entryMs)
      ? entryMs + MIN_STAGE_SETTLE_MS
      : nowMs + MIN_STAGE_SETTLE_MS;
    const keepMs = Number.isFinite(previousSettleMs)
      ? Math.max(wantedMs, previousSettleMs)
      : wantedMs;
    if (keepMs > nowMs) stageSettlingUntil = new Date(keepMs).toISOString();
  }

  // 首次进入注意力是舞台的"一次出场"。之后 done→error 之类仍算同一轮等待，
  // 舞台重新计时（stageSince），但不应因此重新抽动画/重播入场。
  // 收尾期间继续沿用这次出场的标识，避免动画被 remount。
  let attentionEnteredAt = prev?.attentionEnteredAt ?? null;
  let stageEnteredAt = prev?.stageEnteredAt ?? null;
  if (waiting) {
    if (!wasWaiting) stageEnteredAt = null;
    if (!wasWaiting || !attentionEnteredAt) {
      attentionEnteredAt = attentionSince ?? nowIso;
    }
  } else if (!stageSettlingUntil) {
    attentionEnteredAt = null;
    stageEnteredAt = null;
  }

  return {
    agentId: input.agentId,
    status,
    summary: input.summary ?? prev?.summary ?? '',
    attention,
    updatedAt: nowIso,
    onStage: false, // 由 projectStage 统一决定，避免两处各算一遍
    seatHighlight: waiting,
    attentionSince,
    stageSince,
    attentionEnteredAt,
    stageEnteredAt,
    stageSettlingUntil,
    lastSeenAt:
      safeIso(input.checkedAt) ?? safeIso(input.observedAt) ?? nowIso,
    polled: input.polled ?? prev?.polled ?? false,
    confidence,
    reason: input.reason ?? prev?.reason ?? '',
  };
}

/**
 * 由全部 runtime 计算舞台。
 *
 * 名额是"显示优先级"，不是"是否存在"：
 * 超时让位、或挤不上的，仍然 seatHighlight，等待计时照常走。
 */
export function projectStage(
  runtimes: Map<string, AgentRuntimeState>,
  maxOnStage: number = MAX_ON_STAGE,
  customStatuses: CustomStatusDef[] = [],
  stageTimeoutMs: number = DEFAULT_STAGE_TIMEOUT_MS,
  nowMs: number = Date.now(),
): { runtimes: Map<string, AgentRuntimeState>; stage: StageSnapshot } {
  const waiting = [...runtimes.values()].filter(
    (r) => r.attention === 'attention',
  );

  const isTimedOut = (r: AgentRuntimeState): boolean => {
    if (!r.stageSince) return false;
    const t = Date.parse(r.stageSince);
    if (!Number.isFinite(t)) return false;
    if (nowMs - t < stageTimeoutMs) return false;
    // Even a short configured timeout must not cut the entrance animation.
    const entered = r.stageEnteredAt ? Date.parse(r.stageEnteredAt) : NaN;
    if (Number.isFinite(entered) && nowMs - entered < MIN_STAGE_DWELL_MS) return false;
    return true;
  };

  const ranked = [...waiting].sort((a, b) => {
    // 没超时的优先占舞台（新来的还能被看到），超时的排后面但仍高亮
    const ta = isTimedOut(a) ? 1 : 0;
    const tb = isTimedOut(b) ? 1 : 0;
    if (ta !== tb) return ta - tb;

    const pa = priorityForStatus(a.status, customStatuses);
    const pb = priorityForStatus(b.status, customStatuses);
    if (pa !== pb) return pa - pb;
    const sa = a.stageSince ? Date.parse(a.stageSince) : Infinity;
    const sb = b.stageSince ? Date.parse(b.stageSince) : Infinity;
    if (sa !== sb) return sa - sb;
    return a.agentId.localeCompare(b.agentId);
  });

  const rankedIds = new Set(ranked.map((r) => r.agentId));
  const protectedNow = [...runtimes.values()]
    .filter((r) => {
      if (!r.onStage || !rankedIds.has(r.agentId) || isTimedOut(r)) return false;
      const entered = r.stageEnteredAt ? Date.parse(r.stageEnteredAt) : NaN;
      return Number.isFinite(entered) && nowMs - entered < MIN_STAGE_DWELL_MS;
    })
    .sort((a, b) => {
      const ea = a.stageEnteredAt ? Date.parse(a.stageEnteredAt) : nowMs;
      const eb = b.stageEnteredAt ? Date.parse(b.stageEnteredAt) : nowMs;
      return ea - eb || a.agentId.localeCompare(b.agentId);
    })
    .slice(0, Math.max(0, maxOnStage))
    .map((r) => r.agentId);

  const protectedSet = new Set(protectedNow);
  const readyIds = [
    ...protectedNow,
    ...ranked
      .filter((r) => !isTimedOut(r) && !protectedSet.has(r.agentId))
      .slice(0, Math.max(0, maxOnStage - protectedNow.length))
      .map((r) => r.agentId),
  ];

  const settling = [...runtimes.values()]
    .filter((r) => {
      if (r.attention === 'attention' || !r.stageSettlingUntil) return false;
      const until = Date.parse(r.stageSettlingUntil);
      return Number.isFinite(until) && until > nowMs;
    })
    .sort((a, b) => {
      const ua = Date.parse(a.stageSettlingUntil!);
      const ub = Date.parse(b.stageSettlingUntil!);
      if (ua !== ub) return ua - ub;
      return a.agentId.localeCompare(b.agentId);
    })
    .slice(0, Math.max(0, maxOnStage - readyIds.length))
    .map((r) => r.agentId);

  const onStageIds = [...readyIds, ...settling];
  const onStageSet = new Set(onStageIds);

  const next = new Map<string, AgentRuntimeState>();
  for (const [id, r] of runtimes) {
    const onStage = onStageSet.has(id);
    next.set(id, {
      ...r,
      onStage,
      stageEnteredAt: onStage
        ? r.stageEnteredAt ?? new Date(nowMs).toISOString()
        : settling.includes(id)
          ? r.stageEnteredAt
          : null,
    });
  }

  return {
    runtimes: next,
    stage: {
      onStageIds,
      seatHighlightIds: ranked.map((r) => r.agentId),
      showDashboard: onStageIds.length === 0,
      waitingCount: ranked.length,
      timedOutIds: ranked.filter(isTimedOut).map((r) => r.agentId),
      settlingIds: settling,
      protectedIds: protectedNow,
    },
  };
}

