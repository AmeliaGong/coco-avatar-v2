// 交付模块的**内部**用户端路由 —— 给微信云函数 BFF 用的那一层。
//
// **为什么要有这一层**：WeStream 小程序是统一入口，但小程序**不能直连
// Coco Avatar** —— 微信 request 的合法域名要求已 ICP 备案，而 fly.dev
// 没法备案。所以小程序只能走「小程序 → 微信云函数 BFF → Coco Avatar 的
// /api/internal/*」。
//
// **主体标识是 `external_id`（契约 4，2026-10-25 定）** —— 也就是游民纪元
// 的 `users.id`，**不是** Coco Avatar 内部的 `client_id`。小程序那边存的是
// `users.id`，不存 Coco Avatar 的内部主键。
//
// 职责切分：BFF 负责「**你是谁**」（认证，把已认证会话换成 `users.id`）；
// Coco Avatar 负责「**你能看谁**」（用 `clients.external_id` 的唯一索引把
// `external_id` 解析成 `client_id`，据此限定全部查询作用域）。
// 解析在 identity.js（createExternalSubjectResolver）。
//
// **与公开层（userRoutes.js）的差别只有两件事**：
//   1. 拿哪个 id 找人 —— conversation_id vs external_id
//   2. 用哪种鉴权 —— 链接即凭证 vs Bearer service token
// 其余（读方案、算进度、落证据）**全部在 userService.js**，
// 这里一行业务逻辑都没有 —— service 层只认 `client_id`，解析结果直接喂给它。
//
// **同样永远不返回 clients.notes**：BFF 的 service token 只证明
// 「这是 WeStream 的后端」，不证明「这个调用者有权看教练备注」。
// 小程序是给用户看的，教练备注绝不能从这条路出去。
//
// **没配 serviceToken 时返回 503**（不是 401）——「我们还没准备好」
// 与「你没权限」是两回事，排查时该去看环境变量而不是去查 token。
//
// --- 鉴权权威（增补 I.1）---
//
// **本文件不生产鉴权中间件，只消费。**
// 服务间密钥的读取与比较只有一个权威：server/auth.js 的
// createRequireInternal。server.js 在启动时构造那一个实例并注入进来
// （`createInternalUserDeliveryRouter({ db, plans, requireInternal })`）。
//
// 为什么不能各造各的：两份实现迟早会漂 —— 一份比对了 token、另一份忘了比
// （或者一份按 env 兜底、另一份不兜底），结果就是「有的路由要 token、
// 有的不要」，而这种差异**只有在被绕过时才会被发现**。
//
// 因此本文件的默认值（不传 requireInternal 时自建一个）**只服务于单测**：
// 测试要的是「这一组路由能独立跑起来」。生产装配路径必须注入 ——
// server.js 就是这么接的。**新增 internal 路由时不要在这里新造中间件。**

import { Router } from 'express';
import { asyncRoute } from '../asyncRoute.js';
import { createRequireInternal } from '../auth.js';
import { createExternalSubjectResolver } from './identity.js';
import {
  createUserService,
  respondWithServiceError,
} from './userService.js';

export function createInternalUserDeliveryRouter({
  db,
  plans,
  serviceToken,
  requireInternal: injectedRequireInternal = null,
} = {}) {
  if (!db || !plans) throw new Error('createInternalUserDeliveryRouter 需要 db 与 plans');
  const service = createUserService({ db, plans });
  // 注入优先；没注入才自建（单测用）。**生产路径走注入** —— 见文件头。
  const requireInternal =
    typeof injectedRequireInternal === 'function'
      ? injectedRequireInternal
      : createRequireInternal({ serviceToken });
  // 主体解析：external_id → client_id，挂到 req.clientId。
  // 解析不到 = 「这个人还没有交付记录」，404 —— 不是错误。
  const resolveSubject = createExternalSubjectResolver({ db });
  const router = Router();

  // 读方案（按 external_id —— 契约 4）。
  //
  // ⚠️ 中间件顺序不能反：**先认证（401），再解析主体（404）**。
  // 反过来的话，没带 token 的人能拿 external_id 去试「这个人有没有交付
  // 记录」—— 那就是个探测口。
  router.get(
    '/api/internal/clients/by-external/:externalId/plan',
    requireInternal,
    resolveSubject,
    asyncRoute(async (req, res) => {
      try {
        res.json(service.getPlanForClient(req.clientId));
      } catch (err) {
        respondWithServiceError(res, err);
      }
    })
  );

  // 开始今天的这张卡。
  router.post(
    '/api/internal/clients/by-external/:externalId/plan/start',
    requireInternal,
    resolveSubject,
    asyncRoute(async (req, res) => {
      try {
        res.json(service.startPlanForClient(req.clientId));
      } catch (err) {
        respondWithServiceError(res, err);
      }
    })
  );

  // 证据回填（打卡）。
  router.post(
    '/api/internal/clients/by-external/:externalId/plan/evidence',
    requireInternal,
    resolveSubject,
    asyncRoute(async (req, res) => {
      try {
        res.json(service.addEvidenceForClient(req.clientId, req.body || {}));
      } catch (err) {
        respondWithServiceError(res, err);
      }
    })
  );

  return router;
}
