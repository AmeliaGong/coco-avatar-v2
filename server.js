import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { createPromptRegistry, SCENARIO_IDS } from './server/promptRegistry.js';
import { createModelClient } from './server/engine/modelClient.js';
import { createCbtEngine } from './server/engine/cbtEngine.js';
import {
  STRUCTURED_OUTPUT_TYPE_NAMES,
  STRUCTURED_SCHEMAS,
  STRUCTURED_VALIDATORS,
  structuredJsonToPersist,
} from './server/structuredTypes.js';
import { statusForEngineError, errorBodyForStatus } from './server/errorStatus.js';
import { asyncRoute } from './server/asyncRoute.js';
import { createRequireAdmin, createRequireInternal } from './server/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'https://api.minimax.chat/v1/text/chatcompletion_v2';

// 判定本文件是否作为进程入口运行。
// 两边都取 realpath 再比较：import.meta.url 默认是模块的真实路径，
// 而 process.argv[1] 是「敲进来的那个路径」（可能是软链）；在
// --preserve-symlinks-main 下则正好相反。只比较 realpath 两种情况都对，
// 只比原始路径会在软链启动时静默地不监听、也不报错。
const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
})();

// 缺少 API key 时直接退出。放在 getDb() 之前，与改造前的顺序完全一致：
// 缺 key 时不建库、不改 schema。
if (!MINIMAX_API_KEY) {
  console.error('Error: MINIMAX_API_KEY environment variable is not set');
  process.exit(1);
}

// Initialize database
const db = getDb();

// 鉴权中间件。db 必须**注入进去**（server/auth.js 不 import db.js）。
// getDb() 是懒初始化的单例，上面已经调用过，所以这里 db 已就绪。
//
// 注意：**不传 adminPassword**。密码校验在 POST /api/admin/login 里，
// 中间件只管会话 token 的有效性 —— 传一个没人用的值会让人以为密码是
// 这条鉴权链的一部分。工厂函数的签名仍接受它（将来可能用）。
const requireAdmin = createRequireAdmin({ db });
// 服务间鉴权。serviceToken 在**构造时**从环境变量读一次 —— 所以
// INTERNAL_SERVICE_TOKEN 必须在模块加载前就设好（server/auth.js 里有说明）。
const requireInternal = createRequireInternal();

// Prompt Registry：文件是兜底真相源，数据库里的激活版本优先。
// 这样真人教练可以随时调整话术而不需要重新部署。
const promptRegistry = createPromptRegistry({ db });

// 模型客户端。
//
// fetchImpl 是**测试缝**：globalThis.__cocoFetchImpl 存在时走它，否则走
// 全局 fetch。生产环境不存在这个全局变量 —— 生产代码不依赖它存在，
// 它只在测试里被装上（装完必须卸掉）。
const modelClient = createModelClient({
  apiKey: MINIMAX_API_KEY,
  baseUrl: MINIMAX_API_URL,
  fetchImpl: (url, init) =>
    typeof globalThis.__cocoFetchImpl === 'function'
      ? globalThis.__cocoFetchImpl(url, init)
      : fetch(url, init),
});

// CBT 交付引擎：拼 prompt → 调模型 → 拆结构化块，都收在引擎里。
// 路由只负责「取数据 → 调引擎 → 写数据 → 吐 SSE」。
//
// 注意：createCbtEngine 返回的**就是 runCbt 本体**（不是一个带方法的对象），
// 所以下面直接 `await cbtEngine({...})` 调用。
const cbtEngine = createCbtEngine({
  getPrompt: promptRegistry.getPrompt,
  getPromptMeta: promptRegistry.getPromptMeta,
  callModel: modelClient,
  // 形状给模型看，语义（哪个必填、枚举、worth_practicing 的 false
  // 是什么意思）必须一起给 —— 只给形状的话模型不知道 worth_practicing
  // 还有个有意义的 false 状态，会一律输出 true。
  //
  // schemas 与 validators 都从 server/structuredTypes.js 的同一张表派生，
  // 白名单也是 —— 三者不会漂。
  schemas: STRUCTURED_SCHEMAS,
});

