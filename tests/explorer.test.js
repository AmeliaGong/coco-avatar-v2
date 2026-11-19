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
  const { name, aliases } = parseName('# 丙同学 / 小丙（副标题）');
  assert.equal(name, '丙同学');
  assert.deepEqual(aliases, ['小丙']);
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

// ── 五、显式的结束标记（2026-11-13）─────────────────────────────
//
// 为什么要有：素材讲完之后，服务端本来会**一直重复注入最后一段**
// （start 被 Math.min 夹在最后一段上）⇒ 模型只能自己从「这次只给了一段」
// 推断出「讲完了」。那是推断，不是信号 —— 换个模型就可能反复重讲。
//
// 现在改成两件事：
//   ① 这一轮要讲的正好是最后一段时，素材里带**显式标记**；
//   ② 全部讲完之后进入「收口态」，**不再重复注入**最后一段。

test('中间段不是最后一段（不标记）', () => {
  seedStories();
  const db = getDb();
  const ctx = buildExplorerContext({
    db,
    conversationId: 'f1',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  assert.ok(ctx.selected);
  assert.equal(ctx.selected.is_final, false, '第一段不是最后一段');
});

test('讲到最后一段时，素材里带显式的结束标记', () => {
  seedStories();
  const db = getDb();
  // 先选人（甲同学共 2 段）
  buildExplorerContext({
    db,
    conversationId: 'f2',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  // 讲完第一段后 ⇒ 这一轮讲的是第二段 = 最后一段
  const ctx = buildExplorerContext({
    db,
    conversationId: 'f2',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
      { role: 'assistant', content: '甲同学的第一段。第二行还是第一段。' },
      { role: 'user', content: '嗯，我懂' },
    ],
  });
  assert.ok(ctx.selected);
  assert.equal(ctx.selected.is_final, true, '讲最后一段时要明确标记');
  assert.match(ctx.selected.segments[0].text, /甲同学的第二段/);
});

test('全部讲完之后进入收口态：**不再重复注入**最后一段', () => {
  seedStories();
  const db = getDb();
  const base = [
    { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
    { role: 'user', content: '甲同学' },
    { role: 'assistant', content: '甲同学的第一段。第二行还是第一段。' },
    { role: 'user', content: '嗯，我懂' },
    { role: 'assistant', content: '甲同学的第二段。' },
    { role: 'user', content: '很感动' },
  ];
  buildExplorerContext({ db, conversationId: 'f3', history: base.slice(0, 2) });
  const ctx = buildExplorerContext({ db, conversationId: 'f3', history: base });
  assert.equal(ctx.phase, 'closing', '讲完就该收口');
  assert.equal(ctx.selected, undefined, '收口态不再注入正文');
  assert.ok(ctx.catalog.length > 0, '目录还在（用户可以换人）');
  const state = createExplorerStore({ db }).getSession('f3');
  assert.equal(state.phase, 'closing');
});

test('结束标记进了 prompt（模型看得见「这是最后一段」）', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'story',
    history: [{ role: 'user', content: '你好' }],
    clientContext: {
      explorer: {
        catalog: [],
        selected: {
          id: 'jia',
          name: '甲同学',
          one_liner: '一句画像',
          segments: [{ text: '甲同学的第一段。' }],
          guide: '一次讲一段',
          safety: '不渲染细节',
          is_final: true,
        },
      },
    },
  });
  const prompt = calls[0].systemPrompt;
  assert.ok(prompt.includes('最后一段'), '结束标记应当出现在 prompt 里');
  assert.ok(prompt.includes('收口'), '结束标记要写明接下来是收口');
  // 2026-11-19 线上实测：最后一段时模型**只发了收口那一问**、
  // 把 326 字的原文整段漏掉了 ⇒ 这一轮的产物只剩 35 字。
  // 根因是指令只说了「讲完原文后只问这一句」，模型可以只执行后半句。
  // ⇒ 结束标记必须写死**顺序**：先讲原文，再问。
  assert.ok(
    /先.{0,6}讲.{0,8}原文.{0,20}再.{0,6}问|先讲原文，再问/.test(prompt),
    '结束标记要写死顺序：先逐字讲完原文，再问收口那一问'
  );
});

// ── 2026-11-19：模型把一段**讲成了简介**时，不能因此跳过原文 ──────
//
// 线上真实故障：用户选了某一位探索者，模型第一轮回了一段"人物简介"（不是原文）。
// 按轮数算，"那一轮"就算讲过一段 ⇒ 下一轮直接给第 2 段
// ⇒ **第 1 段的原文被整段跳过**，用户只读到简介，然后模型还说
// "完整原文素材没有加载到我这里"。

test('模型把第一段讲成了简介 ⇒ 下一轮仍然给第 1 段（不跳过原文）', () => {
  seedStories();
  const db = getDb();
  buildExplorerContext({
    db,
    conversationId: 'c9',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  // 第二轮：模型把第一段**总结**了（没有逐字复述原文）
  const ctx = buildExplorerContext({
    db,
    conversationId: 'c9',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
      { role: 'assistant', content: '甲同学是个测试用的人，她的第一段大概讲的是开头。' },
      { role: 'user', content: '太短了' },
    ],
  });
  assert.ok(ctx.selected, '这一轮仍然要有素材');
  assert.equal(ctx.selected.name, '甲同学');
  assert.match(
    ctx.selected.segments[0].text,
    /甲同学的第一段/,
    '讲成简介之后，下一轮要重讲第 1 段的原文，而不是跳到第 2 段'
  );
  assert.equal(ctx.selected.retry, true, '要告诉模型"上一轮没逐字讲出来，请重讲"');
});

test('逐字讲完一段之后，下一轮给下一段，且不再要 retry', () => {
  seedStories();
  const db = getDb();
  buildExplorerContext({
    db,
    conversationId: 'c10',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  const ctx = buildExplorerContext({
    db,
    conversationId: 'c10',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
      { role: 'assistant', content: '甲同学的第一段。第二行还是第一段。' },
      { role: 'user', content: '嗯，我懂' },
    ],
  });
  assert.match(ctx.selected.segments[0].text, /甲同学的第二段/);
  assert.equal(ctx.selected.retry, false, '正常讲过就不该再要求重讲');
});

// ── 2026-11-19：段首是**标题**时，模型跳过它也要算"讲过了" ──────────
//
// 线上真实故障：原文第 1 段以「文章大标题 + 第一个小标题」开头，
// 模型**正确地**跳过了那两行（那是标题，不是故事）。
// 而"讲过了"原先是拿**开头 8 个字**当指纹的 ⇒ 指纹永远对不上
// ⇒ 服务端永远重讲第 1 段 ⇒ 第 3、4、5 段永远轮不到
// ⇒ 用户只读到两段，模型就自己收口了。
//
// 现在改成**段内分布的窗口**判定：跳过开头不影响判定。

const TITLE_HEAD_MD = `# 乙同学（测试用）

> 分类 02 亲密关系 ｜ 编号 99-8

## 一句话

这是一句用于测试的画像。

## 字段

| 字段 | 内容 |
|---|---|
| 姓名 / 化名 | 乙同学 |
| 匹配信号 | 用户说「我想听故事」时优先推这则 |

## 匹配定位

- **教育层级**：**L2 自我教育** —— 用来测教育层级解析。
- **分类**：02（主线）

## 正文（按原小标题分段 · 原文逐字）

### [段 0] 原文标题与开场

> 乙同学的生命故事：一段用来测标题被跳过的正文。

> 一、开场：一次近乎莽撞的决定

> 正文第一句从这里开始，正文第一句从这里开始，正文第一句从这里开始，正文第一句从这里开始。

### [段 1] 原小标题：二、接下来的事

> 第二段的正文，第二段的正文，第二段的正文，第二段的正文，第二段的正文，第二段的正文。

## 给 Coco Avatar 的使用说明（端上怎么讲）

- 一次讲一段，讲完停一下。

## 校对备注（原文照抄未改）

- 这里是笔误待确认。
`;

function seedTitleStory() {
  const store = createExplorerStore({ db: getDb() });
  store.upsert(
    parseExplorerMarkdown(TITLE_HEAD_MD, { id: 'yi2', fallbackCategory: '02' })
  );
  return store;
}

test('段首是标题、模型跳过标题 ⇒ 照样判定"讲过了"，给下一段', () => {
  seedTitleStory();
  const db = getDb();
  // 模型讲了第 1 段，但**跳过了开头两行标题**（正确做法）
  const said = '正文第一句从这里开始，正文第一句从这里开始，正文第一句从这里开始，正文第一句从这里开始。';
  buildExplorerContext({
    db,
    conversationId: 't1',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '乙同学' },
    ],
  });
  const ctx = buildExplorerContext({
    db,
    conversationId: 't1',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '乙同学' },
      { role: 'assistant', content: said },
      { role: 'user', content: '嗯' },
    ],
  });
  assert.ok(ctx.selected);
  assert.match(
    ctx.selected.segments[0].text,
    /第二段的正文/,
    '跳过标题也算讲过了 ⇒ 下一轮该给第 2 段，而不是重讲第 1 段'
  );
  assert.equal(ctx.selected.retry, false, '讲过了就不该再要求重讲');
});

