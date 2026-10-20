/** Registered agent instance (user-configured roster). */

export const MAX_SEATS = 16;
export const DEFAULT_VISIBLE_SEATS = 12;

/** Optional per-agent knobs for adapters (file path/url, vendor, …). */
export interface AdapterConfig {
  /** Absolute/relative filesystem path to a status snapshot JSON. */
  statusPath?: string;
  /**
   * HTTP(S) or same-origin URL returning the same snapshot JSON
   * (browser-friendly; e.g. `/status/demo.json`).
   */
  statusUrl?: string;
  /** Poll interval for file/url adapters (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Opaque vendor key for future adapters (claude-code, codex, …). */
  vendor?: string;
  [key: string]: unknown;
}

export interface AgentInstance {
  id: string;
  name: string;
  /** Adapter plugin type, e.g. "mock", "claude-code", "file" */
  adapterType: string;
  enabled: boolean;
  /** 0-based seat index in the seat strip (0 .. MAX_SEATS-1) */
  seatIndex: number;
  /** Character / skin binding id */
  characterId: string;
  /** Adapter-specific options (e.g. file statusPath / statusUrl) */
  adapterConfig?: AdapterConfig;
  createdAt: string; // ISO
}

export function createAgent(partial: {
  id?: string;
  name: string;
  adapterType?: string;
  enabled?: boolean;
  seatIndex: number;
  characterId?: string;
  adapterConfig?: AdapterConfig;
}): AgentInstance {
  if (partial.seatIndex < 0 || partial.seatIndex >= MAX_SEATS) {
    throw new Error(`seatIndex must be 0..${MAX_SEATS - 1}`);
  }
  return {
    id: partial.id ?? crypto.randomUUID(),
    name: partial.name,
    adapterType: partial.adapterType ?? 'mock',
    enabled: partial.enabled ?? true,
    seatIndex: partial.seatIndex,
    characterId: partial.characterId ?? 'default',
    adapterConfig: partial.adapterConfig,
    createdAt: new Date().toISOString(),
  };
}
