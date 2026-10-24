// 教练知识库：存取与检索。
//
// 边界：这里只负责「存取与检索」。把检索结果注入 prompt 的接线不在本模块 ——
// 那会改变线上 chat 的 prompt 行为，是一次需要单独评审的变更。
//
// ============================================================================
// 【接线时的验收标准】（评审结论，现在只记录、不实现）
//
// 总纲：**知识库内容是不可信输入。任何字段进 system prompt 前必须经引擎净化；
//        内容永远不被当作指令执行。**
//
//   ① 收敛渲染入口：将来接线时**首选删掉 formatForPrompt**；如果后台要预览，
//      就把它和引擎共用同一套净化函数。判据：`grep -rn formatForPrompt server/`
//      的结果里只剩引擎那套。
//   ② 净化只在渲染期做，**绝不在 create() / update() 时截断入库** —— 否则管理员
//      的原始材料被**永久销毁**，以后净化规则变了也救不回来。
//   ③ content 补「行首标记压平」：引擎的 sanitizeKnowledgeBody **保留换行**
//      （段落结构是信息的一部分），所以内容里可以塞进伪造的段落标题。接线时要
//      在 sanitizeKnowledgeBody 里**只把每行行首**的 --- / ### / === 标记吃掉
//      （保留换行与缩进），例如 line.replace(/^(\s*)([-#=]{1,6}\s*)/, '$1')。
//      —— 这一条要改 server/engine/cbtEngine.js，**不属于本任务**。
//   ④ 总量闸门改成按条目整条丢/留，并标注省略了多少条。
//
// ============================================================================
// 性能备注：现在数据量小，检索是全表扫，够用。数据量上来之后需要
// `updated_at` 索引（配合 `WHERE kind = ?`），或者直接上 FTS5 全文检索。
// ============================================================================
import crypto from 'node:crypto';

// 检索默认返回多少条；列出默认返回多少条。两个默认值不一样，别抄串。
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_LIST_LIMIT = 100;

// 对外暴露的列。**不含 embedding** —— 那是给将来的向量检索预留的内部列，
// 现在没人用；泄漏出去会让调用方误以为能用。
// 显式列名（不用 SELECT *）：表结构一变 SELECT * 的形状就会静默漂移。
const ENTRY_COLUMNS =
  'id, kind, title, content, tags, source_url, created_at, updated_at';

// 把一行的 tags 安全地解析成字符串数组。
//
// 为什么必须容错：tags 是 TEXT 列，里面装的是 JSON 字符串。脏数据来源很多 ——
// 手工写进去的、别的程序写进去的、旧版本遗留的。JSON.parse 遇到 'not-json'
// 会抛 SyntaxError，而一次抛错就意味着**整次检索不可用** —— 一行脏数据
// 让整个知识库检索瘫痪，这个代价远比丢掉几个 tag 大得多。
//
// 退化规则：
//   - 不是合法 JSON         → []
//   - 是合法 JSON 但不是数组  → []
//   - 是数组但含非字符串元素   → 只保留字符串元素
//
// @internal 仅供测试用；外部调用方请用 store 的方法（别直接调这个）。
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
  // 逐个 trim 并丢掉空串：存进去的 tag 是 trim 过的，比较时也必须一样，
  // 否则「存 ' 转型 '、查 '转型'」会 0 命中。
  return parsed
    .filter(t => typeof t === 'string')
    .map(t => t.trim())
    .filter(t => t !== '');
}

