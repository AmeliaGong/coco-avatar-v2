// /api/chat 薄路由的测试。
//
// 这套测试全部用假 fetch 驱动，一个数据包都不发向网络。
//
// 两条贯穿全局的约束：
//   1. server.js 起的是**共享单例 app**（tests/helpers/testServer.js 里
//      import 的就是它），server.js 的模块级状态是全局的 —— 所以假 fetch
//      必须每个测试单独装、单独卸，不能靠改内部行为来切换。
//   2. 断言要能证伪「先写流后落库」这类实现顺序错误（E3）—— 见下面
//      「落库发生在响应体写出去之前」那条：它用 SQLite 触发器把落库
//      打断，看响应体里有没有已经写出去的流式内容。
import './helpers/testEnv.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createServer } from './helpers/testServer.js';
import { createGatewayRuleFetch } from './helpers/gatewayRule.js';
import { resetDb } from './helpers/testDb.js';
import { getDb } from '../db.js';
import { createCbtEngine, CbtEngineError } from '../server/engine/cbtEngine.js';
import { STUCK_POINT_SCHEMA } from '../server/contracts/stuckPoint.js';
import { STRUCTURED_OUTPUT_TYPE_NAMES, structuredJsonToPersist } from '../server/structuredTypes.js';

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
  // 测试缝必须清掉：生产路径不依赖它存在，留着会让后面的测试拿着假模型跑。
  globalThis.__cocoFetchImpl = undefined;
});

// --- 假模型 ---------------------------------------------------------------

// MiniMax 形状的成功响应。
function miniMaxResponse(content, usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content } }],
        usage,
      };
    },
    async text() {
      return '';
    },
  };
}

// 装一个「模型返回这段内容」的假 fetch。
function installFetch(content, usage) {
  globalThis.__cocoFetchImpl = async () => miniMaxResponse(content, usage);
}

// 装一个「网关直接报错」的假 fetch。
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

function rows(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

function countMessages(role) {
  return getDb()
    .prepare('SELECT COUNT(*) AS c FROM messages' + (role ? ' WHERE role = ?' : ''))
    .get(...(role ? [role] : [])).c;
}

// 一张真的卡点（不是占位符）。
const REAL_CARD = {
  title: '我怕被抛弃',
  belief: '一旦停下来就会被抛弃',
  evidence_against: ['上次停下来休息了三天，一切都好'],
  emotion: '焦虑',
  micro_action: '今天中午躺十分钟',
};

// 模型复述格式时会抄的那份骨架（值全是 schema 里的占位串）。
const RESTATED_CARD = {
  title: STUCK_POINT_SCHEMA.title,
  belief: STUCK_POINT_SCHEMA.belief,
  evidence_against: STUCK_POINT_SCHEMA.evidence_against,
  emotion: STUCK_POINT_SCHEMA.emotion,
  micro_action: STUCK_POINT_SCHEMA.micro_action,
};

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

test('正常路径返回伪 SSE，带 X-Conversation-Id 头', { timeout: 15000 }, async () => {
  installFetch('你好，我是 Coco。');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '用一句话介绍你自己' }],
  });

  assert.equal(res.status, 200);
  const convId = res.headers.get('x-conversation-id');
  assert.ok(convId, '缺少 X-Conversation-Id 头');

  // 伪 SSE：若干 `data: ` 行 + 结尾的 `data: [DONE]`
  const lines = text.split('\n').filter(l => l.startsWith('data: '));
  assert.ok(lines.length >= 1, '没有任何 data: 行');
  assert.equal(lines[lines.length - 1], 'data: [DONE]');
  assert.ok(text.includes('你好，我是 Coco。'));

  // 助手消息落库了
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, '你好，我是 Coco。');
  assert.equal(assistant[0].conversation_id, convId);
});

test('会话不存在时自动建一个，并把场景记在会话上', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    scenario: 'cbt_quick',
  });
  assert.equal(res.status, 200);
  const conv = rows('SELECT * FROM conversations');
  assert.equal(conv.length, 1);
  assert.equal(conv[0].scenario, 'cbt_quick');
  assert.equal(conv[0].status, 'active');
});

// ---------------------------------------------------------------------------
// E1：白名单校验必须发生在落库之前
// ---------------------------------------------------------------------------

test('scenario 非法 → 400，数据库里没有新增任何 user 消息', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    scenario: 'no_such_scenario',
  });

  assert.equal(res.status, 400);
  // 核心断言：一条没人回复的 user 消息不能留在库里
  assert.equal(countMessages(), 0);
  assert.equal(countMessages('user'), 0);
  // 会话也不该被建出来
  assert.equal(rows('SELECT * FROM conversations').length, 0);
});

