import type { AgentStatusUpdate } from '../domain/updates';
import {
  parseStatusSnapshot,
  type AdapterConfig,
  type AgentAdapter,
  type EmitFn,
  type StatusSnapshotV1,
} from './types';

export type SnapshotReader = (source: string) => Promise<string | null>;

export interface FileStatusAdapterOptions {
  /** Roster agent id — updates are always emitted under this id. */
  agentId: string;
  /**
   * Where to read. Prefer statusUrl in browser; statusPath in Node/Tauri.
   * If both set, statusUrl wins (fetch is universally available in UI).
   */
  statusPath?: string;
  statusUrl?: string;
  pollIntervalMs?: number;
  /**
   * Injected reader for tests / Tauri FS.
   * Default: fetch(url) when source looks like URL/path-for-http, else null in browser.
   */
  readText?: SnapshotReader;
  /** Treat a poll snapshot as lost after this age without a fresh checkedAt. */
  staleAfterMs?: number;
  /** Emit offline after this long without any readable snapshot. */
  missingAfterMs?: number;
  /** Event-driven sources have no heartbeat; never infer liveness from age. */
  eventDriven?: boolean;
}

function looksLikeHttpSource(source: string): boolean {
  return (
    /^https?:\/\//i.test(source) ||
    source.startsWith('/') ||
    source.startsWith('./')
  );
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

function liveStatusAgentId(source: string): string | null {
  const m = source.match(/^\/status\/([A-Za-z0-9._-]+)\.json$/);
  return m ? m[1]! : null;
}

async function defaultReadText(source: string): Promise<string | null> {
  // Tauri 安装包里的 /status 是构建时快照；真实数据在 ~/.agent-stage/status。
  if (isTauriRuntime()) {
    const id = liveStatusAgentId(source);
    if (id) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<string | null>('read_status_snapshot', { agentId: id });
      } catch {
        return null;
      }
    }
  }
  if (!looksLikeHttpSource(source) && !source.includes('://')) {
    // Filesystem paths need Node/Tauri injection — silent skip in plain browser.
    return null;
  }
  try {
    const res = await fetch(source, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Polls Agent Stage status snapshot JSON (protocol v1) and emits updates.
 * Does not invent random states — only mirrors the file/URL.
 */
export class FileStatusAdapter implements AgentAdapter {
  readonly type = 'file';
  private timer: ReturnType<typeof setInterval> | null = null;
  private emit: EmitFn | null = null;
  private readonly agentId: string;
  private readonly source: string;
  private readonly pollIntervalMs: number;
  private readonly readText: SnapshotReader;
  private readonly staleAfterMs: number;
  private readonly missingAfterMs: number;
  private readonly eventDriven: boolean;
  private lastKey = '';
  private firstFailureAt: number | null = null;

  constructor(opts: FileStatusAdapterOptions) {
    this.agentId = opts.agentId;
    const url = opts.statusUrl?.trim();
    const path = opts.statusPath?.trim();
    this.source = url || path || `/status/${opts.agentId}.json`;
    this.pollIntervalMs = Math.max(250, opts.pollIntervalMs ?? 1000);
    this.readText = opts.readText ?? defaultReadText;
    this.staleAfterMs = Math.max(10_000, opts.staleAfterMs ?? 90_000);
    this.missingAfterMs = Math.max(10_000, opts.missingAfterMs ?? 45_000);
    this.eventDriven = opts.eventDriven ?? false;
  }

  static fromAdapterConfig(
    agentId: string,
    config?: AdapterConfig | null,
    readText?: SnapshotReader,
  ): FileStatusAdapter {
    return new FileStatusAdapter({
      agentId,
      statusPath: config?.statusPath,
      statusUrl: config?.statusUrl,
      pollIntervalMs: config?.pollIntervalMs,
      readText,
      staleAfterMs:
        typeof config?.staleAfterMs === 'number' ? config.staleAfterMs : undefined,
      missingAfterMs:
        typeof config?.missingAfterMs === 'number' ? config.missingAfterMs : undefined,
    });
  }

  start(emit: EmitFn): void {
    this.stop();
    this.emit = emit;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit = null;
    this.lastKey = '';
    this.firstFailureAt = null;
  }

  /** One-shot read (tests / debug). */
  async readOnce(): Promise<AgentStatusUpdate | null> {
    const snap = await this.loadSnapshot();
    if (!snap) return null;
    return this.toUpdate(snap);
  }

  private async poll(): Promise<void> {
    if (!this.emit) return;
    const snap = await this.loadSnapshot();
    if (!snap) {
      if (!this.eventDriven) this.handleUnreadable();
      return;
    }
    this.firstFailureAt = null;
    // 新状态读到了，解除上一次"失联"的去重锁。
    if (this.lastKey.startsWith('offline|状态源')) this.lastKey = '';
    const update = this.toUpdate(snap);
    // 状态没变时也要定期刷新 lastSeenAt，否则会把正常轮询误判为失联；
    // 但没必要每 1.5s 都触发一次整块 UI 重算。
    const checkedBucket = update.checkedAt
      ? Math.floor(Date.parse(update.checkedAt) / 15_000)
      : 0;
    const key = `${update.status}|${update.summary ?? ''}|${update.confidence ?? ''}|${checkedBucket}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit(update);
  }

  private handleUnreadable(): void {
    const now = Date.now();
    if (this.firstFailureAt == null) this.firstFailureAt = now;
    if (now - this.firstFailureAt < this.missingAfterMs) return;
    const update: AgentStatusUpdate = {
      agentId: this.agentId,
      status: 'offline',
      summary: '状态源不可读（文件缺失或解析失败）',
      confidence: 'certain',
      reason: `连续 ${Math.round((now - this.firstFailureAt) / 1000)}s 读不到 ${this.source}`,
      observedAt: new Date(now).toISOString(),
      meta: { ingest: 'file', source: this.source, sourceUnreadable: true },
      polled: true,
    };
    const key = `${update.status}|${update.summary}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit?.(update);
  }

  private async loadSnapshot(): Promise<StatusSnapshotV1 | null> {
    const text = await this.readText(this.source);
    if (text == null || text.trim() === '') return null;
    return parseStatusSnapshot(text);
  }

  private toUpdate(snap: StatusSnapshotV1): AgentStatusUpdate {
    // poller 在 meta 里声明 confidence（weak = 靠时间窗/日志猜的，只展示不占注意力）
    const metaConfidence = snap.meta?.confidence;
    const confidence =
      metaConfidence === 'weak' || metaConfidence === 'certain'
        ? (metaConfidence as 'weak' | 'certain')
        : 'certain';
    // 只有带心跳的快照才按轮询源判失联。旧格式没有 checkedAt，
    // 其 observedAt 在状态不变时是刻意冻结的，不能拿来当心跳；
    // hook / 手工事件源同样没有心跳，不能用时间判死。
    const polled = !this.eventDriven && (snap.polled ?? Boolean(snap.checkedAt));
    const checkedMs = snap.checkedAt ? Date.parse(snap.checkedAt) : NaN;
    // 只有轮询型数据源才用 checkedAt 判失联。hook 事件源可能几小时没有新事件，
    // 但它并不是"死了"；这类源没有 checkedAt，必须原样保留最后状态。
    const checkedStale =
      polled && Number.isFinite(checkedMs) && Date.now() - checkedMs > this.staleAfterMs;
    if (checkedStale) {
      return {
        agentId: this.agentId,
        status: 'offline',
        summary: `状态源失联（最后：${snap.summary || snap.status}）`,
        confidence: 'certain',
        reason: `${Math.round((Date.now() - checkedMs) / 1000)}s 没有新的 checkedAt`,
        observedAt: snap.observedAt,
        checkedAt: snap.checkedAt,
        polled,
        meta: {
          ...snap.meta,
          vendor: snap.vendor,
          source: this.source,
          ingest: 'file',
          sourceStale: true,
        },
      };
    }
    return {
      agentId: this.agentId,
      status: snap.status,
      summary: snap.summary,
      confidence,
      reason:
        typeof snap.meta?.reason === 'string'
          ? (snap.meta.reason as string)
          : typeof snap.meta?.signal === 'string'
            ? `信号：${String(snap.meta.signal)}`
            : undefined,
      observedAt: snap.observedAt,
      checkedAt: snap.checkedAt,
      polled,
      meta: {
        ...snap.meta,
        vendor: snap.vendor,
        sessionId: snap.sessionId,
        sourceAgentId: snap.agentId,
        ingest: 'file',
        source: this.source,
      },
    };
  }
}
