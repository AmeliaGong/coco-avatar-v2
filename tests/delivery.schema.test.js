import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';

// 列的形状取计划的**最终版**：Task 1 的六张表 + 增补 B.1 的轮次/来源列
// + 增补 D.0.2 的「圈 / 情景 / 靶子」+ 增补 D.2 的教练手法库。
const EXPECTED_COLUMNS = {
  clients: ['id', 'display_name', 'phone', 'email', 'source', 'external_id', 'status', 'notes', 'created_at', 'updated_at'],
  stuck_points: ['id', 'client_id', 'source', 'title', 'belief', 'evidence_against', 'emotion', 'micro_action', 'raw_json', 'created_at'],
  sessions_1v1: ['id', 'client_id', 'transcript', 'source', 'source_type', 'source_url', 'occurred_at', 'duration_minutes', 'journey_id', 'created_at'],
  plans: ['id', 'client_id', 'stuck_point_id', 'status', 'version', 'payload', 'diagnosis_md', 'round', 'supersedes_id', 'source_session_id', 'journey_id', 'mode', 'repeat_days', 'created_at', 'published_at', 'activated_at', 'archived_at'],
  practices: ['id', 'plan_id', 'day', 'title', 'intent', 'action', 'evidence_prompt', 'success_criteria', 'circle', 'scenario', 'target_belief', 'custom_data', 'sort_order'],
  evidences: ['id', 'practice_id', 'client_id', 'content', 'occurred_at', 'created_at'],
  coach_moves: ['id', 'name', 'summary', 'when_to_use', 'script', 'targets', 'tags', 'active', 'created_at', 'updated_at'],
};

test('交付模块的表都存在，列齐全', () => {
  const db = getDb();
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    assert.deepEqual(cols, columns, `${table} 的列不对`);
  }
});

test('external_id 的唯一索引存在（同一 external_id 不会重复建档）', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='clients'").all().map(r => r.name);
  assert.ok(indexes.includes('idx_clients_external'), '缺少 idx_clients_external');
});

test('教练手法库：名字唯一索引 + active 索引都在', () => {
  const db = getDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='coach_moves'").all().map(r => r.name);
  assert.ok(indexes.includes('idx_coach_moves_name'), '缺少 idx_coach_moves_name');
  assert.ok(indexes.includes('idx_coach_moves_active'), '缺少 idx_coach_moves_active');
});

test('交付项目表 journeys 存在，且有内容快照列', () => {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(journeys)').all().map(c => c.name);
  for (const c of ['id', 'client_id', 'title', 'kind', 'source', 'url', 'snapshot_md',
                   'status', 'phase_note', 'started_at', 'ended_at', 'notes',
                   'created_at', 'updated_at']) {
    assert.ok(cols.includes(c), `journeys 缺列：${c}`);
  }
});
