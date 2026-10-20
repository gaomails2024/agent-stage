import type { AgentInstance } from '../domain/agent';
import { MAX_SEATS } from '../domain/agent';
import {
  BUILTIN_STATUSES,
  MAX_CUSTOM_STATES,
  validateCustomStatuses,
  type AttentionTier,
  type CustomStatusDef,
} from '../domain/status';
import { DEFAULT_DISPLAY_PROFILE } from './display';
import {
  defaultConfig,
  type AppConfig,
  type CharacterConfig,
  type SeatSide,
} from './types';

export const LOCAL_STORAGE_KEY = 'agent-stage-config';
export const CONFIG_FILENAME = 'config.json';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min = 1, max = 100_000): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizeAgent(raw: unknown, index: number): AgentInstance | null {
  if (!isRecord(raw)) return null;
  const seatIndex = num(raw.seatIndex, index, 0, MAX_SEATS - 1);
  const id = str(raw.id) || crypto.randomUUID();
  const name = str(raw.name).trim() || `Agent ${index + 1}`;
  let adapterConfig: AgentInstance['adapterConfig'];
  if (isRecord(raw.adapterConfig)) {
    const ac = raw.adapterConfig;
    adapterConfig = {
      ...ac,
      statusPath: typeof ac.statusPath === 'string' ? ac.statusPath : undefined,
      statusUrl: typeof ac.statusUrl === 'string' ? ac.statusUrl : undefined,
      pollIntervalMs:
        typeof ac.pollIntervalMs === 'number' && Number.isFinite(ac.pollIntervalMs)
          ? Math.max(250, Math.round(ac.pollIntervalMs))
          : undefined,
      vendor: typeof ac.vendor === 'string' ? ac.vendor : undefined,
    };
  }
  return {
    id,
    name,
    adapterType: str(raw.adapterType, 'mock') || 'mock',
    enabled: raw.enabled !== false,
    seatIndex,
    characterId: str(raw.characterId, 'default') || 'default',
    adapterConfig,
    createdAt: str(raw.createdAt) || new Date().toISOString(),
  };
}

function normalizeCharacter(raw: unknown, fallback: CharacterConfig): CharacterConfig {
  if (!isRecord(raw)) return structuredClone(fallback);
  const actionsIn = Array.isArray(raw.actions) ? raw.actions : [];
  const byStatus = new Map<string, string>();
  for (const a of actionsIn) {
    if (!isRecord(a)) continue;
    const status = str(a.status);
    const assetPath = str(a.assetPath);
    if (status) byStatus.set(status, assetPath || `/characters/default/${status}.png`);
  }
  const id = str(raw.id, fallback.id) || fallback.id;
  const portraitPath =
    str(raw.portraitPath, fallback.portraitPath) || fallback.portraitPath;
  const stageFallback =
    fallback.stagePortraitPath ||
    (id ? `/characters/${id}/stage.png` : '') ||
    portraitPath;
  const stagePortraitPath =
    str(raw.stagePortraitPath, stageFallback) || stageFallback;
  return {
    id,
    name: str(raw.name, fallback.name) || fallback.name,
    portraitPath,
    stagePortraitPath,
    actions: BUILTIN_STATUSES.map((status) => ({
      status,
      assetPath:
        byStatus.get(status) ||
        fallback.actions.find((x) => x.status === status)?.assetPath ||
        `/characters/default/${status}.png`,
      label: undefined,
    })),
  };
}

/**
 * Merge unknown JSON with defaults — safe for partial / older configs.
 */
