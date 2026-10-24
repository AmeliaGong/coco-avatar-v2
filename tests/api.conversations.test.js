import './helpers/testEnv.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

let base;
let server;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

// before 失败时 server 为 undefined，用可选链避免抛出掩盖真实错误。
after(() => server?.close());

// 每个用例前清库，让各用例彼此独立。
beforeEach(() => resetDb());

test('POST /api/conversations 创建会话并返回 id', async () => {
  const res = await fetch(`${base}/api/conversations`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(
    body.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test('GET /api/conversations/:id 返回该会话与消息', async () => {
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

test('管理接口带伪造 token 时返回 401', async () => {
  const res = await fetch(`${base}/api/admin/conversations`, {
    headers: { 'x-admin-token': 'not-a-real-token' },
  });
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

test('管理员登录成功后可用 token 访问管理接口', async () => {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token && typeof token === 'string');

  const res = await fetch(`${base}/api/admin/conversations`, {
    headers: { 'x-admin-token': token },
  });
  assert.equal(res.status, 200);
});
