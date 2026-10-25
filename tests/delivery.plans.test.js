import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createClientStore } from '../server/delivery/clients.js';
import { createPlanStore, pickPracticeMatch } from '../server/delivery/plans.js';

beforeEach(() => resetDb());

const db = getDb();
const clients = createClientStore({ db });
const plans = createPlanStore({ db });

const PAYLOAD = {
  diagnosis: { core_belief: '我不能停下来', pattern: '一直加班', root_cause: '怕被评价' },
  vision: { title: '有边界的忙碌', narrative: '你可以在停下来时仍然是值得被喜欢的人。', horizon: '1_year' },
  practices: [
    { day: 1, title: '午休离开工位', intent: '验证停下来不会出事', action: '今天午休离开工位十分钟', evidence_prompt: '离开工位的时候在想什么？', success_criteria: '离开满十分钟' },
    { day: 2, title: '关掉一个通知', intent: '验证不是所有消息都要立刻回', action: '关掉一个工作群的免打扰', evidence_prompt: '关掉之后最怕发生什么？', success_criteria: '保持关闭一小时' },
  ],
  worth_practicing: true,
};

function seedClient() {
  return clients.create({ display_name: '客户甲' });
}

test('建草稿：状态是 draft，payload 原样存 JSON', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  assert.equal(plan.status, 'draft');
  assert.equal(plan.version, 1);
  assert.deepEqual(JSON.parse(plan.payload).vision.title, '有边界的忙碌');
});

test('建草稿：物化出两条练习项，字段完整', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  const practices = plans.listPractices(plan.id);
  assert.equal(practices.length, 2);
  assert.equal(practices[0].title, '午休离开工位');
  assert.equal(practices[0].sort_order, 0);
  assert.equal(practices[1].day, 2);
});

test('物化：按 title 匹配，重复保存不新建行、id 不变', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  const before = plans.listPractices(plan.id);
  const changed = { ...PAYLOAD, practices: [{ ...PAYLOAD.practices[0], action: '改成走楼梯' }, PAYLOAD.practices[1]] };
  plans.updatePayload(plan.id, changed);
  const after = plans.listPractices(plan.id);
  assert.equal(after.length, 2);
  assert.equal(after[0].id, before[0].id, 'id 必须保留 —— 证据挂在这个 id 上');
  assert.equal(after[0].action, '改成走楼梯');
});

test('物化：教练手工填的 custom_data 不被 AI 草稿冲掉', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  plans.updatePractice(plan.id, plans.listPractices(plan.id)[0].id, { custom_data: '他午休习惯去天台' });
  plans.updatePayload(plan.id, { ...PAYLOAD, practices: [{ ...PAYLOAD.practices[0], action: '新动作' }, PAYLOAD.practices[1]] });
  const p = plans.listPractices(plan.id)[0];
  assert.equal(p.custom_data, '他午休习惯去天台');
});

test('物化：payload 里删掉的练习项不删行，只标记 sort_order = -1', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  const removedId = plans.listPractices(plan.id)[1].id;
  plans.updatePayload(plan.id, { ...PAYLOAD, practices: [PAYLOAD.practices[0]] });
  const row = db.prepare('SELECT * FROM practices WHERE id = ?').get(removedId);
  assert.ok(row, '行不能被删 —— 删了它的证据会变孤儿');
  assert.equal(row.sort_order, -1);
});

test('发布：draft → pending_activation，published_at 被记上', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  const published = plans.publish(plan.id);
  assert.equal(published.status, 'pending_activation');
  assert.ok(published.published_at);
});

test('发布：已发布的方案不能再发布一次', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  plans.publish(plan.id);
  assert.throws(() => plans.publish(plan.id), /pending_activation/);
});

test('激活：pending_activation → active', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  plans.publish(plan.id);
  const active = plans.activate(plan.id);
  assert.equal(active.status, 'active');
  assert.ok(active.activated_at);
});

