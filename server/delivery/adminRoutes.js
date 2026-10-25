// 交付模块的后台接口。
//
// 单独成文件的原因：server.js 里已经有 20 多个路由，再塞十几个进去就没法读了。
// 这一组路由共享同一套依赖（客户 store、方案 store、分析服务、手法库），集中起来
// 依赖关系一眼看得见。
//
// **这里是唯一能读 clients.notes（教练私有备注）的地方。** 用户端接口
// 永远不返回 notes —— 那是教练的私人笔记，不是来访者的东西。
//
// 挂载方式（server.js）：
//   app.use('/api/admin', createAdminDeliveryRouter({ clients, plans, analysis, moves, requireAdmin }));
//
// **路径一律写相对路径** —— 挂载前缀（/api/admin）是 server.js 决定的。
// 写成绝对路径会出现「挂一次前缀、两处各写一遍 /api/admin」的漂移：
// 前端按 /api/admin/... 调用，路由里再写一遍就会变成 /api/admin/api/admin/...
//
// **每个 handler 都用 asyncRoute 包起来**：Express 4 不接 async handler 的
// rejection，一个数据库错误就能打死进程（fly.io 单进程 = 整站掉线）。

import express, { Router } from 'express';
import { asyncRoute } from '../asyncRoute.js';
import { extractTranscriptFromUpload } from './upload.js';

// 业务错误 → 4xx；意外错误 → 5xx（交给 asyncRoute 兜底）。
//
// **为什么要分两类**：路由里 catch 住所有异常并一律回 400，会把「数据库坏了」
// 也说成「你参数填错了」—— 排查时会被带偏。反过来，一律回 500 又会让
// 「客户不存在」变成 5xx。
//
// 判据：
//   - RangeError / TypeError —— better-sqlite3 绑了非法类型（请求体里的对象
//     绑进 SQL 就是这样），这是**意外错误**，不是业务错误 → 500。
//   - 带 SQLITE_ code 的 SqliteError —— 数据库本身出错 → 500。
//   - 消息里带「不存在」—— 资源不存在 → 404。
//   - 其余（自己抛的业务错误，如「name 必填」）→ 400。
function classifyError(err) {
  if (err instanceof RangeError || err instanceof TypeError) return 500;
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_')) return 500;
  if (err && typeof err.message === 'string' && err.message.includes('不存在')) return 404;
  return 400;
}

// 分析服务失败时的状态码。
//
// **为什么要分开**：分析服务把上游故障也包成 {ok:false} 返回
// （error = 'engine_error'）。那不是「你参数填错了」，是服务器到模型
// 那一段出了问题 —— 报 400 会让教练以为是自己写错了转写。
function statusForAnalysisResult(result) {
  const code = result?.error;
  if (code === 'no_input') return 400;      // 没有素材可分析
  if (code === 'engine_error') return 500;   // 上游模型/网关
  return 422;                                // 内容不合格（契约校验没过）
}

