// 用户端的业务逻辑 —— **唯一一份**。
//
// 为什么必须有这一层：12 月的 WeStream 小程序不能直连 Coco Avatar
// （fly.dev 无法 ICP 备案），只能走微信云函数 BFF → `/api/internal/*`；
// 而试点期的网页走 `/api/conversations/:id/plan`。
// 两条通路必须算出**一模一样**的进度 —— 「今天显示第 3 天、教练那边显示
// 第 4 天」是用户直接看得见的错。所以两层路由之间只允许差两件事：
// **拿哪个 id 找人**、**用哪种鉴权**。其余逻辑全在这里，只写一遍。
//
// **打卡是唯一真相源在 Coco Avatar**：`evidences` 一落库，
// 用户端与教练端看到的进度必须一致 —— 进度计算（computeProgress）
// 因此只能在 service 层算一次，路由层不许自己数。

import { computeProgress, pickCurrentPractice } from './progress.js';

// 打卡内容的**长度上限**。
//
// 一条打卡是「我今天做了什么」—— 几百字到一两千字就够。上限的作用是
// 挡住「把一整本书贴进来」这类把数据库撑大的用法，也是给教练后台的
// 展示留出余量（列表页要显示全文摘要）。
const MAX_EVIDENCE_CONTENT = 4000;

// 每个客户**每 10 分钟最多 20 次**打卡写入。
//
// 为什么要限：公开层的凭证是链接（拿到链接就能打），internal 层的凭证是
// service token —— 两者都挡不住「脚本无限刷」。一次无限刷会做两件事：
// 把 evidences 表撑大、把教练后台的「最近打卡」列表冲掉（真正要看的东西
// 被淹了）。
//
// 20 次 / 10 分钟 ≈ 每 30 秒一次 —— 正常人一天打卡一两次，绰绰有余。
//
// ⚠️ 限流状态是**进程内内存**的：重启即清零。多实例部署需要换成共享存储
// （Redis 之类）。现在 fly.io 是**单进程**，所以进程内状态就是全局状态。
const EVIDENCE_RATE_LIMIT = 20;
const EVIDENCE_RATE_WINDOW_MS = 10 * 60 * 1000;

// 面向用户的错误：自带 HTTP 状态码 + 中文文案。
//
// 为什么不用 server/errorStatus.js：那张表是「引擎错误码 → 状态码」的映射，
// 用户端这些是「请求参数不对 / 方案状态不对」，不属于引擎那一类。
export class UserServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UserServiceError';
    this.status = status;
  }
}

