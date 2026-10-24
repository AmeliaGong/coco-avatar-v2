# Coco Avatar 教练交付模块 × 游民纪元 设计规格

日期：2026-10-24
状态：待评审
作者：Coco + Claude（brainstorming 会话）

---

## 1. 背景

Coco Avatar 上线以来承载真实付费客户（如某位真实付费客户）。当前工作流是手工的：

1. 客户在 Coco Avatar 完成 CBT 练习，获得领悟；
2. Coco 做 1 小时真人 1v1（手机 / 飞书 / 腾讯视频**录音**）；
3. 录音转文字 → 放进 WorkBuddy → 产出可视化 HTML 方案与 14 天练习；
4. HTML 以链接形式发给客户；
5. 客户练习成果**没有回到平台**，全部沉淀在 HTML 和 Coco 的脑子里。

同时，WeStream 正在筹备《游民纪元（Nomad Era）》App MVP 1.0（微信小程序优先，8 周买断冲刺，2026-12-01 → 2027-01-31），其商业入口 1 是「6 份高管潜能全案报告 & 1v1 解读」￥980 —— **这正是 Coco Avatar 交付模块的付费出口**。

本设计要让这两件事共用一套底座，并且不破坏任一方已定的产品原则。

### 1.1 驱动需求（Coco 原话拆解）

| # | 诉求 | 对应能力 |
|---|---|---|
| D1 | 后台能导出对话数据，喂给 WorkBuddy 分析 | 会话导出（Markdown 档案 + JSON） |
| D2 | 手机/飞书录音 → 自动转写 → 分析 → 出方案 | 音频上传 + 自动转写 + 教练分析 prompt |
| D3 | 方案自动回到用户界面 | `plans` 状态机 + 用户端方案页 |
| D4 | 每个用户卡点不同，且不是每个卡点都值得做练习 | 教练可判定「不做练习」，只交付诊断 |
| D5 | 有时需要 Coco 手工补充个性化数据 | 教练可手工编辑方案与练习卡片 |
| D6 | 用户首页主动收到更新后的练习 | 方案发布 → 用户端状态可见（**非 IM 红点**） |
| D7 | 用户实时看到未来愿景和练习成果 | 愿景 + 成果可视化（V2.0 指标） |
| D8 | 真人 Coco 持续喂材料，让 Coco Avatar 更懂 | 知识库（检索注入，非模型微调） |

---

## 2. 核心概念与边界

### 2.1 两个产品、两层职责

| | 游民纪元 MVP 1.0 | Coco Avatar 教练交付模块 |
|---|---|---|
| 角色 | ToC 获客与信任过滤 | ToB 付费交付与陪跑 |
| 载体 | 微信小程序（原生） | Web（现有 SPA + Express + SQLite） |
| 人 | 领养者（职场人）/ 游民 / 管理员 | 教练（Coco）/ 客户（付费用户） |
| 术语 | 分校（用户侧）/ 教务（Coco 侧） | 教务 / 客户 |

**关系：游民纪元是漏斗顶端（获客 + 信任过滤），Coco Avatar 交付模块是漏斗底端（交付 + 陪跑）。两者由「卡点」这一实体串联。**

### 2.2 「严禁对话」禁区的准确边界（重要，勿再反复讨论）

游民纪元 MVP 1.0 的三条禁区中，「严禁 IM / 双向打字聊天」指的是：

> **游民与游民之间**的互动 —— 领养后像旅行青蛙一样，只有静态图片/卡片在游民之间单向流动和传递，不做聊天。

**不**约束：

- 用户与 Coco Avatar（AI 教练）之间的 CBT 对话 —— 这是**教练交付面**，必须有对话；
- 教练（Coco）后台与客户档案之间的交互 —— 这是**教务工作台**。

因此最终形态是：**小程序内只有一个 AI 对话入口（认知急救箱，一次一问、问答完成即主动终止），其余全部是卡片。** 这与「严禁 IM」不冲突。

