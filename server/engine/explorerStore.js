// explorer_stories / explorer_sessions 两张表的存取。
//
// ⚠️ 这两张表里的是**真人可识别信息**（化名、身份、所在地、职业、
// 家庭创伤细节、诊断词）。它们只存在于数据库里：
//   - 不进版本库（仓库是 public 的）；
//   - 不进镜像（不进任何 prompt 文件）；
//   - **不提供公开读接口** —— 只有 admin 接口与模型注入通道能读到。
//
// 正文由 scripts/seed-explorer-stories.mjs 从**本地**的
// docs/探索者故事/*.md 解析后写入（那个目录在 .gitignore 里）。

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 脏数据不能让整站崩掉 —— 宁可当空数组。
    return [];
  }
}

function rowToStory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    aliases: parseJsonArray(row.aliases),
    category: row.category || null,
    education_level: row.education_level || null,
    one_liner: row.one_liner || '',
    match_signals: parseJsonArray(row.match_signals),
    tags: parseJsonArray(row.tags),
    // segments: [{label, text}] —— label 是原文章的小标题，
    // **只是分段记号，端上不显示**（模型也不许把它说出来）。
    segments: parseJsonArray(row.segments),
    guide: row.guide || null,
    safety: row.safety || null,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 探索者故事的存取。
 *
 * @param {object} params
 * @param {object} params.db 数据库连接
 */
export function createExplorerStore({ db } = {}) {
  if (!db) {
    throw new Error('createExplorerStore 需要 db：探索者素材存在数据库里');
  }

  function listAll() {
    return db
      .prepare('SELECT * FROM explorer_stories ORDER BY id')
      .all()
      .map(rowToStory);
  }

  function listActive() {
    return db
      .prepare('SELECT * FROM explorer_stories WHERE is_active = 1 ORDER BY id')
      .all()
      .map(rowToStory);
  }

  function get(id) {
    return rowToStory(db.prepare('SELECT * FROM explorer_stories WHERE id = ?').get(id));
  }

  /**
   * 写入（按 id 覆盖）。
   *
   * 为什么是「覆盖」而不是「追加」：seed 脚本要能**反复跑**（素材改了重跑一次），
   * 而 id 是稳定的（来自文件名）⇒ 同一个 id 的新版本直接盖掉旧的，
   * 不会攒出一堆重复行。
   */
  function upsert(story) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO explorer_stories
         (id, name, aliases, category, education_level, one_liner,
          match_signals, tags, segments, guide, safety, is_active,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         aliases = excluded.aliases,
         category = excluded.category,
         education_level = excluded.education_level,
         one_liner = excluded.one_liner,
         match_signals = excluded.match_signals,
         tags = excluded.tags,
         segments = excluded.segments,
         guide = excluded.guide,
         safety = excluded.safety,
         is_active = excluded.is_active,
         updated_at = excluded.updated_at`
    ).run(
      story.id,
      story.name,
      JSON.stringify(story.aliases || []),
      story.category || null,
      story.education_level || null,
      story.one_liner || '',
      JSON.stringify(story.match_signals || []),
      JSON.stringify(story.tags || []),
      JSON.stringify(story.segments || []),
      story.guide || null,
      story.safety || null,
      story.is_active === false ? 0 : 1,
      now,
      now
    );
    return get(story.id);
  }

  function setActive(id, isActive) {
    db.prepare('UPDATE explorer_stories SET is_active = ?, updated_at = ? WHERE id = ?').run(
      isActive ? 1 : 0,
      new Date().toISOString(),
      id
    );
  }

  function remove(id) {
    db.prepare('DELETE FROM explorer_stories WHERE id = ?').run(id);
  }

  // ── 会话状态 ────────────────────────────────────────────────────

  function getSession(conversationId) {
    if (!conversationId) return null;
    const row = db
      .prepare('SELECT * FROM explorer_sessions WHERE conversation_id = ?')
      .get(conversationId);
    if (!row) return null;
    return {
      conversation_id: row.conversation_id,
      phase: row.phase,
      selected_id: row.selected_id,
      base_assistant_count: row.base_assistant_count,
      updated_at: row.updated_at,
    };
  }

  function setSession(conversationId, { phase, selected_id = null, base_assistant_count = 0 }) {
    if (!conversationId) return;
    db.prepare(
      `INSERT INTO explorer_sessions
         (conversation_id, phase, selected_id, base_assistant_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         phase = excluded.phase,
         selected_id = excluded.selected_id,
         base_assistant_count = excluded.base_assistant_count,
         updated_at = excluded.updated_at`
    ).run(
      conversationId,
      phase,
      selected_id,
      base_assistant_count,
      new Date().toISOString()
    );
  }

  function resetSession(conversationId) {
    if (!conversationId) return;
    db.prepare('DELETE FROM explorer_sessions WHERE conversation_id = ?').run(conversationId);
  }

  return {
    listAll,
    listActive,
    get,
    upsert,
    setActive,
    remove,
    getSession,
    setSession,
    resetSession,
  };
}
