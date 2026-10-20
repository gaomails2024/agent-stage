import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createAdapterForAgent } from './adapters/registry';
import { MockAdapter } from './adapters/mock';
import type { AgentAdapter } from './adapters/types';
import { SeatBar, SettingsPanel, StageView } from './components';
import {
  loadConfigDetailed,
  saveConfig,
  type PersistBackend,
} from './config/persist';
import { defaultConfig, type AppConfig } from './config/types';
import { RuntimeStore } from './store/runtimeStore';
import './App.css';

export default function App() {
  const storeRef = useRef<RuntimeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new RuntimeStore();
  }
  const store = storeRef.current;

  const mockRef = useRef<MockAdapter | null>(null);
  const fileAdaptersRef = useRef<AgentAdapter[]>([]);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [config, setConfig] = useState<AppConfig>(() => defaultConfig());
  const [configReady, setConfigReady] = useState(false);
  const [, setPersistBackend] = useState<PersistBackend | 'loading'>(
    'loading',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mockRunning, setMockRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());


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
    (next: AppConfig, opts?: { restartMock?: boolean }) => {
      setConfig(next);
      store.setRoster(next.agents, {
        customStatuses: next.customStatuses,
        escalationTimeoutMs: next.escalationTimeoutMs,
        minStageDwellMs: next.minStageDwellMs,
      });
      startFileAdapters(next);

      if (opts?.restartMock && mockRef.current) {
        mockRef.current.stop();
        const adapter = new MockAdapter({
          agentIds: next.agents.filter((a) => a.enabled).map((a) => a.id),
          intervalMs: 3500,
          biasAttention: true,
        });
        mockRef.current = adapter;
        adapter.start((u) => store.applyUpdate(u));
        setMockRunning(true);
      }
    },
    [store, startFileAdapters],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { config: loaded, backend } = await loadConfigDetailed();
      if (cancelled) return;
      applyConfig(loaded);
      setPersistBackend(backend);
      setConfigReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  useEffect(() => {
    const unsub = store.subscribe(rerender);
    store.startTicking(1000);
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      unsub();
      store.stopTicking();
      mockRef.current?.stop();
      stopFileAdapters();
      clearInterval(clock);
    };
  }, [store, rerender, stopFileAdapters]);

  const agents = store.getAgents();
  const runtimes = store.getAllRuntimes();
  const stage = store.getStage();
  const escalationTimeoutMs = store.getEscalationTimeoutMs();

  const agentsById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );
  const runtimesById = useMemo(
    () => new Map(runtimes.map((r) => [r.agentId, r])),
    [runtimes],
  );
  const charactersById = useMemo(
    () => new Map(config.characters.map((c) => [c.id, c])),
    [config.characters],
  );

  const enabledAgents = useMemo(
    () => agents.filter((a) => a.enabled),
    [agents],
  );

  const startMock = () => {
    mockRef.current?.stop();
    const adapter = new MockAdapter({
      agentIds: enabledAgents.map((a) => a.id),
      intervalMs: 3500,
      biasAttention: true,
    });
    mockRef.current = adapter;
    adapter.start((u) => store.applyUpdate(u));
    setMockRunning(true);
  };

  const stopMock = () => {
    mockRef.current?.stop();
    mockRef.current = null;
    setMockRunning(false);
  };


  const handleSaveSettings = async (next: AppConfig): Promise<PersistBackend> => {
    const backend = await saveConfig(next);
    applyConfig(next, { restartMock: mockRunning });
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
      <header className="top-bar">
        <div>
          <h1>Agent Stage</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
          {!mockRunning ? (
            <button type="button" className="btn primary" onClick={startMock}>
              Start Mock
            </button>
          ) : (
            <button type="button" className="btn danger" onClick={stopMock}>
              Stop Mock
            </button>
          )}
        </div>
      </header>

      <main className={`stage-layout side-${config.seatSide}`}>
        <StageView
          stage={stage}
          agentsById={agentsById}
          runtimesById={runtimesById}
          charactersById={charactersById}
          escalationTimeoutMs={escalationTimeoutMs}
          nowMs={nowMs}
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
