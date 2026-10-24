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

test('对话接口在没有可用模型密钥时返回 500 而不是崩溃', async () => {
  resetDb();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.ok(res.status === 500 || res.status === 502, `期望 5xx，实际 ${res.status}`);
});
