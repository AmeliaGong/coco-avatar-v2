# Coco Avatar 底座改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Coco Avatar 从「单体 server.js + 写死的 prompt」改造成「可测试、可版本化 prompt、可被小程序调用的引擎」，为随后的教练交付模块打好地基，且**部署后对现有用户的对话行为零变化**。

**Architecture:** 引入零依赖的 `node:test` 测试基建；把 `server.js` 改为可被测试导入的 app；把 230 行的 `SYSTEM_PROMPT` 迁到 `prompts/*.md` 文件 + `prompt_scenarios` 数据库覆盖层（Prompt Registry）；把 `/api/chat` 里的 prompt 拼装、模型调用、结构化输出解析抽成 HTTP 无关的 `runCbt()` 引擎。

**Tech Stack:** Node.js 原生 `node:test` / `node:assert`（零新依赖）、Express 4、better-sqlite3、MiniMax-M2.7（`api.minimax.chat`）、Vite + React 18（前端，本计划基本不动）

**依据规格：** `docs/superpowers/specs/2026-10-24-coco-avatar-coach-delivery-design.md` §5.2、§6、§7、§13

---

## 本计划的范围与后续计划

规格里的「阶段 0」包含 5 项工作量悬殊的部分。按「每个计划独立产出可运行、可测试的软件」的原则，阶段 0 拆成 4 个计划：

| 计划 | 内容 | 状态 |
|---|---|---|
| **计划 1（本文）** | 测试基建 · 服务可测试化 · 契约模块 · Prompt Registry · CBT Engine 抽离 · 知识库检索 · 内部服务鉴权 | **本计划** |
| 计划 2 | 交付模块后端：`clients` / `stuck_points` / `plans` / `practices` / `evidences` 表 + 客户档案 API + 方案生命周期 API + 契约 3 的 `POST /api/internal/clients` | 待写 |
| 计划 3 | 教务后台前端（客户档案页 / 方案编辑器 / 知识库录入 / prompt 版本切换）+ 用户端方案页 + 证据回填 | 待写 |
| 计划 4 | 音频上传与转写（OpenRouter whisper-1）· 会话导出（Markdown + JSON）· 契约 3 的支付回调联调 | 待写 |

**计划 1 的完成标志**：现有对话行为在生产上**逐字节不变**，同时代码具备可测试、可扩展、可被外部系统调用的地基。

### 与规格的偏离（两处，均为缩小范围）

1. 规格 §6.2 列了 `scenario.story.md`。本计划**不单独建** —— 故事模式已包含在 `scenario.chat.md` 里，单独拆会产生内容重复。等小程序橱窗真的需要独立的「只讲故事」场景时再拆。
2. 规格 §6.2 未列 `scenario.chat.md`。本计划**新增**它 —— 它承载当前生产的默认对话行为（故事模式 + CBT 7 步 + 自由对话），必须原样保留以保证零回归。

---

## 全局约定

- **工作目录**：`/Users/cocogong/coco-startup/coco-avatar-main`
- **测试命令**：`npm test`
- **零新依赖**：本计划不新增任何 npm 包。测试用 Node 内置 `node:test`。原因：Dockerfile 里 `npm prune --production` 会删掉 devDependencies，测试依赖必须随运行时存在或完全不需要。
- **部署命令**（固定，只在 Task 10 使用）：
  ```bash
  flyctl deploy --app coco-avatar-icy-sun-5917 --config /Users/cocogong/coco-startup/coco-avatar-main/fly.toml
  ```
  ⚠️ 绝不在 `/Users/cocogong/coco-startup/coco-avatar` 目录下执行 —— 那是另一个同名 app 的 Next.js 项目，部署会覆盖线上 Vite 版本。
- **密钥纪律**：任何密钥、token、密码都不得出现在命令行字面量里，不得打印到输出里。

---

## File Structure

| 路径 | 职责 |
|---|---|
| `server/promptRegistry.js` | Prompt 的装配与版本覆盖。文件是兜底真相源，DB 里的激活版本优先 |
| `server/contracts/stuckPoint.js` | 契约 1：`stuck_point` 结构、校验、归一化 |
| `server/contracts/plan.js` | 契约 2：教练分析产出（方案 payload）的结构、校验、归一化 |
| `server/engine/modelClient.js` | MiniMax 调用封装，可注入 `fetchImpl` 以便测试 |
| `server/engine/structuredOutput.js` | 结构化输出的指令拼装、定位、剥离、解析 |
| `server/engine/cbtEngine.js` | `runCbt()` —— HTTP 无关的引擎，编排 prompt 与模型调用 |
| `server/engine/knowledge.js` | 知识库检索与按场景注入 |
| `server/auth.js` | `requireAdmin`（从 server.js 迁出）、`requireInternal`（新增） |
| `prompts/persona.base.md` | 人格底座 v1（与生产字节一致） |
| `prompts/persona.v2.md` | 人格底座增强版（含边界与转化原则），v2 种子，**默认不激活** |
| `prompts/scenario.chat.md` | 生产默认对话场景（故事模式 + CBT 7 步），与生产字节一致 |
| `prompts/scenario.cbt_quick.md` | 急救箱场景（5 步单向链，问答完成即主动终止） |
| `prompts/scenario.cbt_delivery.md` | 教练交付场景 |
| `prompts/scenario.analysis.md` | 教练分析场景（转写 → 契约 2 的 JSON） |
| `tests/fixtures/legacy-chat-prompt.txt` | 黄金文件：生产 prompt 的快照，用于字节级回归断言 |
| `tests/helpers/testEnv.js` | 测试环境（临时 DB 路径、假密钥），**必须最先被 import** |
| `tests/helpers/testDb.js` | 测试库清空 |
| `tests/helpers/testServer.js` | 在随机端口启动 app 并提供 `fetch` |

---

### Task 1: 测试基建（零依赖 `node:test`）

**Files:**
- Create: `tests/helpers/testEnv.js`
- Create: `tests/helpers/testDb.js`
- Create: `tests/smoke.test.js`
- Modify: `package.json`（新增 `scripts.test`）

- [ ] **Step 1: 在 package.json 加上 test 脚本**

修改 `package.json` 的 `scripts`，在 `"start"` 之后加入：

```json
    "test": "node --test tests/*.test.js"
```

（脚本本身不是实现，先加上才能让 `npm test` 跑起来。）

- [ ] **Step 2: 写失败的测试**

创建 `tests/smoke.test.js`：

```js
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';

test('测试库建在临时目录，不污染 data/coco.db', () => {
  assert.ok(process.env.DB_PATH.includes('coco-test-'), 'DB_PATH 未指向临时目录');
  const db = getDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(r => r.name);
  assert.ok(names.includes('conversations'));
  assert.ok(names.includes('messages'));
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— 报错包含 `Error: Cannot find module '.../tests/helpers/testEnv.js'`，因为该文件尚未创建。

- [ ] **Step 4: 创建测试环境助手**

创建 `tests/helpers/testEnv.js`：

```js
// 必须在任何会 import db.js 的模块之前被加载。
// ESM 的模块求值顺序遵循 import 顺序，所以只要这个文件排在第一位，
// process.env.DB_PATH 就一定在 db.js 求值前被设置好。
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DB_PATH = path.join(os.tmpdir(), `coco-test-${randomUUID()}.db`);
process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'test-key-not-used';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin';
process.env.INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';
// 指向一个不可达的本地端口：测试里的对话请求会立刻失败（不产生网络流量、不会挂起）。
process.env.MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'http://127.0.0.1:9/unreachable';
```

创建 `tests/helpers/testDb.js`：

```js
import { getDb } from '../../db.js';

const TABLES = [
  'messages',
  'token_usage',
  'admin_sessions',
  'stories',
  'conversations',
];

export function resetDb() {
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  for (const t of TABLES) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.pragma('foreign_keys = ON');
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— 输出包含 `ℹ pass 1`、`ℹ fail 0`。

- [ ] **Step 6: 提交**

```bash
git add package.json tests/helpers/testEnv.js tests/helpers/testDb.js tests/smoke.test.js
git commit -m "test: 引入零依赖 node:test 基建与临时库隔离"
```

---

### Task 2: 让 `server.js` 可被测试导入

**Files:**
- Modify: `server.js:238-241`（`__dirname` 定义之后）、`server.js:681-683`（listen 处）
- Test: `tests/api.conversations.test.js`

**背景：** 现在 `server.js` 在模块顶层直接 `app.listen()`，任何 `import` 它的测试都会占住 8080 端口并阻塞。改成「只有作为入口文件被运行时才 listen」。

- [ ] **Step 1: 写失败的测试**

创建 `tests/api.conversations.test.js`：

```js
import './helpers/testEnv.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server.close());

test('POST /api/conversations 创建会话并返回 id', async () => {
  resetDb();
  const res = await fetch(`${base}/api/conversations`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.id, /^[0-9a-f-]{36}$/);
});

test('GET /api/conversations/:id 返回该会话与消息', async () => {
  resetDb();
  const created = await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json();
  const res = await fetch(`${base}/api/conversations/${created.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, created.id);
  assert.deepEqual(body.messages, []);
});

test('管理接口未带 token 时返回 401', async () => {
  const res = await fetch(`${base}/api/admin/conversations`);
  assert.equal(res.status, 401);
});