// Clean up expired admin sessions on startup
db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(new Date().toISOString());

app.use(cors());
app.use(express.json());

// --- Helper functions ---

function generateId() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

// --- Conversation API (frontend) ---

// Create a new conversation
app.post('/api/conversations', (req, res) => {
  const id = generateId();
  const createdAt = now();
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, ?)'
  ).run(id, null, createdAt, 'active');
  res.json({ id, created_at: createdAt, status: 'active' });
});

// Get conversation info (with expiry check)
//
// 注意：这条路由**没有任何鉴权** —— 拿到 id 就能读走整个会话的全部消息。
// 它比 /api/chat 更容易滥用（不花钱、不限速、还把历史全吐出来），
// 而且早于本轮改造就存在。
//
// 什么时候必须收口：见 /api/chat 上方「client_id 与『会话归属』」那段
// 注释（clients 表成立 / 对外开放 / 会话里出现可识别个人的信息）——
// 届时**读写两条路径要一起**做归属校验。
app.get('/api/conversations/:id', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (isExpired(conv.expires_at)) {
    // Update status if not already expired
    if (conv.status !== 'expired') {
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('expired', conv.id);
    }
    return res.status(410).json({ error: 'Conversation expired', expired: true });
  }
  // Load messages for this conversation
  const messages = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(req.params.id);
  res.json({ ...conv, messages });
});

// --- /api/chat 的薄路由 ---
//
// 路由只做四件事：取数据 → 调引擎 → 写数据 → 吐 SSE。
// 「拼 prompt / 调模型 / 拆结构化块」的语义全在 server/engine/cbtEngine.js 里；
// 「这张卡点合不合法」的语义全在 server/contracts/ 里。
//
// 两条硬约束：
//   1. **校验在落库之前**。scenario / structured_output 非法时直接 400，
//      不留一条没人回复的 user 消息在库里。
//   2. **落库在吐流之前**。响应已经发出去、进程随后崩溃 → 消息和 token
//      账永久丢失，而用户已经看到回复了。反过来（先落库再写流），
//      任何时刻 messages 表与 token_usage 表都和用户看到的内容一致。

// 请求体里 structured_output 的取值域：STRUCTURED_OUTPUT_TYPE_NAMES
// （来自 server/structuredTypes.js 的单一来源表，与引擎 schemas 的键一一对应）。
//
// 引擎错误码 → HTTP 状态码的映射在 server/errorStatus.js（独立模块，可单测）。

// 从结构化内容里取一个能当标题的字段，给「模型只给了结构化块、没有正文」
// 的那种轮次拼一句兜底正文。
function structuredTitle(type, structured) {
  if (!structured || typeof structured !== 'object') return null;
  if (type === 'plan') {
    const t =
      structured.vision && typeof structured.vision.title === 'string'
        ? structured.vision.title.trim()
        : '';
    return t || null;
  }
  const t = typeof structured.title === 'string' ? structured.title.trim() : '';
  return t || null;
}

// 兜底正文。取不到标题就用一句固定文案 —— 宁可短，不可假。
//
// requested：本轮**是否请求了**结构化输出。两种情况的文案必须分开 ——
// 本轮根本没要结构化输出时说「只交付了结构化内容」会让人一头雾水
// （引擎那边也是分开的两句，见 cbtEngine.js 里 empty_reply 的文案）。
function fallbackReplyText(type, structured, validated, requested) {
  if (!requested) {
    return '这一轮没有请求结构化输出，正文是空的。';
  }
  // 没通过契约校验的那份（多半是模型复述格式时抄的占位骨架）不能拿来
  // 当正文 —— 那等于把占位符展示给用户。
  const title = validated === false ? null : structuredTitle(type, structured);
  if (title) return `这一轮我先交付了结构化内容：${title}`;
  return '这一轮我只交付了结构化内容，正文是空的。';
}

