// Coco 自己那条故事线（prompts/scenario.story.md）的素材切分。
//
// 2026-11-16：4 段里第 3 段有 897 字（一条气泡就是一堵墙）→ 按段落切成 9 段。
// 2026-11-17：换成 Coco 给的新故事稿，精选提炼成 3 段。
// 2026-11-18：Coco 自己重写了**整合版**（4 段：阿里/挪威 → 硅谷/西藏 → 大理/纪录片
//             → 代际/巴厘岛/社区/共创）。这是她本人写的最新版本，唯一权威版本。
//
// ⚠️ 两条硬约束：
//   1. **Coco 的原文一个字都不能改**（包括标点）。切分只允许在段落之间切。
//   2. 每段之后都要有一句问（问句是这个场景的引擎：用户答完才推进）；
//      最后一段之后进入收口（共鸣 → 问感受 → 桥接社区）。
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

// 切出 4 个「第N段：」
const segs = [];
const re = /^第(\d+)段：\s*$/gm;
let m;
const marks = [];
while ((m = re.exec(material))) marks.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
for (let i = 0; i < marks.length; i++) {
  const stop = i + 1 < marks.length ? marks[i + 1].start : material.length;
  segs.push({ n: marks[i].n, text: material.slice(marks[i].end, stop).trim() });
}

test('Coco 的故事是 4 段，编号连续', () => {
  assert.equal(segs.length, 4, `应该是 4 段，实际 ${segs.length} 段`);
  assert.deepEqual(segs.map(s => s.n), [1, 2, 3, 4]);
});

test('没有任何一段超过 620 字，也没有空段', () => {
  // 旧版第 3 段有 897 字（一条气泡就是一堵墙）；现在是 422 / 308 / 470 / 469。
  for (const s of segs) {
    assert.ok(s.text.length <= 620, `第${s.n}段有 ${s.text.length} 字，太长了`);
    assert.ok(s.text.length > 0, `第${s.n}段是空的`);
  }
});

test('四段的字数锁死（422 / 308 / 470 / 469，合计 1669）', () => {
  const lens = segs.map(s => s.text.length);
  assert.deepEqual(lens, [422, 308, 470, 469], `字数变了：${lens.join(' / ')}`);
  assert.equal(lens.reduce((a, b) => a + b, 0), 1669);
});

test('四段长度大致均衡（最长不超过最短的 1.8 倍），且每段都有分量', () => {
  const lens = segs.map(s => s.text.length);
  const min = Math.min(...lens);
  const max = Math.max(...lens);
  assert.ok(min >= 300, `最短的一段只有 ${min} 字，太单薄`);
  assert.ok(max <= min * 1.8, `最长 ${max} / 最短 ${min}，太不均衡`);
});

test('手稿里的内部标记没有混进素材（小标题/编号/分隔线端上不能出现）', () => {
  assert.equal(/^故事\d[：:]/m.test(material), false, '素材里还留着「故事N：」标记');
  assert.equal(material.includes('第一段'), false, '素材里出现了「第一段」这种手稿标记');
  assert.equal(/^---$/m.test(material), false, '素材里出现了分隔线');
});

test('4 段之后各有一句问，收口挂在第 4 段', () => {
  const qBlock = prompt.split('【每段之后问什么】')[1].split('【故事收尾阶段】')[0];
  const asked = [...qBlock.matchAll(/- 第(\d+)段之后/g)].map(x => Number(x[1]));
  assert.deepEqual(asked, [1, 2, 3, 4], '每段都要有一句问');
  assert.ok(prompt.includes('【故事收尾阶段】（第4段讲完、用户回应之后）'), '收口应挂在第 4 段');
});

test('每段后的问句是她审过的那三个', () => {
  const qBlock = prompt.split('【每段之后问什么】')[1].split('【故事收尾阶段】')[0];
  for (const q of [
    '你有没有过那种时刻——明明做得很“体面”、很成功，却觉得自己在一点点被消耗掉？',
    '当一件你已经全身心投入、却还没看到结果的事遇到瓶颈，你会不会问自己：我是在做它，还是在用它证明自己？',
    '如果给你一整年，不许交差、不许证明什么，只让你去探索自己的天赋和热爱——你会用来做什么？',
  ]) {
    assert.ok(qBlock.includes(q), `每段问句里缺：${q}`);
  }
});

