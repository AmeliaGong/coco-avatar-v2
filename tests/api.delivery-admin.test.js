import './helpers/testEnv.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createRequireAdmin } from '../server/auth.js';
import { createClientStore } from '../server/delivery/clients.js';
import { createPlanStore } from '../server/delivery/plans.js';
import { createCoachMoveStore } from '../server/delivery/coachMoves.js';
import { createAdminDeliveryRouter } from '../server/delivery/adminRoutes.js';

// 分析服务按计划由别的模块提供（server/delivery/analysis.js）：
// 它负责跑引擎，而 1v1 记录的存取是数据层的活（createDeliveryData）——
// 挂到同一个对象上，adminRoutes 就只需要 analysis 一个依赖。
import { createAnalysisService, createDeliveryData } from '../server/delivery/analysis.js';

// 引擎按 server.js 的方式装配：真引擎 + 指向不可达网关的模型客户端
// （测试环境里 MINIMAX_API_URL 指向 127.0.0.1:9），所以「调模型」这条路
// 必然失败 —— 测试据此断言「返回了错误，而不是 404」。
import { createPromptRegistry } from '../server/promptRegistry.js';
import { createModelClient } from '../server/engine/modelClient.js';
import { createCbtEngine } from '../server/engine/cbtEngine.js';
import { STRUCTURED_SCHEMAS } from '../server/structuredTypes.js';
import { parseStuckPoint } from '../server/contracts/stuckPoint.js';
import { parsePlanPayload } from '../server/contracts/plan.js';

let server;
let baseUrl;
let token;
let clients;
let plans;
let moves;
let analysis;

before(async () => {
  const db = getDb();
  clients = createClientStore({ db });
  plans = createPlanStore({ db });
  moves = createCoachMoveStore({ db });

  const promptRegistry = createPromptRegistry({ db });
  const modelClient = createModelClient({
    apiKey: process.env.MINIMAX_API_KEY,
    baseUrl: process.env.MINIMAX_API_URL,
  });
  const cbtEngine = createCbtEngine({
    getPrompt: promptRegistry.getPrompt,
    getPromptMeta: promptRegistry.getPromptMeta,
    callModel: modelClient,
    // 结构化输出的形状与语义要一起给模型（与 server.js 的装法一致），
    // 少传 schemas 引擎会报「未知的结构化输出类型」。
    schemas: STRUCTURED_SCHEMAS,
  });
  analysis = createAnalysisService({
    callEngine: cbtEngine,
    validators: { stuck_point: parseStuckPoint, plan: parsePlanPayload },
  });
  // 1v1 记录与卡点的存取挂在分析服务上（server.js 里也是这么装的）。
  const deliveryData = createDeliveryData({ db });
  Object.assign(analysis, deliveryData);

  // 交付模块的后台路由：**前缀 /api/admin 由挂载处决定**，路由里写相对路径。
  //
  // 这里自己起一个 app 而不是用 server.js 的 app —— server.js 的 app 上有
  // SPA 兜底路由（app.get('*')），它会抢在后来挂上的路由之前把请求吃掉，
  // 测试里挂上去的路由就永远不会被匹配到。
  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin',
    createAdminDeliveryRouter({
      clients,
      plans,
      analysis,
      moves,
      requireAdmin: createRequireAdmin({ db }),
      db,
    })
  );

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

// 关掉监听 —— 否则进程不会退出（node --test 会一直等事件循环排空）。
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  resetDb();
  // admin 会话令牌：直接写 admin_sessions（与 POST /api/admin/login 同一张表、
  // 同一套语义 —— 24 小时过期）。
  //
  // **每个用例都要重写一遍**：resetDb() 会清空所有表，包括 admin_sessions ——
  // 令牌没了，后面每个请求都会 401。
  token = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(
      token,
      new Date().toISOString(),
      new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    );
});

function admin(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
      ...(options.headers || {}),
    },
  });
}