test('管理员登录密码错误时返回 401', async () => {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../tests/helpers/testServer.js'`。

- [ ] **Step 3: 创建测试服务器助手**

创建 `tests/helpers/testServer.js`：

```js
import { app } from '../../server.js';

// 在随机端口启动 app，返回 baseUrl 与关闭函数。
export async function createServer() {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
```

- [ ] **Step 4: 改造 server.js 使其可导入**

修改 `server.js` 顶部导入区（第 5 行之后）加入：

```js
import { pathToFileURL } from 'url';
```

修改 `server.js` 第 674 行之前、`app.use(express.static(...))` 之后，把文件末尾的 listen 段替换为：

```js
// 只有当本文件是进程入口时才启动监听器。
// 这样测试可以 import app 而不会占用端口。
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ pass 4`、`ℹ fail 0`。

- [ ] **Step 6: 手工验证生产启动路径没坏**

Run: `MINIMAX_API_KEY=dummy PORT=8099 node server.js & sleep 1; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8099/api/conversations -X POST; kill %1`
Expected: 输出 `200`（证明入口检测生效，服务照常启动）。

- [ ] **Step 7: 提交**

```bash
git add server.js tests/api.conversations.test.js tests/helpers/testServer.js
git commit -m "refactor: server.js 改为可导入，listen 仅在入口时执行"
```

---

### Task 3: 契约模块（契约 1 与契约 2 的代码化）

**Files:**
- Create: `server/contracts/stuckPoint.js`
- Create: `server/contracts/plan.js`
- Test: `tests/contracts.test.js`

**背景：** 规格 §4 的契约 1（`stuck_point` 结构）与契约 2（教练分析 JSON schema）是 M1 写 CBT Prompt 的前置依赖。这里把它们变成可执行的代码 —— 既校验模型输出，也作为喂给模型的 schema 提示。

- [ ] **Step 1: 写失败的测试**

创建 `tests/contracts.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStuckPoint, normalizeStuckPoint } from '../server/contracts/stuckPoint.js';
import { validatePlanPayload, normalizePlanPayload } from '../server/contracts/plan.js';

test('stuck_point：完整结构通过校验', () => {
  const ok = validateStuckPoint({
    title: '我不能停下来，因为一旦停下来就会被抛弃',
    belief: '停下来就会被抛弃',
    evidence_against: ['上周请假一天，年底考核并没有变差'],
    emotion: '焦虑',
    micro_action: '今天记录一次「我可以慢下来」的时刻',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
});

test('stuck_point：缺少 title 报错', () => {
  const ok = validateStuckPoint({ belief: 'x' });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('title')));
});

test('stuck_point：normalize 把 evidence_against 补成数组', () => {
  const n = normalizeStuckPoint({
    title: '  卡点  ',
    evidence_against: '只有一条证据',
  });
  assert.equal(n.title, '卡点');
  assert.deepEqual(n.evidence_against, ['只有一条证据']);
  assert.deepEqual(n.belief, '');
  assert.deepEqual(n.emotion, '');
  assert.deepEqual(n.micro_action, '');
});

test('plan：worth_practicing 为 false 时 practices 允许为空', () => {
  const ok = validatePlanPayload({
    diagnosis: { core_belief: 'a', pattern: 'b', root_cause: 'c' },
    vision: { title: 't', narrative: 'n', horizon: '1_year' },
    practices: [],
    worth_practicing: false,
  });
  assert.equal(ok.ok, true);
});

test('plan：缺少 diagnosis 报错', () => {
  const ok = validatePlanPayload({ vision: { title: 't', narrative: 'n', horizon: '1_year' } });
  assert.equal(ok.ok, false);
  assert.ok(ok.errors.some(e => e.includes('diagnosis')));
});

test('plan：vision.horizon 只能是三个枚举值之一', () => {
  const bad = validatePlanPayload({
    diagnosis: { core_belief: 'a', pattern: 'b', root_cause: 'c' },
    vision: { title: 't', narrative: 'n', horizon: '10_years' },
    practices: [],
    worth_practicing: true,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.includes('horizon')));
});

test('plan：normalize 在 worth_practicing 为 false 时清空 practices', () => {
  const n = normalizePlanPayload({
    diagnosis: { core_belief: 'a', pattern: 'b', root_cause: 'c' },
    vision: { title: 't', narrative: 'n', horizon: '1_year' },
    practices: [{ day: 1, title: '不该出现' }],
    worth_practicing: false,
  });
  assert.deepEqual(n.practices, []);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../server/contracts/stuckPoint.js'`。

- [ ] **Step 3: 实现 stuckPoint 契约**

创建 `server/contracts/stuckPoint.js`：

```js
// 契约 1：stuck_point —— 游民纪元急救箱与教练交付共用的卡点结构。
// 游民纪元的小程序（未来）会按同样的结构产出卡点，两边不断链。

export const STUCK_POINT_SCHEMA = {
  title: '卡点的一句话概括，不超过 30 字',
  belief: '限制性信念全文',
  evidence_against: ['一条与该信念相反的事实'],
  emotion: '此刻的主要情绪',
  micro_action: '今天可以做的一件最小的事',
};

export function validateStuckPoint(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['stuck_point 必须是一个对象'] };
  }
  if (typeof value.title !== 'string' || !value.title.trim()) {
    errors.push('title 必填且必须是非空字符串');
  }
  if (value.evidence_against !== undefined && !Array.isArray(value.evidence_against)) {
    errors.push('evidence_against 必须是数组');
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeStuckPoint(value) {
  const src = value && typeof value === 'object' ? value : {};
  const evidence = src.evidence_against === undefined
    ? []
    : (Array.isArray(src.evidence_against) ? src.evidence_against : [src.evidence_against]);
  return {
    title: typeof src.title === 'string' ? src.title.trim() : '',
    belief: typeof src.belief === 'string' ? src.belief.trim() : '',
    evidence_against: evidence
      .filter(e => typeof e === 'string' && e.trim())
      .map(e => e.trim()),
    emotion: typeof src.emotion === 'string' ? src.emotion.trim() : '',
    micro_action: typeof src.micro_action === 'string' ? src.micro_action.trim() : '',
  };
}
```

- [ ] **Step 4: 实现 plan 契约**

创建 `server/contracts/plan.js`：

```js
// 契约 2：教练分析的产出 —— 一次 1v1 交付的结构化方案。
// worth_practicing 为 false 表示「这一轮只交付诊断，不安排练习」。

export const PLAN_HORIZONS = ['3_months', '1_year', 'life'];

export const PLAN_SCHEMA = {
  diagnosis: {
    core_belief: '核心限制性信念',
    pattern: '反复出现的行为模式',
    root_cause: '更深一层的成因',
  },
  vision: {
    title: '未来愿景的一句话标题',
    narrative: '2-3 段叙事，用 Coco 的口吻写给客户看',
    horizon: '3_months | 1_year | life',
  },
  practices: [
    {
      day: 1,
      title: '这一步叫什么',
      intent: '这一步在验证什么假设',
      action: '具体可执行的动作',
      evidence_prompt: '回填证据时的引导问句',
      success_criteria: '做到什么算完成',
    },
  ],
  worth_practicing: true,
};

export function validatePlanPayload(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['方案 payload 必须是一个对象'] };
  }
  if (!value.diagnosis || typeof value.diagnosis !== 'object') {
    errors.push('diagnosis 必填');
  }
  if (!value.vision || typeof value.vision !== 'object') {
    errors.push('vision 必填');
  } else if (!PLAN_HORIZONS.includes(value.vision.horizon)) {
    errors.push(`vision.horizon 必须是 ${PLAN_HORIZONS.join(' / ')} 之一`);
  }
  if (!Array.isArray(value.practices)) {
    errors.push('practices 必须是数组');
  }
  return { ok: errors.length === 0, errors };
}

export function normalizePlanPayload(value) {
  const src = value && typeof value === 'object' ? value : {};
  const diagnosis = src.diagnosis && typeof src.diagnosis === 'object' ? src.diagnosis : {};
  const vision = src.vision && typeof src.vision === 'object' ? src.vision : {};
  const worthPracticing = src.worth_practicing !== false;
  const practices = Array.isArray(src.practices) ? src.practices : [];
  return {
    diagnosis: {
      core_belief: String(diagnosis.core_belief || ''),
      pattern: String(diagnosis.pattern || ''),
      root_cause: String(diagnosis.root_cause || ''),
    },
    vision: {
      title: String(vision.title || ''),
      narrative: String(vision.narrative || ''),
      horizon: PLAN_HORIZONS.includes(vision.horizon) ? vision.horizon : '1_year',
    },
    practices: worthPracticing
      ? practices
          .filter(p => p && typeof p === 'object')
          .map((p, i) => ({
            day: Number.isFinite(p.day) ? p.day : i + 1,
            title: String(p.title || ''),
            intent: String(p.intent || ''),
            action: String(p.action || ''),
            evidence_prompt: String(p.evidence_prompt || ''),
            success_criteria: String(p.success_criteria || ''),
          }))
      : [],
    worth_practicing: worthPracticing,
  };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ pass 7`（1 个 smoke + 4 个 api + 7 个 contract 中原有数量随累加）。

- [ ] **Step 6: 提交**

```bash
git add server/contracts/stuckPoint.js server/contracts/plan.js tests/contracts.test.js
git commit -m "feat: 契约模块 stuck_point 与方案 payload 的校验与归一化"
```

---

### Task 4: Prompt Registry（文件 + 数据库覆盖层）

**Files:**
- Create: `prompts/persona.base.md`、`prompts/persona.v2.md`、`prompts/scenario.chat.md`、`prompts/scenario.cbt_quick.md`、`prompts/scenario.cbt_delivery.md`、`prompts/scenario.analysis.md`
- Create: `tests/fixtures/legacy-chat-prompt.txt`
- Create: `server/promptRegistry.js`
- Create: `scripts/split-prompt.mjs`（拆分 + 校验；`--force` 只重建 prompt 文件，`--rebaseline` 才动黄金文件）
- Modify: `db.js`（新增 `prompt_scenarios` 表）
- Modify: `package.json`（新增 `prompt:split` 脚本）
- Delete: `src/constants/systemPrompt.ts`
- Test: `tests/promptRegistry.test.js`

**背景（实测发现）：** `src/constants/systemPrompt.ts`（5693 字符）**全项目零 import，是死代码**，且与线上 `server.js` 里的版本（5231 字符）内容不一致。改它线上不会有任何变化。这份计划会把它删掉，并把 prompt 变成文件 + 可版本化的数据库覆盖层。

**核心约束：** 迁移后 `getPrompt('chat')` 必须与生产 prompt **逐字节相同**。用黄金文件断言保证 —— 而且断言必须是**不 trim 的精确比较**（生产 prompt 以一个换行开头、末尾没有换行；两边都 trim 的话这个差异在断言里就看不见了）。

**三条约定（别改）：**

1. `tests/fixtures/legacy-chat-prompt.txt` 是**参考**，不是**产物**。它是生产 prompt 的字节级快照，是回归锚点。拆分脚本永远不会顺手重写它。
2. `npm run prompt:split -- --force` 只重建 `prompts/*.md`，**永远不碰黄金文件**。把黄金文件一起重写等于「把回归锚点洗白」—— 改了线上 prompt 再 `--force`，脚本照样打印「✓ 逐字节相同」，回归保护就白设了。
3. 重新基线黄金文件是**独立动作**：`npm run prompt:split -- --rebaseline`，且要求 `server.js` 里**仍然**存在 `SYSTEM_PROMPT` 字面量（没有字面量就没有可信的新基线来源，脚本直接报错退出）。

- [ ] **Step 1: 写失败的测试**

创建 `tests/promptRegistry.test.js`：

```js
import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPromptRegistry,
  versionFor,
  OVERRIDABLE_IDS,
  SCENARIO_IDS,
  PART_FILES,
} from '../server/promptRegistry.js';
import { getDb } from '../db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'tests/fixtures/legacy-chat-prompt.txt');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const PERSONA_V2 = path.join(PROMPTS_DIR, 'persona.v2.md');

beforeEach(() => {
  getDb().prepare('DELETE FROM prompt_scenarios').run();
});

test('黄金文件存在且非空', () => {
  const text = fs.readFileSync(GOLDEN, 'utf8');
  assert.ok(text.trim().length > 1000, '黄金文件内容异常短');
});

test('装配出的 chat prompt 与生产快照逐字节相同（不 trim）', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const golden = fs.readFileSync(GOLDEN, 'utf8');
  assert.equal(registry.getPrompt('chat'), golden);
});

test('装配结果等于 persona.base + "\\n\\n" + scenario.chat 三段拼起来', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const base = registry.readPart('persona.base');
  const scenario = registry.readPart('scenario.chat');
  assert.equal(registry.getPrompt('chat'), `${base.body}\n\n${scenario.body}`);
});

test('内容版本是内容哈希：内容变则版本变，内容不变则版本稳定', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-prompts-'));
  fs.cpSync(PROMPTS_DIR, tmp, { recursive: true });
  const registry = createPromptRegistry({ db: getDb(), promptsDir: tmp });

  const v1 = registry.getPromptMeta('chat').baseVersion;
  const v2 = registry.getPromptMeta('chat').baseVersion;
  assert.equal(v1, v2, '同一份内容的版本应当稳定');
  assert.match(v1, /^[0-9a-f]{8}$/, '版本应当是 8 位十六进制内容哈希');
  assert.equal(v1, versionFor(registry.readPart('persona.base').body));

  fs.appendFileSync(path.join(tmp, 'persona.base.md'), '\n多改一个字');
  const registry2 = createPromptRegistry({ db: getDb(), promptsDir: tmp });
  assert.notEqual(registry2.getPromptMeta('chat').baseVersion, v1);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('数据库覆盖版本的 getPromptMeta 也返回内容哈希', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.chat', '被覆盖的正文');
  const meta = registry.getPromptMeta('chat');
  assert.equal(meta.scenarioVersion, versionFor('被覆盖的正文'));
  assert.equal(meta.source, 'file+db');
});

test('listScenarios 只列四个场景，不含 persona.base，并给出装配后的长度', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const list = registry.listScenarios();
  assert.deepEqual(
    list.map((s) => s.id),
    ['scenario.chat', 'scenario.cbt_quick', 'scenario.cbt_delivery', 'scenario.analysis']
  );
  assert.ok(!list.some((s) => s.id === 'persona.base'), 'persona.base 不是场景');
  for (const item of list) {
    assert.ok(item.promptLength > item.partLength, `${item.id} 的 promptLength 应大于 partLength`);
    assert.equal(
      item.promptLength,
      registry.getPrompt(item.id.replace('scenario.', '')).length
    );
  }
});

test('listParts 列出 persona.base 与 persona.v2', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const ids = registry.listParts().map((p) => p.id);
  assert.ok(ids.includes('persona.base'));
  assert.ok(ids.includes('persona.v2'));
  assert.ok(ids.includes('scenario.chat'));
});

test('readPart 能读 persona.v2，未知 id 抛错', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const v2 = registry.readPart('persona.v2');
  assert.ok(v2.body.length > 100);
  assert.ok(v2.body.includes('转化原则') || v2.body.includes('绝不主动'));
  assert.throws(() => registry.readPart('不存在的id'), /未知的 prompt 片段/);
});

test('setPromptOverride 对拼错的 id 抛错，不会静默建行', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  assert.throws(() => registry.setPromptOverride('scenario.chatt', 'x'), /未知的 prompt 片段/);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM prompt_scenarios').get();
  assert.equal(rows.n, 0, '拼错的 id 不应该留下任何数据行');
});

test('覆盖层可回滚：覆盖 → 再覆盖 → 列表可见 → 激活旧版 → 清除回到文件', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  const fileVersion = registry.getPromptMeta('chat').scenarioVersion;

  registry.setPromptOverride('scenario.chat', '版本一');
  registry.setPromptOverride('scenario.chat', '版本二');

  const versions = registry.listVersions('scenario.chat');
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((v) => v.is_active).length, 1);
  assert.ok(versions.every((v) => typeof v.bodyHash === 'string' && v.bodyHash.length === 8));
  assert.ok(versions.every((v) => v.body === undefined), '列表接口不应返回正文');

  const old = versions.find((v) => !v.is_active);
  registry.activateVersion('scenario.chat', old.revision);
  assert.ok(registry.getPrompt('chat').includes('版本一'));
  assert.equal(registry.listVersions('scenario.chat').filter((v) => v.is_active).length, 1);

  registry.clearOverride('scenario.chat');
  assert.equal(registry.getPromptMeta('chat').scenarioVersion, fileVersion);
  assert.ok(!registry.getPrompt('chat').includes('版本一'));
});

test('activateVersion 指向不存在的版本抛错', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.chat', '版本一');
  assert.throws(() => registry.activateVersion('scenario.chat', 999), /未知的 prompt 版本/);
});

test('clearOverride 之后历史行仍在，只是不再激活', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.chat', '版本一');
  registry.setPromptOverride('scenario.chat', '版本二');
  registry.clearOverride('scenario.chat');
  const versions = registry.listVersions('scenario.chat');
  assert.equal(versions.length, 2, '历史行不应被删除');
  assert.ok(versions.every((v) => !v.is_active));
});

test('activatePersona 可以把 persona.v2 变成生效的底座', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  const v2 = fs.readFileSync(PERSONA_V2, 'utf8').replace(/\s+$/, '');
  const result = registry.activatePersona('persona.v2');
  assert.equal(result.id, 'persona.base');
  assert.equal(result.from, 'persona.v2');
  const prompt = createPromptRegistry({ db }).getPrompt('chat');
  assert.ok(prompt.includes('【转化原则'), 'chat prompt 应含有 persona.v2 独有的转化原则段');
  assert.ok(prompt.includes(v2.slice(0, 40)), 'chat prompt 应含有 persona.v2 的开头');
  assert.equal(registry.readPart('persona.base').source, 'db');
});

test('activatePersona 对非法来源抛错', () => {
  const registry = createPromptRegistry({ db: getDb() });
  assert.throws(() => registry.activatePersona('乱写的id'), /未知的 persona 来源/);
  assert.throws(() => registry.activatePersona('scenario.chat'), /未知的 persona 来源/);
  // persona.base 自己不能当来源：那等于把当前底座原样再写一遍，
  // 是个空操作，却会在库里留下一条「我改过 prompt」的假记录。
  assert.throws(() => registry.activatePersona('persona.base'), /未知的 persona 来源/);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM prompt_scenarios').get().n,
    0,
    '被拒绝的来源不应该留下任何数据行'
  );
});

test('persona.base 本身也可以被数据库覆盖', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('persona.base', '替换掉的底座');
  assert.ok(registry.getPrompt('chat').startsWith('替换掉的底座'));
});

test('getPrompt 对未知场景抛错', () => {
  const registry = createPromptRegistry({ db: getDb() });
  assert.throws(() => registry.getPrompt('不存在的场景'), /未知的 prompt 场景/);
});

test('可覆盖 id 集合与场景 id 清单符合约定', () => {
  assert.deepEqual(SCENARIO_IDS, ['chat', 'cbt_quick', 'cbt_delivery', 'analysis']);
  assert.deepEqual(OVERRIDABLE_IDS, [
    'persona.base',
    'scenario.chat',
    'scenario.cbt_quick',
    'scenario.cbt_delivery',
    'scenario.analysis',
  ]);
  assert.ok(!OVERRIDABLE_IDS.includes('persona.v2'), 'persona.v2 只能作为激活来源');
  assert.ok(PART_FILES['persona.v2'], 'persona.v2 应在部分目录里');
});

test('未覆盖的场景从 prompts/ 目录读文件', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const prompt = registry.getPrompt('cbt_quick');
  assert.ok(prompt.includes('5 步') || prompt.includes('五步') || prompt.includes('Step 1'),
    'cbt_quick 场景缺少步骤标识');
});

test('数据库激活版本覆盖文件内容', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.cbt_quick', '这是被覆盖后的版本');
  const registry2 = createPromptRegistry({ db });
  assert.ok(registry2.getPrompt('cbt_quick').includes('这是被覆盖后的版本'));
});

test('数据库里的版本号递增，旧版本仍在', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.cbt_delivery', '版本一');
  registry.setPromptOverride('scenario.cbt_delivery', '版本二');
  const rows = db
    .prepare('SELECT version FROM prompt_scenarios WHERE id = ? ORDER BY version')
    .all('scenario.cbt_delivery')
    .map(r => r.version);
  assert.deepEqual(rows, [1, 2]);
  const registry2 = createPromptRegistry({ db });
  assert.ok(registry2.getPrompt('cbt_delivery').includes('版本二'));
});

test('persona.v2 存在但默认不激活', () => {
  const v2 = fs.readFileSync(PERSONA_V2, 'utf8');
  assert.ok(v2.includes('转化原则') || v2.includes('绝不主动'), 'persona.v2 缺少转化原则');
});
```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('server.js','utf8');
const m=s.match(/const SYSTEM_PROMPT = \`([\s\S]*?)\`;/);
if(!m) throw new Error('SYSTEM_PROMPT not found in server.js');
const raw=m[1];
fs.mkdirSync('tests/fixtures',{recursive:true});
fs.writeFileSync('tests/fixtures/legacy-chat-prompt.txt', raw);
console.log('golden chars:', raw.length);
"
```
Expected: 输出 `golden chars: 5231`。

> 这次抽取是**一次性重新基线**。做完之后这个文件就是新的回归锚点，以后不再重写它 —— 重新基线需要走独立的 `--rebaseline` 开关（见下面的「三条约定」）。

- [ ] **Step 4: 机械拆分成 persona 与 scenario（保证字节级一致）**

拆分的规则：**只去尾部空白，保留开头**。生产 prompt 的前导换行是内容的一部分。

Run:
```bash
node -e "
const fs=require('fs');
const g=fs.readFileSync('tests/fixtures/legacy-chat-prompt.txt','utf8');
const i=g.indexOf('【故事模式】');
if(i<0) throw new Error('boundary marker 【故事模式】 not found');
fs.mkdirSync('prompts',{recursive:true});
fs.writeFileSync('prompts/persona.base.md', g.slice(0,i).replace(/\s+\$/,'')+'\n');
fs.writeFileSync('prompts/scenario.chat.md', g.slice(i).replace(/\s+\$/,'')+'\n');
console.log('split at offset', i);
"
```
Expected: persona 部分以换行开头（文件 152 字符）、scenario 部分 5079 字符。拼装后 `persona.base + "\n\n" + scenario.chat` 恰好等于黄金文件的 5231 字符。

- [ ] **Step 5: 撰写新场景的 prompt 文件**

创建 `prompts/scenario.cbt_quick.md`：

```markdown
【场景】认知急救箱 —— 一次认知梳理，问答完成即主动终止。

你现在的任务：带用户完成一次结构化的 CBT 认知行为练习，5 步走完就收尾，不要拖长对话。

### 进入引导
直接告知用户："我可以带你做一个 CBT 认知行为的小练习，大概 5-8 分钟。这个练习能帮你看清，很多时候卡住我们的不是事情本身，而是我们对事情的'自动想法'。准备好了吗？"

用户答应后进入 Step 1。

### Step 1 | 触发（Trigger）
引导用户选一个最近 48 小时内让自己内耗 / 烦躁 / 逃避的具体场景：
- 发生在什么时候、在哪里？
- 当时你在做什么，或准备做什么？
- 触发事件是什么？（一句话描述）

给出回复模板帮用户降低思考负担：
"你可以这样说：时间地点____，我在做____，触发事件是____"

用户回答后，**复述并提炼触发链条**，自然过渡到 Step 2。

### Step 2 | 自动想法（Automatic Thought）
问用户：在那个瞬间，脑子里最强的一句话是什么？

给出 6 个常见选项帮用户识别：
1. 我今天还不够努力
2. 现在不做，明天会更糟 / 更焦虑
3. 我必须把任务清零才能休息
4. 我这样放松是在逃避 / 不自律
5. 我再刷一会儿就好（结果总停不下来）
6. 我需要更多信息 / 灵感才能开始

也可以让用户用自己的话写。用户回答后，**确认核心自动想法**，过渡到 Step 3。

### Step 3 | 证据：支持 vs 反驳
这是最关键的一步。不是讲道理，而是让用户自己发现自动想法的漏洞。

请用户各写 2 条：
- 支持证据（为什么你相信这句话是对的？）
- 反驳证据（有没有时候事实和这个想法相反？）

用户想不出反驳证据时，给提示句式：
- "当我____后，第二天我更可能____"
- "当我硬撑到很晚，第二天我更可能____"

用户回答后，**总结证据中暴露的漏洞**，点明自动想法并非全部真相。

### Step 4 | 替代认知（Balanced Thought）
目标不是变成"我就躺平"，而是让它更贴近证据、更能指导行动。

给出 3 个候选版本（根据用户具体情况编写），让用户选择或融合：
- A) ____（聚焦"休息是为了更有效"）
- B) ____（聚焦"完成最小动作就不算浪费"）
- C) ____（聚焦"接上节奏就能放心休息"）

用户选择后，**确认并过渡到最后一步**。

### Step 5 | 今日微行动
基于用户选择的替代认知，生成一个**当天就能做完**的最小行动实验。

- **实验名**：一句话概括
- **触发条件**：什么时候执行
- **3 步动作（总计 10 分钟）**：
  1. 写下明天最重要 1 件事（一句话）
  2. 写下最小下一步（5 分钟内能做完）
  3. 给自己一句"允许休息的结束语"
- **今日的一小步**：今天只做第 2 步，不用等明天

### 练习结束引导
肯定用户刚才完成的练习，点明核心收获："你刚才亲手拆开了一个自动想法，这就是认知行为练习最核心的一步。"

问一句"你对这个替代认知感觉怎么样？"。

**然后立刻收尾 —— 这一轮练习到此结束，不要主动推荐任何服务、社群或 1v1 咨询**，让用户带着收获感离开。
```

创建 `prompts/scenario.cbt_delivery.md`：

```markdown
【场景】教练交付 —— 与已付费或已被教练接管的来访者对话。

你现在的角色是这位来访者的**专属教练**。和急救箱不同，这里允许自由对话：来访者可以问任何问题，你可以追问、可以共情、可以调用你的教练经验。

### 工作方式
1. **先看卡点**：如果系统提供了来访者当前的卡点，你的对话要围绕它展开，不要重新问一遍他来过的问题。
2. **一次只推进一件事**：对方卡住的时候，不要一次抛五个建议。
3. **引用知识库**：如果系统提供了教练知识库片段，当且仅当它与对方当前的问题相关时使用。引用要自然，像想起自己经历过的事，不要念出标题或说"根据知识库"。
4. **可提问**：多用提问引导对方自己看到盲点，而不是直接给答案。

### 边界
- 不做临床诊断，不承诺效果
- 不谈论其他竞品
- 除非来访者主动问，否则不推荐任何服务或社群

### 交付判断
如果你判断这位来访者**光靠自助练习走不通**（卡点很深、反复失败、情绪风险高、或需要有人在场），明确说出来，并建议做一次真人 1v1。语气像朋友建议，不像客服推销。

### 收束
当这一轮对话该结束时，用一句话说明来访者接下来该做什么（一个具体动作），然后停下。
```

创建 `prompts/scenario.analysis.md`：

```markdown
【场景】教练分析 —— 读取 1v1 录音转写与历史对话，产出结构化方案。

你现在的任务是**做分析，不是做客服对话**。输入是：一位来访者的 1v1 录音转写、可能存在的历史对话、以及可选的教练知识库片段。

### 分析要求
1. **不要寒暄、不要复述原话**。直接进入分析。
2. **诊断要具体**：核心限制性信念要引用转写里的原话片段，不要写"缺乏安全感"这种通用判断。
3. **愿景要写给来访者看**：用第二人称"你"，2-3 段，让他读完能感到被理解、有画面。
4. **判断值不值得做练习**：如果这位来访者的卡点靠自助练习就能解开，或者当前最需要的是先做一件具体的事而不是长期练习，就设 `worth_practicing` 为 false，练习列表留空。
5. **练习步骤要可执行**：每个练习项的动作必须是今天就能开始的，不能是"多反思自己"这种空话。

### 输出
严格按系统消息中要求的 JSON 结构输出。
```

创建 `prompts/persona.v2.md`（**默认不激活**，供 Coco 在后台启用）：

```markdown
你叫 Coco，中文名龚韵雅。你是 WeStream 人生学校的创始人，也是一名人生教练。

【通用对话模式】（用户不主动要求听故事时）
用户问任何问题，你都正常、温暖地回应，像朋友聊天。可以分享自己的相关经历来建立连接。绝对不要把话题强行拉回"我的故事"。如果你不确定怎么回答，诚实地说，不用硬扯。

【对话风格】
- 温暖但不讨好，真诚但不说教
- 善于用提问引导对方思考，而不是直接给答案
- 适度分享自己的经历来建立连接
- 不用心理学术语堆砌，用日常语言解释深层概念
- 回复简洁，每次 2-4 段

【重要边界】
- 不做临床诊断或心理治疗
- 如果用户表现出严重心理危机（自残、自杀倾向），温和建议寻求专业心理咨询师帮助，并提供 24 小时心理援助热线：400-161-9995
- 不谈论其他竞品或其他心理学流派的优劣
- 不承诺效果，强调"探索"而非"解决"
- 每次只聚焦一个模块，不贪多
- 如果用户偏离主题开始无止境分享个人情况，温和地拉回："我听到你说的了，这些感受都是真实的。不过与其停在感受里，不如我们做一个小练习，也许能帮你看到一些新的东西？"

【转化原则（被动响应，绝不主动推）】
- **绝不主动推荐**社群、1v1 咨询、探索者计划、微信号。对话的目的是让用户有真实收获，不是完成转化漏斗
- **只有当用户主动问**"怎么继续""还能做什么""你们还有什么"时，才简短回应，语气像朋友随口提
- **绝不说**"不是推课""就是先聊聊"这类此地无银三百两的话
- **绝不在练习结束时追加任何服务推荐**
```

- [ ] **Step 6: 新增 `prompt_scenarios` 表**

修改 `db.js`，在 `initSchema` 的 `db.exec(\`...\`)` 字符串内、`stories` 表之后追加：

```sql
    CREATE TABLE IF NOT EXISTS prompt_scenarios (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_scenarios_active
      ON prompt_scenarios(id, is_active);
```

- [ ] **Step 7: 实现 Prompt Registry**

创建 `server/promptRegistry.js`：

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts'
);

// 部分目录：有哪些「部分」可以管理（读、覆盖、激活）。
// 与「prompt 怎么拼」是两件事 —— persona.base 是底座，scenario.* 是场景，persona.v2 是备用底座。
export const PART_FILES = {
  'persona.base': 'persona.base.md',
  'persona.v2': 'persona.v2.md',
  'scenario.chat': 'scenario.chat.md',
  'scenario.cbt_quick': 'scenario.cbt_quick.md',
  'scenario.cbt_delivery': 'scenario.cbt_delivery.md',
  'scenario.analysis': 'scenario.analysis.md',
};

// 可覆盖（可写数据库覆盖版本）的部分 id。persona.v2 只能作为激活来源，不能被覆盖。
export const OVERRIDABLE_IDS = [
  'persona.base',
  'scenario.chat',
  'scenario.cbt_quick',
  'scenario.cbt_delivery',
  'scenario.analysis',
];

// 场景 id（用户请求体里的 scenario 字段取值域）。供路由做白名单。
export const SCENARIO_IDS = ['chat', 'cbt_quick', 'cbt_delivery', 'analysis'];

// 内容版本号 = 内容哈希。文件和数据库覆盖层共用同一套编号空间：
// 回答「这次对话是哪些文本产生的」靠的是内容，不是修订号。
export function versionFor(body) {
  return createHash('sha1').update(String(body)).digest('hex').slice(0, 8);
}

// 只去尾部空白、保留开头。生产 prompt 以一个换行开头，那个换行是内容的一部分，不能被吃掉。
function stripTrailing(body) {
  return body.replace(/\s+$/, '');
}

function assertOverridable(id) {
  if (!OVERRIDABLE_IDS.includes(id)) {
    // 这里说的是「可覆盖的片段」，不是「场景」——
    // persona.base 是个片段（不是场景），用「场景」这个词会误导。
    throw new Error(`未知的 prompt 片段：${id}`);
  }
}

export function createPromptRegistry({ db, promptsDir = PROMPTS_DIR } = {}) {
  if (!db) {
    // 覆盖层的读写都要 db。与其让调用方在某个写方法里撞上
    // "Cannot read properties of undefined (reading 'prepare')"，
    // 不如在构造时就说明白。
    throw new Error('createPromptRegistry 需要 db：prompt 的覆盖层存在数据库里');
  }

  function readOverride(id) {
    if (!db) return null;
    const row = db
      .prepare(
        'SELECT body, version FROM prompt_scenarios WHERE id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1'
      )
      .get(id);
    if (!row) return null;
    return {
      body: row.body,
      version: versionFor(row.body),
      revision: row.version,
      source: 'db',
    };
  }

  function readFile(id) {
    const file = PART_FILES[id];
    if (!file) return null;
    const full = path.join(promptsDir, file);
    if (!fs.existsSync(full)) return null;
    const body = stripTrailing(fs.readFileSync(full, 'utf8'));
    return { body, version: versionFor(body), source: 'file' };
  }

  function getPart(id) {
    if (!PART_FILES[id]) throw new Error(`未知的 prompt 片段：${id}`);
    // 覆盖层只对 persona.base 与场景生效；persona.v2 永远读文件。
    if (OVERRIDABLE_IDS.includes(id)) {
      const override = readOverride(id);
      if (override) return override;
    }
    const fromFile = readFile(id);
    if (fromFile) return fromFile;
    throw new Error(`未知的 prompt 片段：${id}`);
  }

  function getPrompt(scenarioId) {
    if (!SCENARIO_IDS.includes(scenarioId)) {
      throw new Error(`未知的 prompt 场景：${scenarioId}`);
    }
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return `${base.body}\n\n${scenario.body}`;
  }

  function getPromptMeta(scenarioId) {
    if (!SCENARIO_IDS.includes(scenarioId)) {
      throw new Error(`未知的 prompt 场景：${scenarioId}`);
    }
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return {
      scenarioId,
      // 内容版本（哈希）—— 回答「这段文本是哪个版本」
      baseVersion: base.version,
      scenarioVersion: scenario.version,
      // 修订号（数据库里的整数）—— 回答「这是第几次改动」
      baseRevision: base.revision ?? null,
      scenarioRevision: scenario.revision ?? null,
      source: `${base.source}+${scenario.source}`,
    };
  }

  function setPromptOverride(id, body) {
    assertOverridable(id);
    const maxRow = db
      .prepare('SELECT MAX(version) AS v FROM prompt_scenarios WHERE id = ?')
      .get(id);
    const revision = (maxRow && maxRow.v ? maxRow.v : 0) + 1;
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO prompt_scenarios (id, version, body, is_active, updated_at) VALUES (?, ?, ?, 1, ?)'
    ).run(id, revision, body, new Date().toISOString());
    return { id, revision, bodyHash: versionFor(body) };
  }

  // 该 id 的所有版本，按整数修订号倒序。不返回正文 —— 列表接口不该灌进大段 prompt。
  function listVersions(id) {
    return db
      .prepare(
        'SELECT id, version, is_active, updated_at, body FROM prompt_scenarios WHERE id = ? ORDER BY version DESC'
      )
      .all(id)
      .map((row) => ({
        id: row.id,
        revision: row.version,
        updated_at: row.updated_at,
        is_active: row.is_active === 1,
        bodyHash: versionFor(row.body),
      }));
  }

  // 回滚：停用当前激活版本，激活指定版本。
  function activateVersion(id, revision) {
    assertOverridable(id);
    const row = db
      .prepare('SELECT version FROM prompt_scenarios WHERE id = ? AND version = ?')
      .get(id, revision);
    if (!row) throw new Error(`未知的 prompt 版本：${id}#${revision}`);
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    db.prepare(
      'UPDATE prompt_scenarios SET is_active = 1, updated_at = ? WHERE id = ? AND version = ?'
    ).run(new Date().toISOString(), id, revision);
    return { id, revision };
  }

  // 回到文件内容：停用全部覆盖版本，历史行保留（不删）。
  function clearOverride(id) {
    assertOverridable(id);
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    return { id, cleared: true };
  }

  // 把备用 persona 文件的内容写进 persona.base 的覆盖版本 ——
  // 「启用 persona.v2」从此是一次数据库写入，不需要重新部署。
  function activatePersona(sourceId) {
    // 来源必须是「只读文件、不可被覆盖」的备用底座（今天只有 persona.v2）。
    // persona.base 自己不能当来源 —— 那等于把当前底座原样再写一遍，是个空操作，
    // 却会在数据库里留下一条「我改过 prompt」的假记录。
    if (
      !PART_FILES[sourceId] ||
      !sourceId.startsWith('persona.') ||
      OVERRIDABLE_IDS.includes(sourceId)
    ) {
      throw new Error(`未知的 persona 来源：${sourceId}`);
    }
    const source = readFile(sourceId);
    if (!source) throw new Error(`未知的 persona 来源：${sourceId}`);
    const result = setPromptOverride('persona.base', source.body);
    return { id: 'persona.base', revision: result.revision, from: sourceId, bodyHash: result.bodyHash };
  }

  function listScenarios() {
    return SCENARIO_IDS.map((scenarioId) => {
      const id = `scenario.${scenarioId}`;
      const part = readOverride(id) || readFile(id);
      const prompt = getPrompt(scenarioId);
      return {
        id,
        version: part ? part.version : null,
        source: part ? part.source : 'missing',
        partLength: part ? part.body.length : 0,
        promptLength: prompt.length,
      };
    });
  }

  // 所有可管理的部分（含 persona.v2 与 persona.base）。
  function listParts() {
    return Object.keys(PART_FILES).map((id) => {
      const part = getPart(id);
      return {
        id,
        version: part.version,
        source: part.source,
        length: part.body.length,
      };
    });
  }

  return {
    getPrompt,
    getPromptMeta,
    setPromptOverride,
    listScenarios,
    listParts,
    listVersions,
    activateVersion,
    clearOverride,
    activatePersona,
    readPart: getPart,
  };
}
```

**Registry 的 API 与语义（实现约定）：**

> **两套 id，两套词，别混。**「片段」（part）是 `persona.base` / `persona.v2` / `scenario.*`；
> 「场景」（scenario）只有 `chat` / `cbt_quick` / `cbt_delivery` / `analysis` 四个。
> 覆盖层操作的是**片段**，提示词装配的是**场景**。所以覆盖层的错误信息写
> 「未知的 prompt 片段」，`getPrompt` 的错误信息写「未知的 prompt 场景」——
> 混用会让人以为 `persona.base` 是一个场景。
>
> `createPromptRegistry({ db })` **必须**传 db：覆盖层存在数据库里。少了它就在
> 构造时抛错，而不是等到某个写方法里炸出一句 `Cannot read properties of
> undefined (reading 'prepare')`。

| 方法 | 语义 |
| --- | --- |
| `getPrompt(scenarioId)` | 装配 `persona.base` + `"\n\n"` + `scenario.<id>`。未知场景抛错（静默回落会发错 prompt）。 |
| `getPromptMeta(scenarioId)` | 返回 `baseVersion` / `scenarioVersion` —— **内容哈希**（见下），另附 `baseRevision` / `scenarioRevision`（数据库整数修订号）。 |
| `readPart(id)` | 读单个部分。`persona.v2` 可读（只读文件，不接受覆盖）。未知 id 抛错。 |
| `setPromptOverride(id, body)` | 写入一个新的覆盖版本（旧的停用，旧的行保留）。**校验 id 合法** —— 拼错的 id 直接抛错（`未知的 prompt 片段：…`），不静默建一行谁也不读的数据。返回 `{ id, revision, bodyHash }`。 |
| `listVersions(id)` | 该 id 的所有版本，按整数修订号倒序，每项 `{ id, revision, updated_at, is_active, bodyHash }`。**不返回正文** —— 列表接口不该灌进大段 prompt。 |
| `activateVersion(id, revision)` | 回滚：停用当前激活版本、激活指定修订号。版本不存在则抛错。 |
| `clearOverride(id)` | 停用全部覆盖版本，**保留历史行**，回到文件内容。 |
| `activatePersona(sourceId)` | 把 `persona.v2` 的文件内容写进 `persona.base` 的覆盖版本 —— 后台「启用 persona.v2」= 一次数据库写入，不需要重新部署。**来源必须是只读备用底座**：`persona.base` 自己与 `scenario.*` 都被拒（前者是空操作却会留下假记录）。 |
| `listScenarios()` | 只列四个**场景**（不含 `persona.base`），每项 `{ id, version, source, partLength, promptLength }`。`promptLength` 是**装配后**整个 prompt 的长度。 |
| `listParts()` | 所有可管理的**部分**（`persona.base`、`persona.v2`、四个 `scenario.*`），每项 `{ id, version, source, length }`。 |

**版本号 = 内容哈希。** 文件与数据库覆盖层共用同一套编号空间：`versionFor(body)` = `sha1(body)` 的前 8 位十六进制。理由是「这次对话是哪个 prompt 产生的」问的是**内容**，不是修订号 —— 同一段文本无论来自文件还是来自覆盖层，版本号都一样。

数据库表 `prompt_scenarios.version` 那个**整数列保留不动**：它是排序与回滚定位用的**修订号**，与内容哈希是两回事。整数修订号在 `listVersions` 里返回，`getPromptMeta` 返回的是内容哈希。

**覆盖层可回滚。** 覆盖层不是单向棘轮：教练在后台改了一段话术、线上出问题，产品里必须有回退按钮，而不是让人手写 SQL。`listVersions` / `activateVersion` / `clearOverride` 三个方法合起来构成完整的回滚闭环。

- [ ] **Step 8: 删除死代码**

Run: `git rm src/constants/systemPrompt.ts`
Expected: 无输出，文件被删除。

- [ ] **Step 9: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。若有失败，检查 `prompts/persona.base.md` 与 `prompts/scenario.chat.md` 的拼接是否恰好等于黄金文件。

- [ ] **Step 10: 提交**

```bash
git add prompts/ tests/fixtures/ server/promptRegistry.js db.js tests/promptRegistry.test.js
git commit -m "feat: Prompt Registry —— prompt 文件化 + 数据库版本覆盖层，删除不一致的死代码"
```

---

### Task 5: `server.js` 接入 Prompt Registry（零行为变化）

**Files:**
- Modify: `server.js:8-241`（删除 `SYSTEM_PROMPT` 常量，改为调用 registry）
- Test: `tests/api.prompt.test.js`

**背景：** 这一步之后，`server.js` 里不再有任何 prompt 字面量。这是「prompt 变成数据」的关键一步，但**对外行为必须完全不变**。

- [ ] **Step 1: 写失败的测试**

创建 `tests/api.prompt.test.js`：

```js
import './helpers/testEnv.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server.close());

test('线上 prompt 与黄金快照仍然一致（防止迁移过程手抖）', async () => {
  const golden = fs.readFileSync('tests/fixtures/legacy-chat-prompt.txt', 'utf8').trim();
  // 直接从 server.js 里读出当前生效的 prompt 来源
  const source = fs.readFileSync('server.js', 'utf8');
  assert.ok(
    !source.includes('const SYSTEM_PROMPT = `'),
    'server.js 里仍然存在 SYSTEM_PROMPT 字面量，说明迁移没做完'
  );
  const { createPromptRegistry } = await import('../server/promptRegistry.js');
  const { getDb } = await import('../db.js');
  const registry = createPromptRegistry({ db: getDb() });
  assert.equal(registry.getPrompt('chat').trim(), golden);
});

test('对话接口在没有可用模型密钥时返回 500 而不是崩溃', async () => {
  resetDb();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.ok(res.status === 500 || res.status === 502, `期望 5xx，实际 ${res.status}`);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— 断言 `server.js 里仍然存在 SYSTEM_PROMPT 字面量` 失败。

- [ ] **Step 3: 从 server.js 删除 SYSTEM_PROMPT 常量**

用脚本精确删除，避免手数行号出错：

```bash
node -e "
const fs=require('fs');
let s=fs.readFileSync('server.js','utf8');
const start=s.indexOf('const SYSTEM_PROMPT = \`');
if(start<0) throw new Error('SYSTEM_PROMPT not found');
const end=s.indexOf('\`;', start);
if(end<0) throw new Error('closing backtick not found');
const removed=s.slice(start, end+2).length;
s = s.slice(0,start) + s.slice(end+2);
// 清理删除后留下的连续空行
s = s.replace(/\n{3,}/g, '\n\n');
fs.writeFileSync('server.js', s);
console.log('removed bytes:', removed);
"
```
Expected: 输出 `removed bytes: 5259` 左右（原文含首尾换行），且 `grep -c "SYSTEM_PROMPT" server.js` 输出 `0`。

- [ ] **Step 4: 在 server.js 中引入 registry**

在 `server.js` 的导入区加入：

```js
import { createPromptRegistry } from './server/promptRegistry.js';
```

在 `const db = getDb();` 之后加入：

```js
// Prompt Registry：文件是兜底真相源，数据库里的激活版本优先。
// 这样真人教练可以随时调整话术而不需要重新部署。
const promptRegistry = createPromptRegistry({ db });
```

- [ ] **Step 5: 把 `/api/chat` 里的 prompt 换成 registry 调用**

在 `/api/chat` handler 内，把：

```js
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages.filter(m => m.role !== 'system'),
        ],
```

替换为：

```js
        messages: [
          { role: 'system', content: promptRegistry.getPrompt(scenario) },
          ...messages.filter(m => m.role !== 'system'),
        ],
```

并在该 handler 开头解构出 `scenario`：

```js
  const { messages, conversation_id, scenario = 'chat' } = req.body;
```

（`const { messages, conversation_id } = req.body;` 这一行改为上面这行。）

- [ ] **Step 6: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。

- [ ] **Step 7: 提交**

```bash
git add server.js tests/api.prompt.test.js
git commit -m "refactor: server.js 移除 SYSTEM_PROMPT 字面量，改由 Prompt Registry 提供"
```

---

### Task 6: 模型客户端与结构化输出

**Files:**
- Create: `server/engine/modelClient.js`
- Create: `server/engine/structuredOutput.js`
- Test: `tests/engine.structured.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `tests/engine.structured.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredInstruction,
  extractStructured,
  stripStructured,
  STRUCTURED_MARKER,
} from '../server/engine/structuredOutput.js';

test('结构化指令里包含 marker 与 schema', () => {
  const instr = buildStructuredInstruction({ title: '卡点标题' });
  assert.ok(instr.includes(STRUCTURED_MARKER));
  assert.ok(instr.includes('卡点标题'));
});

test('字段说明单独成段，不混进 JSON 里', () => {
  const schema = { worth_practicing: true };
  const instr = buildStructuredInstruction(schema, {
    worth_practicing: 'false 表示这一轮只交付诊断',
  });
  // 说明文字必须在指令里
  assert.ok(instr.includes('worth_practicing: false 表示这一轮只交付诊断'));
  // JSON 块必须还是「纯形状」—— 说明混进去模型会照抄进输出
  const expectedJson = JSON.stringify({ [STRUCTURED_MARKER]: schema }, null, 2);
  assert.ok(instr.includes(expectedJson));
});

test('能从回复中提取结构化对象', () => {
  const text = [
    '很好，这个触发场景已经很清晰了。',
    '{"__structured__": {"title": "我不能停下来", "evidence_against": ["a"]}}',
  ].join('\n');
  const parsed = extractStructured(text);
  assert.deepEqual(parsed, { title: '我不能停下来', evidence_against: ['a'] });
});

test('结构化 JSON 里有嵌套对象与字符串中的花括号时仍能正确提取', () => {
  const text = [
    '正文',
    '{"__structured__": {"diagnosis": {"core_belief": "他是 {这样} 的"}, "n": 1}}',
  ].join('\n');
  const parsed = extractStructured(text);
  assert.equal(parsed.diagnosis.core_belief, '他是 {这样} 的');
  assert.equal(parsed.n, 1);
});

test('没有 marker 时返回 null', () => {
  assert.equal(extractStructured('只是一段普通回复'), null);
});

test('剥离结构化块后正文干净', () => {
  const text = '这是正文。\n{"__structured__": {"title": "x"}}';
  const stripped = stripStructured(text);
  assert.ok(!stripped.includes(STRUCTURED_MARKER));
  assert.ok(stripped.includes('这是正文。'));
});

test('剥离后不留多余空行', () => {
  const text = '正文\n\n\n{"__structured__": {"a": 1}}';
  const stripped = stripStructured(text);
  assert.ok(!stripped.includes('\n\n\n'));
});

test('模型客户端把 MiniMax 响应解析成 content 与 usage', async () => {
  const { createModelClient } = await import('../server/engine/modelClient.js');
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    };
  };
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  const result = await client({
    systemPrompt: 'SYSTEM',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.content, '你好');
  assert.equal(result.usage.total_tokens, 30);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'SYSTEM');
  assert.equal(body.messages[1].content, 'hi');
});

