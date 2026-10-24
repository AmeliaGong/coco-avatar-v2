import './helpers/testEnv.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server.close());

test('POST /api/conversations 创建会话并返回 id', async () => {
  resetDb();
  const res = await fetch(`${base}/api/conversations`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.id, /^[0-9a-f-]{36}$/);
});

test('GET /api/conversations/:id 返回该会话与消息', async () => {
  resetDb();
  const created = await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json();
  const res = await fetch(`${base}/api/conversations/${created.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, created.id);
  assert.deepEqual(body.messages, []);
});

test('管理接口未带 token 时返回 401', async () => {
  const res = await fetch(`${base}/api/admin/conversations`);
  assert.equal(res.status, 401);
});

test('管理员登录密码错误时返回 401', async () => {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(res.status, 401);
});