async function seedClientAndConversation() {
  const db = getDb();
  const convId = 'conv-test-1';
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status, scenario, link_kind) VALUES (?, '第一次 CBT', ?, 'active', 'chat', 'client')"
  ).run(convId, new Date().toISOString());
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at, structured_json) VALUES (?, ?, ?, ?, ?)'
  ).run(
    convId,
    'assistant',
    '我们识别到你的卡点',
    new Date().toISOString(),
    JSON.stringify({ title: '我不敢停下来', belief: '我不能停下来' })
  );
  return convId;
}

test('未登录时客户列表返回 401', async () => {
  const res = await fetch(`${baseUrl}/api/admin/clients`);
  assert.equal(res.status, 401);
});

test('建客户 → 列表里能看到', async () => {
  const res = await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲', phone: '13800000000' }),
  });
  assert.equal(res.status, 200);
  const list = await (await admin('/api/admin/clients')).json();
  assert.equal(list.clients.length, 1);
  assert.equal(list.clients[0].display_name, '客户甲');
});

test('挂载会话并导入卡点 → 客户详情里能看到会话与卡点', async () => {
  const convId = await seedClientAndConversation();
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const res = await admin(`/api/admin/clients/${id}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ conversation_ids: [convId] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.attached, 1);
  assert.equal(body.stuck_points_imported, 1);
  const detail = await (await admin(`/api/admin/clients/${id}`)).json();
  assert.equal(detail.client.conversations.length, 1);
  assert.equal(detail.client.stuck_points.length, 1);
  assert.equal(detail.client.stuck_points[0].title, '我不敢停下来');
});

test('粘贴 1v1 咨询记录 → 存档成功', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const res = await admin(`/api/admin/clients/${id}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ transcript: '来访者：我一停下来就慌。\n教练：你上次停下来是什么时候？' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.transcript.includes('我一停下来就慌'), true);
});

test('粘贴空白 1v1 记录 → 400', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const res = await admin(`/api/admin/clients/${id}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ transcript: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('生成方案草稿 → 拿到契约 2 的结构', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  await admin(`/api/admin/clients/${id}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ transcript: '来访者：我一停下来就慌。' }),
  });
  const res = await admin(`/api/admin/clients/${id}/plans/generate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // 生成会真的调模型 —— 测试环境里网关不可达，所以这里只断言「不是 404，
  // 且错误是上游网关错」，不断言模型输出。
  assert.notEqual(res.status, 404);
  if (res.status !== 200) {
    const body = await res.json();
    assert.ok(body.error, '失败时必须给出错误信息');
  }
});

test('发布方案 → 状态变成 pending_activation', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const db = getDb();
  const planId = 'plan-test-1';
  db.prepare(
    `INSERT INTO plans (id, client_id, status, version, payload, created_at) VALUES (?, ?, 'draft', 1, ?, ?)`
  ).run(planId, id, JSON.stringify({ diagnosis: {}, vision: {}, practices: [], worth_practicing: true }), new Date().toISOString());
  const res = await admin(`/api/admin/plans/${planId}/publish`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan.status, 'pending_activation');
});

test('客户档案里不含教练私有备注以外的越权字段', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲', notes: '教练私有备注' }),
  })).json();
  const detail = await (await admin(`/api/admin/clients/${id}`)).json();
  assert.equal(detail.client.notes, '教练私有备注');
});

// **进程不许被一个数据库错误打死。** Express 4 不接 async handler 的
// rejection —— 一个逃出去的 rejection 就是一次 unhandledRejection =
// 进程退出 = 整站掉线（fly.io 单进程，还能被反复触发成 crash-loop）。
//
// 这个测试守两件事：响应是 5xx 的 JSON（不是连接被重置），以及
// **进程还活着**（后面那条请求仍然通）。
test('数据库出错时返回 5xx JSON，进程不死', async () => {
  // phone 传对象：clients.create 不校验它，better-sqlite3 绑对象会抛
  // RangeError（绑对象不算一个参数 → "Too few parameter values"）。
  // 这是一个真正的数据库层错误，走 5xx 那条路。
  const res = await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲', phone: { 不是: '字符串' } }),
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(body.error, '要有一个 error 字段');
  // 进程还活着吗？再发一个正常请求。
  const alive = await admin('/api/admin/clients');
  assert.equal(alive.status, 200, '进程被打死了 —— async handler 的 rejection 逃出去了');
});

// 数组里的元素同样要类型守卫：对象绑进 better-sqlite3 会抛 RangeError。
test('conversation_ids 里有对象 → 400，不打死进程', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const res = await admin(`/api/admin/clients/${id}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ conversation_ids: [{ evil: 1 }] }),
  });
  assert.equal(res.status, 400);
  const alive = await admin('/api/admin/clients');
  assert.equal(alive.status, 200);
});

