/**
 * 验收标准：只测"谁需要人"这一件事。
 *
 * 四条不变量（产品目标的第一性原理）：
 *   I1 不能漏   —— 需要人时必须出现在注意力里（舞台或坐席高亮）
 *   I2 不能假   —— 不需要人、或证据不足时，不能占注意力
 *   I3 不能自己消失 —— 舞台超时让位，但坐席一直亮着
 *   I4 一眼可判 —— 更急的排前面，且能看到等了多久
 *
 * 这些测试是重构的唯一验收门槛。UI 与素材不在测试范围内。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRuntime,
  projectStage,
  MAX_ON_STAGE,
  MIN_STAGE_DWELL_MS,
  MIN_STAGE_SETTLE_MS,
} from '../src/stage/rules';
import { RuntimeStore } from '../src/store/runtimeStore';
import type { AgentRuntimeState } from '../src/domain/updates';
import { parseStatusSnapshot } from '../src/adapters/types';
import { attentionForStatus } from '../src/domain/status';
import { analyzeCodexRollout } from '../scripts/lib/codexRollout.mjs';
import {
  clampSeStagePercent,
  motionSrcFor,
  normalStageMotionChoices,
  pickRandomNormalStageMotion,
  pickRandomSeStageMotion,
  pickRandomStageMotion,
  seMotionSrcFor,
  shouldUseSeStage,
  seStageMotionChoices,
  stageMotionChoices,
} from '../src/components/motion';
import { mergeWithDefaults } from '../src/config/persist';
import { defaultConfig } from '../src/config/types';

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function raise(
  prev: AgentRuntimeState | undefined,
  status: string,
  opts: { sec?: number; confidence?: 'certain' | 'weak'; summary?: string; observedAt?: Date } = {},
) {
  return deriveRuntime({
    prev,
    agentId: 'a',
    status,
    summary: opts.summary ?? status,
    confidence: opts.confidence,
    now: opts.observedAt ?? at(opts.sec ?? 0),
  });
}

/** I1：attention 一定进注意力集合 */
test('I1 需要人时不漏：needs_input 上舞台且坐席高亮', () => {
  const rt = raise(undefined, 'needs_input');
  const { stage } = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
  assert.equal(rt.attention, 'attention');
  assert.deepEqual(stage.onStageIds, ['a']);
  assert.deepEqual(stage.seatHighlightIds, ['a']);
  assert.equal(stage.showDashboard, false);
});

test('I1 超员也不漏：第 3 个仍保留坐席高亮', () => {
  const m = new Map<string, AgentRuntimeState>();
  for (const id of ['x', 'y', 'z']) {
    const rt = deriveRuntime({ agentId: id, status: 'needs_input', summary: id, now: T0 });
    m.set(id, rt);
  }
  const { stage } = projectStage(m, MAX_ON_STAGE, [], 60_000, at(0).getTime());
  assert.equal(stage.onStageIds.length, MAX_ON_STAGE);
  assert.equal(stage.seatHighlightIds.length, 3, '三个都要亮，不能被舞台名额吃掉');
});

/** I2：不确定、不认识的东西不能抢注意力 */
test('I2 弱证据不上舞台也不呼吸（只保留原始状态）', () => {
  const rt = raise(undefined, 'done', { confidence: 'weak' });
  const { stage } = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
  assert.equal(rt.attention, 'silent', '弱证据按 silent 处理，不能进 attention 统计');
  assert.deepEqual(stage.onStageIds, []);
  assert.deepEqual(stage.seatHighlightIds, []);
});

test('I2 未知状态不抢注意力（vendor 写 busy/working 不能上台）', () => {
  for (const s of ['busy', 'working', 'Running', 'weird']) {
    assert.equal(attentionForStatus(s), 'silent', `${s} 应为 silent`);
    const rt = raise(undefined, s);
    const { stage } = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
    assert.deepEqual(stage.onStageIds, [], `${s} 不能上台`);
  }
});