test('structured_output 非法 → 400，同样没有 user 消息落库', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    structured_output: 'no_such_type',
  });

  assert.equal(res.status, 400);
  assert.equal(countMessages(), 0);
  assert.equal(rows('SELECT * FROM conversations').length, 0);
});

test('structured_output 不是字符串 → 400', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    structured_output: { type: 'stuck_point' },
  });

  assert.equal(res.status, 400);
  assert.equal(countMessages(), 0);
});

test('messages 不是数组 → 400（不能因为 messages.filter 抛错变成 500）', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  for (const bad of ['你好', 42, { role: 'user' }]) {
    const { res } = await postChat({ messages: bad });
    assert.equal(res.status, 400, `messages=${JSON.stringify(bad)} 应该 400`);
  }
  assert.equal(countMessages(), 0);
});

test('messages 不传 → 400，且不留下孤儿会话、不白调一次模型', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({});
    assert.equal(res.status, 400);
    // 模型调用是花钱的：请求本身不合法就不该走到那一步
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    // 也不能留下一个没人说话的孤儿会话
    assert.equal(rows('SELECT * FROM conversations').length, 0);
    assert.equal(countMessages(), 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('messages 传 null → 400，同样不留会话、不调模型', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({ messages: null });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0);
    assert.equal(countMessages(), 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('messages 传空数组 → 400（没有内容可发：不建会话、不调模型）', { timeout: 15000 }, async () => {
  // ⚠️ 这条测试以前钉的是 **200**（"允许（它确实是数组）"）—— 那是**虚构**。
  //
  // 空数组是数组，但里面没有内容：这样的请求发到网关会被拒
  // （2013 invalid params, chat content is empty）⇒ 生产上回 502。
  // 之所以在测试里看不出来，是因为**别的**假 fetch 对任何请求都回 200。
  // 现在回 400：请求本身没内容，不是「AI 挂了」。
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({ messages: [] });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求没内容却调了模型');
    // 也不能留下一个没人说话的孤儿会话
    assert.equal(rows('SELECT * FROM conversations').length, 0);
    assert.equal(countMessages(), 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

// ---------------------------------------------------------------------------
// 网关的规则必须**在本地**就被挡住
//
// 这一段用**按网关规则行事**的假 fetch（tests/helpers/gatewayRule.js）：
// 请求里没有「非 system 的非空消息」时，它按网关的真实形状回
// 200 + base_resp{status_code:2013} —— 也就是生产上会看到的东西。
//
// 它证明两件事：
//   1. 这种请求**根本没发出去**（调用次数为 0）—— 不是「发出去被拒」；
//   2. 正常请求**照发**（调用次数为 1），且发出去的请求体里确实带着那条
//      user 消息 —— 守卫没有把正常路径也堵掉。
// ---------------------------------------------------------------------------

test('网关规则：网关自己也会拒的形状，本地就挡掉，请求根本没发出去', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch();
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    // 这一组是**网关也会拒**的（线上验过：只有 system / 没有非空内容 ⇒ 2013）。
    for (const bad of [
      [], // 空数组
      [{ role: 'system', content: '客户端塞的 system' }], // 只有 system
      [{ role: 'user' }], // content 缺失
      [{ role: 'user', content: '   ' }], // content 是空白
      [null], // null 元素
    ]) {
      const { res } = await postChat({ messages: bad });
      assert.equal(res.status, 400, `messages=${JSON.stringify(bad)} 应该 400`);
    }
    assert.equal(calls.length, 0, '这种请求根本没发到网关');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '不留孤儿会话');
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('本平台更严：tool/developer 这些角色本平台不认（**不是**网关会 2013）', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch();
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    // 措辞要准确：这两个 400 是**本平台**给的（usableMessages 只认
    // user/assistant），不是网关回的 2013 —— 假 fetch 的规则比这宽
    // （它只看「非 system 且 content 非空」），所以它压根没被调用。
    for (const bad of [
      [{ role: 'tool', content: '工具结果' }],
      [{ role: 'developer', content: '开发者消息' }],
    ]) {
      const { res } = await postChat({ messages: bad });
      assert.equal(res.status, 400, `messages=${JSON.stringify(bad)} 应该 400`);
    }
    assert.equal(calls.length, 0, '根本没发到网关');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '不留孤儿会话');
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('tool 消息被剔掉：不进网关、不进库（判据与发模型的那份是同一份）', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch({ content: '收到。' });
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    const { res } = await postChat({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'tool', content: '工具结果' },
      ],
    });
    assert.equal(res.status, 200);
    // 发给网关的请求体里没有 tool 消息
    const sent = calls[0].messages;
    assert.equal(sent.length, 2, '只有 system + user');
    assert.deepEqual(sent[1], { role: 'user', content: '你好' });
    // 库里也没有 tool 消息
    assert.equal(countMessages('user'), 1);
    assert.equal(countMessages('tool'), 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('落库的用户消息 = 真正发给模型的那一条（不是「最后一条 user」）', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch({ content: '收到。' });
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    const { res } = await postChat({
      messages: [
        { role: 'user', content: '第一条' },
        { role: 'user', content: '' }, // 空的：引擎会剔掉
      ],
    });
    assert.equal(res.status, 200);
    // 引擎把空的那条剔掉了 —— 发给网关的是「第一条」
    const sent = calls[0].messages;
    assert.equal(sent.length, 2, '只有 system + 第一条');
    assert.deepEqual(sent[1], { role: 'user', content: '第一条' });
    // 落库也必须是「第一条」：模型听见了的那句话不能丢。
    // （之前这里是另一套判据：取「最后一条 user」⇒ pop() 拿到空的那条 ⇒
    //   「第一条」模型听见了、库里却没有。）
    const userRows = rows("SELECT * FROM messages WHERE role = 'user'");
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0].content, '第一条');
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('错误优先级：更具体的错先报出来（空消息不盖住配置错）', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const cases = [
    [{ messages: [], scenario: 'no_such_scenario' }, 'Unknown scenario'],
    [{ messages: [], structured_output: 'no_such_type' }, 'Unknown structured_output'],
    [{ messages: [], client_id: { evil: true } }, 'client_id 必须是字符串'],
    [{ messages: [], conversation_id: '' }, 'conversation_id 必须是非空字符串'],
  ];
  for (const [body, expected] of cases) {
    const { res, text } = await postChat(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(text.includes(expected), `期望包含「${expected}」，实际：${text}`);
  }
  assert.equal(rows('SELECT * FROM conversations').length, 0, '不留孤儿会话');
});

test('会话过期优先于「消息没内容」（410 先报）', { timeout: 15000 }, async () => {
  getDb()
    .prepare(
      'INSERT INTO conversations (id, title, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      'conv-expired-empty',
      null,
      new Date().toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
      'active'
    );
  installFetch('不该被调用');
  const { res, text } = await postChat({
    messages: [],
    conversation_id: 'conv-expired-empty',
  });
  assert.equal(res.status, 410);
  assert.ok(text.includes('expired'), text);
});

test('网关规则：正常请求照发到网关，且请求体里带着那条 user 消息', { timeout: 15000 }, async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch();
  globalThis.__cocoFetchImpl = fetchImpl;
  try {
    const { res } = await postChat({ messages: [{ role: 'user', content: '你好' }] });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, '正常请求必须照发');
    const sent = calls[0].messages;
    assert.equal(sent[0].role, 'system');
    assert.deepEqual(sent[1], { role: 'user', content: '你好' });
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

// ---------------------------------------------------------------------------
// 过期会话
// ---------------------------------------------------------------------------

test('过期会话 → 410，会话状态被置为 expired', { timeout: 15000 }, async () => {
  const db = getDb();
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'conv-expired',
    null,
    new Date().toISOString(),
    new Date(Date.now() - 60_000).toISOString(),
    'active'
  );

  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    conversation_id: 'conv-expired',
  });

  assert.equal(res.status, 410);
  const conv = rows('SELECT * FROM conversations WHERE id = ?', 'conv-expired')[0];
  assert.equal(conv.status, 'expired');
  assert.equal(countMessages(), 0);
});

// ---------------------------------------------------------------------------
// E4：结构化输出落库
// ---------------------------------------------------------------------------

test('结构化输出落进 messages.structured_json', { timeout: 15000 }, async () => {
  installFetch(`这是你的卡点。\n{"__structured__": ${JSON.stringify(REAL_CARD)}}`);
  const { res } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.ok(assistant.structured_json, 'structured_json 是空的');
  const stored = JSON.parse(assistant.structured_json);
  assert.equal(stored.title, '我怕被抛弃');
  // 正文里不该留着 marker 块
  assert.ok(!assistant.content.includes('__structured__'));
});

test('R-1：模型先复述格式再给真卡点时，落库的是真的那张卡', { timeout: 15000 }, async () => {
  const content = [
    '我先复述一下格式：',
    `{"__structured__": ${JSON.stringify(RESTATED_CARD)}}`,
    '你真正的卡点是：',
    `{"__structured__": ${JSON.stringify(REAL_CARD)}}`,
  ].join('\n');
  installFetch(content);

  const { res } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  const stored = JSON.parse(assistant.structured_json);
  // 复述里的占位骨架不能被当成答案
  assert.equal(stored.title, '我怕被抛弃');
  assert.notEqual(stored.title, STUCK_POINT_SCHEMA.title);
  assert.notEqual(stored.belief, STUCK_POINT_SCHEMA.belief);
});

test('R-1（顺序反过来）：模型先给真卡点、后面又复述了一遍格式时，落库的仍是真卡点', { timeout: 15000 }, async () => {
  // 「取最后一个合法块」在这里会取到**复述**那份 —— 契约校验才救得回来。
  // 这一条是 validators 真正起作用的证据。
  const content = [
    '你真正的卡点是：',
    `{"__structured__": ${JSON.stringify(REAL_CARD)}}`,
    '顺便把格式复述一遍：',
    `{"__structured__": ${JSON.stringify(RESTATED_CARD)}}`,
  ].join('\n');
  installFetch(content);

  const { res } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  const stored = JSON.parse(assistant.structured_json);
  assert.equal(stored.title, '我怕被抛弃');
});

test('模型只复述了格式、没给出契约合法的卡点 → structured_json 存 null，但请求仍然 200', { timeout: 15000 }, async () => {
  const content = [
    '好的，我按这个格式输出。',
    `{"__structured__": ${JSON.stringify(RESTATED_CARD)}}`,
  ].join('\n');
  installFetch(content);

  const { res } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.ok(assistant, '助手消息没有落库');
  // 绝不能把没过契约的、含占位符的假卡点存进库
  assert.equal(assistant.structured_json, null);
});

// ---------------------------------------------------------------------------
// E2 / E5：token 记账
// ---------------------------------------------------------------------------

test('token_usage 记下 scenario 与 prompt_version（两段内容哈希，不是 0.0）', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 200);

  const usage = rows('SELECT * FROM token_usage')[0];
  assert.ok(usage, '没有 token_usage 记录');
  assert.equal(usage.scenario, 'chat');
  assert.match(usage.prompt_version, /^[0-9a-f]{8}\.[0-9a-f]{8}$/);
  assert.notEqual(usage.prompt_version, '0.0');
  assert.equal(usage.total_tokens, 18);
});

test('不同场景的 prompt_version 不一样（能区分 chat 与 cbt_quick）', { timeout: 15000 }, async () => {
  installFetch('好的。');
  await postChat({ messages: [{ role: 'user', content: '你好' }], scenario: 'chat' });
  await postChat({ messages: [{ role: 'user', content: '你好' }], scenario: 'cbt_quick' });

  const versions = rows('SELECT scenario, prompt_version FROM token_usage ORDER BY id ASC');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].scenario, 'chat');
  assert.equal(versions[1].scenario, 'cbt_quick');
  assert.notEqual(versions[0].prompt_version, versions[1].prompt_version);
});

