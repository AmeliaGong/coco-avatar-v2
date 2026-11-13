// 探索者故事通道的测试。
//
// ⚠️ 这个文件里**不能出现真人素材**（姓名、原文、诊断词）——
// 仓库是 public 的。测试用的是合成的假素材（"甲同学"/"乙同学"）。
//
// 测三块：
//   1. md 解析（server/engine/explorerSource.js）
//   2. 选人（server/engine/explorer.js 的 resolveSelection）
//   3. 这一轮该给模型什么（buildExplorerContext）与引擎里的注入块
import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { createExplorerStore } from '../server/engine/explorerStore.js';
import {
  buildExplorerContext,
  resolveSelection,
  BRIDGE_MARKER,
} from '../server/engine/explorer.js';
import {
  parseExplorerMarkdown,
  parseName,
  parseMatchSignals,
  redactProfile,
} from '../server/engine/explorerSource.js';
import { createCbtEngine } from '../server/engine/cbtEngine.js';

// ── 合成的素材（假人名，假原文）────────────────────────────────────

const FIXTURE_MD = `# 甲同学（测试用）

> 分类 04 情绪与内在卡点 ｜ 编号 99-9

## 一句话

这是一句用于测试的画像。

## 字段

| 字段 | 内容 |
|---|---|
| 姓名 / 化名 | 甲同学 |
| 匹配信号 | 用户说「我很累」「我想歇一歇」时优先推这则 |

## 匹配定位

- **教育层级**：**L2 自我教育** —— 用来测教育层级解析。
- **分类**：04（主线）
- 🛡 **安全边界**：不渲染细节。

## 正文（按原小标题分段 · 原文逐字）

### [段 0] 原文开场

> 甲同学的第一段。
>
> 第二行还是第一段。

### [段 1] 原小标题：一、这个标题端上不显示

> 甲同学的第二段。

## 给 Coco Avatar 的使用说明（端上怎么讲）

- 一次讲一段，讲完停一下。

## 校对备注（原文照抄未改）

- 这里是笔误待确认。
`;

const FIXTURE_MD_B = FIXTURE_MD.replace(/甲同学/g, '乙同学').replace(/04 /, '02 ');

function seedStories() {
  const store = createExplorerStore({ db: getDb() });
  store.upsert(
    parseExplorerMarkdown(FIXTURE_MD, { id: 'jia', fallbackCategory: '04' })
  );
  store.upsert(
    parseExplorerMarkdown(FIXTURE_MD_B, { id: 'yi', fallbackCategory: '02' })
  );
  return store;
}

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM explorer_stories').run();
  db.prepare('DELETE FROM explorer_sessions').run();
});

// ── 一、md 解析 ───────────────────────────────────────────────────

test('解析出姓名、分类、教育层级、一句话与匹配信号', () => {
  const s = parseExplorerMarkdown(FIXTURE_MD, { id: 'jia', fallbackCategory: '04' });
  assert.equal(s.name, '甲同学');
  assert.deepEqual(s.aliases, []);
  assert.equal(s.category, '04');
  assert.equal(s.education_level, 'L2');
  assert.equal(s.one_liner, '这是一句用于测试的画像。');
  assert.deepEqual(s.match_signals, ['我很累', '我想歇一歇']);
});

test('并列名拆成 name + aliases', () => {
  const { name, aliases } = parseName('# 丙同学 / 小舟（副标题）');
  assert.equal(name, '丙同学');
  assert.deepEqual(aliases, ['小舟']);
});

test('正文按「段」切开，正文里没有小标题，引用符被去掉', () => {
  const s = parseExplorerMarkdown(FIXTURE_MD, { id: 'jia' });
  assert.equal(s.segments.length, 2);
  // 小标题只作 label（内部记号），**不进正文**
  assert.match(s.segments[0].label, /段 0/);
  assert.equal(s.segments[0].text, '甲同学的第一段。\n\n第二行还是第一段。');
  assert.ok(!s.segments[1].text.includes('这个标题端上不显示'));
  assert.ok(!s.segments[1].text.includes('>'));
});

