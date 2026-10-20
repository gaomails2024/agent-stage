import type { BuiltinStatus } from '../domain/status';
import { BUILTIN_STATUSES } from '../domain/status';
import type { AgentAdapter, EmitFn } from './types';

const SUMMARIES: Record<BuiltinStatus, string[]> = {
  idle: ['待机中', '发呆…', '等下一单'],
  running: ['写代码中', '跑测试…', '翻文档'],
  needs_auth: ['请登录', '等 OAuth', '需要 API Key'],
  needs_input: ['选一下方案', '确认删除？', '补一句需求'],
  done: ['改完了，请审', 'PR 已开', '任务完成'],
  error: ['编译挂了', '超时', '权限拒绝'],
  offline: ['已下线', '未启动', '不在线'],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export interface MockAdapterOptions {
  /** Agent ids this mock drives */
  agentIds: string[];
  /** Interval between random updates (ms) */
  intervalMs?: number;
  /** Prefer attention states more often when true */
  biasAttention?: boolean;
}

/**
 * Cycles / randomly emits status updates for registered mock agents.
 */
export class MockAdapter implements AgentAdapter {
  readonly type = 'mock';
  private timer: ReturnType<typeof setInterval> | null = null;
  private emit: EmitFn | null = null;
  private readonly agentIds: string[];
  private readonly intervalMs: number;
  private readonly biasAttention: boolean;
  private index = 0;

  constructor(opts: MockAdapterOptions) {
    this.agentIds = opts.agentIds;
    this.intervalMs = opts.intervalMs ?? 4000;
    this.biasAttention = opts.biasAttention ?? false;
  }

  start(emit: EmitFn): void {
    this.stop();
    this.emit = emit;
    // Initial idle for all
    for (const id of this.agentIds) {
      emit({
        agentId: id,
        status: 'idle',
        summary: pick(SUMMARIES.idle),
      });
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit = null;
  }

  /** Force one agent into a status (for UI buttons). */
  force(agentId: string, status: BuiltinStatus, summary?: string): void {
    if (!this.emit) return;
    this.emit({
      agentId,
      status,
      summary: summary ?? pick(SUMMARIES[status]),
    });
  }

  private tick(): void {
    if (!this.emit || this.agentIds.length === 0) return;
    const agentId = this.agentIds[this.index % this.agentIds.length]!;
    this.index += 1;

    let pool: BuiltinStatus[] = [...BUILTIN_STATUSES];
    if (this.biasAttention) {
      pool = [
        ...BUILTIN_STATUSES,
        'needs_auth',
        'needs_input',
        'done',
        'error',
      ];
    }
    const status = pick(pool);
    this.emit({
      agentId,
      status,
      summary: pick(SUMMARIES[status]),
    });
  }
}