// ---------------------------------------------------------------------------
// E3：落库先于吐流
// ---------------------------------------------------------------------------

test('落库发生在响应体写出去之前', { timeout: 15000 }, async () => {
  const db = getDb();
  // 用触发器把「助手消息落库」这一步打断。如果实现是「先写流、后落库」，
  // 客户端已经拿到整段流式内容了；如果实现是「先落库、后写流」，这次
  // 请求会直接失败，一个 data: 行都不该出现。
  db.exec(`
    CREATE TRIGGER block_assistant_insert
    BEFORE INSERT ON messages
    WHEN NEW.role = 'assistant'
    BEGIN
      SELECT RAISE(ABORT, 'assistant insert blocked by test');
    END;
  `);

  installFetch('这条回复不该被写出去。');
  try {
    const { res, text } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
    });

    assert.equal(res.status, 500);
    assert.ok(
      !text.includes('data: '),
      '响应体里出现了流式内容 —— 说明是「先写流、后落库」'
    );
    assert.equal(countMessages('assistant'), 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_assistant_insert');
  }
});

// ---------------------------------------------------------------------------
// E2：empty_reply 不是失败
// ---------------------------------------------------------------------------

test('empty_reply：模型只给结构化块、没有正文 → 200，消息与 token 都落库', { timeout: 15000 }, async () => {
  installFetch(`{"__structured__": ${JSON.stringify(REAL_CARD)}}`);

  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  assert.ok(text.includes('data: '));

  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.ok(assistant, '助手消息没有落库');
  assert.ok(assistant.content.trim().length > 0, '兜底正文是空的');
  assert.ok(assistant.content.includes('我怕被抛弃'), '兜底正文里没有卡点标题');
  assert.equal(JSON.parse(assistant.structured_json).title, '我怕被抛弃');

  // 这一轮已经付过钱了，账必须记上
  const usage = rows('SELECT * FROM token_usage')[0];
  assert.ok(usage, 'empty_reply 时没有记账');
  assert.equal(usage.total_tokens, 18);
  assert.equal(usage.scenario, 'chat');
});

