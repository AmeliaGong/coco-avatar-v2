// 内部接口的**主体标识** —— `external_id`（契约 4，2026-10-25 定）。
//
// 背景：WeStream 小程序不能直连 Coco Avatar（fly.dev 无法 ICP 备案），
// 只能走「小程序 → 微信云函数 BFF → Coco Avatar 的 /api/internal/*」。
// 于是有一个问题必须回答：**BFF 传给 Coco Avatar 的「这是谁」是哪一个 id？**
//
// 答案：`external_id`（游民纪元 `users.id`），**不是** Coco Avatar 内部的
// `client_id`。
//
// 职责切分（这是本文件存在的全部理由）：
//
//   BFF 负责「**你是谁**」—— 认证，并把已认证会话换成 `users.id`。
//   Coco Avatar 负责「**你能看谁**」—— 用 `clients.external_id` 的唯一索引
//   把 `external_id` 解析成 `client_id`，并据此限定全部查询作用域。
//
// 为什么归属校验不放在 BFF 侧：设计规格 §5.3 的数据主权表把「映射」明确
// 划给 Coco Avatar（`coco_avatar.clients.external_id ↔ nomad_era.users.id`）。
// 若放在 BFF 侧，BFF 就得自己存一份 `external_id → client_id` 映射，
// 也就是游民纪元的 users 表里要存一份 Coco Avatar 的内部主键 ——
// **同一个映射两份真相**，要同步要对账，还把内部主键泄进了 ToC 侧的库。
//
// 附带好处：内部接口的主体标识**统一**了。
// `POST /api/internal/sync/nomad` 的请求体本来就用 `external_id`；
// 现在读接口也用它 ⇒ 整个 `/api/internal/*` 只有一种「这是谁」的写法，
// BFF 那边只有一条规则要记。
//
// ⚠️ 遗留风险（不要假装没有）：`external_id` **必须**由 BFF 从**已认证会话**
// 推导，绝不能取自请求参数 / 请求体 / 小程序传入的任何字段。
// Coco Avatar 不认识微信会话，它无法自己证明「这个 openid 是这个人」——
// 这条只能靠契约 + BFF 代码评审来保证。缓解条件：用户**无法绕过 BFF 直连
// Coco Avatar**（备案约束），所以这不是公开可打的漏洞，是内部实现风险。

// 解析器 —— 只做一件事：external_id → client_id。
//
// **service 层一行都不用改**：它只认 `client_id`，路由层把解析结果喂给它
// 就行（见 server/delivery/internalUserRoutes.js）。
//
// ⚠️ `db.prepare` 在构造时执行 ⇒ 调用方必须保证 `initSchema` 已经跑过
// （`clients` 表由 `CREATE TABLE IF NOT EXISTS` 建出）。这跟
// `server/auth.js` 的 `createRequireAdmin({db})` 是同一个约定：
// **缺表要在启动时炸，不要等到请求时才发现**。
export function createClientIdentityResolver({ db } = {}) {
  if (!db) throw new Error('createClientIdentityResolver 需要 db');
  const selectIdByExternalId = db.prepare('SELECT id FROM clients WHERE external_id = ?');

  // 返回 client_id，或 null（查不到）。
  //
  // 查不到是**正常状态**，不是错误：该用户还没建档（没付费 / 教练手工建档的
  // 客户 `source='manual'` ⇒ `external_id` 为 NULL）。调用方据此返回
  // 「尚无交付」，不要 500。
  //
  // 唯一性由 `idx_clients_external`（`WHERE external_id IS NOT NULL`）保证，
  // 所以这里最多命中一行。
  function resolveClientId(externalId) {
    if (typeof externalId !== 'string' || externalId.length === 0) return null;
    const row = selectIdByExternalId.get(externalId);
    return row ? row.id : null;
  }

  return { resolveClientId };
}

// 路由层中间件：把路径里的 `external_id` 解析成 `client_id`，挂到
// `req.clientId` 上。解析不到就 404（「尚无交付」）。
//
// 为什么放中间件而不是每个 handler 里各写一遍：三个 internal 路由要的是
// 同一跳，写三遍就是三处可能写歪的地方。
//
// 路径必须是 `/api/internal/clients/by-external/:externalId/...` ——
// **不接受 `client_id`**。Coco Avatar 的内部 UUID 不出 Coco Avatar。
// 万一有人把 client_id 填进这个槽位，解析不到就是 404（fail-closed），
// 不会误命中别人的档案。
//
// ⚠️ 这里**直接**回 404，不走 `respondWithServiceError`：那个出口要
// `err instanceof UserServiceError`，而 UserServiceError 定义在
// `userService.js` 里 —— 本文件刻意不 import 它（那会造成 delivery 模块
// 内部的循环依赖，且 UserServiceError 只属于用户端那一层）。
// 响应体形状与 `respondWithServiceError` 的 4xx 分支**完全一致**
// （`{ error: <固定中文文案> }`），所以前端看到的东西没有差别。
export function createExternalSubjectResolver({ db } = {}) {
  const { resolveClientId } = createClientIdentityResolver({ db });

  return function resolveExternalSubject(req, res, next) {
    const externalId = req.params?.externalId;
    const clientId = resolveClientId(externalId);
    if (!clientId) {
      return res.status(404).json({ error: '还没有交付记录' });
    }
    req.externalId = externalId;
    req.clientId = clientId;
    next();
  };
}
