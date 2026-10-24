import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';

test('测试库建在临时目录，不污染 data/coco.db', () => {
  assert.ok(process.env.DB_PATH.includes('coco-test-'), 'DB_PATH 未指向临时目录');
  const db = getDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(r => r.name);
  assert.ok(names.includes('conversations'));
  assert.ok(names.includes('messages'));
});
