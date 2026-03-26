# Coco AI 数字分身 Web 原型

Coco（龚韵雅）的 AI 数字分身网页，用于 WeStream 人生学校的客户转化触点。

## 技术栈

- React 18 + Vite 5 + React Router 7
- TypeScript
- TailwindCSS 3
- Express 4 (API 代理服务器)
- SQLite (better-sqlite3) — 对话持久化 + Token 追踪
- Marked (Markdown 渲染)
- AI Gateway (Claude Sonnet 4.6)

## 项目结构

```
coco-avatar/
├── src/
│   ├── components/        # React 组件（聊天 UI）
│   │   ├── Header.tsx
│   │   ├── ChatArea.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── InputArea.tsx
│   │   └── QuickActions.tsx
│   ├── pages/             # 页面
│   │   ├── ChatPage.tsx   # 聊天页（/ 和 /c/:id）
│   │   ├── ExpiredPage.tsx # 链接过期提示页
│   │   └── admin/         # 管理后台
│   │       ├── AdminLayout.tsx
│   │       ├── AdminConversations.tsx
│   │       ├── AdminConversationDetail.tsx
│   │       ├── AdminCreateLink.tsx
│   │       └── AdminStats.tsx
│   ├── hooks/
│   │   └── useChat.ts     # 聊天逻辑 Hook
│   ├── lib/
│   │   └── api.ts         # API 调用（前端 + 管理后台）
│   ├── constants/
│   │   └── systemPrompt.ts # Coco 的 System Prompt（勿动）
│   ├── App.tsx            # 路由定义
│   ├── main.tsx
│   └── index.css
├── server.js              # Express 后端（API + 管理后台 API）
├── db.js                  # SQLite 数据库初始化 + Schema
├── fly.toml               # Fly.io 部署配置
├── Dockerfile
├── package.json
└── vite.config.js
```

## 功能特性

1. **AI 对话**：基于 Claude Sonnet 4.6，使用 Coco 人格的 System Prompt
2. **流式输出**：AI 回复逐字显示，体验流畅
3. **Markdown 渲染**：支持加粗、列表等格式
4. **快捷入口**：首次访问提供 3 个话题快捷按钮
5. **CBT 6 步法**：AI 会根据用户困境引导进行认知行为疗法练习
6. **温暖设计**：大地色系 UI，治愈感的视觉风格
7. **响应式**：移动端优先，适配各种屏幕
8. **对话持久化**：SQLite 存储所有对话和消息记录
9. **独立对话链接**：管理员可生成带有效期的对话链接 `/c/:id`
10. **Token 消耗追踪**：自动解析 AI Gateway SSE 流中的 usage 字段
11. **管理后台**：密码保护的 `/admin` 后台，对话管理 + 统计面板

## 启动方式

### 1. 安装依赖

```bash
npm install
```

### 2. 构建前端

```bash
npm run build
```

### 3. 启动服务器

```bash
export AI_GATEWAY_API_KEY="your-api-key-here"
npm run start
```

或者一行命令：

```bash
AI_GATEWAY_API_KEY="your-api-key-here" npm run start
```

服务器将在 http://localhost:8080 启动。

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `AI_GATEWAY_API_KEY` | 是 | — | AI Gateway API Key |
| `PORT` | 否 | `8080` | 服务器端口 |
| `ADMIN_PASSWORD` | 否 | `admin` | 管理后台登录密码 |
| `DB_PATH` | 否 | `./data/coco.db` | SQLite 数据库文件路径 |

## 开发模式

开发时可以使用 Vite 的开发服务器：

```bash
npm run dev
```

但注意：开发模式下 API 代理不会工作，因为 API Key 在 server.js 中处理。

## 路由说明

| 路径 | 说明 |
|------|------|
| `/` | 首页，匿名对话（自动创建 conversation） |
| `/c/:id` | 指定对话链接（管理员生成，支持过期时间） |
| `/expired` | 链接过期提示页 |
| `/admin` | 管理后台（需密码登录） |
| `/admin/create-link` | 生成对话链接 |
| `/admin/stats` | Token 消耗统计面板 |

## API 端点

### 前端调用

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/conversations` | 创建新对话 |
| `GET` | `/api/conversations/:id` | 获取对话信息（含过期校验） |
| `POST` | `/api/chat` | 聊天（支持 `conversation_id` 参数，自动保存消息和 token） |

### 管理后台 API（需 `X-Admin-Token` header）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/admin/login` | 密码验证，返回 session token |
| `GET` | `/api/admin/conversations` | 对话列表（分页、按状态/时间筛选） |
| `GET` | `/api/admin/conversations/:id` | 对话详情 + 消息列表 + token 明细 |
| `POST` | `/api/admin/conversations` | 生成新对话链接（设置 title、expires_in_days） |
| `GET` | `/api/admin/stats` | Token 统计（总量、按天、按对话） |

## 数据库

SQLite，3 张表：

- **conversations** — 对话元数据（id, title, created_at, expires_at, status）
- **messages** — 消息记录（conversation_id, role, content, created_at）
- **token_usage** — Token 消耗（conversation_id, prompt_tokens, completion_tokens, total_tokens）

数据库文件默认位于 `./data/coco.db`，生产环境通过 `DB_PATH` 环境变量指向 Fly.io volume。

## 部署到 Fly.io

### 首次部署

```bash
# 1. 创建持久化 volume（SQLite 数据存储）
fly volumes create coco_data --region sjc --size 1

# 2. 设置环境变量
fly secrets set AI_GATEWAY_API_KEY="your-api-key"
fly secrets set ADMIN_PASSWORD="your-secure-password"

# 3. 部署
fly deploy
```

### 后续部署

```bash
fly deploy
```

Volume 数据在重新部署时不会丢失。

### 生产配置要点

- `fly.toml` 已配置 `[mounts]` 将 `coco_data` volume 挂载到 `/data`
- `Dockerfile` 已包含 `python3` + `build-essential`（better-sqlite3 编译所需）
- SQLite 使用 WAL 模式，适合单实例读写
- `auto_stop_machines = "stop"` — 无流量时自动停机节省成本

### 手动部署（非 Fly.io）

1. 确保服务器安装 Node.js v20+、python3、build-essential
2. `npm install --include=dev && npm run build && npm prune --production`
3. 设置环境变量（参见上表）
4. `npm run start`
5. 用 PM2 或 systemd 保持进程常驻

## Coco 的 AI 人格

AI 使用的 System Prompt 定义了 Coco 的：

- 身份背景（WeStream 创始人、人生教练、导演）
- 核心价值观（相信天赋使命、最小阻力思维、社区力量）
- 对话风格（温暖不讨好、善用提问、口语化）
- CBT 6 步法引导框架
- 转化引导策略（自然融入 WeStream 社区介绍）

详见 `src/constants/systemPrompt.ts`。

## API 端点

- `GET /`: 静态文件服务（前端页面）
- `POST /api/chat`: AI 聊天接口（SSE 流式响应）

## 注意事项

1. API Key 不要提交到代码仓库，使用环境变量管理
2. server.js 充当代理，避免在前端暴露 API Key
3. 首次加载会显示欢迎消息和 3 个快捷按钮
4. AI 回复时间取决于网络和 AI Gateway 响应速度

## 联系方式

项目开发：Kira (Warren Agent Team)
产品设计：Warren + Coco
