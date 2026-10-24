// 鉴权中间件（server/auth.js）的测试。
//
// 两套鉴权是**故意分开**的，不要合并：
//   - admin（网页后台）：X-Admin-Token，随机 session token，**落库**到
//     admin_sessions 表，24 小时过期。
//   - internal（服务间）：Authorization: Bearer <token>，固定的服务间密钥，
//     **不落库**，只在环境变量里，用定长比较（timingSafeEqual）比对。
import './helpers/testEnv.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequireAdmin, createRequireInternal } from '../server/auth.js';
import { getDb } from '../db.js';
import { createServer } from './helpers/testServer.js';
import { resetDb } from './helpers/testDb.js';

// 共享 app（server.js 里的那个）：用来测真实的挂载方式。
let server;
let base;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server?.close());

beforeEach(() => resetDb());

// 临时的小 Express app：把中间件挂上去单独测边界情况，
// 不去改 server.js 的挂载方式。
async function withTempApp(middleware, fn) {
  const app = express();
  app.get('/probe', middleware, (req, res) => {
    res.json({ ok: true });
  });
  const listener = app.listen(0);
  await new Promise((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });
  const { port } = listener.address();
  try {
    return await fn(`http://127.0.0.1:${port}/probe`);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

// 直接调用中间件（不经过 HTTP）：用来断言「拒绝时没有调 next()」，
// 以及塞一些 HTTP 层造不出来的畸形 req（比如 headers 里塞对象）。
function callMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    let nextCalled = false;
    let settled = false;
    const res = {
      statusCode: null,
      payload: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.payload = body;
        setTimeout(finish, 0);
        return this;
      },
    };
    // 延迟一拍再收尾：这样「既写了响应又调了 next()」这种 bug 也能被看见。
    function finish() {
      if (settled) return;
      settled = true;
      resolve({ status: res.statusCode, body: res.payload, nextCalled });
    }
    try {
      middleware(req, res, () => {
        nextCalled = true;
        setTimeout(finish, 0);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// 临时改环境变量并还原。
function withoutEnv(key, fn) {
  const saved = process.env[key];
  delete process.env[key];
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

// ----------------------------------------------------------------
// 一、内部接口基线（走共享 app 的真实挂载）
// ----------------------------------------------------------------

test('内部接口：没带 token → 401', async () => {
  const res = await fetch(`${base}/api/internal/ping`);
  assert.equal(res.status, 401);
});

test('内部接口：token 错误 → 401', async () => {
  const res = await fetch(`${base}/api/internal/ping`, {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(res.status, 401);
});

test('内部接口：token 正确 → 200 + { ok: true }', async () => {
  const res = await fetch(`${base}/api/internal/ping`, {
    headers: { Authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

// ----------------------------------------------------------------
// 二、createRequireInternal 的边界情况
// ----------------------------------------------------------------

test('服务端没配 token → 503（配置缺失，不是鉴权失败）', async () => {
  await withoutEnv('INTERNAL_SERVICE_TOKEN', async () => {
    await withTempApp(createRequireInternal({ serviceToken: '' }), async (url) => {
      const res = await fetch(url);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.deepEqual(body, { error: 'INTERNAL_SERVICE_TOKEN not configured' });
    });
  });
});

test('长度不同的 token → 401，不崩（timingSafeEqual 长度不等会抛 RangeError）', async () => {
  await withTempApp(createRequireInternal({ serviceToken: 'short' }), async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer wrong-length-but-not-equal' },
    });
    assert.equal(res.status, 401);
  });
});

test('长度相同但内容不对的 token → 401（真正走完定长比较）', async () => {
  await withTempApp(createRequireInternal({ serviceToken: 'abcdefgh' }), async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer abcdefgi' },
    });
    assert.equal(res.status, 401);
  });
});

test('Authorization 不是 Bearer 前缀 → 401', async () => {
  const cases = ['Basic abc', 'Bearer', 'bearer abc', 'test-internal-token'];
  await withTempApp(createRequireInternal({ serviceToken: 'test-internal-token' }), async (url) => {
    for (const header of cases) {
      const res = await fetch(url, { headers: { Authorization: header } });
      assert.equal(res.status, 401, `Authorization: ${header} 应该 401`);
    }
  });
});

test('Bearer 后面是空字符串 → 401', async () => {
  await withTempApp(createRequireInternal({ serviceToken: 'test-internal-token' }), async (url) => {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' } });
    assert.equal(res.status, 401);
  });
});

test('serviceToken 不是字符串 → 503，不崩（Buffer.from(对象) 会抛）', async () => {
  const mw = createRequireInternal({ serviceToken: {} });
  await withTempApp(mw, async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer test-internal-token' },
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { error: 'INTERNAL_SERVICE_TOKEN not configured' });
  });
});

test('expected 在构造时取一次：构造后改环境变量，实例行为不变', async () => {
  const saved = process.env.INTERNAL_SERVICE_TOKEN;
  process.env.INTERNAL_SERVICE_TOKEN = 'token-at-construction';
  try {
    const mw = createRequireInternal();
    // 构造之后才改环境变量 —— 已构造的实例不应该跟着变。
    process.env.INTERNAL_SERVICE_TOKEN = 'token-changed-after-construction';

    await withTempApp(mw, async (url) => {
      const ok = await fetch(url, {
        headers: { Authorization: 'Bearer token-at-construction' },
      });
      assert.equal(ok.status, 200);

      const changed = await fetch(url, {
        headers: { Authorization: 'Bearer token-changed-after-construction' },
      });
      assert.equal(changed.status, 401);
    });
  } finally {
    if (saved === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = saved;
  }
});

// ----------------------------------------------------------------
// 三、requireAdmin：迁出后行为不变
// ----------------------------------------------------------------

async function login() {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token, '登录应该返回 token');
  return body.token;
}

test('requireAdmin：有效的 session token → 200', async () => {
  const token = await login();
  const res = await fetch(`${base}/api/admin/conversations`, {
    headers: { 'X-Admin-Token': token },
  });
  assert.equal(res.status, 200);
});

test('requireAdmin：无效 token → 401 + { error: Unauthorized }', async () => {
  const res = await fetch(`${base}/api/admin/conversations`, {
    headers: { 'X-Admin-Token': 'not-a-real-session-token' },
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Unauthorized' });
});

test('requireAdmin：过期的 session → 401，且那条记录被删掉', async () => {
  const db = getDb();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)'
  ).run('expired-session-token', past, past);

  const res = await fetch(`${base}/api/admin/conversations`, {
    headers: { 'X-Admin-Token': 'expired-session-token' },
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Unauthorized' });

  // 过期会话必须**被删掉**，不只是被拒绝。
  const row = db
    .prepare('SELECT * FROM admin_sessions WHERE token = ?')
    .get('expired-session-token');
  assert.equal(row, undefined, '过期 session 应该从 admin_sessions 表里被删掉');
});

// ----------------------------------------------------------------
// 四、类型/长度守卫：畸形输入不能把服务打挂
// ----------------------------------------------------------------

// 一个一碰就炸的假 db：用来断言「被拒绝的请求根本没走到数据库」。
function explodingDb() {
  return {
    prepare() {
      throw new Error('被拒绝的请求不应该查库');
    },
  };
}

test('requireAdmin：x-admin-token 不是字符串 → 401，不崩', async () => {
  const mw = createRequireAdmin({ db: explodingDb() });
  for (const bad of [{}, ['a'], 123, null]) {
    const result = await callMiddleware(mw, { headers: { 'x-admin-token': bad } });
    assert.equal(result.status, 401, `token=${JSON.stringify(bad)} 应该 401`);
    assert.deepEqual(result.body, { error: 'Unauthorized' });
    assert.equal(result.nextCalled, false, '拒绝时不能调 next()');
  }
});

test('requireAdmin：x-admin-token 超长 → 401', async () => {
  const mw = createRequireAdmin({ db: explodingDb() });
  const result = await callMiddleware(mw, {
    headers: { 'x-admin-token': 'x'.repeat(1000) },
  });
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'Unauthorized' });
  assert.equal(result.nextCalled, false, '拒绝时不能调 next()');
});

test('requireAdmin：拒绝时不调 next()（否则会 headers already sent）', async () => {
  const mw = createRequireAdmin({ db: getDb() });
  const result = await callMiddleware(mw, { headers: {} });
  assert.equal(result.status, 401);
  assert.equal(result.nextCalled, false);
});
