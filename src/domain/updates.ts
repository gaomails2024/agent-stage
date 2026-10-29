import type { StatusId } from './status';

/** Payload adapters emit into the store. */
export interface AgentStatusUpdate {
  agentId: string;
  status: StatusId;
  /** One-line summary for overlay / dashboard */
  summary?: string;
  /**
   * 这条状态有多可信。
   * - certain（默认）：来自明确信号（官方 API / 明确的 turn 开始与结束）
   * - weak：靠时间窗、mtime、日志痕迹猜出来的 —— 只展示，不占注意力
   */
  confidence?: 'certain' | 'weak';
  /** 为什么这么判（给"一眼可判"用，也方便事后追查信号源） */
  reason?: string;
  /** Optional opaque metadata from adapter */
  meta?: Record<string, unknown>;
  /** When the adapter observed this state (ISO). Defaults to now in store. */
  observedAt?: string;
  /** Last time the source was successfully checked (ISO). */
  checkedAt?: string;
  /**
   * Poll-backed sources must say so. Without it, silence means "no event",
   * not "dead" — hook-driven sessions can legally sit quiet for hours.
   */
  polled?: boolean;
}

/** Live runtime view of one agent (roster + latest status). */
export interface AgentRuntimeState {
  agentId: string;
  status: StatusId;
  summary: string;
  attention: import('./status').AttentionTier;
  updatedAt: string;
  /** On main stage right now */
  onStage: boolean;
  /** Seat still highlighted (attention / 等待人处理) */
  seatHighlight: boolean;
  /** 什么时候开始等人。同状态重复上报不会改这个值（I3） */
  attentionSince: string | null;
  /** 什么时候上的舞台。用于"占太久让位"，与等待时长分开算 */
  stageSince: string | null;
  /** 最近一次真正进入注意力（silent → attention）的时间；`stageSince` 会随状态变化重算 */
  attentionEnteredAt: string | null;
  /** 实际被分配到舞台的时间；用于保证一次入场至少完整播一轮 */
  stageEnteredAt: string | null;
  /** 已经下台、但动画还没播完的收尾截止时间；只影响视觉，不影响等待统计 */
  stageSettlingUntil: string | null;
  /** 最后一次成功读到状态源的时间；用于判断数据源是否还活着 */
  lastSeenAt: string | null;
  /** Whether the source is expected to heartbeat while running. */
  polled: boolean;
  /** 这条状态的可信度；weak 一律不进注意力（I2） */
  confidence: 'certain' | 'weak';
  /** 人类可读的判定依据 */
  reason: string;
}

