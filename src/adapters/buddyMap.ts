import type { BuiltinStatus } from '../domain/status';
import type { StatusSnapshotV1 } from './types';

/** Subset of CodeBuddy / WorkBuddy Jobs API fields we care about. */
export interface BuddyJobLike {
  id?: string;
  shortId?: string;
  sessionId?: string;
  name?: string;
  state?: string;
  status?: string;
  tempo?: string;
  alive?: boolean;
  settled?: boolean;
  cwd?: string;
  summary?: string;
  lastMessage?: string;
  [key: string]: unknown;
}

/**
 * Map Buddy Jobs lifecycle → Agent Stage status.
 * Prefer `state` (working|blocked|done|failed|stopped), fall back to `status` (busy|waiting|idle|stopped).
 */
export function mapBuddyJobToStatus(job: BuddyJobLike): {
  status: BuiltinStatus;
  summary: string;
} {
  const state = String(job.state ?? '').toLowerCase();
  const live = String(job.status ?? '').toLowerCase();
  const tempo = String(job.tempo ?? '').toLowerCase();
  const name = String(job.name || job.id || job.shortId || 'job');

  if (state === 'blocked' || live === 'waiting' || tempo === 'blocked') {
    return {
      status: 'needs_input',
      summary: job.summary
        ? String(job.summary)
        : `${name}: waiting / blocked`,
    };
  }
  if (state === 'failed') {
    return {
      status: 'error',
      summary: job.summary ? String(job.summary) : `${name}: failed`,
    };
  }
  if (state === 'done') {
    return {
      status: 'done',
      summary: job.summary ? String(job.summary) : `${name}: done`,
    };
  }
  if (state === 'working' || live === 'busy' || tempo === 'active') {
    return {
      status: 'running',
      summary: job.summary
        ? String(job.summary)
        : `${name}: working`,
    };
  }
  if (state === 'stopped' || live === 'stopped') {
    return {
      status: 'idle',
      summary: `${name}: stopped`,
    };
  }
  if (live === 'idle' || tempo === 'idle' || state === '') {
    return {
      status: 'idle',
      summary: `${name}: idle`,
    };
  }
  // 未知枚举不能默认 running：那会把“看不懂”伪装成“在忙”，并可能占注意力。
  return {
    status: 'idle',
    summary: `${name}: unknown state (${state || live || 'unknown'})`,
  };
}

/** Pick the job that most needs human attention, else the busiest. */
export function pickBuddyJob(
  jobs: BuddyJobLike[],
  preferId?: string,
): BuddyJobLike | null {
  if (!jobs.length) return null;
  if (preferId) {
    const hit = jobs.find(
      (j) =>
        j.id === preferId ||
        j.shortId === preferId ||
        j.sessionId === preferId,
    );
    if (hit) return hit;
  }
  const rank = (j: BuddyJobLike): number => {
    const { status } = mapBuddyJobToStatus(j);
    switch (status) {
      case 'needs_auth':
        return 0;
      case 'needs_input':
        return 1;
      case 'error':
        return 2;
      case 'done':
        return 3;
      case 'running':
        return 4;
      default:
        return 5;
    }
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export function buddyJobToSnapshot(
  agentId: string,
  job: BuddyJobLike,
  vendor: 'workbuddy' | 'codebuddy',
): StatusSnapshotV1 {
  const mapped = mapBuddyJobToStatus(job);
  return {
    schemaVersion: 1,
    agentId,
    status: mapped.status,
    summary: mapped.summary,
    observedAt: new Date().toISOString(),
    vendor,
    sessionId: job.sessionId ? String(job.sessionId) : undefined,
    meta: {
      jobId: job.id,
      shortId: job.shortId,
      state: job.state,
      status: job.status,
      tempo: job.tempo,
      cwd: job.cwd,
    },
  };
}

export function unwrapBuddyJobsPayload(json: unknown): BuddyJobLike[] {
  if (Array.isArray(json)) return json as BuddyJobLike[];
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data as BuddyJobLike[];
    if (o.data && typeof o.data === 'object') {
      const d = o.data as Record<string, unknown>;
      if (Array.isArray(d.jobs)) return d.jobs as BuddyJobLike[];
      // single job
      if (d.id || d.state || d.status) return [d as BuddyJobLike];
    }
    if (o.id || o.state || o.status) return [o as BuddyJobLike];
  }
  return [];
}
