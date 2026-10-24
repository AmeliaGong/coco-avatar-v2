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

// Node 里**没有**全局的 AsyncFunction（那是浏览器的），从 async 函数的原型
// 上取它的构造器。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

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
//
// **必须是 async**：fn() 返回 Promise 时，finally 会在异步体完成**之前**
// 执行（同步的 finally 不会等 await）。那就等于「env 提前还原」——
// 现在恰好没出问题（构造在第一个 await 之前同步求值），但把构造挪到
// await 之后这条测试就会假失败或假通过，也就是「测试在骗人」。
async function withoutEnv(key, fn) {
  const saved = process.env[key];
  delete process.env[key];
  try {
    return await fn();
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

// 一个「不该被碰到」的假 db。
//
// 注意：工厂会在构造时 prepare 一次 SQL（闭包捕获），所以 prepare 本身
// 不能抛 —— 抛了的话错误会发生在**构造时**而不是请求时。
// 真正要断言的是：被拒绝的请求**根本没执行**任何 get()/run()。
function forbiddenDb() {
  const calls = { get: 0, run: 0 };
  return {
    calls,
    prepare() {
      return {
        get() {
          calls.get++;
          throw new Error('被拒绝的请求不应该查库');
        },
        run() {
          calls.run++;
          throw new Error('被拒绝的请求不应该写库');
        },
      };
    },
  };
}

test('requireAdmin：x-admin-token 不是字符串 → 401，不崩', async () => {
  const db = forbiddenDb();
  const mw = createRequireAdmin({ db });
  for (const bad of [{}, ['a'], 123, null]) {
    const result = await callMiddleware(mw, { headers: { 'x-admin-token': bad } });
    assert.equal(result.status, 401, `token=${JSON.stringify(bad)} 应该 401`);
    assert.deepEqual(result.body, { error: 'Unauthorized' });
    assert.equal(result.nextCalled, false, '拒绝时不能调 next()');
  }
  assert.equal(db.calls.get, 0, '被拒绝的请求不应该查库');
  assert.equal(db.calls.run, 0, '被拒绝的请求不应该写库');
});

test('requireAdmin：x-admin-token 超长 → 401', async () => {
  const db = forbiddenDb();
  const mw = createRequireAdmin({ db });
  const result = await callMiddleware(mw, {
    headers: { 'x-admin-token': 'x'.repeat(1000) },
  });
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'Unauthorized' });
  assert.equal(result.nextCalled, false, '拒绝时不能调 next()');
  assert.equal(db.calls.get, 0, '被拒绝的请求不应该查库');
  assert.equal(db.calls.run, 0, '被拒绝的请求不应该写库');
});

test('requireAdmin：拒绝时不调 next()（否则会 headers already sent）', async () => {
  const mw = createRequireAdmin({ db: getDb() });
  const result = await callMiddleware(mw, { headers: {} });
  assert.equal(result.status, 401);
  assert.equal(result.nextCalled, false);
});

// ----------------------------------------------------------------
// 五、expires_at 是坏值时必须 fail-closed（不能放行）
//
// 背景：`new Date('garbage')` 是 Invalid Date，而 `Invalid Date < new Date()`
// 恒为 false —— 不加守卫的话，一条 expires_at 损坏的记录会被**永久放行**，
// 而且永远不会被清理（启动/登录清理用的都是 expires_at < ? 的字符串比较）。
// ----------------------------------------------------------------

test('requireAdmin：expires_at 是坏值 → 401，且那条 session 被删掉', async () => {
  const db = getDb();
  const badValues = ['garbage', '', 'not-a-date', '2026-13-45T99:99:99Z'];
  for (const bad of badValues) {
    const token = `bad-expires-${bad || 'empty'}`;
    db.prepare(
      'INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)'
    ).run(token, new Date().toISOString(), bad);

    const res = await fetch(`${base}/api/admin/conversations`, {
      headers: { 'X-Admin-Token': token },
    });
    assert.equal(res.status, 401, `expires_at=${JSON.stringify(bad)} 应该 401`);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Unauthorized' });

    // 坏值也要走删除分支 —— 否则它就是一条永久凭据。
    const row = db
      .prepare('SELECT * FROM admin_sessions WHERE token = ?')
      .get(token);
    assert.equal(row, undefined, `expires_at=${JSON.stringify(bad)} 的 session 应该被删掉`);
  }
});

