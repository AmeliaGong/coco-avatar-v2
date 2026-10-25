import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createClientStore } from '../server/delivery/clients.js';

beforeEach(() => resetDb());

const db = getDb();
const store = createClientStore({ db });

function seedConversation(id, title) {
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, status, scenario, link_kind) VALUES (?, ?, ?, 'active', 'chat', 'client')"
  ).run(id, title, new Date().toISOString());
}

function seedMessage(convId, role, content, structuredJson) {
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content, created_at, structured_json) VALUES (?, ?, ?, ?, ?)'
  ).run(convId, role, content, new Date().toISOString(), structuredJson || null);
}

test('建客户：display_name 必填，空串报错', () => {
  assert.throws(() => store.create({ display_name: '  ' }), /display_name/);
  const c = store.create({ display_name: '客户甲', phone: '13800000000', notes: '1v1 老客户' });
  assert.equal(c.display_name, '客户甲');
  assert.equal(c.source, 'manual');
  assert.equal(c.status, 'active');
  assert.ok(c.id);
});

test('建客户：external_id 重复时报错，不静默建第二个档', () => {
  store.create({ display_name: '客户甲', external_id: 'nomad-1' });
  assert.throws(() => store.create({ display_name: '客户乙', external_id: 'nomad-1' }), /external_id/);
});

test('挂载会话：conversations.client_id 被写上', () => {
  seedConversation('conv-1', '第一次 CBT');
  const c = store.create({ display_name: '客户甲' });
  const r = store.attachConversations(c.id, ['conv-1']);
  assert.equal(r.attached, 1);
  const conv = db.prepare('SELECT client_id FROM conversations WHERE id = ?').get('conv-1');
  assert.equal(conv.client_id, c.id);
});

test('挂载会话：不存在的会话被跳过，不抛错', () => {
  seedConversation('conv-1', '第一次 CBT');
  const c = store.create({ display_name: '客户甲' });
  const r = store.attachConversations(c.id, ['conv-1', 'conv-不存在']);
  assert.equal(r.attached, 1);
  assert.equal(r.skipped.length, 1);
});

test('挂载会话：会话已经属于别的客户时拒绝改嫁', () => {
  seedConversation('conv-1', '第一次 CBT');
  const a = store.create({ display_name: 'A' });
  const b = store.create({ display_name: 'B' });
  store.attachConversations(a.id, ['conv-1']);
  assert.throws(() => store.attachConversations(b.id, ['conv-1']), /已经属于/);
});

test('导入卡点：从会话的结构化输出里抽出卡点并挂到客户', () => {
  seedConversation('conv-1', '第一次 CBT');
  seedMessage('conv-1', 'assistant', '我们识别到你的卡点', JSON.stringify({
    title: '我不敢停下来',
    belief: '我不能停下来',
    evidence_against: ['我请过三天假，没人出事'],
    emotion: '焦虑',
    micro_action: '今天午休时离开工位十分钟',
  }));
  const c = store.create({ display_name: '客户甲' });
  store.attachConversations(c.id, ['conv-1']);
  const imported = store.importStuckPointsFromConversations(c.id, ['conv-1']);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].title, '我不敢停下来');
  assert.equal(imported[0].client_id, c.id);
  assert.deepEqual(imported[0].evidence_against, ['我请过三天假，没人出事']);
});

test('导入卡点：重复导入同一个会话不会产生第二条', () => {
  seedConversation('conv-1', '第一次 CBT');
  seedMessage('conv-1', 'assistant', '我们识别到你的卡点', JSON.stringify({ title: '我不敢停下来' }));
  const c = store.create({ display_name: '客户甲' });
  store.attachConversations(c.id, ['conv-1']);
  store.importStuckPointsFromConversations(c.id, ['conv-1']);
  const again = store.importStuckPointsFromConversations(c.id, ['conv-1']);
  assert.equal(again.length, 0);
  const count = db.prepare('SELECT COUNT(*) AS n FROM stuck_points').get().n;
  assert.equal(count, 1);
});

test('客户详情：能拿到他的会话列表与最近互动时间', () => {
  seedConversation('conv-1', '第一次 CBT');
  const c = store.create({ display_name: '客户甲' });
  store.attachConversations(c.id, ['conv-1']);
  const detail = store.getWithConversations(c.id);
  assert.equal(detail.conversations.length, 1);
  assert.equal(detail.conversations[0].id, 'conv-1');
  assert.ok(detail.conversations[0].last_message_at || detail.conversations[0].created_at);
});

test('教练手录卡点：title 必填', () => {
  const c = store.create({ display_name: '客户甲' });
  assert.throws(() => store.addStuckPoint(c.id, { title: '  ' }), /title/);
});

test('教练手录卡点：存下来，source 是 manual', () => {
  const c = store.create({ display_name: '客户甲' });
  const sp = store.addStuckPoint(c.id, {
    title: '我不敢停下来',
    belief: '我不能停下来',
    evidence_against: '我请过三天假，没人出事',
  });
  assert.equal(sp.title, '我不敢停下来');
  assert.equal(sp.source, 'manual');
  assert.deepEqual(JSON.parse(sp.evidence_against), ['我请过三天假，没人出事']);
});

test('引擎提取的卡点：source 是 extracted', () => {
  const c = store.create({ display_name: '客户甲' });
  const sp = store.addExtractedStuckPoint(c.id, { title: '我不敢停下来', belief: 'x' });
  assert.equal(sp.source, 'extracted');
});