/** I3：不会自己消失 */
test('I3 一件没处理的事，几小时后仍然在等你（只是让出了舞台）', () => {
  let rt = raise(undefined, 'needs_auth', { sec: 0 });
  const later = deriveRuntime({
    prev: rt,
    agentId: 'a',
    status: 'needs_auth',
    summary: 'still waiting',
    now: at(3600),
  });
  const { stage } = projectStage(
    new Map([[later.agentId, later]]), MAX_ON_STAGE, [], 60_000, at(3600).getTime(),
  );
  // 舞台让出去了
  assert.deepEqual(stage.onStageIds, []);
  // 但这件事没被忘掉：仍然高亮、仍然算在等待里
  assert.deepEqual(stage.seatHighlightIds, ['a'], '一小时后仍然高亮');
  assert.equal(stage.waitingCount, 1, '一直算在等你的人数里');
});

test('I3 重复同状态不会重置等待起点；10 分钟后让出舞台但仍在等你', () => {
  let rt = raise(undefined, 'needs_input', { sec: 0 });
  for (let s = 2; s < 600; s += 2) {
    rt = deriveRuntime({
      prev: rt,
      agentId: 'a',
      status: 'needs_input',
      summary: `回合 ${s}s`, // 轮询器习惯：summary 带秒数
      now: at(s),
    });
  }
  assert.equal(rt.attentionSince, T0.toISOString(), '等待起点必须保持首次时间');
  const { stage } = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(600).getTime());
  assert.deepEqual(stage.onStageIds, [], '10 分钟后让出舞台');
  assert.deepEqual(stage.seatHighlightIds, ['a'], '但仍在坐席上亮着');
  assert.equal(stage.waitingCount, 1, '仍算在等你');
});

test('I3 不会因为轮询重放而"闪 1 秒"（既有 bug 的回归用例）', () => {
  // 旧实现：超时下台后，同状态再进来会先上台、下一 tick 又被踢下，看起来闪一下。
  // 现在：让位之后同状态重放不会重新上台，也不会从高亮里掉出来。
  let rt = raise(undefined, 'done', { sec: 0 });
  rt = deriveRuntime({ prev: rt, agentId: 'a', status: 'done', summary: '完成 61s', now: at(61) });
  const t61 = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(61).getTime());
  assert.deepEqual(t61.stage.onStageIds, [], '已经等了 61 秒，让出舞台');
  assert.deepEqual(t61.stage.seatHighlightIds, ['a'], '但仍然高亮');

  // 轮询再来一条同状态
  rt = deriveRuntime({ prev: rt, agentId: 'a', status: 'done', summary: '完成 62s', now: at(62) });
  const t62 = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(62).getTime());
  assert.deepEqual(t62.stage.onStageIds, [], '不会因为重放而短暂回到舞台');
  assert.deepEqual(t62.stage.seatHighlightIds, ['a'], '也不会掉出高亮');
});

