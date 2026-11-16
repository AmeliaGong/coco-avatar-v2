// Coco 自己那条故事线（prompts/scenario.story.md）的素材切分。
//
// 2026-11-16：原来的 4 段里，第 3 段有 897 字 —— 一条气泡就是一堵墙。
// 现在按**Coco 自己的段落边界**切成 9 段，最长 354 字。
//
// ⚠️ 两条硬约束：
//   1. **Coco 的原文一个字都不能改**（包括标点）。切分只允许在段落之间切。
//   2. 每段之后都要有一句问（问句是这个场景的引擎：用户答完才推进）。
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

// 切出 9 个「第N段：」
const segs = [];
const re = /^第(\d+)段：\s*$/gm;
let m;
const marks = [];
while ((m = re.exec(material))) marks.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
for (let i = 0; i < marks.length; i++) {
  const stop = i + 1 < marks.length ? marks[i + 1].start : material.length;
  segs.push({ n: marks[i].n, text: material.slice(marks[i].end, stop).trim() });
}

test('Coco 的故事切成 9 段，编号连续', () => {
  assert.equal(segs.length, 9, `应该是 9 段，实际 ${segs.length} 段`);
  assert.deepEqual(segs.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('没有任何一段超过 360 字（原来第 3 段是 897 字）', () => {
  for (const s of segs) {
    assert.ok(s.text.length <= 360, `第${s.n}段有 ${s.text.length} 字，太长了`);
    assert.ok(s.text.length > 0, `第${s.n}段是空的`);
  }
});

test('素材总字数没变（切分只动边界，不动字）', () => {
  const total = segs.reduce((a, s) => a + s.text.length, 0);
  assert.equal(total, 2335, `总字数应仍是 2335，实际 ${total}`);
});

test('旧的「故事N：」内部标记已经清掉（那些是切分记号，端上不能出现）', () => {
  assert.equal(/^故事\d[：:]/m.test(material), false, '素材里还留着「故事N：」标记');
  assert.equal(material.includes('第1段：\n故事1：'), false);
});

test('9 段之后各有一句问，收口挂在第 9 段', () => {
  const qBlock = prompt.split('【每段之后问什么】')[1].split('【故事收尾阶段】')[0];
  const asked = [...qBlock.matchAll(/- 第(\d+)段之后/g)].map(x => Number(x[1]));
  assert.deepEqual(asked, [1, 2, 3, 4, 5, 6, 7, 8, 9], '每段都要有一句问');
  assert.ok(prompt.includes('【故事收尾阶段】（第9段讲完、用户回应之后）'), '收口应挂在第 9 段');
});

test('Coco 原文的锚点句还在（证明没有把她的原话改写/丢掉）', () => {
  for (const line of [
    '故事要从我在阿里公司的那个夏天说起',
    '而我坐上了回国的飞机。',
    '老子这一年就是不挣钱',
    'Gap Year 是我第一次真正为自己而活的一年。',
    '就是那一刻，我决定创办 WeStream 人生学校。',
    'Be water，We stream。',
  ]) {
    assert.ok(material.includes(line), `原文缺了：${line}`);
  }
});

test('钩子覆盖 9 段之间的 8 个过渡', () => {
  const hookBlock = prompt.split('【讲故事阶段】')[1].split('【每段之后问什么】')[0];
  for (let i = 1; i <= 8; i++) {
    assert.ok(hookBlock.includes(`第${i}段→第${i + 1}段`), `缺第${i}段→第${i + 1}段的钩子`);
  }
});
