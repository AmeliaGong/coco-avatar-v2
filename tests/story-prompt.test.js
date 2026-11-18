// Coco 自己那条故事线（prompts/scenario.story.md）的素材切分。
//
// 2026-11-16：原来的 4 段里，第 3 段有 897 字 —— 一条气泡就是一堵墙。
// 2026-11-17：Coco 给了新的故事原稿（原 7 节），从原稿里**精选提炼**成 3 段
//   （倦怠与召唤 / 出走与天赋 / 边界与信念），每段 400–560 字。
//
// ⚠️ 两条硬约束：
//   1. **精选版是 Coco 自己的话**，必须一字不差地讲出来（标点也不动）。
//   2. 每段之后都要有一句问（问句是这个场景的引擎：用户答完才推进）；
//      第 3 段之后进入收口。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = fs.readFileSync(path.join(ROOT, 'prompts/scenario.story.md'), 'utf8');

const MARK = '故事素材（按顺序讲述，讲哪段就读哪段，不要改字）：\n';
const material = prompt.split(MARK)[1].split('\n---')[0];

// 切出 3 个「第N段：」
const segs = [];
const re = /^第(\d+)段：\s*$/gm;
let m;
const marks = [];
while ((m = re.exec(material))) marks.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
for (let i = 0; i < marks.length; i++) {
  const stop = i + 1 < marks.length ? marks[i + 1].start : material.length;
  segs.push({ n: marks[i].n, text: material.slice(marks[i].end, stop).trim() });
}

test('Coco 的故事是 3 段，编号连续', () => {
  assert.equal(segs.length, 3, `应该是 3 段，实际 ${segs.length} 段`);
  assert.deepEqual(segs.map(s => s.n), [1, 2, 3]);
});

test('没有任何一段超过 620 字，也没有空段', () => {
  // 旧版第 3 段有 897 字（一条气泡就是一堵墙）；现在是 414 / 497 / 559。
  for (const s of segs) {
    assert.ok(s.text.length <= 620, `第${s.n}段有 ${s.text.length} 字，太长了`);
    assert.ok(s.text.length > 0, `第${s.n}段是空的`);
  }
});

test('三段的字数锁死（414 / 497 / 559，合计 1470）', () => {
  const lens = segs.map(s => s.text.length);
  assert.deepEqual(lens, [414, 497, 559], `字数变了：${lens.join(' / ')}`);
  assert.equal(lens.reduce((a, b) => a + b, 0), 1470);
});

test('三段长度大致均衡（最长不超过最短的 1.8 倍），且每段都有分量', () => {
  const lens = segs.map(s => s.text.length);
  const min = Math.min(...lens);
  const max = Math.max(...lens);
  assert.ok(min >= 300, `最短的一段只有 ${min} 字，太单薄`);
  assert.ok(max <= min * 1.8, `最长 ${max} / 最短 ${min}，太不均衡`);
  assert.ok(max <= 620, `最长的一段 ${max} 字，还是太长`);
});

test('旧稿的内部标记「故事N：」没有残留（那些是切分记号，端上不能出现）', () => {
  assert.equal(/^故事\d[：:]/m.test(material), false, '素材里还留着「故事N：」标记');
  assert.equal(material.includes('第1段：\n故事1：'), false);
});

test('3 段之后各有一句问，收口挂在第 3 段', () => {
  const qBlock = prompt.split('【每段之后问什么】')[1].split('【故事收尾阶段】')[0];
  const asked = [...qBlock.matchAll(/- 第(\d+)段之后/g)].map(x => Number(x[1]));
  assert.deepEqual(asked, [1, 2, 3], '每段都要有一句问');
  assert.ok(prompt.includes('【故事收尾阶段】（第3段讲完、用户回应之后）'), '收口应挂在第 3 段');
});

test('每段后的问句用的是 Coco 自己原稿里的 ▸ 反思问题', () => {
  const qBlock = prompt.split('【每段之后问什么】')[1].split('【故事收尾阶段】')[0];
  for (const q of [
    '你有多久没有听过内心真正的呼唤？',
    '如果有一项天赋让你投入时不计成本、不知疲倦，你是否敢以此为基石构建你的生命事业？',
  ]) {
    assert.ok(qBlock.includes(q), `每段问句里缺：${q}`);
  }
});

test('新稿的锚点句都在（证明她的原话没被改写/丢掉）', () => {
  for (const line of [
    '世界流动大学',
    '你忆起，自己是谁了吗？',
    '30岁之后，你最主要的身份是一个画家。',
    '有温度的边界',
    'Astronoland',
    'Be water，We stream。',
  ]) {
    assert.ok(material.includes(line), `原文缺了：${line}`);
  }
});

test('旧稿（阿里/北欧那版）没有混进新素材', () => {
  assert.equal(material.includes('阿里公司的那个夏天'), false, '旧稿开场还在');
  assert.equal(material.includes('北欧'), false, '旧稿的北欧段落还在');
});

test('钩子覆盖 3 段之间的 2 个过渡', () => {
  const hookBlock = prompt.split('【讲故事阶段】')[1].split('【每段之后问什么】')[0];
  for (const h of ['第1段→第2段', '第2段→第3段']) {
    assert.ok(hookBlock.includes(h), `缺 ${h} 的钩子`);
  }
  assert.equal(/第3段→第4段/.test(hookBlock), false, '只有 3 段，不该有第4段');
});
