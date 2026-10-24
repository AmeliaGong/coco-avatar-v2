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
