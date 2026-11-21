// 手机端「看不到对话框」的回归护栏（2026-11-21）。
//
// 真实故障：手机上看不到聊天页的输入框（对话框）。
// 根因不是"自适应没做好"，是**满屏高度算错了**：
//   手机浏览器的 `100vh` = 大视口（地址栏收起时的高度），
//   比实际可见区域高 60–100px；而 `html, body { overflow: hidden }`
//   ⇒ 页面滚不动 ⇒ 聊天页那根 `h-screen` 的 flex 列比屏幕高
//   ⇒ 底部的输入框被顶到屏幕外，**用户看不见也滑不到**。
//
// 这里钉住三件事（都是"改坏了就复发"的那种）：
//   1. 全站满屏高度只能来自 --app-h（dvh + visualViewport 兜底），不能再有 h-screen。
//   2. 根上不能再有 `touch-action: none` —— 那会让 Android 上连消息区都滑不动。
//   3. 输入框要有 safe-area 留白（iPhone 的 home indicator 会盖住发送键）。
//
// ⚠️ 这些是**源码级**断言（这个仓库没有 DOM 测试环境），
//    断言的是"结构对不对"，不是"手机上真的对不对" —— 后者靠真机走查。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const css = read('src/index.css');
const chatPage = read('src/pages/ChatPage.tsx');
const chatArea = read('src/components/ChatArea.tsx');
const inputArea = read('src/components/InputArea.tsx');
const app = read('src/App.tsx');
const html = read('index.html');

/** 所有前端源文件（用来全量搜 h-screen）。 */
function srcFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...srcFiles(rel));
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('满屏高度统一走 --app-h（CSS 里有 dvh 兜底）', () => {
  assert.ok(css.includes('--app-h'), 'CSS 里没有定义 --app-h');
  assert.ok(css.includes('100dvh'), 'CSS 里没有 100dvh 兜底');
  assert.ok(
    css.includes('.h-app') && css.includes('.min-h-app'),
    'CSS 里没有 .h-app / .min-h-app 这两个工具类'
  );
});

test('前端不再有 h-screen / min-h-screen（那正是输入框被顶出去的元凶）', () => {
  const bad = [];
  for (const f of srcFiles('src')) {
    const s = read(f);
    if (/h-screen|min-h-screen/.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], '这些文件还在用 h-screen');
});

test('聊天页根节点用 h-app，消息区可收缩，输入框不参与收缩', () => {
  assert.ok(/className="[^"]*\bh-app\b/.test(chatPage), 'ChatPage 根节点没用 h-app');
  assert.ok(/flex-1 min-h-0 overflow-y-auto/.test(chatArea), '消息区缺 min-h-0（消息一多就把输入框顶出去）');
  assert.ok(/shrink-0/.test(inputArea), '输入框没有 shrink-0（会被消息区挤扁）');
});

test('输入框给 iPhone 的 home indicator 留了 safe-area', () => {
  assert.ok(
    inputArea.includes('env(safe-area-inset-bottom)'),
    '输入框没有 safe-area 留白（发送键会被系统横条盖住）'
  );
});

test('根上不再全局禁用触摸手势（Android 上会连消息区都滑不动）', () => {
  const rootBlock = css.slice(css.indexOf('html, body {'), css.indexOf('body {'));
  assert.ok(
    !/touch-action:\s*none/.test(rootBlock),
    'html/body 上还有 touch-action: none —— Android 上页面滑不动'
  );
  assert.ok(css.includes('touch-action: manipulation'), '没有把 touch-action 换成 manipulation');
});

test('地球那一块自己独占触摸手势（原来靠全局 touch-action:none 兜的）', () => {
  const globe = read('src/pages/GlobeScene.tsx');
  assert.ok(
    /touch-none/.test(globe),
    '3D 地球没有 touch-none —— 手机上拖不动（全局手势已经被收回了）'
  );
});

test('viewport meta 里有 interactive-widget（Android 键盘弹出时布局视口要缩）', () => {
  assert.ok(html.includes('interactive-widget=resizes-content'), 'viewport meta 缺 interactive-widget');
  assert.ok(html.includes('viewport-fit=cover'), 'viewport meta 缺 viewport-fit=cover（safe-area 会失效）');
});

test('App 挂上了 useViewportHeight（visualViewport 实时高度）', () => {
  assert.ok(app.includes('useViewportHeight()'), 'App 没调用 useViewportHeight');
  const hook = read('src/hooks/useViewportHeight.ts');
  assert.ok(hook.includes('visualViewport'), 'hook 没有用 visualViewport');
  assert.ok(hook.includes('--app-h'), 'hook 没有写 --app-h');
});