test('一轮只给一段（不给两段）：「第 1 段」与「下一段」必须指同一段', () => {
  seedStories();
  const db = getDb();
  const ctx = buildExplorerContext({
    db,
    conversationId: 't2',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  assert.equal(ctx.selected.segments.length, 1, '一轮只给一段');
  assert.match(ctx.selected.segments[0].text, /甲同学的第一段/);
});

test('注入的段号是**真实序号**，不是永远「第 1 段」', () => {
  // 线上真实故障（2026-11-19）：一轮只给一段，标记按"本轮第 1 个"算 ⇒
  // **每一轮的标记都是【第1段】**。模型讲到第 3 轮时看到的还是「第 1 段」，
  // 而对话里第 1 段早就讲过了 ⇒ 它以为这一段讲过了 ⇒ 改写成概述
  // （实测第 3 段起就不再逐字讲，第 4～5 段干脆没讲）。
  // ⇒ 标记必须带真实序号：第 N 段（共 M 段）。
  seedStories();
  const db = getDb();
  const first = buildExplorerContext({
    db,
    conversationId: 't2b',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  assert.equal(first.selected.segmentNo, 1, '选人那轮是第 1 段');
  assert.ok(first.selected.segmentTotal >= 2, '总数要是整则故事的段数');

  const second = buildExplorerContext({
    db,
    conversationId: 't2b',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
      { role: 'assistant', content: '甲同学的第一段。第二行还是第一段。' },
      { role: 'user', content: '继续' },
    ],
  });
  assert.equal(second.selected.segmentNo, 2, '第 2 轮该标「第 2 段」');
  assert.equal(second.selected.segmentTotal, first.selected.segmentTotal);
});

test('prompt 里的段标记带真实序号（第 2 段不能还写成「第 1 段」）', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'story',
    history: [{ role: 'user', content: '你好' }],
    clientContext: {
      explorer: {
        catalog: [],
        selected: {
          id: 'jia',
          name: '甲同学',
          one_liner: '一句画像',
          segments: [{ text: '甲同学的第三段。' }],
          guide: '一次讲一段',
          safety: '不渲染细节',
          is_final: false,
          segmentNo: 3,
          segmentTotal: 5,
        },
      },
    },
  });
  const prompt = calls[0].systemPrompt;
  assert.ok(prompt.includes('【第3段'), '标记要写第 3 段');
  assert.ok(prompt.includes('共5段'), '标记要写总共 5 段');
});

