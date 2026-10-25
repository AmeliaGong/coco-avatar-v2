// 契约 4：内部接口的主体标识是 `external_id`，归属校验在 Coco Avatar 侧。
//
// 这个测试要证明的东西只有一件：**「外部主体 → 内部客户」的解析是唯一且
// fail-closed 的**。业务逻辑（读方案、算进度）不在这里测 —— 那是
// userService.js 的事，与本契约无关。
//
// ⚠️ `clients` 表在本分支（底座分支）还没有 —— 它是交付线加的。这里按
// **设计规格 §5.1 的原样**建表，与交付线 db.js 里的建表语句逐列一致，
// 所以这个测试在底座分支与交付线分支上都能跑（表已存在时 CREATE TABLE
// IF NOT EXISTS 是空操作）。

// ⚠️ 必须先 import testEnv：它把 DB_PATH 指到临时目录。
// 不 import 的话，getDb() 会连到**真实的开发库**（data/coco.db）——
// 这个测试里有 DELETE FROM clients，在真实库上跑会撞外键、也会把
// 真实数据删掉。
import './helpers/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import {
  createClientIdentityResolver,
  createExternalSubjectResolver,
} from '../server/delivery/identity.js';

const db = getDb();

function ensureClientsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_external
      ON clients(external_id) WHERE external_id IS NOT NULL;
  `);
}

function insertClient({ id, displayName, externalId, source = 'nomad_era' }) {
  db.prepare(
    `INSERT INTO clients (id, display_name, source, external_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z')`
  ).run(id, displayName, source, externalId ?? null);
}

function clearClients() {
  db.exec('DELETE FROM clients');
}

test.before(() => {
  ensureClientsTable();
});

test('external_id 能解析出 client_id', () => {
  clearClients();
  insertClient({ id: 'client-1', displayName: '客户一', externalId: 'nomad-user-1' });

  const { resolveClientId } = createClientIdentityResolver({ db });
  assert.equal(resolveClientId('nomad-user-1'), 'client-1');
});

test('查不到 external_id 时返回 null（不是抛错）—— 「尚无交付」是正常状态', () => {
  clearClients();
  insertClient({ id: 'client-1', displayName: '客户一', externalId: 'nomad-user-1' });

  const { resolveClientId } = createClientIdentityResolver({ db });
  assert.equal(resolveClientId('nomad-user-不存在'), null);
});

test('external_id 为 NULL 的客户（教练手工建档）解析不到 —— 它没有外部身份', () => {
  clearClients();
  insertClient({ id: 'manual-1', displayName: '手工建档', externalId: null, source: 'manual' });

  const { resolveClientId } = createClientIdentityResolver({ db });
  // 传 null / 空串 / 非字符串都解析不到，且不抛错。
  assert.equal(resolveClientId(null), null);
  assert.equal(resolveClientId(''), null);
  assert.equal(resolveClientId(undefined), null);
  assert.equal(resolveClientId(123), null);
});

test('fail-closed：把 client_id 塞进 external_id 槽位解析不到人', () => {
  clearClients();
  insertClient({ id: 'client-1', displayName: '客户一', externalId: 'nomad-user-1' });

  const { resolveClientId } = createClientIdentityResolver({ db });
  // 内部 UUID 不出 Coco Avatar —— 就算有人拿它来打这个接口，也查不到。
  assert.equal(resolveClientId('client-1'), null);
});

test('external_id 唯一 —— 同一 external_id 不会有第二个客户', () => {
  clearClients();
  insertClient({ id: 'client-1', displayName: '客户一', externalId: 'nomad-user-1' });

  assert.throws(
    () => insertClient({ id: 'client-2', displayName: '客户二', externalId: 'nomad-user-1' }),
    /UNIQUE|constraint/i
  );

  const { resolveClientId } = createClientIdentityResolver({ db });
  assert.equal(resolveClientId('nomad-user-1'), 'client-1');
});

test('中间件：解析成功时把 client_id 挂到 req.clientId', () => {
  clearClients();
  insertClient({ id: 'client-1', displayName: '客户一', externalId: 'nomad-user-1' });

  const middleware = createExternalSubjectResolver({ db });
  const req = { params: { externalId: 'nomad-user-1' } };
  let nextCalled = false;
  middleware(req, { status() { throw new Error('不该走到错误分支'); }, json() { throw new Error('不该走到错误分支'); } }, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.clientId, 'client-1');
  assert.equal(req.externalId, 'nomad-user-1');
});

test('中间件：解析不到就 404 + 固定文案「还没有交付记录」', () => {
  clearClients();
  insertClient({ id: 'client-1', displayName: '客户一', externalId: 'nomad-user-1' });

  const middleware = createExternalSubjectResolver({ db });
  const req = { params: { externalId: 'nomad-user-不存在' } };
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  middleware(req, { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } }, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, '解析不到时不该调 next（否则会落到读方案的 handler）');
  assert.equal(statusCode, 404);
  assert.deepEqual(body, { error: '还没有交付记录' });
});

test('中间件：没有 externalId 参数时也 404，不放行', () => {
  clearClients();

  const middleware = createExternalSubjectResolver({ db });
  const req = { params: {} };
  let statusCode = null;
  let nextCalled = false;
  middleware(req, { status(c) { statusCode = c; return this; }, json() { return this; } }, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 404);
});
