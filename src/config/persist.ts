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

function mergeById<T extends { id: string }>(base: T[], incoming: T[]): T[] {
  const byId = new Map(base.map((x) => [x.id, x]));
  for (const item of incoming) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * 版本升级只补缺，不推平用户改过的东西。
 * 新增 agent/角色会进来；已存在的以本地配置为准。
 */
function mergeOverride(base: AppConfig, override: Record<string, unknown>): AppConfig {
  const candidate = mergeWithDefaults(override);
  const baseRaw = base as unknown as Record<string, unknown>;
  const bg = isRecord(baseRaw.background) ? baseRaw.background : {};
  const overrideBg = isRecord(override.background) ? override.background : {};
  return mergeWithDefaults({
    ...override,
    // 本地已有字段优先，override 只补本地没有的新字段 / 新条目。
    ...baseRaw,
    // 只补 override 真正声明的新项，已有项保持用户当前值。
    // 不能无条件 merge candidate：override 没写 agents 时它会是默认 10 人，
    // 会把用户已删除的 agent 又塞回来。
    agents: Array.isArray(override.agents)
      ? mergeById(base.agents, candidate.agents)
      : base.agents,
    characters: Array.isArray(override.characters)
      ? mergeById(base.characters, candidate.characters)
      : base.characters,
    customStatuses: base.customStatuses,
    background: { ...overrideBg, ...bg },
  });
}

/** localStorage 是浏览器可见镜像；Tauri 下不要把 token 写进去。 */
function stripSecrets(config: AppConfig): AppConfig {
  return {
    ...config,
    agents: config.agents.map((a) =>
      a.adapterConfig?.authToken
        ? { ...a, adapterConfig: { ...a.adapterConfig, authToken: undefined } }
        : a,
    ),
  };
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
 * 合并未知 JSON 与默认值 —— 对残缺 / 老版本配置安全。
 *
 * minStageDwellMs 已废弃；escalationTimeoutMs 保留并迁移。
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
      5_000,
      3_600_000,
    ),
    seStageChancePercent: num(
      raw.seStageChancePercent,
      base.seStageChancePercent,
      0,
      100,
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

function saveToLocalStorage(json: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(LOCAL_STORAGE_KEY, json);
    return true;
  } catch {
    // quota / private mode
    return false;
  }
}

export type PersistBackend = 'tauri-file' | 'localStorage' | 'defaults';

export interface LoadConfigResult {
  config: AppConfig;
  backend: PersistBackend;
  /** 读取过程中遇到的问题（不阻断启动，但应该让用户看到） */
  warnings: string[];
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

/**
 * 读配置。优先级：已有的用户配置（Tauri 文件 > localStorage）
 * 之上再叠加 public/config.override.json 里声明过的字段。
 *
 * forceVersion 只在版本号变化时生效，而且**只覆盖 override 里写明的字段**，
 * 用户自己改过的名字/背景/座位不会被推平
 * （旧实现是整份替换，一次 bump 就抹掉所有手工调整）。
 */
export async function loadConfigDetailed(): Promise<LoadConfigResult> {
  const warnings: string[] = [];

  // 1) 先拿现有配置
  let baseConfig: AppConfig | null = null;
  let backend: PersistBackend = 'defaults';

  const fromTauri = await loadFromTauriFile();
  if (fromTauri) {
    try {
      baseConfig = mergeWithDefaults(JSON.parse(fromTauri));
      backend = 'tauri-file';
    } catch {
      warnings.push('Tauri 配置文件解析失败，已回退到其它来源');
    }
  }
  if (!baseConfig) {
    const fromLs = loadFromLocalStorage();
    if (fromLs) {
      try {
        baseConfig = mergeWithDefaults(JSON.parse(fromLs));
        backend = 'localStorage';
      } catch {
        warnings.push('本地配置解析失败，已使用默认配置');
      }
    }
  }

  // 2) override 叠加
  try {
    const res = await fetch('/config.override.json', { cache: 'no-store' });
    if (res.ok) {
      const raw: unknown = await res.json();
      if (isRecord(raw)) {
        const forceVersion =
          typeof raw.forceVersion === 'string' || typeof raw.forceVersion === 'number'
            ? String(raw.forceVersion)
            : null;
        const forceAlways = raw.force === true;
        const versionBump = forceVersion != null && readForceVersion() !== forceVersion;
        if (forceAlways || versionBump) {
          const { force: _f, forceVersion: _fv, ...rest } = raw;
          // 关键：以现有配置为底，新增项补进来，已有项不推平。
          const config = baseConfig
            ? mergeOverride(baseConfig, rest)
            : mergeWithDefaults(rest);
          try {
            await saveConfig(config);
            // 保存成功才记版本号，避免"记了版本但没存进去"导致下次不再导入
            if (forceVersion) writeForceVersion(forceVersion);
          } catch (e) {
            warnings.push(
              `override 导入后保存失败：${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return { config, backend: isTauri() ? 'tauri-file' : 'localStorage', warnings };
        }
      }
    }
  } catch {
    /* override 是可选增强，读不到就用现有配置 */
  }

  return { config: baseConfig ?? defaultConfig(), backend, warnings };
}

/**
 * 保存配置。
 * localStorage 是镜像，Tauri 文件是主存储；主存储失败会**抛错**，
 * 不再静默降级 —— 否则用户会看到"已保存"，重启却回到旧配置。
 */
export async function saveConfig(config: AppConfig): Promise<PersistBackend> {
  const json = JSON.stringify(config, null, 2);
  // localStorage 是可读镜像，不放 token；真正的主存储是 Tauri 文件。
  const mirror = isTauri() ? stripSecrets(config) : config;
  const lsOk = saveToLocalStorage(JSON.stringify(mirror, null, 2));
  const tauriOk = await saveToTauriFile(json);

  if (isTauri() && !tauriOk) {
    throw new Error(
      lsOk
        ? '无法写入应用数据目录（配置只存在浏览器缓存里，重启可能丢失）'
        : '配置保存失败：应用数据目录与浏览器缓存都不可写',
    );
  }
  if (!isTauri() && !lsOk) {
    throw new Error('配置保存失败：浏览器缓存不可写（隐私模式或空间不足）');
  }
  return tauriOk ? 'tauri-file' : 'localStorage';
}

export function describePersistTarget(): string {
  if (isTauri()) {
    return `Tauri app data (${CONFIG_FILENAME}) + localStorage mirror`;
  }
  return `localStorage key "${LOCAL_STORAGE_KEY}"`;
}

export { DEFAULT_DISPLAY_PROFILE };
