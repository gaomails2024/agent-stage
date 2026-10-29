import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState } from '../domain/updates';
import type { CharacterConfig, SeatSide } from '../config/types';
import { AgentCard } from './AgentCard';

export interface SeatBarProps {
  agents: AgentInstance[];
  runtimesById: Map<string, AgentRuntimeState>;
  charactersById: Map<string, CharacterConfig>;
  side?: SeatSide;
}

const MIN_GAP_PX = 8;
/** Right/left plate: 3 rows × 4 columns */
const GRID_COLS = 4;
const GRID_ROWS = 3;
const PLATE_SLOTS = GRID_COLS * GRID_ROWS;

function isSidePlate(side: SeatSide): boolean {
  return side === 'left' || side === 'right';
}

/**
 * Distribute leftover strip space as even gaps.
 * - bottom: single-row flex (n seats, n-1 gaps)
 * - left/right: 3×4 grid — column gaps fill leftover width; row gaps
 *   stay at MIN_GAP_PX so all 3 rows fit (no vertical gap inflate / clip)
 * When cards no longer fit horizontally, fall back to min gap + overflow.
 */
function useSeatStripGap(
  side: SeatSide,
  seatCount: number,
): {
  stripRef: RefObject<HTMLDivElement | null>;
  gapStyle: CSSProperties;
  overflowing: boolean;
} {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [gapStyle, setGapStyle] = useState<CSSProperties>({ gap: `${MIN_GAP_PX}px` });
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;

    const measure = () => {
      const slots = el.querySelectorAll<HTMLElement>('.seat-slot');
      const n = slots.length;
      if (n === 0) {
        setGapStyle({ gap: `${MIN_GAP_PX}px` });
        setOverflowing(false);
        return;
      }

      if (isSidePlate(side)) {
        const cols = GRID_COLS;
        let cardW = 0;
        for (const slot of slots) {
          cardW = Math.max(cardW, slot.getBoundingClientRect().width);
        }
        if (cardW <= 0) return;

        const availW = el.clientWidth;
        const leftoverW = availW - cols * cardW;
        const colGaps = Math.max(1, cols - 1);

        // Column gaps may fill leftover width; row gaps stay at MIN so
        // all 3 rows fit without vertical stretch or a clipped last row.
        let colGap = MIN_GAP_PX;
        let overflow = false;
        if (leftoverW >= MIN_GAP_PX * colGaps) {
          colGap = leftoverW / colGaps;
        } else {
          overflow = true;
        }

        setGapStyle({
          columnGap: `${colGap}px`,
          rowGap: `${MIN_GAP_PX}px`,
        });
        setOverflowing(overflow);
        return;
      }

      // bottom: single-row flex
      const available = el.clientWidth;
      let cardSize = 0;
      for (const slot of slots) {
        cardSize = Math.max(cardSize, slot.getBoundingClientRect().width);
      }
      if (cardSize <= 0) return;

      const leftover = available - n * cardSize;
      if (n === 1) {
        setGapStyle({ gap: `${MIN_GAP_PX}px` });
        setOverflowing(leftover < 0);
        return;
      }
      if (leftover >= MIN_GAP_PX * (n - 1)) {
        setGapStyle({ gap: `${leftover / (n - 1)}px` });
        setOverflowing(false);
      } else {
        setGapStyle({ gap: `${MIN_GAP_PX}px` });
        setOverflowing(true);
      }
    };

    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    measure();
    const raf = requestAnimationFrame(measure);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [side, seatCount]);

  return { stripRef, gapStyle, overflowing };
}

export function SeatBar({
  agents,
  runtimesById,
  charactersById,
  side = 'right',
}: SeatBarProps) {
  const sorted = [...agents].sort((a, b) => a.seatIndex - b.seatIndex);
  const sidePlate = isSidePlate(side);
  // 座位超过 12 个时不要再塞空占位：否则会出现第 4 行并被裁切。
  const emptyCount = sidePlate
    ? Math.max(0, PLATE_SLOTS - sorted.length)
    : 0;
  const { stripRef, gapStyle, overflowing } = useSeatStripGap(
    side,
    sorted.length + emptyCount,
  );

  return (
    <section
      className={`seat-bar side-${side}${sidePlate ? ' plate-3x4' : ''}`}
      aria-label="Agent seats"
    >
      <div
        ref={stripRef}
        className={`seat-strip${sidePlate ? ' seat-strip-grid' : ''}${
          overflowing ? ' is-overflowing' : ' is-filled'
        }`}
        style={gapStyle}
      >
        {sorted.map((agent) => (
          <div key={agent.id} className="seat-slot">
            <AgentCard
              agent={agent}
              runtime={runtimesById.get(agent.id)}
              character={charactersById.get(agent.characterId)}
              variant="seat"
            />
          </div>
        ))}
        {Array.from({ length: emptyCount }, (_, i) => {
          const isLast = i === emptyCount - 1;
          // Temporary status-color legend in the last empty seat for confirm.
          if (isLast) {
            return (
              <div
                key={`empty-slot-${i}`}
                className="seat-slot seat-slot-empty seat-slot-color-preview"
              >
                <div className="agent-card variant-seat is-empty is-color-preview">
                  <div className="color-preview-body">
                    <div className="color-preview-title">状态色预览</div>
                    <div className="color-preview-chip idle">空闲</div>
                    <div className="color-preview-chip running">工作中</div>
                    <div className="color-preview-chip needs_auth">等授权</div>
                    <div className="color-preview-chip needs_input">等操作</div>
                    <div className="color-preview-chip error">出错</div>
                    <div className="color-preview-chip done">完成待审</div>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div
              key={`empty-slot-${i}`}
              className="seat-slot seat-slot-empty"
              aria-hidden
            >
              <div className="agent-card variant-seat is-empty">
                <div className="portrait" />
                <div className="card-meta" />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