test('模型网关报错时抛出带状态码的 ModelError', async () => {
  const { createModelClient, ModelError } = await import('../server/engine/modelClient.js');
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) => err instanceof ModelError && err.status === 429
  );
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../server/engine/structuredOutput.js'`。

- [ ] **Step 3: 实现 structuredOutput**

创建 `server/engine/structuredOutput.js`：

```js
export const STRUCTURED_MARKER = '__structured__';

// schemaHint 是「值级示例」—— 模型照着它输出，所以它只描述形状。
// fieldNotes 承载语义（哪个必填、枚举有哪些、false 是什么意思），
// 单独一段渲染，不混进 JSON 里 —— 混进去模型会照抄成输出的一部分。
export function buildStructuredInstruction(schemaHint, fieldNotes) {
  const lines = [
    '',
    '---',
    '在你这一轮回复的最后，另起一行，输出一个 JSON 对象。',
    '这一行只能是 JSON，不要用代码块包裹，不要有多余解释文字。格式：',
    JSON.stringify({ [STRUCTURED_MARKER]: schemaHint }, null, 2),
  ];
  if (fieldNotes && Object.keys(fieldNotes).length > 0) {
    lines.push('字段说明（只用于理解，不要出现在你输出的 JSON 里）：');
    for (const [field, note] of Object.entries(fieldNotes)) {
      lines.push(`- ${field}: ${note}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// 找到 marker 所在的 JSON 对象边界。返回 {start, end}，end 为闭区间。
