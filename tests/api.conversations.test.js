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

// 场景要回给前端：刷新页面 / 重进会话时，前端靠它恢复场景。
// 不恢复的话，会话掉回默认的 chat —— 而 chat 的 prompt 开头是「故事模式」，
// 故事线会被搅乱（用户会看到 Coco 突然开始讲故事）。
test('GET /api/conversations/:id 会把场景带回给前端', async () => {
  const db = getDb();
  const created = await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json();
  db.prepare('UPDATE conversations SET scenario = ? WHERE id = ?').run('idea', created.id);

  const body = await (await fetch(`${base}/api/conversations/${created.id}`)).json();
  assert.equal(body.scenario, 'idea');
});

// ── 2026-11-19：后台生成的链接要能选场景 ───────────────────────────
//
// 探索者的目录/选人/逐段讲故事**只在 `scenario='story'` 里注入**
// （server/engine/explorer.js 的 `enabled: scenario === 'story'`）。
// 后台建链接原来不写场景 ⇒ 表默认值 'chat' ⇒ 链接里跑不到那条线。

async function adminToken() {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  const { token } = await login.json();
  return token;
}

test('后台建链接可以指定场景（story），且公开接口读得到', async () => {
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ title: '故事线', expires_in_days: 7, scenario: 'story' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.scenario, 'story');

  // 前端刷新时靠这个恢复场景（GET /api/conversations/:id）
  const pub = await (await fetch(`${base}/api/conversations/${body.id}`)).json();
  assert.equal(pub.scenario, 'story');
});

test('后台建链接不指定场景 ⇒ 还是 chat（不改变既有链接的含义）', async () => {
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ title: '老样子', expires_in_days: 7 }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).scenario, 'chat');
});

test('后台建链接传了非法场景 ⇒ 400（不要默默改成 chat）', async () => {
  const token = await adminToken();
  const res = await fetch(`${base}/api/admin/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ title: '乱写的', scenario: 'not-a-scenario' }),
  });
  assert.equal(res.status, 400);
});

test('已经发出去的链接可以改场景（不用重发一个新链接）', async () => {
  const token = await adminToken();
  const created = await (
    await fetch(`${base}/api/admin/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ title: '改成故事线' }),
    })
  ).json();
  const res = await fetch(`${base}/api/admin/conversations/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ scenario: 'story' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).scenario, 'story');
});

test('会话里的场景会跟着这一轮实际在用的场景走（刷新不掉回 chat）', async () => {
  // 背景：后台建的链接默认 'chat'，用户在链接里点「听听 Coco 和探索者们的
  // 故事」⇒ 那一轮走的是 story ⇒ 刷新后必须还是 story，
  // 否则故事线断掉、模型看不到探索者目录。
  const token = await adminToken();
  const created = await (
    await fetch(`${base}/api/admin/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ title: '点按钮那条' }),
    })
  ).json();
  assert.equal(created.scenario, 'chat');

  // 装一个假 fetch —— 测试环境里的网关地址是 unreachable 的（tests/helpers/testEnv.js），
  // 不装的话这一轮会 500（模型调用失败），断言就变成在测模型了。
  globalThis.__cocoFetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: '好的' } }] };
    },
    async text() {
      return '';
    },
  });

  // 走一轮 scenario='story' 的对话
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '我想听听探索者们的故事' }],
      conversation_id: created.id,
      scenario: 'story',
    }),
  });
  const chatBody = await chat.text();
  assert.equal(chat.status, 200, chatBody.slice(0,300));

  globalThis.__cocoFetchImpl = undefined;

  const pub = await (await fetch(`${base}/api/conversations/${created.id}`)).json();
  assert.equal(pub.scenario, 'story', '这一轮走的是 story ⇒ 库里也要记成 story');
});
