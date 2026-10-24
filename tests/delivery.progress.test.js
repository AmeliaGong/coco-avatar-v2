import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStreak,
  computeProgress,
  pickCurrentPractice,
} from '../server/delivery/progress.js';

const prac = (id, sort_order) => ({ id, sort_order });
const ev = (practice_id, created_at) => ({ practice_id, created_at });

test('没有证据时连续天数为 0', () => {
  assert.equal(computeStreak([]), 0);
});

test('同一天两条证据算 1 天', () => {
  assert.equal(computeStreak([
    ev('p1', '2026-10-20T09:00:00.000Z'),
    ev('p2', '2026-10-20T21:00:00.000Z'),
  ]), 1);
});

test('连续两天算 2 天', () => {
  assert.equal(computeStreak([
    ev('p1', '2026-10-19T09:00:00.000Z'),
    ev('p2', '2026-10-20T09:00:00.000Z'),
  ]), 2);
});

test('中间断了一天，连续天数从最后一天往回数', () => {
  // 20 号有证据，19 号没有，18 号有 —— 连续 1 天，不是 2 天
  assert.equal(computeStreak([
    ev('p1', '2026-10-18T09:00:00.000Z'),
    ev('p2', '2026-10-20T09:00:00.000Z'),
  ]), 1);
});

test('连续天数从最后一条证据往回数，不从今天数', () => {
  // 证据都在 3 天前，但它们是连续的 —— 连续天数应是 2，而不是 0
  assert.equal(computeStreak([
    ev('p1', '2026-10-18T09:00:00.000Z'),
    ev('p2', '2026-10-19T09:00:00.000Z'),
  ]), 2);
});

test('时间戳格式不对的证据不计入', () => {
  assert.equal(computeStreak([
    { practice_id: 'p1', created_at: 'not-a-date' },
    { practice_id: 'p1', created_at: null },
    { practice_id: 'p1' },
  ]), 0);
});

test('进度：总条数、已完成条数、比例', () => {
  const practices = [prac('p1', 0), prac('p2', 1), prac('p3', 2)];
  const evidences = [ev('p1', '2026-10-20T09:00:00.000Z')];
  const p = computeProgress(practices, evidences);
  assert.equal(p.total, 3);
  assert.equal(p.completed, 1);
  assert.equal(p.ratio, 1 / 3);
  assert.equal(p.streak_days, 1);
});

test('进度：被移除的练习（sort_order = -1）不计入总数', () => {
  const practices = [prac('p1', 0), prac('gone', -1)];
  const p = computeProgress(practices, []);
  assert.equal(p.total, 1);
  assert.equal(p.completed, 0);
  assert.equal(p.ratio, 0);
});

test('进度：一条都没有时 ratio 是 0 而不是 NaN', () => {
  const p = computeProgress([], []);
  assert.equal(p.ratio, 0);
  assert.equal(p.total, 0);
});

test('当前练习：第一条没有证据的', () => {
  const practices = [prac('p1', 0), prac('p2', 1)];
  const current = pickCurrentPractice(practices, [ev('p1', '2026-10-20T09:00:00.000Z')]);
  assert.equal(current.id, 'p2');
});

test('当前练习：全部做完就是 null', () => {
  const practices = [prac('p1', 0), prac('p2', 1)];
  const current = pickCurrentPractice(practices, [
    ev('p1', '2026-10-20T09:00:00.000Z'),
    ev('p2', '2026-10-20T10:00:00.000Z'),
  ]);
  assert.equal(current, null);
});

test('当前练习：跳过被移除的练习', () => {
  const practices = [prac('gone', -1), prac('p1', 0)];
  const current = pickCurrentPractice(practices, []);
  assert.equal(current.id, 'p1');
});