### 2.3 「交付 ≠ 开始」

方案交付给客户，不代表客户开始练了。`plans.status` 为四态：

```
draft ──publish──▶ pending_activation ──客户确认──▶ active ──结项──▶ archived
  │                     │
  └──────┬──────────────┘
         └── 撤回/作废
```

- `draft`：教练在后台编辑中（**永不对客户可见**）
- `pending_activation`：已交付，客户界面可见「你的练习已就绪，需确认开始」
- `active`：客户已确认，练习进行中
- `archived`：完成或作废

「已交付待确认」是**业务状态，不是 IM 红点**。游民纪元的「不设已读未读红点」禁区不适用于此 —— 后者是消息系统，前者是履约状态。

### 2.4 术语表

| 名词 | 含义 |
|---|---|
| 卡点 / `stuck_point` | 用户当前的限制性信念与核心卡点，贯穿全流程的核心实体 |
| 方案 / `plan` | 一次 1v1 交付的结构化产物（含练习与成果定义） |
| 练习 / `practice` | 方案下的执行项（长版 14 天 / 短版 1 个微行动） |
| 证据 / `evidence` | 客户在练习中回填的「今天发生了一次 X，让我意识到 Y」 |
| 场景 / `scenario` | Prompt Registry 中的一段编排（急救箱 / 交付 / 故事） |
| 教务 / 教练 | Coco 本人 |
| 分校 / 客户 | 付费用户 |

---

## 3. 系统架构

### 3.1 全局视图

