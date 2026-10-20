import type { AgentInstance } from '../domain/agent';
import type { AgentRuntimeState } from '../domain/updates';
import type { CharacterConfig } from '../config/types';
import type { StageSnapshot } from '../stage/rules';
import { AgentCard } from './AgentCard';
import { DashboardPanel } from './DashboardPanel';

export interface StageViewProps {
  stage: StageSnapshot;
  agentsById: Map<string, AgentInstance>;
  runtimesById: Map<string, AgentRuntimeState>;
  charactersById: Map<string, CharacterConfig>;
  escalationTimeoutMs: number;
  nowMs: number;
}

function remainingSec(
  rt: AgentRuntimeState | undefined,
  timeoutMs: number,
  nowMs: number,
): number | null {
  if (!rt?.onStage || !rt.attentionSince) return null;
  const elapsed = nowMs - new Date(rt.attentionSince).getTime();
  return Math.max(0, Math.min(Math.round(timeoutMs / 1000), Math.ceil((timeoutMs - elapsed) / 1000)));
}

export function StageView({
  stage,
  agentsById,
  runtimesById,
  charactersById,
  escalationTimeoutMs,
  nowMs,
}: StageViewProps) {
  if (stage.showDashboard) {
    return (
      <section className="stage-view dashboard-mode" aria-label="Main stage">
        <DashboardPanel
          stage={stage}
          runtimes={[...runtimesById.values()]}
          escalationTimeoutSec={Math.round(escalationTimeoutMs / 1000)}
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
          return (
            <div key={id} className="stage-slot">
              <AgentCard
                agent={agent}
                runtime={rt}
                character={charactersById.get(agent.characterId)}
                variant="stage"
                timeoutRemainingSec={remainingSec(
                  rt,
                  escalationTimeoutMs,
                  nowMs,
                )}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
