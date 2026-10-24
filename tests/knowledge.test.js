// 知识库 store 的存取与检索。
//
// 边界：本文件只测「存取与检索」。把检索结果注入 prompt 的接线属于后续
// 任务（而且那会改变线上 chat 的 prompt 行为），所以这里不碰 server.js。
import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createKnowledgeStore } from '../server/engine/knowledge.js';

beforeEach(() => resetDb());

const store = () => createKnowledgeStore({ db: getDb() });

// ---------------------------------------------------------------- 基线五条

test('按 tag 检索：只命中带这个 tag 的条目', () => {
  const s = store();
  s.create({ kind: 'case', title: '自由职业转型', content: '来访者从阿里离职后做独立咨询', tags: ['转型'] });
  s.create({ kind: 'case', title: '亲密关系', content: '来访者与伴侣长期冷战', tags: ['婚姻'] });

  const hits = s.search({ tags: ['转型'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '自由职业转型');
  assert.deepEqual(hits[0].tags, ['转型']);
});

test('没有 tag 时按关键词匹配标题与正文', () => {
  const s = store();
  s.create({ kind: 'case', title: '自由职业转型', content: '来访者从阿里离职后做独立咨询', tags: [] });
  s.create({ kind: 'case', title: '亲密关系', content: '来访者与伴侣长期冷战', tags: [] });

  assert.equal(s.search({ query: '自由职业' }).length, 1);
  assert.equal(s.search({ query: '冷战' })[0].title, '亲密关系');
});

test('检索有数量上限（limit=3）', () => {
  const s = store();
  for (let i = 0; i < 6; i++) {
    s.create({ kind: 'case', title: `条目${i}`, content: '同一个关键词', tags: ['批量'] });
  }
  const hits = s.search({ tags: ['批量'], limit: 3 });
  assert.equal(hits.length, 3);
});

test('新建条目时 tags 存成 JSON 数组', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '标题', content: '正文', tags: ['a', 'b'] });
  assert.deepEqual(created.tags, ['a', 'b']);

  const row = getDb().prepare('SELECT tags FROM knowledge_entries WHERE id = ?').get(created.id);
  assert.equal(row.tags, JSON.stringify(['a', 'b']));
});

test('检索结果可以被拼成注入文本', () => {
  const s = store();
  s.create({ kind: 'case', title: '自由职业转型', content: '来访者从阿里离职后做独立咨询', tags: ['转型'] });
  const hits = s.search({ tags: ['转型'] });
  const section = s.formatForPrompt(hits);
  assert.ok(section.includes('自由职业转型'));
  assert.ok(section.includes('来访者从阿里离职'));
});

// -------------------------------------------------------------------- E1

test('formatForPrompt 只输出条目行，不重复输出段落标题', () => {
  const s = store();
  s.create({ kind: 'case', title: '自由职业转型', content: '来访者从阿里离职', tags: ['转型'] });
  const section = s.formatForPrompt(s.search({ tags: ['转型'] }));

  // 段落标题由拼 prompt 的一方（当前是 cbtEngine 的 buildContextSection）负责，
  // store 再输出一份就会在模型看到两段一模一样的节结构。
  assert.ok(!section.includes('可参考的教练知识库'));
  assert.ok(!section.includes('---'));
  // 但条目行本身必须在。
  assert.ok(section.includes('【case】'));
  assert.ok(section.includes('自由职业转型'));
  assert.ok(section.includes('来访者从阿里离职'));
});

test('formatForPrompt 对空数组返回空串', () => {
  const s = store();
  assert.equal(s.formatForPrompt([]), '');
  assert.equal(s.formatForPrompt(null), '');
  assert.equal(s.formatForPrompt(undefined), '');
});

// -------------------------------------------------------------------- E2

test('一行坏掉的 tags（not-json）不会让整次检索崩掉', () => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('k-bad', 'case', '脏数据条目', '正文', 'not-json', null, now, now);

  const s = store();
  let hits = [];
  assert.doesNotThrow(() => {
    hits = s.search({ query: '脏数据' });
  });
  // 坏 tags 退化成 []：这条还能被关键词命中，但拿不到 tag 分。
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].tags, []);

  // 坏 tags 不能连累同一次检索里的其它记录。
  s.create({ kind: 'case', title: '好条目', content: '正常正文', tags: ['正常'] });
  const ok = s.search({ tags: ['正常'] });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].title, '好条目');
});

test('tags 是合法 JSON 但不是数组时退化成空数组', () => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('k-obj', 'case', '对象 tags', '正文', '{"a":1}', null, now, now);

  const s = store();
  const hits = s.search({ query: '对象' });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].tags, []);
});

test('tags 数组里的非字符串元素被丢掉', () => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('k-mixed', 'case', '混合 tags', '正文', '["好",1,null,{"x":1},"也好"]', null, now, now);

  const s = store();
  assert.deepEqual(s.search({ query: '混合' })[0].tags, ['好', '也好']);
});