test('「介绍」（人物卡）与故事段分开：介绍只给一次，且不进故事段序列', () => {
  seedStories();
  const db = getDb();
  const first = buildExplorerContext({
    db,
    conversationId: 't3',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
    ],
  });
  assert.equal(first.selected.intro, null, '没有人物卡 ⇒ 没有介绍');
  const second = buildExplorerContext({
    db,
    conversationId: 't3',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和乙同学。你想先听谁的？' },
      { role: 'user', content: '甲同学' },
      { role: 'assistant', content: '甲同学的第一段。第二行还是第一段。' },
      { role: 'user', content: '嗯' },
    ],
  });
  assert.equal(second.selected.intro, null, '介绍只在选人那一轮给');
});

// ── 编辑说明不进正文（2026-11-19）────────────────────────────────
//
// 素材的正文里混着写给端上的说明（「**端上处理**：……」）。
// 它们一旦进 prompt，模型就会**照着念出来** ——
// 用户读到的是"这是写给端上的说明"。

const EDITORIAL_MD = `# 丙同学（测试用）

> 分类 04 情绪与内在卡点 ｜ 编号 99-7

## 一句话

这是一句用于测试的画像。

## 字段

| 字段 | 内容 |
|---|---|
| 姓名 / 化名 | 丙同学 |
| 匹配信号 | 用户说「我累了」时优先推这则 |

## 匹配定位

- **教育层级**：**L2 自我教育** —— 用来测教育层级解析。
- **分类**：04（主线）

## 人物卡（原文开篇 · 端上作为人物简介）

> 丙同学，一个用来测人物卡解析的人。

## 正文（按原小标题分段 · 原文逐字）

### [段 0] 原文开篇人物卡（见上「人物卡」）

> **端上处理**：人物卡，不是故事。用"Coco 介绍丙同学是谁"2-3 句带过。

### [段 1] 原小标题：一、正文从这里开始

> 【生命故事】
>
> 正文的第一句，正文的第一句，正文的第一句，正文的第一句，正文的第一句。
>
> ---
>
> ▲游离的黑暗时期：20岁之前

## 给 Coco Avatar 的使用说明（端上怎么讲）

- 一次讲一段，讲完停一下。

## 校对备注（原文照抄未改）

- 这里是笔误待确认。
`;

