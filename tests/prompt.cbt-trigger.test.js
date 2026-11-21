// Step 1（触发）的引导话术 —— 产品约束的可执行断言。
//
// 为什么要有这些断言（2026-11-20）：
//   第一批内测用户反馈「最近 48 小时内并没有发生让自己情绪内耗的事，
//   或者感知不到自己潜意识的烦躁」⇒ 「必须 48 小时内 + 必须是个具体事件」
//   这个要求会把人直接卡死在 Step 1，进不去后面的练习。
//
// 钉住的不变量：**触发点可以是"最近让你心烦的情景"，也可以是
// "在心里反复权衡、还没法决定的事"，也可以是"说不上来的烦躁"**，
// 而且**不许再限定时间范围**、**不许逼用户编一个事件**。
//
// 这三条同时钉在两个入口上：
//   ② 卡点急救 = prompts/scenario.cbt_quick.md
//   ① 故事线结尾的 CBT 模块 = prompts/scenario.story.md / prompts/scenario.chat.md
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS = path.join(ROOT, 'prompts');

const read = f => fs.readFileSync(path.join(PROMPTS, f), 'utf8');
const cbtQuick = read('scenario.cbt_quick.md');
const story = read('scenario.story.md');
const chat = read('scenario.chat.md');

/** 从文本里切出【…】标记那一块（到下一个标记或文末）。 */
function block(text, marker) {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `找不到标记：${marker}`);
  const rest = text.slice(i + marker.length);
  const j = rest.search(/\n【/);
  return marker + (j >= 0 ? rest.slice(0, j) : rest);
}

const storyCbt = block(story, '【CBT认知练习模块】');
const chatCbt = block(chat, '【CBT认知练习模块】');

for (const [name, text] of [
  ['②卡点急救', cbtQuick],
  ['①故事线的 CBT 模块', storyCbt],
]) {
  test(`${name}：不再限定「最近 48 小时」`, () => {
    assert.ok(!/48\s*小时/.test(text), '还留着 48 小时这个时间门槛');
    assert.ok(!/最近\s*48\s*小时/.test(text));
  });

  test(`${name}：触发点可以是「反复权衡的纠结」`, () => {
    assert.ok(text.includes('反复权衡'), '没提「反复权衡、还没法决定」这件事');
  });

  test(`${name}：不逼用户编事件`, () => {
    assert.ok(text.includes('不要逼他编'), '没写「用户说没发生什么事时不要逼他编」');
  });
}

test('②卡点急救：Step 1 的三问与填写模板都在', () => {
  assert.ok(cbtQuick.includes('当时是什么时间、在哪里？'));
  assert.ok(cbtQuick.includes('哪些声音或念头不断在你脑中出现？'));
  assert.ok(cbtQuick.includes('什么画面触发了那种矛盾的感觉？'));
  assert.ok(
    cbtQuick.includes('时间地点____，我在做____（触发事件），我的脑子里响起____'),
    '填写模板没有换成「我的脑子里响起____」'
  );
  assert.ok(cbtQuick.includes('尽量选一个真实、具体的小场景，不需要把事情想得很大。'));
});

test('①故事线：CBT 模块与 chat 里那份逐字节相同（两边不许漂移）', () => {
  assert.equal(storyCbt, chatCbt);
});

test('①故事线：脚本化的触发话术换成了新的三问与模板', () => {
  assert.ok(chatCbt.includes('请分享一段最近让你感到心烦的情景'));
  assert.ok(chatCbt.includes('心里反复权衡利弊、还没法决定'));
  assert.ok(chatCbt.includes('哪些声音或念头不断在你脑中出现？'));
  assert.ok(chatCbt.includes('什么画面触发了那种矛盾的感觉？'));
  assert.ok(chatCbt.includes('时间地点____，我在做____（触发事件），我的脑子里响起____'));
});