// 落库：助手消息（带结构化输出）+ token 账。
function persistTurn({ convId, scenario, turn }) {
  // 没通过契约校验的结构化输出**绝不落库** —— 那多半是模型复述格式时
  // 抄的占位骨架，存进库就是一条假卡点。
  //
  // 「压根没校验过」（structuredValidated === null）与「校验没过」（false）
  // 同等对待：只有 true 才落。判据在 server/structuredTypes.js 的
  // structuredJsonToPersist 里（将来直接调引擎的 BFF 也用同一份）。
  const structuredJson = structuredJsonToPersist(turn.structured, turn.structuredValidated);

  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at, structured_json) VALUES (?, ?, ?, ?, ?)'
  ).run(convId, 'assistant', turn.text, now(), structuredJson);

  // token 账：**任何情况下都要记**。这一轮已经付过钱了，
  // 「没拿到正文」不是不记账的理由。
  if (turn.usage) {
    const promptTokens = turn.usage.prompt_tokens || 0;
    const completionTokens = turn.usage.completion_tokens || 0;
    db.prepare(
      'INSERT INTO token_usage (conversation_id, prompt_tokens, completion_tokens, total_tokens, created_at, scenario, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      convId,
      promptTokens,
      completionTokens,
      turn.usage.total_tokens || promptTokens + completionTokens,
      now(),
      scenario,
      turn.promptVersion || null
    );
  }
}

// 伪 SSE：前端按 `data: ` 行读，结尾是 `data: [DONE]`。
function streamReply(res, convId, text) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Conversation-Id', convId);
  const chunkSize = 50;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// 引擎的错误 → HTTP 状态码。
function respondWithEngineError(res, error) {
  console.error('Error in chat endpoint:', error);
  const status = statusForEngineError(error);
  return res.status(status).json(errorBodyForStatus(status, error));
}

// client_id 的长度上限。client_id 是**客户端自报**的标签，不是凭证
// （见下面的「会话归属」说明），但它会原样进库、还会进后台列表 ——
// 不设上限的话，一个几百 KB 的字符串就能塞进一行。
const MAX_CLIENT_ID_LENGTH = 128;

// conversation_id 的长度上限。
//
// 我们的会话 id 是 crypto.randomUUID()（36 个字符），128 绰绰有余。
//
// 不设上限的后果比 client_id 严重得多：
//   - 它会**直接当 conversations.id 主键**写进去（新会话那条路），
//     每条 messages.conversation_id 还要再存一份；
//   - 它还会原样进 `X-Conversation-Id` 响应头 —— 几万个字符会把响应头
//     撑爆（Node 默认 16KB 上限），客户端拿到的是「连接被掐」
//     （UND_ERR_HEADERS_OVERFLOW），**不是** 500；
//   - 而那时库里已经落了行、模型的钱也已经付过了。
//
// 所以上限必须在**任何写库 / 调模型之前**生效。
const MAX_CONVERSATION_ID_LENGTH = 128;

