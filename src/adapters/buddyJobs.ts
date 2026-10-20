import type { AdapterConfig } from '../domain/agent';
import type { AgentStatusUpdate } from '../domain/updates';
import {
  buddyJobToSnapshot,
  pickBuddyJob,
  unwrapBuddyJobsPayload,
  type BuddyJobLike,
} from './buddyMap';
import type { AgentAdapter, EmitFn } from './types';

export type BuddyVendor = 'workbuddy' | 'codebuddy';

export interface BuddyJobsAdapterOptions {
  agentId: string;
  vendor: BuddyVendor;
  /** e.g. http://127.0.0.1:8080 */
  baseUrl?: string;
  /** Gateway password / bearer token from --serve */
  authToken?: string;
  /** Prefer a specific job / session id */
  jobId?: string;
  pollIntervalMs?: number;
  /** Injected fetch for tests */
  fetchImpl?: typeof fetch;
}

function defaultBaseUrl(_vendor: BuddyVendor): string {
  // Env overrides belong in adapterConfig.baseUrl or the Node bridge scripts.
  return 'http://127.0.0.1:8080';
}

/**
 * Poll CodeBuddy / WorkBuddy Jobs HTTP API and emit Stage updates.
 * Requires `codebuddy --serve` (or WorkBuddy equivalent) with CORS/auth configured.
 * Docs: https://www.workbuddy.ai/docs/cli/http-api
 */
export class BuddyJobsAdapter implements AgentAdapter {
  readonly type: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emit: EmitFn | null = null;
  private readonly agentId: string;
  private readonly vendor: BuddyVendor;
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly jobId?: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastKey = '';

  constructor(opts: BuddyJobsAdapterOptions) {
    this.agentId = opts.agentId;
    this.vendor = opts.vendor;
    this.type = opts.vendor;
    this.baseUrl = (opts.baseUrl || defaultBaseUrl(opts.vendor)).replace(
      /\/$/,
      '',
    );
    this.authToken = opts.authToken || '';
    this.jobId = opts.jobId;
    this.pollIntervalMs = Math.max(500, opts.pollIntervalMs ?? 2000);
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  static fromAdapterConfig(
    agentId: string,
    vendor: BuddyVendor,
    config?: AdapterConfig | null,
    fetchImpl?: typeof fetch,
  ): BuddyJobsAdapter {
    return new BuddyJobsAdapter({
      agentId,
      vendor,
      baseUrl:
        typeof config?.baseUrl === 'string' ? config.baseUrl : undefined,
      authToken:
        typeof config?.authToken === 'string' ? config.authToken : undefined,
      jobId: typeof config?.jobId === 'string' ? config.jobId : undefined,
      pollIntervalMs: config?.pollIntervalMs,
      fetchImpl,
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

  async readOnce(): Promise<AgentStatusUpdate | null> {
    const job = await this.loadJob();
    if (!job) return null;
    return this.toUpdate(job);
  }

  private async poll(): Promise<void> {
    if (!this.emit) return;
    try {
      const job = await this.loadJob();
      if (!job) {
        const idle: AgentStatusUpdate = {
          agentId: this.agentId,
          status: 'idle',
          summary: `${this.vendor}: no jobs (is --serve up?)`,
          observedAt: new Date().toISOString(),
          meta: { vendor: this.vendor, ingest: 'buddy-jobs' },
        };
        const key = `${idle.status}|${idle.summary}`;
        if (key !== this.lastKey) {
          this.lastKey = key;
          this.emit(idle);
        }
        return;
      }
      const update = this.toUpdate(job);
      const key = `${update.status}|${update.summary ?? ''}|${String(job.id ?? '')}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.emit(update);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const update: AgentStatusUpdate = {
        agentId: this.agentId,
        status: msg.toLowerCase().includes('auth')
          ? 'needs_auth'
          : 'error',
        summary: `${this.vendor}: ${msg.slice(0, 120)}`,
        observedAt: new Date().toISOString(),
        meta: { vendor: this.vendor, ingest: 'buddy-jobs' },
      };
      const key = `${update.status}|${update.summary}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.emit?.(update);
      }
    }
  }

  private async loadJob(): Promise<BuddyJobLike | null> {
    const headers: Record<string, string> = {
      'X-CodeBuddy-Request': '1',
      Accept: 'application/json',
    };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    const path = this.jobId
      ? `/api/v1/jobs/${encodeURIComponent(this.jobId)}`
      : `/api/v1/jobs?all=1`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers,
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`auth ${res.status} — set adapterConfig.authToken`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    const jobs = unwrapBuddyJobsPayload(json);
    return pickBuddyJob(jobs, this.jobId);
  }

  private toUpdate(job: BuddyJobLike): AgentStatusUpdate {
    const snap = buddyJobToSnapshot(this.agentId, job, this.vendor);
    return {
      agentId: this.agentId,
      status: snap.status,
      summary: snap.summary,
      observedAt: snap.observedAt,
      meta: { ...snap.meta, vendor: this.vendor, ingest: 'buddy-jobs' },
    };
  }
}