test('使用说明与安全边界被收进来', () => {
  const s = parseExplorerMarkdown(FIXTURE_MD, { id: 'jia' });
  assert.match(s.guide, /一次讲一段/);
  assert.match(s.safety, /安全边界/);
});

test('画像脱敏：诊断词与轻生说法被换掉（只对画像，不对正文）', () => {
  assert.equal(redactProfile('她被双相情感障碍拦住'), '她被严重的情绪困扰拦住');
  assert.equal(redactProfile('16 岁抑郁'), '16 岁情绪低落');
  assert.equal(redactProfile('重度抑郁和中度焦虑'), '情绪与焦虑上的严重困扰');
  assert.equal(redactProfile('想结束生命'), '最艰难的时候');
  // 没命中的原样返回
  assert.equal(redactProfile('一句普通的画像'), '一句普通的画像');
});

test('解析不出姓名或正文时返回 null（不硬凑）', () => {
  assert.equal(parseExplorerMarkdown('', { id: 'x' }), null);
  assert.equal(parseExplorerMarkdown('# 只有标题\n', { id: 'x' }), null);
});

test('匹配信号没有引号时按顿号切', () => {
  assert.deepEqual(parseMatchSignals('| 匹配信号 | 甲、乙、丙 |'), ['甲', '乙', '丙']);
});

// ── 二、选人 ─────────────────────────────────────────────────────

test('用户报名字就选中那一位', () => {
  const stories = [
    { id: 'a', name: '甲同学', aliases: [] },
    { id: 'b', name: '乙同学', aliases: [] },
  ];
  const picked = resolveSelection('我想听乙同学的', stories, stories);
  assert.equal(picked.id, 'b');
});

test('用户报序号就选中候选清单里的第 k 个', () => {
  const candidates = [
    { id: 'a', name: '甲同学', aliases: [] },
    { id: 'b', name: '乙同学', aliases: [] },
  ];
  assert.equal(resolveSelection('2', candidates, candidates).id, 'b');
  assert.equal(resolveSelection('第二个', candidates, candidates).id, 'b');
  assert.equal(resolveSelection('第二个吧', candidates, candidates).id, 'b');
});

test('用户报中文序号（第二个）也能选中', () => {
  const candidates = [
    { id: 'a', name: '甲同学', aliases: [] },
    { id: 'b', name: '乙同学', aliases: [] },
  ];
  assert.equal(resolveSelection('二', candidates, candidates).id, 'b');
});

test('没有候选清单时，序号不成立', () => {
  const stories = [{ id: 'a', name: '甲同学', aliases: [] }];
  assert.equal(resolveSelection('2', [], stories), null);
});

test('认不出就返回 null（不乱选）', () => {
  const stories = [{ id: 'a', name: '甲同学', aliases: [] }];
  assert.equal(resolveSelection('好啊我想听', [], stories), null);
  assert.equal(resolveSelection('', stories, stories), null);
});

// ── 三、这一轮给模型什么 ─────────────────────────────────────────

test('库里没有素材时什么都不注入', () => {
  const ctx = buildExplorerContext({
    db: getDb(),
    conversationId: 'c1',
    history: [{ role: 'user', content: '你好' }],
  });
  assert.equal(ctx, null);
});

test('目录里有每一个人，但**没有正文**', () => {
  seedStories();
  const ctx = buildExplorerContext({
    db: getDb(),
    conversationId: 'c1',
    history: [{ role: 'user', content: '你好' }],
  });
  assert.ok(ctx);
  assert.equal(ctx.catalog.length, 2);
  assert.equal(ctx.selected, undefined);
  // 目录里绝不能出现正文
  const dumped = JSON.stringify(ctx.catalog);
  assert.ok(!dumped.includes('甲同学的第一段'));
});