```
┌──────────────────────────────────────────────────────────────┐
│ 微信小程序「游民纪元」（新建 · 原生 wxml/wxss）                │
│  Tab1 旷野橱窗（领养/静态卡片传递）                             │
│  Tab2 今日回响（每日切片 + ★Coco 认知急救箱 = 一次一问 CBT 链）  │
│  Tab3 生命之流（三轨仪表盘 + 商业入口1 ￥980 / 入口2 / 入口3）   │
└───────────────────────────┬──────────────────────────────────┘
                            │ wx.request
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 微信云函数 BFF（新建 · 极薄）                                  │
│  · 持有 Coco Avatar service token（密钥不进小程序）             │
│  · 透传 / 聚合 / 简单校验                                      │
│  · 存在原因：微信小程序 request 合法域名要求已 ICP 备案，        │
│    fly.dev 为境外域名无法备案 → 不能直连                       │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Coco Avatar 线上（保留 Web 形态 = 教练交付工作台）              │
│  ├─ CBT Engine（HTTP 无关的纯模块）                            │
│  ├─ Prompt Registry（persona.base + scenario.*）               │
│  ├─ 交付模块 API（clients / plans / practices / knowledge）     │
│  └─ 教务后台 Web（桌面浏览器）                                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ 单向同步（仅 3 项摘要指标）
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 游民纪元 Supabase（PostgreSQL）                                │
│  users / relationships / daily_cards / feed_actions           │
│  + client_id 映射字段                                          │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 为什么小程序必须新建（而不是扩展 Coco Avatar 的壳）

三条硬约束：

1. **渲染模型不兼容** —— Coco Avatar 前端是 Vite SPA + WebGL 3D 星球 + 客户端路由；微信小程序是双线程渲染、无 DOM、无 history 路由、组件为 wxml/wxss 自定义标签。迁移成本 ≈ 重写，8 周冲刺内不可能。
2. **领域模型不兼容** —— Coco Avatar 现有 5 张表（`conversations / messages / token_usage / admin_sessions / stories`）**没有 user 表、没有 client 表**，「专属链接」即身份；游民纪元是 users/relationships/daily_cards/feed_actions 的多对多领养世界。
3. **形态不兼容** —— 教务后台需要桌面浏览器与宽屏表格，不适合小程序。

### 3.3 为什么复用 Coco Avatar 是对的

已沉淀且昂贵的三样：**人格话术**、**会话与计费基础设施**（SQLite WAL + `token_usage` + 过期链接机制）、**AI 网关与错误处理**。重建这些是浪费。

### 3.4 为什么需要云函数 BFF（不可省略）

微信小程序配置 `request` 合法域名要求域名**已 ICP 备案**；`coco-avatar-icy-sun-5917.fly.dev` 为境外域名，无法备案 → 小程序无法直接请求。替代方案是迁移到国内可备案的云（放弃 fly，成本与工期不可接受）。

云函数请求外部 HTTPS 不受此限制，故选云函数 BFF。

**附带收益**：service token 只存在云函数，小程序端不持有任何密钥。

---

## 4. 跨产品契约（跨产品不可改错的部分）

M1（12.01–12.14）的 PM 交付物包含「编写 CBT Prompt」。**以下三个契约必须在 M1 之前定稿**，否则 Prompt 写完即返工。

### 契约 1：`stuck_point` 结构（游民纪元产出 → 教练交付消费）

```jsonc
{
  "id": "uuid",
  "source": "nomad_quickbox" | "cbt_session" | "coach_manual",
  "title": "我不能停下来，因为一旦停下来就会被抛弃",   // 卡点一句话（≤30字）
  "belief": "限制性信念全文",
  "evidence_against": ["一条反向证据"],              // 急救箱版 1 条；交付版多条
  "emotion": "焦虑",
  "micro_action": "今天记录一次「我可以慢下来」的时刻",  // 急救箱版产出
  "created_at": "ISO8601"
}
```

**同一份 `stuck_point` 在用户付费后直接进客户档案，无需重新询问痛点。** 这是「信任过滤」与「付费交付」之间的数据脐带，也是竞品做不到的事。

### 契约 2：教练分析输出 JSON schema（教练分析 prompt → `plans.payload`）

```jsonc
{
  "diagnosis": {
    "core_belief": "…",
    "pattern": "…",              // 重复的行为模式
    "root_cause": "…"
  },
  "vision": {                     // 未来愿景（用户端可见）
    "title": "…",
    "narrative": "…",             // 2–3 段叙事，Coco 的原话
    "horizon": "3_months" | "1_year" | "life"
  },
  "practices": [
    {
      "day": 1,
      "title": "…",
      "intent": "…",             // 这一步在验证什么假设
      "action": "…",             // 具体可执行动作
      "evidence_prompt": "…",    // 回填证据的引导问句
      "success_criteria": "…"
    }
  ],
  "worth_practicing": true        // ← D4：教练可判定「这一轮不安排练习」
}
```

`worth_practicing: false` 时，`practices` 为空数组，方案只交付诊断与愿景。**这是「不是每个卡点都值得做练习」的落地开关。**

### 契约 3：支付成功 → 建客户 + 签发链接（事件式，不走数据同步）

```
游民纪元支付回调
  → 云函数
  → POST /api/internal/clients
      { nomad_user_id, plan_code, display_name? }
      Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
  ← 200 { client_id, access_url }
  → 小程序跳转 access_url
```

**幂等**：同一 `nomad_user_id` 重复调用返回既有 `client_id` 与新签发的链接，不重复建档。

---

## 5. 数据模型

### 5.1 Coco Avatar 侧新增表（SQLite，`db.js`）

```sql
-- 客户（付费用户 / 被教练服务的人）
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone TEXT,                       -- 可选，仅作找回用，不是账号体系
  email TEXT,
  source TEXT,                      -- 'nomad_era' | 'manual'
  external_id TEXT,                 -- 游民纪元 users.id（source='nomad_era' 时有）
  status TEXT NOT NULL DEFAULT 'active',   -- active | archived
  notes TEXT,                       -- 教练私有备注，永不下发
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_clients_external ON clients(external_id) WHERE external_id IS NOT NULL;