// 两层路由共用的错误出口 —— **同一个实现**，避免两个路由各写一份
// 「如果是 UserServiceError 就回 4xx，否则回 500」。
export function respondWithServiceError(res, err) {
  if (err instanceof UserServiceError) {
    return res.status(err.status).json({ error: err.message });
  }
  // 未预期的错误（DB 坏了之类）：只记日志，不把内部细节泄给客户端。
  console.error('交付模块用户端接口出错:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

export function createUserService({ db, plans } = {}) {
  if (!db || !plans) throw new Error('createUserService 需要 db 与 plans');

  // 打卡限流状态：clientId → 最近 N 次写入的时间戳。
  //
  // **两层路由共用同一份**（service 是单例）—— 公开层和 internal 层
  // 各限各的的话，绕过 BFF 走公开层就能把限流绕过去。
  const evidenceHits = new Map();

  function checkEvidenceRate(clientId) {
    const now = Date.now();
    const hits = (evidenceHits.get(clientId) || []).filter(
      (t) => now - t < EVIDENCE_RATE_WINDOW_MS
    );
    if (hits.length >= EVIDENCE_RATE_LIMIT) {
      // 先把旧的记下来（这次不算命中，但窗口内的命中数要留着）
      evidenceHits.set(clientId, hits);
      throw new UserServiceError(429, '打卡太频繁了，休息一下再来');
    }
    hits.push(now);
    evidenceHits.set(clientId, hits);
  }

  // 只查 id —— **不 SELECT clients.notes**。
  // 教练私有备注不是来访者的东西；用「查全表再删字段」的那种写法，
  // 将来有人往 clients 上加一列就可能顺手带出去。这里从源头不查。
  function clientExists(clientId) {
    return !!db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  }

  // 会话 → 客户 id。**公开路由按 conversation_id 找人，靠的就是这一跳。**
  // 找不到（会话不存在 / 没关联客户）返回 null —— 公开层的语义是
  // 「没有方案」，不是「你无权访问」。
  //
  // ⚠️ **必须同时要求 link_kind = 'client'。**
  //
  // `conversations.client_id` 是**客户端自报的标签**（底座 Task 8 的设计）：
  // 公开的 /api/chat 允许调用方自己填 client_id。所以**只**看 client_id
  // 是不够的 —— 任何人都能新建一个会话、把自己的 client_id 填成某个
  // 真实客户的 id，然后打开 /api/conversations/:id/plan 读到那个客户的
  // 方案（含 1v1 诊断结论与信念系统）。
  //
  // 而 client_id 一旦泄露就很容易泄露：GET /api/conversations/:id 是
  // 零鉴权的、把整行会话（含 client_id）吐出来 —— 把链接转发给别人，
  // 对方就拿到了这个 id。
  //
  // `link_kind` 正好是那个「不是自报、而是教练建立的」标记：
  // 它只有教练在交付后台挂载会话时才会被写成 'client'，
  // 公开路径碰都不碰它（默认 'test'）。
  //
  // 所以这里的判据是**两个条件同时成立**：
  //   link_kind = 'client'（教练挂载的）**且** client_id 非空（挂到了谁名下）
  function clientIdByConversation(conversationId) {
    const conv = db
      .prepare('SELECT id, client_id, link_kind FROM conversations WHERE id = ?')
      .get(conversationId);
    if (!conv || !conv.client_id) return null;
    if (conv.link_kind !== 'client') return null;
    return conv.client_id;
  }

  // 客户当前生效的方案 + 它的练习项 + 证据。
  //
  // findCurrentForClient：优先 active，其次 pending_activation。
  // 两个方案同时挂着会让用户不知道该练哪个，所以用户端只认这一个。
  function loadBundle(clientId) {
    const plan = plans.findCurrentForClient(clientId);
    if (!plan) return null;
    return {
      plan,
      practices: plans.listPractices(plan.id),
      evidences: plans.listEvidences(plan.id),
    };
  }

  // ---- 字段白名单 --------------------------------------------------
  // 响应是**逐字段挑出来**的，不是查全表再删字段。
  // 这样将来 clients / plans 上加任何列，都不可能顺流到用户端。

  function pickVision(vision) {
    if (!vision || typeof vision !== 'object') return null;
    return {
      title: vision.title ?? null,
      narrative: vision.narrative ?? null,
      horizon: vision.horizon ?? null,
    };
  }

  // 信念系统（C.1）：核心新信念 + 外周信念 + 本期不主攻的议题。
  // 「本期不碰什么」要给用户看 —— 写出来是让它在合适的时候出现。
  function pickBeliefSystem(bs) {
    if (!bs || typeof bs !== 'object') return null;
    const peripheral = Array.isArray(bs.peripheral)
      ? bs.peripheral
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            name: p.name ?? null,
            statement: p.statement ?? null,
            new_voice: p.new_voice ?? null,
          }))
      : [];
    const deferred = Array.isArray(bs.deferred)
      ? bs.deferred.filter((d) => typeof d === 'string')
      : [];
    return {
      core_new: bs.core_new ?? null,
      peripheral,
      deferred,
    };
  }

  function pickDiagnosis(diagnosis) {
    if (!diagnosis || typeof diagnosis !== 'object') return null;
    return {
      core_belief: diagnosis.core_belief ?? null,
      pattern: diagnosis.pattern ?? null,
      root_cause: diagnosis.root_cause ?? null,
      belief_system: pickBeliefSystem(diagnosis.belief_system),
    };
  }

  function pickPractice(p) {
    return {
      id: p.id,
      day: p.day ?? null,
      title: p.title,
      intent: p.intent ?? null,
      action: p.action ?? null,
      evidence_prompt: p.evidence_prompt ?? null,
      success_criteria: p.success_criteria ?? null,
      // 增补 D.0.2：14 张卡要能说出「用哪个圈 / 今天什么情景 / 打哪条信念」。
      circle: p.circle ?? null,
      scenario: p.scenario ?? null,
      target_belief: p.target_belief ?? null,
    };
  }

  // 组装一份用户端可见的方案视图。
  //
  // **这里是「进度只算一次」的落点**：教练端与用户端看到的数字都出自
  // 这一处 computeProgress。
  function buildView(bundle) {
    if (!bundle) return { has_plan: false };
    const { plan, practices, evidences } = bundle;

    let payload = {};
    try {
      payload = JSON.parse(plan.payload);
    } catch {
      // payload 坏了不能让整个接口挂掉 —— 用户至少还能看到练习清单。
      payload = {};
    }

    const done = new Set(evidences.map((e) => e.practice_id));
    const current = pickCurrentPractice(practices, evidences);
    const progress = computeProgress(practices, evidences);

    return {
      has_plan: true,
      status: plan.status,
      plan_id: plan.id,
      // 'sequence'（一天一张，14 张依次走）还是 'daily_repeat'（同一条每天重复）
      // —— 前端据此显示「第 N / M 天」。老方案没这列时按 sequence 算。
      mode: plan.mode || 'sequence',
      worth_practicing: payload.worth_practicing !== false,
      vision: pickVision(payload.vision),
      diagnosis: pickDiagnosis(payload.diagnosis),
      practices: practices.map((p) => ({
        ...pickPractice(p),
        done: done.has(p.id),
        evidence_count: evidences.filter((e) => e.practice_id === p.id).length,
      })),
      current_practice: current ? pickPractice(current) : null,
      evidences: evidences.map((e) => ({
        id: e.id,
        practice_id: e.practice_id,
        content: e.content,
        created_at: e.created_at,
      })),
      progress: {
        ...progress,
        // 当前卡是谁 —— 前端据此判断「今天做这个」。
        current_practice_id: current ? current.id : null,
      },
    };
  }

  // ---- 对外动作（按客户 id，两层路由共用）--------------------------

  function getPlanForClient(clientId) {
    if (!clientExists(clientId)) {
      throw new UserServiceError(404, '客户不存在');
    }
    return buildView(loadBundle(clientId));
  }

  function getPlanForConversation(conversationId) {
    const clientId = clientIdByConversation(conversationId);
    if (!clientId) return { has_plan: false };
    return buildView(loadBundle(clientId));
  }

  function startPlanForClient(clientId) {
    if (!clientExists(clientId)) {
      throw new UserServiceError(404, '客户不存在');
    }
    const bundle = loadBundle(clientId);
    if (!bundle) throw new UserServiceError(404, '没有可开始的方案');
    if (bundle.plan.status === 'pending_activation') {
      plans.activate(bundle.plan.id);
    } else if (bundle.plan.status !== 'active') {
      throw new UserServiceError(400, `方案当前是 ${bundle.plan.status}，不能开始`);
    }
    return buildView(loadBundle(clientId));
  }

  function startPlanForConversation(conversationId) {
    const clientId = clientIdByConversation(conversationId);
    if (!clientId) throw new UserServiceError(404, '没有可开始的方案');
    return startPlanForClient(clientId);
  }

  function addEvidenceForClient(clientId, body = {}) {
    if (!clientExists(clientId)) {
      throw new UserServiceError(404, '客户不存在');
    }
    const bundle = loadBundle(clientId);
    if (!bundle) throw new UserServiceError(404, '没有可回填的方案');
    if (bundle.plan.status !== 'active') {
      throw new UserServiceError(400, '方案还没开始，先点「开始练习」');
    }

    const practiceId = typeof body.practice_id === 'string' ? body.practice_id : '';
    // **校验练习项确实属于当前方案** —— 否则拿到链接的人可以把证据
    // 写到别人的练习上（或者写到已被移出方案的旧卡上）。
    const practice = bundle.practices.find((p) => p.id === practiceId);
    if (!practice) throw new UserServiceError(400, '练习项不属于当前方案');

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new UserServiceError(400, 'content 必填');
    if (content.length > MAX_EVIDENCE_CONTENT) {
      throw new UserServiceError(
        400,
        `打卡内容太长了（最多 ${MAX_EVIDENCE_CONTENT} 字，现在 ${content.length} 字）`
      );
    }

    // 限流**在真正写库之前**查 —— 超限的请求不该留下任何痕迹。
    checkEvidenceRate(clientId);

    try {
      plans.addEvidence({
        practiceId: practice.id,
        clientId,
        content,
      });
    } catch (err) {
      throw new UserServiceError(400, err.message);
    }
    return buildView(loadBundle(clientId));
  }

  function addEvidenceForConversation(conversationId, body = {}) {
    const clientId = clientIdByConversation(conversationId);
    if (!clientId) throw new UserServiceError(404, '没有可回填的方案');
    return addEvidenceForClient(clientId, body);
  }

  return {
    loadBundle,
    buildView,
    getPlanForClient,
    getPlanForConversation,
    startPlanForClient,
    startPlanForConversation,
    addEvidenceForClient,
    addEvidenceForConversation,
  };
}
