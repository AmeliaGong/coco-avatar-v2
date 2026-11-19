// ⚠️ 三个入口必须是三个**不同的场景** —— 这条曾经真的坏过：
//
// ②「我想做出改变但遇到卡点」和 ③「我有一个微创业想法」原来都走 `chat`，
// 而 `prompts/scenario.chat.md` 的**开头就是「【故事模式】+ Coco 的 9 段故事素材」**
// ⇒ 真模型在②③里会先去讲故事（本地预览时复现过：点③回的是 Coco 的故事）。
//
// 所以：② 走 `cbt_quick`、③ 走 `idea`，各给各的 prompt。
// 这个测试就是防止有人把②③改回 `chat`（或往新 prompt 里塞进故事素材）。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPromptRegistry } from '../server/promptRegistry.js';
import { getDb } from '../db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('idea 场景的 prompt 里没有 Coco 的故事素材（③ 绝不讲自己的故事）', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const prompt = registry.getPrompt('idea');
  assert.ok(prompt.includes('跨学科'), 'idea 场景要有跨学科视角');
  assert.ok(prompt.includes('一次只问一个问题'), 'idea 场景要一次只问一个问题');
  assert.equal(
    prompt.includes('阿里公司的那个夏天'),
    false,
    'idea 场景不能含 Coco 的故事素材 —— ③ 点了是要谈自己的想法，不是听故事'
  );
  assert.equal(prompt.includes('故事素材'), false, 'idea 场景不该出现「故事素材」这类内部标记');
});

test('chat 场景确实以「故事模式」开头（这就是②③不能走 chat 的原因）', () => {
  const chat = read('prompts/scenario.chat.md');
  assert.ok(chat.includes('【故事模式】'), 'chat 场景开头是故事模式');
  assert.ok(
    chat.includes('阿里公司的那个夏天'),
    'chat 场景里带着 Coco 的故事素材 —— 走 chat 的入口会被带去讲故事'
  );
});

test('三个入口按钮各自指向自己的场景', () => {
  const src = read('src/components/QuickActions.tsx');
  const entry = (label) => {
    const i = src.indexOf(`label: '${label}'`);
    assert.ok(i >= 0, `找不到入口按钮：${label}`);
    const block = src.slice(i, i + 400);
    const m = block.match(/scenario: '([a-z_]+)'/);
    assert.ok(m, `${label} 没有指定场景`);
    return m[1];
  };
  assert.equal(entry('听听 Coco 和探索者们的故事'), 'story');
  assert.equal(entry('我想做出改变但遇到卡点'), 'cbt_quick');
  assert.equal(entry('我有一个微创业想法'), 'idea');
});

test('探索者体验入口 /e/explorer 走 story 场景（目录只在 story 场景注入）', () => {
  const src = read('src/pages/ExplorerEntry.tsx');
  assert.ok(src.includes("scenario: 'story'"), '体验入口必须走 story 场景');
  assert.ok(src.includes('createConversation'), '体验入口要先建会话再进页面');
  const app = read('src/App.tsx');
  assert.ok(app.includes('/e/explorer'), 'App.tsx 里要注册 /e/explorer 路由');
});

test('落地页「和 Coco 聊聊」不再是写死的 /c/demo（那个 id 不存在 ⇒ 一点就跳过期页）', () => {
  const src = read('src/pages/LandingPage.tsx');
  assert.equal(src.includes('/c/demo'), false, '不能写死 /c/demo —— 库里没这个会话');
  assert.ok(src.includes('createConversation'), '要先建会话再跳 /c/:id');
});
