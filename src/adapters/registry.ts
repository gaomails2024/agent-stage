import type { AgentInstance, AdapterConfig } from '../domain/agent';
import { BuddyJobsAdapter, type BuddyVendor } from './buddyJobs';
import { FileStatusAdapter } from './file';
import type { AgentAdapter } from './types';

/**
 * Adapter type ids. Primary UX hides these — adapters are prewired in defaults.
 * Settings "高级" may still show them for power users.
 */
export const ADAPTER_TYPES_PRIORITY = [
  'workbuddy',
  'codebuddy',
  'glm',
  'autoclaw',
  'dsh',
  'marvs',
  'hermes',
  'claude-code',
  'codex',
  'file',
  'mock',
] as const;

export type KnownAdapterType = (typeof ADAPTER_TYPES_PRIORITY)[number];

export const ADAPTER_LABELS: Record<KnownAdapterType, string> = {
  workbuddy: 'WorkBuddy (Jobs API)',
  codebuddy: 'CodeBuddy (Jobs API)',
  glm: '智谱清言 (bridge → file)',
  autoclaw: 'AutoClaw (bridge → file)',
  dsh: 'DeepSeek Harness (bridge → file)',
  marvs: 'Marvis (bridge → file)',
  hermes: 'Hermes (bridge → file)',
  'claude-code': 'Claude Code (hooks → file)',
  codex: 'Codex (bridge → file)',
  file: 'File / URL snapshot',
  mock: 'Mock (demo)',
};

/** Adapter types that poll Buddy Jobs HTTP in-process. */
const BUDDY = new Set<string>(['workbuddy', 'codebuddy']);

/** Types that read StatusSnapshotV1 via FileStatusAdapter (bridges/hooks write files). */
const FILE_BACKED = new Set<string>([
  'file',
  'glm',
  'autoclaw',
  'dsh',
  'marvs',
  'hermes',
  'claude-code',
  'codex',
]);

export function isBuddyAdapterType(t: string): t is BuddyVendor {
  return BUDDY.has(t);
}

export function isFileBackedAdapterType(t: string): boolean {
  return FILE_BACKED.has(t);
}

export function createAdapterForAgent(
  agent: AgentInstance,
): AgentAdapter | null {
  if (!agent.enabled) return null;
  const t = agent.adapterType;
  const cfg = agent.adapterConfig;

  if (isBuddyAdapterType(t)) {
    return BuddyJobsAdapter.fromAdapterConfig(agent.id, t, cfg);
  }

  if (isFileBackedAdapterType(t)) {
    return FileStatusAdapter.fromAdapterConfig(
      agent.id,
      withFileDefaults(agent.id, t, cfg),
    );
  }

  // mock is started manually via Debug / Start Mock
  return null;
}

function withFileDefaults(
  agentId: string,
  type: string,
  cfg?: AdapterConfig,
): AdapterConfig {
  const next: AdapterConfig = { ...cfg, vendor: cfg?.vendor ?? type };
  if (!next.statusUrl && !next.statusPath) {
    next.statusUrl = `/status/${agentId}.json`;
  }
  return next;
}