-- 卡点（贯穿急救箱与交付）
CREATE TABLE stuck_points (
  id TEXT PRIMARY KEY,
  client_id TEXT,                   -- NULL = 尚未付费（游民纪元急救箱产出）
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  belief TEXT,
  evidence_against TEXT,            -- JSON array
  emotion TEXT,
  micro_action TEXT,
  raw_json TEXT,                    -- 完整结构化输出
  created_at TEXT NOT NULL
);

-- 方案（一次 1v1 交付）
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  stuck_point_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|pending_activation|active|archived
  version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,            -- 契约 2 的 JSON
  diagnosis_md TEXT,               -- 教练手写补充（Markdown）
  created_at TEXT NOT NULL,
  published_at TEXT,
  activated_at TEXT,
  archived_at TEXT
);

-- 练习项（plan 的下挂执行项）
CREATE TABLE practices (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  day INTEGER,
  title TEXT NOT NULL,
  intent TEXT,
  action TEXT,
  evidence_prompt TEXT,
  success_criteria TEXT,
  custom_data TEXT,                 -- 教练手工补充的个性化数据（D5）
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 练习证据（客户回填）
CREATE TABLE evidences (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_at TEXT,
  created_at TEXT NOT NULL
);

-- 1v1 记录（录音转写与分析）
CREATE TABLE sessions_1v1 (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  plan_id TEXT,
  audio_path TEXT,
  transcript TEXT,
  source TEXT,                      -- 'phone' | 'feishu' | 'tencent' | 'upload'
  duration_sec INTEGER,
  created_at TEXT NOT NULL
);

-- 知识库（真人持续喂材料）
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- case | quote | judgment | term
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,                        -- JSON array
  source_url TEXT,
  embedding TEXT,                   -- 预留，向量检索
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 教练提示词底座（Prompt Registry 的存储形态）
CREATE TABLE prompt_scenarios (
  id TEXT PRIMARY KEY,              -- 'cbt_quick' | 'cbt_delivery' | 'story'
  name TEXT NOT NULL,
  base_key TEXT NOT NULL,           -- 'persona.base'
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
```

### 5.2 现有表的最小改动

| 表 | 改动 | 理由 |
|---|---|---|
| `conversations` | 加 `client_id TEXT`（可空）、`scenario TEXT`（`chat`/`quickbox`/`delivery`）、`link_kind TEXT`（`test`/`client`） | 让链接从「身份」降级为「访问凭证」，客户成为一等公民 |
| `messages` | 加 `structured_json TEXT` | 保存 CBT 结构化输出（卡点等） |
| `token_usage` | 加 `scenario TEXT`、`prompt_version TEXT` | 按场景归集成本；任何一条历史消息可追溯当时的人格版本 |
| `stories` | 不动 | 故事模块保留在 Web 侧 |

> 术语统一：全项目一律称 `scenario`（场景），不再使用 `mode`。

### 5.3 数据主权与同步方向

| 数据 | 归属 | 理由 |
|---|---|---|
| 身份、领养关系、每日卡片、投喂记录 | 游民纪元 `users` 等 | ToC 主数据 |
| 1v1 记录、方案全文、教练私有备注、练习成果 | Coco Avatar | **私有教务数据，本就不该在 ToC 端** |
| 映射 | `coco_avatar.clients.external_id ↔ nomad_era.users.id` | 一个用户一个主 ID |

**同步只走一个方向：Coco Avatar → 游民纪元**，且只回写三项摘要：

```jsonc
// POST /api/internal/sync/nomad
{
  "external_id": "...",
  "stuck_point_title": "…",     // 卡点一句话
  "practice_progress": 0.42,    // 当前练习完成度 0–1
  "vision_progress": 0.30       // 未来愿景推进度 0–1
}
```

**小程序永远拿不到教练的完整转写与私有备注。** 这既是隐私边界，也是「极简克制」的技术兑现。

---

## 6. Prompt Registry（底座改造）

### 6.1 现状问题（实测）

- [server.js:8](../server.js#L8) 的线上 `SYSTEM_PROMPT`（5231 字符 / 230 行）在用；
- [src/constants/systemPrompt.ts:3](../src/constants/systemPrompt.ts#L3)（5693 字符 / 211 行）**全项目零 import —— 是死代码，且与线上内容不一致**；
- 改前端那份，线上行为不会变 —— 地雷。

### 6.2 目标结构

```
prompts/
  persona.base.md        # 人格、价值观、对话风格、转化原则（唯一真相源）
  scenario.story.md     # 故事模式（现有故事素材）
  scenario.cbt_quick.md # 急救箱版：5 步单向链，问答完成即主动终止
  scenario.cbt_delivery.md # 交付版：教练式、允许自由对话、可引用知识库
  scenario.analysis.md   # 教练分析 prompt（录音转写 → 契约 2 的 JSON）
```

- `persona.base` 为**唯一真相源**，`server.js` 与后台共用；`src/constants/systemPrompt.ts` **删除**，杜绝双份漂移。
- 运行时：`最终 prompt = persona.base + scenario.<id>`，场景可由 `prompt_scenarios` 表覆盖（不重启即可调优）。
- `scenario.cbt_quick` 与 `scenario.cbt_delivery` **共享同一套 CBT 方法论**（触发 → 自动想法 → 证据 → 替代认知 → 行动实验），只在流程编排与粒度上不同。

### 6.3 为什么这必须在 M1 之前

M1 的 PM 交付物是「编写 CBT Prompt」。Prompt 的结构直接依赖场景编排方式，而场景编排依赖 `stuck_point` 契约（契约 1）与教练分析 schema（契约 2）。三者是一条链，顺序不能颠倒。

---

## 7. CBT Engine（HTTP 无关的纯模块）

### 7.1 现状

`/api/chat`（[server.js:324](../server.js#L324)）在一个 handler 里同时承担：prompt 拼装、DB 读写、模型调用、伪 SSE。**伪 SSE**：调用 MiniMax 非流式端点取回全文后按 50 字符切片伪装成 SSE（前端兼容用）。

### 7.2 目标接口

```ts
// src/engine/cbtEngine.ts —— 纯模块，不依赖 req/res
export interface CbtRunInput {
  scenario: 'cbt_quick' | 'cbt_delivery' | 'story';
  history: { role: 'user' | 'assistant'; content: string }[];
  clientContext?: {
    stuckPoint?: StuckPoint;
    knowledge?: KnowledgeEntry[];   // 检索注入
  };
  structuredOutput?: 'stuck_point' | 'plan';  // 期望的结构化产出
}

export interface CbtRunResult {
  reply: string;                    // 给用户看的回复
  structured?: object;              // 结构化产出（契约 1 / 契约 2）
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  scenarioId: string;
  promptVersion: string;            // 可追溯
}

export async function runCbt(input: CbtRunInput): Promise<CbtRunResult>;
```

- Express 路由与云函数 BFF 都只做「取数据 → 调 `runCbt` → 写数据」。
- **真流式是独立后续项**（`runCbtStream`），本设计不依赖它 —— 急救箱是一次性单向链，非流式完全够用。
- `promptVersion` 写进 `messages`/`token_usage`，保证任何一条历史消息都能追溯当时的人格版本。

---

## 8. 交付模块功能设计

### 8.1 教务后台（Web，桌面浏览器）

新增导航：**客户 / 方案 / 知识库**（现有：对话列表 / 生成链接 / 统计面板）。

#### 客户档案页 `/admin/clients`
- 列表：姓名、来源、最近互动、方案数、状态
- 详情：档案卡 + 关联卡点 + 方案时间线 + 练习证据回看
- 操作：**导入对话历史**（从既有 `conversations` 挂到该客户下）、导出、编辑备注

#### 方案编辑器 `/admin/clients/:id/plans/new`
三栏：
- **左：素材** —— 该客户的对话历史（可勾选纳入分析）、1v1 录音转写、知识库检索结果
- **中：结构化表单** —— 契约 2 的字段（诊断 / 愿景 / 练习项）；教练可直接编辑每个字段（D5 手工补充）
- **右：预览** —— 用户端将看到的最终形态（卡片式）

流程：
```
1. 选客户 → 2. 上传录音（自动转写）/ 粘贴转写文本 → 3. 选参考对话 + 检索知识库
→ 4. 「生成草稿」= 调 scenario.analysis → 5. 教练审阅修改（可整段重写）
→ 6. 发布（draft → pending_activation）
```

#### 知识库 `/admin/knowledge`
- 条目增删改查，按 `kind` / `tags` 检索
- 一键「喂入知识库」：粘贴飞书文档正文或上传录音转写 → 生成 `case` 条目
- 供 `scenario.cbt_delivery` 与 `scenario.analysis` 检索注入

### 8.2 用户端（现有 `/c/:id` 会话页 + 新增方案页）

Coco Avatar 用户端目前是**单页聊天**（`ChatPage` + `useChat` + `ChatArea`）。新增：

#### 方案接收页 `/c/:id/plan`
- `pending_activation` 时：显示「Coco 为你准备了一份练习」+ **开始按钮**（`→ active`）+ 方案摘要
- `active` 时：**当前练习卡**（第几天 / 意图 / 具体动作 / 成功标准）
- 证据回填表单（一次一问，非自由聊天；提交即存 `evidences`）
- **未来愿景**区块（来自 `payload.vision`，始终可见）

#### 首页
- 顶部：**当前练习状态条**（不是红点，是状态条：未开始 / 进行中 第 N 天 / 已完成）
- 「你的愿景」区块 + 进度
- 「练习成果」区块 —— V2.0 指标（新证据非空 + 连续天数）

### 8.3 音频转写

- 上传音频（Coco 手机 / 飞书 / 腾讯视频录音）
- 服务端调 **OpenRouter `whisper-1`** 转写（`.env` 中 `OPENROUTER_API_KEY` 已存在，当前代码未使用）
- 转写文本存入 `sessions_1v1.transcript`
- 可手动修正后保存
- 音频文件存 fly 卷 `coco_data` 下新目录（`DB_PATH` 同卷）

### 8.4 导出

- **会话导出**（D1）：单会话 / 客户全部会话 → **Markdown 档案 + JSON** 两种格式，供 WorkBuddy 分析
- **方案导出**：客户可见稿（教练内部稿 ≠ 客户稿的两层拆分，沿用现有 WorkBuddy 稿的 house style）

---

## 9. API 清单

### 9.1 公共 / 用户端

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/conversations` | 创建会话（已有） |
| GET | `/api/conversations/:id` | 会话信息（已有） |
| POST | `/api/chat` | 对话（已有，需加 `scenario` / `client_id`） |
| GET | `/api/clients/:id/plan` | 取当前方案（用户视角，裁剪私有字段） |
| POST | `/api/clients/:id/plan/activate` | 确认开始（`pending_activation → active`） |
| POST | `/api/practices/:id/evidence` | 提交证据 |

### 9.2 教练后台（`requireAdmin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PATCH | `/api/admin/clients` | 客户 CRUD |
| GET | `/api/admin/clients/:id` | 客户详情（档案 + 卡点 + 方案 + 证据） |
| GET | `/api/admin/clients/:id/export` | 导出 Markdown 档案 + JSON |
| POST | `/api/admin/clients/:id/plans` | 新建方案（草稿） |
| PATCH | `/api/admin/plans/:id` | 编辑方案（含手工补充） |
| POST | `/api/admin/plans/:id/generate` | 调教练分析生成草稿 |
| POST | `/api/admin/plans/:id/publish` | `draft → pending_activation` |
| POST | `/api/admin/plans/:id/archive` | 作废 / 结项 |
| POST | `/api/admin/clients/:id/sessions` | 上传音频 → 转写 |
| GET/POST/PATCH | `/api/admin/knowledge` | 知识库条目 |
| POST | `/api/admin/clients/:id/attach` | 把既有 `conversations` 挂到客户名下 |
| GET | `/api/admin/prompt-scenarios` | Prompt Registry 查看/切换版本 |

### 9.3 服务间（`Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/internal/clients` | 契约 3：建客户 + 签发链接（幂等） |
| POST | `/api/internal/sync/nomad` | 单向同步三项摘要 |
| POST | `/api/internal/cbt/run` | 云函数 BFF 调用的引擎入口（服务端 token） |

---

## 10. 分期与排期

### 阶段 0 · 准备期（2026-10-24 → 11-30，5 周）—— **不占用 8 周冲刺资源**

> **实施计划的范围仅限阶段 0。** 阶段 1 是游民纪元侧的联调（由其团队主导），阶段 2 是本模块的下一轮迭代，各自独立排期。本规格三阶段合在一起仍偏大，但三者之间无代码依赖，可独立拆分为三次 implementation plan —— **下一次只做阶段 0**。

| 交付 | 说明 |
|---|---|
| **契约 1 + 契约 2 定稿** | `stuck_point` 结构、教练分析 JSON schema。**最高优先级**，M1 要写 Prompt |
| **Prompt Registry 底座** | `persona.base` + `scenario.*` 拆分；删除 `src/constants/systemPrompt.ts` 死代码；`prompt_scenarios` 表 |
| **CBT Engine 抽离** | `src/engine/cbtEngine.ts` 纯模块，`/api/chat` 改为薄路由 |
| **交付模块第一期** | `clients` / `stuck_points` / `plans` / `practices` 表 + 客户档案页 + 方案编辑器 + 发布流 + 用户端方案页 + 导出 + 音频转写 |
| **知识库第一期** | `knowledge_entries` + 录入与检索注入 |

### 阶段 1 · 游民纪元 8 周冲刺（2026-12-01 → 01-31）—— **本模块只占 PM 零碎时间**

- 只做契约 1/2/3 的**契约对齐**与联调，不做新功能
- 云函数 BFF 与小程序急救箱联调（M2 前后）
- 契约 3 支付回调联调

### 阶段 2 · 2027-02 起

- 练习闭环指标（新证据非空 + 连续天数）
- 真流式（`runCbtStream`）
- 知识库向量化与语义检索
- 练习成果可视化、愿景推进度

---

## 11. 非目标（YAGNI）

明确**不做**：

- 小程序内的自由聊天（只有一次一问的急救箱链）
- 教练与客户在小程序内的直接消息
- 小程序内展示教练私有备注、完整转写
- 模型微调 / 训练管线（人格靠 Prompt Registry + 知识库，不靠训练）
- 复杂的账号体系（手机号仅作找回，不是账号）
- 多分支 RPG 式练习树（练习是线性 14 天）
- 复杂钱包与提现（游民纪元侧禁区）
- 老会话数据迁移（仅提供「补挂客户」动作，挂 ~12 条近 30 天活跃链接；历史不迁）

---

## 12. 风险与开放问题

| # | 风险 / 问题 | 处置 |
|---|---|---|
| R1 | 小程序审核与备案（`fly.dev` 不可备案） | 云函数 BFF 绕开；阶段 0 内先跑通最小云函数 |
| R2 | 契约 1/2/3 若在 M1 后才定 → Prompt 返工 | 列为阶段 0 第一优先级，11-30 前定稿 |
| R3 | `token_usage` 只按会话记，无按客户归集 | `client_id` 落到会话后可按客户聚合；阶段 2 再做成本视图 |
| R4 | 教练手工编辑与 AI 草稿冲突 | 方案有 `version`；「重新生成」时保留教练手工字段（标记 `custom_data` 的不被覆盖） |
| R5 | 现有 89 条内测会话的归属 | 不迁移；提供「补挂客户」动作 |
| R6 | 管理员口令仍为默认值 `admin` | 与本设计无关，但优先级高于上线；`flyctl secrets set ADMIN_PASSWORD=…` |
| R7 | 交付模块代码尚未纳入 git | 阶段 0 开始前先把现有 18 个未提交变更提交并推 `AmeliaGong/coco-avatar-v2` |

### 开放问题

1. **契约 3 的支付通道**：游民纪元的支付回调形态（微信支付商户回调 / 第三方）尚未确定，影响 `POST /api/internal/clients` 的调用方与幂等键设计。→ 阶段 1 联调前确认。
2. **`INTERNAL_SERVICE_TOKEN` 的分发与轮换**：`flyctl secrets set` 即可，但需确定是否多环境（dev/staging/prod）分 token。
3. **知识库的检索方式**：阶段 0 先用 SQLite FTS5 或简单 tag 匹配，向量化作为阶段 2；需确认是否引入外部 embedding 服务（成本）。

---

## 13. 附：本设计对既有代码的具体改动清单

| 文件 | 改动 |
|---|---|
| `db.js` | 新增 8 张表；`conversations` 加 `client_id`/`scenario`/`link_kind`；`messages` 加 `structured_json`；`token_usage` 加 `scenario`/`prompt_version` |
| `server.js` | `SYSTEM_PROMPT`（230 行）迁出到 `prompts/persona.base.md`；新增路由组（§9）；`/api/chat` 改为薄路由调 `runCbt` |
| `src/constants/systemPrompt.ts` | **删除**（死代码，与线上不一致） |
| `src/engine/cbtEngine.ts` | 新建 —— HTTP 无关的引擎 |
| `src/engine/promptRegistry.ts` | 新建 —— 场景装配 + 版本追踪 |
| `src/lib/api.ts` | 新增 admin / user / internal 三组 API 封装 |
| `src/pages/admin/AdminLayout.tsx` | 导航加「客户 / 知识库」；滚动容器沿用现有 `flex-1 min-h-0 overflow-y-auto touch-auto` |
| `src/pages/admin/AdminClients*.tsx` | 新建 —— 客户档案、方案编辑器 |
| `src/pages/admin/AdminKnowledge.tsx` | 新建 |
| `src/pages/PlanPage.tsx` | 新建 —— 用户端方案页 + 证据回填 |
| `src/hooks/useChat.ts` | 支持 `scenario` / `client_id` |

---

## 14. 决策记录

| 决策 | 选择 | 时间 |
|---|---|---|
| 1v1 交付模块建在哪 | 留在 Coco Avatar（SQLite/Express），不塞进小程序 | 2026-10-24 |
| 交付模块与 8 周冲刺的关系 | 准备期做底座，冲刺期不碰 | 2026-10-24 |
| 小程序 ↔ 引擎连接方式 | 云函数 BFF + 小程序自绘 UI | 2026-10-24 |
| 急救箱 prompt 与现有 CBT 的关系 | 同一套底座 + 场景编排（Prompt Registry） | 2026-10-24 |
| 方案载体 | 结构化数据（B） | 2026-10-24 |
| 客户身份 | 管理员建客户 + 链接绑定；手机号仅作找回 | 2026-10-24 |
| 方案生成方式 | AI 出草稿 → Coco 审 → 发布 | 2026-10-24 |
| 方案内容来源 | 内置生成为主 + 外部 JSON 导入 | 2026-10-24 |
| 音频处理 | 上传音频自动转写（OpenRouter whisper-1） | 2026-10-24 |
| 导出格式 | Markdown 档案 + JSON | 2026-10-24 |
