import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState } from '../domain/updates';
import type { CharacterConfig } from '../config/types';
import { accentForId, initials, statusLabel } from './statusLabels';
import { motionSrcFor, seMotionSrcFor, shouldUseSeStage } from './motion';

export type CardVariant = 'stage' | 'seat';

export interface AgentCardProps {
  agent: AgentInstance;
  runtime?: AgentRuntimeState;
  variant: CardVariant;
  /** Character skin for status art; falls back to silhouette when missing */
  character?: CharacterConfig | null;
  /** Stage-only: chance (0–100) that this entrance uses the alternative clip. */
  seStageChancePercent?: number;
  /** Decorative stage preview: does not imply a real runtime status. */
  preview?: boolean;
  /** One-shot clip chosen by the preview picker. */
  previewMotionSrc?: string | null;
  /** Next one-shot clip to load into the same video when the current one ends. */
  nextPreviewMotionSrc?: string | null;
  /** Caption shown in the stage status band during preview. */
  previewLabel?: string;
  /** Called once after a preview clip ends. */
  onPreviewEnded?: () => void;
  /** Visual tail after a real alert has already cleared; not a new alert. */
  settling?: boolean;
  /** True while this card is within the guaranteed one-round stage dwell. */
  protectedDwell?: boolean;
}



function randomIdleGapMs(): number {
  return 1200 + Math.floor(Math.random() * 3800);
}

