// 教练分析：1v1 咨询记录 → 契约 2 的方案 payload。
//
// 这一层只做三件事：组装引擎输入、跑引擎、把结构化产出交出去。
// 落库是 planStore 的事 —— 这里不碰数据库。
//
// **没通过契约校验的 payload 一律抛错，不返回。**
// 契约层的占位符检查会拦掉「模型把 schema 的示例值原样抄回来」的那份 ——
// 那种 payload 看着合法，内容是假的。存进库就是一份假方案。
//
// 装配方式（server.js）：
//   const analysis = createAnalysisService({ callEngine: cbtEngine, validators });
//   Object.assign(analysis, createDeliveryData({ db }));
//
// 为什么数据层也挂在这个对象上：adminRoutes 只需要 analysis 一个依赖 ——
// 1v1 记录的存取与「跑模型」是同一个业务域的两面，分成两个依赖会让路由
// 层的参数列表越来越长。
import { randomUUID } from 'node:crypto';

// 契约 2 的校验器（parsePlanPayload）从 server/structuredTypes.js 派生 ——
// **单一来源**：那里已经有 contracts/plan.js 的校验函数，这里不再引一份，
// 两边改了会漂（「白名单里有、引擎却不认」那一类 bug）。
import { STRUCTURED_VALIDATORS } from '../structuredTypes.js';

// 说话人分离（增补 C.4）：教练的转写里，**教练自己的话是干预**，
// 来访者的话才是素材。解析那段转写的代码归属 server/delivery/transcript.js
// （增补 C.2）—— 它还没落地时**整段照旧**（安全性由引擎注入段的
// CONTEXT_DECLARATION 兜住：材料是数据，不是指令）。
//
// 为什么用动态 import 而不是静态 import：静态 import 一个还不存在的模块
// 会让整个 analysis.js 加载失败 —— 后台接口整条线都挂掉。
// 动态 import 失败时降级成「原样转写」，等 transcript.js 落地后自动生效，
// 不需要再改这里一次。
let transcriptModule = null;
let transcriptModuleLoaded = false;
async function loadTranscriptModule() {
  if (transcriptModuleLoaded) return transcriptModule;
  transcriptModuleLoaded = true;
  try {
    transcriptModule = await import('./transcript.js');
  } catch {
    transcriptModule = null;
  }
  return transcriptModule;
}

