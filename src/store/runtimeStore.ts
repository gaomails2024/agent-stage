import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState, AgentStatusUpdate } from '../domain/updates';
import type { CustomStatusDef, StatusId } from '../domain/status';
import { attentionForStatus } from '../domain/status';
import {
  deriveRuntime,
  projectStage,
  DEFAULT_STAGE_TIMEOUT_MS,
  MAX_ON_STAGE,
  type StageSnapshot,
} from '../stage/rules';

export type Listener = () => void;

/**
 * 全部 agent 的运行时状态。
 *
 * 有一个每 1 秒的 tick，但它**只做一件事**：检查谁在舞台上占太久了，让位给后来的人。
 * 它不会把任何人从坐席高亮里撤掉 —— 需要人处理这件事，只有状态变化才结束。
 */
export class RuntimeStore {
  private runtimes = new Map<string, AgentRuntimeState>();
  private listeners = new Set<Listener>();
  private agents: AgentInstance[] = [];
  private customStatuses: CustomStatusDef[] = [];
  private stageTimeoutMs = DEFAULT_STAGE_TIMEOUT_MS;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  setRoster(
    agents: AgentInstance[],
    opts?: { customStatuses?: CustomStatusDef[]; stageTimeoutMs?: number },
  ): void {
    this.agents = agents;
    if (opts?.customStatuses) this.customStatuses = opts.customStatuses;
    if (opts?.stageTimeoutMs != null) this.stageTimeoutMs = opts.stageTimeoutMs;

    // 禁用 = 从看板上撤下。
    const active = new Set(agents.filter((a) => a.enabled).map((a) => a.id));
    for (const id of [...this.runtimes.keys()]) {
      if (!active.has(id)) this.runtimes.delete(id);
    }
    for (const a of agents) {
      if (!a.enabled) continue;
      if (!this.runtimes.has(a.id)) {
        this.runtimes.set(a.id, {
          agentId: a.id,
          status: 'offline',
          summary: '',
          attention: 'silent',
          updatedAt: new Date().toISOString(),
          onStage: false,
          seatHighlight: false,
          attentionSince: null,
          stageSince: null,
          attentionEnteredAt: null,
          stageEnteredAt: null,
          stageSettlingUntil: null,
          lastSeenAt: null,
          polled: false,
          confidence: 'certain',
          reason: '尚未收到状态',
        });
      }
    }
    this.refreshStage();
    this.emit();
  }

  /** 每 1 秒重算一次舞台名额（超时让位）。不影响坐席高亮。 */
  startTicking(everyMs = 1000): void {
    this.stopTicking();
    this.tickTimer = setInterval(() => {
      this.tickNow();
    }, everyMs);
  }

  /** 立即按当前时间重算一次舞台；测试和调试也用它。 */
  tickNow(nowMs: number = Date.now()): void {
    const before = this.getStage().onStageIds.join(',');
    // 舞台卡会显示“已等 X”；收尾卡也要在窗口结束时准时撤下。
    const showClock = this.getAllRuntimes().some((r) => r.onStage);
    this.runtimes = projectStage(
      this.runtimes,
      MAX_ON_STAGE,
      this.customStatuses,
      this.stageTimeoutMs,
      nowMs,
    ).runtimes;
    const after = this.getStage().onStageIds.join(',');
    // 舞台变化要让 UI 更新；有人仍在等待时也要更新"已等 X"。
    if (before !== after || showClock) this.emit();
  }

  stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  applyUpdate(update: AgentStatusUpdate): void {
    const prev = this.runtimes.get(update.agentId);
    const now = new Date();
    const observed = update.observedAt ? new Date(update.observedAt) : undefined;
    const checked = update.checkedAt ? new Date(update.checkedAt) : undefined;
    const runtime = deriveRuntime({
      prev,
      agentId: update.agentId,
      status: update.status,
      summary: update.summary,
      confidence: update.confidence,
      reason: update.reason,
      now,
      observedAt: observed && Number.isFinite(observed.getTime()) ? observed : undefined,
      checkedAt: checked && Number.isFinite(checked.getTime()) ? checked : undefined,
      polled: update.polled,
      customStatuses: this.customStatuses,
    });
    this.runtimes.set(update.agentId, runtime);
    this.refreshStage();
    this.emit();
  }

  forceStatus(agentId: string, status: StatusId, summary?: string): void {
    this.applyUpdate({ agentId, status, summary });
  }

  setStageTimeoutMs(ms: number): void {
    this.stageTimeoutMs = Math.max(5_000, ms);
    this.refreshStage();
    this.emit();
  }

  getStageTimeoutMs(): number {
    return this.stageTimeoutMs;
  }

  getAgents(): AgentInstance[] {
    return this.agents;
  }

  getRuntime(agentId: string): AgentRuntimeState | undefined {
    return this.runtimes.get(agentId);
  }

  /** 只返回启用中的 agent —— 用于 Dashboard 计数与坐席列表 */
  getAllRuntimes(): AgentRuntimeState[] {
    return this.agents
      .filter((a) => a.enabled)
      .map((a) => this.runtimes.get(a.id))
      .filter((r): r is AgentRuntimeState => !!r);
  }

  getStage(): StageSnapshot {
    return projectStage(
      this.runtimes,
      MAX_ON_STAGE,
      this.customStatuses,
      this.stageTimeoutMs,
      Date.now(),
    ).stage;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private refreshStage(): void {
    this.runtimes = projectStage(
      this.runtimes,
      MAX_ON_STAGE,
      this.customStatuses,
      this.stageTimeoutMs,
      Date.now(),
    ).runtimes;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Convenience for tests / scripts without DOM */
export function createSeededStore(agents: AgentInstance[]): RuntimeStore {
  const store = new RuntimeStore();
  store.setRoster(agents);
  return store;
}

// Re-export attention helper for UI
export { attentionForStatus };
