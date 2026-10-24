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

// ======================================================================
// 以下是代码质量评审（CHANGES REQUESTED）要求补的硬化项与测试盲区
// ======================================================================

// ------------------------------------------------- 拍板①：kind 是过滤器

test('kind 是过滤器不是打分项：search 只返回该 kind 的条目', () => {
  const s = store();
  s.create({ kind: 'case', title: '案例 A', content: '正文', tags: ['共同'] });
  s.create({ kind: 'quote', title: '语录 B', content: '正文', tags: ['共同'] });

  const hits = s.search({ tags: ['共同'], kind: 'case' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'case');
  assert.equal(hits[0].title, '案例 A');
});

test('search 与 list 的 kind 过滤行为一致', () => {
  const s = store();
  s.create({ kind: 'case', title: '案例 A', content: '正文', tags: ['共同'] });
  s.create({ kind: 'quote', title: '语录 B', content: '正文', tags: ['共同'] });
  s.create({ kind: 'case', title: '案例 C', content: '正文', tags: ['共同'] });

  const viaSearch = s.search({ kind: 'case' }).map(e => e.id).sort();
  const viaList = s.list({ kind: 'case' }).map(e => e.id).sort();
  assert.deepEqual(viaSearch, viaList);
  assert.equal(viaSearch.length, 2);
  assert.ok(viaSearch.every(id => s.get(id).kind === 'case'));
});

test('kind 为空 / 非法时不过滤（search 与 list 一致）', () => {
  const s = store();
  s.create({ kind: 'case', title: '案例 A', content: '正文', tags: [] });
  s.create({ kind: 'quote', title: '语录 B', content: '正文', tags: [] });

  // 非字符串 kind → 当 null → 不过滤（list 仍返回整表）。
  assert.equal(s.list({ kind: 42 }).length, 2);
  assert.equal(s.list({ kind: '' }).length, 2);
  assert.equal(s.list({ kind: null }).length, 2);
  // search 的 kind 非法 → 不过滤；又没有任何打分条件 → 空数组。
  assert.deepEqual(s.search({ kind: 42 }), []);
  assert.deepEqual(s.search({ kind: '' }), []);
});

test('search 什么条件都不传时返回空数组（想取全部请用 list）', () => {
  const s = store();
  s.create({ kind: 'case', title: '案例 A', content: '正文', tags: ['x'] });
  assert.deepEqual(s.search(), []);
  assert.deepEqual(s.search({}), []);
  assert.equal(s.list().length, 1);
});

// --------------------------------------------------------- 检索打分语义

test('tag 命中的权重高于关键词命中', () => {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // A 只命中 tag；B 只命中关键词。若 tag 权重被改成 *1，两者同分，
  // 就会按 updated_at 倒序把 B 排到前面 —— 这条断言正好抓住那个变异。
  insert.run('k-a', 'note', '只命中 tag', '毫不相关的正文', '["重要"]', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  insert.run('k-b', 'note', '只命中关键词', '关键词在这里', '["无关"]', null, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

  const s = store();
  const hits = s.search({ tags: ['重要'], query: '关键词' });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'k-a');
});

test('同分但 updated_at 不同：新的在前', () => {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // created_at 相同、updated_at 不同、同分。id 顺序与 updated_at 顺序相反：
  // 少了 updated_at 这级 tiebreaker 就会排成 k-a 在前。
  insert.run('k-a', 'note', '旧的一条', '同样的关键词', '[]', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  insert.run('k-b', 'note', '新的一条', '同样的关键词', '[]', null, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

  const s = store();
  const hits = s.search({ query: '同样' });
  assert.deepEqual(hits.map(e => e.id), ['k-b', 'k-a']);
});

// ------------------------------------------------------- I-1 remove 类型

test('remove 遇到非法 id 返回 false，不抛底层错误', () => {
  const s = store();
  assert.equal(s.remove({}), false);
  assert.equal(s.remove([]), false);
  assert.equal(s.remove(true), false);
  assert.equal(s.remove(123), false);
  assert.equal(s.remove(''), false);
  assert.equal(s.remove(null), false);
  assert.equal(s.remove(undefined), false);
});

// ------------------------------------------------------- I-2 list 的 limit

test('list 的 limit 非法时退回默认 100（不会变成不限量）', () => {
  const s = store();
  for (let i = 0; i < 120; i++) {
    s.create({ kind: 'case', title: `条目${i}`, content: '正文', tags: [] });
  }
  assert.equal(s.list({ limit: 0 }).length, 100);
  assert.equal(s.list({ limit: -1 }).length, 100);
  assert.equal(s.list({ limit: 'abc' }).length, 100);
  assert.equal(s.list({ limit: null }).length, 100);
  assert.equal(s.list({ limit: NaN }).length, 100);
  assert.equal(s.list({ limit: 3 }).length, 3);
});

test('list 的 limit 是真的 LIMIT（不是固定 100）', () => {
  const s = store();
  for (let i = 0; i < 10; i++) {
    s.create({ kind: 'case', title: `条目${i}`, content: '正文', tags: [] });
  }
  assert.equal(s.list({ limit: 3 }).length, 3);
});

// ------------------------------------------------------- I-4 source_url

test('create 遇到非法 source_url 抛中文错误', () => {
  const s = store();
  assert.throws(
    () => s.create({ kind: 'case', title: 'x', content: 'y', source_url: {} }),
    (err) => {
      assert.match(err.message, /source_url/);
      assert.match(err.message, /字符串/);
      return true;
    }
  );
  assert.throws(() => s.create({ kind: 'case', title: 'x', content: 'y', source_url: 123 }), /source_url/);
});

test('source_url 存得进去、也读得回来', () => {
  const s = store();
  const created = s.create({
    kind: 'case',
    title: '自由职业转型',
    content: '来访者从阿里离职',
    tags: ['转型'],
    source_url: 'http://example.com/a',
  });
  assert.equal(created.source_url, 'http://example.com/a');

  const row = getDb()
    .prepare('SELECT source_url FROM knowledge_entries WHERE id = ?')
    .get(created.id);
  assert.equal(row.source_url, 'http://example.com/a');

  // search 返回的条目也必须带着 source_url。
  const hits = s.search({ tags: ['转型'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source_url, 'http://example.com/a');
});

// --------------------------------------------------- I-5 五个出口的形状

test('create / search / list / get / update 的返回字段完全一致，且不含 embedding', () => {
  const s = store();
  const created = s.create({
    kind: 'case',
    title: '自由职业转型',
    content: '来访者从阿里离职',
    tags: ['转型'],
    source_url: 'http://example.com/a',
  });

  const shapes = [
    created,
    s.search({ tags: ['转型'] })[0],
    s.list()[0],
    s.get(created.id),
    s.update(created.id, { title: '自由职业转型（修订）' }),
  ];
  const expected = [
    'content',
    'created_at',
    'id',
    'kind',
    'source_url',
    'tags',
    'title',
    'updated_at',
  ];
  for (const entry of shapes) {
    assert.deepEqual(Object.keys(entry).sort(), expected);
    assert.ok(!Object.keys(entry).includes('embedding'));
    assert.ok(Array.isArray(entry.tags));
  }
});

// --------------------------------------------------------- I-6 get/update

test('get 取一条；不存在（或 id 非法）返回 null', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '标题', content: '正文', tags: ['x'] });
  assert.equal(s.get(created.id).title, '标题');
  assert.equal(s.get('不存在的id'), null);
  assert.equal(s.get({}), null);
  assert.equal(s.get(''), null);
});

test('update 改字段、刷新 updated_at、且不许改 id / created_at', async () => {
  const s = store();
  const created = s.create({
    kind: 'case',
    title: '标题',
    content: '正文',
    tags: ['旧标签'],
    source_url: 'http://example.com/a',
  });

  await new Promise(r => setTimeout(r, 5));
  const updated = s.update(created.id, {
    kind: 'quote',
    title: '新标题',
    content: '新正文',
    tags: ['新标签'],
    source_url: 'http://example.com/b',
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.kind, 'quote');
  assert.equal(updated.title, '新标题');
  assert.equal(updated.content, '新正文');
  assert.deepEqual(updated.tags, ['新标签']);
  assert.equal(updated.source_url, 'http://example.com/b');
  // 创建时间不许改。
  assert.equal(updated.created_at, created.created_at);
  // 更新时间必须刷新。
  assert.notEqual(updated.updated_at, created.updated_at);
  assert.ok(updated.updated_at > created.updated_at);
});

test('update 没给的字段保持原值', () => {
  const s = store();
  const created = s.create({
    kind: 'case',
    title: '标题',
    content: '正文',
    tags: ['标签'],
    source_url: 'http://example.com/a',
  });
  const updated = s.update(created.id, { title: '只改标题' });
  assert.equal(updated.title, '只改标题');
  assert.equal(updated.kind, 'case');
  assert.equal(updated.content, '正文');
  assert.deepEqual(updated.tags, ['标签']);
  assert.equal(updated.source_url, 'http://example.com/a');
});

test('update 对不存在的 id 返回 false，且不会凭空插入一行', () => {
  const s = store();
  assert.equal(s.update('不存在的id', { title: 'x' }), false);
  assert.equal(s.update({}, { title: 'x' }), false);
  assert.equal(s.update('', { title: 'x' }), false);
  assert.equal(s.list().length, 0);
});

test('update 忽略 patch 里的 id / created_at / updated_at', () => {
  const s = store();
  const a = s.create({ kind: 'case', title: 'A', content: '正文', tags: [] });
  const b = s.create({ kind: 'case', title: 'B', content: '正文', tags: [] });

  const updated = s.update(a.id, {
    title: 'A 改了',
    id: b.id,
    created_at: '1999-01-01T00:00:00.000Z',
    updated_at: '1999-01-01T00:00:00.000Z',
  });

  // 改的还是 A：id 与 created_at 没被动过。
  assert.equal(updated.id, a.id);
  assert.equal(updated.created_at, a.created_at);
  assert.equal(updated.title, 'A 改了');
  // B 一点没动。
  assert.equal(s.get(b.id).title, 'B');
  assert.equal(s.get(b.id).created_at, b.created_at);
});

test('update 的入参校验跟 create 一样：空的 kind/title/content 抛中文错误', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '标题', content: '正文', tags: [] });
  assert.throws(() => s.update(created.id, { kind: '' }), /kind/);
  assert.throws(() => s.update(created.id, { title: '' }), /title/);
  assert.throws(() => s.update(created.id, { content: '' }), /content/);
  assert.throws(() => s.update(created.id, { kind: 123 }), /kind/);
  assert.throws(() => s.update(created.id, { source_url: {} }), /source_url/);
});

test('update 的 patch 不是对象时抛中文错误', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '标题', content: '正文', tags: [] });
  assert.throws(() => s.update(created.id, null), /patch/);
  assert.throws(() => s.update(created.id, '不是对象'), /patch/);
});

