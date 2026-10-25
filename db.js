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

    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      source_url TEXT,
      embedding TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_entries(kind);
  `);

  // 建表语句里的 CREATE TABLE IF NOT EXISTS 对**所有**库都生效 —— 新库建出
  // 全部表，旧库也会把**缺的新表**补出来（比如 knowledge_entries）。
  // 但它**不会改已存在的表结构**：线上卷里的旧表不会长出新列 —— 那靠这里补。
  // 所以：新表不需要进 migrateSchema；给旧表**加列**才需要。
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
    // PRAGMA table_info 对**不存在的表不报错**，只是返回空数组 ——
    // 所以「表压根不存在」得自己看出来（否则下一步的 ALTER TABLE 会抛一句
    // 干巴巴的 "no such table: xxx"，看不出该怎么办）。
    if (!cols.length) {
      throw new Error(
        `migrateSchema：表 ${table} 不存在 —— 先跑 initSchema 建表，再补列`
      );
    }
    if (!cols.some(c => c.name === column)) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (err) {
        // 并发 ALTER 的竞态：check-then-act 不是原子的。
        //
        // fly 的滚动部署可能短暂有两个机器同时对着同一个卷跑迁移：
        // 两边都看到「这列还没有」，都去 ADD COLUMN，**输的那个**拿到
        // SQLite 的 `duplicate column name: xxx`。
        //
        // 那恰恰是我们想要的结果（列已经存在了）—— 所以当成成功继续，
        // 而不是抛错。抛错的话 getDb() 会抛，server.js 的模块级
        // `const db = getDb()` 会在 listen 之前就抛 → 进程退出 →
        // crash loop → 整站不可用。
        //
        // 判据用 better-sqlite3 抛出来的**错误对象**（code === 'SQLITE_ERROR'
        // 且 message 含 'duplicate column name'），不是自己拼的字符串 ——
        // 其它任何失败（磁盘满、只读卷、表损坏）都必须照旧抛出去。
        if (isDuplicateColumnError(err)) {
          continue;
        }
        throw new Error(
          `migrateSchema：给 ${table} 补列 ${column} 失败（${
            err && err.message ? err.message : err
          }）`
        );
      }
    }
  }
}

// 「这列已经存在了」—— 也就是并发 ALTER 时我们**输掉**的那一次。
//
// better-sqlite3 把 SQLite 的错误原样抛出来：一个 SqliteError，
// `code === 'SQLITE_ERROR'`，`message` 形如
// `duplicate column name: client_id`。
//
// 两个条件都要满足才认：
//   - code === 'SQLITE_ERROR'：确认它真的是 SQLite 抛的，不是别处伪造的；
//   - message 里含 'duplicate column name'：确认是「列已存在」这一种，
//     而不是别的 SQLITE_ERROR（比如只读卷上的 "attempt to write a readonly database"）。
//
// 任何其它错误都必须照旧抛出 —— 把启动期的硬失败变成静默跳过，
// 只会让「迁移没生效」这件事更难查。
function isDuplicateColumnError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'SQLITE_ERROR') return false;
  const message = typeof err.message === 'string' ? err.message : '';
  return message.includes('duplicate column name');
}
