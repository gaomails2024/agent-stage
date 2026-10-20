import type { StatusId } from './status';

/** Payload adapters emit into the store. */
export interface AgentStatusUpdate {
  agentId: string;
  status: StatusId;
  /** One-line summary for overlay / dashboard */
  summary?: string;
  /** Optional opaque metadata from adapter */
  meta?: Record<string, unknown>;
  /** When the adapter observed this state (ISO). Defaults to now in store. */
  observedAt?: string;
}

/** Live runtime view of one agent (roster + latest status). */
export interface AgentRuntimeState {
  agentId: string;
  status: StatusId;
  summary: string;
  attention: import('./status').AttentionTier;
  updatedAt: string;
  /** On main stage right now */
  onStage: boolean;
  /** Seat still highlighted after timeout demotion */
  seatHighlight: boolean;
  /** When this agent entered attention / stage (for FIFO + timeout) */
  attentionSince: string | null;
  /** True after timeout demotion — stays on seat HL, not auto-promoted until status changes */
  stageDismissed: boolean;
}