// --- client_id 与「会话归属」---
//
// client_id 是**客户端自报**的标识，**不是凭证**：
//   - 现在的实现只是把它原样记进 conversations.client_id（一个可检索的
//     标签），**不**用它做任何鉴权、也不代表任何人的身份。
//   - 谁传什么就存什么 —— 传 'a' 的人可以冒充传 'b' 的人。这是**已知且
//     有意为之**的现状：还没有 clients 表，服务端没有任何东西能把一个
//     client_id 验成「某个真人」。
//   - 等真的有了 clients 表（或者任何绑定到真人/客户的会话），client_id
//     就要从「自报标签」升级成「服务端认的标识」，那时候才谈得上归属校验。
//
// 什么时候**必须**开始做会话归属校验（读和写都要）：
//   1. 有了 clients 表 / 任何绑定到客户的会话；
//   2. 服务从「内部/教练自用」变成「对外开放给外部用户」；
//   3. 会话里开始出现可识别个人的信息（真名、联系方式、病史），
//      或者开始区分付费/等级。
//
// 为什么现在**不做**：现在做不了 —— 没有可信的身份来源，硬做只是把
// 「拿不到 id 就能看别人的会话」换成「拿不到 id 也能冒充别人的
// client_id」，看着像有鉴权，其实没有。真正要落地时，读路径和写路径
// 必须**一起**收口：
//   - 写路径：POST /api/chat —— 带上 conversation_id 时必须校验这个
//     会话属于当前 client_id，否则谁都能往别人的会话里插消息。
//   - 读路径：GET /api/conversations/:id —— **这条现在完全没有鉴权**，
//     拿到 id 就能读走整个会话的全部消息。它比 /api/chat 更容易滥用
//     （不花钱、不限速、还把历史全吐出来），而且它早于本次改造就存在。
//     对外之前必须一起收。
app.post('/api/chat', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const {
    messages: rawMessages,
    conversation_id,
    scenario = 'chat',
    client_id = null,
    structured_output = null,
  } = body;

  // --- 校验（全部在落库之前） ---
  // messages 必须是数组。
  //
  // 「不传」与「传 null」同样不是数组 —— 一样 400。放它们过去的话，
  // 请求会继续建会话、调模型（**模型调用是花钱的**）、写 assistant 消息，
  // 最后回 200；请求方却压根没说要聊什么。
  //
  // 空数组 [] 是合法的 —— 它确实是数组，也是改动前的行为。
  //
  // 让 messages.filter 去撞 TypeError 只会变成一个没人看得懂的 500
  // （而且 Express 4 不接 async handler 的异常 → 请求直接挂死）。
  if (!Array.isArray(rawMessages)) {
    return res.status(400).json({ error: 'messages 必须是数组' });
  }
  const messages = rawMessages;

  if (!SCENARIO_IDS.includes(scenario)) {
    return res.status(400).json({ error: `Unknown scenario: ${scenario}` });
  }

  let structuredType = null;
  if (structured_output !== undefined && structured_output !== null) {
    if (
      typeof structured_output !== 'string' ||
      !STRUCTURED_OUTPUT_TYPE_NAMES.includes(structured_output)
    ) {
      return res.status(400).json({ error: `Unknown structured_output: ${structured_output}` });
    }
    structuredType = structured_output;
  }

  // client_id：只接受字符串（null / 不传 = 没有客户端标识）。
  //
  // 之前它是被直接丢给 better-sqlite3 的 —— 传一个对象
  // （{evil: true}）会抛 RangeError（bind 参数不支持对象/数组），而这
  // 发生在 async handler 里 → 进程直接退出、请求挂死。
  //
  // 非字符串**不**静默当成 null：调用方以为自己传了标识（于是以为会话
  // 是「自己的」），服务端却记成「无标识」—— 这种不一致比报错更难查。
  if (client_id !== null && client_id !== undefined) {
    if (typeof client_id !== 'string') {
      return res.status(400).json({ error: 'client_id 必须是字符串' });
    }
    if (client_id.length > MAX_CLIENT_ID_LENGTH) {
      return res
        .status(400)
        .json({ error: `client_id 超过 ${MAX_CLIENT_ID_LENGTH} 字符上限` });
    }
  }

  // conversation_id：同理，只接受非空字符串、且有长度上限。
  //
  // 之前同样是可以直接传对象进来的崩溃点。空串也没意义（查不到会话，
  // 最后会新建一个）—— 当成非法请求说清楚，比默默新建一个会话好。
  //
  // 长度上限的理由见 MAX_CONVERSATION_ID_LENGTH 的注释：它会直接当主键
  // 写进库，还会进响应头 —— 太长会把响应头撑爆，客户端连 500 都收不到。
  if (conversation_id !== null && conversation_id !== undefined) {
    if (typeof conversation_id !== 'string' || conversation_id.trim() === '') {
      return res.status(400).json({ error: 'conversation_id 必须是非空字符串' });
    }
    if (conversation_id.length > MAX_CONVERSATION_ID_LENGTH) {
      return res
        .status(400)
        .json({ error: `conversation_id 超过 ${MAX_CONVERSATION_ID_LENGTH} 字符上限` });
    }
  }

  // --- 会话 ---
  let convId = conversation_id || null;
  const existing = convId
    ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId)
    : null;
  if (existing && isExpired(existing.expires_at)) {
    if (existing.status !== 'expired') {
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('expired', existing.id);
    }
    return res.status(410).json({ error: 'Conversation expired', expired: true });
  }
  if (!existing) {
    // 会话不存在就建一个。
    //
    // 注意这里**没有**（也不需要）临时关掉外键检查：会话行先插、消息行
    // 后插，顺序上本来就满足外键。之前那对
    // `db.pragma('foreign_keys = OFF/ON')` 只是把外键检查在中间这段时间
    // 关掉（而 SQLite 的 PRAGMA foreign_keys 在事务里是空操作），没有
    // 任何好处，却让「外键到底开没开」变得不可知。
    convId = convId || generateId();
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, status, scenario, client_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, null, now(), 'active', scenario, client_id ?? null);
  }

  // --- 用户消息 ---
  const userMsg = messages.filter(m => m && m.role === 'user').pop();
  // content 不是非空字符串的消息不进库 —— 引擎本来也会把它从上下文里
  // 剔掉，存进去只会留下一条模型压根没看见的消息。
  const userContent =
    userMsg && typeof userMsg.content === 'string' && userMsg.content.trim() !== ''
      ? userMsg.content
      : null;
  if (userContent !== null) {
    db.prepare(
      'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(convId, 'user', userContent, now());
  }

  // --- 调引擎 ---
  let turn;
  try {
    const result = await cbtEngine({
      scenario,
      history: messages,
      structuredOutput: structuredType,
      // 契约层的校验函数：签名正好是 (payload) => ({ok, errors, value})。
      // 模型复述格式时抄的占位串会被 parseStuckPoint 拒掉 —— 这正是
      // 「落库的是真卡点、不是占位骨架」的实现方式。
      //
      // 与 schemas、白名单同出一张表（server/structuredTypes.js）。
      validators: STRUCTURED_VALIDATORS,
    });
    turn = {
      text: result.reply,
      structured: result.structured,
      structuredValidated: result.structuredValidated,
      usage: result.usage,
      promptVersion: result.promptVersion,
    };
  } catch (error) {
    // empty_reply 不是失败：模型只交付了结构化块（那正是契约 1/契约 2 的
    // 目标产出），正文为空。这一轮的卡点与 token 消耗都还在 —— 落库、
    // 记账，然后回 200 + 一句兜底正文。
    if (error && error.code === 'empty_reply') {
      turn = {
        text: fallbackReplyText(
          structuredType,
          error.structured,
          error.structuredValidated,
          structuredType !== null
        ),
        structured: error.structured,
        structuredValidated: error.structuredValidated,
        usage: error.usage,
        promptVersion: error.promptVersion,
      };
    } else {
      return respondWithEngineError(res, error);
    }
  }

  // --- 落库（先落库，再吐流） ---
  //
  // 助手消息、token 账、会话标题**必须一起成功或一起失败**：
  // 少了标题只是一次「标题没自动生成」，少了助手消息或 token 账却是
  // 「用户看到了回复，库里却没有这一轮」—— 账丢了就再也补不回来。
  const persistAll = db.transaction(() => {
    persistTurn({ convId, scenario, turn });

    // Auto-set title from first user message if not set
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId);
    if (conv && !conv.title && userContent) {
      const title =
        userContent.substring(0, 50) + (userContent.length > 50 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
    }
  });

  try {
    persistAll();
  } catch (err) {
    // 落库失败就**不要**把回复发出去 —— 发出去的内容用户看到了，
    // 库里却没有，账也丢了。（事务已回滚：不会出现「有消息没记账」。）
    console.error('Error persisting chat turn:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  streamReply(res, convId, turn.text);
}));

