// 库结构的两条路都要对：
//   - **新库**：走 db.js 的 initSchema 建表语句。
//   - **老库**（线上卷里已有的那些）：CREATE TABLE IF NOT EXISTS 不会改
//     结构，靠 migrateSchema 补列。
//
// 两条路补出来的列必须一模一样 —— 走错一条的表现是「我这条 SQL 在测试
// 库里跑得通，在线上库上炸」。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateSchema, getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).sort();
}

// 一份「改造前」的老库：只有最初的五张表、最初的列。
function createLegacyDb() {
  const file = path.join(os.tmpdir(), `coco-migrate-${randomUUID()}.db`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  return { db, file };
}

const EXPECTED_CONVERSATION_COLUMNS = [
  'client_id',
  'created_at',
  'expires_at',
  'id',
  'link_kind',
  'scenario',
  'status',
  'title',
];
const EXPECTED_MESSAGE_COLUMNS = [
  'conversation_id',
  'content',
  'created_at',
  'id',
  'role',
  'structured_json',
];
const EXPECTED_TOKEN_USAGE_COLUMNS = [
  'completion_tokens',
  'conversation_id',
  'created_at',
  'id',
  'prompt_tokens',
  'prompt_version',
  'scenario',
  'total_tokens',
];

test('老库跑一遍 migrateSchema 就补齐新列', () => {
  const { db, file } = createLegacyDb();
  try {
    migrateSchema(db);
    assert.deepEqual(columnNames(db, 'conversations'), EXPECTED_CONVERSATION_COLUMNS.slice().sort());
    assert.deepEqual(columnNames(db, 'messages'), EXPECTED_MESSAGE_COLUMNS.slice().sort());
    assert.deepEqual(columnNames(db, 'token_usage'), EXPECTED_TOKEN_USAGE_COLUMNS.slice().sort());
  } finally {
    db.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  }
});

test('migrateSchema 可以重复执行（启动时每次都会跑）', () => {
  const { db, file } = createLegacyDb();
  try {
    migrateSchema(db);
    migrateSchema(db);
    assert.deepEqual(columnNames(db, 'conversations'), EXPECTED_CONVERSATION_COLUMNS.slice().sort());
  } finally {
    db.close();
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

// ---------------------------------------------------------------------------
// 并发 ALTER 的竞态
//
// PRAGMA table_info → ALTER TABLE ADD COLUMN 是 check-then-act，
// **不是**跨进程原子的。fly 的滚动部署可能短暂有两个机器同时对着
// 同一个卷跑迁移：两边都看到「这列还没有」，都去 ADD COLUMN，
// **输掉**的那一个拿到 SQLite 的 `duplicate column name: xxx`。
//
// 那恰恰是想要的结果（列已经被另一个进程加上了）。所以 migrateSchema
// 必须把它当成成功继续 —— 否则 getDb() 抛错 → server.js 的模块级
// `const db = getDb()` 在 listen 之前就抛 → 进程退出 → crash loop。
// ---------------------------------------------------------------------------

// 一个「只会把某一条 ALTER 打成 duplicate column name」的假 db。
//
// 用的错误对象是 better-sqlite3 真的从 SQLite 抛出来的那一个
// （SqliteError，code === 'SQLITE_ERROR'），不是自己拼的字面量 ——
// 判据必须对着真实错误对象成立。
function withDuplicateColumnOn(db, table, column) {
  const needle = `ALTER TABLE ${table} ADD COLUMN ${column}`;
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (typeof sql === 'string' && sql.includes(needle)) {
      const err = new Error(`duplicate column name: ${column}`);
      err.name = 'SqliteError';
      err.code = 'SQLITE_ERROR';
      throw err;
    }
    return realExec(sql);
  };
  return db;
}

test('并发 ALTER 撞车（duplicate column name）→ 当成成功，继续补剩下的列', () => {
  const { db, file } = createLegacyDb();
  try {
    // 模拟：我们在 conversations.client_id 这一步输了竞态。
    withDuplicateColumnOn(db, 'conversations', 'client_id');
    assert.doesNotThrow(() => migrateSchema(db), 'duplicate column 不该让启动崩掉');
    // 关键：不是「整段跳过」—— 后面的列照样补上了。
    assert.deepEqual(columnNames(db, 'messages'), EXPECTED_MESSAGE_COLUMNS.slice().sort());
    assert.deepEqual(columnNames(db, 'token_usage'), EXPECTED_TOKEN_USAGE_COLUMNS.slice().sort());
    // conversations 里除了 client_id（我们输掉的那一步）之外都补齐了
    assert.deepEqual(
      columnNames(db, 'conversations').filter(c => c !== 'client_id'),
      EXPECTED_CONVERSATION_COLUMNS.slice().sort().filter(c => c !== 'client_id')
    );
  } finally {
    db.close();
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

test('ALTER 真的失败（不是 duplicate column）→ 照旧抛错，且带中文说明', () => {
  // 两种「真的失败」，都要照旧抛出去：
  //   1. code 是 SQLITE_READONLY（只读卷）—— code 就不是 SQLITE_ERROR；
  //   2. code 是 SQLITE_ERROR，但 message 是别的东西（磁盘 I/O 之类）——
  //      code 对上了，**message 对不上**。
  // 第 2 种才是真正在钉「不能只看 code 就放行」。
  const cases = [
    { code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' },
    { code: 'SQLITE_ERROR', message: 'disk I/O error' },
  ];
  for (const { code, message } of cases) {
    const { db, file } = createLegacyDb();
    try {
      const realExec = db.exec.bind(db);
      db.exec = (sql) => {
        if (typeof sql === 'string' && sql.includes('ALTER TABLE')) {
          const err = new Error(message);
          err.name = 'SqliteError';
          err.code = code;
          throw err;
        }
        return realExec(sql);
      };
      assert.throws(
        () => migrateSchema(db),
        (err) => {
          assert.match(err.message, /migrateSchema/);
          assert.match(err.message, /conversations/);
          assert.match(err.message, /client_id/);
          assert.match(err.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        },
        `${code} / ${message} 应当照旧抛错`
      );
    } finally {
      db.close();
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  }
});

test('老库补出来的列有正确的默认值（scenario 默认 chat）', () => {
  const { db, file } = createLegacyDb();
  try {
    migrateSchema(db);
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, ?)'
    ).run('c1', null, new Date().toISOString(), 'active');
    const row = db.prepare('SELECT scenario, link_kind FROM conversations WHERE id = ?').get('c1');
    assert.equal(row.scenario, 'chat');
    assert.equal(row.link_kind, 'test');
  } finally {
    db.close();
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

test('新库（建表语句那条路）的列与老库补列后完全一致', () => {
  const db = getDb();
  assert.deepEqual(columnNames(db, 'conversations'), EXPECTED_CONVERSATION_COLUMNS.slice().sort());
  assert.deepEqual(columnNames(db, 'messages'), EXPECTED_MESSAGE_COLUMNS.slice().sort());
  assert.deepEqual(columnNames(db, 'token_usage'), EXPECTED_TOKEN_USAGE_COLUMNS.slice().sort());
});

test('表还不存在时，migrateSchema 的报错要说明「先建表」', () => {
  // 干巴巴一句 "no such table: conversations" 看不出该怎么办。
  const file = path.join(os.tmpdir(), `coco-empty-${randomUUID()}.db`);
  const db = new Database(file);
  try {
    assert.throws(
      () => migrateSchema(db),
      (err) => {
        assert.match(err.message, /conversations/);
        assert.match(err.message, /先跑 initSchema/);
        return true;
      }
    );
  } finally {
    db.close();
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

test('resetDb 中途抛错时，外键仍然被恢复成 ON', () => {
  // resetDb 里那对 pragma 必须成对（try/finally）：中间任何一条 DELETE
  // 抛错，外键就永久停在 OFF —— 同进程后面的测试全都跑在一个「外键没开」
  // 的库上，而且没人看得出为什么。
  const db = getDb();
  // 先造一行消息 —— 触发器是逐行触发的，表空着就不会触发。
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, ?)'
  ).run('c-reset', null, new Date().toISOString(), 'active');
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run('c-reset', 'user', '你好', new Date().toISOString());
  db.exec(`
    CREATE TRIGGER block_messages_delete
    BEFORE DELETE ON messages
    BEGIN
      SELECT RAISE(ABORT, 'delete blocked by test');
    END;
  `);
  try {
    assert.throws(() => resetDb(), /delete blocked by test/);
    // 关键断言：抛错之后外键仍然是开着的
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_messages_delete');
    resetDb();
  }
});

test('外键检查是开着的：给不存在的会话插消息会被拒绝', () => {
  // 路由里曾经有一对「临时关掉外键检查」的 pragma。现在没有了 ——
  // 外键必须一直开着，而且要能证明它确实开着。
  const db = getDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  try {
    assert.throws(
      () => {
        db.prepare(
          'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
        ).run('no-such-conversation', 'user', '你好', new Date().toISOString());
      },
      /FOREIGN KEY/
    );
  } finally {
    // 万一外键没开（实现坏了），把插进去的脏行清掉，别污染后面的测试。
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run('no-such-conversation');
  }
});
