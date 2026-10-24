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
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';
import { getDb } from '../db.js';
import { createCbtEngine, CbtEngineError } from '../server/engine/cbtEngine.js';
import { STUCK_POINT_SCHEMA } from '../server/contracts/stuckPoint.js';

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

test('messages 传空数组 → 允许（它确实是数组）', { timeout: 15000 }, async () => {
  installFetch('你好。');
  const { res } = await postChat({ messages: [] });
  assert.equal(res.status, 200);
  // 没有用户消息，但会话与助手消息都该在
  assert.equal(countMessages('user'), 0);
  assert.equal(countMessages('assistant'), 1);
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
    () => engine({ scenario: 'analysis', history: [], structuredOutput: 'plan' }),
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