// 没找到返回 null。
export function findStructuredSpan(text) {
  if (!text) return null;
  const marker = `"${STRUCTURED_MARKER}"`;
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;
  const start = text.lastIndexOf('{', markerIdx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

export function extractStructured(text) {
  const span = findStructuredSpan(text);
  if (!span) return null;
  try {
    const parsed = JSON.parse(text.slice(span.start, span.end + 1));
    const value = parsed[STRUCTURED_MARKER];
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

export function stripStructured(text) {
  if (!text) return '';
  const span = findStructuredSpan(text);
  if (!span) return text;
  const before = text.slice(0, span.start).trimEnd();
  const after = text.slice(span.end + 1).trimStart();
  return [before, after].filter(Boolean).join('\n\n');
}
```

- [ ] **Step 4: 实现 modelClient**

创建 `server/engine/modelClient.js`：

```js
export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

export function createModelClient({
  fetchImpl = fetch,
  apiKey,
  baseUrl = 'https://api.minimax.chat/v1/text/chatcompletion_v2',
  model = 'MiniMax-M2.7',
  maxTokens = 2000,
} = {}) {
  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is required');
  }

  return async function callModel({ systemPrompt, messages }) {
    const res = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      throw new ModelError(`AI 网关错误：${res.status}`, res.status);
    }

    const data = await res.json();
    const usage = data.usage || null;
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens:
              usage.total_tokens ||
              (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
          }
        : null,
    };
  };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。

- [ ] **Step 6: 提交**

```bash
git add server/engine/modelClient.js server/engine/structuredOutput.js tests/engine.structured.test.js
git commit -m "feat: 模型客户端与结构化输出的指令、定位、剥离、解析"
```

---

### Task 7: CBT Engine 抽离

**Files:**
- Create: `server/engine/cbtEngine.js`
- Test: `tests/engine.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `tests/engine.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCbtEngine } from '../server/engine/cbtEngine.js';

function makeEngine({ reply = '好的', structured = null, promptText = 'SYSTEM PROMPT' } = {}) {
  const calls = [];
  const callModel = async ({ systemPrompt, messages }) => {
    calls.push({ systemPrompt, messages });
    const body = structured
      ? `${reply}\n{"__structured__": ${JSON.stringify(structured)}}`
      : reply;
    return { content: body, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  };
  const engine = createCbtEngine({
    getPrompt: () => promptText,
    callModel,
    schemas: { stuck_point: { title: '卡点标题', belief: '限制性信念' } },
  });
  return { engine, calls };
}

test('引擎把场景 prompt 与历史消息传给模型', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'chat',
    history: [{ role: 'user', content: '你好' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, 'SYSTEM PROMPT');
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: '你好' }]);
});

test('引擎返回剥离了结构化块的回复', async () => {
  const { engine } = makeEngine({
    reply: '这是正文。',
    structured: { title: '我不能停下来' },
  });
  const result = await engine({
    scenario: 'cbt_quick',
    history: [{ role: 'user', content: 'x' }],
    structuredOutput: 'stuck_point',
  });
  assert.equal(result.reply, '这是正文。');
  assert.deepEqual(result.structured, { title: '我不能停下来' });
});

test('引擎把 schema 提示拼进 system prompt', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'cbt_quick',
    history: [],
    structuredOutput: 'stuck_point',
  });
  assert.ok(calls[0].systemPrompt.includes('__structured__'));
  assert.ok(calls[0].systemPrompt.includes('卡点标题'));
});

test('schemas 传 { schema, notes } 时字段说明也进 system prompt', async () => {
  const calls = [];
  const callModel = async ({ systemPrompt }) => {
    calls.push({ systemPrompt });
    return { content: 'ok', usage: { total_tokens: 1 } };
  };
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel,
    schemas: {
      plan: {
        schema: { worth_practicing: true },
        notes: { worth_practicing: 'false 表示这一轮只交付诊断' },
      },
    },
  });
  await engine({ scenario: 'analysis', history: [], structuredOutput: 'plan' });
  assert.ok(calls[0].systemPrompt.includes('__structured__'));
  assert.ok(calls[0].systemPrompt.includes('false 表示这一轮只交付诊断'));
});