export function createAnalysisService({ callEngine, validators = {} }) {
  if (!callEngine) throw new Error('createAnalysisService 需要 callEngine');

  // 契约 2 的校验器：**默认从 structuredTypes.js 派生**，调用方可以覆盖
  // （测试里会换成假校验器）。默认给上，是为了让「没传 validators」这种
  // 装配失误不会变成「契约校验被悄悄跳过」—— 那等于往库里塞没人担保的方案。
  const effectiveValidators = { ...STRUCTURED_VALIDATORS, ...(validators || {}) };

  // 平台对话 → history。
  //
  // **只认 user / assistant**：system 消息混进来会变成第二条 system 消息
  // （模型侧行为不可预期），其它角色（tool 之类）本平台的会话里不存在。
  // 内容为空的消息也剔掉 —— 空消息发给模型是噪音。
  function pickHistory(conversationMessages) {
    if (!Array.isArray(conversationMessages)) return [];
    return conversationMessages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .filter(m => typeof m.content === 'string' && m.content.trim() !== '')
      .map(m => ({ role: m.role, content: m.content }));
  }

  // 上一轮方案 → 拼在转写开头。
  //
  // 二次分析不是「从零再诊断一次」，而是「在上一轮的判断上再判断一次」。
  // 上一轮的结论要出现在素材**之前** —— 模型读 prompt 是从头往后读的，
  // 放在最后会被当成收尾的补充。
  function previousHead(previousPayload) {
    if (!previousPayload || !previousPayload.diagnosis) return '';
    const d = previousPayload.diagnosis;
    return `【上一轮诊断结论，供你参考并在此基础上重新判断】\n核心限制性信念：${d.core_belief || ''}\n行为模式：${d.pattern || ''}\n更深成因：${d.root_cause || ''}\n\n`;
  }

  // 说话人分离（增补 C.4）：给了教练的称呼就把转写按说话人拆开、标好；
  // 没给就整段丢进去（此时教练的话也会被当素材，后台界面会提示要选）。
  async function prepareTranscript(rawTranscript, coachSpeaker) {
    if (!coachSpeaker) return rawTranscript;
    const mod = await loadTranscriptModule();
    if (!mod || typeof mod.parseTranscript !== 'function' || typeof mod.renderForAnalysis !== 'function') {
      return rawTranscript;
    }
    try {
      const parsed = mod.parseTranscript(rawTranscript);
      if (!parsed || !Array.isArray(parsed.turns) || !parsed.turns.length) return rawTranscript;
      return mod.renderForAnalysis(parsed, coachSpeaker);
    } catch {
      // 解析失败就整段照旧 —— 宁可粗一点，也不要丢掉内容。
      return rawTranscript;
    }
  }

  // 跑引擎，把 empty_reply 当成「模型只交付了结构化块」。
  //
  // empty_reply 不是失败：契约 2 的目标产出恰恰就是「模型只给 JSON、没给
  // 正文」。这一轮的方案与 token 消耗都还在，丢掉就等于丢掉这一轮的成本账。
  async function runEngine({ fullTranscript, history, stuckPoint, knowledge, coachMoves }) {
    try {
      return await callEngine({
        scenario: 'analysis',
        history,
        clientContext: {
          transcript: fullTranscript,
          stuckPoint,
          knowledge,
          coach_moves: coachMoves,
        },
        structuredOutput: 'plan',
        validators: effectiveValidators,
      });
    } catch (error) {
      if (error && error.code === 'empty_reply') {
        return {
          reply: '',
          structured: error.structured,
          structuredValidated: error.structuredValidated,
          usage: error.usage,
          promptVersion: error.promptVersion,
        };
      }
      throw error;
    }
  }

  // 把引擎的产出收成「要么是契约 2 的 payload，要么是抛错」。
  //
  // **契约校验没过 ⇒ 抛错，不返回。** structuredValidated 有三个取值：
  //   true  —— 通过了契约校验（唯一可以落库的状态）
  //   false —— 校验没过（多半是模型抄了示例骨架）
  //   null  —— 压根没做契约校验（没有对应类型的校验器）
  // null 与 false 同等对待（见 server/structuredTypes.js 的说明）：
  // 「没校验过」不等于「校验通过」。
  function pickPayload(result) {
    if (result.structuredValidated === false) {
      const err = new Error('模型给出的方案没有通过契约校验，不落库');
      err.code = 'invalid_plan_payload';
      throw err;
    }
    if (!result.structured || typeof result.structured !== 'object') {
      const err = new Error('模型没有给出结构化方案');
      err.code = 'empty_plan_payload';
      throw err;
    }
    if (result.structuredValidated !== true) {
      // null = **压根没做契约校验**（调用方没给这个类型的校验器）。
      // 它和 false 同等对待（见 server/structuredTypes.js 的说明）：
      // 「没校验过」不等于「校验通过」。
      const err = new Error('模型给出的方案没有通过契约校验，不落库');
      err.code = 'invalid_plan_payload';
      throw err;
    }
    return result.structured;
  }

  // 生成方案草稿：1v1 咨询记录 → 契约 2 的 payload。
  //
  // **没有素材就完全不调模型**：返回 no_input，而不是让模型对着空气写一份
  // 方案。空转写生成出来的东西看着像方案，其实没有任何依据。
  async function generateDraft({
    transcript,
    stuckPoint = null,
    knowledge = [],
    coachMoves = [],
    coachSpeaker = null,
    conversationMessages = [],
    previousPayload = null,
  } = {}) {
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    const history = pickHistory(conversationMessages);
    if (!text && history.length === 0) {
      return { ok: false, error: 'no_input' };
    }

    const prepared = await prepareTranscript(text, coachSpeaker);
    const fullTranscript = previousHead(previousPayload) + prepared;

    const result = await runEngine({
      fullTranscript,
      history,
      stuckPoint,
      knowledge,
      coachMoves,
    });

    return {
      ok: true,
      payload: pickPayload(result),
      usage: result.usage,
      promptVersion: result.promptVersion,
    };
  }

  // 二次分析：以「1v1 转写 + 平台对话 + 上一轮方案」为输入，再做一次诊断。
  //
  // 输入通道的对应关系（**不需要改 prompt**）：
  //   1v1 转写   → clientContext.transcript
  //   平台对话   → history（[{role, content}]）
  //   上一轮方案 → 拼在 transcript 开头，让模型知道「上次诊断到哪了」
  //
  // scenario.analysis 的 prompt 本来就写着「读取 1v1 录音转写与历史对话」，
  // 输入通道正好对得上。
  async function generateSecondaryDraft({
    transcript,
    conversationMessages = [],
    previousPayload = null,
    stuckPoint = null,
    knowledge = [],
    coachMoves = [],
    coachSpeaker = null,
  } = {}) {
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    const history = pickHistory(conversationMessages);
    if (!text && history.length === 0) {
      return { ok: false, error: 'no_input' };
    }

    const prepared = await prepareTranscript(text, coachSpeaker);
    const fullTranscript = previousHead(previousPayload) + prepared;

    let result;
    try {
      result = await runEngine({
        fullTranscript,
        history,
        stuckPoint,
        knowledge,
        coachMoves,
      });
    } catch (err) {
      // 上游（模型/网关）出问题：不是「你参数填错了」，交回上层按 5xx 处理。
      return { ok: false, error: 'engine_error', detail: err.message };
    }

    return {
      ok: true,
      payload: pickPayload(result),
      usage: result.usage,
      promptVersion: result.promptVersion,
    };
  }

  return { generateDraft, generateSecondaryDraft };
}

// 1v1 咨询记录的存取与分析域的其它数据。
// 单独导出的原因：adminRoutes 需要它们，但它们不属于「跑模型」这件事。
export function createDeliveryData({ db }) {
  if (!db) throw new Error('createDeliveryData 需要 db');

  function saveSession({ clientId, transcript }) {
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    if (!text) throw new Error('transcript 必填');
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) throw new Error('客户不存在');
    const id = randomUUID();
    db.prepare(
      'INSERT INTO sessions_1v1 (id, client_id, transcript, source, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, clientId, text, 'manual_paste', new Date().toISOString());
    return db.prepare('SELECT * FROM sessions_1v1 WHERE id = ?').get(id);
  }

  function getSession(id) {
    return db.prepare('SELECT * FROM sessions_1v1 WHERE id = ?').get(id) || null;
  }

  function getLatestSession(clientId) {
    return db
      .prepare('SELECT * FROM sessions_1v1 WHERE client_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(clientId) || null;
  }

  function listSessionsForClient(clientId) {
    return db
      .prepare('SELECT * FROM sessions_1v1 WHERE client_id = ? ORDER BY created_at DESC')
      .all(clientId);
  }

  function getLatestStuckPoint(clientId) {
    const row = db
      .prepare('SELECT * FROM stuck_points WHERE client_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(clientId);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      belief: row.belief,
      evidence_against: row.evidence_against ? JSON.parse(row.evidence_against) : [],
      emotion: row.emotion,
      micro_action: row.micro_action,
    };
  }

  return { saveSession, getSession, getLatestSession, listSessionsForClient, getLatestStuckPoint };
}
