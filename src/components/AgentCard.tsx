import { useEffect, useState, type CSSProperties } from 'react';
import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState } from '../domain/updates';
import type { CharacterConfig } from '../config/types';
import { accentForId, initials, statusLabel } from './statusLabels';

export type CardVariant = 'stage' | 'seat';

export interface AgentCardProps {
  agent: AgentInstance;
  runtime?: AgentRuntimeState;
  variant: CardVariant;
  /** Seconds remaining until stage timeout; only meaningful on stage */
  timeoutRemainingSec?: number | null;
  /** Character skin for status art; falls back to silhouette when missing */
  character?: CharacterConfig | null;
}

function assetForStatus(
  character: CharacterConfig | null | undefined,
  status: string,
  variant: CardVariant = 'seat',
): string | null {
  if (!character) return null;
  // Stage focus: full-body stage art (not the seat upper-body crop).
  if (variant === 'stage') {
    return character.stagePortraitPath || character.portraitPath || null;
  }
  const hit = character.actions.find((a) => a.status === status);
  if (hit?.assetPath) return hit.assetPath;
  if (character.portraitPath) return character.portraitPath;
  return null;
}

export function AgentCard({
  agent,
  runtime,
  variant,
  timeoutRemainingSec,
  character,
}: AgentCardProps) {
  const status = runtime?.status ?? 'offline';
  const attention = runtime?.attention ?? 'silent';
  const onStage = runtime?.onStage ?? false;
  const seatHl = runtime?.seatHighlight ?? false;
  const dismissed = runtime?.stageDismissed ?? false;
  const accent = accentForId(agent.id);
  const asset = assetForStatus(character, status, variant);
  const isOffline = status === 'offline';
  // Breath only when a human must act — not for idle/running/done/seatHl dwell.
  const needsIntervention =
    !isOffline &&
    (status === 'needs_input' || status === 'needs_auth' || status === 'error');
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [asset, status]);
  // Offline seats: gray card only — never show portrait art
  const showAsset = !!asset && !imgFailed && !isOffline;
  const showStageTimer =
    variant === 'stage' &&
    timeoutRemainingSec != null &&
    timeoutRemainingSec >= 0;

  const classes = [
    'agent-card',
    `variant-${variant}`,
    attention,
    // Seat only: one status-colored breath ring; stage has no breath
    variant === 'stage' && onStage ? 'on-stage' : '',
    seatHl ? 'seat-hl' : '',
    dismissed ? 'dismissed' : '',
    isOffline ? 'is-offline' : '',
    needsIntervention ? 'needs-intervention' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const portraitInner = (
    <div className="portrait" aria-hidden>
      {!isOffline && (
        <div className={`portrait-figure${showAsset ? ' has-asset' : ''}`}>
          {showAsset ? (
            <img
              className="portrait-asset"
              src={asset!}
              alt=""
              draggable={false}
              onError={() => setImgFailed(true)}
            />
          ) : (
            <>
              <span className="portrait-initials">{initials(agent.name)}</span>
              <span className="portrait-silhouette" />
            </>
          )}
        </div>
      )}
      {variant === 'seat' && (
        <div className="portrait-status-chip">{statusLabel(status)}</div>
      )}
    </div>
  );

  return (
    <article
      className={classes}
      style={{ '--accent': accent } as CSSProperties}
      data-agent-id={agent.id}
      data-variant={variant}
      data-status={status}
    >
      {variant === 'stage' ? (
        <>
          <div className="portrait-stage-name">{agent.name}</div>
          {portraitInner}
          <div className="stage-status-zone">
            <div className="portrait-status-chip stage-status-bar">
              <span className="stage-status-line">
                <span className="stage-status-label">{statusLabel(status)}</span>
                {showStageTimer && (
                  <span className="stage-countdown" aria-label="stage timeout">
                    ：{String(timeoutRemainingSec).padStart(3, '0')}s
                  </span>
                )}
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          {portraitInner}
          <div className="card-meta">
            <h3 className="card-name">{agent.name}</h3>
          </div>
        </>
      )}
    </article>
  );
}
