import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createAdapterForAgent } from './adapters/registry';
import type { AgentAdapter } from './adapters/types';
import { SeatBar, SettingsPanel, StageView } from './components';
import type { StagePreview } from './components/StageView';
import {
  pickRandomNormalStageMotion,
  pickRandomSeStageMotion,
} from './components/motion';
import { loadConfigDetailed, saveConfig, type PersistBackend } from './config/persist';
import { defaultConfig, type AppConfig } from './config/types';
import { RuntimeStore } from './store/runtimeStore';
import './App.css';

export default function App() {
  const storeRef = useRef<RuntimeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new RuntimeStore();
  }
  const store = storeRef.current;

  const fileAdaptersRef = useRef<AgentAdapter[]>([]);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [config, setConfig] = useState<AppConfig>(() => defaultConfig());
  const [configReady, setConfigReady] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [, setPersistBackend] = useState<PersistBackend | 'loading'>('loading');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState<StagePreview | null>(null);
  const [nextPreview, setNextPreview] = useState<StagePreview | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);

  const stopFileAdapters = useCallback(() => {
    for (const a of fileAdaptersRef.current) {
      void a.stop();
    }
    fileAdaptersRef.current = [];
  }, []);

  const startFileAdapters = useCallback(
    (next: AppConfig) => {
      stopFileAdapters();
      const adapters: AgentAdapter[] = [];
      for (const agent of next.agents) {
        const adapter = createAdapterForAgent(agent);
        if (!adapter) continue;
        adapter.start((u) => store.applyUpdate(u));
        adapters.push(adapter);
      }
      fileAdaptersRef.current = adapters;
    },
    [store, stopFileAdapters],
  );

  const applyConfig = useCallback(
    (next: AppConfig) => {
      setConfig(next);
      store.setRoster(next.agents, {
        customStatuses: next.customStatuses,
        stageTimeoutMs: next.escalationTimeoutMs,
      });
      store.startTicking();
      startFileAdapters(next);
    },
    [store, startFileAdapters],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadConfigDetailed();
      if (cancelled) return;
      applyConfig(loaded.config);
      setPersistBackend(loaded.backend);
      setWarnings(loaded.warnings);
      setConfigReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  useEffect(() => {
    const unsub = store.subscribe(rerender);
    return () => {
      unsub();
      stopFileAdapters();
      store.stopTicking();
    };
  }, [store, rerender, stopFileAdapters]);

  const agents = store.getAgents();
  const runtimes = store.getAllRuntimes();
  const stage = store.getStage();

  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled), [agents]);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const runtimesById = useMemo(
    () => new Map(runtimes.map((r) => [r.agentId, r])),
    [runtimes],
  );
  const charactersById = useMemo(
    () => new Map(config.characters.map((c) => [c.id, c])),
    [config.characters],
  );

  // Preview is purely decorative. It never writes RuntimeStore, so it cannot
  // masquerade as a real alert or overwrite a live agent's status.
  const previewRandomEntrance = () => {
    const choice = pickRandomSeStageMotion(agents, charactersById);
    if (!choice) return;
    if (previewPlaying) {
      setNextPreview((prev) => ({ choice, token: (prev?.token ?? 0) + 1 }));
      return;
    }
    setPreview((prev) => ({ choice, token: (prev?.token ?? 0) + 1 }));
  };

  const previewNormalEntrance = () => {
    const choice = pickRandomNormalStageMotion(agents, charactersById);
    if (!choice) return;
    if (previewPlaying) {
      setNextPreview((prev) => ({ choice, token: (prev?.token ?? 0) + 1 }));
      return;
    }
    setPreview((prev) => ({ choice, token: (prev?.token ?? 0) + 1 }));
  };

  const togglePreviewPlayback = () => {
    if (previewPlaying) {
      setPreviewPlaying(false);
      setPreview(null);
      setNextPreview(null);
      return;
    }
    setPreviewPlaying(true);
    if (preview && !nextPreview) {
      const choice = pickRandomNormalStageMotion(agents, charactersById);
      setNextPreview(choice ? { choice, token: 1 } : null);
    }
  };

  // Real alerts always win. If one arrives mid-preview, drop the preview
  // instead of letting it pop back after the alert is resolved.
  useEffect(() => {
    if (preview && stage.waitingCount > 0) setPreview(null);
    if (nextPreview && stage.waitingCount > 0) setNextPreview(null);
  }, [preview, nextPreview, stage.waitingCount]);

  const handlePreviewEnded = () => {
    if (!previewPlaying || stage.waitingCount > 0 || !nextPreview) {
      setPreview(null);
      return;
    }
    setPreview(nextPreview);
    const choice = pickRandomNormalStageMotion(agents, charactersById);
    setNextPreview(choice ? { choice, token: nextPreview.token + 1 } : null);
  };

  // Continuous preview advances only after the current clip ends, so every
  // entrance gets its full playback time. Real alerts pause the sequence and
  // it resumes once the stage is clear again.
  useEffect(() => {
    if (!previewPlaying || stage.waitingCount > 0 || preview) return;
    const choice = pickRandomNormalStageMotion(agents, charactersById);
    if (!choice) {
      setPreviewPlaying(false);
      return;
    }
    setPreview((prev) => ({ choice, token: (prev?.token ?? 0) + 1 }));
    const nextChoice = pickRandomNormalStageMotion(agents, charactersById);
    setNextPreview(nextChoice ? { choice: nextChoice, token: 1 } : null);
  }, [previewPlaying, stage.waitingCount, preview, agents, charactersById]);

  const handleSaveSettings = async (next: AppConfig): Promise<PersistBackend> => {
    const backend = await saveConfig(next);
    applyConfig(next);
    setPersistBackend(backend);
    return backend;
  };

  const bg =
    config.background.mode === 'color'
      ? config.background.color ?? '#0f1419'
      : undefined;

  const shellStyle: CSSProperties = {
    ['--canvas-w' as string]: `${config.windowWidth}px`,
    ['--canvas-h' as string]: `${config.windowHeight}px`,
    ['--seat-card-w' as string]: `${config.seatCardWidth}px`,
    ['--seat-strip-h' as string]: `${config.seatStripHeight}px`,
    ...(config.background.mode === 'image' && config.background.imagePath
      ? {
          backgroundImage: `url(${config.background.imagePath})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : { backgroundColor: bg }),
  };

  if (!configReady) {
    return (
      <div className="app-shell app-loading" style={shellStyle}>
        <p>加载配置…</p>
      </div>
    );
  }

  return (
    <div className="app-shell" style={shellStyle}>
      <div className="corner-actions">
        <button type="button" className="btn btn-sm" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button
          type="button"
          className="btn btn-sm btn-camouflage"
          onClick={previewRandomEntrance}
          disabled={stage.waitingCount > 0}
          title={
            stage.waitingCount > 0
              ? '有真实告警时优先显示告警，处理完再预览'
              : '从美色版舞台动画中随机播放一个'
          }
        >
          随机
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={previewNormalEntrance}
          disabled={stage.waitingCount > 0}
          title={
            stage.waitingCount > 0
              ? '有真实告警时优先显示告警，处理完再预览'
              : '从 10 个 Agent 中随机播放一个动画'
          }
        >
          上台
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={togglePreviewPlayback}
          disabled={stage.waitingCount > 0 && !previewPlaying}
          title={
            previewPlaying
              ? '停止连续随机播放'
              : stage.waitingCount > 0
                ? '有真实告警时优先显示告警，处理完再预览'
                : '连续随机播放 10 个 Agent 的动画'
          }
        >
          {previewPlaying ? '停止' : '播放'}
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="config-warning" role="status">
          {warnings.join('；')}
        </div>
      )}

      <main className={`stage-layout side-${config.seatSide}`}>
        <StageView
          stage={stage}
          agentsById={agentsById}
          runtimesById={runtimesById}
          charactersById={charactersById}
          seStageChancePercent={config.seStageChancePercent}
          preview={preview}
          nextPreview={nextPreview}
          previewKey={previewPlaying ? 'preview:continuous' : `preview:${preview?.token ?? 0}`}
          onPreviewEnded={handlePreviewEnded}
        />
        <SeatBar
          agents={enabledAgents}
          runtimesById={runtimesById}
          charactersById={charactersById}
          side={config.seatSide}
        />
      </main>

      <SettingsPanel
        open={settingsOpen}
        config={config}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}
