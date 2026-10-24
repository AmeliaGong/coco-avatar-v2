import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStuckPoint,
  normalizeStuckPoint,
  STUCK_POINT_FIELD_NOTES,
} from '../server/contracts/stuckPoint.js';
import {
  validatePlanPayload,
  normalizePlanPayload,
  PLAN_HORIZONS,
  PLAN_FIELD_NOTES,
} from '../server/contracts/plan.js';

const validDiagnosis = { core_belief: 'a', pattern: 'b', root_cause: 'c' };
const validVision = { title: 't', narrative: 'n', horizon: '1_year' };
const validPractice = { day: 1, title: '这一步', action: '今晚 22:00 关掉手机' };

// ---------- stuck_point ----------

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
  assert.equal(n.belief, '');
  assert.equal(n.emotion, '');
  assert.equal(n.micro_action, '');
});

test('stuck_point：evidence_against 是字符串时校验也放行（normalize 能包成数组）', () => {
  const ok = validateStuckPoint({ title: '卡点', evidence_against: '一条证据' });
  assert.equal(ok.ok, true, `不该报错: ${ok.errors.join('; ')}`);
});

test('stuck_point：evidence_against 是数字时报错', () => {
  const ok = validateStuckPoint({ title: '卡点', evidence_against: 42 });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('evidence_against')));
});

test('stuck_point：非对象输入报错，数组也算非对象', () => {
  assert.equal(validateStuckPoint(null).ok, false);
  assert.equal(validateStuckPoint('x').ok, false);
  assert.equal(validateStuckPoint([1, 2, 3]).ok, false);
});

test('stuck_point：normalize 对非对象输入返回空结构而不是抛错', () => {
  const n = normalizeStuckPoint([1, 2, 3]);
  assert.deepEqual(Object.keys(n).sort(), [
    'belief',
    'emotion',
    'evidence_against',
    'micro_action',
    'title',
  ]);
  assert.equal(n.title, '');
  assert.deepEqual(n.evidence_against, []);
});

test('stuck_point：字段说明覆盖必填项，且随 prompt 一起可用', () => {
  assert.ok(STUCK_POINT_FIELD_NOTES.title.includes('必填'));
  assert.ok(STUCK_POINT_FIELD_NOTES.evidence_against.includes('数组'));
});

// ---------- plan ----------

test('plan：worth_practicing 为 false 时 practices 允许为空', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [],
    worth_practicing: false,
  });
  assert.equal(ok.ok, true);
});

test('plan：缺少 diagnosis 报错', () => {
  const ok = validatePlanPayload({ vision: validVision });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('diagnosis')));
});

test('plan：vision.horizon 只能是三个枚举值之一', () => {
  const bad = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.includes('horizon')));
});

test('plan：normalize 在 worth_practicing 为 false 时清空 practices', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: 1, title: '不该出现' }],
    worth_practicing: false,
  });
  assert.deepEqual(n.practices, []);
});

test('plan：worth_practicing 为字符串 "false" 时也关掉练习', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [validPractice],
    worth_practicing: 'false',
  });
  assert.equal(n.worth_practicing, false);
  assert.deepEqual(n.practices, []);
});

test('plan：worth_practicing 为 0 时也关掉练习，为 "true" 时保留', () => {
  const base = { diagnosis: validDiagnosis, vision: validVision, practices: [validPractice] };
  assert.equal(normalizePlanPayload({ ...base, worth_practicing: 0 }).worth_practicing, false);
  assert.equal(normalizePlanPayload({ ...base, worth_practicing: 'true' }).worth_practicing, true);
});

test('plan：worth_practicing 缺省时按 true 处理', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [validPractice],
  });
  assert.equal(n.worth_practicing, true);
  assert.equal(n.practices.length, 1);
});

test('plan：worth_practicing 写成无法理解的字符串时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [],
    worth_practicing: 'maybe',
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('worth_practicing')));
});

test('plan：normalize 不替模型编造 vision.horizon', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
  });
  assert.equal(n.vision.horizon, '10_years');
});

test('plan：vision.horizon 缺失时 normalize 留空而不是兜底成 1_year', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n' },
    practices: [],
  });
  assert.equal(n.vision.horizon, '');
});

test('plan：practice 缺 action 报错（不能给用户一个做不了的练习）', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: 1, title: '这一步' }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('action')));
});

test('plan：practice 缺 title 报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: 1, action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('title')));
});

test('plan：practice 的 day 不是数字时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: '第三天', title: '这一步', action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('day')));
});

test('plan：practice 不是对象时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: ['不是对象'],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('practices[0]')));
});

test('plan：normalize 把字符串形式的 day 转成数字', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: '3', title: '这一步', action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(n.practices[0].day, 3);
});

test('plan：normalize 在 day 缺失时按顺序编号', () => {
  const n = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ title: '第一步', action: 'a' }, { title: '第二步', action: 'b' }],
    worth_practicing: true,
  });
  assert.deepEqual(n.practices.map(p => p.day), [1, 2]);
});

test('plan：normalize 保留 0 而不是把它当成空值吞掉', () => {
  const n = normalizePlanPayload({
    diagnosis: { core_belief: 0, pattern: 'b', root_cause: 'c' },
    vision: validVision,
    practices: [],
  });
  assert.equal(n.diagnosis.core_belief, '0');
});

test('plan：两个契约的同名字段归一化规则一致（title 都会去空白）', () => {
  const sp = normalizeStuckPoint({ title: '  卡点  ' });
  const pl = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: '  愿景  ', narrative: 'n', horizon: '1_year' },
    practices: [],
  });
  assert.equal(sp.title, '卡点');
  assert.equal(pl.vision.title, '愿景');
});

test('plan：非对象输入报错，数组也算非对象', () => {
  assert.equal(validatePlanPayload(null).ok, false);
  assert.equal(validatePlanPayload(5).ok, false);
  assert.equal(validatePlanPayload([]).ok, false);
});

test('plan：normalize 的输出键集合固定', () => {
  const n = normalizePlanPayload({});
  assert.deepEqual(Object.keys(n).sort(), [
    'diagnosis',
    'practices',
    'vision',
    'worth_practicing',
  ]);
  assert.deepEqual(Object.keys(n.vision).sort(), ['horizon', 'narrative', 'title']);
});

test('plan：字段说明里写清了 worth_practicing 的 false 语义', () => {
  const note = PLAN_FIELD_NOTES.worth_practicing;
  assert.ok(note.includes('false'), '未说明 false 的含义');
  assert.ok(note.includes('诊断'), '未说明 false 时只交付诊断');
  assert.ok(PLAN_FIELD_NOTES['vision.horizon'].includes('3_months'));
  assert.ok(PLAN_FIELD_NOTES['vision.horizon'].includes('1_year'));
  assert.ok(PLAN_FIELD_NOTES['vision.horizon'].includes('life'));
});

test('plan：horizon 枚举就是三个值', () => {
  assert.deepEqual(PLAN_HORIZONS, ['3_months', '1_year', 'life']);
});
