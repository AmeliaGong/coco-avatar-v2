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

    -- ── 交付模块的新表 ────────────────────────────────────────────
    --
    -- 这些表都还没上线过，所以直接改 CREATE TABLE 即可，不需要迁移脚本
    -- （CREATE TABLE IF NOT EXISTS 对所有库都生效，旧库也会被补出缺的新表）。
    -- 形状取自计划的最终版：Task 1 的六张表 + 增补 B.1 的轮次/来源列 +
    -- 增补 D.0.2 的「圈 / 情景 / 靶子」+ 增补 D.2 的教练手法库 +
    -- 增补 B.1 的交付项目表 journeys（它没有对外的 store，依赖的是这张表）。

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      source TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'nomad_era'
      external_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'archived'
      notes TEXT,                              -- 教练私有备注，永不下发给用户端
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stuck_points (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id),
      source TEXT NOT NULL,                    -- 'chat' | 'manual' | 'extracted'
      title TEXT NOT NULL,
      belief TEXT,
      evidence_against TEXT,                   -- JSON array
      emotion TEXT,
      micro_action TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions_1v1 (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      transcript TEXT NOT NULL,
      source TEXT,                             -- 'manual_paste' | 'whisper'
      -- 下面几列是增补 B 加的：一次真人咨询有来源、日期、时长，
      -- 还要知道它是为了哪个交付项目做的。
      source_type TEXT NOT NULL DEFAULT 'paste', -- 'paste'|'feishu_link'|'recording_transcript'
      source_url TEXT,                          -- 飞书文档链接 / 腾讯视频链接
      occurred_at TEXT,                         -- 咨询发生的时间
      duration_minutes INTEGER,                -- 1 小时 = 60
      journey_id TEXT,                          -- 这次咨询服务于哪个交付项目
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      stuck_point_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',    -- 'draft'|'pending_activation'|'active'|'archived'
      version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,                   -- 契约 2 的 JSON（内容真相源）
      diagnosis_md TEXT,                       -- 教练手写补充
      -- 下面几列是增补 B 加的：诊断会做很多轮，一轮改一版。
      round INTEGER NOT NULL DEFAULT 1,        -- 第几轮诊断（1v1 之后会是第 2 轮）
      supersedes_id TEXT,                      -- 这一轮取代哪一份旧方案
      source_session_id TEXT,                  -- 这一轮是基于哪一次 1v1 做的
      journey_id TEXT,                         -- 这一轮是为哪个交付项目做的
      mode TEXT NOT NULL DEFAULT 'sequence',   -- 'sequence'|'daily_repeat'
      repeat_days INTEGER,                     -- mode='daily_repeat' 时：同一个圈跑几天
      created_at TEXT NOT NULL,
      published_at TEXT,
      activated_at TEXT,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS practices (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      day INTEGER,
      title TEXT NOT NULL,
      intent TEXT,
      action TEXT,
      evidence_prompt TEXT,
      success_criteria TEXT,
      circle TEXT,                            -- 用的是哪个圈（教练手法库的一条）
      scenario TEXT,                          -- 这一天切入的具体情景
      target_belief TEXT,                     -- 这一天针对的外周信念名
      custom_data TEXT,                       -- 教练手工补充的个性化数据（契约 2 的 D5）
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS evidences (
      id TEXT PRIMARY KEY,
      practice_id TEXT NOT NULL REFERENCES practices(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      content TEXT NOT NULL,
      occurred_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coach_moves (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,                     -- 圈/手法的名字，唯一
      summary TEXT NOT NULL,                  -- 一句话：这一手在干什么
      when_to_use TEXT,                       -- 适用情景
      script TEXT,                            -- 教练的原话脚本
      targets TEXT,                           -- JSON array：它打的是哪类信念
      tags TEXT,                              -- JSON array
      active INTEGER NOT NULL DEFAULT 1,      -- 0 = 归档（不物理删：方案里引用过它）
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 交付项目：教练在外部平台（workbuddy 等）做出来、发给来访者的东西。
    --
    -- **为什么要单独一张表，而不是塞进 plans：** 交付物和诊断方案是两种东西。
    -- 方案是我们系统里生成的、逐条可回填的；交付物是教练手工做的一份完整文档
    -- （游学手册、练习稿），它的正文在外部平台上，**我们只做留档**。
    --
    -- **为什么要存 snapshot_md：** 外部平台的链接是**可变的** —— 同一个 URL 会被
    -- 覆盖成新一版。只存 URL 等于什么都没存。
    CREATE TABLE IF NOT EXISTS journeys (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      title TEXT NOT NULL,                    -- '5 天大理游学' / '14 天核心信念练习'
      kind TEXT NOT NULL DEFAULT 'other',     -- 'study_tour'|'practice_program'|'other'
      source TEXT NOT NULL DEFAULT 'workbuddy', -- 'workbuddy'|'manual'
      url TEXT,                               -- 外部链接（可空）
      snapshot_md TEXT,                       -- 内容快照（留档用，链接会变）
      status TEXT NOT NULL DEFAULT 'active',  -- 'planned'|'active'|'completed'|'archived'
      phase_note TEXT,                        -- '第一阶段：入住 WeStream 空间'
      started_at TEXT,
      ended_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_external
      ON clients(external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stuck_points_client ON stuck_points(client_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_1v1_client ON sessions_1v1(client_id);
    CREATE INDEX IF NOT EXISTS idx_plans_client ON plans(client_id);
    CREATE INDEX IF NOT EXISTS idx_practices_plan ON practices(plan_id);
    CREATE INDEX IF NOT EXISTS idx_evidences_practice ON evidences(practice_id);
    CREATE INDEX IF NOT EXISTS idx_evidences_client ON evidences(client_id);
    CREATE INDEX IF NOT EXISTS idx_journeys_client ON journeys(client_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_moves_name ON coach_moves(name);
    CREATE INDEX IF NOT EXISTS idx_coach_moves_active ON coach_moves(active);
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