// ---------------------------------------------------------------------------
// 模型侧错误
// ---------------------------------------------------------------------------

test('模型网关返回 500 → 502，且没有任何 assistant 消息落库', { timeout: 15000 }, async () => {
  installFailingFetch(500);
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });

  assert.equal(res.status, 502);
  assert.equal(countMessages('assistant'), 0);
  assert.equal(rows('SELECT * FROM token_usage').length, 0);
});

test('模型返回空内容 → 502，且没有任何 assistant 消息落库', { timeout: 15000 }, async () => {
  globalThis.__cocoFetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: '' } }], usage: { total_tokens: 3 } };
    },
    async text() {
      return '';
    },
  });

  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });

  assert.equal(res.status, 502);
  assert.equal(countMessages('assistant'), 0);
});

// ---------------------------------------------------------------------------
// E7-1：notes 类型不对时必须抛 CbtEngineError（带 code），不能漏出裸 Error
// ---------------------------------------------------------------------------

test('E7-1：schemas 里的 notes 类型不对时，引擎抛 CbtEngineError 且 code 是 invalid_schema', { timeout: 15000 }, async () => {
  let called = false;
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel: async () => {
      called = true;
      return { content: 'ok', usage: { total_tokens: 1 } };
    },
    schemas: {
      plan: { schema: { worth_practicing: true }, notes: '这是一段字符串，不是字段语义表' },
    },
  });

  await assert.rejects(
    () => engine({ scenario: 'analysis', history: [{ role: 'user', content: '你好' }], structuredOutput: 'plan' }),
    (err) => {
      assert.ok(err instanceof CbtEngineError, `不是 CbtEngineError：${err && err.name}`);
      assert.equal(err.code, 'invalid_schema');
      return true;
    }
  );
  assert.equal(called, false, '配置错了就不该去调模型');
});

