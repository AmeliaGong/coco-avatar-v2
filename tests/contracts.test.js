import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStuckPoint,
  normalizeStuckPoint,
  parseStuckPoint,
  STUCK_POINT_FIELD_NOTES,
  STUCK_POINT_SCHEMA,
  STUCK_POINT_PLACEHOLDERS,
} from '../server/contracts/stuckPoint.js';
import {
  validatePlanPayload,
  normalizePlanPayload,
  parsePlanPayload,
  PLAN_HORIZONS,
  PLAN_FIELD_NOTES,
  PLAN_SCHEMA,
  PLAN_PLACEHOLDERS,
} from '../server/contracts/plan.js';
import { toText, toNumber } from '../server/contracts/shared.js';

const validDiagnosis = { core_belief: 'a', pattern: 'b', root_cause: 'c' };
const validVision = { title: 't', narrative: 'n', horizon: '1_year' };
const validPractice = { day: 1, title: '这一步', action: '今晚 22:00 关掉手机' };

// 递归收集对象/数组里的全部字符串叶子，路径用点号连接（数组用 [i]）。
// 用来断言「占位值清单」与 schema 的示例值不漂移。
function collectStringLeaves(node, path = '', out = []) {
  if (typeof node === 'string') {
    out.push({ path, value: node });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectStringLeaves(item, `${path}[${i}]`, out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, val] of Object.entries(node)) {
      collectStringLeaves(val, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

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

// ---------- 照抄示例值必须被拦住 ----------

test('stuck_point：title 照抄 schema 示例值时报错', () => {
  const ok = validateStuckPoint({ title: STUCK_POINT_SCHEMA.title });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('title')),
    `错误信息里应含 title，实际: ${ok.errors.join('; ')}`,
  );
});

test('stuck_point：belief 照抄 schema 示例值时报错', () => {
  const ok = validateStuckPoint({ title: '卡点', belief: STUCK_POINT_SCHEMA.belief });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('belief')),
    `错误信息里应含 belief，实际: ${ok.errors.join('; ')}`,
  );
});

test('stuck_point：evidence_against 里有一项照抄 schema 示例值时报错', () => {
  const ok = validateStuckPoint({
    title: '卡点',
    evidence_against: ['上周请假一天，年底考核并没有变差', STUCK_POINT_SCHEMA.evidence_against[0]],
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('evidence_against')),
    `错误信息里应含 evidence_against，实际: ${ok.errors.join('; ')}`,
  );
});

test('stuck_point：emotion / micro_action 照抄 schema 示例值时报错', () => {
  for (const key of ['emotion', 'micro_action']) {
    const ok = validateStuckPoint({ title: '卡点', [key]: STUCK_POINT_SCHEMA[key] });
    assert.equal(ok.ok, false, `${key} 照抄示例值时应该报错`);
    assert.ok(
      ok.errors.some(e => e.includes(key)),
      `错误信息里应含 ${key}，实际: ${ok.errors.join('; ')}`,
    );
  }
});

test('stuck_point：占位值清单与 schema 的示例值不漂移', () => {
  const leaves = collectStringLeaves(STUCK_POINT_SCHEMA).map(l => l.value);
  for (const leaf of leaves) {
    assert.ok(
      STUCK_POINT_PLACEHOLDERS.includes(leaf),
      `schema 里的示例值不在占位值清单中: ${leaf}`,
    );
  }
  assert.deepEqual(
    [...STUCK_POINT_PLACEHOLDERS].sort(),
    [...new Set(leaves)].sort(),
    '占位值清单里有多余的项，或漏掉了 schema 里的示例值',
  );
});

test('plan：diagnosis.core_belief 照抄 schema 示例值时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: { ...validDiagnosis, core_belief: PLAN_SCHEMA.diagnosis.core_belief },
    vision: validVision,
    practices: [],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('diagnosis.core_belief')),
    `错误信息里应含 diagnosis.core_belief，实际: ${ok.errors.join('; ')}`,
  );
});

test('plan：vision.narrative 照抄 schema 示例值时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: { ...validVision, narrative: PLAN_SCHEMA.vision.narrative },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('vision.narrative')),
    `错误信息里应含 vision.narrative，实际: ${ok.errors.join('; ')}`,
  );
});

test('plan：practices[0].action 照抄 schema 示例值时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: 1, title: '这一步', action: PLAN_SCHEMA.practices[0].action }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('practices[0].action')),
    `错误信息里应含 practices[0].action，实际: ${ok.errors.join('; ')}`,
  );
});

