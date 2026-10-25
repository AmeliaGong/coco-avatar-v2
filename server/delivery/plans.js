// 方案、练习项与练习证据。
//
// **plans.payload 是内容真相源，practices 是执行层索引。**
// 为什么不是两份独立的数据：练习项既要给用户看（内容），又要挂证据
// （需要一个稳定 id）。两份各存一份必然漂移 —— 教练改了一处，另一处
// 还是旧的。所以内容只存在 payload 里，practices 行由 payload 物化出来，
// 唯一的职责是提供一个稳定 id 给 evidences 外键用。

import { randomUUID } from 'node:crypto';

const PLAN_STATUSES = ['draft', 'pending_activation', 'active', 'archived'];
const PLAN_MODES = ['sequence', 'daily_repeat'];

function now() {
  return new Date().toISOString();
}

// 练习项的匹配：payload 里的一条练习，应该对应到哪一行已有的 practice。
//
// 纯函数：不吃数据库、不看时钟。
//
// **为什么要分级匹配（增补 D 的修正）**：14 天 Circle 天然是 14 张同名卡
// （同一个圈，14 个不同情景）。只按 title 匹配的话，Map 里只留得下第一行，
// 其余 13 行每次保存都变成新建行 → id 变 → 挂在上面的练习证据全部失联。
//
// 匹配优先级：
//   1. (title, day) 完全一致
//   2. 同 title，取 day 最接近的
//   3. 同 day
//   4. 都没有 —— 调用方新建一行
export function pickPracticeMatch(candidates, { title, day } = {}) {
  const t = typeof title === 'string' ? title.trim() : '';
  const d = Number.isInteger(day) ? day : null;
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const exact = candidates.find(c => c.title === t && c.day === d);
  if (exact) return exact;

  const sameTitle = candidates.filter(c => c.title === t);
  if (sameTitle.length) {
    if (d === null) return sameTitle[0];
    return sameTitle.reduce((best, c) => {
      const dist = (row) => (Number.isInteger(row.day) ? Math.abs(row.day - d) : Infinity);
      return dist(c) < dist(best) ? c : best;
    }, sameTitle[0]);
  }

  if (d !== null) {
    const sameDay = candidates.find(c => c.day === d);
    if (sameDay) return sameDay;
  }

  return null;
}