// ---------------------------------------------------------------------------
// E7-2：残骸清理不得越过行尾吃掉正文
// ---------------------------------------------------------------------------

test('E7-2：复述留下的截断残骸之后那行正文必须原样保留', { timeout: 15000 }, async () => {
  const content = [
    '这是你要的格式：',
    '{"__structured__": {"title": "卡点的一句话概括"',
    '残骸之后这一行正文必须原样保留。',
    `{"__structured__": ${JSON.stringify(REAL_CARD)}}`,
  ].join('\n');
  installFetch(content);

  const { res } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.ok(
    assistant.content.includes('残骸之后这一行正文必须原样保留。'),
    `残骸之后的正文被吃掉了：${JSON.stringify(assistant.content)}`
  );
  // 残骸本身不该进正文
  assert.ok(!assistant.content.includes('卡点的一句话概括'));
});

// ---------------------------------------------------------------------------
// C-1：client_id / conversation_id 必须是字符串
//
// 这两个字段之前是直接丢给 better-sqlite3 的：传一个对象会抛 RangeError
// （bind 参数不支持对象/数组），而那发生在 async handler 里 → Express 4
// 不接这个异常 → 进程直接退出、请求挂死。
// ---------------------------------------------------------------------------

test('client_id 不是字符串 → 400（不建会话、不调模型、进程不崩）', { timeout: 15000 }, async () => {
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
    assert.equal(countMessages(), 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('client_id 超过长度上限 → 400', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    client_id: 'x'.repeat(129),
  });
  assert.equal(res.status, 400);
  assert.equal(rows('SELECT * FROM conversations').length, 0);
});

test('client_id 是字符串 → 原样记进会话', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    client_id: 'client-abc',
  });
  assert.equal(res.status, 200);
  const conv = rows('SELECT * FROM conversations')[0];
  assert.equal(conv.client_id, 'client-abc');
});

test('conversation_id 不是字符串 → 400（不崩进程）', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    conversation_id: { evil: true },
  });
  assert.equal(res.status, 400);
  assert.equal(countMessages(), 0);
});

test('conversation_id 是空串 → 400', { timeout: 15000 }, async () => {
  installFetch('不该被调用');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
    conversation_id: '',
  });
  assert.equal(res.status, 400);
  assert.equal(rows('SELECT * FROM conversations').length, 0);
});

// ---------------------------------------------------------------------------
// I-1：conversation_id 的**字符集**
//
// conversation_id 会**原样**进 `X-Conversation-Id` 响应头。Node 的
// setHeader 拒绝控制字符（\n / \r / \0 …）—— 抛 ERR_INVALID_CHAR。
//
// 而本分支的顺序是「先落库、再吐流」：setHeader 发生在**模型调用之后**。
// 所以一个 'a\nb' 会走完：建会话 → 写用户消息 → **调模型（花钱）** →
// 落库 → setHeader 炸 → 500。用户拿到 500，库里留下孤儿会话与孤儿消息，
// 模型的钱已经付了。而且这是公开端点 —— 可以重复放大成本。
//
// 所以字符集必须在**任何写库 / 调模型之前**拒掉：400，且模型没被叫醒。
// ---------------------------------------------------------------------------