test('引擎把卡点与知识库注入 system prompt', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'cbt_delivery',
    history: [],
    clientContext: {
      stuckPoint: { title: '我不能停下来', belief: '停下来就会被抛弃' },
      knowledge: [{ kind: 'case', title: '一个案例', content: '案例正文' }],
    },
  });
  assert.ok(calls[0].systemPrompt.includes('我不能停下来'));
  assert.ok(calls[0].systemPrompt.includes('案例正文'));
});

test('没有请求结构化输出时不追加 schema 指令', async () => {
  const { engine, calls } = makeEngine();
  const result = await engine({ scenario: 'chat', history: [] });
  assert.ok(!calls[0].systemPrompt.includes('__structured__'));
  assert.equal(result.structured, null);
});

test('引擎返回 usage 与场景标识', async () => {
  const { engine } = makeEngine();
  const result = await engine({ scenario: 'chat', history: [] });
  assert.equal(result.usage.total_tokens, 3);
  assert.equal(result.scenario, 'chat');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../server/engine/cbtEngine.js'`。

- [ ] **Step 3: 实现 cbtEngine**

创建 `server/engine/cbtEngine.js`：

```js
import { buildStructuredInstruction, extractStructured, stripStructured } from './structuredOutput.js';

export function createCbtEngine({ getPrompt, getPromptMeta, callModel, schemas = {} } = {}) {
  if (!getPrompt) throw new Error('getPrompt is required');
  if (!callModel) throw new Error('callModel is required');

  function buildContextSection(clientContext) {
    const parts = [];
    if (clientContext && clientContext.stuckPoint) {
      const sp = clientContext.stuckPoint;
      const lines = [`卡点：${sp.title || ''}`];
      if (sp.belief) lines.push(`限制性信念：${sp.belief}`);
      if (Array.isArray(sp.evidence_against) && sp.evidence_against.length) {
        lines.push(`已有的反向证据：${sp.evidence_against.join('；')}`);
      }
      parts.push(`--- 这位来访者当前的卡点（已确认）---\n${lines.join('\n')}`);
    }
    if (clientContext && Array.isArray(clientContext.knowledge) && clientContext.knowledge.length) {
      const lines = clientContext.knowledge.map(
        k => `- 【${k.kind || 'note'}】${k.title || ''}：${k.content || ''}`
      );
      parts.push(
        '--- 可参考的教练知识库（仅在相关时使用，不要复述本节标题）---\n' + lines.join('\n')
      );
    }
    return parts.length ? '\n\n' + parts.join('\n\n') : '';
  }

  return async function runCbt({ scenario, history = [], clientContext = null, structuredOutput = null }) {
    let systemPrompt = getPrompt(scenario);
    systemPrompt += buildContextSection(clientContext);

    if (structuredOutput) {
      const entry = schemas[structuredOutput];
      if (!entry) {
        throw new Error(`未知的结构化输出类型：${structuredOutput}`);
      }
      // schemas 的值可以是：
      //   - 直接就是 schema（值级示例，只有形状）
      //   - { schema, notes } —— 形状 + 字段语义。语义必须单独传，
      //     混进 schema 里模型会照抄成输出的一部分。
      const schema = entry.schema ? entry.schema : entry;
      const notes = entry.notes ? entry.notes : null;
      systemPrompt += buildStructuredInstruction(schema, notes);
    }

    const result = await callModel({
      systemPrompt,
      messages: history.map(m => ({ role: m.role, content: m.content })),
    });

    const meta = getPromptMeta ? getPromptMeta(scenario) : null;

    return {
      reply: stripStructured(result.content),
      structured: structuredOutput ? extractStructured(result.content) : null,
      usage: result.usage || null,
      scenario,
      // prompt_version 的含义：装配后 prompt 的**内容哈希来源** ——
      // base 段与 scenario 段各自的内容哈希（Task 4 的 versionFor）。
      // 回答「这次对话是哪两段文本产生的」，而不是「是第几次改动」。
      promptVersion: meta ? `${meta.baseVersion}.${meta.scenarioVersion}` : null,
    };
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。

- [ ] **Step 5: 提交**

```bash
git add server/engine/cbtEngine.js tests/engine.test.js
git commit -m "feat: CBT Engine 抽离为 HTTP 无关的 runCbt()"
```

---

### Task 8: `/api/chat` 改为薄路由

**Files:**
- Modify: `server.js:324-432`（`/api/chat` handler）、`server.js` 导入区
- Modify: `db.js`（`conversations` 加字段、`messages` 加字段、`token_usage` 加字段）
- Test: `tests/api.chat.test.js`

**背景：** 现在 `/api/chat` 有 110 行，把会话管理、消息落库、模型调用、伪 SSE 全塞在一个 handler 里。改完后它只剩「取数据 → 调引擎 → 写数据 → 吐 SSE」。

- [ ] **Step 1: 写失败的测试**

创建 `tests/api.chat.test.js`：

```js
import './helpers/testEnv.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server.close());

beforeEach(() => resetDb());

test('对话接口返回 SSE 格式并带上会话 id 头', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  // 测试环境没有真实模型，预期是 5xx，但必须先创建出会话并返回 id 头
  if (res.status >= 500) {
    assert.ok(res.headers.get('X-Conversation-Id'), '缺少 X-Conversation-Id 头');
    return;
  }
  const text = await res.text();
  assert.ok(text.includes('data: '));
  assert.ok(text.includes('[DONE]'));
});

test('过期会话返回 410', async () => {
  const { getDb } = await import('../db.js');
  const db = getDb();
  const id = '11111111-2222-3333-4444-555555555555';
  const past = new Date(Date.now() - 86400000).toISOString();
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'active')"
  ).run(id, null, new Date().toISOString(), past);
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], conversation_id: id }),
  });
  assert.equal(res.status, 410);
});

test('会话记录了 scenario 字段', async () => {
  const { getDb } = await import('../db.js');
  const db = getDb();
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status, scenario) VALUES (?, ?, ?, 'active', 'cbt_quick')"
  ).run(id, null, new Date().toISOString());
  const row = db.prepare('SELECT scenario FROM conversations WHERE id = ?').get(id);
  assert.equal(row.scenario, 'cbt_quick');
});

test('messages 表能保存结构化输出', async () => {
  const { getDb } = await import('../db.js');
  const db = getDb();
  const id = 'cccccccc-1111-2222-3333-444444444444';
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, 'active')"
  ).run(id, null, new Date().toISOString());
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at, structured_json) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'assistant', '回复', new Date().toISOString(), JSON.stringify({ title: 'x' }));
  const row = db
    .prepare('SELECT structured_json FROM messages WHERE conversation_id = ?')
    .get(id);
  assert.equal(JSON.parse(row.structured_json).title, 'x');
});

test('token_usage 记录了 scenario 与 prompt_version', async () => {
  const { getDb } = await import('../db.js');
  const db = getDb();
  const id = 'dddddddd-1111-2222-3333-444444444444';
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, 'active')"
  ).run(id, null, new Date().toISOString());
  db.prepare(
    'INSERT INTO token_usage (conversation_id, prompt_tokens, completion_tokens, total_tokens, created_at, scenario, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 1, 2, 3, new Date().toISOString(), 'chat', 'a1b2c3d4.e5f6a7b8');
  const row = db
    .prepare('SELECT scenario, prompt_version FROM token_usage WHERE conversation_id = ?')
    .get(id);
  assert.equal(row.scenario, 'chat');
  // prompt_version = 装配后 prompt 的两段内容哈希（base 段 + scenario 段），
  // 不是「0.0」这种占位 —— 它必须能区分 chat 与 cbt_quick，也能回溯到具体文本。
  assert.equal(row.prompt_version, 'a1b2c3d4.e5f6a7b8');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `no such column: scenario`。

- [ ] **Step 3: 扩展表结构**

> 本步会把 `db.js` 的 `initSchema` 整体替换成下面这份完整代码。**它已经包含 Task 4 Step 6 加进去的 `prompt_scenarios` 表**，所以 Task 4 的改动不会丢失。Task 9 会在此基础上再加 `knowledge_entries`。

在 `db.js` 中，把 `initSchema` 改成下面这个完整形态 —— 即原有的 `db.exec(\`...\`)` 建表语句**原样保留**，只把函数结尾改成调用 `migrateSchema(db)`，并追加 `migrateSchema` 函数：

```js
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT DEFAULT 'active',
      client_id TEXT,
      scenario TEXT DEFAULT 'chat',
      link_kind TEXT DEFAULT 'test'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      structured_json TEXT
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_at TEXT NOT NULL,
      scenario TEXT,
      prompt_version TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
      ON token_usage(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_created
      ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_status
      ON conversations(status);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      is_coco INTEGER DEFAULT 0,
      avatar TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_scenarios (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_scenarios_active
      ON prompt_scenarios(id, is_active);
  `);

  // 轻量迁移：给已存在的表补列。
  migrateSchema(db);
}

