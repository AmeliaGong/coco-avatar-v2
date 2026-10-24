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
- Modify: `db.js`（新增 `prompt_scenarios` 表）
- Modify: `package.json`（新增 `prompt:split` 脚本）
- Delete: `src/constants/systemPrompt.ts`
- Test: `tests/promptRegistry.test.js`

**背景（实测发现）：** `src/constants/systemPrompt.ts`（5693 字符）**全项目零 import，是死代码**，且与线上 `server.js` 里的版本（5231 字符）内容不一致。改它线上不会有任何变化。这份计划会把它删掉，并把 prompt 变成文件 + 可版本化的数据库覆盖层。

**核心约束：** 迁移后 `getPrompt('chat')` 必须与生产 prompt **逐字节相同**。用黄金文件断言保证。

- [ ] **Step 1: 写失败的测试**

创建 `tests/promptRegistry.test.js`：

```js
import './helpers/testEnv.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPromptRegistry } from '../server/promptRegistry.js';
import { getDb } from '../db.js';

const GOLDEN = 'tests/fixtures/legacy-chat-prompt.txt';

before(() => {
  const db = getDb();
  db.prepare('DELETE FROM prompt_scenarios').run();
});

test('黄金文件存在且非空', () => {
  const text = fs.readFileSync(GOLDEN, 'utf8');
  assert.ok(text.trim().length > 1000, '黄金文件内容异常短');
});

test('装配出的 chat prompt 与生产快照逐字节相同', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const golden = fs.readFileSync(GOLDEN, 'utf8').trim();
  assert.equal(registry.getPrompt('chat').trim(), golden);
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
  db.prepare('DELETE FROM prompt_scenarios').run();
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
  db.prepare('DELETE FROM prompt_scenarios').run();
});

test('persona.v2 存在但默认不激活', () => {
  const v2 = fs.readFileSync('prompts/persona.v2.md', 'utf8');
  assert.ok(v2.includes('转化原则') || v2.includes('绝不主动'), 'persona.v2 缺少转化原则');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `ENOENT: no such file or directory, open 'tests/fixtures/legacy-chat-prompt.txt'`。

- [ ] **Step 3: 从生产代码抽取黄金文件（机械操作，不手抄）**

Run:
```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('server.js','utf8');
const m=s.match(/const SYSTEM_PROMPT = \`([\s\S]*?)\`;/);
if(!m) throw new Error('SYSTEM_PROMPT not found in server.js');
const body=m[1].trim();
fs.mkdirSync('tests/fixtures',{recursive:true});
fs.writeFileSync('tests/fixtures/legacy-chat-prompt.txt', body+'\n');
console.log('golden bytes:', body.length);
"
```
Expected: 输出 `golden bytes: 5230`。

- [ ] **Step 4: 机械拆分成 persona 与 scenario（保证字节级一致）**

Run:
```bash
node -e "
const fs=require('fs');
const g=fs.readFileSync('tests/fixtures/legacy-chat-prompt.txt','utf8').trim();
const i=g.indexOf('【故事模式】');
if(i<0) throw new Error('boundary marker 【故事模式】 not found');
fs.mkdirSync('prompts',{recursive:true});
fs.writeFileSync('prompts/persona.base.md', g.slice(0,i).trim()+'\n');
fs.writeFileSync('prompts/scenario.chat.md', g.slice(i).trim()+'\n');
console.log('split at offset', i);
"
```
Expected: 输出 `split at offset 152` —— persona 150 字节、scenario 5078 字节。

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
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts'
);

// id -> 文件名。未在数据库中被覆盖的场景从这里读取。
const SCENARIO_FILES = {
  'scenario.chat': 'scenario.chat.md',
  'scenario.cbt_quick': 'scenario.cbt_quick.md',
  'scenario.cbt_delivery': 'scenario.cbt_delivery.md',
  'scenario.analysis': 'scenario.analysis.md',
  'persona.base': 'persona.base.md',
};