function PortraitStillOrMotion({
  asset,
  status,
  variant,
  seMotionSrc,
  playOnce = false,
  nextPreviewMotionSrc,
  onPreviewEnded,
  onStillError,
}: {
  asset: string;
  status: string;
  variant: CardVariant;
  /** Alternative stage clip; undefined means this appearance uses the normal one. */
  seMotionSrc?: string | null;
  /** Preview clips play exactly once instead of looping with the stage. */
  playOnce?: boolean;
  nextPreviewMotionSrc?: string | null;
  onPreviewEnded?: () => void;
  onStillError: () => void;
}) {
  const normalMotionSrc = motionSrcFor(asset, status, variant);
  const fallbackMotionSrc = seMotionSrc || normalMotionSrc;
  const [primarySrc, setPrimarySrc] = useState(fallbackMotionSrc);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [motionFailed, setMotionFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<number | null>(null);
  const previewEndedRef = useRef(onPreviewEnded);
  const nextPreviewMotionRef = useRef(nextPreviewMotionSrc);
  // 视频真正跑起来（currentTime > 0）之后才让它盖住静图。
  // 否则 play() 到首帧解码之间会露出第一帧，看起来像"停在开头 1~2 秒"。
  const [frameAdvanced, setFrameAdvanced] = useState(false);

  useEffect(() => {
    previewEndedRef.current = onPreviewEnded;
    nextPreviewMotionRef.current = nextPreviewMotionSrc;
  }, [onPreviewEnded, nextPreviewMotionSrc]);

  // A missing/broken preview clip must not leave the dashboard covered forever.
  useEffect(() => {
    if (playOnce && motionFailed) previewEndedRef.current?.();
  }, [playOnce, motionFailed]);

  // The appearance is chosen once per stage entrance by the parent. If the
  // alternative clip is missing/unreadable, fall back to the normal clip
  // instead of dropping the stage animation entirely.
  const motionSrc = primarySrc;

  useEffect(() => {
    setMotionFailed(false);
    setPlaying(false);
    setFrameAdvanced(false);
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, [asset, motionSrc]);

  useEffect(() => {
    if (!motionSrc || motionFailed) return;
    const v = videoRef.current;
    if (!v) return;
    const startPlayback = () => {
      try {
        v.currentTime = 0;
        setFrameAdvanced(false);
        setPlaying(true);
        void v.play().catch(() => {
          setPlaying(false);
          setMotionFailed(true);
        });
      } catch {
        setPlaying(false);
        setMotionFailed(true);
      }
    };
    // 首帧解码完成 + 时间轴确实前进后才显示视频，
    // 避开"play() 之后画面定格在第一帧"的空窗。
    const onTimeUpdate = () => {
      if (v.currentTime > 0.05) setFrameAdvanced(true);
    };
    v.addEventListener('timeupdate', onTimeUpdate);
    const onEnded = () => {
      // Seat stills freeze between plays; valid stage previews stay covered continuously.
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      if (playOnce) {
        if (nextPreviewMotionRef.current) {
          setFrameAdvanced(false);
          setPrimarySrc(nextPreviewMotionRef.current);
          previewEndedRef.current?.();
          try {
            v.currentTime = 0;
            setPlaying(true);
            void v.play();
          } catch {
            setPlaying(false);
            setMotionFailed(true);
          }
        } else {
          setPlaying(false);
          setFrameAdvanced(false);
          previewEndedRef.current?.();
        }
      } else if (variant === 'stage') {
        // Stage motion is a KF1→motion→KF1 loop: replay immediately.
        setFrameAdvanced(false);
        void v.play().catch(() => {
          setPlaying(false);
          setMotionFailed(true);
        });
      } else {
        setPlaying(false);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(startPlayback, randomIdleGapMs());
      }
    };
    v.addEventListener('ended', onEnded);
    // Independent per-card first play: 0.3–5s random delay so cards never start in sync.
    const firstDelayMs = 300 + Math.random() * 4700;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(startPlayback, variant === 'stage' ? 0 : firstDelayMs);
    return () => {
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('timeupdate', onTimeUpdate);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, [motionSrc, motionFailed, playOnce, variant]);

  return (
    <>
      <img
        className="portrait-asset"
        src={asset}
        alt=""
        draggable={false}
        style={{
          opacity:
            variant === 'stage' && motionSrc && !motionFailed ? 0 : 1,
        }}
        onError={onStillError}
      />
      {motionSrc && !motionFailed ? (
        <video
          ref={videoRef}
          className="portrait-asset portrait-motion"
          src={motionSrc}
          muted
          playsInline
          preload="auto"
          style={{ opacity: variant === 'stage' ? 1 : playing && frameAdvanced ? 1 : 0 }}
          loop={!playOnce && variant === 'stage'}
          onError={() => {
            if (normalMotionSrc && primarySrc !== normalMotionSrc) {
              setPrimarySrc(normalMotionSrc);
              setMotionFailed(false);
              setFrameAdvanced(false);
              return;
            }
            setPlaying(false);
            setMotionFailed(true);
          }}
        />
      ) : null}
    </>
  );
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

/** 等了多久：给人一个"这事到底积压了多久"的判断依据 */
function waitingFor(since: string | null, nowMs: number): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hour}h${rest}m` : `${hour}h`;
}

export function AgentCard({
  agent,
  runtime,
  variant,
  character,
  seStageChancePercent = 0,
  preview = false,
  previewMotionSrc,
  nextPreviewMotionSrc,
  previewLabel,
  onPreviewEnded,
  settling = false,
  protectedDwell = false,
}: AgentCardProps) {
  const status = runtime?.status ?? (preview ? 'running' : 'offline');
  const attention = runtime?.attention ?? 'silent';
  const onStage = runtime?.onStage ?? false;
  const seatHl = runtime?.seatHighlight ?? false;
  const isWeak = runtime?.confidence === 'weak';
  const accent = accentForId(agent.id);
  const asset = assetForStatus(character, status, variant);
  const isOffline = status === 'offline';
  // 呼吸灯：真的需要人动手时才亮（done 只是待审，不催）
  const needsIntervention =
    !isOffline &&
    attention === 'attention' &&
    (status === 'needs_input' || status === 'needs_auth' || status === 'error');
  const [imgFailed, setImgFailed] = useState(false);
  // Pick once per stage entrance, not on every poll/render. The parent remounts
  // stage cards with a new appearanceKey when an agent takes the stage again.
  const [seStage] = useState(
    () =>
      !preview &&
      variant === 'stage' &&
      shouldUseSeStage(seStageChancePercent, Math.random() * 100),
  );
  useEffect(() => {
    setImgFailed(false);
  }, [asset, status]);
  // Offline seats: gray card only — never show portrait art
  const showAsset = !!asset && !imgFailed && !isOffline;

  const waited = preview ? null : waitingFor(runtime?.attentionSince ?? null, Date.now());
  const classes = [
    'agent-card',
    `variant-${variant}`,
    attention,
    variant === 'stage' && (onStage || preview) ? 'on-stage' : '',
    seatHl ? 'seat-hl' : '',
    isOffline ? 'is-offline' : '',
    needsIntervention && !preview && !settling ? 'needs-intervention' : '',
    settling ? 'is-settling' : '',
    protectedDwell ? 'is-dwell' : '',
    isWeak ? 'is-weak' : '',
  ]
    .filter(Boolean)
    .join(' ');


  const portraitInner = (
    <div className="portrait" aria-hidden>
      {!isOffline && (
        <div className={`portrait-figure${showAsset ? ' has-asset' : ''}`}>
          {showAsset ? (
            <PortraitStillOrMotion
              asset={asset!}
              status={status}
              variant={variant}
              playOnce={preview}
              nextPreviewMotionSrc={nextPreviewMotionSrc}
              onPreviewEnded={preview ? onPreviewEnded : undefined}
              seMotionSrc={
                preview
                  ? previewMotionSrc ?? null
                  : variant === 'stage' && seStage
                    ? seMotionSrcFor(asset)
                    : null
              }
              onStillError={() => setImgFailed(true)}
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
                <span className="stage-status-label">
                  {preview
                    ? '动画预览'
                    : settling
                      ? `收尾 · ${statusLabel(status)}`
                      : statusLabel(status)}
                </span>
                {waited && <span className="stage-waited">已等 {waited}</span>}
              </span>
              {(previewLabel || runtime?.summary) && (
                <span className="stage-summary">
                  {previewLabel || runtime?.summary}
                </span>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          {portraitInner}
          <div className="card-meta">
            <h3 className="card-name">{agent.name}</h3>
            {isWeak && <span className="card-weak" title={runtime?.reason}>?</span>}
          </div>
        </>
      )}
    </article>
  );
}