test('conversation_id 含换行 → 400（不建会话、不写消息、**不调模型**）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      conversation_id: 'a\nb',
    });
    assert.equal(res.status, 400);
    // 关键断言：模型不能被叫醒 —— 那一步是要花钱的。
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0, '留下了孤儿会话');
    assert.equal(countMessages(), 0, '留下了孤儿消息');
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('conversation_id 含控制字符（\\r / \\0）→ 400（不调模型）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    for (const bad of ['a\rb', 'a\u0000b']) {
      const { res } = await postChat({
        messages: [{ role: 'user', content: '你好' }],
        conversation_id: bad,
      });
      assert.equal(res.status, 400, `conversation_id=${JSON.stringify(bad)} 应该 400`);
      assert.equal(modelCalled, false, '请求不合法却调了模型');
      assert.equal(rows('SELECT * FROM conversations').length, 0);
      assert.equal(countMessages(), 0);
    }
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('conversation_id 含空格 → 400（不调模型）', { timeout: 15000 }, async () => {
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    for (const bad of ['a b', ' abc', 'abc ']) {
      const { res } = await postChat({
        messages: [{ role: 'user', content: '你好' }],
        conversation_id: bad,
      });
      assert.equal(res.status, 400, `conversation_id=${JSON.stringify(bad)} 应该 400`);
      assert.equal(modelCalled, false, '请求不合法却调了模型');
      assert.equal(rows('SELECT * FROM conversations').length, 0);
      assert.equal(countMessages(), 0);
    }
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('conversation_id 是合法 UUID → 正常走完（不是 400）', { timeout: 15000 }, async () => {
  // 我们自己的会话 id 就是 crypto.randomUUID()（server.js 的 generateId），
  // 前端把它原样回传（src/lib/api.ts:39）。所以 UUID **必须**能过 ——
  // 字符集检查不是要把正常的会话挡在门外。
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('好的。');
  };
  try {
    const uuid = crypto.randomUUID();
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      conversation_id: uuid,
    });
    assert.notEqual(res.status, 400, `合法 UUID 被拒了：${uuid}`);
    assert.equal(res.status, 200);
    assert.equal(modelCalled, true, '合法 UUID 没有走到模型');
    // 会话按这个 id 建出来了
    assert.equal(rows('SELECT * FROM conversations').length, 1);
    assert.equal(rows('SELECT * FROM conversations')[0].id, uuid);
    // 响应头里也是同一个值（这就是 setHeader 能接受它的原因）
    assert.equal(res.headers.get('x-conversation-id'), uuid);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

// ---------------------------------------------------------------------------
// C-2：async handler 的兜底 —— 出错要回 500，不能把进程带走
//
// 之前这里抛出的异常会变成 unhandledRejection → Node 默认让进程退出，
// 客户端只看到「连接被重置」。这条测试用触发器把「建会话」这一步打断：
// 没有兜底的话，整个测试进程会被带走（node --test 直接失败）。
// ---------------------------------------------------------------------------

test('建会话失败时回 500，进程不崩（async handler 的兜底）', { timeout: 15000 }, async () => {
  const db = getDb();
  db.exec(`
    CREATE TRIGGER block_conversation_insert
    BEFORE INSERT ON conversations
    BEGIN
      SELECT RAISE(ABORT, 'conversation insert blocked by test');
    END;
  `);

  installFetch('这条回复不该被写出去。');
  try {
    const { res, text } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
    });

    assert.equal(res.status, 500);
    assert.ok(!text.includes('data: '), '响应体里出现了流式内容');
    assert.equal(countMessages(), 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_conversation_insert');
  }
});

// ---------------------------------------------------------------------------
// I-1：助手消息、token 账、会话标题必须同一个事务
// ---------------------------------------------------------------------------

test('token 账写不进去时，助手消息也跟着回滚（同一个事务）', { timeout: 15000 }, async () => {
  const db = getDb();
  db.exec(`
    CREATE TRIGGER block_token_usage_insert
    BEFORE INSERT ON token_usage
    BEGIN
      SELECT RAISE(ABORT, 'token usage insert blocked by test');
    END;
  `);

  installFetch('这条回复不该被写出去。');
  try {
    const { res, text } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
    });

    assert.equal(res.status, 500);
    assert.ok(!text.includes('data: '), '响应体里出现了流式内容');
    // 事务回滚：助手消息与 token 账**都**不该在 ——
    // 「有消息没记账」和「有账没消息」一样是残缺的一轮。
    assert.equal(countMessages('assistant'), 0);
    assert.equal(rows('SELECT * FROM token_usage').length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_token_usage_insert');
  }
});

// ---------------------------------------------------------------------------
// I-3：几处「应该发生」的事（用户消息 / 自动标题 / 兜底正文 / 错误体）
// ---------------------------------------------------------------------------

