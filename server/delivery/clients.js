// 客户与「会话 / 卡点」的挂载关系。
//
// 为什么不把 SQL 直接写在 server.js 里：交付模块的表有六张，路由会变成
// 一堆 prepare 的复制粘贴。这里的每个函数都只做一件事，且都能被单测覆盖。
//
// 两条不可让步的规则：
//   1. **教练私有备注（notes）只走 admin 接口**，任何用户端接口都不返回它。
//   2. **external_id 唯一** —— 同一 external_id 绝不建第二个档，否则支付
//      回调重放会造出两个客户。

import { randomUUID } from 'node:crypto';

const CLIENT_STATUSES = ['active', 'archived'];

// 卡点的来源：AI 从对话里提的、教练手录的、引擎抽取的。
// 为什么不做成白名单枚举挂在表上：source 是**给人看的标签**，不是路由依据 ——
// 将来多一种来源不该需要改代码。
const STUCK_POINT_SOURCES = ['conversation', 'extracted', 'manual'];

function now() {
  return new Date().toISOString();
}

// 从会话的结构化输出里读出卡点。messages.structured_json 存的是契约 1
// 归一化后的 JSON —— 这里只取认识的字段，其余忽略。
function readStuckPointFromMessage(row) {
  if (!row || !row.structured_json) return null;
  let parsed;
  try {
    parsed = JSON.parse(row.structured_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) return null;
  return {
    title,
    belief: typeof parsed.belief === 'string' ? parsed.belief : null,
    evidence_against: Array.isArray(parsed.evidence_against) ? parsed.evidence_against : null,
    emotion: typeof parsed.emotion === 'string' ? parsed.emotion : null,
    micro_action: typeof parsed.micro_action === 'string' ? parsed.micro_action : null,
  };
}

// DB 里 evidence_against 存的是 JSON 字符串（要能被 SQL 过滤，也省得
// 迁移历史行）。给人看的形状是数组 —— 这里统一解开。
function parseJsonArray(text) {
  if (Array.isArray(text)) return text;
  if (typeof text !== 'string' || !text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function createClientStore({ db }) {
  if (!db) throw new Error('createClientStore 需要 db');

  function create(input = {}) {
    const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : '';
    if (!displayName) throw new Error('display_name 必填');
    const externalId = input.external_id ? String(input.external_id) : null;
    if (externalId) {
      const existing = db.prepare('SELECT id FROM clients WHERE external_id = ?').get(externalId);
      if (existing) throw new Error(`external_id 已存在（客户 ${existing.id}），不重复建档`);
    }
    const id = randomUUID();
    const ts = now();
    db.prepare(
      `INSERT INTO clients (id, display_name, phone, email, source, external_id, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      displayName,
      input.phone || null,
      input.email || null,
      input.source || 'manual',
      externalId,
      'active',
      input.notes || null,
      ts,
      ts
    );
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  }

  function list() {
    return db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM plans p WHERE p.client_id = c.id) AS plan_count,
                (SELECT COUNT(*) FROM conversations v WHERE v.client_id = c.id) AS conversation_count,
                (SELECT MAX(v.created_at) FROM conversations v WHERE v.client_id = c.id) AS last_conversation_at
         FROM clients c
         ORDER BY c.created_at DESC`
      )
      .all();
  }

  function get(id) {
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
  }

  function update(id, patch = {}) {
    const existing = get(id);
    if (!existing) throw new Error('客户不存在');
    const next = {
      display_name: patch.display_name !== undefined ? String(patch.display_name).trim() : existing.display_name,
      phone: patch.phone !== undefined ? patch.phone : existing.phone,
      email: patch.email !== undefined ? patch.email : existing.email,
      status: patch.status !== undefined ? patch.status : existing.status,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
    };
    if (!next.display_name) throw new Error('display_name 不能为空');
    if (!CLIENT_STATUSES.includes(next.status)) throw new Error(`status 只能是 ${CLIENT_STATUSES.join(' / ')}`);
    db.prepare(
      'UPDATE clients SET display_name = ?, phone = ?, email = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?'
    ).run(next.display_name, next.phone, next.email, next.status, next.notes, now(), id);
    return get(id);
  }

  function attachConversations(clientId, conversationIds = []) {
    const client = get(clientId);
    if (!client) throw new Error('客户不存在');
    if (!Array.isArray(conversationIds)) throw new Error('conversationIds 必须是数组');
    let attached = 0;
    const skipped = [];
    for (const convId of conversationIds) {
      // 每一项都要类型守卫：请求体里的元素可能是对象，而 better-sqlite3
      // 绑对象会抛 RangeError（底座 Task 8 修的 /api/chat client_id 就是
      // 这一类崩溃点 —— 一个 rejection 打死单进程，整站掉线）。
      if (typeof convId !== 'string' || convId.trim() === '') {
        throw new Error('conversationIds 里每一项必须是非空字符串');
      }
      const conv = db.prepare('SELECT id, client_id FROM conversations WHERE id = ?').get(convId);
      if (!conv) {
        skipped.push(convId);
        continue;
      }
      // 「已经属于别的客户」只在它指的是**另一个真实客户**时才算。
      //
      // 底座的 conversations.client_id 是**客户端自报的标签**（不是凭证），
      // 老会话里可能是 'a'、'manchi' 这种随手写的字符串，也可能是上一版
      // 前端自造的 id。拿它跟 clients.id 比，会把「标签不同」误判成
      // 「改嫁」，教练就没法把老会话挂到客户名下 —— 所以先查它是不是
      // 一个真实的 client id，是才判改嫁。
      const owner = conv.client_id
        ? db.prepare('SELECT id FROM clients WHERE id = ?').get(conv.client_id)
        : null;
      if (owner && owner.id !== clientId) {
        throw new Error(`会话 ${convId} 已经属于别的客户，不能改嫁`);
      }
      if (!conv.client_id || conv.client_id !== clientId) {
        db.prepare('UPDATE conversations SET client_id = ? WHERE id = ?').run(clientId, convId);
        attached += 1;
      }
      // link_kind = 'client'：**这条关联是教练建立的**，不是来访者自报的。
      //
      // conversations.client_id 本身是公开 /api/chat 允许调用方自己填的
      // 「自报标签」—— 只看它，用户可以新建一个会话、把 client_id 填成
      // 别的客户的 id，然后读到那个客户的方案。
      //
      // 用户端判定「这个会话归这个教练客户管」时，会**同时**要求
      // link_kind = 'client'（见 userService.clientIdByConversation）。
      // 这个标记只有这里会写，公开路径永远写不到它。
      db.prepare('UPDATE conversations SET link_kind = ? WHERE id = ?').run('client', convId);
    }
    return { attached, skipped };
  }

  function listConversations(clientId) {
    return db
      .prepare(
        `SELECT v.id, v.title, v.created_at, v.expires_at, v.status, v.scenario,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = v.id) AS message_count,
                (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = v.id) AS last_message_at
         FROM conversations v
         WHERE v.client_id = ?
         ORDER BY v.created_at DESC`
      )
      .all(clientId);
  }

  function getWithConversations(clientId) {
    const client = get(clientId);
    if (!client) return null;
    return { ...client, conversations: listConversations(clientId) };
  }

  // 从会话的助手消息里抽卡点。已经导入过的（同一 client + 同一 title）
  // 跳过 —— 重复导入会造出两条一样的卡点。
  function importStuckPointsFromConversations(clientId, conversationIds = []) {
    const created = [];
    for (const convId of conversationIds) {
      const rows = db
        .prepare(
          "SELECT structured_json FROM messages WHERE conversation_id = ? AND role = 'assistant' AND structured_json IS NOT NULL ORDER BY id ASC"
        )
        .all(convId);
      for (const row of rows) {
        const sp = readStuckPointFromMessage(row);
        if (!sp) continue;
        const dup = db
          .prepare('SELECT id FROM stuck_points WHERE client_id IS ? AND title = ?')
          .get(clientId, sp.title);
        if (dup) continue;
        const id = randomUUID();
        db.prepare(
          `INSERT INTO stuck_points (id, client_id, source, title, belief, evidence_against, emotion, micro_action, raw_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          clientId,
          'chat',
          sp.title,
          sp.belief,
          sp.evidence_against ? JSON.stringify(sp.evidence_against) : null,
          sp.emotion,
          sp.micro_action,
          row.structured_json,
          now()
        );
        const inserted = db.prepare('SELECT * FROM stuck_points WHERE id = ?').get(id);
        // 这里把 evidence_against 解成数组再交出去：调用方（教练后台）
        // 要的是「一条条的反面证据」，不是一坨 JSON 字符串。
        created.push({ ...inserted, evidence_against: parseJsonArray(inserted.evidence_against) });
      }
    }
    return created;
  }

  function listStuckPoints(clientId) {
    return db
      .prepare('SELECT * FROM stuck_points WHERE client_id = ? ORDER BY created_at DESC')
      .all(clientId)
      .map((row) => ({ ...row, evidence_against: parseJsonArray(row.evidence_against) }));
  }

  // 教练手录卡点。永远是有的兜底 —— AI 提的卡点教练可以改，
  // 提错了教练可以自己重写。
  function addStuckPoint(clientId, input = {}) {
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) throw new Error('客户不存在');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('title 必填');
    const toArr = v => {
      if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
      if (typeof v === 'string' && v.trim()) return v.trim().split('\n').map(s => s.trim()).filter(Boolean);
      return [];
    };
    const source = STUCK_POINT_SOURCES.includes(input.source) ? input.source : 'manual';
    const id = randomUUID();
    db.prepare(
      `INSERT INTO stuck_points (id, client_id, source, title, belief, evidence_against, emotion, micro_action, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      clientId,
      source,
      title,
      typeof input.belief === 'string' ? input.belief : '',
      JSON.stringify(toArr(input.evidence_against)),
      typeof input.emotion === 'string' ? input.emotion : '',
      typeof input.micro_action === 'string' ? input.micro_action : '',
      input.raw_json ? JSON.stringify(input.raw_json) : null,
      now()
    );
    return db.prepare('SELECT * FROM stuck_points WHERE id = ?').get(id);
  }

  // 存引擎提取出来的卡点。source 标成 'extracted'，
  // 教练在页面上能看出这条是 AI 提的（可以改）。
  function addExtractedStuckPoint(clientId, stuckPoint = {}) {
    return addStuckPoint(clientId, {
      title: stuckPoint.title,
      belief: stuckPoint.belief,
      evidence_against: stuckPoint.evidence_against,
      emotion: stuckPoint.emotion,
      micro_action: stuckPoint.micro_action,
      raw_json: stuckPoint,
      source: 'extracted',
    });
  }

  return {
    create,
    list,
    get,
    update,
    attachConversations,
    listConversations,
    getWithConversations,
    importStuckPointsFromConversations,
    listStuckPoints,
    addStuckPoint,
    addExtractedStuckPoint,
  };
}
