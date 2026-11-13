// 探索者故事的 admin 接口。
//
// ⚠️ **没有公开读接口** —— 这条本身就是契约的一部分：
// 探索者故事是真人可识别信息，地球页那张 stories 表（公开渲染）不能承载它。
// 所以这里要断言：没有 token 读不到、带 token 才读得到、而且读到的
// JSON 字段是对的（segments 的 label 与 text 分开，label 只作内部记号）。
//
// 用合成素材（"甲同学"/"乙同学"）—— 真人素材不能进仓库（仓库是 public 的）。
import './helpers/testEnv.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { resetDb } from './helpers/testDb.js';
import { createServer } from './helpers/testServer.js';

let server;
let base;
let token;

before(async () => {
  server = await createServer();
  base = server.baseUrl;
});

after(() => server?.close());

beforeEach(() => {
  resetDb();
  token = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(
      token,
      new Date().toISOString(),
      new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    );
});

function adminHeaders(extra = {}) {
  return { 'X-Admin-Token': token, 'Content-Type': 'application/json', ...extra };
}

const STORY = {
  id: 'jia',
  name: '甲同学',
  aliases: ['小甲'],
  category: '04',
  education_level: 'L2',
  one_liner: '一句用于测试的画像。',
  match_signals: ['我很累'],
  segments: [
    { label: '[段 0] 原小标题', text: '甲同学的第一段。' },
    { label: '[段 1] 原小标题', text: '甲同学的第二段。' },
  ],
  guide: '一次讲一段。',
  safety: '不渲染细节。',
};

test('没有 admin token 读不到任何素材', async () => {
  const res = await fetch(`${base}/api/admin/explorer-stories`);
  assert.equal(res.status, 401);
});

test('批量写入：合法的收下，不合法的退回', async () => {
  const res = await fetch(`${base}/api/admin/explorer-stories`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      stories: [
        STORY,
        { id: '没有名字的' },
        { name: '没有 id 的' },
        { id: 'yi', name: '乙同学', segments: [{ label: 'x', text: '乙的一段。' }] },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.accepted, ['jia', 'yi']);
  assert.equal(body.count, 2);
  assert.equal(body.rejected.length, 2);
});

test('写进去的素材能读回来，且 label 与 text 分开', async () => {
  await fetch(`${base}/api/admin/explorer-stories`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ stories: [STORY] }),
  });
  const res = await fetch(`${base}/api/admin/explorer-stories`, { headers: adminHeaders() });
  const body = await res.json();
  assert.equal(body.stories.length, 1);
  const s = body.stories[0];
  assert.equal(s.name, '甲同学');
  assert.deepEqual(s.aliases, ['小甲']);
  assert.deepEqual(s.match_signals, ['我很累']);
  assert.equal(s.segments.length, 2);
  assert.equal(s.segments[0].label, '[段 0] 原小标题');
  assert.equal(s.segments[0].text, '甲同学的第一段。');
  assert.equal(s.safety, '不渲染细节。');
});

test('同一个 id 重复写入是覆盖，不攒重复行', async () => {
  for (const one_liner of ['第一版画像。', '第二版画像。']) {
    await fetch(`${base}/api/admin/explorer-stories`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ stories: [{ ...STORY, one_liner }] }),
    });
  }
  const res = await fetch(`${base}/api/admin/explorer-stories`, { headers: adminHeaders() });
  const body = await res.json();
  assert.equal(body.stories.length, 1);
  assert.equal(body.stories[0].one_liner, '第二版画像。');
});

test('可以停用一则素材（停用后不进入运行时目录）', async () => {
  await fetch(`${base}/api/admin/explorer-stories`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ stories: [STORY, { id: 'yi', name: '乙同学' }] }),
  });
  getDb().prepare('UPDATE explorer_stories SET is_active = 0 WHERE id = ?').run('jia');

  const { buildExplorerContext } = await import('../server/engine/explorer.js');
  const ctx = buildExplorerContext({
    db: getDb(),
    conversationId: 'c1',
    history: [{ role: 'user', content: '你好' }],
  });
  assert.equal(ctx.catalog.length, 1);
  assert.equal(ctx.catalog[0].name, '乙同学');
});

test('删除一则素材', async () => {
  await fetch(`${base}/api/admin/explorer-stories`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ stories: [STORY] }),
  });
  const res = await fetch(`${base}/api/admin/explorer-stories/jia`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
  assert.equal(res.status, 200);
  const list = await fetch(`${base}/api/admin/explorer-stories`, { headers: adminHeaders() });
  assert.equal((await list.json()).stories.length, 0);
});

test('**没有公开读接口** —— 素材不出现在任何非 admin 路径上', async () => {
  await fetch(`${base}/api/admin/explorer-stories`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ stories: [STORY] }),
  });
  // 地球页那张 stories 表是公开渲染的 —— 探索者故事**绝不能**混进去。
  const publicStories = await fetch(`${base}/api/stories`);
  const text = await publicStories.text();
  assert.ok(!text.includes('甲同学'), '公开的 stories 接口不能出现探索者素材');
  assert.ok(!text.includes('甲同学的第一段'));
});

test('一批大素材（>100kb）写得进去 —— 灌素材这条路不能被 body 上限挡住', async () => {
  // 为什么要有这条：一次灌 15 则素材是 153,429 **字节**（UTF-8 字节数，
  // 不是字符数 —— 中文一字 3 字节，JSON.stringify 给的是字符数 59,622，
  // 差一半多）。express.json() 的默认上限是 100kb ⇒ 灌数据这条路
  // 直接 400 "Invalid request body"。
  //
  // 这条断言的是「上限被挪到这条路径上了」，不是「多大都能灌」：
  // 用 15 则 × 每则 8KB 合成素材（不塞真人内容），越线时应当 200。
  const big = [];
  for (let i = 0; i < 15; i++) {
    big.push({
      ...STORY,
      id: `big-${i}`,
      name: `大素材${i}`,
      segments: Array.from({ length: 8 }, (_, s) => ({
        label: `段 ${s}`,
        text: '这是一段用于测试体积极限的合成文字。'.repeat(90),
      })),
    });
  }
  const payload = JSON.stringify({ stories: big });
  assert.ok(
    Buffer.byteLength(payload, 'utf8') > 102400,
    '这条用例必须真的越过 100kb，否则它证明不了什么'
  );
  const res = await fetch(`${base}/api/admin/explorer-stories`, {
    method: 'POST',
    headers: adminHeaders(),
    body: payload,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 15);
});