// ------------------------------------------------------- m3 tag 空白归一化

test('tag 的空白被归一化：存 \' 转型 \' 用 \'转型\' 也能搜到', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '标题', content: '正文', tags: [' 转型 '] });
  assert.deepEqual(created.tags, ['转型']);
  assert.equal(s.search({ tags: ['转型'] }).length, 1);
  assert.equal(s.search({ tags: [' 转型 '] }).length, 1);
});

test('tag 去重、空 tag 丢掉', () => {
  const s = store();
  const created = s.create({ kind: 'case', title: '标题', content: '正文', tags: ['a', 'a', '  ', 'b'] });
  assert.deepEqual(created.tags, ['a', 'b']);
  // 查询侧去重：重复的 tag 不改变结果。
  assert.equal(s.search({ tags: ['a', 'a'] }).length, 1);
});

// ------------------------------------------------- m8 formatForPrompt 容错

test('formatForPrompt 遇到 null / 缺字段的条目不崩', () => {
  const s = store();
  let out = '';
  assert.doesNotThrow(() => {
    out = s.formatForPrompt([null, undefined, [], '字符串', { kind: 'case' }, { title: '只有标题' }]);
  });
  assert.ok(out.includes('【case】'));
  assert.ok(out.includes('只有标题'));
});

// ------------------------------------------------------ list 的 kind 过滤

test('list 按 kind 过滤', () => {
  const s = store();
  s.create({ kind: 'case', title: '案例', content: '正文', tags: [] });
  s.create({ kind: 'quote', title: '语录', content: '正文', tags: [] });
  const rows = s.list({ kind: 'quote' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'quote');
});

test('list 带 kind 时 limit 也生效', () => {
  const s = store();
  for (let i = 0; i < 6; i++) {
    s.create({ kind: 'case', title: `案例${i}`, content: '正文', tags: [] });
  }
  s.create({ kind: 'quote', title: '语录', content: '正文', tags: [] });
  assert.equal(s.list({ kind: 'case', limit: 3 }).length, 3);
});

test('kind 的前后空白被归一化（search 与 list 一致）', () => {
  const s = store();
  s.create({ kind: 'case', title: '案例', content: '正文', tags: [] });
  assert.equal(s.search({ kind: ' case ' }).length, 1);
  assert.equal(s.list({ kind: ' case ' }).length, 1);
});

