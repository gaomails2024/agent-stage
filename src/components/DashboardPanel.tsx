import type { AgentRuntimeState } from '../domain/updates';
import type { StageSnapshot } from '../stage/rules';

export interface DashboardPanelProps {
  stage: StageSnapshot;
  runtimes: AgentRuntimeState[];
}

/** 和舞台同一口径：只有“真的需要人且证据确定”才算在等你。 */
export function countBuckets(runtimes: AgentRuntimeState[]) {
  let needsYou = 0;
  let done = 0;
  let error = 0;
  let running = 0;
  let idle = 0;
  let offline = 0;
  for (const r of runtimes) {
    if (r.status === 'offline') offline++;
    else if (r.attention === 'attention') {
      if (r.status === 'done') done++;
      else needsYou++;
    }
    else if (r.status === 'running') running++;
    else idle++;
  }
  return { needsYou, done, error, running, idle, offline };
}

export function DashboardPanel({ stage, runtimes }: DashboardPanelProps) {
  const b = countBuckets(runtimes);
  return (
    <div className="dashboard-panel">
      <div className="dashboard-hero">
        <p className="dashboard-kicker">Agent Stage</p>
        <h2>{stage.waitingCount > 0 ? `${stage.waitingCount} 个在等你` : '都还好'}</h2>
      </div>
      <div className="dashboard-stats">
        <div className="stat">
          <span className="stat-n">{runtimes.length}</span>
          <span className="stat-l">Agents</span>
        </div>
        <div className="stat warn">
          {/* 与标题同一口径：还没被确认的等待数 */}
          <span className="stat-n">{stage.waitingCount}</span>
          <span className="stat-l">在等你</span>
        </div>
        <div className="stat warn">
          <span className="stat-n">{b.needsYou}</span>
          <span className="stat-l">需介入</span>
        </div>
        <div className="stat">
          <span className="stat-n">{b.done}</span>
          <span className="stat-l">待审</span>
        </div>
        <div className="stat">
          <span className="stat-n">{b.error}</span>
          <span className="stat-l">出错</span>
        </div>
        <div className="stat">
          <span className="stat-n">{b.running}</span>
          <span className="stat-l">Running</span>
        </div>
        <div className="stat ok">
          <span className="stat-n">{b.idle}</span>
          <span className="stat-l">Idle</span>
        </div>
        <div className="stat">
          <span className="stat-n">{b.offline}</span>
          <span className="stat-l">Offline</span>
        </div>
      </div>
    </div>
  );
}