test('用户消息落库了（模型看得见的那条也在库里）', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '我最近总是失眠' }],
  });
  assert.equal(res.status, 200);
  const user = rows("SELECT * FROM messages WHERE role = 'user'");
  assert.equal(user.length, 1);
  assert.equal(user[0].content, '我最近总是失眠');
});

test('会话标题自动取首条用户消息的前 50 个字', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user', content: 'x'.repeat(80) }],
  });
  assert.equal(res.status, 200);
  const conv = rows('SELECT * FROM conversations')[0];
  assert.equal(conv.title, 'x'.repeat(50) + '...');
});

test('兜底正文里不会出现没过契约校验的占位标题', { timeout: 15000 }, async () => {
  // 模型只复述了格式（占位骨架）→ 这份结构化没过契约校验。
  // 兜底正文**绝不能**把那份占位标题展示给用户。
  installFetch(`{"__structured__": ${JSON.stringify(RESTATED_CARD)}}`);
  const { res } = await postChat({
    messages: [{ role: 'user', content: '我卡住了' }],
    structured_output: 'stuck_point',
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.ok(assistant, '助手消息没有落库');
  assert.ok(
    !assistant.content.includes(STUCK_POINT_SCHEMA.title),
    `兜底正文里出现了占位标题：${assistant.content}`
  );
  assert.ok(
    !assistant.content.includes(STUCK_POINT_SCHEMA.belief),
    `兜底正文里出现了占位信念：${assistant.content}`
  );
});

test('502 的响应体里没有网关的内部细节', { timeout: 15000 }, async () => {
  installFailingFetch(500, 'gateway exploded: SECRET_INTERNAL_DETAIL');
  const { res, text } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });

  assert.equal(res.status, 502);
  assert.ok(
    !text.includes('SECRET_INTERNAL_DETAIL'),
    `响应体泄漏了网关的内部细节：${text}`
  );
  assert.deepEqual(JSON.parse(text), { error: 'AI Gateway error' });
});

test('500 的响应体只有一句通用文案（不泄漏 SQL / 触发器报错）', { timeout: 15000 }, async () => {
  const db = getDb();
  db.exec(`
    CREATE TRIGGER block_assistant_insert_for_body
    BEFORE INSERT ON messages
    WHEN NEW.role = 'assistant'
    BEGIN
      SELECT RAISE(ABORT, 'assistant insert blocked by test SECRET_SQL');
    END;
  `);

  installFetch('这条回复不该被写出去。');
  try {
    const { res, text } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
    });

    assert.equal(res.status, 500);
    assert.ok(!text.includes('SECRET_SQL'), `响应体泄漏了内部细节：${text}`);
    assert.deepEqual(JSON.parse(text), { error: 'Internal server error' });
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_assistant_insert_for_body');
  }
});

test('白名单里的每一种类型都能真的走通（白名单与引擎的 schemas 不能漂）', { timeout: 15000 }, async () => {
  // 白名单、引擎的 schemas、契约的 validators 出自同一张表
  // （server/structuredTypes.js）。这张测试是那道保证的**外部**证据：
  // 白名单里多了一个引擎不认识的类型，这里就会 400。
  for (const type of STRUCTURED_OUTPUT_TYPE_NAMES) {
    installFetch('好的。');
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      structured_output: type,
    });
    assert.equal(res.status, 200, `structured_output=${type} 没能走通`);
  }
});

test('处理完请求后，外键检查仍然是开着的', { timeout: 15000 }, async () => {
  installFetch('好的。');
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(res.status, 200);
  // 路由里不该有「临时关掉外键检查」的 pragma —— 就算有，也必须成对恢复。
  assert.equal(getDb().pragma('foreign_keys', { simple: true }), 1);
});

test('conversation_id 超过长度上限 → 400（不建会话、不调模型）', { timeout: 15000 }, async () => {
  // conversation_id 会**直接当 conversations.id 主键**写进去，还会原样进
  // X-Conversation-Id 响应头 —— 太长会把响应头撑爆（客户端连 500 都收
  // 不到），而那时库里已经落了行、模型的钱也已经付过了。
  let modelCalled = false;
  globalThis.__cocoFetchImpl = async () => {
    modelCalled = true;
    return miniMaxResponse('不该被调用');
  };
  try {
    const { res } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
      conversation_id: 'x'.repeat(50000),
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalled, false, '请求不合法却调了模型');
    assert.equal(rows('SELECT * FROM conversations').length, 0);
    assert.equal(countMessages(), 0);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('网关返回非字符串的 content → 502（invalid_content_type 是可达的）', { timeout: 15000 }, async () => {
  // modelClient 不做类型强制：`content || ''` 只挡假值，真值非字符串
  // （这里是一个对象）会原样穿过 → 引擎抛 invalid_content_type → 502。
  // 这条测试顺带钉住 errorStatus.js 里那句注释（「这条是可达的」）。
  globalThis.__cocoFetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: { text: 'hi' } } }],
        usage: { total_tokens: 3 },
      };
    },
    async text() {
      return '';
    },
  });

  // 抓一下服务端记下来的那个错误，确认走的是 invalid_content_type
  // （而不是「空内容」那条 —— 两者都映射到 502，光看状态码分不出来）。
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args);
  };
  try {
    const { res, text } = await postChat({
      messages: [{ role: 'user', content: '你好' }],
    });

    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(text), { error: 'AI Gateway error' });
    assert.equal(countMessages('assistant'), 0);

    const engineError = logged
      .flat()
      .find((a) => a && typeof a === 'object' && typeof a.code === 'string');
    assert.ok(engineError, '没有记录到带 code 的引擎错误');
    assert.equal(engineError.code, 'invalid_content_type');
  } finally {
    console.error = originalError;
  }
});

