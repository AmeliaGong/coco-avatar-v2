import './helpers/testEnv.js';
import { test, before, beforeEach, after } from 'node:test';
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

// 公开的会话响应**不能**带教练内部的归属标签。
//
// 这不是洁癖：client_id 一旦泄露，别人就能拿着它去读**同一个客户的
// 其它会话**的方案 —— 公开的 /api/conversations/:id/plan 靠
// conversation_id 找人，找到会话再按「link_kind='client' 且 client_id
// 非空」取方案。归属标签不外泄，这条链才断在源头。
test('公开的会话响应里没有 client_id 与 link_kind', async () => {
  const db = getDb();
  const created = await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json();
  // 模拟教练在后台把这个会话挂到某个客户名下（link_kind='client'）。
  db.prepare("UPDATE conversations SET client_id = ?, link_kind = 'client' WHERE id = ?")
    .run('客户代号-x', created.id);

  const body = await (await fetch(`${base}/api/conversations/${created.id}`)).json();
  assert.equal('client_id' in body, false, 'client_id 不能进公开响应');
  assert.equal('link_kind' in body, false, 'link_kind 不能进公开响应');
  assert.equal(JSON.stringify(body).includes('客户代号-x'), false, '归属标签的值不能出现在公开响应里');
  // 来访者该看的字段照旧。
  assert.equal(body.id, created.id);
  assert.equal(body.status, 'active');
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