// 把 tags 归一成字符串数组：不是数组就当空数组，数组里的非字符串元素丢掉，
// 逐个 trim()（存进去和查出来必须是同一个字符串，否则「存 ' 转型 '、
// 查 '转型'」会 0 命中），空串丢掉，重复的去掉。
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const value = tag.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// 把一行数据库记录变成对外的条目形状。
//
// **三个出口（create / search / list，以及 get / update）共用这一个函数** ——
// 五个出口的字段集合必须一模一样，否则调用方会在「有的入口有 created_at、
// 有的没有」这种地方踩坑。embedding 刻意不进来（见 ENTRY_COLUMNS）。
function toEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    source_url: row.source_url ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createKnowledgeStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createKnowledgeStore 需要一个数据库连接（{ db }）');
  }

  const selectById = db.prepare(
    `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`
  );

  // 新建一条知识库条目。
  //
  // kind / title / content 是 NOT NULL 列：不校验的话，传 undefined 会让
  // better-sqlite3 抛一句干巴巴的底层错误，看不出是哪个字段出了问题。
  function create({ kind, title, content, tags = [], source_url = null } = {}) {
    assertNonEmptyString(kind, 'kind');
    assertNonEmptyString(title, 'title');
    assertNonEmptyString(content, 'content');
    const cleanSourceUrl = normalizeSourceUrl(source_url);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO knowledge_entries
         (id, kind, title, content, tags, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, kind, title, content, JSON.stringify(normalizeTags(tags)), cleanSourceUrl, now, now);
    // 写完库再查一行出来返回：这样返回的 created_at / updated_at 与库里完全一致。
    return toEntry(selectById.get(id));
  }

  // 检索：按 tag / 关键词打分，按 kind **过滤**，返回分数最高的若干条。
  //
  // kind 是过滤器，不是打分项 —— 一个叫「kind」的参数却不过滤，最容易被调用方
  // 误解（规格原文写的就是「按 kind 过滤」）。
  //
  // 入参一律容错：未来的调用方可能传各种奇怪的参数，一条坏参数不该让检索抛异常。
  //
  // 约定：**什么都不传时返回空数组** —— 想取全部请用 list()。
  // 传了 kind（合法字符串）时，kind 本身就是一个检索条件，返回该 kind 的条目。
  function search(params = {}) {
    const opts =
      params && typeof params === 'object' && !Array.isArray(params) ? params : {};

    const wanted = normalizeTags(opts.tags);
    const q = typeof opts.query === 'string' ? opts.query.trim() : '';
    const kind =
      typeof opts.kind === 'string' && opts.kind.trim() !== '' ? opts.kind.trim() : null;
    const limit = normalizeLimit(opts.limit, DEFAULT_SEARCH_LIMIT);

    // 一个条件都没有 → 空数组（见上面的约定）。
    if (!wanted.length && !q && !kind) return [];

    const rows = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries`).all();

    // kind 过滤：非字符串的 kind 已经被归一成 null（= 不过滤），这里只会拿到
    // 合法字符串。空字符串的 kind 视作「不过滤」。
    const kindRows = kind ? rows.filter(row => row.kind === kind) : rows;

    const scored = kindRows
      .map(row => {
        const rowTags = parseTags(row.tags);
        const tagHit = wanted.length ? wanted.filter(t => rowTags.includes(t)).length : 0;
        const haystack = `${row.title}\n${row.content}`;
        const queryHit = q ? (haystack.includes(q) ? 1 : 0) : 0;
        // 打分只有两项：tag 命中（权重 2）+ 关键词命中（权重 1）。
        return { row, score: tagHit * 2 + queryHit };
      })
      // 有 tag / 关键词条件时，只保留真正命中的（score > 0）。
      // 只有 kind 条件时，全部保留（kind 本身就是条件）。
      .filter(x => (wanted.length || q ? x.score > 0 : true))
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

    return scored.map(x => toEntry(x.row));
  }

  // 把检索结果渲染成可注入 prompt 的条目行。
  //
  // ⚠️ **这是预览用渲染。它不做任何净化 —— 不要把它直接拼进 system prompt。**
  //    进 prompt **必须**走 server/engine/cbtEngine.js 的 buildContextSection
  //    （那里有 sanitizeShort / sanitizeKnowledgeBody，还有 MAX_CONTEXT_CHARS
  //    的总量闸门）。这里的实现不折换行、不封顶、不压平行首标记，
  //    知识库正文里可以塞进伪造的段落标题。
  //
  // **只输出条目行，不输出段落标题** —— 段落标题由拼 prompt 的一方负责
  // （当前是 cbtEngine 的 buildContextSection，它已经输出了
  // 「--- 可参考的教练知识库 ---」这个标题）。两边都输出的话，模型会看到
  // 两段一模一样的节结构。
  function formatForPrompt(entries) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const lines = entries
      // 脏数据（null、数组、字符串）跳过，不能让整个 prompt 装配崩掉。
      .filter(e => e && typeof e === 'object' && !Array.isArray(e))
      // 字段缺失也不能崩：缺哪个就渲染成空串。
      .map(e => `- 【${text(e.kind)}】${text(e.title)}：${text(e.content)}`);
    return lines.join('\n');
  }

  // 列出条目（按更新时间倒序，同时间按 id 升序 —— 保证结果完全确定）。
  //
  // tags 一律解析成数组：否则同一份数据在 search() 和 list() 里形状不一致
  // （一个是数组，一个是 JSON 字符串），调用方一定会踩坑。其它字段原样返回。
  //
  // kind 的规则与 search **完全一致**：非字符串 → 当 null → 不过滤；
  // 合法字符串 → 过滤。
  // 从 HTTP query 进来的 kind 一定是字符串（req.query.x 永远是 string 或
  // undefined），所以「非字符串 kind」只可能来自代码内部调用 —— 将来写 admin
  // 路由时 kind 来自 query 天然安全，但 **limit 来自 query 是字符串**，所以
  // limit 的校验**必须**在 store 层做（不能只在路由层做）。
  function list({ kind = null, limit = DEFAULT_LIST_LIMIT } = {}) {
    const kindFilter =
      typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : null;
    const safeLimit = normalizeLimit(limit, DEFAULT_LIST_LIMIT);
    const rows = kindFilter
      ? db
          .prepare(
            `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries
              WHERE kind = ?
              ORDER BY updated_at DESC, id ASC
              LIMIT ?`
          )
          .all(kindFilter, safeLimit)
      : db
          .prepare(
            `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries
              ORDER BY updated_at DESC, id ASC
              LIMIT ?`
          )
          .all(safeLimit);
    return rows.map(toEntry);
  }

  // 按 id 取一条。不存在（或 id 非法）返回 null。
  function get(id) {
    if (!isNonEmptyString(id)) return null;
    return toEntry(selectById.get(id));
  }

  // 改一条已有条目。返回改完后的条目；id 不存在（或 id 非法）返回 false。
  //
  // 可以改：kind / title / content / tags / source_url。
  // **不接受 id / created_at** —— 不许改主键、不许改创建时间（这两个字段一律忽略）。
  // patch 里没给的字段保持原值；只有显式给了才校验。
  function update(id, patch = {}) {
    if (!isNonEmptyString(id)) return false;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('知识库条目的 patch 必须是一个对象');
    }
    const current = selectById.get(id);

    // 没有这行时各字段先置 null —— UPDATE 匹配不到任何行，changes 为 0，
    // 下面据此返回 false。**存在与否由 UPDATE 自己说了算**，不在这里提前返回：
    // 提前 return 会让「行不存在」这条分支变成死代码。
    let kind = current ? current.kind : null;
    let title = current ? current.title : null;
    let content = current ? current.content : null;
    let tags = current ? current.tags : '[]';
    let sourceUrl = current ? current.source_url : null;

    if (patch.kind !== undefined) {
      assertNonEmptyString(patch.kind, 'kind');
      kind = patch.kind;
    }
    if (patch.title !== undefined) {
      assertNonEmptyString(patch.title, 'title');
      title = patch.title;
    }
    if (patch.content !== undefined) {
      assertNonEmptyString(patch.content, 'content');
      content = patch.content;
    }
    if (patch.tags !== undefined) {
      tags = JSON.stringify(normalizeTags(patch.tags));
    }
    if (patch.source_url !== undefined) {
      sourceUrl = normalizeSourceUrl(patch.source_url);
    }
    // patch.id / patch.created_at / patch.updated_at 一律忽略：主键与创建时间
    // 不是「条目内容」，改了会让历史记录失去意义。

    const now = new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE knowledge_entries
            SET kind = ?, title = ?, content = ?, tags = ?, source_url = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(kind, title, content, tags, sourceUrl, now, id);
    // changes === 0 → 行不存在（并发删除等），不能 INSERT 出一条新的。
    if (info.changes === 0) return false;
    return toEntry(selectById.get(id));
  }

  // 删除一条。id 不存在（或 id 非法）返回 false。
  function remove(id) {
    // id 必须是字符串：传对象/数组/布尔值时 better-sqlite3 会抛
    // RangeError / TypeError 那种看不懂的底层错误。非法 id 直接当「没这一条」。
    if (!isNonEmptyString(id)) return false;
    return db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id).changes > 0;
  }

  return { create, search, formatForPrompt, list, get, update, remove };
}

// 非法 limit（非正整数：0 / 负数 / NaN / 字符串 / null）退回默认值。
//
// 为什么必须在 store 层做：将来 admin 路由的 limit 来自 HTTP query string，
// 一定是字符串；SQLite 里 LIMIT -1 是「不限量」，LIMIT 'abc' 直接报
// datatype mismatch —— 透传必炸。
function normalizeLimit(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function assertNonEmptyString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new Error(`知识库条目的 ${field} 不能为空`);
  }
}

// source_url 必须是字符串或 null。非字符串抛中文错误（不抛 better-sqlite3 的
// RangeError 那种看不懂的底层错误）。
function normalizeSourceUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error('知识库条目的 source_url 必须是字符串或 null');
  }
  return value;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}