// --- Admin API ---

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  // Clean up expired sessions opportunistically
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(createdAt);
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(token, createdAt, expiresAt);
  res.json({ token });
});

// --- Internal API (service-to-service) ---
//
// 内部服务鉴权自检端点。计划 2 会在这里挂真正的业务接口。
//
// 必须挂在 express.static 之前（否则 dist 里有同名文件时会被静态中间件截走）。
//
// 服务端没配 INTERNAL_SERVICE_TOKEN 时这里返回 **503** +
// { error: 'INTERNAL_SERVICE_TOKEN not configured' }。这是**配置信号**，
// 不是攻击信号：它只说明「服务在跑但没配内部密钥」，
// 排查时应该去查环境变量，而不是去查 token。泄露的只是配置状态，不是秘密。
app.get('/api/internal/ping', requireInternal, (req, res) => {
  res.json({ ok: true });
});

// Admin: list conversations
app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const { page = 1, limit = 20, status, from, to } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE 1=1';
  const params = [];

  if (status) {
    where += ' AND c.status = ?';
    params.push(status);
  }
  if (from) {
    where += ' AND c.created_at >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND c.created_at <= ?';
    params.push(to);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as count FROM conversations c ${where}`
  ).get(...params).count;

  const conversations = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
      (SELECT SUM(total_tokens) FROM token_usage WHERE conversation_id = c.id) as total_tokens
    FROM conversations c
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  // Check and update expired conversations
  for (const conv of conversations) {
    if (conv.status === 'active' && isExpired(conv.expires_at)) {
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('expired', conv.id);
      conv.status = 'expired';
    }
  }

  res.json({ conversations, total, page: parseInt(page), limit: parseInt(limit) });
});

// Admin: conversation detail
app.get('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(req.params.id);

  const tokenUsage = db.prepare(
    'SELECT * FROM token_usage WHERE conversation_id = ? ORDER BY id ASC'
  ).all(req.params.id);

  res.json({ ...conv, messages, token_usage: tokenUsage });
});

// Admin: create conversation link (with optional expiry)
app.post('/api/admin/conversations', requireAdmin, (req, res) => {
  const { title, expires_in_days } = req.body;
  const id = generateId();
  const createdAt = now();
  let expiresAt = null;

  if (expires_in_days && expires_in_days > 0) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + parseInt(expires_in_days));
    expiresAt = d.toISOString();
  }

  db.prepare(
    'INSERT INTO conversations (id, title, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title || null, createdAt, expiresAt, 'active');

  res.json({ id, title, created_at: createdAt, expires_at: expiresAt, status: 'active' });
});

// Admin: update an existing conversation link (title / expiry)
app.patch('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const { title, expires_at, expires_in_days, never } = req.body || {};
  const updates = [];
  const params = [];

  if (typeof title === 'string') {
    updates.push('title = ?');
    params.push(title.trim() || null);
  }

  let newExpiresAt = conv.expires_at;
  if (never === true) {
    newExpiresAt = null;
  } else if (typeof expires_at === 'string' && expires_at) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'Invalid expires_at' });
    }
    newExpiresAt = d.toISOString();
  } else if (expires_in_days !== undefined && expires_in_days !== null) {
    const days = parseInt(expires_in_days, 10);
    if (isNaN(days) || days < 0) {
      return res.status(400).json({ error: 'Invalid expires_in_days' });
    }
    if (days === 0) {
      newExpiresAt = null;
    } else {
      // N days counted from the link's creation time
      const d = new Date(conv.created_at);
      d.setUTCDate(d.getUTCDate() + days);
      newExpiresAt = d.toISOString();
    }
  }

  if (newExpiresAt !== conv.expires_at) {
    updates.push('expires_at = ?');
    params.push(newExpiresAt);
  }

  // status follows the expiry: a revived link goes back to active
  updates.push('status = ?');
  params.push(isExpired(newExpiresAt) ? 'expired' : 'active');

  if (updates.length) {
    params.push(conv.id);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  res.json(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id));
});

// Admin: token stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const { from, to } = req.query;

  let where = 'WHERE 1=1';
  const params = [];
  if (from) { where += ' AND created_at >= ?'; params.push(from); }
  if (to) { where += ' AND created_at <= ?'; params.push(to); }

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COUNT(*) as total_requests
    FROM token_usage ${where}
  `).get(...params);

  const daily = db.prepare(`
    SELECT
      date(created_at) as date,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(total_tokens) as total_tokens,
      COUNT(*) as requests
    FROM token_usage ${where}
    GROUP BY date(created_at)
    ORDER BY date DESC
    LIMIT 30
  `).all(...params);

  const conversationCount = db.prepare(
    'SELECT COUNT(*) as count FROM conversations'
  ).get().count;

  res.json({ totals, daily, conversation_count: conversationCount });
});

