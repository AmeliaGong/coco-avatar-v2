// 必须是第一个 import：保证 db.js 求值前 DB_PATH 已指向隔离的临时库。
import './testEnv.js';
import { getDb, DB_PATH } from '../../db.js';

// 硬性隔离断言：万一 testEnv.js 没生效，绝不允许操作开发者的真实 data/coco.db。
// 两处都要查：process.env 是环境变量，而 db.js 在模块作用域捕获的是自己的 DB_PATH
// 常量 —— 若 db.js 早于 testEnv.js 求值，两者会指向不同的库。
if (!process.env.DB_PATH?.includes('coco-test-')) {
  throw new Error('测试库未隔离，DB_PATH=' + process.env.DB_PATH);
}
if (!DB_PATH?.includes('coco-test-')) {
  throw new Error('测试库未隔离，db.js 解析到的库路径=' + DB_PATH);
}
// 两个来源必须指向同一个库：db.js 在模块作用域捕获 DB_PATH，
// 若它比 testEnv.js 更早求值，两边会指向不同的库 —— 只查 env 会漏掉这种情况。
if (process.env.DB_PATH !== DB_PATH) {
  throw new Error(
    '测试库未隔离：process.env.DB_PATH 与 db.js 解析到的库路径不一致\n' +
      `  env: ${process.env.DB_PATH}\n  db.js: ${DB_PATH}`
  );
}

export function resetDb() {
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  // 运行时从 sqlite_master 读取表清单，避免后续任务新增表时漏清。
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const t of tables) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  // sqlite_sequence 被上面的 NOT LIKE 过滤掉了，单独清空，让 AUTOINCREMENT id 重新从 1 开始。
  const hasSeq = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
    .all();
  if (hasSeq.length > 0) {
    db.prepare('DELETE FROM sqlite_sequence').run();
  }
  db.pragma('foreign_keys = ON');
}