export function mergeWithDefaults(raw: unknown): AppConfig {
  const base = defaultConfig();
  if (!isRecord(raw)) return base;

  const agentsRaw = Array.isArray(raw.agents) ? raw.agents : null;
  const agents =
    agentsRaw && agentsRaw.length > 0
      ? agentsRaw
          .map((a, i) => normalizeAgent(a, i))
          .filter((a): a is AgentInstance => !!a)
          .slice(0, MAX_SEATS)
      : base.agents;

  const charactersRaw = Array.isArray(raw.characters) ? raw.characters : [];
  const baseById = new Map(base.characters.map((c) => [c.id, c]));
  const characters =
    charactersRaw.length > 0
      ? charactersRaw.map((c, i) => {
          const id =
            typeof c === 'object' && c && 'id' in c && typeof (c as { id: unknown }).id === 'string'
              ? (c as { id: string }).id
              : '';
          const fallback =
            (id && baseById.get(id)) ||
            base.characters[i] ||
            base.characters[0]!;
          return normalizeCharacter(c, fallback);
        })
      : base.characters;

  let customStatuses: CustomStatusDef[] = base.customStatuses;
  if (Array.isArray(raw.customStatuses)) {
    customStatuses = raw.customStatuses
      .filter(isRecord)
      .map((c): CustomStatusDef => {
        const attention: AttentionTier =
          c.attention === 'silent' || c.attention === 'attention'
            ? c.attention
            : 'attention';
        return {
          id: str(c.id).trim(),
          label: str(c.label).trim() || str(c.id).trim(),
          attention,
        };
      })
      .filter((c) => c.id)
      .slice(0, MAX_CUSTOM_STATES);
    try {
      validateCustomStatuses(customStatuses);
    } catch {
      customStatuses = [];
    }
  }

  const seatSide = str(raw.seatSide, base.seatSide) as SeatSide;
  const side: SeatSide =
    seatSide === 'left' || seatSide === 'right' || seatSide === 'bottom'
      ? seatSide
      : 'bottom';

  const bgRaw = isRecord(raw.background) ? raw.background : {};
  const mode = bgRaw.mode === 'image' ? 'image' : 'color';

  return {
    displayProfileId: str(raw.displayProfileId, base.displayProfileId),
    windowWidth: num(raw.windowWidth, base.windowWidth, 320, 7680),
    windowHeight: num(raw.windowHeight, base.windowHeight, 240, 4320),
    background: {
      mode,
      color: str(bgRaw.color, base.background.color ?? '#0f1419') || '#0f1419',
      imagePath: str(bgRaw.imagePath, base.background.imagePath ?? '') || undefined,
    },
    seatSide: side,
    visibleSeats: num(raw.visibleSeats, base.visibleSeats, 1, MAX_SEATS),
    seatCardWidth: num(raw.seatCardWidth, base.seatCardWidth, 64, 320),
    // Cap strip height: old 376 defaults pushed seats off-screen with canvas-based stage height
    seatStripHeight: (() => {
      const cardW = num(raw.seatCardWidth, base.seatCardWidth, 64, 320);
      const floor = Math.ceil(cardW * 1.5 + 104);
      return Math.max(num(raw.seatStripHeight, base.seatStripHeight, 160, 360), floor);
    })(),
    escalationTimeoutMs: num(
      raw.escalationTimeoutMs,
      base.escalationTimeoutMs,
      1000,
      3_600_000,
    ),
    minStageDwellMs: num(
      raw.minStageDwellMs,
      base.minStageDwellMs ?? 120_000,
      1000,
      3_600_000,
    ),
    agents,
    characters,
    customStatuses,
  };
}

function isTauri(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !!(window as any).__TAURI_INTERNALS__
    );
  } catch {
    return false;
  }
}

async function loadFromTauriFile(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const text = await invoke<string>('load_app_config');
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function saveToTauriFile(json: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_app_config', { contents: json });
    return true;
  } catch {
    return false;
  }
}

function loadFromLocalStorage(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(LOCAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveToLocalStorage(json: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LOCAL_STORAGE_KEY, json);
  } catch {
    // quota / private mode
  }
}

export type PersistBackend = 'tauri-file' | 'localStorage' | 'defaults';

export interface LoadConfigResult {
  config: AppConfig;
  backend: PersistBackend;
}

export async function loadConfig(): Promise<AppConfig> {
  const result = await loadConfigDetailed();
  return result.config;
}

export const FORCE_VERSION_KEY = 'agent-stage-force-version';

function readForceVersion(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(FORCE_VERSION_KEY);
  } catch {
    return null;
  }
}

function writeForceVersion(v: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FORCE_VERSION_KEY, v);
  } catch {
    /* ignore */
  }
}

export async function loadConfigDetailed(): Promise<LoadConfigResult> {
  // Optional one-shot / versioned roster from Vite public/ (Mac discovery, etc.)
  try {
    const res = await fetch('/config.override.json', { cache: 'no-store' });
    if (res.ok) {
      const raw = await res.json();
      if (raw && typeof raw === 'object') {
        const rec = raw as Record<string, unknown>;
        const forceVersion =
          typeof rec.forceVersion === 'string' || typeof rec.forceVersion === 'number'
            ? String(rec.forceVersion)
            : null;
        const forceAlways = rec.force === true;
        const versionBump =
          forceVersion != null && readForceVersion() !== forceVersion;
        if (forceAlways || versionBump) {
          const {
            force: _f,
            forceVersion: _fv,
            ...rest
          } = rec;
          const config = mergeWithDefaults(rest);
          await saveConfig(config);
          if (forceVersion) writeForceVersion(forceVersion);
          return { config, backend: 'localStorage' };
        }
      }
    }
  } catch {
    /* ignore */
  }

  const fromTauri = await loadFromTauriFile();
  if (fromTauri) {
    try {
      return {
        config: mergeWithDefaults(JSON.parse(fromTauri)),
        backend: 'tauri-file',
      };
    } catch {
      /* fall through */
    }
  }

  const fromLs = loadFromLocalStorage();
  if (fromLs) {
    try {
      return {
        config: mergeWithDefaults(JSON.parse(fromLs)),
        backend: 'localStorage',
      };
    } catch {
      /* fall through */
    }
  }

  return { config: defaultConfig(), backend: 'defaults' };
}

export async function saveConfig(config: AppConfig): Promise<PersistBackend> {
  const json = JSON.stringify(config, null, 2);
  // Always mirror to localStorage for Vite / fallback
  saveToLocalStorage(json);
  const tauriOk = await saveToTauriFile(json);
  return tauriOk ? 'tauri-file' : 'localStorage';
}

export function describePersistTarget(): string {
  if (isTauri()) {
    return `Tauri app data (${CONFIG_FILENAME}) + localStorage mirror`;
  }
  return `localStorage key "${LOCAL_STORAGE_KEY}"`;
}

export { DEFAULT_DISPLAY_PROFILE };
