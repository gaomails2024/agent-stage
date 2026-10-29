/**
 * Smoke: stage rules + mock + config merge/persist.
 * Run: pnpm smoke
 */
import { MockAdapter } from '../src/adapters/mock';
import { FileStatusAdapter } from '../src/adapters/file';
import { parseStatusSnapshot } from '../src/adapters/types';
import {
  mapBuddyJobToStatus,
  pickBuddyJob,
  unwrapBuddyJobsPayload,
} from '../src/adapters/buddyMap';
import { BuddyJobsAdapter } from '../src/adapters/buddyJobs';
import { createAdapterForAgent } from '../src/adapters/registry';
import { defaultConfig } from '../src/config/types';
import {
  LOCAL_STORAGE_KEY,
  loadConfig,
  mergeWithDefaults,
  saveConfig,
} from '../src/config/persist';
import { createSeededStore } from '../src/store/runtimeStore';
import { deriveRuntime, projectStage, MAX_ON_STAGE } from '../src/stage/rules';
import { attentionForStatus } from '../src/domain/status';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log('smoke: attention tiers');
assert(attentionForStatus('idle') === 'silent', 'idle silent');
assert(attentionForStatus('running') === 'silent', 'running silent');
assert(attentionForStatus('needs_auth') === 'attention', 'auth');
assert(attentionForStatus('done') === 'attention', 'done=attention MVP');

console.log('smoke: 舞台按紧急度排序、超员不丢信息');
const m1 = new Map<string, ReturnType<typeof deriveRuntime>>();
for (const [id, st] of [['a', 'needs_auth'], ['b', 'done'], ['c', 'needs_input']] as const) {
  m1.set(id, deriveRuntime({ agentId: id, status: st, summary: st, now: new Date('2026-01-01T00:00:00Z') }));
}
const p1 = projectStage(m1, MAX_ON_STAGE, [], 60_000, Date.parse('2026-01-01T00:00:00Z'));
assert(p1.stage.onStageIds.length === MAX_ON_STAGE, 'stage capped');
assert(p1.stage.onStageIds[0] === 'a', 'needs_auth first');
assert(p1.stage.onStageIds[1] === 'c', 'needs_input second');
assert(p1.stage.seatHighlightIds.length === 3, 'all three highlighted');
assert(p1.stage.onStageIds.includes('b') === false, 'done waits behind');

console.log('smoke: 需要人不会因为时间流逝消失');
const base = deriveRuntime({ agentId: 'a', status: 'needs_input', summary: 't', now: new Date('2026-01-01T00:00:00Z') });
const later = deriveRuntime({
  prev: base, agentId: 'a', status: 'needs_input', summary: 't2',
  now: new Date('2026-01-01T06:00:00Z'),
});
assert(later.attentionSince === base.attentionSince, '等待起点不被刷新');
const pLater = projectStage(new Map([['a', later]]), MAX_ON_STAGE, [], 60_000, Date.parse('2026-01-01T06:00:00Z'));
assert(pLater.stage.seatHighlightIds.includes('a'), '六小时后仍在坐席高亮（只是让出舞台）');

console.log('smoke: 弱证据与未知状态不占注意力');
const weak = deriveRuntime({ agentId: 'w', status: 'done', summary: 'x', confidence: 'weak' });
assert(weak.attention === 'silent', 'weak -> silent');
assert(deriveRuntime({ agentId: 'u', status: 'busy', summary: 'x' }).attention === 'silent', 'unknown -> silent');

console.log('smoke: MockAdapter emits');
const cfg = defaultConfig();
const store = createSeededStore(cfg.agents);
const received: string[] = [];
const mock = new MockAdapter({
  agentIds: cfg.agents.map((x) => x.id),
  intervalMs: 50,
});
await new Promise<void>((resolve) => {
  mock.start((u) => {
    store.applyUpdate(u);
    received.push(`${u.agentId}:${u.status}`);
    if (received.length >= cfg.agents.length + 2) {
      mock.stop();
      resolve();
    }
  });
});
assert(received.length >= cfg.agents.length, 'got updates');
assert(store.getAllRuntimes().length === cfg.agents.length, 'runtimes');

console.log('smoke: mergeWithDefaults + localStorage persist');
const merged = mergeWithDefaults({
  windowWidth: 800,
  agents: [{ id: 'x', name: 'X', seatIndex: 0, adapterType: 'mock' }],
  customStatuses: [{ id: 'paused', label: '暂停', attention: 'silent' }],
});
assert(merged.windowWidth === 800, 'merged width');
assert(merged.agents.length === 1 && merged.agents[0]!.name === 'X', 'merged agent');
assert(merged.customStatuses[0]?.id === 'paused', 'custom status');

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