test('证据：回填一条，挂在练习项上', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  const practice = plans.listPractices(plan.id)[0];
  const ev = plans.addEvidence({ practiceId: practice.id, clientId: c.id, content: '今天走了十分钟，很安静' });
  assert.ok(ev.id);
  assert.equal(plans.listEvidences(plan.id).length, 1);
});

test('证据：content 为空拒绝写入', () => {
  const c = seedClient();
  const plan = plans.createDraft({ clientId: c.id, payload: PAYLOAD });
  const practice = plans.listPractices(plan.id)[0];
  assert.throws(() => plans.addEvidence({ practiceId: practice.id, clientId: c.id, content: '   ' }), /content/);
});

test('worth_practicing 为 false 的方案：没有练习项', () => {
  const c = seedClient();
  const plan = plans.createDraft({
    clientId: c.id,
    payload: { ...PAYLOAD, worth_practicing: false, practices: [] },
  });
  assert.equal(plans.listPractices(plan.id).length, 0);
});

test('14 张同名卡：保存两次，行数不变、id 不变（证据不失联）', () => {
  const c = seedClient();
  const practices = Array.from({ length: 14 }, (_, i) => ({
    day: i + 1,
    title: '三问圈',
    intent: 'i',
    action: `情景 ${i + 1} 里的动作`,
    evidence_prompt: 'p',
    success_criteria: 's',
  }));
  const plan = plans.createDraft({ clientId: c.id, payload: { ...PAYLOAD, practices } });
  const before = plans.listPractices(plan.id);
  assert.equal(before.length, 14);

  // 改一个字再存一次 —— 物化不该新建行
  const edited = practices.map((p, i) => (i === 7 ? { ...p, action: '改过的动作' } : p));
  plans.updatePayload(plan.id, { ...PAYLOAD, practices: edited });
  const after = plans.listPractices(plan.id);
  assert.equal(after.length, 14, '不能新建行');
  assert.deepEqual(after.map(p => p.id), before.map(p => p.id), 'id 必须一一对应');
  assert.equal(after[7].action, '改过的动作');
});

test('物化：圈 / 情景 / 靶子三个字段被存下来', () => {
  const c = seedClient();
  const plan = plans.createDraft({
    clientId: c.id,
    payload: {
      ...PAYLOAD,
      practices: [{ day: 1, title: '三问圈', action: 'a', circle: '三问圈', scenario: '开会前', target_belief: '外周信念甲' }],
    },
  });
  const p = plans.listPractices(plan.id)[0];
  assert.equal(p.circle, '三问圈');
  assert.equal(p.scenario, '开会前');
  assert.equal(p.target_belief, '外周信念甲');
});

// ── pickPracticeMatch（增补 D.0.2 的分级匹配）────────────────────────

const matchRows = [
  { id: 'p1', title: '三问圈', day: 1 },
  { id: 'p2', title: '三问圈', day: 2 },
  { id: 'p3', title: '三问圈', day: 3 },
];

test('(title, day) 完全一致：直接命中', () => {
  assert.equal(pickPracticeMatch(matchRows, { title: '三问圈', day: 2 }).id, 'p2');
});

test('改了标题、天次不变：同 day 兜住，id 不丢', () => {
  const m = pickPracticeMatch(matchRows, { title: '三问圈（改名）', day: 3 });
  assert.equal(m.id, 'p3');
});

test('改了天次、标题不变：同 title 里取 day 最接近的', () => {
  const m = pickPracticeMatch(matchRows, { title: '三问圈', day: 30 });
  assert.equal(m.id, 'p3', 'day 30 离 3 最近');
});

test('标题和天次都换了：匹配不上，返回 null（调用方新建行）', () => {
  assert.equal(pickPracticeMatch(matchRows, { title: '完全不同的练习', day: 9 }), null);
});

test('候选为空：返回 null', () => {
  assert.equal(pickPracticeMatch([], { title: 'x', day: 1 }), null);
});

test('day 缺失时不按 day 匹配，落到同 title', () => {
  const m = pickPracticeMatch(matchRows, { title: '三问圈', day: null });
  assert.ok(m);
  assert.equal(m.title, '三问圈');
});
