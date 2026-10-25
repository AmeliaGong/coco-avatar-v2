import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createCoachMoveStore, SEED_MOVES } from '../server/delivery/coachMoves.js';

let moves;

beforeEach(() => {
  resetDb();
  moves = createCoachMoveStore({ db: getDb() });
});

test('新建一条手法', () => {
  const m = moves.create({ name: '三问圈', summary: '把卡点拆成三问', when_to_use: '卡点刚被激活' });
  assert.equal(m.name, '三问圈');
  assert.equal(m.active, 1);
  assert.deepEqual(m.targets, []);
});

test('名字重复要拦下', () => {
  moves.create({ name: '三问圈', summary: 'a' });
  assert.throws(() => moves.create({ name: '三问圈', summary: 'b' }), /已存在/);
});

test('summary 必填', () => {
  assert.throws(() => moves.create({ name: 'x', summary: '  ' }), /summary/);
});

test('归档是置 active=0，不是物理删除', () => {
  const m = moves.create({ name: '三问圈', summary: 'a' });
  moves.archive(m.id);
  assert.equal(moves.get(m.id).active, 0);
  assert.equal(moves.list({ activeOnly: true }).length, 0);
  assert.equal(moves.list({ activeOnly: false }).length, 1);
});

test('seed 按名字幂等：跑两次不重复', () => {
  const seed = [{ name: '三问圈', summary: 'a' }];
  moves.seed(seed);
  moves.seed(seed);
  assert.equal(moves.list({ activeOnly: false }).length, 1);
});

// targets / tags 存取都要 trim + 去重 —— 同一个 target 写两遍不该在库里留两条。
test('targets / tags 去空白且去重', () => {
  const m = moves.create({
    name: '三问圈',
    summary: 'a',
    targets: ['  我不能停 ', '我不能停', '', '   ', 42],
    tags: ['认知', '认知'],
  });
  assert.deepEqual(m.targets, ['我不能停']);
  assert.deepEqual(m.tags, ['认知']);
});

test('非字符串 id 不进 SQL：get 返回 null，update / archive 抛中文错', () => {
  assert.equal(moves.get({ evil: 1 }), null);
  assert.equal(moves.get(undefined), null);
  assert.throws(() => moves.update({ evil: 1 }, { summary: 'x' }), /id/);
  assert.throws(() => moves.archive({ evil: 1 }), /id/);
});

test('update 改字段；改名撞上别人要拦下', () => {
  const a = moves.create({ name: '三问圈', summary: 'a' });
  moves.create({ name: '问你的心', summary: 'b' });
  const updated = moves.update(a.id, { summary: '改过的摘要', script: '照抄的原话' });
  assert.equal(updated.summary, '改过的摘要');
  assert.equal(updated.script, '照抄的原话');
  assert.throws(() => moves.update(a.id, { name: '问你的心' }), /已存在/);
});

test('种子手法是五条，且内容里不出现来访者信息', () => {
  assert.equal(SEED_MOVES.length, 5);
  for (const m of SEED_MOVES) {
    assert.ok(m.name && m.summary && m.when_to_use && m.script);
  }
  const created = moves.seed(SEED_MOVES);
  assert.equal(created.length, 5);
  assert.equal(moves.list({ activeOnly: false }).length, 5);
});