export function createPlanStore({ db }) {
  if (!db) throw new Error('createPlanStore 需要 db');

  function getRow(planId) {
    return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) || null;
  }

  // 把 payload.practices 物化成 practice 行。
  //
  // 匹配用 pickPracticeMatch（分级匹配，增补 D）—— 14 张同名卡也能对上，
  // id 保住，证据不失联。
  function materialize(planId, payload) {
    const existing = db
      .prepare('SELECT * FROM practices WHERE plan_id = ? ORDER BY sort_order ASC')
      .all(planId);
    const incoming = Array.isArray(payload?.practices) ? payload.practices : [];
    const used = new Set();

    incoming.forEach((p, index) => {
      const title = typeof p?.title === 'string' ? p.title.trim() : '';
      if (!title) return;
      const day = Number.isInteger(p.day) ? p.day : index + 1;
      const candidates = existing.filter(c => !used.has(c.id));
      const matched = pickPracticeMatch(candidates, { title, day });
      const values = {
        day,
        intent: p.intent || null,
        action: p.action || null,
        evidence_prompt: p.evidence_prompt || null,
        success_criteria: p.success_criteria || null,
        circle: p.circle || null,
        scenario: p.scenario || null,
        target_belief: p.target_belief || null,
        sort_order: index,
      };
      if (matched) {
        used.add(matched.id);
        // **不碰 custom_data** —— 那是教练手工补充的个性化数据，
        // 不能被 AI 草稿冲掉。
        db.prepare(
          `UPDATE practices SET day = ?, intent = ?, action = ?, evidence_prompt = ?, success_criteria = ?,
             circle = ?, scenario = ?, target_belief = ?, sort_order = ? WHERE id = ?`
        ).run(
          values.day, values.intent, values.action, values.evidence_prompt, values.success_criteria,
          values.circle, values.scenario, values.target_belief, values.sort_order, matched.id
        );
      } else {
        db.prepare(
          `INSERT INTO practices (id, plan_id, day, title, intent, action, evidence_prompt, success_criteria,
             circle, scenario, target_belief, custom_data, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        ).run(
          randomUUID(), planId, values.day, title, values.intent, values.action, values.evidence_prompt,
          values.success_criteria, values.circle, values.scenario, values.target_belief, values.sort_order
        );
      }
    });

    // payload 里没有的旧行：不删（删了它的证据会变孤儿），只标记
    // sort_order = -1 表示已移出方案。移出后又加回来的行，靠 pickPracticeMatch
    // 按 (title, day) 找回原来的 id —— 所以这里不硬删。
    for (const row of existing) {
      if (!used.has(row.id)) {
        db.prepare('UPDATE practices SET sort_order = -1 WHERE id = ?').run(row.id);
      }
    }
  }

  function listPractices(planId) {
    return db
      .prepare('SELECT * FROM practices WHERE plan_id = ? AND sort_order >= 0 ORDER BY sort_order ASC')
      .all(planId);
  }

  // 全部练习行（含已被移出方案的），教练后台要看得到历史。
  function listAllPractices(planId) {
    return db
      .prepare('SELECT * FROM practices WHERE plan_id = ? ORDER BY sort_order ASC, day ASC')
      .all(planId);
  }

  // 建草稿方案。
  //
  // **整段包在事务里**：插方案 + 物化练习项是多步写入，中途失败会留下
  // 「方案落了、练习项没落」的半截数据 —— 那些行是查不出来也删不掉的孤儿。
  //
  // 参数名两种都收（clientId / client_id）：Task 3 与增补 B.3 各自的
  // 叫法不一样，两个入口都真实存在，统一成一种会让另一边报错。
  function createDraft(input = {}) {
    const clientId = input.clientId || input.client_id || null;
    if (!clientId) throw new Error('clientId 必填');
    const payload = input.payload;
    if (!payload || typeof payload !== 'object') throw new Error('payload 必填');
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) throw new Error('客户不存在');

    const mode = PLAN_MODES.includes(input.mode) ? input.mode : 'sequence';
    if (mode === 'daily_repeat') {
      const d = Number(input.repeat_days);
      if (!Number.isInteger(d) || d <= 0) throw new Error('repeat_days 必须是正整数');
    }
    const stuckPointId = input.stuckPointId || input.stuck_point_id || null;
    const supersedesId = input.supersedes_id || input.supersedesId || null;
    const sourceSessionId = input.source_session_id || input.sourceSessionId || null;
    const journeyId = input.journey_id || input.journeyId || null;

    const id = randomUUID();
    const run = db.transaction(() => {
      // 轮次 = 同一个客户已有的方案数 + 1
      const count = db.prepare('SELECT COUNT(*) AS n FROM plans WHERE client_id = ?').get(clientId).n;
      db.prepare(
        `INSERT INTO plans (id, client_id, stuck_point_id, status, version, payload, diagnosis_md,
           round, supersedes_id, source_session_id, journey_id, mode, repeat_days, created_at)
         VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        clientId,
        stuckPointId,
        JSON.stringify(payload),
        input.diagnosisMd || input.diagnosis_md || null,
        count + 1,
        supersedesId,
        sourceSessionId,
        journeyId,
        mode,
        mode === 'daily_repeat' ? Number(input.repeat_days) : null,
        now()
      );
      materialize(id, payload);
    });
    run();
    return getRow(id);
  }

  function listByClient(clientId) {
    return db
      .prepare('SELECT * FROM plans WHERE client_id = ? ORDER BY created_at DESC')
      .all(clientId);
  }

  // 改方案内容。同样包在事务里：payload 与练习项必须一起成功或一起失败。
  function updatePayload(planId, payload) {
    const plan = getRow(planId);
    if (!plan) throw new Error('方案不存在');
    if (!payload || typeof payload !== 'object') throw new Error('payload 必填');
    if (plan.status !== 'draft') {
      throw new Error(`方案已经是 ${plan.status}，不能再改内容`);
    }
    const run = db.transaction(() => {
      db.prepare('UPDATE plans SET payload = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(payload), planId);
      materialize(planId, payload);
    });
    run();
    return getRow(planId);
  }

  function updateDiagnosisMd(planId, diagnosisMd) {
    const plan = getRow(planId);
    if (!plan) throw new Error('方案不存在');
    db.prepare('UPDATE plans SET diagnosis_md = ? WHERE id = ?').run(diagnosisMd || null, planId);
    return getRow(planId);
  }

  function updatePractice(planId, practiceId, patch = {}) {
    const row = db.prepare('SELECT * FROM practices WHERE id = ? AND plan_id = ?').get(practiceId, planId);
    if (!row) throw new Error('练习项不存在');
    const next = {
      title: patch.title !== undefined ? String(patch.title).trim() : row.title,
      day: patch.day !== undefined ? patch.day : row.day,
      intent: patch.intent !== undefined ? patch.intent : row.intent,
      action: patch.action !== undefined ? patch.action : row.action,
      evidence_prompt: patch.evidence_prompt !== undefined ? patch.evidence_prompt : row.evidence_prompt,
      success_criteria: patch.success_criteria !== undefined ? patch.success_criteria : row.success_criteria,
      circle: patch.circle !== undefined ? patch.circle : row.circle,
      scenario: patch.scenario !== undefined ? patch.scenario : row.scenario,
      target_belief: patch.target_belief !== undefined ? patch.target_belief : row.target_belief,
      custom_data: patch.custom_data !== undefined ? patch.custom_data : row.custom_data,
    };
    if (!next.title) throw new Error('title 不能为空');
    db.prepare(
      `UPDATE practices SET title = ?, day = ?, intent = ?, action = ?, evidence_prompt = ?, success_criteria = ?,
         circle = ?, scenario = ?, target_belief = ?, custom_data = ?
       WHERE id = ?`
    ).run(
      next.title, next.day, next.intent, next.action, next.evidence_prompt, next.success_criteria,
      next.circle, next.scenario, next.target_belief, next.custom_data, practiceId
    );
    return db.prepare('SELECT * FROM practices WHERE id = ?').get(practiceId);
  }

  function publish(planId) {
    const plan = getRow(planId);
    if (!plan) throw new Error('方案不存在');
    if (plan.status !== 'draft') {
      throw new Error(`方案当前是 ${plan.status}，只有 draft 能发布为 pending_activation`);
    }
    db.prepare("UPDATE plans SET status = 'pending_activation', published_at = ? WHERE id = ?").run(now(), planId);
    return getRow(planId);
  }

  function activate(planId) {
    const plan = getRow(planId);
    if (!plan) throw new Error('方案不存在');
    if (plan.status !== 'pending_activation') {
      throw new Error(`方案当前是 ${plan.status}，只有 pending_activation 能激活`);
    }
    db.prepare("UPDATE plans SET status = 'active', activated_at = ? WHERE id = ?").run(now(), planId);
    return getRow(planId);
  }

  function archive(planId) {
    const plan = getRow(planId);
    if (!plan) throw new Error('方案不存在');
    db.prepare("UPDATE plans SET status = 'archived', archived_at = ? WHERE id = ?").run(now(), planId);
    return getRow(planId);
  }

  function addEvidence({ practiceId, clientId, content, occurredAt = null } = {}) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) throw new Error('content 必填');
    const practice = db.prepare('SELECT * FROM practices WHERE id = ?').get(practiceId);
    if (!practice) throw new Error('练习项不存在');
    const id = randomUUID();
    db.prepare(
      'INSERT INTO evidences (id, practice_id, client_id, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, practiceId, clientId, text, occurredAt, now());
    return db.prepare('SELECT * FROM evidences WHERE id = ?').get(id);
  }

  function listEvidences(planId) {
    return db
      .prepare(
        `SELECT e.*, p.title AS practice_title, p.sort_order AS practice_sort_order
         FROM evidences e
         JOIN practices p ON p.id = e.practice_id
         WHERE p.plan_id = ?
         ORDER BY e.created_at ASC`
      )
      .all(planId);
  }

  // 客户当前生效的方案：优先 active，其次 pending_activation。
  // 用户端只认这一个 —— 两个方案同时挂着会让用户不知道该练哪个。
  function findCurrentForClient(clientId) {
    const active = db
      .prepare("SELECT * FROM plans WHERE client_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(clientId);
    if (active) return active;
    return db
      .prepare("SELECT * FROM plans WHERE client_id = ? AND status = 'pending_activation' ORDER BY created_at DESC LIMIT 1")
      .get(clientId) || null;
  }

  // 取代链的尽头：轮次最高的那个（增补 B.3）。
  function findLatestForClient(clientId) {
    return db
      .prepare('SELECT * FROM plans WHERE client_id = ? ORDER BY round DESC, created_at DESC LIMIT 1')
      .get(clientId) || null;
  }

  function getBundle(planId) {
    const plan = getRow(planId);
    if (!plan) return null;
    return {
      plan,
      practices: listAllPractices(planId),
      evidences: listEvidences(planId),
    };
  }

  return {
    createDraft,
    listByClient,
    get: getRow,
    getBundle,
    listPractices,
    listAllPractices,
    updatePayload,
    updateDiagnosisMd,
    updatePractice,
    publish,
    activate,
    archive,
    addEvidence,
    listEvidences,
    findCurrentForClient,
    findLatestForClient,
    statuses: PLAN_STATUSES,
  };
}