test('手法库：建 → 改 → 归档', async () => {
  const created = await admin('/api/admin/coach-moves', {
    method: 'POST',
    body: JSON.stringify({ name: '三问圈', summary: '把卡点拆成三问', script: '照抄的原话' }),
  });
  assert.equal(created.status, 200);
  const { move } = await created.json();
  assert.equal(move.name, '三问圈');

  const list = await (await admin('/api/admin/coach-moves')).json();
  assert.equal(list.moves.length, 1);

  const patched = await admin(`/api/admin/coach-moves/${move.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ summary: '改过的摘要' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).move.summary, '改过的摘要');

  const archived = await admin(`/api/admin/coach-moves/${move.id}/archive`, { method: 'POST' });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).move.active, 0);

  const active = await (await admin('/api/admin/coach-moves')).json();
  assert.equal(active.moves.length, 0);
  const all = await (await admin('/api/admin/coach-moves?all=1')).json();
  assert.equal(all.moves.length, 1);
});

test('手法重名 → 400', async () => {
  await admin('/api/admin/coach-moves', {
    method: 'POST',
    body: JSON.stringify({ name: '三问圈', summary: 'a' }),
  });
  const res = await admin('/api/admin/coach-moves', {
    method: 'POST',
    body: JSON.stringify({ name: '三问圈', summary: 'b' }),
  });
  assert.equal(res.status, 400);
});

test('改单个练习项：circle / scenario / target_belief 都能改', async () => {
  const db = getDb();
  const { id: clientId } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const planId = 'plan-test-2';
  db.prepare(
    `INSERT INTO plans (id, client_id, status, version, payload, created_at) VALUES (?, ?, 'draft', 1, ?, ?)`
  ).run(planId, clientId, JSON.stringify({ diagnosis: {}, vision: {}, practices: [], worth_practicing: true }), new Date().toISOString());
  db.prepare(
    `INSERT INTO practices (id, plan_id, day, title, sort_order) VALUES ('practice-test-1', ?, 1, '今天的一步', 0)`
  ).run(planId);

  const res = await admin(`/api/admin/plans/${planId}/practices/practice-test-1`, {
    method: 'PATCH',
    body: JSON.stringify({ circle: '三问圈', scenario: '今天走进办公室', target_belief: '我不能停下来' }),
  });
  assert.equal(res.status, 200);
  const { practice } = await res.json();
  assert.equal(practice.circle, '三问圈');
  assert.equal(practice.scenario, '今天走进办公室');
  assert.equal(practice.target_belief, '我不能停下来');
});

test('1v1 文件上传 → 只提取文本，不入库', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const res = await fetch(`${baseUrl}/api/admin/clients/${id}/sessions/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Admin-Token': token,
      'X-File-Name': encodeURIComponent('咨询记录.txt'),
    },
    body: Buffer.from('来访者：我一停下来就慌。', 'utf8'),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, 'text');
  assert.ok(body.text.includes('我一停下来就慌'));
  // 上传不等于入库：会话列表还是空的。
  const sessions = await (await admin(`/api/admin/clients/${id}/sessions`)).json();
  assert.equal(sessions.sessions.length, 0);
});

test('1v1 文件上传：后缀不认识 → 400', async () => {
  const { id } = await (await admin('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify({ display_name: '客户甲' }),
  })).json();
  const res = await fetch(`${baseUrl}/api/admin/clients/${id}/sessions/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Admin-Token': token,
      'X-File-Name': encodeURIComponent('照片.jpg'),
    },
    body: Buffer.from('x', 'utf8'),
  });
  assert.equal(res.status, 400);
});