await saveConfig(merged);
const loaded = await loadConfig();
assert(loaded.agents[0]?.id === 'x', 'roundtrip agent');
assert(
  typeof localStorage.getItem(LOCAL_STORAGE_KEY) === 'string',
  'localStorage written',
);


console.log('smoke: parseStatusSnapshot + FileStatusAdapter');
const snapText = JSON.stringify({
  schemaVersion: 1,
  agentId: 'file-1',
  status: 'needs_auth',
  summary: 'login please',
  observedAt: '2026-01-02T00:00:00.000Z',
  vendor: 'demo',
});
assert(parseStatusSnapshot(snapText)?.status === 'needs_auth', 'parse snapshot');
assert(parseStatusSnapshot('{bad') === null, 'bad json null');
assert(parseStatusSnapshot('{"schemaVersion":1}') === null, 'incomplete null');

const fileStore = createSeededStore([
  {
    id: 'file-1',
    name: 'File One',
    adapterType: 'file',
    enabled: true,
    seatIndex: 0,
    characterId: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
    adapterConfig: { statusPath: '/tmp/fake.json', pollIntervalMs: 50 },
  },
]);
let fileGot = '';
const mem = { text: snapText };
const fileAdapter = new FileStatusAdapter({
  agentId: 'file-1',
  statusPath: '/tmp/fake.json',
  pollIntervalMs: 40,
  readText: async () => mem.text,
});
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('file adapter timeout')), 2000);
  fileAdapter.start((u) => {
    fileStore.applyUpdate(u);
    fileGot = `${u.agentId}:${u.status}:${u.summary}`;
    if (u.status === 'needs_auth') {
      mem.text = JSON.stringify({
        schemaVersion: 1,
        agentId: 'file-1',
        status: 'running',
        summary: 'working',
        observedAt: '2026-01-02T00:00:01.000Z',
      });
    }
    if (u.status === 'running') {
      clearTimeout(t);
      fileAdapter.stop();
      resolve();
    }
  });
});
assert(fileGot.startsWith('file-1:running'), `file adapter got ${fileGot}`);
assert(fileStore.getRuntime('file-1')?.status === 'running', 'store running');


console.log('smoke: buddy job mapping + BuddyJobsAdapter');
assert(mapBuddyJobToStatus({ state: 'blocked' }).status === 'needs_input', 'blocked');
assert(mapBuddyJobToStatus({ state: 'working' }).status === 'running', 'working');
assert(mapBuddyJobToStatus({ state: 'failed' }).status === 'error', 'failed');
assert(mapBuddyJobToStatus({ state: 'done' }).status === 'done', 'done');
const picked = pickBuddyJob([
  { id: 'a', state: 'idle', status: 'idle' },
  { id: 'b', state: 'blocked', status: 'waiting' },
]);
assert(picked?.id === 'b', 'pick blocked first');
assert(unwrapBuddyJobsPayload({ data: [{ id: 'x', state: 'working' }] }).length === 1, 'unwrap');

const buddyStore = createSeededStore([
  {
    id: 'wb-1',
    name: 'WB',
    adapterType: 'workbuddy',
    enabled: true,
    seatIndex: 0,
    characterId: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
    adapterConfig: { baseUrl: 'http://buddy.test', authToken: 't' },
  },
]);
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  assert(url.includes('/api/v1/jobs'), 'jobs url');
  return new Response(
    JSON.stringify({
      data: [{ id: 'j1', name: 'Alpha', state: 'blocked', status: 'waiting' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
let buddyStatus = '';
const buddy = new BuddyJobsAdapter({
  agentId: 'wb-1',
  vendor: 'workbuddy',
  baseUrl: 'http://buddy.test',
  authToken: 't',
  pollIntervalMs: 50,
  fetchImpl: fakeFetch,
});
await new Promise<void>((resolve, reject) => {
  const tmo = setTimeout(() => reject(new Error('buddy timeout')), 2000);
  buddy.start((u) => {
    buddyStore.applyUpdate(u);
    buddyStatus = u.status;
    if (u.status === 'needs_input') {
      clearTimeout(tmo);
      buddy.stop();
      resolve();
    }
  });
});
assert(buddyStatus === 'needs_input', 'buddy emit');

const created = createAdapterForAgent({
  id: 'cb-1',
  name: 'CB',
  adapterType: 'codebuddy',
  enabled: true,
  seatIndex: 1,
  characterId: 'default',
  createdAt: '2026-01-01T00:00:00.000Z',
});
assert(created?.type === 'codebuddy', 'factory codebuddy');
assert(
  createAdapterForAgent({
    id: 'm',
    name: 'M',
    adapterType: 'mock',
    enabled: true,
    seatIndex: 0,
    characterId: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
  }) === null,
  'mock not auto-started',
);

console.log('OK — M0/M1/M2/M3 adapters smoke passed');
