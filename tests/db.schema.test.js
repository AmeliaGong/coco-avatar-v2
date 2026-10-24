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