test('plan：vision.horizon 为 1_year 不报错（合法枚举值不能被误杀）', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n', horizon: '1_year' },
    practices: [validPractice],
    worth_practicing: true,
  });
  assert.equal(ok.ok, true, `不该报错: ${ok.errors.join('; ')}`);
  assert.deepEqual(ok.errors, []);
});

test('plan：占位值清单与 schema 的示例值不漂移（horizon 是合法枚举，跳过）', () => {
  const leaves = collectStringLeaves(PLAN_SCHEMA)
    .filter(l => l.path !== 'vision.horizon')
    .map(l => l.value);
  for (const leaf of leaves) {
    assert.ok(
      PLAN_PLACEHOLDERS.includes(leaf),
      `schema 里的示例值不在占位值清单中: ${leaf}`,
    );
  }
  assert.deepEqual(
    [...PLAN_PLACEHOLDERS].sort(),
    [...new Set(leaves)].sort(),
    '占位值清单里有多余的项，或漏掉了 schema 里的示例值',
  );
});

test('正常内容不因占位值检查而被误伤', () => {
  const sp = validateStuckPoint({
    title: '我不能停下来，因为一旦停下来就会被抛弃',
    belief: '停下来就会被抛弃',
    evidence_against: ['上周请假一天，年底考核并没有变差'],
    emotion: '焦虑',
    micro_action: '今天记录一次「我可以慢下来」的时刻',
  });
  assert.equal(sp.ok, true, `不该报错: ${sp.errors.join('; ')}`);
  const pl = validatePlanPayload({
    diagnosis: { core_belief: '我不够好', pattern: '反复讨好', root_cause: '早年的否定' },
    vision: { title: '有自己的节奏', narrative: '你不再用忙碌换安全。', horizon: 'life' },
    practices: [validPractice],
    worth_practicing: true,
  });
  assert.equal(pl.ok, true, `不该报错: ${pl.errors.join('; ')}`);
});

test('stuck_point：belief / emotion / micro_action 的字段说明写明可以给数组', () => {
  for (const key of ['belief', 'emotion', 'micro_action']) {
    assert.ok(
      STUCK_POINT_FIELD_NOTES[key].includes('数组'),
      `${key} 的字段说明没写明可以给数组: ${STUCK_POINT_FIELD_NOTES[key]}`,
    );
  }
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

// ---------- plan：必填校验必须跟字段说明一致 ----------

test('plan：diagnosis 的三个必填字段缺失时报错，且错误带对应路径', () => {
  for (const key of ['core_belief', 'pattern', 'root_cause']) {
    const diagnosis = { ...validDiagnosis };
    delete diagnosis[key];
    const ok = validatePlanPayload({
      diagnosis,
      vision: validVision,
      practices: [],
      worth_practicing: true,
    });
    assert.equal(ok.ok, false, `${key} 缺失时应该报错`);
    assert.ok(
      ok.errors.some(e => e.includes(`diagnosis.${key}`)),
      `错误信息里应含 diagnosis.${key}，实际: ${ok.errors.join('; ')}`,
    );
  }
});

test('plan：vision.title 与 vision.narrative 缺失时报错，且错误带对应路径', () => {
  for (const key of ['title', 'narrative']) {
    const vision = { ...validVision };
    delete vision[key];
    const ok = validatePlanPayload({
      diagnosis: validDiagnosis,
      vision,
      practices: [],
      worth_practicing: true,
    });
    assert.equal(ok.ok, false, `${key} 缺失时应该报错`);
    assert.ok(
      ok.errors.some(e => e.includes(`vision.${key}`)),
      `错误信息里应含 vision.${key}，实际: ${ok.errors.join('; ')}`,
    );
  }
});

test('plan：diagnosis 里的必填字段是空字符串也算缺失', () => {
  const ok = validatePlanPayload({
    diagnosis: { ...validDiagnosis, pattern: '   ' },
    vision: validVision,
    practices: [],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('diagnosis.pattern')));
});

test('plan：缺少 worth_practicing 报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [],
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('worth_practicing')),
    `实际: ${ok.errors.join('; ')}`,
  );
  assert.ok(
    ok.errors.some(e => e.includes('worth_practicing') && e.includes('必填')),
    `缺失应该报「必填」: ${ok.errors.join('; ')}`,
  );
});