test('I3 状态真的变安静时才离开（不是靠计时器）', () => {
  let rt = raise(undefined, 'needs_input', { sec: 0 });
  rt = deriveRuntime({ prev: rt, agentId: 'a', status: 'running', summary: '继续干活', now: at(5) });
  const { stage } = projectStage(new Map([[rt.agentId, rt]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
  assert.deepEqual(stage.onStageIds, []);
  assert.equal(rt.seatHighlight, false);
  assert.equal(rt.attentionSince, null);
});

/** I4：排序与等待时长 */
test('I4 更急的排前面：needs_auth 优先于 done', () => {
  const m = new Map<string, AgentRuntimeState>();
  m.set('d', deriveRuntime({ agentId: 'd', status: 'done', summary: 'd', now: at(0) }));
  m.set('auth', deriveRuntime({ agentId: 'auth', status: 'needs_auth', summary: 'a', now: at(10) }));
  const { stage } = projectStage(m, 1, [], 60_000, at(10).getTime());
  assert.deepEqual(stage.onStageIds, ['auth'], '等授权比待审更急');
});

test('I4 同级按等待时间：先等的人排前面', () => {
  const m = new Map<string, AgentRuntimeState>();
  m.set('late', deriveRuntime({ agentId: 'late', status: 'needs_input', summary: 'l', now: at(60) }));
  m.set('early', deriveRuntime({ agentId: 'early', status: 'needs_input', summary: 'e', now: at(10) }));
  const { stage } = projectStage(m, 1, [], 60_000, at(10).getTime());
  assert.deepEqual(stage.onStageIds, ['early']);
});

test('I4 没见过的时间戳不能用（过期 observedAt 不能立刻被判走了很久）', () => {
  const stale = new Date(T0.getTime() - 3 * 3600_000);
  const rt = deriveRuntime({
    agentId: 'a',
    status: 'done',
    summary: 'x',
    now: T0,
    observedAt: stale,
  } as never);
  assert.equal(rt.attentionSince, T0.toISOString(), '过期时间戳应视为"刚刚看到"');
});

/** 数据入口：坏数据不能进到渲染层 */
test('坏 observedAt 在解析阶段就被拒绝', () => {
  for (const bad of ['not-a-date', '2026-13-45T99:99:99Z', '1792995031679']) {
    const text = JSON.stringify({
      schemaVersion: 1,
      agentId: 'x',
      status: 'done',
      summary: 's',
      observedAt: bad,
    });
    assert.equal(parseStatusSnapshot(text), null, `observedAt=${bad} 应被拒绝`);
  }
});

test('合法 observedAt 正常通过', () => {
  const text = JSON.stringify({
    schemaVersion: 1,
    agentId: 'x',
    status: 'done',
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(parseStatusSnapshot(text)?.status, 'done');
});

test('状态真的变安静时才离开注意力', () => {
  let rt = raise(undefined, 'needs_input', { sec: 0 });
  rt = deriveRuntime({ prev: rt, agentId: 'a', status: 'running', summary: '继续干活', now: at(30) });
  assert.equal(rt.attention, 'silent');
  assert.equal(rt.seatHighlight, false);
  assert.equal(rt.attentionSince, null);
});

test('数据源心跳过期：轮询源应被视为失联，事件源不应被时间误判', async () => {
  const { FileStatusAdapter } = await import('../src/adapters/file');
  const stale = new FileStatusAdapter({
    agentId: 'a',
    statusUrl: '/status/a.json',
    readText: async () =>
      JSON.stringify({
        schemaVersion: 1,
        agentId: 'a',
        status: 'done',
        summary: 'old',
        observedAt: '2026-01-01T00:00:00.000Z',
        checkedAt: '2026-01-01T00:00:00.000Z',
      }),
    staleAfterMs: 10_000,
  });
  const staleUpdate = await stale.readOnce();
  assert.equal(staleUpdate?.status, 'offline', '轮询源失联必须降级为 offline');
  assert.equal(staleUpdate?.polled, true);

  const hook = new FileStatusAdapter({
    agentId: 'b',
    statusUrl: '/status/b.json',
    readText: async () =>
      JSON.stringify({
        schemaVersion: 1,
        agentId: 'b',
        status: 'needs_input',
        summary: 'hook event',
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
  });
  const hookUpdate = await hook.readOnce();
  assert.equal(hookUpdate?.status, 'needs_input', '没有心跳的事件源不能按时间判死');
  assert.equal(hookUpdate?.polled, false);
});

test('禁用 agent 不再占舞台、不计入看板', () => {
  const store = new RuntimeStore();
  const agents = [
    { id: 'on', name: 'On', adapterType: 'file', enabled: true, seatIndex: 0, characterId: 'd', createdAt: '' },
    { id: 'off', name: 'Off', adapterType: 'file', enabled: true, seatIndex: 1, characterId: 'd', createdAt: '' },
  ] as never;
  store.setRoster(agents);
  store.applyUpdate({ agentId: 'off', status: 'needs_auth', summary: 'x' });
  assert.deepEqual(store.getStage().onStageIds, ['off']);
  store.setRoster(
    [
      { id: 'on', name: 'On', adapterType: 'file', enabled: true, seatIndex: 0, characterId: 'd', createdAt: '' },
      { id: 'off', name: 'Off', adapterType: 'file', enabled: false, seatIndex: 1, characterId: 'd', createdAt: '' },
    ] as never,
  );
  assert.deepEqual(store.getStage().onStageIds, [], '禁用后必须让出舞台');
  assert.equal(store.getAllRuntimes().length, 1, '看板只统计启用中的');
});

/**
 * 时间解析：必须区分"日志里的墙上时间"和"真 UTC ISO"。
 * 旧实现先替换空格再判断，导致本机时间被当 UTC 解析，
 * 在 UTC+8 上得到 -8 小时的负年龄，于是"刚刚还在动"被永久判成 running。
 */
test('本机墙上时间与 UTC ISO 都解析成"刚刚"', async () => {
  const { parseLogAgeMs } = await import('../src/adapters/logTime');
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const wall = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  for (const input of [wall, now.toISOString()]) {
    const age = parseLogAgeMs(input);
    assert.notEqual(age, null, `${input} 应可解析`);
    assert.ok(age! < 5_000, `${input} 应解析为刚刚，实际 ${age}ms`);
  }
});

test('未来的时间戳返回 null，而不是负年龄', async () => {
  const { parseLogAgeMs } = await import('../src/adapters/logTime');
  const future = new Date(Date.now() + 8 * 3600_000).toISOString();
  assert.equal(parseLogAgeMs(future), null, '未来时间必须拒绝，不能当成"很忙"');
});

test('裸 T 时间按 UTC，不按本机墙上时间', async () => {
  const { parseLogAgeMs } = await import('../src/adapters/logTime');
  const now = Date.now();
  const iso = new Date(now - 60_000).toISOString().replace('Z', '');
  const age = parseLogAgeMs(iso, now);
  assert.notEqual(age, null, '裸 T 应可解析');
  assert.ok(Math.abs(age! - 60_000) < 5_000, `应约等于 60s，实际 ${age}ms`);
});

/** 舞台是稀缺资源：占太久要让位给新来的，但信息不能丢 */
test('I3 占满 60 秒后让出舞台，但坐席仍然高亮', () => {
  const m = new Map<string, AgentRuntimeState>();
  const r = deriveRuntime({ agentId: 'a', status: 'needs_input', summary: 'x', now: T0 });
  m.set('a', r);

  // 30 秒时还在台上
  const t30 = projectStage(m, 2, [], 60_000, T0.getTime() + 30_000);
  assert.deepEqual(t30.stage.onStageIds, ['a']);

  // 61 秒后让出舞台
  const t61 = projectStage(m, 2, [], 60_000, T0.getTime() + 61_000);
  assert.deepEqual(t61.stage.onStageIds, [], '超时后不再占舞台');
  assert.deepEqual(t61.stage.seatHighlightIds, ['a'], '但必须仍然高亮');
  assert.deepEqual(t61.stage.timedOutIds, ['a'], '标记为超时让位');
  assert.equal(t61.stage.waitingCount, 1, '仍在等待统计里，没被丢掉');
});

test('I3 让位之后，新来的 attention 能拿到舞台', () => {
  const m = new Map<string, AgentRuntimeState>();
  m.set('old', deriveRuntime({ agentId: 'old', status: 'needs_input', summary: 'o', now: T0 }));
  // 61 秒后来了一个新人
  const fresh = deriveRuntime({ agentId: 'new', status: 'error', summary: 'n', now: at(61) });
  m.set('new', fresh);
  const p = projectStage(m, 2, [], 60_000, at(61).getTime());
  assert.deepEqual(p.stage.onStageIds, ['new'], '新人上台，老人让位');
  assert.deepEqual(p.stage.seatHighlightIds.sort(), ['new', 'old'], '两个都还亮着');
});

test('上台不会闪：2 秒就解除的告警仍完整播完一轮收尾', () => {
  const first = deriveRuntime({ agentId: 'a', status: 'needs_input', summary: '审批', now: at(0) });
  const p0 = projectStage(new Map([['a', first]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
  const onStage = p0.runtimes.get('a')!;
  assert.deepEqual(p0.stage.onStageIds, ['a']);
  assert.ok(onStage.stageEnteredAt);

  const cleared = deriveRuntime({
    prev: onStage,
    agentId: 'a',
    status: 'running',
    summary: '继续干活',
    now: at(2),
  });
  assert.equal(cleared.attention, 'silent', '真实状态已解除，不能再算需要人');
  assert.equal(cleared.seatHighlight, false);

  const p2 = projectStage(new Map([['a', cleared]]), MAX_ON_STAGE, [], 60_000, at(2).getTime());
  assert.deepEqual(p2.stage.onStageIds, ['a'], '动画不能只闪 2 秒');
  assert.deepEqual(p2.stage.settlingIds, ['a'], '标记为纯视觉收尾');
  assert.equal(p2.stage.waitingCount, 0, '收尾不能伪造“在等你”');
  assert.deepEqual(p2.stage.seatHighlightIds, []);

  const p9 = projectStage(
    new Map([['a', cleared]]), MAX_ON_STAGE, [], 60_000, at(0).getTime() + MIN_STAGE_SETTLE_MS - 1,
  );
  assert.deepEqual(p9.stage.onStageIds, ['a'], '收尾窗口内继续显示');

  const p10 = projectStage(
    new Map([['a', cleared]]), MAX_ON_STAGE, [], 60_000, at(0).getTime() + MIN_STAGE_SETTLE_MS + 1,
  );
  assert.deepEqual(p10.stage.onStageIds, [], '一轮播完后准时撤下');
  assert.deepEqual(p10.stage.settlingIds, []);
});

test('上台不会闪：即使超时设得很短，也不能砍断入场动画', () => {
  const first = deriveRuntime({ agentId: 'a', status: 'needs_input', summary: '审批', now: at(0) });
  const p0 = projectStage(new Map([['a', first]]), MAX_ON_STAGE, [], 5_000, at(0).getTime());
  const onStage = p0.runtimes.get('a')!;

  const p5 = projectStage(new Map([['a', onStage]]), MAX_ON_STAGE, [], 5_000, at(5).getTime());
  assert.deepEqual(p5.stage.onStageIds, ['a'], '5 秒超时也不能早于一轮动画');
  assert.deepEqual(p5.stage.protectedIds, ['a']);

  const pAfter = projectStage(
    new Map([['a', p5.runtimes.get('a')!]]),
    MAX_ON_STAGE,
    [],
    5_000,
    at(0).getTime() + MIN_STAGE_DWELL_MS + 1,
  );
  assert.deepEqual(pAfter.stage.onStageIds, [], '保护期过后按原超时规则让位');
  assert.deepEqual(pAfter.stage.seatHighlightIds, ['a'], '让位后坐席仍然高亮');
});

test('上台不会闪：保护期内来了新告警，先播完当前这一轮', () => {
  const first = deriveRuntime({ agentId: 'old', status: 'needs_input', summary: '旧', now: at(0) });
  const p0 = projectStage(new Map([['old', first]]), 1, [], 60_000, at(0).getTime());
  const oldOnStage = p0.runtimes.get('old')!;

  const fresh = deriveRuntime({ agentId: 'new', status: 'needs_auth', summary: '新', now: at(2) });
  const p2 = projectStage(
    new Map([['old', oldOnStage], ['new', fresh]]),
    1,
    [],
    60_000,
    at(2).getTime(),
  );
  assert.deepEqual(p2.stage.onStageIds, ['old'], '当前入场不被新告警截断');
  assert.deepEqual(p2.stage.seatHighlightIds.sort(), ['new', 'old'], '新告警仍要立刻高亮');
  assert.equal(p2.stage.waitingCount, 2);

  const pAfter = projectStage(
    p2.runtimes,
    1,
    [],
    60_000,
    at(0).getTime() + MIN_STAGE_DWELL_MS + 1,
  );
  assert.deepEqual(pAfter.stage.onStageIds, ['new'], '保护期结束后让位给更急的新告警');
  assert.deepEqual(pAfter.stage.seatHighlightIds.sort(), ['new', 'old']);
});

test('一次入场只抽一次动画：状态在 attention 内部变化不 remount，真正离场后才重置', () => {
  const first = deriveRuntime({ agentId: 'a', status: 'done', summary: '待审', now: at(0) });
  const p0 = projectStage(new Map([['a', first]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
  const entered = p0.runtimes.get('a')!;

  const escalated = deriveRuntime({
    prev: entered,
    agentId: 'a',
    status: 'needs_auth',
    summary: '要登录',
    now: at(2),
  });
  assert.equal(escalated.attentionEnteredAt, entered.attentionEnteredAt, '同一轮等待不重新抽签');
  assert.notEqual(escalated.stageSince, entered.stageSince, '超时计时按新状态重算');

  const cleared = deriveRuntime({
    prev: { ...escalated, onStage: true, stageEnteredAt: at(0).toISOString() },
    agentId: 'a',
    status: 'idle',
    summary: '空闲',
    now: at(3),
  });
  const settleEnd = new Date(at(0).getTime() + MIN_STAGE_SETTLE_MS + 2);
  const afterSettle = deriveRuntime({
    prev: cleared,
    agentId: 'a',
    status: 'idle',
    summary: '空闲',
    now: settleEnd,
  });
  assert.equal(afterSettle.attentionEnteredAt, null, '真正离场后清掉出场标识');
  assert.equal(afterSettle.stageEnteredAt, null);
});

test('超时下台后重新上台算新的一次入场，会重新抽动画', () => {
  const first = deriveRuntime({ agentId: 'a', status: 'needs_input', summary: '等', now: at(0) });
  const p0 = projectStage(new Map([['a', first]]), MAX_ON_STAGE, [], 60_000, at(0).getTime());
  const firstEntry = p0.runtimes.get('a')!;

  const offStage = projectStage(
    new Map([['a', firstEntry]]), MAX_ON_STAGE, [], 60_000, at(61).getTime(),
  ).runtimes.get('a')!;
  assert.equal(offStage.onStage, false);
  assert.equal(offStage.stageEnteredAt, null, '下台后清掉入场标识');

  const fresh = deriveRuntime({
    prev: offStage,
    agentId: 'a',
    status: 'error',
    summary: '新告警',
    now: at(62),
  });
  const p62 = projectStage(new Map([['a', fresh]]), MAX_ON_STAGE, [], 60_000, at(62).getTime());
  const secondEntry = p62.runtimes.get('a')!;
  assert.equal(secondEntry.onStage, true);
  assert.ok(secondEntry.stageEnteredAt);
  assert.notEqual(secondEntry.stageEnteredAt, firstEntry.stageEnteredAt, '新一轮应重新入场');
});

/** Codex 真实审批：悬空的升级调用必须在结果回来前被识别为“等人” */
function codexLine(obj: unknown) {
  return JSON.stringify(obj);
}

const CODEX_TURN = 'turn-1';
const CODEX_CALL = 'call_approval_1';

function codexRolloutLines() {
  return [
    codexLine({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: CODEX_TURN },
    }),
    codexLine({
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: CODEX_CALL,
        arguments: JSON.stringify({
          cmd: 'pnpm test',
          sandbox_permissions: 'require_escalated',
          justification: '允许跑测试？',
        }),
        internal_chat_message_metadata_passthrough: { turn_id: CODEX_TURN },
      },
    }),
  ];
}

test('Codex 审批未返回：识别为 needs_input，等待起点取调用写入时间', () => {
  const now = Date.parse('2026-01-01T00:00:11.000Z');
  const { pending, openTurns } = analyzeCodexRollout(codexRolloutLines().join('\n'), { now });
  assert.equal(openTurns.length, 1, '回合仍是打开状态');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.callId, CODEX_CALL);
  assert.equal(pending[0]!.kind, 'approval');
  assert.equal(pending[0]!.ageMs, 10_000);
});

test('Codex 审批已有输出：不再算等人', () => {
  const text = [
    ...codexRolloutLines(),
    codexLine({
      timestamp: '2026-01-01T00:00:12.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: CODEX_CALL, output: 'ok' },
    }),
  ].join('\n');
  const { pending } = analyzeCodexRollout(text, { now: Date.parse('2026-01-01T00:00:13.000Z') });
  assert.deepEqual(pending, []);
});

test('Codex 自动批准后已开始执行：item_completed 也能解除', () => {
  const text = [
    ...codexRolloutLines(),
    codexLine({
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', id: CODEX_CALL, status: 'completed' },
      },
    }),
  ].join('\n');
  const { pending } = analyzeCodexRollout(text, { now: Date.parse('2026-01-01T00:00:13.000Z') });
  assert.deepEqual(pending, []);
});

test('Codex 回合已结束：旧审批不再长期占注意力', () => {
  const text = [
    ...codexRolloutLines(),
    codexLine({
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: CODEX_TURN },
    }),
  ].join('\n');
  const { pending, openTurns } = analyzeCodexRollout(text, {
    now: Date.parse('2026-01-01T00:00:13.000Z'),
  });
  assert.deepEqual(pending, [], '已结束的回合不能留下僵尸审批');
  assert.deepEqual(openTurns, []);
});

test('Codex 普通命令不误报审批（use_default 不是升级）', () => {
  const text = codexLine({
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_normal',
      arguments: JSON.stringify({ cmd: 'ls', sandbox_permissions: 'use_default' }),
    },
  });
  const { pending } = analyzeCodexRollout(text, { now: Date.parse('2026-01-01T00:00:13.000Z') });
  assert.deepEqual(pending, []);
});

test('Codex 提问工具（request_user_input）也算等人', () => {
  const text = codexLine({
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'call_question',
      arguments: JSON.stringify({ question: '选哪个？' }),
    },
  });
  const { pending } = analyzeCodexRollout(text, { now: Date.parse('2026-01-01T00:00:13.000Z') });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, 'question');
});

test('Codex MCP 命名的提问工具也算等人', () => {
  const text = codexLine({
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'mcp__codex_app__request_user_input',
      call_id: 'call_mcp_question',
      arguments: JSON.stringify({ question: '选哪个？' }),
    },
  });
  const { pending } = analyzeCodexRollout(text, { now: Date.parse('2026-01-01T00:00:13.000Z') });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, 'question');
});

test('Codex 非 shell 工具即使参数里带 require_escalated 也不误报', () => {
  const text = codexLine({
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'apply_patch',
      call_id: 'call_patch',
      arguments: JSON.stringify({ patch: 'x', sandbox_permissions: 'require_escalated' }),
    },
  });
  const { pending } = analyzeCodexRollout(text, { now: Date.parse('2026-01-01T00:00:13.000Z') });
  assert.deepEqual(pending, [], '只有已知 shell 工具能触发审批提醒');
});

/** 舞台美色版：按概率抽中，坐席不受影响，缺失素材回退普通版 */
test('美色版概率：0 永不抽中，100 必中，中间值按百分比判定', () => {
  assert.equal(shouldUseSeStage(0, 0), false);
  assert.equal(shouldUseSeStage(0, 99.999), false);
  assert.equal(shouldUseSeStage(100, 0), true);
  assert.equal(shouldUseSeStage(100, 99.999), true);
  assert.equal(shouldUseSeStage(30, 29.999), true);
  assert.equal(shouldUseSeStage(30, 30), false);
  assert.equal(clampSeStagePercent(-5), 0);
  assert.equal(clampSeStagePercent(140), 100);
  assert.equal(clampSeStagePercent(Number.NaN), 0);
});

test('美色版概率：抽签分布符合设置，不会永远只出一种', () => {
  let hits = 0;
  for (let i = 0; i < 10_000; i++) {
    if (shouldUseSeStage(37, i / 100)) hits++;
  }
  assert.equal(hits, 3_700, '37% 应正好覆盖 0–36.99 的抽签区间');
});

test('美色版素材路径只由舞台静图推导，坐席动画保持普通版', () => {
  const stageAsset = '/characters/codex/stage.png';
  assert.equal(motionSrcFor(stageAsset, 'running', 'stage'), '/characters/codex/stage-motion.webm');
  assert.equal(seMotionSrcFor(stageAsset), '/characters/codex/se.stage-motion.webm');
  assert.equal(
    motionSrcFor('/characters/codex/portrait.png', 'running', 'seat'),
    '/characters/codex/portrait-motion.webm',
    '坐席只走 portrait-motion，不参与美色版抽签',
  );
  assert.equal(motionSrcFor(stageAsset, 'offline', 'stage'), null, '下线不播动画');
  assert.equal(seMotionSrcFor(null), null);
});

test('美色版概率配置：缺失时默认 0，越界值被夹到 0–100', () => {
  assert.equal(mergeWithDefaults({}).seStageChancePercent, 0, '老配置升级后默认关闭');
  assert.equal(mergeWithDefaults({ seStageChancePercent: 45 }).seStageChancePercent, 45);
  assert.equal(mergeWithDefaults({ seStageChancePercent: -20 }).seStageChancePercent, 0);
  assert.equal(mergeWithDefaults({ seStageChancePercent: 999 }).seStageChancePercent, 100);
  assert.equal(mergeWithDefaults({ seStageChancePercent: 'abc' }).seStageChancePercent, 0);
});

test('随机上台：10 个 Agent × 2 版动画，共 20 个候选且不重复', () => {
  const cfg = defaultConfig();
  const characters = new Map(cfg.characters.map((c) => [c.id, c]));
  const choices = stageMotionChoices(cfg.agents, characters);
  assert.equal(cfg.agents.length, 10);
  assert.equal(choices.length, 20);

  const clips = new Set(choices.map((c) => c.motionSrc));
  assert.equal(clips.size, 20, '每个动画文件只出现一次');
  for (const choice of choices) {
    assert.ok(
      choice.motionSrc.endsWith(
        choice.flavor === 'se' ? '/se.stage-motion.webm' : '/stage-motion.webm',
      ),
      `${choice.motionSrc} 与 ${choice.flavor} 版本不符`,
    );
  }
});

test('随机上台：抽签覆盖全部 20 个候选，边界不会越界', () => {
  const cfg = defaultConfig();
  const characters = new Map(cfg.characters.map((c) => [c.id, c]));

  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const choice = pickRandomStageMotion(cfg.agents, characters, () => i / 20);
    assert.ok(choice);
    seen.add(choice.motionSrc);
  }
  assert.equal(seen.size, 20, '每个候选都有抽中的区间');

  const low = pickRandomStageMotion(cfg.agents, characters, () => 0);
  const high = pickRandomStageMotion(cfg.agents, characters, () => 1);
  const bad = pickRandomStageMotion(cfg.agents, characters, () => Number.NaN);
  assert.equal(low?.motionSrc, stageMotionChoices(cfg.agents, characters)[0]!.motionSrc);
  assert.equal(high?.motionSrc, stageMotionChoices(cfg.agents, characters)[19]!.motionSrc);
  assert.equal(bad?.motionSrc, low?.motionSrc, '非法随机值退回第一个候选');
});

test('上台：只从 10 个常规版动画中随机选 1 个', () => {
  const cfg = defaultConfig();
  const characters = new Map(cfg.characters.map((c) => [c.id, c]));
  const choices = normalStageMotionChoices(cfg.agents, characters);
  assert.equal(choices.length, 10);
  assert.ok(choices.every((choice) => choice.flavor === 'normal'));

  const seen = new Set<string>();
  for (let i = 0; i < choices.length; i++) {
    const choice = pickRandomNormalStageMotion(cfg.agents, characters, () => i / choices.length);
    assert.ok(choice);
    assert.equal(choice.flavor, 'normal');
    seen.add(choice.motionSrc);
  }
  assert.equal(seen.size, 10, '每个常规版候选都有抽中的区间');
});

test('随机按钮：只从美色版动画中随机选 1 个', () => {
  const cfg = defaultConfig();
  const characters = new Map(cfg.characters.map((c) => [c.id, c]));
  const choices = seStageMotionChoices(cfg.agents, characters);
  assert.equal(choices.length, 10);
  assert.ok(choices.every((choice) => choice.flavor === 'se'));

  const seen = new Set<string>();
  for (let i = 0; i < choices.length; i++) {
    const choice = pickRandomSeStageMotion(cfg.agents, characters, () => i / choices.length);
    assert.ok(choice);
    assert.equal(choice.flavor, 'se');
    assert.ok(choice.motionSrc.endsWith('/se.stage-motion.webm'));
    seen.add(choice.motionSrc);
  }
  assert.equal(seen.size, 10, '每个美色版候选都有抽中的区间');
});

test('随机上台：禁用 Agent 仍可预览，但缺角色/素材的会跳过', () => {
  const cfg = defaultConfig();
  const characters = new Map(cfg.characters.map((c) => [c.id, c]));
  const agents = cfg.agents.map((a, i) => (i === 0 ? { ...a, enabled: false } : a));
  const choices = stageMotionChoices(agents, characters);
  assert.equal(choices.length, 20, '预览按名单抽，不受启用开关影响');

  const withoutCharacter = agents.slice(1);
  assert.equal(stageMotionChoices(withoutCharacter, new Map()).length, 0);
  assert.equal(pickRandomStageMotion([], characters), null);
});