// 请求体里的数组元素也要类型守卫。
//
// **为什么**：`conversation_ids: [{evil: 1}]` 里的对象绑进 better-sqlite3
// 会抛 RangeError —— 在 async handler 里抛出去就是一次 unhandledRejection
// = 进程退出 = 整站掉线。所以守卫的写法是「不是非空字符串就 400」，
// 不是「查不到就跳过」。
function requireStringArray(value, fieldName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} 必须是数组`);
  return value.map((v) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`${fieldName} 里每一项必须是非空字符串`);
    }
    return v.trim();
  });
}

// 统一的错误响应。业务错误 4xx（带具体原因），意外错误 5xx。
//
// **意外错误不回传原始消息** —— 里面可能有 SQL、路径、字段名，属于内部细节；
// 只回一句「服务器出错了」，排障看服务端日志。
function sendError(res, err) {
  const status = classifyError(err);
  if (status === 500) {
    console.error('Admin delivery route failed:', err);
    res.status(500).json({ error: '服务器出错了，请稍后重试' });
    return;
  }
  res.status(status).json({ error: err?.message || '请求不合法' });
}

export function createAdminDeliveryRouter({
  clients,
  plans,
  analysis,
  moves = null,
  requireAdmin,
  db = null,
}) {
  if (!clients || !plans) throw new Error('createAdminDeliveryRouter 需要 clients 与 plans');
  if (typeof requireAdmin !== 'function') throw new Error('createAdminDeliveryRouter 需要 requireAdmin');
  const router = Router();

  router.use(requireAdmin);

  // --- 客户 ---
  router.get('/clients', asyncRoute(async (req, res) => {
    res.json({ clients: clients.list() });
  }));

  router.post('/clients', asyncRoute(async (req, res) => {
    try {
      const client = clients.create(req.body || {});
      res.json(client);
    } catch (err) {
      sendError(res, err);
    }
  }));

  router.get('/clients/:id', asyncRoute(async (req, res) => {
    const detail = clients.getWithConversations(req.params.id);
    if (!detail) return res.status(404).json({ error: '客户不存在' });
    res.json({
      client: { ...detail, stuck_points: clients.listStuckPoints(req.params.id) },
      plans: plans.listByClient(req.params.id),
    });
  }));

  router.patch('/clients/:id', asyncRoute(async (req, res) => {
    try {
      res.json(clients.update(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  }));

  // --- 挂载会话并导入卡点 ---
  //
  // **两步入库要放在一个事务里**：挂了会话却没导入卡点（或反过来）会留下
  // 半截数据 —— 那些行查不出来也删不掉。db 是可选注入的（没注入时退化成
  // 两次独立写入）。
  router.post('/clients/:id/conversations', asyncRoute(async (req, res) => {
    try {
      const ids = requireStringArray((req.body || {}).conversation_ids, 'conversation_ids');
      const attachAndImport = () => {
        const result = clients.attachConversations(req.params.id, ids);
        const imported = clients.importStuckPointsFromConversations(req.params.id, ids);
        return { ...result, stuck_points_imported: imported.length };
      };
      // 有 db 就整段包进事务：挂了会话却没导入卡点（或反过来）会留下半截数据。
      const payload = db ? db.transaction(attachAndImport)() : attachAndImport();
      res.json(payload);
    } catch (err) {
      sendError(res, err);
    }
  }));

  // --- 手工录入卡点 ---
  //
  // 卡点有两个来源：从会话里自动导入的（挂载会话时顺带做），和教练手写的。
  // 手写这条路必须有 —— 有些卡点是聊出来的、根本没进过任何一条会话。
  router.post('/clients/:id/stuck-points', asyncRoute(async (req, res) => {
    try {
      const sp = clients.addStuckPoint(req.params.id, req.body || {});
      res.json(sp);
    } catch (err) {
      sendError(res, err);
    }
  }));

  // --- 1v1 咨询记录（手动粘贴）---
  router.get('/clients/:id/sessions', asyncRoute(async (req, res) => {
    res.json({ sessions: analysis.listSessionsForClient(req.params.id) });
  }));

  router.post('/clients/:id/sessions', asyncRoute(async (req, res) => {
    try {
      const transcript = (req.body || {}).transcript;
      if (typeof transcript !== 'string' || !transcript.trim()) {
        return res.status(400).json({ error: 'transcript 必填' });
      }
      const session = analysis.saveSession({
        clientId: req.params.id,
        transcript,
      });
      res.json(session);
    } catch (err) {
      sendError(res, err);
    }
  }));

  // --- 1v1 文件上传：只提取文本，不入库 ---
  //
  // 提取结果回到前端文本框，教练能改 —— 改完再保存/再分析。
  // docx 里的说话人标记经常变形，机器提取出来的东西要人能改过才能用。
  router.post(
    '/clients/:id/sessions/upload',
    express.raw({ type: 'application/octet-stream', limit: '5mb' }),
    asyncRoute(async (req, res) => {
      let filename = '';
      try {
        filename = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      } catch {
        filename = '';
      }
      try {
        const r = await extractTranscriptFromUpload({ buffer: req.body, filename });
        res.json({ text: r.text, kind: r.kind, warnings: r.warnings, filename });
      } catch (err) {
        sendError(res, err);
      }
    })
  );

  // --- 方案 ---
  router.get('/clients/:id/plans', asyncRoute(async (req, res) => {
    res.json({ plans: plans.listByClient(req.params.id) });
  }));

  // 生成方案草稿：用最新一条（或指定的）1v1 记录。
  router.post('/clients/:id/plans/generate', asyncRoute(async (req, res) => {
    try {
      const body = req.body || {};
      const sessionId = typeof body.session_id === 'string' && body.session_id.trim()
        ? body.session_id.trim()
        : null;
      const session = sessionId
        ? analysis.getSession(sessionId)
        : analysis.getLatestSession(req.params.id);
      if (!session) {
        return res.status(400).json({ error: '还没有 1v1 咨询记录 —— 先粘贴一段再生成' });
      }
      const stuckPoint = analysis.getLatestStuckPoint(req.params.id);
      // 手法库是**全局的**（Coco 定的口径：先按全局做），所以生成方案时
      // 把库里**在用**的手法全部交给模型 —— 14 天 Circle 的圈要来自
      // 教练的手法库，不能是模型现编的。
      const coachMoves = moves
        ? moves.list({ activeOnly: true }).map((m) => ({
            name: m.name,
            summary: m.summary,
            when_to_use: m.when_to_use,
            script: m.script,
          }))
        : [];
      const result = await analysis.generateDraft({
        transcript: session.transcript,
        stuckPoint,
        coachMoves,
      });
      if (!result || result.ok === false) {
        const message = (result && (result.error || result.message)) || '生成方案失败';
        return res.status(statusForAnalysisResult(result)).json({
          error: message,
          detail: (result && result.detail) || null,
        });
      }
      const plan = plans.createDraft({
        clientId: req.params.id,
        payload: result.payload,
        stuckPointId: stuckPoint ? stuckPoint.id : null,
      });
      res.json({ plan, usage: result.usage });
    } catch (err) {
      // 生成失败基本都是「上游模型/网关出问题」，那是 5xx 不是「你参数填错了」。
      // 只有契约层明确说「payload 不合法」才是 422（内容不合格，可以改）。
      const status =
        err?.code === 'invalid_plan_payload' || err?.code === 'empty_plan_payload' ? 422 : 500;
      res.status(status).json({ error: err?.message || '生成方案失败' });
    }
  }));

  // 二次分析：拿着新转写 + 上一版方案，再跑一轮诊断。
  //
  // 本次适用的手法由前端勾选（coach_move_ids）：一条都不勾 = 不限制，
  // 不是「不给」。
  router.post('/clients/:id/secondary-analysis', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const clientId = req.params.id;
    try {
      let transcript = typeof body.transcript === 'string' ? body.transcript : '';
      let sourceSessionId = null;
      if (!transcript && typeof body.session_id === 'string' && body.session_id.trim()) {
        const s = analysis.getSession(body.session_id.trim());
        if (!s) return res.status(404).json({ error: '咨询记录不存在' });
        // 别人的咨询记录不能拿来分析 —— 这里必须按 client_id 核对一次。
        if (s.client_id && s.client_id !== clientId) {
          return res.status(404).json({ error: '咨询记录不存在' });
        }
        transcript = s.transcript;
        sourceSessionId = s.id;
      }
      if (!transcript || !transcript.trim()) {
        return res.status(400).json({ error: 'transcript 必填' });
      }

      // 客户在会话里说过的话 —— 二次分析要能看到它们。
      const conversationMessages = db
        ? db.prepare(
            "SELECT role, content FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE client_id = ?) ORDER BY id ASC"
          ).all(clientId)
        : [];

      const latest = plans.findLatestForClient(clientId);
      let previousPayload = null;
      if (latest) {
        try {
          previousPayload = JSON.parse(latest.payload);
        } catch {
          previousPayload = null;
        }
      }

      let coachMoves = [];
      const moveIds = requireStringArray(body.coach_move_ids, 'coach_move_ids');
      if (moves && moveIds.length) {
        coachMoves = moveIds
          .map((id) => moves.get(id))
          .filter(Boolean)
          .map((m) => ({ name: m.name, summary: m.summary, when_to_use: m.when_to_use, script: m.script }));
      }

      const result = await analysis.generateSecondaryDraft({
        transcript,
        conversationMessages,
        previousPayload,
        coachMoves,
        coachSpeaker: typeof body.coach_speaker === 'string' ? body.coach_speaker : null,
      });
      if (!result || result.ok === false) {
        const message = (result && (result.error || result.message)) || '二次分析失败';
        return res.status(statusForAnalysisResult(result)).json({
          error: message,
          detail: (result && result.detail) || null,
        });
      }
      const plan = plans.createDraft({
        client_id: clientId,
        payload: result.payload,
        supersedes_id: latest ? latest.id : null,
        source_session_id: sourceSessionId,
        journey_id: body.journey_id || null,
      });
      res.json({ plan });
    } catch (err) {
      // 同上：二次分析失败是上游问题（模型/网关），不是请求写错了。
      res.status(500).json({ error: err?.message || '二次分析失败' });
    }
  }));

  router.get('/plans/:planId', asyncRoute(async (req, res) => {
    const bundle = plans.getBundle(req.params.planId);
    if (!bundle) return res.status(404).json({ error: '方案不存在' });
    res.json(bundle);
  }));

  router.patch('/plans/:planId', asyncRoute(async (req, res) => {
    try {
      const body = req.body || {};
      let plan = plans.get(req.params.planId);
      if (!plan) return res.status(404).json({ error: '方案不存在' });
      if (body.payload !== undefined) plan = plans.updatePayload(req.params.planId, body.payload);
      if (body.diagnosis_md !== undefined) plan = plans.updateDiagnosisMd(req.params.planId, body.diagnosis_md);
      res.json({ plan });
    } catch (err) {
      sendError(res, err);
    }
  }));

  // 编辑单个练习项 —— circle / scenario / target_belief 是教练最常改的三样。
  router.patch('/plans/:planId/practices/:practiceId', asyncRoute(async (req, res) => {
    try {
      const practice = plans.updatePractice(req.params.planId, req.params.practiceId, req.body || {});
      res.json({ practice });
    } catch (err) {
      sendError(res, err);
    }
  }));

  router.post('/plans/:planId/publish', asyncRoute(async (req, res) => {
    try {
      res.json({ plan: plans.publish(req.params.planId) });
    } catch (err) {
      sendError(res, err);
    }
  }));

  // --- 教练手法库 ---
  if (moves) {
    router.get('/coach-moves', asyncRoute(async (req, res) => {
      res.json({ moves: moves.list({ activeOnly: req.query.all !== '1' }) });
    }));

    router.post('/coach-moves', asyncRoute(async (req, res) => {
      try {
        res.json({ move: moves.create(req.body || {}) });
      } catch (err) {
        sendError(res, err);
      }
    }));

    router.patch('/coach-moves/:moveId', asyncRoute(async (req, res) => {
      try {
        res.json({ move: moves.update(req.params.moveId, req.body || {}) });
      } catch (err) {
        sendError(res, err);
      }
    }));

    router.post('/coach-moves/:moveId/archive', asyncRoute(async (req, res) => {
      try {
        res.json({ move: moves.archive(req.params.moveId) });
      } catch (err) {
        sendError(res, err);
      }
    }));

    router.post('/coach-moves/:moveId/restore', asyncRoute(async (req, res) => {
      try {
        res.json({ move: moves.restore(req.params.moveId) });
      } catch (err) {
        sendError(res, err);
      }
    }));
  }

  return router;
}