test('plan：worth_practicing 为 null 也算缺失', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [],
    worth_practicing: null,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('worth_practicing')));
});

test('plan：worth_practicing 为 false 且 practices 非空时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [validPractice],
    worth_practicing: false,
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('practices')),
    `实际: ${ok.errors.join('; ')}`,
  );
});

test('plan：worth_practicing 为 false 且 practices 是空数组时通过', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [],
    worth_practicing: false,
  });
  assert.equal(ok.ok, true, `不该报错: ${ok.errors.join('; ')}`);
});

test('plan：worth_practicing 为 false 且完全不传 practices 时通过', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    worth_practicing: false,
  });
  assert.equal(ok.ok, true, `不该报错: ${ok.errors.join('; ')}`);
});

test('plan：worth_practicing 为 true 却不传 practices 报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(
    ok.errors.some(e => e.includes('practices')),
    `实际: ${ok.errors.join('; ')}`,
  );
});

test('plan：practices 不是数组时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: { day: 1 },
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('practices')));
});

test('plan：day 是科学计数法字符串时报错', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: '1e3', title: '这一步', action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('day')));
});

test('plan：day 是小数时报错（day 必须是整数）', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: 1.5, title: '这一步', action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('day')));
});

test('plan：day 是数字字符串时通过', () => {
  const ok = validatePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: '3', title: '这一步', action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(ok.ok, true, `不该报错: ${ok.errors.join('; ')}`);
});

// ---------- 原子入口 parse* ----------

test('parsePlanPayload：非法 payload 返回 ok:false 与 null value', () => {
  const parsed = parsePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.value, null);
  assert.ok(parsed.errors.length > 0);
});

test('parsePlanPayload：合法 payload 返回归一化后的结构', () => {
  const parsed = parsePlanPayload({
    diagnosis: validDiagnosis,
    vision: validVision,
    practices: [{ day: '3', title: '  这一步  ', action: '做点事' }],
    worth_practicing: true,
  });
  assert.equal(parsed.ok, true, `不该报错: ${parsed.errors.join('; ')}`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.value.practices[0].day, 3);
  assert.equal(parsed.value.practices[0].title, '这一步');
});

test('parsePlanPayload：非法 horizon 不会被悄悄改成 1_year（先校验后归一化）', () => {
  const parsed = parsePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.value, null);
  // 直接调 normalize 会把非法值原样留着 —— 这正是必须走 parse 的原因。
  const loose = normalizePlanPayload({
    diagnosis: validDiagnosis,
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(loose.vision.horizon, '10_years');
});

test('parseStuckPoint：emotion 是数组时通过且归一化成一段文本', () => {
  const parsed = parseStuckPoint({
    title: '我不能停下来，因为一旦停下来就会被抛弃',
    belief: '停下来就会被抛弃',
    evidence_against: ['上周请假一天，年底考核并没有变差'],
    emotion: ['焦虑'],
    micro_action: '今天记录一次「我可以慢下来」的时刻',
  });
  assert.equal(parsed.ok, true, `不该报错: ${parsed.errors.join('; ')}`);
  assert.equal(parsed.value.emotion, '焦虑');
});

test('parseStuckPoint：非法 payload 返回 ok:false 与 null value', () => {
  const parsed = parseStuckPoint({ belief: 'x' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.value, null);
  assert.ok(parsed.errors.length > 0);
});

test('stuck_point：belief / emotion / micro_action 是数字时报错', () => {
  for (const key of ['belief', 'emotion', 'micro_action']) {
    const ok = validateStuckPoint({ title: '卡点', [key]: 42 });
    assert.equal(ok.ok, false, `${key} 为数字时应该报错`);
    assert.ok(ok.errors.some(e => e.includes(key)));
  }
});

// ---------- 共享归一化规则 ----------

test('shared：toText 对布尔返回空串（布尔不是散文）', () => {
  assert.equal(toText(false), '');
  assert.equal(toText(true), '');
});

test('shared：toText 把数组拍平成顿号连接的文本', () => {
  assert.equal(toText(['焦虑', '害怕']), '焦虑、害怕');
  assert.equal(toText(['焦虑', '']), '焦虑');
});

test('shared：toNumber 不接受十六进制与科学计数法字符串', () => {
  assert.equal(toNumber('0x10'), null);
  assert.equal(toNumber('1e3'), null);
  assert.equal(toNumber('3'), 3);
});