test('requireAdmin：expires_at 是 null / undefined → 401，且那条 session 被删掉', async () => {
  // expires_at 列是 NOT NULL，插不进 null —— 所以这一层用假 db 直接构造
  // 「库里那条记录的 expires_at 读出来是 null / undefined」的场景。
  for (const bad of [null, undefined]) {
    const calls = { run: 0 };
    const db = {
      prepare() {
        return {
          get: () => ({ token: 'x', created_at: 'x', expires_at: bad }),
          run: () => {
            calls.run++;
          },
        };
      },
    };
    const mw = createRequireAdmin({ db });
    const result = await callMiddleware(mw, {
      headers: { 'x-admin-token': 'some-token' },
    });
    assert.equal(result.status, 401, `expires_at=${bad} 应该 401`);
    assert.deepEqual(result.body, { error: 'Unauthorized' });
    assert.equal(result.nextCalled, false);
    assert.equal(calls.run, 1, `expires_at=${bad} 的 session 应该被删掉`);
  }
});

test('requireAdmin：expires_at 是合法的未来时间 → 200（别把正常的也毙掉）', async () => {
  const db = getDb();
  const token = 'valid-future-session';
  db.prepare(
    'INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)'
  ).run(token, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());

  const res = await fetch(`${base}/api/admin/conversations`, {
    headers: { 'X-Admin-Token': token },
  });
  assert.equal(res.status, 200);

  // 还没过期就不能删。
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  assert.ok(row, '没过期的 session 不应该被删掉');
});

// ----------------------------------------------------------------
// 六、Bearer 前缀校验必须**真的**被测试覆盖
//
// 关键构造：serviceToken = 'c123'，而 'Basic c123'.slice(7) === 'c123'。
// 所以一旦前缀判断被删掉，这些头就会被当成合法凭据放行（200）。
// ----------------------------------------------------------------

test('Bearer 前缀校验：切出来的 token 恰好等于配置值时也必须 401', async () => {
  const mw = createRequireInternal({ serviceToken: 'c123' });
  const headers = [
    'Basic c123', // slice(7) === 'c123' —— 删掉前缀判断就会 200
    'bearer c123',
    'BEARER c123',
    'BeArEr c123',
    'Bearer',
    'Bearer  c123', // 两个空格 → slice(7) === ' c123' → 长度不等 → 401
    'c123',
  ];
  await withTempApp(mw, async (url) => {
    for (const header of headers) {
      const res = await fetch(url, { headers: { Authorization: header } });
      assert.equal(res.status, 401, `Authorization: ${header} 应该 401`);
    }
  });
});

// ----------------------------------------------------------------
// 七、「中间件必须同步」这个不变量
//
// Express 4 **不捕获** async handler 抛出的 rejection → 未捕获 rejection
// → Node 默认 unhandledRejection = throw → **进程退出** → fly.io 单进程全站崩。
// 这就是 Task 8 抓过的同一类 bug。
// ----------------------------------------------------------------

test('两个中间件都不能是 async 函数', () => {
  const admin = createRequireAdmin({ db: forbiddenDb() });
  const internal = createRequireInternal({ serviceToken: 'x' });
  assert.ok(
    !(admin instanceof AsyncFunction),
    'requireAdmin 不能是 async：Express 4 不捕获 async 抛错 → 进程退出'
  );
  assert.ok(
    !(internal instanceof AsyncFunction),
    'requireInternal 不能是 async：Express 4 不捕获 async 抛错 → 进程退出'
  );
});

test('db 抛错 → 500（Express 捕获得到），进程存活', async () => {
  // get() 抛错 = 请求处理期间 db 出故障（表不存在 / 文件损坏 / SQLITE_BUSY）。
  const db = {
    prepare() {
      return {
        get() {
          throw new Error('模拟 db 故障');
        },
        run() {
          throw new Error('模拟 db 故障');
        },
      };
    },
  };
  const mw = createRequireAdmin({ db });

  let errorHandlerCalled = false;
  const app = express();
  app.get('/probe', mw, (req, res) => {
    res.json({ ok: true });
  });
  // 必须自己挂 error handler：否则 Express 默认错误处理器在测试环境
  // 会把堆栈吐到响应里。
  app.use((err, req, res, next) => {
    errorHandlerCalled = true;
    res.status(500).json({ error: 'Internal server error' });
  });

  const listener = app.listen(0);
  await new Promise((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });
  try {
    const { port } = listener.address();
    const res = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { 'X-Admin-Token': 'some-token' },
    });
    assert.equal(res.status, 500);
    assert.equal(errorHandlerCalled, true, '错误处理中间件应该被调用');
    // 能走到这里就说明进程没死（async 版本会在这里整个进程退出）。
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('db.prepare 抛错 → 工厂同步抛错（不是未捕获 rejection）', () => {
  const db = {
    prepare() {
      throw new Error('模拟表不存在');
    },
  };
  assert.throws(() => createRequireAdmin({ db }), /模拟表不存在/);
});
