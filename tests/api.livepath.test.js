// `POST /api/chat` 这条**线上**路径与 `main` 的差异 —— 每一条都被钉住。
//
// 背景：本分支的 headline claim 是「对线上路径零行为变化」。这句话的
// 准确含义是「对**格式正确**的请求零行为变化」—— 但确实还有几处
// 可观察的差异（有的更安全，有的只是更严格）。它们必须：
//   1. **被测到**（否则下一个人改坏了都不知道）；
//   2. **被写下来**（见 docs/superpowers/plans/2026-10-24-coco-avatar-foundation.md
//      的「有意为之的行为变更」一节）。
//
// 这里列的是**差异**，不是「本分支该有的行为」—— 所以每条测试的名字
// 都点明「与 main 不同在哪里」。
import './helpers/testEnv.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';
import { getDb } from '../db.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server?.close());

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  globalThis.__cocoFetchImpl = undefined;
});

// --- 假模型 ---------------------------------------------------------------

function miniMaxResponse(content, usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }], usage };
    },
    async text() {
      return '';
    },
  };
}

function installFetch(content) {
  globalThis.__cocoFetchImpl = async () => miniMaxResponse(content);
}

function installFailingFetch(status = 500, body = 'gateway exploded') {
  globalThis.__cocoFetchImpl = async () => ({
    ok: false,
    status,
    async json() {
      return {};
    },
    async text() {
      return body;
    },
  });
}

async function postChat(body) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text };
}

// 把伪 SSE 的正文还原出来（前端读的是 data: 行里的 delta.content）。
function sseContent(text) {
  let out = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      out += obj?.choices?.[0]?.delta?.content ?? '';
    } catch {
      /* 非 JSON 的 data 行忽略 */
    }
  }
  return out;
}

function rows(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// 差异 1：正文无条件 stripAllStructured + trim（**即使没请求结构化输出**）
//
// main：直接把模型的原文（fullContent）吐出去，一个字都不动。
// 本分支：cbtEngine.js 里 `stripAllStructured(raw).trim()` 是**无条件**跑的
// —— 哪怕这一轮根本没请求 structured_output。
//
// 后果（有意为之）：一段普通对话里如果恰好出现了合法的
// `{"__structured__": ...}` 块，它会被**静默剥掉**；正文首尾的空白
// 也会被 trim 掉。所以 SSE 的字节与 main 不同。
//
// 为什么要这样：结构化块是**给程序看的**，不该出现在用户的聊天气泡里，
// 也不该原样存进 messages 表再回灌给模型。这条是**安全/正确性**上的
// 取舍，不是「顺手改的」。
// ---------------------------------------------------------------------------

test('差异 1：没请求结构化输出时，正文里的结构化块仍被剥掉、首尾空白被 trim（main 是原样透传）', { timeout: 15000 }, async () => {
  installFetch('  你好  {"__structured__": {"title": "卡点"}}  ');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 200);

  // 剥掉了结构化块，也 trim 掉了首尾空白。
  assert.equal(sseContent(text), '你好');
  assert.ok(!text.includes('__structured__'), '结构化块泄漏进了用户气泡');

  // 落库的正文同样是被剥过的 —— 下一轮回灌给模型的也是它。
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.equal(assistant.content, '你好');
});

// ---------------------------------------------------------------------------
// 差异 2：上游网关的 HTTP 状态被**统一折叠成 502**
//
// main：`res.status(response.status)` —— 网关回 429 就回 429、回 401 就回 401。
// 本分支：网关侧的错一律是 ModelError → statusForEngineError → 502，
// body 固定是 {error: 'AI Gateway error'}。
//
// 后果（有意为之）：客户端**看不到**上游的真实状态码了。
// 想要区分「限流」与「服务端故障」的调用方得自己看 body —— 而 body 里
// 没有这个信息（这是刻意的：不给客户端内部细节）。
// 上游的真实状态码仍然带在 ModelError.status 里，只进服务端日志。
// ---------------------------------------------------------------------------

