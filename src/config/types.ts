import type { AgentInstance } from '../domain/agent';
import type { BuiltinStatus, CustomStatusDef } from '../domain/status';
import { BUILTIN_STATUSES } from '../domain/status';
import { DEFAULT_DISPLAY_PROFILE } from './display';

export type SeatSide = 'bottom' | 'left' | 'right';

export interface BackgroundConfig {
  mode: 'color' | 'image';
  /** CSS color when mode=color */
  color?: string;
  /** Local path or URL when mode=image */
  imagePath?: string;
}

/** Per-status visual binding for a character skin */
export interface StatusActionBinding {
  status: BuiltinStatus | string;
  /** Asset path (static image / sprite sheet) */
  assetPath: string;
  /** Optional short label override */
  label?: string;
}

export interface CharacterConfig {
  id: string;
  name: string;
  /** Default portrait / idle standing art (seat uses this; often upper-body crop) */
  portraitPath: string;
  /** Full-body stage standing art (853×1280 contain). Falls back to portraitPath. */
  stagePortraitPath?: string;
  /** Bindings for the 6 built-in states (+ optional custom) */
  actions: StatusActionBinding[];
}

/** 界面配置。 */
export interface AppConfig {
  /** Default secondary-monitor canvas (iPad 4 landscape logical 1024×768) */
  displayProfileId: string;
  windowWidth: number;
  windowHeight: number;
  background: BackgroundConfig;
  seatSide: SeatSide;
  visibleSeats: number;
  seatCardWidth: number;
  seatStripHeight: number;
  /** 上台后多久让出舞台（ms）；超时后坐席仍然高亮。 */
  escalationTimeoutMs: number;
  /** 舞台动画抽中美色版（se.stage-motion.webm）的概率，0–100。 */
  seStageChancePercent: number;
  agents: AgentInstance[];
  characters: CharacterConfig[];
  customStatuses: CustomStatusDef[];
}

/** Built-in roster: agents only (no chatbots); adapters prewired; users only edit UI. */
export const DEFAULT_ROSTER_SPEC: ReadonlyArray<{
  id: string;
  name: string;
  adapterType: string;
  characterId: string;
  vendor: string;
}> = [
  { id: 'workbuddy-1', name: 'WorkBuddy', adapterType: 'file', characterId: 'workbuddy', vendor: 'workbuddy' },
  { id: 'codebuddy-1', name: 'CodeBuddy', adapterType: 'file', characterId: 'codebuddy', vendor: 'codebuddy' },
  { id: 'hermes-1', name: 'Hermes Agent', adapterType: 'hermes', characterId: 'hermes', vendor: 'hermes' },
  { id: 'dsh-1', name: 'DeepSeek Harness', adapterType: 'dsh', characterId: 'dsh', vendor: 'dsh' },
  { id: 'grok-bot-1', name: 'Grok Bot', adapterType: 'file', characterId: 'grok-bot', vendor: 'grok-bot' },
  { id: 'marvs-1', name: 'Marvis', adapterType: 'marvs', characterId: 'marvis', vendor: 'marvis' },
  { id: 'autoclaw-1', name: 'AutoClaw', adapterType: 'autoclaw', characterId: 'autoclaw', vendor: 'autoclaw' },
  { id: 'doubao-1', name: '豆包工作', adapterType: 'file', characterId: 'doubao', vendor: 'doubao' },
  { id: 'claude-code-1', name: 'Claude Code', adapterType: 'claude-code', characterId: 'claude-code', vendor: 'claude-code' },
  { id: 'codex-1', name: 'Codex', adapterType: 'codex', characterId: 'codex', vendor: 'codex' },
] as const;

function characterFor(id: string, name: string): CharacterConfig {
  const base = `/characters/${id}`;
  // Prefer standing portrait; per-status art can diverge later.
  const portrait = `${base}/portrait.png`;
  const stage = `${base}/stage.png`;
  return {
    id,
    name,
    portraitPath: portrait,
    stagePortraitPath: stage,
    actions: BUILTIN_STATUSES.map((status) => ({
      status,
      assetPath: portrait,
    })),
  };
}

export function defaultConfig(): AppConfig {
  const now = new Date().toISOString();
  const characters: CharacterConfig[] = [
    characterFor('default', 'Default Chan'),
    ...DEFAULT_ROSTER_SPEC.map((r) => characterFor(r.characterId, r.name)),
  ];
  // Deduplicate character ids (roster characterIds are unique)
  const seen = new Set<string>();
  const uniqueChars = characters.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  const agents: AgentInstance[] = DEFAULT_ROSTER_SPEC.map((r, i) => ({
    id: r.id,
    name: r.name,
    adapterType: r.adapterType,
    enabled: true,
    seatIndex: i,
    characterId: r.characterId,
    adapterConfig: {
      statusUrl: `/status/${r.id}.json`,
      pollIntervalMs: 1500,
      vendor: r.vendor,
    },
    createdAt: now,
  }));

  return {
    displayProfileId: DEFAULT_DISPLAY_PROFILE.id,
    windowWidth: DEFAULT_DISPLAY_PROFILE.windowWidth,
    windowHeight: DEFAULT_DISPLAY_PROFILE.windowHeight,
    background: { mode: 'color', color: '#0f1419' },
    seatSide: 'right',
    visibleSeats: agents.length,
    seatCardWidth: DEFAULT_DISPLAY_PROFILE.defaultSeatCardWidth,
    seatStripHeight: DEFAULT_DISPLAY_PROFILE.defaultSeatStripHeight,
    escalationTimeoutMs: 60_000,
    seStageChancePercent: 0,
    agents,
    characters: uniqueChars,
    customStatuses: [],
  };
}
