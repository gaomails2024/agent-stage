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
}

function looksLikeHttpSource(source: string): boolean {
  return (
    /^https?:\/\//i.test(source) ||
    source.startsWith('/') ||
    source.startsWith('./')
  );
}

async function defaultReadText(source: string): Promise<string | null> {
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
  private lastKey = '';

  constructor(opts: FileStatusAdapterOptions) {
    this.agentId = opts.agentId;
    const url = opts.statusUrl?.trim();
    const path = opts.statusPath?.trim();
    this.source = url || path || `/status/${opts.agentId}.json`;
    this.pollIntervalMs = Math.max(250, opts.pollIntervalMs ?? 1000);
    this.readText = opts.readText ?? defaultReadText;
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
    if (!snap) return;
    const update = this.toUpdate(snap);
    // Ignore observedAt-only churn from the live poller rewriting every tick.
    const key = `${update.status}|${update.summary ?? ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit(update);
  }

  private async loadSnapshot(): Promise<StatusSnapshotV1 | null> {
    const text = await this.readText(this.source);
    if (text == null || text.trim() === '') return null;
    return parseStatusSnapshot(text);
  }

  private toUpdate(snap: StatusSnapshotV1): AgentStatusUpdate {
    return {
      agentId: this.agentId,
      status: snap.status,
      summary: snap.summary,
      observedAt: snap.observedAt,
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