// CREATE TABLE IF NOT EXISTS 对已存在的表不会改结构，
// 所以线上卷里的旧表需要靠这里补列。
function migrateSchema(db) {
  const additions = [
    ['conversations', 'client_id', 'TEXT'],
    ['conversations', 'scenario', "TEXT DEFAULT 'chat'"],
    ['conversations', 'link_kind', "TEXT DEFAULT 'test'"],
    ['messages', 'structured_json', 'TEXT'],
    ['token_usage', 'scenario', 'TEXT'],
    ['token_usage', 'prompt_version', 'TEXT'],
  ];
  for (const [table, column, type] of additions) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
```

- [ ] **Step 4: 把 /api/chat 改为薄路由**

在 `server.js` 导入区加入：

```js
import { createModelClient } from './server/engine/modelClient.js';
import { createCbtEngine } from './server/engine/cbtEngine.js';
import { STUCK_POINT_SCHEMA, STUCK_POINT_FIELD_NOTES } from './server/contracts/stuckPoint.js';
import { PLAN_SCHEMA, PLAN_FIELD_NOTES } from './server/contracts/plan.js';
```

在 `server.js` 的配置区（第 243–245 行，`const MINIMAX_API_KEY = ...` 那一段）加入一行，让测试可以指向一个不可达的本地地址，从而**离线且确定性地**触发失败，而不是去打真实网关：

```js
const MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'https://api.minimax.chat/v1/text/chatcompletion_v2';
```

在 `const promptRegistry = createPromptRegistry({ db });` 之后加入：

```js
const modelClient = createModelClient({
  apiKey: MINIMAX_API_KEY,
  baseUrl: MINIMAX_API_URL,
});
const cbtEngine = createCbtEngine({
  getPrompt: promptRegistry.getPrompt,
  getPromptMeta: promptRegistry.getPromptMeta,
  callModel: modelClient,
  // 形状给模型看，语义（哪个必填、枚举、worth_practicing 的 false
  // 是什么意思）必须一起给 —— 只给形状的话模型不知道 worth_practicing
  // 还有个有意义的 false 状态，会一律输出 true。
  schemas: {
    stuck_point: { schema: STUCK_POINT_SCHEMA, notes: STUCK_POINT_FIELD_NOTES },
    plan: { schema: PLAN_SCHEMA, notes: PLAN_FIELD_NOTES },
  },
});
```

把 `/api/chat` handler 整体替换为：

```js
app.post('/api/chat', async (req, res) => {
  const { messages = [], conversation_id, scenario = 'chat', client_id = null } = req.body || {};
  // scenario 是**用户请求体里的字段** —— 必须先做白名单校验再落库。
  // 未知场景直接 400：否则 getPrompt 抛错会变成 500，而用户消息已经落库了。
  if (!SCENARIO_IDS.includes(scenario)) {
    return res.status(400).json({ error: `Unknown scenario: ${scenario}` });
  }
  const userMsg = messages.filter(m => m.role === 'user').pop();

  let convId = conversation_id;
  const existing = convId ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) : null;
  if (existing && isExpired(existing.expires_at)) {
    if (existing.status !== 'expired') {
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('expired', existing.id);
    }
    return res.status(410).json({ error: 'Conversation expired', expired: true });
  }
  if (!existing) {
    convId = convId || generateId();
    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, status, scenario, client_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, null, now(), 'active', scenario, client_id);
    db.pragma('foreign_keys = ON');
  }

  if (userMsg) {
    db.prepare(
      'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(convId, 'user', userMsg.content, now());
  }

  try {
    const result = await cbtEngine.runCbt({
      scenario,
      history: messages.filter(m => m.role !== 'system'),
      structuredOutput: null,
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Conversation-Id', convId);

    // 伪 SSE：模型已返回完整文本，按 50 字符切片以兼容前端。
    if (result.reply) {
      const chunkSize = 50;
      for (let i = 0; i < result.reply.length; i += chunkSize) {
        const chunk = result.reply.slice(i, i + chunkSize);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();

    if (result.reply) {
      db.prepare(
        'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(convId, 'assistant', result.reply, now());
    }

    if (result.usage) {
      db.prepare(
        'INSERT INTO token_usage (conversation_id, prompt_tokens, completion_tokens, total_tokens, created_at, scenario, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        convId,
        result.usage.prompt_tokens || 0,
        result.usage.completion_tokens || 0,
        result.usage.total_tokens || 0,
        now(),
        scenario,
        result.promptVersion
      );
    }

    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId);
    if (conv && !conv.title && userMsg) {
      const title = userMsg.content.substring(0, 50) + (userMsg.content.length > 50 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
    }
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    if (error && error.name === 'ModelError') {
      return res.status(502).json({ error: 'AI Gateway error' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。

- [ ] **Step 6: 手工验证真实模型通路**

Run:
```bash
MINIMAX_API_KEY="$(grep '^MINIMAX_API_KEY=' .env | cut -d= -f2-)" PORT=8099 node server.js &
sleep 2
curl -sN -X POST http://127.0.0.1:8099/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"用一句话介绍你自己"}]}' | head -20
kill %1
```
Expected: 输出若干 `data: {...}` 行，最后是 `data: [DONE]`。**不要把 API key 打印出来** —— 上面的命令用 `grep`/`cut` 从 `.env` 取值，`$(...)` 的展开不会出现在终端输出里，但请确认终端没有回显完整命令历史；若不确定，改用 `export MINIMAX_API_KEY=...` 之外的 `set -a; source .env; set +a` 方式。

- [ ] **Step 7: 提交**

```bash
git add server.js db.js tests/api.chat.test.js
git commit -m "refactor: /api/chat 改为薄路由，调用抽离出的 CBT Engine"
```

---

### Task 9: 知识库检索与注入

**Files:**
- Modify: `db.js`（新增 `knowledge_entries` 表）
- Create: `server/engine/knowledge.js`
- Test: `tests/knowledge.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `tests/knowledge.test.js`：

```js
import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createKnowledgeStore } from '../server/engine/knowledge.js';

beforeEach(() => resetDb());

function seedEntry({ id, kind, title, content, tags }) {
  getDb()
    .prepare(
      'INSERT INTO knowledge_entries (id, kind, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, kind, title, content, JSON.stringify(tags || []), new Date().toISOString(), new Date().toISOString());
}

test('知识库能按 tag 检索', () => {
  seedEntry({ id: 'k1', kind: 'case', title: '自由职业转型', content: '来访者从阿里离职', tags: ['转行'] });
  seedEntry({ id: 'k2', kind: 'quote', title: '一句原话', content: '停下来就会被抛弃', tags: ['卡点'] });
  const store = createKnowledgeStore({ db: getDb() });
  const hits = store.search({ tags: ['转行'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'k1');
});

test('没有 tag 时按关键词匹配标题与正文', () => {
  seedEntry({ id: 'k1', kind: 'case', title: '自由职业转型', content: '来访者从阿里离职', tags: [] });
  seedEntry({ id: 'k2', kind: 'case', title: '异地搬迁', content: '搬家之后的状态', tags: [] });
  const store = createKnowledgeStore({ db: getDb() });
  const hits = store.search({ query: '阿里' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'k1');
});

test('检索有数量上限', () => {
  for (let i = 0; i < 10; i++) {
    seedEntry({ id: `k${i}`, kind: 'case', title: `案例${i}`, content: '转行', tags: ['转行'] });
  }
  const store = createKnowledgeStore({ db: getDb() });
  const hits = store.search({ tags: ['转行'], limit: 3 });
  assert.equal(hits.length, 3);
});

test('新建条目时 tags 存成 JSON 数组', () => {
  const store = createKnowledgeStore({ db: getDb() });
  const created = store.create({ kind: 'case', title: '新案例', content: '正文', tags: ['A', 'B'] });
  const row = getDb().prepare('SELECT tags FROM knowledge_entries WHERE id = ?').get(created.id);
  assert.deepEqual(JSON.parse(row.tags), ['A', 'B']);
});

test('检索结果可以被引擎拼成注入文本', () => {
  seedEntry({ id: 'k1', kind: 'case', title: '自由职业转型', content: '来访者从阿里离职', tags: ['转行'] });
  const store = createKnowledgeStore({ db: getDb() });
  const hits = store.search({ tags: ['转行'] });
  const section = store.formatForPrompt(hits);
  assert.ok(section.includes('自由职业转型'));
  assert.ok(section.includes('来访者从阿里离职'));
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `no such table: knowledge_entries`。

- [ ] **Step 3: 建表**

修改 `db.js` 的 `initSchema`，在 `prompt_scenarios` 之后追加：

```sql
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      source_url TEXT,
      embedding TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_entries(kind);
```

- [ ] **Step 4: 实现 knowledge store**

创建 `server/engine/knowledge.js`：

```js
import crypto from 'node:crypto';

export function createKnowledgeStore({ db } = {}) {
  function create({ kind, title, content, tags = [], source_url = null }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      kind,
      title,
      content,
      JSON.stringify(Array.isArray(tags) ? tags : []),
      source_url,
      now,
      now
    );
    return { id, kind, title, content, tags };
  }

  function search({ tags = [], query = '', kind = null, limit = 5 } = {}) {
    const rows = db.prepare('SELECT * FROM knowledge_entries').all();
    const wanted = tags.filter(Boolean);
    const q = query.trim();

    const scored = rows
      .map(row => {
        const rowTags = JSON.parse(row.tags || '[]');
        const tagHit = wanted.length ? wanted.filter(t => rowTags.includes(t)).length : 0;
        const haystack = `${row.title}\n${row.content}`;
        const queryHit = q ? (haystack.includes(q) ? 1 : 0) : 0;
        const kindHit = kind && row.kind === kind ? 1 : 0;
        return { row, score: tagHit * 2 + queryHit + kindHit };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at))
      .slice(0, limit);

    return scored.map(x => ({
      id: x.row.id,
      kind: x.row.kind,
      title: x.row.title,
      content: x.row.content,
      tags: JSON.parse(x.row.tags || '[]'),
      source_url: x.row.source_url,
    }));
  }

  function formatForPrompt(entries) {
    if (!entries || !entries.length) return '';
    const lines = entries.map(e => `- 【${e.kind}】${e.title}：${e.content}`);
    return '--- 可参考的教练知识库（仅在相关时使用，不要复述本节标题）---\n' + lines.join('\n');
  }

  function list({ kind = null, limit = 100 } = {}) {
    if (kind) {
      return db
        .prepare('SELECT * FROM knowledge_entries WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
        .all(kind, limit);
    }
    return db
      .prepare('SELECT * FROM knowledge_entries ORDER BY updated_at DESC LIMIT ?')
      .all(limit);
  }

  function remove(id) {
    return db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0;
  }

  return { create, search, formatForPrompt, list, remove };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。

- [ ] **Step 6: 提交**

```bash
git add db.js server/engine/knowledge.js tests/knowledge.test.js
git commit -m "feat: 知识库表与按 tag/关键词的检索"
```

---

### Task 10: 内部服务鉴权中间件

**Files:**
- Create: `server/auth.js`
- Modify: `server.js`（`requireAdmin` 迁出并引入 `requireInternal`）
- Modify: `.gitignore`（忽略 `.internal-token`）
- Test: `tests/auth.test.js`

**背景：** 契约 3 需要游民纪元的支付回调调用 Coco Avatar。这个接口不能走 admin 密码（admin 是网页后台用的），需要一个**独立的服务间密钥**。密钥只放在服务端，小程序与云函数持有。

- [ ] **Step 1: 写失败的测试**

创建 `tests/auth.test.js`：

```js
import './helpers/testEnv.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server.close());

test('内部接口未带 token 时返回 401', async () => {
  resetDb();
  const res = await fetch(`${base}/api/internal/ping`);
  assert.equal(res.status, 401);
});

test('内部接口 token 错误时返回 401', async () => {
  const res = await fetch(`${base}/api/internal/ping`, {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(res.status, 401);
});

test('内部接口带正确 token 时返回 200', async () => {
  const res = await fetch(`${base}/api/internal/ping`, {
    headers: { Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— 404（路由还不存在）。

- [ ] **Step 3: 实现 auth.js**

创建 `server/auth.js`：

```js
import crypto from 'node:crypto';

export function createRequireAdmin({ db, adminPassword }) {
  return function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const session = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
    if (!session || new Date(session.expires_at) < new Date()) {
      if (session) {
        db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

// 服务间鉴权：请求头 Authorization: Bearer <token>
// 用定长比较避免时序侧信道。
export function createRequireInternal({ serviceToken } = {}) {
  const expected = serviceToken || process.env.INTERNAL_SERVICE_TOKEN || '';
  return function requireInternal(req, res, next) {
    if (!expected) {
      return res.status(503).json({ error: 'INTERNAL_SERVICE_TOKEN not configured' });
    }
    const header = req.headers['authorization'] || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}
```

- [ ] **Step 4: 在 server.js 中启用**

在 `server.js` 导入区加入：

```js
import { createRequireAdmin, createRequireInternal } from './server/auth.js';
```

删除 `server.js` 里原来的 `function requireAdmin(req, res, next) { ... }` 整段，改为在 `const db = getDb();` 之后加：

```js
const requireAdmin = createRequireAdmin({ db, adminPassword: ADMIN_PASSWORD });
const requireInternal = createRequireInternal();
```

并在 `app.use(express.json());` 之后挂载内部路由的 ping（用来验证鉴权生效；真正的业务路由在计划 2 里加）：

```js
// 内部服务鉴权自检端点。计划 2 会在这里挂真正的业务接口。
app.get('/api/internal/ping', requireInternal, (req, res) => {
  res.json({ ok: true });
});
```

- [ ] **Step 5: 确认测试环境已设置 token**

`tests/helpers/testEnv.js` 在 Task 1 已经设置了：

```js
process.env.INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';
```

**无需再改**，直接进入下一步。若该行不在，检查 Task 1 的 Step 3 是否漏了。

- [ ] **Step 6: 忽略本地密钥文件**

修改 `.gitignore`，在文件末尾加入：

```
# 内部服务间密钥（不得提交）
.internal-token
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— `ℹ fail 0`。

- [ ] **Step 8: 提交**

```bash
git add server/auth.js server.js tests/auth.test.js tests/helpers/testEnv.js .gitignore
git commit -m "feat: 内部服务间鉴权中间件，与管理员会话分离"
```

---

### Task 11: 回归验证与部署

**Files:** 无代码改动（验证与发布）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部通过，`ℹ fail 0`。

- [ ] **Step 2: 本地构建检查**

Run: `npm run build`
Expected: 输出 `✓ built in ...`，无 TypeScript 报错。前端本计划几乎没动，这一步是确认没有连带破坏。

- [ ] **Step 3: 本地起服务做一次人工冒烟**

Run:
```bash
MINIMAX_API_KEY=dummy ADMIN_PASSWORD=test-admin PORT=8099 node server.js &
sleep 2
echo "--- 创建会话 ---"
curl -s -X POST http://127.0.0.1:8099/api/conversations
echo ""
echo "--- 内部接口无 token（应 401）---"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8099/api/internal/ping
kill %1
```
Expected: 第一条返回一个带 UUID 的 JSON；第二条输出 `401`。

- [ ] **Step 4: 备份线上数据库**

线上数据在 fly 卷 `coco_data` 里。部署前先备份。

先取机器 ID：

```bash
MACHINE_ID=$(https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  flyctl machines list -a coco-avatar-icy-sun-5917 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(m[0].id)})")
echo "machine: $MACHINE_ID"
```

再备份（`machine exec` 的整条命令必须作为一个带引号的字符串参数）：

⚠️ **不要用 `cp /data/coco.db /data/coco.db.bak`** —— 库是 **WAL 模式**，
已提交但还留在 `coco.db-wal` 里的数据**不在主文件里**。只 `cp` 主文件会
漏掉最近写入的会话与消息，而且**看不出来**（备份文件大小正常、内容少了一截）。

用 **better-sqlite3 的 `db.backup()`**（SQLite 自己的在线备份 API，
容器里已经装着 better-sqlite3 —— 见 Step 7 用的就是 `/app/node_modules/better-sqlite3`）。
它会走 SQLite 的 backup API，产出一份**包含 WAL 里已提交数据**的一致快照，
而且**不需要停服**：

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  flyctl machine exec "$MACHINE_ID" "node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/coco.db',{readonly:true});db.backup('/data/coco.db.bak.pre-foundation').then(()=>{console.log('backup ok');db.close();}).catch(e=>{console.error(e);process.exit(1);})\" && ls -la /data/"
```
Expected: 输出 `backup ok`，以及 `coco.db.bak.pre-foundation` 及其大小。

（`sqlite3 .backup` 是等价方案，但容器里没有装 sqlite3 CLI；better-sqlite3
的 `db.backup()` 走的是同一个 SQLite backup API，且不引入新依赖。）

**验一下备份真的包含数据**（可选但建议）：

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  flyctl machine exec "$MACHINE_ID" "node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/coco.db.bak.pre-foundation',{readonly:true});console.log('conversations:',db.prepare('SELECT COUNT(*) c FROM conversations').get().c);console.log('messages:',db.prepare('SELECT COUNT(*) c FROM messages').get().c);\""
```
Expected: `conversations:` 与 `messages:` 的数量与备份前一致（**不为 0**）。

- [ ] **Step 5: 设置内部服务密钥**

在本地生成并存入被忽略的文件（**不要把值打印到终端**）：

```bash
umask 077 && openssl rand -hex 32 > .internal-token && echo "已生成到 .internal-token（不打印内容）"
```

同步到 fly secret（值通过命令替换传入，不会作为字面量出现在命令里）：

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  flyctl secrets set INTERNAL_SERVICE_TOKEN="$(cat .internal-token)" -a coco-avatar-icy-sun-5917
```
Expected: 输出 `fly secrets set` 成功信息。

- [ ] **Step 6: 部署**

⚠️ 这一步会重启线上服务。部署前确认 §全局约定 里的 app 名与路径。

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  flyctl deploy --app coco-avatar-icy-sun-5917 --config /Users/cocogong/coco-startup/coco-avatar-main/fly.toml
```
Expected: 约 4 分钟后输出 `✔ Machine <机器ID> update succeeded`。

⚠️ **必须带代理前缀。** 2026-10-24 实测：shell 直连 `fly.dev` 会 12s 超时（`curl` 返回 000），`api.github.com` 和 `registry.npmjs.org` 却正常 —— 是 Clash 路由问题，不是凭据问题。Clash Verge 混合端口是 **7897**（7890 是关的）。
⚠️ DNS 校验可能因本地网络（Clash 屏蔽 8.8.8.8）失败，**这不代表部署失败**。以 `✔ Machine <id> update succeeded` 为准。

- [ ] **Step 7: 线上验证**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://coco-avatar-icy-sun-5917.fly.dev/api/internal/ping
```
Expected: `401`（说明路由已上线且鉴权生效）。

再验证迁移没有破坏现有数据：

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  flyctl machine exec "$MACHINE_ID" "node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/coco.db',{readonly:true});console.log('conversations:',db.prepare('SELECT COUNT(*) c FROM conversations').get().c);console.log('messages:',db.prepare('SELECT COUNT(*) c FROM messages').get().c);console.log('conversation columns:',db.prepare('PRAGMA table_info(conversations)').all().map(r=>r.name).join(','));console.log('prompt_scenarios:',db.prepare('SELECT COUNT(*) c FROM prompt_scenarios').get().c);\""
```
Expected:
- `conversations:` 约 89（部署前的数量，若期间有新增会更大）
- `messages:` 与部署前一致
- `conversation columns:` 包含 `client_id,scenario,link_kind`
- `prompt_scenarios:` 为 `0`（尚未在后台覆盖任何 prompt，全部走文件）

- [ ] **Step 8: 提交部署备注**

```bash
git add -A && git commit -m "chore: 底座改造部署上线（prompt 字节级不变，schema 已迁移）"
```
Expected: 若无改动则该命令无输出（`nothing to commit`），属正常。

---

## 有意为之的行为变更（相对 `main`）

本计划标题里那句「prompt 字节级不变 / 零行为变化」，准确含义是：

> **对格式正确的请求，线上 `POST /api/chat` 的行为不变**；
> 另有若干条**有意为之**的差异列在下面，每一条都有对应的回归测试钉住
> （`tests/api.livepath.test.js`），并且都记在这里。

不写下来的差异就是「惊喜」—— 未来的读者会以为「零行为变化」是字面意思，
然后在某个依赖旧行为的调用方那里踩坑。所以这一节是这份计划的一部分，
不是附录。

### 差异一览（全部有测试）

| # | 差异 | 现在是什么 | 为什么 | 测试 |
|---|---|---|---|---|
| 1 | 正文**无条件**剥结构化块 + trim | 即使本轮**没有**请求结构化输出，`stripAllStructured(raw).trim()` 也会跑：正文里恰好出现的合法 `{"__structured__": ...}` 块会被静默剥掉，首尾空白也会被 trim。`main` 是把模型原文逐字透传。 | 结构化块是**给程序看的** —— 不该出现在用户的聊天气泡里，也不该原样存进 `messages` 表再回灌给模型。 | `tests/api.livepath.test.js`「差异 1」 |
| 2 | 上游网关状态**统一折叠成 502** | 网关回 429/401/500，一律回 `502` + `{error:'AI Gateway error'}`。`main` 是原样回 `res.status(response.status)`（429 就是 429）。 | 502 表达「模型侧出问题了」；上游的真实状态码仍带在 `ModelError.status` 里，只进服务端日志，不给客户端。 | `tests/api.livepath.test.js`「差异 2」（429 与 401 各一条） |
| 3 | `conversation_id: ""` → **400** | 空串是**非法请求**。`main` 里空串是 falsy → **静默新建**一个会话（旧上下文被丢掉、调用方毫不知情）。 | 明确报错好过默默换一段会话。真实的客户端（`src/lib/api.ts`）传的是 `undefined`，从不传空串。 | `tests/api.livepath.test.js`「差异 3」 |
| 4 | `client_id` / `conversation_id` **类型**不对 → **400** | `main` 把它们直接丢给 better-sqlite3 与 SQL：传对象会抛 `RangeError`，而那发生在 async handler 里 → Express 4 不接 → unhandled rejection → **整个进程退出**。 | 400 远好过崩进程。（`client_id` 是**客户端自报的标签**，不进响应头，所以**不做字符集限制** —— 非 ASCII / 邮箱 / 人写的标签都合法。） | `tests/api.livepath.test.js`「差异 4」 |
| 5 | `conversation_id` **字符集**受限 → **400** | 只允许 `A-Za-z0-9._~-`（我们自己的 id 是 `crypto.randomUUID()`）。`main` 不限字符，于是 `conversation_id: "a\nb"` 会一路走到 `res.setHeader('X-Conversation-Id', ...)` 抛 `ERR_INVALID_CHAR`。 | 那个 id 会**原样进响应头**。在本分支的「先落库、再吐流」顺序下，它抛的时候**模型已经计费、库里已经留下孤儿会话与孤儿消息**了 —— 而这是公开端点，可以重复放大成本。所以字符集必须在**任何写库 / 调模型之前**拒掉。 | `tests/api.chat.test.js`「conversation_id 含换行 → 400（不建会话、不写消息、**不调模型**）」「conversation_id 含控制字符（\r / \0）→ 400（不调模型）」「conversation_id 含空格 → 400（不调模型）」 |
| 6 | `migrateSchema` 把 `duplicate column name` 当成**成功** | 之前任何 ALTER 失败都抛错 → `getDb()` 抛 → `server.js` 模块级 `const db = getDb()` 在 `listen()` 之前就抛 → 进程退出 → crash loop。 | `PRAGMA table_info` → `ALTER TABLE ADD COLUMN` 是 check-then-act，**不是**跨进程原子的。fly 滚动部署可能短暂有两个机器对着同一个卷跑迁移，输的那一个拿到的 `duplicate column name` 恰恰是**想要的结果**（列已经存在了）。别的 ALTER 失败照旧抛。 | `tests/db.schema.test.js`「并发 ALTER 撞车」 |
| 7 | 400 响应体里回显的用户输入**限长 40 + 去控制字符** | `Unknown scenario: ${scenario}` / `Unknown structured_output: ${structured_output}` 改成先过 `echoForError()`。合法取值**不变**（`'foo'` 还是 `'foo'`），只有超长 / 带控制字符的输入被改写。 | 这两个字段用户可控，而 `express.json()` 默认上限 100kb ⇒ 100kb 请求换来 100kb 响应（**响应放大**），而这个端点公开、可无限重复调用。控制字符还会污染日志与任何把错误体渲染成文本的地方。 | `tests/api.livepath.test.js`「差异 7」（两条） |
| 8 | 没有「**可发消息**」的请求 → **400**（本地拒掉，不建会话、不调模型）；本平台不存在的角色被**剔掉** | 判据：**至少要有一条 user/assistant 的、content 非空的消息**。`{"messages":[]}`、只有 system 消息、消息的 content 是空的 —— 这些请求**一条能发给网关的消息都没有**。网关的底线是「至少一条**非 system 的非空**消息」—— 其中「只有 system 的请求会被回 2013 `invalid params, chat content is empty`」是**线上实测**的；「content 是空的 / 元素是 null」这两档是**按这条底线推出来的**（没单独验过），但它们连「一条非 system 的非空消息」都凑不齐，落进同一档。所以这类请求注定被拒。本分支在**本地**就说清楚：`400` + `{"error":"messages 里至少要有一条有内容的用户或助手消息"}`，**不建会话、不调模型**。<br>另一面：`tool` / `developer` 这类本平台**不存在**的角色现在被**剔掉**（本平台自己的判据只认 user/assistant），而不是原样发给网关换一个说不清的 502。⚠️ 这里要说准确：这两个 400 是**本平台**给的，**不是**网关回的 2013 —— 网关在 **role 这一维上的态度我们没有验过**（验过的只有两档：只有 system ⇒ 2013；只有 assistant ⇒ 200 被接受；tool/developer 未知，MiniMax 文档说的 `invalid role` 是另一种接口的约束）。本平台**从严**：只认 user/assistant，不冒「发过去才发现网关不认」的险。<br>`main` 是把请求照发给网关、由网关来拒：网关回非 2xx（429/401/500）⇒ **原样回网关的状态码** + `'AI Gateway error'`（**不是**固定 400；见「差异 2」）；网关以 HTTP 200 + `base_resp{status_code:2013}` 回（老接口的形状）⇒ `data.choices?.[0]?.message?.content \|\| ''` 拿到空串 ⇒ 客户端收到一个**空气泡**（200，正文为空）。两种都不是「明确拒绝这个请求」，而且 `main` 这时**已经建了会话**（一个没人说话的会话行）。<br>（`content` 缺失 / `null` 元素这两种形状在 `main` 上更早就崩了 —— 见下面的「修好的」表。） | ①**可归因**：502「AI Gateway error」的语义是「AI 侧挂了」，会让调用方以为要重试或换模型；真相是「你压根没说要聊什么」，那是 400。②**不花钱**：这个端点公开且可重复调用，不该为「没内容」的请求花一次网关往返。③**不留垃圾**：`main` 那种「建了会话却没人说话」的行会一直堆在库里。 | `tests/api.livepath.test.js`「差异 8」（两条） |

> 表里的编号与测试名里的编号一一对应（「差异 1」…「差异 8」）。
> 第 5、6 两条的测试在**别的文件**里，所以没有用「差异 N」开头 ——
> 按「测试」列给出的文件与用例名去找即可。

#### 其余的行为差异（行为差异审计逐条核过的）

上面 8 条是**一开始就计划内**的。底座上线前又做了一次「逐条对着 `main` 核」
的行为审计（目的是确认「零行为变化」这句话到底在什么范围内成立），
核出下面这些**同样是差异、但不在原来那张表里**的条目。它们的共同点：
**每一条都是「`main` 的行为 ≠ 本分支的行为」，每一条都有测试钉住**。

| # | 差异 | `main` 上是什么 | 本分支是什么 | 为什么 | 测试 |
|---|---|---|---|---|---|
| 9 | 失败的一轮（上游 200 但**没有正文**）**照记账** | 回 **200** + 空气泡（正文为空），**有 usage 就照记 token 账** | 回 **502**（见「差异 2」），**也照记 token 账** —— 有 user 行、有 token 账、**没有** assistant 行（没有正文可存） | 「没拿到正文」不是「没付钱」：请求已经跑完了、tokens 已经被扣了。`server.js` 里本来就写着「token 账：**任何情况下都要记**」—— 502 那一档不记账就与这句话自相矛盾 | `tests/api.chat.test.js`「上游 200 但没有正文 → 502，这一轮的钱**照样记账**」 |
| 10 | 网关返回**无法解析的响应体**（HTTP 200 + HTML / 被截断） | `await response.json()` 抛原生 `SyntaxError`，落在 try 里 ⇒ 被 catch ⇒ 回 **500** `{"error":"Internal server error"}` | `modelClient` 把解析失败包成 `ModelError` ⇒ 回 **502** `{"error":"AI Gateway error"}` | 500 的语义是「我们自己的代码错了」；真相是「模型侧返回了坏东西」。502 才是「可以重试/该找模型侧」的那一档 | `tests/api.chat.test.js`「网关回 200 但响应体**不是 JSON** → 502（不是 500：那不是我们自己的错）」、`tests/engine.structured.test.js`「网关返回无法解析的响应时抛 ModelError 而不是原生 SyntaxError」 |
| 11 | 请求体**不是合法 JSON** ⇒ **400 + 简短 JSON**（永不给堆栈） | 交给 Express 的默认错误处理器 ⇒ 回 **HTML** 错误页（非 production 下还**带堆栈**） | 自建的错误中间件 ⇒ **400** + `{"error":"Invalid request body"}`，**任何时候都不给堆栈** | 堆栈是内部细节（路径、依赖版本、源码片段），与「500 不泄露内部细节」的目标一致 | `tests/api.chat.test.js`「请求体不是合法 JSON → 400 + 简短 JSON（不给堆栈）」 |
| 12 | 请求体**超过 100KB** ⇒ **400**（`main` 是 413） | body-parser 抛 `entity.too.large` ⇒ 默认处理器回 **413**（HTML） | 同一个错误中间件把它映射成 **400** + JSON | 请求体太大是**请求本身**的问题 ⇒ 4xx。413 在这里没有信息量（调用方并不需要知道上限是多少） | `tests/api.chat.test.js`「请求体超过 100KB → 400 + 简短 JSON（不给堆栈）」 |
| 13 | `client_id` / `conversation_id` **长度上限 128** | 没有任何长度上限 | 超过 128 ⇒ **400**（在**任何写库 / 调模型之前**） | `conversation_id` 会当**主键**写进库，还会原样进 `X-Conversation-Id` 响应头 —— 几万个字符会把响应头撑爆（Node 默认 16KB 上限），客户端拿到的是「连接被掐」（`UND_ERR_HEADERS_OVERFLOW`），**不是** 500；而那时库里已经落了行、模型的钱也已经付过了。`client_id` 会原样进库并进后台列表 | `tests/api.chat.test.js`「client_id 超过长度上限 → 400」「conversation_id 超过长度上限 → 400」 |
| 14 | `client_id` 与 `scenario` **被记进会话行** | `main` 的 `conversations` 表里**没有这两列**，`main` 的 `/api/chat` 也只解构了 `messages` 与 `conversation_id` ⇒ 传了也**被丢掉** | 两列都记下来 ⇒ `GET /api/conversations/:id` 与后台接口的响应体**多了两个字段** | 交付线要按 client 归集会话；`scenario` 是 prompt 的一部分，不记下来就查不出「这条会话用的是哪个 prompt」 | `tests/api.chat.test.js`「client_id 是字符串 → 原样记进会话」「scenario 也记进会话行（不记就查不出「这条会话用的是哪个 prompt」）」 |
| 15 | 会话过期时，POST **顺手把 `status` 置成 `expired`** | `main` 的 POST **只**回 410、**不**置 status（`main` 里做这个副作用的是它的 **GET** 会话接口） | POST 里顺手置了 | 那个会话确实过期了；「状态」与「事实」对不上会让后台的会话列表失真 | `tests/api.chat.test.js`「过期会话 → 410，会话状态被置为 expired」 |
| 16 | **先落库、再吐流** | 先 `res.write`/`res.end` 把回复**发出去**，**之后**才插 assistant 消息与 token 账 ⇒ 落库失败时**用户已经看到了回复、库里却没有这一轮、账也丢了** | 助手消息 + token 账 + 标题在**一个事务**里落完；落库失败就回 500、**一个字都不发** | 「用户看到了回复、库里却没有」是补不回来的残缺回合。顺序反过来之后，「库里有了、用户没看到」（用户刷新一下就能看到）就变成了可接受的失败 | `tests/api.chat.test.js`「落库发生在响应体写出去之前」「token 账写不进去时，助手消息也跟着回滚（同一个事务）」 |
| 17 | 新增 `GET /api/internal/ping`（内部服务鉴权自检） | 没有这个端点 | `requireInternal` 保护 ⇒ 无 token 一律 **401**；服务端没配 token ⇒ **503** | 计划 2 的内部接口要有「服务间鉴权可用」的探针，否则上线后第一件事就是「鉴权到底通没通」没人知道 | `tests/auth.test.js`「内部接口：没带 token → 401」「内部接口：token 正确 → 200 + { ok: true }」 |
| 18 | `token_usage` 多两列（`scenario` / `prompt_version`） | 只有 (id, conversation_id, prompt_tokens, completion_tokens, total_tokens, created_at) | 多两列 ⇒ 后台会话详情接口吐出的 `token_usage` 行**多了两个字段** | 成本要能**按场景**归集、要能追到**具体版本的 prompt**（两段内容哈希） | `tests/api.chat.test.js`「token_usage 记下 scenario 与 prompt_version（两段内容哈希，不是 0.0）」 |
| 19 | async 路由的异常**被兜住** | `/api/chat` 是**裸的** async handler ⇒ handler 里任何 throw（包括那几处**在 try 之外**的读库/写库）⇒ Express 4 不接 ⇒ unhandled rejection ⇒ **进程退出** | 所有 async 路由都过 `asyncRoute`（`server/asyncRoute.js`）⇒ 记日志 + **500** + JSON | 这是「修好的 1–4」能成立的前提：崩溃点从「进程退出」降级成「一个 500」。它是一条**规矩**（所有 async 路由都得包），所以单独成文件而不是塞在某一份路由代码里 | `tests/api.chat.test.js`「建会话失败时回 500，进程不崩（async handler 的兜底）」、`tests/asyncRoute.test.js` |

> 这张表里**没有**「请求体逐字节相同」那一条 —— 那不是差异，是**限定条件**，
> 见下面「仍然成立的『零行为变化』保证」一节。

#### 「差异 8」的两道防线

「至少要有一条能发给网关的消息」这条规则在**两个层次**上成立，判据只有
**一份**（`server/engine/cbtEngine.js` 导出的 `usableMessages`）：

| 层 | 位置 | 作用 |
|---|---|---|
| 第一道 | `server.js` 的 `/api/chat` 路由 | 在**所有参数校验之后**、**会话过期检查之后**、**建会话之前**就拒掉 ⇒ 不留孤儿会话、不白调一次模型。回 **400**。<br>位置是有讲究的：抢在参数校验前面，会把「scenario 写错了」报成「messages 没内容」—— 更具体的错被更笼统的错盖住（引擎那边 `empty_history` 也是**最后**一道，顺序要一致）。 |
| 第二道 | `server/engine/cbtEngine.js`（`empty_history`） | 所有**直接调引擎**的调用方的收口点 —— `server/delivery/*` 与将来的游民纪元 BFF。回 **400**（`server/errorStatus.js` 的 `ENGINE_ERROR_STATUS` 里新增了一条）。<br>⚠️ **在底座这条分支上，这道防线从 HTTP 路由走不到**：`server/delivery/` 只有 `identity.js` 与 `progress.js`，都不调引擎。它的证据是单元测试 + 错误码表；它是给**将来**的调用方准备的契约。交付线那条（`server/delivery/analysis.js` 的 `ANALYSIS_TURN`）在**自己的分支**上已经补了 —— 那是**调用方该补的**任务轮，引擎补不了。 |

为什么引擎不能替调用方补上那条消息：引擎**不知道「现在要做什么」**。
素材全走注入通道的调用方（1v1 转写、卡点、教练手法都进了 system prompt）
手上没有对话，history 就是空的 —— 那条「任务轮」只能由调用方自己补
（交付线的 `server/delivery/analysis.js` 里的 `ANALYSIS_TURN` 就是这么做的：
它不是素材，只是把「现在要做什么」说清楚）。

引擎这一层挡的是**没补**的那一种：它不知道任务，但它知道「网关不收这种
请求」—— 与其花一次网关往返换一个说不清的 502，不如在本地就说清楚是
「这个请求没有内容」。

**为什么这条值得单列一条差异**：它同时暴露了一个更老的问题 ——
`tests/api.chat.test.js` 与 `tests/api.livepath.test.js` 里原先有几条
断言钉的是**虚构**（假 fetch 对任何请求都回 200，于是「请求体形状不对」
这一类 bug 在测试里根本看不见）。现在多了一个**按网关规则行事**的假
fetch（`tests/helpers/gatewayRule.js`）：它按网关的真实形状回
（2013 / `base_resp`），所以这类 bug 再也藏不住。

⚠️ 但要说清楚**两个 400 的来源不同**，别混成一句话：
网关会回 2013 的形状是「**没有一条非 system 的非空消息**」；
而 `tool` / `developer` 那种形状是**本平台自己**挡的（判据只认 user/assistant）——
真发到网关会不会被接受，**没验过**（验过的只有「只有 assistant ⇒ 200」这一档，
不能外推到 tool/developer）。本平台从严，是**不拿未验行为冒险**，不是
「知道网关会拒」。所以测试里分开两组写：网关也会拒的 / 本平台更严的。
假 fetch 的规则也据此写（`tests/helpers/gatewayRule.js` 的注释里钉着）。

#### 判据只能有一份：另外两处看着像，其实不是

同一个「这句话能不能发给网关」的判断，在这套代码里有过**三份**。前两份共用
同一份 `usableMessages`（`server/engine/cbtEngine.js` 导出就是为了这个）：

| 判据 | 在哪 | 管什么 |
|---|---|---|
| `usableMessages` | `server/engine/cbtEngine.js` | 哪些消息**能发给网关**（user/assistant + content 非空）—— **判据本身** |
| 路由的守卫 | `server.js` | 请求**一条都发不出去** ⇒ 400（不建会话、不调模型） |
| 落库的挑法 | `server.js` | 哪条 user 消息**进库** |

还有两处**不是判据**、但容易被误当成判据：

- `server/engine/modelClient.js` 里的 `.filter(m => m.role !== 'system')` 是
  **传输规则**（system 已经在请求体开头单独放了，这里只是别发两条），
  它**不管**别的 role、也**不看** content 空不空。所以**绕过引擎直接调
  modelClient 的调用方**（将来的游民纪元 BFF）要自己先过一遍
  `usableMessages`。这层没有守卫是有意的：这里的错只能是编程错误，而它抛的
  错会被回成 500 —— 对「请求没内容」来说 500 是错的语义（那是 400）。
- 前端 `src/hooks/useChat.ts` 的 `.filter(m => m.role === 'user' || m.role === 'assistant')`
  是**类型**约束（`ChatMessage` 只有这两种 role），不是「能不能发」的判据。

**第三份（落库）曾经是另一套**：`messages.filter(m => m && m.role === 'user').pop()` ——
取的是**最后一条** user 消息，不管它的 content 有没有内容。于是

    [{"role":"user","content":"第一条"},{"role":"user","content":""}]

这种请求：引擎剔掉空的那条、发给网关的是「第一条」，但落库时 `pop()` 拿到的是
**空的那条** ⇒ 「模型听见了的那句话」**没进库**，会话里只剩 assistant 的一条
回话 —— 一个「模型听见了、库里没有」的回合。现在落库也走 `usableMessages`
⇒ 落库的**就是模型真的看见的那条**。（钉在 `tests/api.chat.test.js`
「落库的用户消息 = 真正发给模型的那一条」。）

⚠️ 但**别把它写成「发出去的 = 存下来的」** —— 那句话在多于一条 user 消息时
不成立，而且**不该**成立：
- 客户端（`src/hooks/useChat.ts`）每一轮都带**完整历史** + 本轮新的那条
  user 消息；
- 服务端因此只**追加本轮新增的那一条** user 消息（+ assistant 回复）——
  之前的轮次在**之前的请求**里已经落库了。

所以「一次请求里带多条 user 消息」时，只有**最后一条**进库，前面几条模型
看得见、库里没有。

⚠️ 注意「正常路径**也**带多条 user 消息」：客户端每轮带的是**完整历史 +
本轮新的那条**，第 2 轮起请求里就有多条 user 消息了。区别不在「有几条」，
而在**前面那几条是不是已经在库里了** —— 正常路径里它们是**之前的请求**
落过库的，所以不丢。真正会丢的是**同一条请求里出现两条都还没落库的
user 消息**（这个端点公开、无鉴权 ⇒ 谁都能这么发）：那时前一条模型看得见、
库里没有，而且**没有任何提示**（见下面的「已知残留」）。

#### 错误优先级：更具体的错先报出来

`{"messages":[],"scenario":"no_such_scenario"}` 报哪个？**Unknown scenario**。
「没内容」是最笼统的错，不该盖住「你把场景名写错了」这种一看就能改的错。
路由里的守卫因此排在**所有参数校验之后**、**会话过期检查之后**、**建会话之前**。

⚠️「和 main 一致」这句话要**限定范围**：

- 「过期会话 + 没内容的消息」⇒ `main` 是 **410**（`main` 压根没有「没内容」
  这一档），我们也是 410 —— 一致。
- 「过期会话 + 别的参数也写错了」（比如 `scenario` 写错）⇒ `main` 是 **410**
  （`main` **根本没有** scenario 校验，过期检查在最前），我们是 **400
  Unknown scenario**（我们先校验参数）。两个都是 4xx、请求本身也确实非法，
  方向上是「更具体的错先报」，但**顺序与 main 不一致** —— 钉在
  `tests/api.chat.test.js`「过期会话 + 别的参数也写错了 → 400（参数错先报；与 main 的顺序不同）」那条。

另外：过期检查在守卫之前 ⇒ 「过期会话 + 没内容的消息」这个请求，**会先把
会话状态置成 `expired`** 再回 410。⚠️ `main` 的 POST **只**回 410、**不**置
status（`main` 里做这个副作用的是它的 GET 会话接口）—— 这一条与 `main`
**不一样**。本分支在 POST 里顺手置了：那个会话确实过期了。

#### 已知残留（这一轮不修，写下来）

- **一条请求里带两条「都还没落库」的 user 消息 ⇒ 前一条静默丢掉。**
  模型看得见（两条都发给了网关），库里只有最后一条，回 200，**没有任何提示**。
  这个端点公开、无鉴权，所以谁都能这么发 —— 比下面那条 assistant-only 更容易
  触发（不用构造角色，只要多发一条）。将来要么落库时把可发的 user 消息都写进去
  （但那会和「客户端每轮带完整历史」打架 ⇒ 重复插历史），要么显式加一个
  「本轮 user 消息」的字段，要么直接 400（可发的 user 消息 > 1 就拒）。
  **这是一个待定的契约缺口，不是 bug 修复项** —— 改哪一边都要先想清楚
  「一轮」到底怎么定义。

- **只有 assistant 消息的请求**：判据允许（网关也接受 —— 线上验过），于是这条路
  是**通的**：HTTP 200、**真的调了一次网关**（要花钱）、**建出了会话行**
  （`title` 为 null）、消息表里**只有 assistant 一行、没有 user 行**。
  前端不会这么发（`useChat` 每一轮都带一条新的 user 轮），所以这是**契约缺口**
  而不是线上 bug；但这个端点**公开、无鉴权**，所以别把它当成「不可能发生」。
  将来收紧判据（比如「最后一条必须是 user」）会让这类请求变成 400 —— 那是
  **有意为之**的行为变更，要写进差异表。
- **history 没有长度上限**：`MAX_CONTEXT_CHARS = 4000` 只约束注入的
  `clientContext`，不约束 history。每一条 user 轮都**完整**发给网关。唯一的
  上限是 `express.json()` 的 100kb 请求体上限。这是**既有**问题，不是这一轮
  引入的。
- **首轮请求里，模型第一眼看到的是 assistant 而不是 user**：`useChat` 的
  初始 state 是那条首屏问候语（`{role:'assistant', content:WELCOME_MESSAGE}`），
  它会被当「上一轮」一起发给网关，而服务端**不**把它落库（不是 user 轮）。
  MiniMax 对「第一条是 assistant」敏不敏感，**我们没验过** —— 记成一个待验项，
  这一轮不改（改它就改了发给网关的请求体 ⇒ 破坏「与 main 逐字节相同」）。

### 本分支**修好**的（`main` 上会整站下线）—— 正面的差异

`main` 的 `/api/chat` 有**四个**请求形状会**杀掉整个进程**。fly.io 跑的是**单进程**，
所以这四个输入每一个都等于「整站不可用」（Node 20 默认 `unhandledRejection = throw` → 进程退出）：

| 输入 | `main` 上发生了什么 | 本分支 |
|---|---|---|
| `{"messages":[{"role":"user"}]}` | `userMsg.content` 是 `undefined` → 被当成 NULL 写进 `NOT NULL` 列 → `SqliteError` 抛在 try **之外** → unhandled rejection → **进程退出** | **400**（`messages 里至少要有一条有内容的用户或助手消息`）⇒ 不建会话、不调模型、进程不崩 |
| `{"messages":[{"role":"user","content":null}]}` | 同上（NULL 写进 `NOT NULL` 的 `content` 列） | **400**（同上） |
| `{"messages":[null]}` | `m.filter(m => m.role === 'user')` → `TypeError`（读 `null.role`）→ 同样 unhandled rejection → **进程退出** | **400**（同上） |
| `{"messages":"不是数组"}` | `messages.filter` 不是一个函数 → `TypeError` → 同样 unhandled rejection → **进程退出** | **400**（`messages 必须是数组`） |

⚠️ 四个崩溃点**全都在 `main` 的 try 之外**（那个 try 从 `fetch` 那行才开始），
所以 `main` 的 `catch` 接不住它们 —— 这就是为什么它们是「进程退出」而不是「500」。

**这是本分支最重要的正面差异**，也是「零行为变化」这句话必须读成
「对**格式正确**的请求零行为变化」的原因。

四条都有测试：`tests/api.livepath.test.js`「修好的 1」…「修好的 4」。

### 本分支**修好**的（`main` 上**根本构建不起来**）

这不是运行时差异，是**构建**差异 —— 但它同样让「从 `main` 干净地重建线上
镜像」这件事做不到，所以必须记下来：

| 问题 | `main` 上 | 本分支 |
|---|---|---|
| `src/data/stories.ts` **从来没被提交过** | `.gitignore` 里有一条**没锚定**的 `data/`（第 37 行）—— gitignore 的模式不含斜杠时**在任意层级都匹配** ⇒ `src/data/` 一起被忽略 ⇒ `src/data/stories.ts`（前端源码，`src/pages/GlobeScene.tsx` 与 `src/pages/StoryPage.tsx` 都 import 它）永远进不了仓库 ⇒ **干净 clone 之后 `npm run build` 必失败** | `c405842` 把文件提交进来；`b8896fc` 把模式锚定成 `/data/`（并给 `*.db` / `*.db-wal` / `*.db-shm` 补了根目录锚定） |

⚠️ 为什么在本地「看起来是好的」：文件在**磁盘上**（只是没进 git），
所以在开发机上 `npm run build` 能过、`docker build` 也能过（构建上下文里有这个
文件）。**只有干净 clone 才暴露** —— 而 CI、别人的机器、新同事的第一次
`git clone`、以及**任何从 `main` 干净地重建线上镜像的动作**，全是干净 clone。
所以这条是「看着没问题、换个环境就炸」的那一类。

**实测（2026-10-25）**：

```bash
git clone --no-local --branch main <repo> /tmp/cleanclone-main
cd /tmp/cleanclone-main && npx vite build
# ⇒ x Build failed in 617ms
#   Could not resolve "../data/stories" from "src/pages/GlobeScene.tsx"
```

同一件事在本分支上：

```bash
git clone --no-local --branch feature/foundation-2026-10-24 <repo> /tmp/cleanclone
cd /tmp/cleanclone && npx vite build
# ⇒ ✓ built in 3.31s
```

（两个 clone 都复用了同一个 `node_modules` —— 这里验的是**源码能不能解析**，
不是依赖能不能装。）

⚠️ 同一个坑在 `.dockerignore` 里也有一份（Docker 的忽略文件用的是 gitignore
式语义，**不含斜杠的模式匹配任意层级**）。本分支自己踩过一次：`c096715`
在 `.dockerignore` 里写了 `data` ⇒ 会把 `src/data/` 一起排除 ⇒ 镜像里的
`RUN npm run build` 解析不到 `../data/stories` ⇒ **构建失败、部署被卡死**
（镜像出不来，旧版本继续跑）。`8b58d90` 把它改成不依赖任何忽略语义假设的
写法（删掉 `data` 那一行，靠 `*.db` / `*.db-wal` / `*.db-shm` 覆盖根目录
`data/` 里的三个文件 —— 这三个模式**不可能**匹配到 `stories.ts`），并在
注释里写清楚了这个坑，免得下一个人再把 `data` 加回来。

⇒ 教训：**改忽略文件时，要问「这个模式会不会在别的层级也命中」** ——
`data/`、`data`、`docs`、`tests` 这类名字在同一个仓库里出现两次，就一定会
出事（`src/data/` 与根 `data/`、`docs/` 与未来的 `src/docs/`）。

> ⚠️ 这两条以前写的是「→ 200」，那是**虚构**。
>
> 当时的断言是「content 不是非空字符串的消息不进库 → 200」+「null 元素被
> 跳过 → 200」，靠的是**假 fetch 对任何请求都回 200**。生产上这两种请求
> 会被发到网关（请求体里只有一条 system），而网关拒绝这种请求
> （2013 `chat content is empty`）⇒ 回 **502**。也就是说「200 + 一条助手
> 消息」只在测试里发生过。
>
> 现在回 400：这些请求确实**一条能发的话都没有**（`{"role":"user"}` 的
> content 是 `undefined`；`content: null` 是 NULL；`[null]` 整个元素就是空的；
> `messages` 不是数组时根本连「消息」都谈不上），说清楚比假装回了一轮
> 对话好。判据与「差异 8」是同一条：**至少要有一条有内容的 user/assistant
> 消息**。

### 仍然成立的「零行为变化」保证（**以及它的适用范围**）

⚠️ 「逐字节不变」这句话**有条件**。它成立的范围是：**线上 `main` 那种
请求**（`scenario` 是 `chat`、没有结构化输出、没有注入上下文、消息只带
`{role, content}` 且内容非空）。超出这个范围，请求体就**不**逐字节相同了 ——
而且**这是有意的**，因为那些都是 `main` 上根本不存在的功能：

| 条件 | 请求体为什么不再与 `main` 相同 |
|---|---|
| `scenario` 不是 `chat` | system prompt = 「persona 底座段 + **该场景的段**」。`main` 只有一个 `SYSTEM_PROMPT`，没有场景这回事（这条差异是**加功能**，不是改行为） |
| 本轮请求了结构化输出 | 引擎往 system prompt 后面追加了格式说明（`buildStructuredInstruction`）⇒ system 段变了 |
| 带上了 `client_context` / 知识库 | 引擎往 system prompt 后面追加了上下文段（`buildContextSection`）⇒ system 段变了 |
| 消息带 `{role, content}` 以外的字段 | `main` 把消息对象**整个**转发给网关（`...messages.filter(...)`），本分支只转发 `{role, content}`（`modelClient` 里 `.map(m => ({role: m.role, content: m.content}))`）⇒ 多出来的键被丢掉了 |
| 消息里有空 content / `tool` / `developer` 角色 | `main` 原样转发；本分支**剔掉**（判据见「差异 8」）⇒ 消息数组变短 |

所以准确的说法是：

- **对 `main` 那种请求**（`scenario=chat`、无结构化输出、无注入上下文、
  消息只带 `{role, content}` 且内容非空），**发给网关的请求体逐字节不变**：
  `tests/api.prompt.test.js`「发往网关的请求体与 main 逐字节一致」断言
  `init.body` 与
  `JSON.stringify({model, messages:[{role:'system',content:<黄金快照>}, ...], max_tokens:2000})`
  **完全相等**（包括键的顺序）。system prompt 用的是
  `tests/fixtures/legacy-chat-prompt.txt` —— 那份文件与 `main` 的 `SYSTEM_PROMPT`
  字面量逐字节相同，所以这里钉的是**请求**，不是拼装。
- **prompt 拼装不变**：`tests/api.prompt.test.js`「线上 prompt 与黄金快照仍然一致」
  （同样只针对 `chat` 场景）。
- **其余场景的 prompt 是新加的**，不在「逐字节不变」的保证范围内 ——
  它们是新功能，不是行为回归。

---

## 验收标准

- [ ] `npm test` 全绿，且**不引入任何 npm 依赖**（`git diff package.json` 只多一行 `test` 脚本）
- [ ] `registry.getPrompt('chat')` 与 `tests/fixtures/legacy-chat-prompt.txt` 逐字节相同 —— **这是"部署后行为零变化"的唯一保证**
- [ ] **发给网关的请求体**（不只是 prompt 拼装）与 `main` 逐字节相同 —— 见 `tests/api.prompt.test.js`「发往网关的请求体与 main 逐字节一致」
- [ ] 「有意为之的行为变更」一节里列的每一条差异都有对应的回归测试（`tests/api.livepath.test.js`）
- [ ] **干净 clone 之后** `npm run build` 与 `npm test` 都过（`src/data/stories.ts` 在仓库里；`.gitignore` / `.dockerignore` 的模式都锚定了根目录）
- [ ] `src/constants/systemPrompt.ts` 已删除，仓库里不再有两份 prompt
- [ ] `/api/chat` handler 从 110 行降到 60 行以内，模型调用逻辑全部在 `server/engine/`
- [ ] 线上 `conversations` / `messages` / `token_usage` 数据量与部署前一致，新列已存在
- [ ] `/api/internal/*` 无 token 一律 401

---

## 已知不在本计划内

- 交付模块的表（`clients` / `plans` / `practices` / `evidences`）与 API → 计划 2
- 教务后台与用户端的页面 → 计划 3
- 音频转写与导出 → 计划 4
- 前端组件测试基建（需要引入 vitest + jsdom 两���依赖）→ 本轮不做。前端改动靠 `npm run build` 的类型检查 + 人工冒烟把关，这是「极简、克制」原则下的取舍
- 真流式（`runCbtStream`）→ 阶段 2。急救箱是一次性单向链，非流式够用