test('差异 2：上游网关的 429 被折叠成 502（main 是原样回 429）', { timeout: 15000 }, async () => {
  installFailingFetch(429, 'rate limited');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(text), { error: 'AI Gateway error' });
});

test('差异 2：上游网关的 401 也被折叠成 502（main 是原样回 401）', { timeout: 15000 }, async () => {
  installFailingFetch(401, 'unauthorized');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(text), { error: 'AI Gateway error' });
});

// ---------------------------------------------------------------------------
// 差异 3：conversation_id 是空串 → 400
//
// main：空串是 falsy → `if (!convId) convId = generateId()` → **新建**一个会话。
// 本分支：空串是**非法请求** → 400。
//
// 后果（有意为之）：以前传空串会静默地开一段新会话（旧的会话 id 被丢掉、
// 上下文断掉），现在明确报错。调用方（前端）本来就不会传空串 ——
// 它传的是 undefined（src/lib/api.ts:39 的 `conversationId || undefined`）。
// ---------------------------------------------------------------------------

test('差异 3：conversation_id 是空串 → 400（main 会静默新建一个会话）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      conversation_id: '',
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '不该新建会话');
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

// ---------------------------------------------------------------------------
// 差异 4：client_id / conversation_id 的**类型**校验 → 400
//
// main：这两个字段被直接丢给 better-sqlite3 与 SQL。传一个对象
// （{evil: true}）会抛 RangeError，而那发生在 async handler 里 →
// Express 4 不接这个异常 → unhandled rejection → **整个进程退出**
// （fly 上是单进程，等于整站不可用）。
//
// 本分支：类型不对一律 400，不崩进程、不建会话、不调模型。
// 后果（有意为之）：这是**破坏性的行为变化** —— 以前会崩，现在会 400。
// 但以前崩的方式（整个站点挂掉）远比 400 糟糕。
// client_id 是**客户端自报的标签**，非字符串就报错；它不进响应头，
// 所以**不做字符集限制**（可以是非 ASCII / 邮箱 / 人写的标签）。
// ---------------------------------------------------------------------------

test('差异 4：client_id 不是字符串 → 400（main 会抛 RangeError 并带崩整个进程）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      client_id: { evil: true },
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0);
    assert.equal(rows('SELECT * FROM messages').length, 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('差异 4：conversation_id 不是字符串 → 400（main 会抛 RangeError 并带崩整个进程）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      conversation_id: { evil: true },
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0);
    assert.equal(rows('SELECT * FROM messages').length, 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

// ---------------------------------------------------------------------------
// 差异 5（**正面的**）：main 上有两个请求形状会**杀掉整个进程**
//
// main 的 `/api/chat`：
//   - {"messages":[{"role":"user"}]} —— content 是 undefined，被当成 NULL 写进
//     NOT NULL 列 → SqliteError 抛在 try **之外** → unhandled rejection → 进程退出；
//   - {"messages":[null]} —— `m.filter(m => m.role === 'user')` → TypeError → 同样退出。
//
// fly.io 跑的是**单进程**，所以这两个输入等于「整站下线」。本分支两个都修好了
// （server.js 的用户消息提取处对 content 做了类型/空值检查，null 元素被跳过）。
//
// 这条是本分支最重要的**正面**差异 —— 「零行为变化」这句话必须读成
// 「对格式正确的请求零行为变化」。
// ---------------------------------------------------------------------------

test('差异 5：{"messages":[{"role":"user"}]}（content 缺失）→ 200，进程不崩（main 上会整站下线）', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user' }],
  });
  assert.equal(res.status, 200);
  // content 不是非空字符串的消息**不进库**（模型压根没看见它）。
  assert.equal(rows("SELECT * FROM messages WHERE role = 'user'").length, 0);
  assert.equal(rows("SELECT * FROM messages WHERE role = 'assistant'").length, 1);
});

test('差异 5：{"messages":[null]} → 200，进程不崩（main 上会整站下线）', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [null],
  });
  assert.equal(res.status, 200);
  assert.equal(rows("SELECT * FROM messages WHERE role = 'user'").length, 0);
  assert.equal(rows("SELECT * FROM messages WHERE role = 'assistant'").length, 1);
});