test('「端上处理」这类编辑说明不进正文', () => {
  const s = parseExplorerMarkdown(EDITORIAL_MD, { id: 'bing', fallbackCategory: '04' });
  const dumped = JSON.stringify(s.segments);
  assert.ok(!dumped.includes('端上处理'), '编辑说明不能进正文');
  assert.ok(!dumped.includes('【生命故事】'), '结构标签不能进正文');
  assert.ok(!dumped.includes('---'), '分隔线不能进正文');
  assert.ok(!dumped.includes('▲'), '排版注解不能进正文');
});

test('人物卡段被标成「介绍」，故事段序列从正文开始', () => {
  const s = parseExplorerMarkdown(EDITORIAL_MD, { id: 'bing', fallbackCategory: '04' });
  const intro = s.segments.find(x => x.kind === 'intro');
  assert.ok(intro, '第 0 段是人物卡 ⇒ 标成介绍');
  assert.match(intro.text, /丙同学，一个用来测人物卡解析的人/, '介绍用人物卡的正文');
  const story = s.segments.filter(x => x.kind !== 'intro');
  assert.equal(story.length, 1);
  assert.match(story[0].text, /正文的第一句/);
});

test('「介绍」段不占故事段的位置：选人那轮同时给介绍与第 1 段', () => {
  const store = createExplorerStore({ db: getDb() });
  store.upsert(parseExplorerMarkdown(EDITORIAL_MD, { id: 'bing', fallbackCategory: '04' }));
  const db = getDb();
  const ctx = buildExplorerContext({
    db,
    conversationId: 't4',
    history: [
      { role: 'assistant', content: '有两位朋友：甲同学和丙同学。你想先听谁的？' },
      { role: 'user', content: '丙同学' },
    ],
  });
  assert.ok(ctx.selected.intro, '这一轮要有介绍');
  assert.match(ctx.selected.intro, /丙同学，一个用来测人物卡解析的人/);
  assert.equal(ctx.selected.segments.length, 1);
  assert.match(ctx.selected.segments[0].text, /正文的第一句/);
  assert.equal(ctx.selected.is_final, true, '只有一段故事 ⇒ 这一轮就是最后一段');
});
