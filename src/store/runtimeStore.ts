import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState, AgentStatusUpdate } from '../domain/updates';
import type { CustomStatusDef, StatusId } from '../domain/status';
import { attentionForStatus } from '../domain/status';
import {
  applyStatusUpdate,
  promoteWaiting,
  snapshotStage,
  tickTimeouts,
  type StageSnapshot,
  DEFAULT_ESCALATION_TIMEOUT_MS,
  DEFAULT_MIN_STAGE_DWELL_MS,
} from '../stage/rules';

export type Listener = () => void;

export class RuntimeStore {
  private runtimes = new Map<string, AgentRuntimeState>();
  private stageQueue: string[] = [];
  private listeners = new Set<Listener>();
  private agents: AgentInstance[] = [];
  private customStatuses: CustomStatusDef[] = [];
  private escalationTimeoutMs = DEFAULT_ESCALATION_TIMEOUT_MS;
  private minStageDwellMs = DEFAULT_MIN_STAGE_DWELL_MS;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  setRoster(
    agents: AgentInstance[],
    opts?: {
      customStatuses?: CustomStatusDef[];
      escalationTimeoutMs?: number;
      minStageDwellMs?: number;
    },
  ): void {
    this.agents = agents;
    if (opts?.customStatuses) this.customStatuses = opts.customStatuses;
    if (opts?.escalationTimeoutMs != null) {
      this.escalationTimeoutMs = opts.escalationTimeoutMs;
    }
    if (opts?.minStageDwellMs != null) {
      this.minStageDwellMs = opts.minStageDwellMs;
    }
    const ids = new Set(agents.map((a) => a.id));
    for (const id of [...this.runtimes.keys()]) {
      if (!ids.has(id)) {
        this.runtimes.delete(id);
        this.stageQueue = this.stageQueue.filter((x) => x !== id);
      }
    }
    // Seed missing runtimes as offline (no portrait) until the first live poll.
    for (const a of agents) {
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
          stageDismissed: false,
        });
      }
    }
    this.emit();
  }

  startTicking(everyMs = 1000): void {
    this.stopTicking();
    this.tickTimer = setInterval(() => {
      const result = tickTimeouts(
        this.runtimes,
        this.stageQueue,
        new Date(),
        this.escalationTimeoutMs,
      );
      this.runtimes = result.runtimes;
      this.stageQueue = result.stageQueue;
      this.emit();
    }, everyMs);
  }

  stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  applyUpdate(update: AgentStatusUpdate): void {
    const prev = this.runtimes.get(update.agentId);
    const { runtime, stageQueue } = applyStatusUpdate({
      prev,
      agentId: update.agentId,
      status: update.status,
      summary: update.summary,
      now: update.observedAt ? new Date(update.observedAt) : new Date(),
      customStatuses: this.customStatuses,
      stageQueue: this.stageQueue,
      escalationTimeoutMs: this.escalationTimeoutMs,
      minStageDwellMs: this.minStageDwellMs,
    });
    this.runtimes.set(update.agentId, runtime);
    this.stageQueue = stageQueue;

    const promoted = promoteWaiting(this.runtimes, this.stageQueue);
    this.runtimes = promoted.runtimes;
    this.stageQueue = promoted.stageQueue;
    this.emit();
  }

  forceStatus(agentId: string, status: StatusId, summary?: string): void {
    this.applyUpdate({ agentId, status, summary });
  }

  setEscalationTimeoutMs(ms: number): void {
    this.escalationTimeoutMs = Math.max(1_000, ms);
    this.emit();
  }

  getEscalationTimeoutMs(): number {
    return this.escalationTimeoutMs;
  }

  setMinStageDwellMs(ms: number): void {
    this.minStageDwellMs = Math.max(1_000, ms);
    this.emit();
  }

  getMinStageDwellMs(): number {
    return this.minStageDwellMs;
  }

  getAgents(): AgentInstance[] {
    return this.agents;
  }

  getRuntime(agentId: string): AgentRuntimeState | undefined {
    return this.runtimes.get(agentId);
  }

  getAllRuntimes(): AgentRuntimeState[] {
    return this.agents
      .map((a) => this.runtimes.get(a.id))
      .filter((r): r is AgentRuntimeState => !!r);
  }

  getStage(): StageSnapshot {
    return snapshotStage(this.runtimes, this.stageQueue);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
