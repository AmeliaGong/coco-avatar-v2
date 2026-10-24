import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, DB_PATH } from '../db.js';

test('测试库建在临时目录，不污染 data/coco.db', () => {
  // 断言 db.js 实际解析到的路径，而不是 process.env —— 后者即使 db.js
  // 早于 testEnv.js 求值、解析到了真实库也依然是「对」的值，会给出假的安全感。
  assert.ok(DB_PATH.includes('coco-test-'), `db.js 解析到的库路径未指向临时目录: ${DB_PATH}`);
  assert.equal(process.env.DB_PATH, DB_PATH, 'env 与 db.js 解析到的库路径不一致');
  const db = getDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(r => r.name);
  assert.ok(names.includes('conversations'));
  assert.ok(names.includes('messages'));
});