export function createPromptRegistry({ db, promptsDir = PROMPTS_DIR } = {}) {
  function readOverride(id) {
    const row = db
      .prepare(
        'SELECT body, version FROM prompt_scenarios WHERE id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1'
      )
      .get(id);
    return row ? { body: row.body, version: row.version, source: 'db' } : null;
  }

  function readFile(id) {
    const file = SCENARIO_FILES[id];
    if (!file) return null;
    const full = path.join(promptsDir, file);
    if (!fs.existsSync(full)) return null;
    return { body: fs.readFileSync(full, 'utf8').trim(), version: 0, source: 'file' };
  }

  function getPart(id) {
    const override = readOverride(id);
    if (override) return override;
    const fromFile = readFile(id);
    if (fromFile) return fromFile;
    throw new Error(`未知的 prompt 场景：${id}`);
  }

  function getPrompt(scenarioId) {
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return `${base.body}\n\n${scenario.body}`;
  }

  function getPromptMeta(scenarioId) {
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return {
      scenarioId,
      baseVersion: base.version,
      scenarioVersion: scenario.version,
      source: `${base.source}+${scenario.source}`,
    };
  }

  function setPromptOverride(id, body) {
    const maxRow = db
      .prepare('SELECT MAX(version) AS v FROM prompt_scenarios WHERE id = ?')
      .get(id);
    const version = (maxRow && maxRow.v ? maxRow.v : 0) + 1;
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO prompt_scenarios (id, version, body, is_active, updated_at) VALUES (?, ?, ?, 1, ?)'
    ).run(id, version, body, new Date().toISOString());
    return { id, version };
  }

  function listScenarios() {
    return Object.keys(SCENARIO_FILES).map(id => {
      const part = readOverride(id) || readFile(id);
      return {
        id,
        version: part ? part.version : null,
        source: part ? part.source : 'missing',
        length: part ? part.body.length : 0,
      };
    });
  }

  return { getPrompt, getPromptMeta, setPromptOverride, listScenarios, readPart };
}
```

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

export function buildStructuredInstruction(schemaHint) {
  return [
    '',
    '---',
    '在你这一轮回复的最后，另起一行，输出一个 JSON 对象。',
    '这一行只能是 JSON，不要用代码块包裹，不要有多余解释文字。格式：',
    JSON.stringify({ [STRUCTURED_MARKER]: schemaHint }, null, 2),
    '---',
  ].join('\n');
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
      const schema = schemas[structuredOutput];
      if (!schema) {
        throw new Error(`未知的结构化输出类型：${structuredOutput}`);
      }
      systemPrompt += buildStructuredInstruction(schema);
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
  ).run(id, 1, 2, 3, new Date().toISOString(), 'chat', '0.0');
  const row = db
    .prepare('SELECT scenario, prompt_version FROM token_usage WHERE conversation_id = ?')
    .get(id);
  assert.equal(row.scenario, 'chat');
  assert.equal(row.prompt_version, '0.0');
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
import { STUCK_POINT_SCHEMA } from './server/contracts/stuckPoint.js';
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
  schemas: { stuck_point: STUCK_POINT_SCHEMA },
});
```

把 `/api/chat` handler 整体替换为：

```js
app.post('/api/chat', async (req, res) => {
  const { messages = [], conversation_id, scenario = 'chat', client_id = null } = req.body || {};
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
MACHINE_ID=$(flyctl machines list -a coco-avatar-icy-sun-5917 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(m[0].id)})")
echo "machine: $MACHINE_ID"
```

再备份（`machine exec` 的整条命令必须作为一个带引号的字符串参数）：

```bash
flyctl machine exec "$MACHINE_ID" "cp /data/coco.db /data/coco.db.bak.pre-foundation && ls -la /data/"
```
Expected: 输出 `coco.db.bak.pre-foundation` 及其大小。

- [ ] **Step 5: 设置内部服务密钥**

在本地生成并存入被忽略的文件（**不要把值打印到终端**）：

```bash
umask 077 && openssl rand -hex 32 > .internal-token && echo "已生成到 .internal-token（不打印内容）"
```

同步到 fly secret（值通过命令替换传入，不会作为字面量出现在命令里）：

```bash
flyctl secrets set INTERNAL_SERVICE_TOKEN="$(cat .internal-token)" -a coco-avatar-icy-sun-5917
```
Expected: 输出 `fly secrets set` 成功信息。

- [ ] **Step 6: 部署**

⚠️ 这一步会重启线上服务。部署前确认 §全局约定 里的 app 名与路径。

```bash
flyctl deploy --app coco-avatar-icy-sun-5917 --config /Users/cocogong/coco-startup/coco-avatar-main/fly.toml
```
Expected: 约 4 分钟后输出 `✔ Machine <机器ID> update succeeded`。DNS 校验可能因本地网络（Clash 屏蔽 8.8.8.8）失败，**这不代表部署失败**。

- [ ] **Step 7: 线上验证**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://coco-avatar-icy-sun-5917.fly.dev/api/internal/ping
```
Expected: `401`（说明路由已上线且鉴权生效）。

再验证迁移没有破坏现有数据：

```bash
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

## 验收标准

- [ ] `npm test` 全绿，且**不引入任何 npm 依赖**（`git diff package.json` 只多一行 `test` 脚本）
- [ ] `registry.getPrompt('chat')` 与 `tests/fixtures/legacy-chat-prompt.txt` 逐字节相同 —— **这是"部署后行为零变化"的唯一保证**
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
