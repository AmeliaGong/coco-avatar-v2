// 教练知识库：存取与检索。
//
// 边界：这里只负责「存取与检索」。把检索结果注入 prompt 的接线不在本模块 ——
// 那会改变线上 chat 的 prompt 行为，是一次需要单独评审的变更。
import crypto from 'node:crypto';

// 默认一次检索返回多少条。
const DEFAULT_LIMIT = 5;

// 把一行的 tags 安全地解析成字符串数组。
//
// 为什么必须容错：tags 是 TEXT 列，里面装的是 JSON 字符串。脏数据来源很多 ——
// 手工写进去的、别的程序写进去的、旧版本遗留的。JSON.parse 遇到 'not-json'
// 会抛 SyntaxError，而一次抛错就意味着**整次检索不可用** —— 一行脏数据
// 让整个知识库检索瘫痪，这个代价远比丢掉几个 tag 大得多。
//
// 退化规则：
//   - 不是合法 JSON      → []
//   - 是合法 JSON 但不是数组 → []
//   - 是数组但含非字符串元素 → 只保留字符串元素
export function parseTags(raw) {
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(t => typeof t === 'string');
}

// 把 tags 归一成字符串数组：不是数组就当空数组，数组里的非字符串元素丢掉。
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter(t => typeof t === 'string');
}

export function createKnowledgeStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createKnowledgeStore 需要一个数据库连接（{ db }）');
  }

  // 新建一条知识库条目。
  //
  // kind / title / content 是 NOT NULL 列：不校验的话，传 undefined 会让
  // better-sqlite3 抛一句干巴巴的底层错误，看不出是哪个字段出了问题。
  function create({ kind, title, content, tags = [], source_url = null } = {}) {
    assertNonEmptyString(kind, 'kind');
    assertNonEmptyString(title, 'title');
    assertNonEmptyString(content, 'content');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const cleanTags = normalizeTags(tags);
    db.prepare(
      'INSERT INTO knowledge_entries (id, kind, title, content, tags, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, kind, title, content, JSON.stringify(cleanTags), source_url, now, now);
    return { id, kind, title, content, tags: cleanTags };
  }

  // 检索：按 tag / 关键词 / kind 打分，返回分数最高的若干条。
  //
  // 入参一律容错：未来的调用方可能传各种奇怪的参数，一条坏参数不该让检索抛异常。
  function search(params = {}) {
    const opts = params && typeof params === 'object' && !Array.isArray(params) ? params : {};

    const wanted = (Array.isArray(opts.tags) ? opts.tags : []).filter(
      t => typeof t === 'string' && t.trim() !== ''
    );
    const q = typeof opts.query === 'string' ? opts.query.trim() : '';
    const kind = typeof opts.kind === 'string' && opts.kind.trim() !== '' ? opts.kind : null;
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

    const rows = db.prepare('SELECT * FROM knowledge_entries').all();

    const scored = rows
      .map(row => {
        const rowTags = parseTags(row.tags);
        const tagHit = wanted.length ? wanted.filter(t => rowTags.includes(t)).length : 0;
        const haystack = `${row.title}\n${row.content}`;
        const queryHit = q ? (haystack.includes(q) ? 1 : 0) : 0;
        const kindHit = kind && row.kind === kind ? 1 : 0;
        return { row, score: tagHit * 2 + queryHit + kindHit };
      })
      .filter(x => x.score > 0)
      // 排序必须**完全确定**：分数相同时按更新时间倒序，还相同时按 id 升序。
      // 少了最后这道 tiebreaker，同分同时间的条目顺序取决于 SQLite 的返回
      // 顺序 —— 同样的数据两次检索可能给出不同结果，调用方（以及测试）会随机炸。
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.updated_at.localeCompare(a.row.updated_at) ||
          a.row.id.localeCompare(b.row.id)
      )
      .slice(0, limit);

    return scored.map(x => ({
      id: x.row.id,
      kind: x.row.kind,
      title: x.row.title,
      content: x.row.content,
      tags: parseTags(x.row.tags),
      source_url: x.row.source_url,
    }));
  }

  // 把检索结果渲染成可注入 prompt 的条目行。
  //
  // **只输出条目行，不输出段落标题** —— 段落标题由拼 prompt 的一方负责
  // （当前是 cbtEngine 的 buildContextSection，它已经输出了
  // 「--- 可参考的教练知识库 ---」这个标题）。两边都输出的话，模型会看到
  // 两段一模一样的节结构。
  function formatForPrompt(entries) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const lines = entries
      .filter(e => e && typeof e === 'object' && !Array.isArray(e))
      .map(e => `- 【${e.kind ?? ''}】${e.title ?? ''}：${e.content ?? ''}`);
    return lines.join('\n');
  }

  // 列出条目（按更新时间倒序）。
  //
  // tags 一律解析成数组：否则同一份数据在 search() 和 list() 里形状不一致
  // （一个是数组，一个是 JSON 字符串），调用方一定会踩坑。其它字段原样返回。
  function list({ kind = null, limit = 100 } = {}) {
    const kindFilter = typeof kind === 'string' && kind.trim() !== '' ? kind : null;
    const rows = kindFilter
      ? db
          .prepare('SELECT * FROM knowledge_entries WHERE kind = ? ORDER BY updated_at DESC, id ASC LIMIT ?')
          .all(kindFilter, limit)
      : db
          .prepare('SELECT * FROM knowledge_entries ORDER BY updated_at DESC, id ASC LIMIT ?')
          .all(limit);
    return rows.map(row => ({ ...row, tags: parseTags(row.tags) }));
  }

  // 删除一条。id 不存在时返回 false。
  function remove(id) {
    return db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0;
  }

  return { create, search, formatForPrompt, list, remove };
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`知识库条目的 ${field} 不能为空`);
  }
}
