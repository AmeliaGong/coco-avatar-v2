import './helpers/testEnv.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createPlanStore } from '../server/delivery/plans.js';
import { createUserDeliveryRouter } from '../server/delivery/userRoutes.js';
import { createInternalUserDeliveryRouter } from '../server/delivery/internalUserRoutes.js';

// **这里自己起一个 express app，而不是用 server.js 导出的 app。**
// 原因：交付模块的用户端路由由 server.js 挂载，而 server.js 不属于本文件
// 的改动范围。测试要能独立跑，就不能依赖「别人什么时候把路由挂上去」。
// 挂载方式与 server.js 计划里的写法一致（app.use(router)）。
//
// 顺带的好处：这条测试只测「路由 + service」，不掺 server.js 的其他中间件。

const db = getDb();
const plans = createPlanStore({ db });

// internal 的挂载用一个独立的开关（internal: true），而不是靠
// serviceToken 是否为 undefined —— 后者分不清「没传」与「传了 undefined」。
function makeApp({ internal = false, internalServiceToken } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createUserDeliveryRouter({ db, plans }));
  if (internal) {
    app.use(
      createInternalUserDeliveryRouter({ db, plans, serviceToken: internalServiceToken })
    );
  }
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let server;
let baseUrl;

// server 必须在测试结束后关掉，否则 node --test 会一直等事件循环排空 ——
// 表现为「测试跑完了但进程不退出」。
before(async () => {
  server = await listen(makeApp());
  baseUrl = server.baseUrl;
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  resetDb();
});

const PAYLOAD = {
  diagnosis: { core_belief: '我不能停下来', pattern: '一直加班', root_cause: '怕被评价' },
  vision: { title: '有边界的忙碌', narrative: '你可以在停下来时仍然是值得被喜欢的人。', horizon: '1_year' },
  practices: [
    { day: 1, title: '午休离开工位', intent: '验证停下来不会出事', action: '今天午休离开工位十分钟', evidence_prompt: '离开工位的时候在想什么？', success_criteria: '离开满十分钟' },
    { day: 2, title: '关掉一个通知', intent: '验证不是所有消息都要立刻回', action: '关掉一个工作群的免打扰', evidence_prompt: '关掉之后最怕发生什么？', success_criteria: '保持关闭一小时' },
  ],
  worth_practicing: true,
};

function seedFullChain({ status = 'pending_activation' } = {}) {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO clients (id, display_name, source, status, notes, external_id, created_at, updated_at)
     VALUES ('client-1', '客户甲', 'manual', 'active', '教练私有备注', 'nomad-user-1', ?, ?)`
  ).run(ts, ts);
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status, scenario, client_id, link_kind) VALUES ('conv-1', 'CBT', ?, 'active', 'chat', 'client-1', 'client')"
  ).run(ts);
  db.prepare(
    `INSERT INTO plans (id, client_id, status, version, payload, created_at) VALUES ('plan-1', 'client-1', ?, 1, ?, ?)`
  ).run(status, JSON.stringify(PAYLOAD), ts);
  const practiceIds = ['prac-1', 'prac-2'];
  PAYLOAD.practices.forEach((p, i) => {
    db.prepare(
      `INSERT INTO practices (id, plan_id, day, title, intent, action, evidence_prompt, success_criteria, custom_data, sort_order)
       VALUES (?, 'plan-1', ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(practiceIds[i], p.day, p.title, p.intent, p.action, p.evidence_prompt, p.success_criteria, i);
  });
  return { practiceIds };
}

// ---------- 公开路由（链接即凭证）----------

test('没有方案时返回 has_plan: false', async () => {
  const res = await fetch(`${baseUrl}/api/conversations/conv-x/plan`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.has_plan, false);
});

// ⚠️ **这条是安全回归**：自报的 client_id 不许让人读到别人的方案。
//
// conversations.client_id 是公开 /api/chat 允许调用方自己填的「自报标签」。
// 所以一个来访者可以新建一个会话、把 client_id 填成某个真实客户的 id，
// 再打开 /api/conversations/:id/plan —— 如果用户端只看 client_id，
// 他就读到了那个客户的方案（含 1v1 诊断结论）。
//
// link_kind = 'client' 是「这条关联是教练建立的」标记 ——
// 只有教练在交付后台挂载会话时才会写，公开路径碰不到它。
test('自报 client_id 的会话读不到别人的方案', async () => {
  seedFullChain();
  const ts = new Date().toISOString();
  // 攻击者自己建会话，client_id 填成真实客户 client-1，link_kind 保持默认 'test'
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status, scenario, client_id) VALUES ('conv-attack', '蹭链接', ?, 'active', 'chat', 'client-1')"
  ).run(ts);
  const body = await (await fetch(`${baseUrl}/api/conversations/conv-attack/plan`)).json();
  assert.equal(body.has_plan, false, '自报 client_id 的会话读到了别人的方案');
});