// --- Stories API ---
app.get('/api/stories', (req, res) => {
  const stories = db.prepare(`
    SELECT id, name, city, country, lat, lng, title, summary, is_coco as isCoco, avatar, created_at as createdAt
    FROM stories ORDER BY is_coco DESC, created_at DESC
  `).all();
  res.json({ stories });
});

app.get('/api/stories/:id', (req, res) => {
  const story = db.prepare(`
    SELECT id, name, city, country, lat, lng, title, summary, content, is_coco as isCoco, avatar, created_at as createdAt
    FROM stories WHERE id = ?
  `).get(req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  res.json(story);
});

app.post('/api/stories', (req, res) => {
  const { id, name, city, country, lat, lng, title, summary, content, isCoco, avatar } = req.body;
  if (!id || !name || !city || !country || !title || !summary || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO stories (id, name, city, country, lat, lng, title, summary, content, is_coco, avatar, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, city, country, lat || 0, lng || 0, title, summary, content, isCoco ? 1 : 0, avatar || null, now);
  res.json({ success: true });
});

app.put('/api/stories/:id', (req, res) => {
  const { name, city, country, lat, lng, title, summary, content, avatar } = req.body;
  const existing = db.prepare('SELECT id FROM stories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Story not found' });
  db.prepare(`
    UPDATE stories SET name=?, city=?, country=?, lat=?, lng=?, title=?, summary=?, content=?, avatar=?
    WHERE id=?
  `).run(name, city, country, lat||0, lng||0, title, summary, content, avatar||null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/stories/:id', (req, res) => {
  db.prepare('DELETE FROM stories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- Express 的错误处理中间件 ---
//
// 必须放在**所有路由之后**：Express 只把错误交给它后面的错误中间件。
//
// 为什么需要它：express.json() 解析请求体失败时（body 不是合法 JSON、
// 或者 body 超过 100KB）会抛错，交给 Express 的默认错误处理器 —— 而默认
// 处理器在非 production 环境下会把**堆栈**回给客户端。那是内部细节
// （路径、依赖版本、源码片段），和「500 不泄露内部细节」的目标不一致。
//
// 一律不给堆栈（生产也不给）：排障看服务端日志。
//
// 注意 headersSent：响应已经开始写了就不能再设状态码/写 body，否则会抛
// "Cannot set headers after they are sent"，把一次错误变成二次崩溃。
app.use((err, req, res, next) => {
  console.error('Unhandled error in request pipeline:', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  // body-parser 的两类错误：请求体不是合法 JSON（entity.parse.failed）、
  // 请求体太大（entity.too.large）。都是**请求本身**的问题 → 400。
  const isBodyError =
    err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large');
  if (isBodyError) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

// 只有当本文件是进程入口时才启动监听器。
// 这样测试可以 import app 而不会占用端口。
// （判定逻辑见文件上部的 isEntryPoint）
if (isEntryPoint) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