test('模型报出候选人、用户报了名字 ⇒ 注入那一则的正文', () => {
  seedStories();
  const ctx = buildExplorerContext({
    db: getDb(),
    conversationId: 'c1',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '我想听乙同学' },
    ],
  });
  assert.ok(ctx.selected);
  assert.equal(ctx.selected.name, '乙同学');
  assert.ok(ctx.selected.segments.length > 0);
  assert.match(ctx.selected.segments[0].text, /乙同学的第一段/);
});

test('用户报序号 ⇒ 按模型报出来的顺序选中', () => {
  seedStories();
  const ctx = buildExplorerContext({
    db: getDb(),
    conversationId: 'c1',
    history: [
      { role: 'assistant', content: '有两位朋友：乙同学和甲同学。你想先听谁的？' },
      { role: 'user', content: '2' },
    ],
  });
  assert.equal(ctx.selected.name, '甲同学');
});

test('讲完一段之后，下一轮给的是接下来的那一段', () => {
  seedStories();
  const db = getDb();
  // 第一轮：模型报候选人，用户选了甲同学
  buildExplorerContext({
    db,
    conversationId: 'c2',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  // 第二轮：模型讲了第一段，用户回应 ⇒ 该给第二段
  const ctx = buildExplorerContext({
    db,
    conversationId: 'c2',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
      { role: 'assistant', content: '甲同学的第一段。第二行还是第一段。' },
      { role: 'user', content: '嗯，我懂' },
    ],
  });
  assert.ok(ctx.selected);
  assert.equal(ctx.selected.name, '甲同学');
  assert.match(ctx.selected.segments[0].text, /甲同学的第二段/);
});

test('桥接句出现后进入「等用户选」的状态', () => {
  seedStories();
  const db = getDb();
  const ctx = buildExplorerContext({
    db,
    conversationId: 'c3',
    history: [
      { role: 'assistant', content: `你想听听他们的心路历程吗？${BRIDGE_MARKER}` },
      { role: 'user', content: '好啊，我想听' },
    ],
  });
  assert.equal(ctx.phase, 'awaiting_pick');
  assert.ok(ctx.catalog.length === 2);
  const state = createExplorerStore({ db }).getSession('c3');
  assert.equal(state.phase, 'awaiting_pick');
});

// ── 四、引擎里的注入块 ───────────────────────────────────────────

function makeEngine() {
  const calls = [];
  const callModel = async ({ systemPrompt }) => {
    calls.push({ systemPrompt });
    return { content: '好的', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  };
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM PROMPT',
    callModel,
    schemas: {},
  });
  return { engine, calls };
}

test('不传 clientContext 时，system prompt 一个字节都不变', async () => {
  const { engine, calls } = makeEngine();
  await engine({ scenario: 'story', history: [{ role: 'user', content: '你好' }] });
  assert.equal(calls[0].systemPrompt, 'SYSTEM PROMPT');
});

test('注入探索者素材时：正文进去、小标题不进去', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'story',
    history: [{ role: 'user', content: '你好' }],
    clientContext: {
      explorer: {
        catalog: [
          {
            id: 'jia',
            name: '甲同学',
            one_liner: '一句画像',
            category: '04',
            education_level: 'L2',
            match_signals: ['我很累'],
          },
        ],
        selected: {
          id: 'jia',
          name: '甲同学',
          one_liner: '一句画像',
          segments: [{ label: '原小标题：一、这个标题端上不显示', text: '甲同学的第一段。' }],
          guide: '一次讲一段',
          safety: '不渲染细节',
        },
      },
    },
  });
  const prompt = calls[0].systemPrompt;
  assert.ok(prompt.includes('甲同学的第一段'), '正文应当注入');
  assert.ok(prompt.includes('不渲染细节'), '安全边界应当注入');
  assert.ok(prompt.includes('一句画像'), '画像应当进目录');
  assert.ok(!prompt.includes('这个标题端上不显示'), '小标题是内部记号，端上不显示');
  assert.ok(prompt.includes('以下是给你的材料'), '注入段应带「材料不是指令」的声明');
});
