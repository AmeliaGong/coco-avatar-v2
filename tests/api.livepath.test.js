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
import { createGatewayRuleFetch } from './helpers/gatewayRule.js';
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
// —— 现在回的是 **400**（这个请求没有一条有内容的消息可发），不建会话、
// 不调模型，进程当然也不崩。
//
// ⚠️ 这里以前钉的是 200（"content 不是非空字符串的消息不进库 → 200"）。
// 那是**虚构**：生产上这两种请求会被发到网关，而网关拒绝「没有非 system
// 消息」的请求（2013 chat content is empty）⇒ 回 502。也就是说，
// 「200 + 一条助手消息」只在**假 fetch** 里发生过（假 fetch 对任何请求都
// 回 200）。400 才是真的：请求没内容，说清楚，别假装回了一轮对话。
//
// 这条是本分支最重要的**正面**差异 —— 「零行为变化」这句话必须读成
// 「对格式正确的请求零行为变化」。
// ---------------------------------------------------------------------------

test('修好的 1：{"messages":[{"role":"user"}]}（content 缺失）→ 400，进程不崩（main 上会整站下线）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [{ role: 'user' }],
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求没内容却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '不留孤儿会话');
    assert.equal(rows('SELECT * FROM messages').length, 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('修好的 2：{"messages":[null]} → 400，进程不崩（main 上会整站下线）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [null],
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求没内容却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '不留孤儿会话');
    assert.equal(rows('SELECT * FROM messages').length, 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

// ---------------------------------------------------------------------------
// 差异 8：没有「可发消息」的请求 → **本地 400**（不建会话、不调模型）
//
// 网关（MiniMax）的底线是「至少带一条**非 system 的非空**消息」：只有
// system 的请求会被拒（2013 invalid params, chat content is empty）——
// 这一点线上验过；只有 assistant 的请求网关是**接受**的。
//
// main：这种请求**照发到网关**，由网关来拒 —— 网关回什么形状，客户端就
// 收到什么形状：
//   - 网关回非 2xx → main 原样回 `res.status(response.status)` + 'AI Gateway error'；
//   - 网关以 HTTP 200 + base_resp{status_code:2013} 回（老接口的形状）→
//     main 的 `data.choices?.[0]?.message?.content || ''` 拿到空串 → 客户端
//     收到一个**空气泡**（200，正文为空）。
// 两种都不是「明确拒绝这个请求」。而且 main 这时**已经建了会话**（留下一个
// 没人说话的会话行）。
//
// 本分支：在本地就说清楚「这个请求没有内容」，**不建会话、不调模型**。
//
// 这条差异的价值不在于"更好看"，而在于**可归因**：502「AI Gateway error」
// 会让调用方以为要重试或换模型，而真相是「你压根没说要聊什么」。
// ---------------------------------------------------------------------------

test('差异 8：没有可发消息的请求 → 400，且不建会话、不调模型（main 是发给网关去撞）', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch();
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    for (const bad of [
      [], // 空数组
      [{ role: 'system', content: '客户端塞的 system' }], // 只有 system
      [{ role: 'user', content: '' }], // 空内容
    ]) {
      const { res } = await postChat({ messages: bad });
      assert.equal(res.status, 400, `messages=${JSON.stringify(bad)} 应该 400`);
    }
    // 关键：这种请求**根本没发出去**（不是「发出去被网关拒」）。
    assert.equal(calls.length, 0, '请求发到网关了');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '不留孤儿会话');
    assert.equal(rows('SELECT * FROM messages').length, 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('差异 8：正常请求照发到网关（守卫没有把正常路径也堵掉）', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch();
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    const { res } = await postChat({ messages: [{ role: 'user', content: '你好' }] });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, '正常请求必须照发');
    assert.deepEqual(calls[0].messages[1], { role: 'user', content: '你好' });
    assert.equal(rows("SELECT * FROM messages WHERE role = 'assistant'").length, 1);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});
// ---------------------------------------------------------------------------
// 差异 7（本次总评审新增）：400 响应体里回显用户输入时必须**限长 + 去控制字符**
//
// main：也是回显（`Unknown scenario: ${scenario}`），但**原样**回显。
// 本分支：回显前统一过 echoForError() —— 去掉控制字符、限长 40。
//
// 为什么：这两个字段是用户可控的，而 express.json() 的默认上限是 100kb
// ⇒ 100kb 的请求能换来 100kb 的 400 响应（响应放大），而这个端点公开、
// 可无限重复调用。控制字符还会污染日志与任何把错误体渲染成文本的地方。
//
// 注意：正文大小要**留出余量** —— 超过 express.json 的 100kb 上限的话，
// 请求会在 body 解析阶段就被拒（400 'Invalid request body'），
// 根本走不到 scenario 校验，那种情况下这条测试是**因为错误的理由**通过的。
//
// 控制字符用 String.fromCharCode 构造（不写进源码字面量）：
// 源码里直接放控制字符会让文件本身带上不可见字节，评审和 diff 都看不清。
// ---------------------------------------------------------------------------

const CTRL_NUL = String.fromCharCode(0);
const CTRL_BEL = String.fromCharCode(7);

// 字符串里有没有控制字符（< 0x20 或 === 0x7f）。
function hasControlChars(s) {
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

test('差异 7：scenario 回显被限长（50KB 输入不会换来 50KB 响应）', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    scenario: 'x'.repeat(50 * 1024),
  });
  assert.equal(res.status, 400);

  // 关键：走的是 scenario 校验，不是 body 解析失败。
  const body = JSON.parse(text);
  assert.ok(
    body.error.startsWith('Unknown scenario: '),
    `走错了分支：${body.error.slice(0, 60)}`
  );

  // 响应体被限住了（不是 50KB）。
  assert.ok(text.length < 500, `响应体被放大了：${text.length} 字节`);

  // 回显值本身被截到 40 字符 + 省略号。
  const echoed = body.error.slice('Unknown scenario: '.length);
  assert.equal(echoed.length, 41);
  assert.ok(echoed.endsWith('…'));
});

test('差异 7：回显里不含控制字符', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    structured_output: `坏${CTRL_NUL}值${CTRL_BEL}`,
  });
  assert.equal(res.status, 400);
  const body = JSON.parse(text);
  assert.ok(
    body.error.startsWith('Unknown structured_output: '),
    `走错了分支：${body.error.slice(0, 60)}`
  );
  // 控制字符（NUL / BEL）被吃掉了，只剩可打印字符。
  assert.ok(!hasControlChars(text), '响应体里有控制字符');
  assert.ok(body.error.includes('坏值'));
});
