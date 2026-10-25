// 交付模块的**公开**用户端路由（试点期网页走这条）。
//
// **权限模型：链接即凭证。** 与现有的 /api/conversations/:id 一致 ——
// 拿到链接就能读该会话所属客户的内容。这是既有的信任模型，不是新加的。
//
// **这里永远不返回 clients.notes。** 教练的私有备注不是来访者的东西。
// 这条不是在路由里「查完再删」实现的 —— 响应是 service 层用**字段白名单**
// 拼出来的，路由根本没碰过 clients 表。
//
// **本文件不许出现业务逻辑。** 12 月小程序那条线（internalUserRoutes.js）
// 与这一条必须算出一样的进度，所以逻辑全在 userService.js。
//
// 每个 handler 都包 asyncRoute：Express 4 不接 async handler 的 rejection ——
// 一次 DB 错误就能变成未捕获异常打死进程（fly.io 单进程 = 整站掉线）。

import { Router } from 'express';
import { asyncRoute } from '../asyncRoute.js';
import {
  createUserService,
  respondWithServiceError,
} from './userService.js';

export function createUserDeliveryRouter({ db, plans } = {}) {
  if (!db || !plans) throw new Error('createUserDeliveryRouter 需要 db 与 plans');
  const service = createUserService({ db, plans });
  const router = Router();

  // 读方案：没有方案时返回 has_plan:false（不是 404）——
  // 「还没拿到方案」是这个阶段用户的正常状态。
  router.get(
    '/api/conversations/:id/plan',
    asyncRoute(async (req, res) => {
      try {
        res.json(service.getPlanForConversation(req.params.id));
      } catch (err) {
        respondWithServiceError(res, err);
      }
    })
  );

  // 开始今天的这张卡：pending_activation → active。
  router.post(
    '/api/conversations/:id/plan/start',
    asyncRoute(async (req, res) => {
      try {
        res.json(service.startPlanForConversation(req.params.id));
      } catch (err) {
        respondWithServiceError(res, err);
      }
    })
  );

  // 证据回填（打卡）：落 evidences，进度由 service 层重算。
  router.post(
    '/api/conversations/:id/plan/evidence',
    asyncRoute(async (req, res) => {
      try {
        res.json(service.addEvidenceForConversation(req.params.id, req.body || {}));
      } catch (err) {
        respondWithServiceError(res, err);
      }
    })
  );

  return router;
}
