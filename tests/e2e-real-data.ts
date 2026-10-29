/**
 * 端到端：读真实的 public/status/*.json，走 adapter → store → 舞台，
 * 验证"谁在等我"在真实数据下是否正确，以及确认后不再反复打扰。
 *
 * Run: npx tsx tests/e2e-real-data.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStatusAdapter } from '../src/adapters/file';
import { RuntimeStore } from '../src/store/runtimeStore';
import { defaultConfig } from '../src/config/types';

const STATUS_DIR = join(process.cwd(), 'public', 'status');

const cfg = defaultConfig();
const store = new RuntimeStore();
store.setRoster(cfg.agents);

const files = readdirSync(STATUS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
let fed = 0;
const adapters: FileStatusAdapter[] = [];

for (const id of cfg.agents.map((a) => a.id)) {
  const file = join(STATUS_DIR, `${id}.json`);
  const adapter = new FileStatusAdapter({
    agentId: id,
    statusPath: file,
    readText: async (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  });
  adapters.push(adapter);
  const u = await adapter.readOnce();
  if (u) {
    store.applyUpdate(u);
    fed++;
  }
}

const stage = store.getStage();
const all = store.getAllRuntimes();

console.log(`读了 ${fed}/${cfg.agents.length} 个状态文件（目录里共 ${files.length} 个 json）\n`);
console.log('全部 agent：');
for (const r of all) {
  const flag = r.attention === 'attention' ? '等人工' : '';
  console.log(
    `  ${r.agentId.padEnd(16)} ${r.status.padEnd(12)} ${flag.padEnd(7)} ` +
      `since=${r.attentionSince ?? '-'}  ${r.summary.slice(0, 40)}`,
  );
}
console.log('\n舞台（按紧急度排序）：', stage.onStageIds);
console.log('坐席高亮（含没挤上舞台的）：', stage.seatHighlightIds);
console.log('在等人数：', stage.waitingCount);

// —— 核心回归：状态真正变化才离开注意力；同状态重放不能重置等待起点 ——
const target = 'e2e-waiting';
store.applyUpdate({ agentId: target, status: 'needs_auth', summary: '需要重新登录' });
if (!store.getAgents().some((a) => a.id === target)) {
  store.setRoster([
    ...cfg.agents,
    {
      id: target, name: 'E2E', adapterType: 'file', enabled: true,
      seatIndex: cfg.agents.length, characterId: 'default', createdAt: '',
    },
  ]);
  store.applyUpdate({ agentId: target, status: 'needs_auth', summary: '需要重新登录' });
}
console.log('\n注入一个等待中的 agent → 舞台：', store.getStage().onStageIds);
{
  const before = store.getRuntime(target)!;
  // 模拟 poller 每 2 秒重写同状态（summary 带秒数，与真实 poller 一致）
  for (let i = 0; i < 5; i++) {
    store.applyUpdate({
      agentId: target,
      status: before.status,
      summary: `${before.summary}（重放 ${i}）`,
    });
  }
  const afterReplay = store.getRuntime(target)!;
  if (afterReplay.attentionSince !== before.attentionSince) {
    console.error('❌ 失败：同状态重放重置了等待起点');
    process.exit(1);
  }
  if (!store.getStage().seatHighlightIds.includes(target)) {
    console.error('❌ 失败：仍在等你的 agent 从坐席高亮消失了');
    process.exit(1);
  }
}

console.log('\n✅ 端到端通过');