test('整合版的锚点句都在（证明她的原话没被改写/丢掉）', () => {
  for (const line of [
    '2019年我在阿里公司的那个夏天',
    '在奥斯陆我见到了自主创业进行教育变革的Alex',
    '坐在布达拉宫斜对面的茶馆',
    '《我在大理开了一所人生学校》',
    'Be water, WeStream',
    '你愿意加入这个共创的过程吗？',
  ]) {
    assert.ok(material.includes(line), `原文缺了：${line}`);
  }
});

test('锚点句落在对的段里（段序不能串）', () => {
  const at = (line, n) => assert.ok(segs[n - 1].text.includes(line), `「${line}」不在第${n}段`);
  at('2019年我在阿里公司的那个夏天', 1);
  at('在奥斯陆我见到了自主创业进行教育变革的Alex', 1);
  at('坐在布达拉宫斜对面的茶馆', 2);
  at('《我在大理开了一所人生学校》', 3);
  at('Be water, WeStream', 4);
  at('你愿意加入这个共创的过程吗？', 4);
});

test('前两版（9 段旧稿 / 3 段精选稿）的句子没有混进来', () => {
  for (const line of [
    '老子这一年就是不挣钱',       // 9 段旧稿
    'Be water，We stream。',        // 9 段旧稿（新版是半角逗号，保留 Coco 写法）
    '世界流动大学',                 // 3 段精选稿（11-17）
    '30岁之后，你最主要的身份是一个画家。', // 3 段精选稿（11-17）
    'Astronoland',                  // 3 段精选稿（11-17）
    '你忆起，自己是谁了吗？',       // 3 段精选稿（11-17）
  ]) {
    assert.equal(material.includes(line), false, `不该出现的旧稿句子：${line}`);
  }
});

test('钩子覆盖 4 段之间的 3 个过渡', () => {
  const hookBlock = prompt.split('【讲故事阶段】')[1].split('【每段之后问什么】')[0];
  for (const h of ['第1段→第2段', '第2段→第3段', '第3段→第4段']) {
    assert.ok(hookBlock.includes(h), `缺 ${h} 的钩子`);
  }
  assert.equal(/第4段→第5段/.test(hookBlock), false, '只有 4 段，不该有第5段');
});

test('收尾阶段：含糊的回答（"我想想"）不算拒绝，必须把人列出来', () => {
  // 2026-11-18 线上实测：模型回了「好，不着急。你可以先想想…」就停下，
  // 用户面前什么都没有 → 后面「第二个」只能对着 15 人目录瞎猜。
  const closing = prompt.split('【故事收尾阶段】（第4段讲完、用户回应之后）').pop().split('\n【探索者分支】')[0];
  assert.ok(closing.includes('我想想'), '收尾阶段要写明"我想想"这类含糊回答');
  assert.ok(/不是拒绝/.test(closing), '要写明含糊 ≠ 拒绝');
  assert.ok(/不要只回一句"好，不着急"就停下/.test(closing), '要禁止只回客套话就停下');
  assert.ok(closing.includes('下一轮一定要把 3 位探索者列出来'), '要强制下一轮列出 3 个人');
});

test('探索者分支：3 个候选的固定格式（3 行 "- " 开头）+ 序号指的是刚列出的三人', () => {
  const branch = prompt.split('【探索者分支】').pop().split('【创业想法分支】')[0];
  assert.ok(branch.includes('- 名字：一句话画像'), '要给模型的候选列表格式');
  assert.ok(branch.includes('正好 3 行，每行以 "- " 开头'), '要规定候选正好 3 行');
  assert.ok(/不是目录里的排序/.test(branch), '要写明序号指的是刚列出的三个人');
});
