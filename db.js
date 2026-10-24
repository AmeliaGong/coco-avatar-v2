import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'coco.db');

// 导出解析后的库路径，供测试隔离断言校验（见 tests/helpers/testDb.js）。
// 生产行为不变：DB_PATH 仍在模块作用域捕获一次。
export { DB_PATH };

let db;

export function getDb() {
  if (!db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT DEFAULT 'active',
      client_id TEXT,
      scenario TEXT DEFAULT 'chat',
      link_kind TEXT DEFAULT 'test'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      structured_json TEXT
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_at TEXT NOT NULL,
      scenario TEXT,
      prompt_version TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
      ON token_usage(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_created
      ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_status
      ON conversations(status);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      is_coco INTEGER DEFAULT 0,
      avatar TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_scenarios (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_scenarios_active
      ON prompt_scenarios(id, is_active);
  `);

  // 建表语句只对**新建**的库生效；线上卷里的旧表不会因为
  // CREATE TABLE IF NOT EXISTS 而长出新列 —— 靠这里补。
  migrateSchema(db);
}

// CREATE TABLE IF NOT EXISTS 对已存在的表不会改结构，
// 所以线上卷里的旧表需要靠这里补列。
//
// 新库走 initSchema 的建表语句，老库走这里 —— 两条路都要对。
// 每列都先查一遍再补：重复执行是安全的（启动时每次都会跑）。
export function migrateSchema(db) {
  const additions = [
    ['conversations', 'client_id', 'TEXT'],
    ['conversations', 'scenario', "TEXT DEFAULT 'chat'"],
    ['conversations', 'link_kind', "TEXT DEFAULT 'test'"],
    ['messages', 'structured_json', 'TEXT'],
    ['token_usage', 'scenario', 'TEXT'],
    ['token_usage', 'prompt_version', 'TEXT'],
  ];
  for (const [table, column, type] of additions) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
