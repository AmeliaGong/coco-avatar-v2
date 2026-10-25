// 交付模块的端到端回归：建客户 → 挂会话导卡点 → 粘 1v1 → 出方案 →
// 发布 → 用户打开链接 → 开始 → 回填 → 进度更新。
//
// **这一条测的是「整条链在同一个进程里接得上」**，不是单个模块的行为
// （单个模块各有自己的单测）。所以它走的是 **server.js 挂好的真实 app**
// （tests/helpers/testServer.js），而不是自己拼一个 express ——
// 挂载漏了、挂错前缀、挂在了 SPA 兜底之后，在这里都会红。
//
// 唯一步骤是「真调模型」：生成方案草稿那一步要调上游网关，测试环境
// 的网关地址是 127.0.0.1:9（不可达）—— 所以这一步直接写草稿代替，
// 模型那一段由 server/delivery/analysis.js 的单测覆盖。
// 「发布 → 用户侧」这一段是真链路，必须在这里走完。
import './helpers/testEnv.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createServer } from './helpers/testServer.js';

const db = getDb();

let server;
let baseUrl;
let token;

before(async () => {
  server = await createServer();
  baseUrl = server.baseUrl;
});

after(async () => {
  await server?.close?.();
});

beforeEach(async () => {
  resetDb();
  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin' }),
  });
  const body = await res.json();
  token = body.token;
  assert.ok(token, 'admin 登录没拿到 token');
});

const admin = (path, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
      ...(options.headers || {}),
    },
  });

const PAYLOAD = {
  diagnosis: {
    core_belief: '我不能停下来',
    pattern: '一直加班',
    root_cause: '怕被评价',
  },
  vision: {
    title: '有边界的忙碌',
    narrative: '你可以在停下来时仍然是值得被喜欢的人。',
    horizon: '1_year',
  },
  practices: [
    {
      day: 1,
      title: '午休离开工位',
      intent: '验证停下来不会出事',
      action: '今天午休离开工位十分钟',
      evidence_prompt: '离开工位的时候在想什么？',
      success_criteria: '离开满十分钟',
    },
    {
      day: 2,
      title: '关掉一个通知',
      intent: '验证不是所有消息都要立刻回',
      action: '关掉一个工作群的免打扰',
      evidence_prompt: '关掉之后最怕发生什么？',
      success_criteria: '保持关闭一小时',
    },
  ],
  worth_practicing: true,
};

test('完整链：建客户 → 挂会话导卡点 → 粘 1v1 → 出方案 → 发布 → 用户开始 → 回填 → 进度更新', async () => {
  const ts = new Date().toISOString();
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status, scenario, link_kind) VALUES ('conv-e2e', '第一次 CBT', ?, 'active', 'chat', 'test')"
  ).run(ts);
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at, structured_json) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'conv-e2e',
    'assistant',
    '我们识别到你的卡点',
    ts,
    JSON.stringify({ title: '我不敢停下来', belief: '我不能停下来' })
  );

  // 1. 建客户
  const client = await (
    await admin('/api/admin/clients', {
      method: 'POST',
      body: JSON.stringify({ display_name: '客户甲', notes: '教练私有备注' }),
    })
  ).json();
  assert.ok(client.id, '建客户没返回 id');

  // 2. 挂会话 + 导入卡点
  const attach = await (
    await admin(`/api/admin/clients/${client.id}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ conversation_ids: ['conv-e2e'] }),
    })
  ).json();
  assert.equal(attach.attached, 1);
  assert.equal(attach.stuck_points_imported, 1);

  // 3. 粘贴 1v1 咨询数据
  const session = await (
    await admin(`/api/admin/clients/${client.id}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ transcript: '来访者：我一停下来就慌。\n教练：你上次停下来是什么时候？' }),
    })
  ).json();
  assert.ok(session.id, '1v1 记录没存进去');

  // 4. 出方案（模型那一段由 analysis 的单测覆盖，这里直接写草稿）
  db.prepare(
    `INSERT INTO plans (id, client_id, status, version, payload, created_at) VALUES ('plan-e2e', ?, 'draft', 1, ?, ?)`
  ).run(client.id, JSON.stringify(PAYLOAD), ts);
  PAYLOAD.practices.forEach((p, i) => {
    db.prepare(
      `INSERT INTO practices (id, plan_id, day, title, intent, action, evidence_prompt, success_criteria, custom_data, sort_order)
       VALUES (?, 'plan-e2e', ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(`prac-e2e-${i + 1}`, p.day, p.title, p.intent, p.action, p.evidence_prompt, p.success_criteria, i);
  });
  const planId = 'plan-e2e';

  // 5. 发布
  const published = await (
    await admin(`/api/admin/plans/${planId}/publish`, { method: 'POST' })
  ).json();
  assert.equal(published.plan.status, 'pending_activation');

  // 6. 用户打开链接 → 看到待激活
  let user = await (await fetch(`${baseUrl}/api/conversations/conv-e2e/plan`)).json();
  assert.equal(user.has_plan, true);
  assert.equal(user.status, 'pending_activation');
  assert.equal(user.current_practice.title, '午休离开工位');
  assert.ok(!JSON.stringify(user).includes('教练私有备注'), '私有备注泄漏');

  // 7. 用户点开始
  user = await (await fetch(`${baseUrl}/api/conversations/conv-e2e/plan/start`, { method: 'POST' })).json();
  assert.equal(user.status, 'active');

  // 8. 用户回填第一条
  user = await (
    await fetch(`${baseUrl}/api/conversations/conv-e2e/plan/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ practice_id: 'prac-e2e-1', content: '今天午休走了十分钟' }),
    })
  ).json();
  assert.equal(user.progress.completed, 1);
  assert.equal(user.progress.total, 2);
  assert.equal(user.current_practice.title, '关掉一个通知');

  // 9. 回填第二条 → 完成
  user = await (
    await fetch(`${baseUrl}/api/conversations/conv-e2e/plan/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ practice_id: 'prac-e2e-2', content: '关了一个群的免打扰' }),
    })
  ).json();
  assert.equal(user.progress.completed, 2);
  assert.equal(user.current_practice, null);
});

test('方案发布后不可再改内容', async () => {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO clients (id, display_name, source, status, created_at, updated_at) VALUES ('c2', 'X', 'manual', 'active', ?, ?)`
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO plans (id, client_id, status, version, payload, created_at) VALUES ('p2', 'c2', 'pending_activation', 1, ?, ?)`
  ).run(JSON.stringify(PAYLOAD), ts);
  const res = await admin('/api/admin/plans/p2', {
    method: 'PATCH',
    body: JSON.stringify({ payload: PAYLOAD }),
  });
  assert.equal(res.status, 400);
});
