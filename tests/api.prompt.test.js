import './helpers/testEnv.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'tests/fixtures/legacy-chat-prompt.txt');

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server?.close());

test('线上 prompt 与黄金快照仍然一致（防止迁移过程手抖）', async () => {
  const golden = fs.readFileSync(GOLDEN, 'utf8');
  // 直接从 server.js 里读出当前生效的 prompt 来源
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(
    !source.includes('const SYSTEM_PROMPT = `'),
    'server.js 里仍然存在 SYSTEM_PROMPT 字面量，说明迁移没做完'
  );
  const { createPromptRegistry } = await import('../server/promptRegistry.js');
  const { getDb } = await import('../db.js');
  const registry = createPromptRegistry({ db: getDb() });
  assert.equal(registry.getPrompt('chat'), golden);
});

test('发往网关的请求体与 main 逐字节一致（system prompt = 黄金快照 + 消息数组 + 参数）', async () => {
  // 黄金快照钉的是 **prompt 的拼装**。这条钉的是**真正发出去的那个请求** ——
  // 因为「零行为变化」这句话真正要保证的是请求本身，而不只是拼装结果。
  //
  // 两者必须**共用同一个黄金文件**：如果这里另抄一份 prompt 文本，
  // 两份就会各自漂移，谁也证明不了谁。所以下面断言的 system 内容
  // 直接来自 tests/fixtures/legacy-chat-prompt.txt（那份文件与 main 的
  // SYSTEM_PROMPT 字面量逐字节相同）。
  resetDb();
  const golden = fs.readFileSync(GOLDEN, 'utf8');

  let captured = null;
  globalThis.__cocoFetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: '好的。' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        };
      },
      async text() {
        return '';
      },
    };
  };
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }

  assert.ok(captured, '模型没有被调用 —— 根本没走到网关这一步');

  // 目标地址：走的是配置项（生产默认就是 MiniMax 的 chatcompletion_v2）。
  assert.equal(captured.url, process.env.MINIMAX_API_URL);

  // 请求头：两个头，与 main 一致。
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.match(captured.init.headers.Authorization, /^Bearer /);

  // **整个请求体逐字节相同**（包括键的顺序 —— JSON.stringify 的顺序是
  // 确定的，所以这是真的「字节级」比较，不是「结构差不多」）。
  const expected = JSON.stringify({
    model: 'MiniMax-M2.7',
    messages: [
      { role: 'system', content: golden },
      { role: 'user', content: 'hi' },
    ],
    max_tokens: 2000,
  });
  assert.equal(captured.init.body, expected);

  // 再逐项断言一遍，便于失败时一眼看出是哪一项变了。
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'MiniMax-M2.7');
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, golden);
  assert.deepEqual(body.messages[1], { role: 'user', content: 'hi' });
});

test('模型网关不可用时返回 502 而不是崩溃', async () => {
  resetDb();
  // 用假 fetch 制造一个确定的网关故障：断言不再依赖「打到一个打不通的
  // 地址会得到什么」，而是「网关 500 → 路由 502」。
  globalThis.__cocoFetchImpl = async () => ({
    ok: false,
    status: 500,
    async json() {
      return {};
    },
    async text() {
      return 'gateway down';
    },
  });
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error, '错误响应里没有 error 字段');
  } finally {
    globalThis.__cocoFetchImpl = undefined;
  }
});

test('网关地址根本打不通时返回 5xx 而不是崩溃', async () => {
  resetDb();
  // 这条不装假 fetch：走真实的 fetch，打到 testEnv 设的不可达地址
  // （127.0.0.1:9，fetch 会直接抛「bad port」）。网络层炸了也不能让
  // 请求挂死 —— 必须有个 5xx 出来。
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.ok(res.status === 500 || res.status === 502, `期望 5xx，实际 ${res.status}`);
});