test('没做契约校验的结构化内容（validated === null）不落库', { timeout: 15000 }, async () => {
  // 造一个**不传 validators** 的引擎（将来的 BFF 就是这么调它的）：
  // 这时 structuredValidated 是 null（压根没校验），不是 true。
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel: async () => ({
      content: `这是你的卡点。\n{"__structured__": ${JSON.stringify(REAL_CARD)}}`,
      usage: { total_tokens: 1 },
    }),
    schemas: { stuck_point: { schema: STUCK_POINT_SCHEMA, notes: {} } },
  });
  const result = await engine({
    scenario: 'chat',
    history: [{ role: 'user', content: '你好' }],
    structuredOutput: 'stuck_point',
  });

  assert.equal(result.structuredValidated, null, '前提：这条路径确实没做契约校验');
  assert.ok(result.structured, '前提：这一轮确实拿到了结构化内容');
  // 路由用的落库判定：没校验过的不落库
  assert.equal(structuredJsonToPersist(result.structured, result.structuredValidated), null);
  // 校验过的照落
  assert.equal(structuredJsonToPersist(REAL_CARD, true), JSON.stringify(REAL_CARD));
  // 校验没过的也不落（既有行为，不许被改坏）
  assert.equal(structuredJsonToPersist(REAL_CARD, false), null);
});

test('路由落库用的是 structuredJsonToPersist（不是自己那套「只挡 false」的判定）', () => {
  // 上面那条测的是判据本身；这条钉住**路由确实用它** —— 否则改回
  // 「structuredValidated === false 才不落」的话，判据测得再对也没用。
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes('structuredJsonToPersist(turn.structured, turn.structuredValidated)'),
    'server.js 的 persistTurn 没有用 structuredJsonToPersist'
  );
  assert.ok(
    !/structuredValidated\s*===\s*false/.test(source),
    'server.js 里还有自己那套「只挡 false」的判定'
  );
});

// ---------------------------------------------------------------------------
// Express 错误处理中间件：body 解析失败不泄露堆栈
// ---------------------------------------------------------------------------

test('请求体不是合法 JSON → 400 + 简短 JSON（不给堆栈）', { timeout: 15000 }, async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"messages": [',
  });
  const text = await res.text();

  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(text), { error: 'Invalid request body' });
  assert.ok(!text.includes('at '), `响应体里出现了堆栈：${text}`);
  assert.ok(!text.includes('node_modules'), `响应体里出现了内部路径：${text}`);
});

test('请求体超过 100KB → 400 + 简短 JSON（不给堆栈）', { timeout: 15000 }, async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(200000) }] }),
  });
  const text = await res.text();

  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(text), { error: 'Invalid request body' });
  assert.ok(!text.includes('at '), `响应体里出现了堆栈：${text}`);
});

// ---------------------------------------------------------------------------
// M-1：兜底正文要分「有没有请求结构化输出」两种文案
// ---------------------------------------------------------------------------

test('本轮没请求结构化输出时，兜底正文说的是「没有请求结构化输出」', { timeout: 15000 }, async () => {
  // 模型只给了结构化块，但本轮**没**要求结构化输出 ——
  // 说「只交付了结构化内容」会让人一头雾水（引擎那边也是分开的两句）。
  installFetch(`{"__structured__": ${JSON.stringify(REAL_CARD)}}`);
  const { res } = await postChat({
    messages: [{ role: 'user', content: '你好' }],
  });

  assert.equal(res.status, 200);
  const assistant = rows("SELECT * FROM messages WHERE role = 'assistant'")[0];
  assert.ok(
    assistant.content.includes('没有请求结构化输出'),
    `兜底正文文案不对：${assistant.content}`
  );
  assert.ok(
    !assistant.content.includes('我怕被抛弃'),
    '没请求结构化输出，就不该把卡点标题当正文'
  );
});