test('list 返回的 tags 也是数组（与 search 的形状一致）', () => {
  const s = store();
  s.create({ kind: 'case', title: '标题', content: '正文', tags: ['a', 'b'] });
  const rows = s.list();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, ['a', 'b']);
  // 其它字段保持原样。
  assert.equal(rows[0].kind, 'case');
  assert.equal(rows[0].title, '标题');
  assert.ok(rows[0].created_at);
});

// -------------------------------------------------------------------- E3

test('同分同时间的多条目，检索顺序完全确定', () => {
  const db = getDb();
  const now = '2026-01-01T00:00:00.000Z';
  const insert = db.prepare(
    `INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 插入顺序故意与 id 顺序相反：只按插入顺序排的实现会被这一条抓住。
  insert.run('k-c', 'note', '第三条', '同样的关键词', '[]', null, now, now);
  insert.run('k-a', 'note', '第一条', '同样的关键词', '[]', null, now, now);
  insert.run('k-b', 'note', '第二条', '同样的关键词', '[]', null, now, now);

  const s = store();
  const first = s.search({ query: '同样' }).map(e => e.id);
  const second = s.search({ query: '同样' }).map(e => e.id);
  assert.deepEqual(first, ['k-a', 'k-b', 'k-c']);
  assert.deepEqual(second, first);
});

// -------------------------------------------------------------------- E4

test('search 对奇怪的入参不抛错', () => {
  const s = store();
  s.create({ kind: 'case', title: '自由职业转型', content: '来访者从阿里离职', tags: ['转型'] });

  assert.doesNotThrow(() => s.search({ tags: '不是数组' }));
  assert.doesNotThrow(() => s.search({ query: 123 }));
  assert.doesNotThrow(() => s.search({ limit: 0 }));
  assert.doesNotThrow(() => s.search({ limit: -1 }));
  assert.doesNotThrow(() => s.search({ limit: 'x' }));
  assert.doesNotThrow(() => s.search({}));
  assert.doesNotThrow(() => s.search());

  // tags 不是数组 → 当成 []，于是没有 tag 命中；
  // query 不是字符串 → 当成 ''，于是没有关键词命中；
  // kind 不是字符串 → 当成 null。
  assert.deepEqual(s.search({ tags: '不是数组' }), []);
  assert.deepEqual(s.search({ query: 123 }), []);
  assert.deepEqual(s.search({ kind: 42 }), []);
});

test('search 的 limit 非法时退回默认 5', () => {
  const s = store();
  for (let i = 0; i < 8; i++) {
    s.create({ kind: 'case', title: `条目${i}`, content: '批量关键词', tags: ['批量'] });
  }
  assert.equal(s.search({ tags: ['批量'], limit: 0 }).length, 5);
  assert.equal(s.search({ tags: ['批量'], limit: -1 }).length, 5);
  assert.equal(s.search({ tags: ['批量'], limit: 'x' }).length, 5);
  assert.equal(s.search({ tags: ['批量'], limit: 3 }).length, 3);
});

// -------------------------------------------------------------------- E5

test('create 对空的 kind / title / content 抛中文错误', () => {
  const s = store();
  assert.throws(
    () => s.create({ kind: '', title: 'x', content: 'y' }),
    (err) => {
      assert.match(err.message, /kind/);
      assert.match(err.message, /不能为空/);
      return true;
    }
  );
  assert.throws(
    () => s.create({ kind: 'case', title: '', content: 'y' }),
    (err) => {
      assert.match(err.message, /title/);
      assert.match(err.message, /不能为空/);
      return true;
    }
  );
  assert.throws(
    () => s.create({ kind: 'case', title: 'x', content: '' }),
    (err) => {
      assert.match(err.message, /content/);
      assert.match(err.message, /不能为空/);
      return true;
    }
  );
});

test('create 对缺字段 / 非字符串字段抛中文错误', () => {
  const s = store();
  assert.throws(() => s.create({ title: 'x', content: 'y' }), /kind/);
  assert.throws(() => s.create({ kind: 'case', content: 'y' }), /title/);
  assert.throws(() => s.create({ kind: 'case', title: 'x' }), /content/);
  assert.throws(() => s.create({ kind: 123, title: 'x', content: 'y' }), /kind/);
  assert.throws(() => s.create({ kind: 'case', title: null, content: 'y' }), /title/);
});

test('create 的 tags 不是数组就当空数组，数组里的非字符串元素丢掉', () => {
  const s = store();
  const a = s.create({ kind: 'case', title: 'x', content: 'y', tags: '不是数组' });
  assert.deepEqual(a.tags, []);
  const b = s.create({ kind: 'case', title: 'x', content: 'y', tags: ['好', 1, null, '也好'] });
  assert.deepEqual(b.tags, ['好', '也好']);
});

// -------------------------------------------------------------------- E6

test('remove 对不存在的 id 返回 false', () => {
  const s = store();
  assert.equal(s.remove('不存在的id'), false);
});

test('remove 掉真实 id 返回 true，之后检索不到', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '自由职业转型', content: '来访者从阿里离职', tags: ['转型'] });
  assert.equal(s.remove(created.id), true);
  assert.equal(s.search({ tags: ['转型'] }).length, 0);
  assert.equal(s.list().length, 0);
});
