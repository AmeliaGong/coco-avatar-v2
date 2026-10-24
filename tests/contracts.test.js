import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStuckPoint, normalizeStuckPoint } from '../server/contracts/stuckPoint.js';
import { validatePlanPayload, normalizePlanPayload } from '../server/contracts/plan.js';

test('stuck_point：完整结构通过校验', () => {
  const ok = validateStuckPoint({
    title: '我不能停下来，因为一旦停下来就会被抛弃',
    belief: '停下来就会被抛弃',
    evidence_against: ['上周请假一天，年底考核并没有变差'],
    emotion: '焦虑',
    micro_action: '今天记录一次「我可以慢下来」的时刻',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
});

test('stuck_point：缺少 title 报错', () => {
  const ok = validateStuckPoint({ belief: 'x' });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('title')));
});

test('stuck_point：normalize 把 evidence_against 补成数组', () => {
  const n = normalizeStuckPoint({
    title: '  卡点  ',
    evidence_against: '只有一条证据',
  });
  assert.equal(n.title, '卡点');
  assert.deepEqual(n.evidence_against, ['只有一条证据']);
  assert.deepEqual(n.belief, '');
  assert.deepEqual(n.emotion, '');
  assert.deepEqual(n.micro_action, '');
});

test('plan：worth_practicing 为 false 时 practices 允许为空', () => {
  const ok = validatePlanPayload({
    diagnosis: { core_belief: 'a', pattern: 'b', root_cause: 'c' },
    vision: { title: 't', narrative: 'n', horizon: '1_year' },
    practices: [],
    worth_practicing: false,
  });
  assert.equal(ok.ok, true);
});

test('plan：缺少 diagnosis 报错', () => {
  const ok = validatePlanPayload({ vision: { title: 't', narrative: 'n', horizon: '1_year' } });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('diagnosis')));
});

test('plan：vision.horizon 只能是三个枚举值之一', () => {
  const bad = validatePlanPayload({
    diagnosis: { core_belief: 'a', pattern: 'b', root_cause: 'c' },
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.includes('horizon')));
});

test('plan：normalize 在 worth_practicing 为 false 时清空 practices', () => {
  const n = normalizePlanPayload({
    diagnosis: { core_belief: 'a', pattern: 'b', root_cause: 'c' },
    vision: { title: 't', narrative: 'n', horizon: '1_year' },
    practices: [{ day: 1, title: '不该出现' }],
    worth_practicing: false,
  });
  assert.deepEqual(n.practices, []);
});
