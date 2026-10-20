import type { AgentRuntimeState } from '../domain/updates';
import type { StageSnapshot } from '../stage/rules';
import type { StatusId } from '../domain/status';
import { statusLabelZh } from './statusLabels';

export interface DashboardPanelProps {
  stage: StageSnapshot;
  runtimes: AgentRuntimeState[];
  escalationTimeoutSec: number;
}

export function DashboardPanel({
  stage,
  runtimes,
  escalationTimeoutSec,
}: DashboardPanelProps) {
  const silent = runtimes.filter((r) => r.attention === 'silent').length;
  const attention = runtimes.filter((r) => r.attention === 'attention').length;
  const running = runtimes.filter((r) => r.status === 'running').length;
  const needs = runtimes.filter(
    (r) => r.status === 'needs_input' || r.status === 'needs_auth',
  ).length;
  const byStatus = runtimes.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="dashboard-panel">
      <div className="dashboard-hero">
        <p className="dashboard-kicker">Main stage</p>
        <h2>Dashboard</h2>
        <p className="dashboard-sub">
          静默时显示看板；有 Agent 要介入时会自动上台（最多 2，FIFO）。
          状态由 bridge / 状态文件轮询刷新。
        </p>
      </div>
      <div className="dashboard-stats">
        <div className="stat">
          <span className="stat-n">{runtimes.length}</span>
          <span className="stat-l">Agents</span>
        </div>
        <div className="stat">
          <span className="stat-n">{running}</span>
          <span className="stat-l">Running</span>
        </div>
        <div className="stat warn">
          <span className="stat-n">{needs}</span>
          <span className="stat-l">Needs you</span>
        </div>
        <div className="stat warn">
          <span className="stat-n">{attention}</span>
          <span className="stat-l">Attention</span>
        </div>
        <div className="stat ok">
          <span className="stat-n">{silent}</span>
          <span className="stat-l">Silent</span>
        </div>
      </div>
      <p className="dashboard-hint">
        Seat highlights: {stage.seatHighlightIds.length || 0} · Timeout{' '}
        {escalationTimeoutSec}s ·{' '}
        {Object.entries(byStatus)
          .map(([s, n]) => `${statusLabelZh(s as StatusId)} ${n}`)
          .join(' · ') || '—'}
      </p>
    </div>
  );
}
