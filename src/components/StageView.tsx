import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState } from '../domain/updates';
import type { CharacterConfig } from '../config/types';
import type { StageSnapshot } from '../stage/rules';
import { AgentCard } from './AgentCard';
import { DashboardPanel } from './DashboardPanel';
import type { StageMotionChoice } from './motion';

export interface StagePreview {
  choice: StageMotionChoice;
  /** Changes on every click so the same clip can be replayed. */
  token: number;
}

export interface StageViewProps {
  stage: StageSnapshot;
  agentsById: Map<string, AgentInstance>;
  runtimesById: Map<string, AgentRuntimeState>;
  charactersById: Map<string, CharacterConfig>;
  seStageChancePercent?: number;
  /** Decorative animation preview; suppressed whenever real attention exists. */
  preview?: StagePreview | null;
  /** Clip queued to replace the active preview without remounting it. */
  nextPreview?: StagePreview | null;
  /** Stable key while a continuous preview sequence is playing. */
  previewKey?: string;
  onPreviewEnded?: () => void;
}

export function StageView({
  stage,
  agentsById,
  runtimesById,
  charactersById,
  seStageChancePercent = 0,
  preview = null,
  nextPreview = null,
  previewKey,
  onPreviewEnded,
}: StageViewProps) {
  if (preview && stage.waitingCount === 0) {
    const { agent, character, motionSrc } = preview.choice;
    return (
      <section className="stage-view focus-mode split-1" aria-label="Animation preview">
        <div className="stage-grid">
          <div key={previewKey ?? `preview:${preview.token}`} className="stage-slot">
            <AgentCard
              agent={agent}
              character={character}
              variant="stage"
              preview
              previewMotionSrc={motionSrc}
              nextPreviewMotionSrc={nextPreview?.choice.motionSrc ?? null}
              previewLabel={character.name}
              onPreviewEnded={onPreviewEnded}
            />
          </div>
        </div>
      </section>
    );
  }

  if (stage.showDashboard) {
    return (
      <section className="stage-view dashboard-mode" aria-label="Main stage">
        <DashboardPanel
          stage={stage}
          runtimes={[...runtimesById.values()]}
        />
      </section>
    );
  }

  const count = stage.onStageIds.length;

  return (
    <section
      className={`stage-view focus-mode split-${count}`}
      aria-label="Main stage"
    >
      <div className="stage-grid">
        {stage.onStageIds.map((id) => {
          const agent = agentsById.get(id);
          const rt = runtimesById.get(id);
          if (!agent) return null;
          const settling = stage.settlingIds.includes(id);
          const protectedDwell = stage.protectedIds.includes(id);
          // Remount only on a genuinely new entrance. `stageSince` advances
          // on every status change; `stageEnteredAt` is assigned only when a
          // card actually takes a slot, and survives its settling tail.
          return (
            <div key={`${id}:${rt?.stageEnteredAt ?? ''}`} className="stage-slot">
              <AgentCard
                agent={agent}
                runtime={rt}
                character={charactersById.get(agent.characterId)}
                variant="stage"
                seStageChancePercent={seStageChancePercent}
                settling={settling}
                protectedDwell={protectedDwell}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
