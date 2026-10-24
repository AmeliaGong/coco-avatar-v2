import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { createPromptRegistry, SCENARIO_IDS } from './server/promptRegistry.js';
import { createModelClient, ModelError } from './server/engine/modelClient.js';
import { createCbtEngine } from './server/engine/cbtEngine.js';
import { STUCK_POINT_SCHEMA, STUCK_POINT_FIELD_NOTES, parseStuckPoint } from './server/contracts/stuckPoint.js';
import { PLAN_SCHEMA, PLAN_FIELD_NOTES, parsePlanPayload } from './server/contracts/plan.js';

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
  schemas: {
    stuck_point: { schema: STUCK_POINT_SCHEMA, notes: STUCK_POINT_FIELD_NOTES },
    plan: { schema: PLAN_SCHEMA, notes: PLAN_FIELD_NOTES },
  },
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

function requireAdmin(req, res, next) {
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

// 请求体里 structured_output 的取值域。与引擎 schemas 的键一一对应。
const STRUCTURED_OUTPUT_TYPES = ['stuck_point', 'plan'];

// 引擎错误码 → HTTP 状态码。
//   400 客户端错（请求本身不对）    500 我们的配置错    502 模型侧错
const ENGINE_ERROR_STATUS = {
  invalid_structured_output: 400,
  unknown_structured_output: 400,
  invalid_history: 400,
  invalid_config: 500,
  invalid_schema: 500,
  empty_content: 502,
  invalid_content_type: 502,
  empty_reply: 502,
};

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
function fallbackReplyText(type, structured, validated) {
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
  const structuredJson =
    turn.structuredValidated === false ||
    turn.structured === null ||
    turn.structured === undefined
      ? null
      : JSON.stringify(turn.structured);

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
  // 网关错（ModelError）→ 502：不是我们的问题，也别报成 500。
  if (error instanceof ModelError || (error && error.name === 'ModelError')) {
    return res.status(502).json({ error: 'AI Gateway error' });
  }
  const code = error && typeof error.code === 'string' ? error.code : null;
  const status = (code && ENGINE_ERROR_STATUS[code]) || 500;
  if (status === 400) {
    // 客户端错：把原因说清楚（这是请求本身的问题，不是服务器炸了）。
    return res.status(400).json({ error: error.message || 'Bad request' });
  }
  return res
    .status(status)
    .json({ error: status === 502 ? 'AI Gateway error' : 'Internal server error' });
}

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const {
    messages: rawMessages,
    conversation_id,
    scenario = 'chat',
    client_id = null,
    structured_output = null,
  } = body;

  // --- 校验（全部在落库之前） ---
  // messages 不是数组时直接 400 —— 让 messages.filter 去撞 TypeError
  // 只会变成一个没人看得懂的 500。
  if (rawMessages !== undefined && rawMessages !== null && !Array.isArray(rawMessages)) {
    return res.status(400).json({ error: 'messages 必须是数组' });
  }
  const messages = Array.isArray(rawMessages) ? rawMessages : [];

  if (!SCENARIO_IDS.includes(scenario)) {
    return res.status(400).json({ error: `Unknown scenario: ${scenario}` });
  }

  let structuredType = null;
  if (structured_output !== undefined && structured_output !== null) {
    if (
      typeof structured_output !== 'string' ||
      !STRUCTURED_OUTPUT_TYPES.includes(structured_output)
    ) {
      return res.status(400).json({ error: `Unknown structured_output: ${structured_output}` });
    }
    structuredType = structured_output;
  }

  // --- 会话 ---
  let convId = conversation_id;
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
    // 会话不存在就建一个（外键检查临时关掉，插完立刻打开）。
    convId = convId || generateId();
    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, status, scenario, client_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, null, now(), 'active', scenario, client_id);
    db.pragma('foreign_keys = ON');
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
      validators: {
        stuck_point: parseStuckPoint,
        plan: parsePlanPayload,
      },
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
        text: fallbackReplyText(structuredType, error.structured, error.structuredValidated),
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
  try {
    persistTurn({ convId, scenario, turn });

    // Auto-set title from first user message if not set
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId);
    if (conv && !conv.title && userContent) {
      const title =
        userContent.substring(0, 50) + (userContent.length > 50 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
    }
  } catch (err) {
    // 落库失败就**不要**把回复发出去 —— 发出去的内容用户看到了，
    // 库里却没有，账也丢了。
    console.error('Error persisting chat turn:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  streamReply(res, convId, turn.text);
});

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

// 只有当本文件是进程入口时才启动监听器。
// 这样测试可以 import app 而不会占用端口。
// （判定逻辑见文件上部的 isEntryPoint）
if (isEntryPoint) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