test('待激活时返回方案摘要与练习清单', async () => {  seedFullChain();
  const body = await (await fetch(`${baseUrl}/api/conversations/conv-1/plan`)).json();
  assert.equal(body.has_plan, true);
  assert.equal(body.status, 'pending_activation');
  assert.equal(body.vision.title, '有边界的忙碌');
  assert.equal(body.practices.length, 2);
  assert.equal(body.current_practice.title, '午休离开工位');
});

test('用户端响应里绝不含教练私有备注', async () => {
  seedFullChain();
  const raw = await (await fetch(`${baseUrl}/api/conversations/conv-1/plan`)).text();
  assert.ok(!raw.includes('教练私有备注'), '私有备注泄漏了');
});

test('开始练习：pending_activation → active', async () => {
  seedFullChain();
  const res = await fetch(`${baseUrl}/api/conversations/conv-1/plan/start`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'active');
});

test('回填证据：存下来，进度变成 1/2', async () => {
  seedFullChain({ status: 'active' });
  const res = await fetch(`${baseUrl}/api/conversations/conv-1/plan/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_id: 'prac-1', content: '今天走了十分钟' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.progress.completed, 1);
  assert.equal(body.progress.total, 2);
  assert.equal(body.current_practice.title, '关掉一个通知');
});

test('回填证据：practice_id 不属于当前方案时拒绝', async () => {
  seedFullChain({ status: 'active' });
  const res = await fetch(`${baseUrl}/api/conversations/conv-1/plan/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_id: '别的方案的练习', content: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('回填证据：空白内容拒绝', async () => {
  seedFullChain({ status: 'active' });
  const res = await fetch(`${baseUrl}/api/conversations/conv-1/plan/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_id: 'prac-1', content: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('回填证据：方案还没开始时拒绝', async () => {
  seedFullChain({ status: 'pending_activation' });
  const res = await fetch(`${baseUrl}/api/conversations/conv-1/plan/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_id: 'prac-1', content: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('连续天数：连续两天的证据算 2 天', async () => {
  seedFullChain({ status: 'active' });
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const today = new Date().toISOString();
  db.prepare(
    'INSERT INTO evidences (id, practice_id, client_id, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('ev-1', 'prac-1', 'client-1', '昨天做的', yesterday, yesterday);
  db.prepare(
    'INSERT INTO evidences (id, practice_id, client_id, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('ev-2', 'prac-1', 'client-1', '今天做的', today, today);
  const body = await (await fetch(`${baseUrl}/api/conversations/conv-1/plan`)).json();
  assert.equal(body.progress.streak_days, 2);
});

// ---------- 信念系统（C.1 / D.5）----------

test('信念系统会下发给用户端（用户看得到这一期在打什么）', async () => {
  seedFullChain();
  const ts = new Date().toISOString();
  // 只留这一份方案 —— 两条方案并存时「取哪一条」由 plans 决定，测起来含糊。
  // 先删子表再删父表（外键是开着的）。
  db.prepare('DELETE FROM evidences').run();
  db.prepare('DELETE FROM practices').run();
  db.prepare('DELETE FROM plans WHERE client_id = ?').run('client-1');
  db.prepare(
    "INSERT INTO plans (id, client_id, status, version, payload, created_at) VALUES ('plan-bs', 'client-1', 'pending_activation', 1, ?, ?)"
  ).run(JSON.stringify({
    ...PAYLOAD,
    diagnosis: {
      ...PAYLOAD.diagnosis,
      belief_system: {
        core_new: '新的核心信念',
        peripheral: [{ name: '外周信念甲', statement: '它到底是什么', new_voice: '它的新声音' }],
        deferred: ['本期不碰的议题'],
      },
    },
  }), ts);
  const body = await (await fetch(`${baseUrl}/api/conversations/conv-1/plan`)).json();
  assert.equal(body.diagnosis.belief_system.core_new, '新的核心信念');
  assert.equal(body.diagnosis.belief_system.peripheral[0].name, '外周信念甲');
  assert.deepEqual(body.diagnosis.belief_system.deferred, ['本期不碰的议题']);
});

// ---------- internal 路由（BFF：Bearer service token，按 external_id · 契约 4）----------

const TOKEN = 'test-internal-token';

async function withInternalApp(fn) {
  const s = await listen(makeApp({ internal: true, internalServiceToken: TOKEN }));
  try {
    await fn(s.baseUrl);
  } finally {
    await s.close();
  }
}

test('internal 路由：Bearer service token 可以按 external_id 读方案', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.has_plan, true);
    assert.equal(body.status, 'pending_activation');
    assert.equal(body.practices.length, 2);
  });
});

test('internal 路由：没有 service token → 401', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan`);
    assert.equal(res.status, 401);
  });
});

test('internal 路由：错的 service token → 401', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.status, 401);
  });
});

test('internal 路由：服务间密钥没配 → 503（不是 401）', async () => {
  seedFullChain();
  const saved = process.env.INTERNAL_SERVICE_TOKEN;
  delete process.env.INTERNAL_SERVICE_TOKEN;
  const s = await listen(makeApp({ internal: true }));
  try {
    const res = await fetch(`${s.baseUrl}/api/internal/clients/by-external/nomad-user-1/plan`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 503);
  } finally {
    await s.close();
    if (saved !== undefined) process.env.INTERNAL_SERVICE_TOKEN = saved;
  }
});

test('internal 路由：响应里也不含教练私有备注', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const raw = await (
      await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    ).text();
    assert.ok(!raw.includes('教练私有备注'), '私有备注泄漏了');
  });
});

test('internal 路由：打卡也走同一套逻辑，进度与公开层一致', async () => {
  seedFullChain({ status: 'active' });
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ practice_id: 'prac-1', content: '小程序里打的卡' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.progress.completed, 1);
    assert.equal(body.progress.total, 2);
    assert.equal(body.current_practice.title, '关掉一个通知');
  });
  // 公开层读到的必须是同一份进度（唯一真相源在 Coco Avatar）。
  const publicBody = await (await fetch(`${baseUrl}/api/conversations/conv-1/plan`)).json();
  assert.equal(publicBody.progress.completed, 1);
  assert.equal(publicBody.progress.total, 2);
  assert.equal(publicBody.current_practice.title, '关掉一个通知');
});

test('internal 路由：开始练习也能走通', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'active');
  });
});

// ⚠️ **fail-closed 回归**：Coco Avatar 的内部 UUID 不出 Coco Avatar。
// 有人把 client_id 填进 external_id 槽位时，解析不到就是 404 ——
// 绝不会误命中别人的档案。
// ---------- 打卡内容的闸门（增补 I.3）----------

test('打卡内容超过 4000 字 → 400，不落库', async () => {
  seedFullChain({ status: 'active' });
  const res = await fetch(`${baseUrl}/api/conversations/conv-1/plan/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_id: 'prac-1', content: '字'.repeat(4001) }),
  });
  assert.equal(res.status, 400);
  const n = db.prepare('SELECT COUNT(*) c FROM evidences').get().c;
  assert.equal(n, 0, '超限的打卡不该落库');
});

test('打卡太频繁 → 429（链接即凭证，脚本能无限刷）', async () => {
  seedFullChain({ status: 'active' });
  const post = () =>
    fetch(`${baseUrl}/api/conversations/conv-1/plan/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ practice_id: 'prac-1', content: '一次打卡' }),
    });
  let last = null;
  for (let i = 0; i < 21; i++) last = await post();
  assert.equal(last.status, 429);
});

test('internal 路由：把 client_id 填进 external_id 槽位 → 404（fail-closed）', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/client-1/plan`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 404);
  });
});

// ⚠️ **中间件顺序回归**：先认证（401），再解析主体（404）。
// 反过来的话，没带 token 的人能拿 external_id 去试「这个人有没有交付
// 记录」—— 那就是个探测口。
test('internal 路由：没带 token 时先 401，不泄漏主体是否存在', async () => {
  seedFullChain();
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nomad-user-1/plan`);
    assert.equal(res.status, 401);
  });
});

test('internal 路由：external_id 查不到人 → 404（尚无交付，不是错误）', async () => {
  await withInternalApp(async (url) => {
    const res = await fetch(`${url}/api/internal/clients/by-external/nobody/plan`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 404);
  });
});
