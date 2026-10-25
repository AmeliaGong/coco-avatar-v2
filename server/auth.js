// 鉴权中间件。
//
// **约定 1：本模块不 import db.js，也不 import server.js。**
//   - import db.js 会让模块在 import 时就去连数据库（副作用 + 测试难隔离）；
//   - import server.js 会造成循环依赖（server.js → auth.js → server.js）。
// 所以 db 一定是**注入进来**的，依赖只允许是标准库。
//
// **约定 2：本模块里的中间件必须是同步函数。**
// Express 4 **不捕获** async handler 抛出的 rejection —— 一次 db 抛错
// （表不存在 / DB 文件损坏 / SQLITE_BUSY）会变成未捕获的 Promise rejection，
// Node 默认 `unhandledRejection = throw` ⇒ **进程直接退出**。
// fly.io 是单进程 ⇒ 全站崩。所以这里**绝不能**写成 async。
// （同仓库的 server/asyncRoute.js 就是为此抽出来的：async 路由必须包它。）
import crypto from 'node:crypto';

// admin 会话 token 的长度上限。超长 token 直接拒绝，不进 SQL、不进日志
// （与 Task 8 给 /api/chat 加的 client_id / conversation_id 上限同一个理由）。
//
// **这个上限只管 admin 侧，internal 侧故意没有**：internal 的 expected 来自
// 服务端配置（不是用户输入），而 provided 的长度直接参与定长比较 ——
// 长度不等即 401，不需要额外的上限。这处不对称是有意的。
const MAX_ADMIN_TOKEN_LENGTH = 256;

// 401 的响应体。**必须逐字节不变**：{ error: 'Unauthorized' }。
// 冻结是为了防止调用方误改这个共享对象。
const UNAUTHORIZED = Object.freeze({ error: 'Unauthorized' });

// Admin 会话鉴权：请求头 X-Admin-Token。
//
// **密码校验不在这里** —— 它在 POST /api/admin/login 里（比对 ADMIN_PASSWORD
// 然后往 admin_sessions 表写一条随机 token）。本中间件只负责一件事：
// 判断「这个会话 token 现在还有效吗」。
//
// options 里可以带上 adminPassword，但这里**刻意不解构它** ——
// 中间件用不到它，留一个「收下但不用」的死参数只会误导后来的人
// （让人以为密码是这条鉴权链的一部分）。当前调用点也不传它。
// 保留在签名里是因为后续可能会用到。
//
// **本工厂必须在 db 就绪之后调用** —— 下面两行会 prepare SQL（表得已经存在）。
// server.js 里 getDb() 之后再调用，db 已就绪（getDb() 会先跑 initSchema）。
export function createRequireAdmin({ db }) {
  // prepare 一次，闭包捕获：better-sqlite3 每次 prepare 都要重新编译 SQL，
  // 没必要每个请求编一次。
  const selectSession = db.prepare('SELECT * FROM admin_sessions WHERE token = ?');
  const deleteSession = db.prepare('DELETE FROM admin_sessions WHERE token = ?');

  return function requireAdmin(req, res, next) {
    const token = req.headers?.['x-admin-token'];
    // token 必须是**非空字符串**：req.headers 的值在 Node/Express 里通常是
    // 字符串，但不保证（重复头可能给数组，测试里的假 req 也可能是对象）。
    // 把非字符串丢给 better-sqlite3 会抛 RangeError，在 async handler 里
    // 抛出去会**打死整个进程**（fly.io 单进程 ⇒ 全站崩）。
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_ADMIN_TOKEN_LENGTH
    ) {
      return res.status(401).json(UNAUTHORIZED);
    }
    const session = selectSession.get(token);
    if (!session) {
      return res.status(401).json(UNAUTHORIZED);
    }
    // **fail-closed**：读不懂自己的数据（expires_at 是坏值）时一律按「已过期」
    // 处理，而不是放行。`new Date('garbage')` 是 Invalid Date，
    // 而 `Invalid Date < new Date()` 恒为 false —— 不加这道守卫的话，
    // 一条 expires_at 损坏的记录会被**永久放行**，而且永远不会被清理
    // （启动清理与登录清理用的都是 expires_at < ? 的**字符串**比较）。
    const expiresAt = new Date(session.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) {
      // 过期的 session 会被**删掉**（不只是被拒绝）。
      deleteSession.run(token);
      return res.status(401).json(UNAUTHORIZED);
    }
    next();
  };
}

// 服务间（internal）鉴权：请求头 Authorization: Bearer <token>。
//
// 用**定长比较**（crypto.timingSafeEqual）避免时序侧信道。
//
// expected 在**构造时**求值一次并被闭包捕获：服务启动后再改环境变量不应该
// 让已构造的中间件行为漂移。（调用方要换 token，就重新构造一个实例。）
//
// serviceToken 的语义：
//   undefined / null / ''  → 回落到 process.env.INTERNAL_SERVICE_TOKEN
//     （空串明确表示「我还没定」，让环境变量来兜底；process.env 取出来
//       一定是字符串，所以回落这一路没有类型风险）
//   其它非字符串（如 {}）  → **不回落**，直接当「未配置」→ 503
//     （显式传了错类型不该被环境变量悄悄补上：那是两个来源混在一起，
//       出了事不知道该改哪边）
export function createRequireInternal({ serviceToken } = {}) {
  const raw =
    serviceToken === undefined || serviceToken === null || serviceToken === ''
      ? process.env.INTERNAL_SERVICE_TOKEN
      : serviceToken;
  // 不是非空字符串 → 当「未配置」（Buffer.from({}) 会抛 TypeError）。
  const expected = typeof raw === 'string' && raw.length > 0 ? raw : '';

  return function requireInternal(req, res, next) {
    if (!expected) {
      // 没配服务间密钥是**配置缺失**，不是鉴权失败 → 503。
      return res.status(503).json({ error: 'INTERNAL_SERVICE_TOKEN not configured' });
    }
    const header = req.headers?.['authorization'];
    // **本实现要求严格的 `Bearer `（大写 B、恰好一个空格）。**
    // RFC 7235 §2.1 / RFC 9110 §11.1 说 auth-scheme 大小写不敏感 ——
    // 所以 `bearer xxx` / `BEARER xxx` 现在都是 401。这是一处**有意的**
    // 互操作偏差（不是安全漏洞：token 本身仍然逐字节比对）。
    // 将来若要放宽，用 /^Bearer[ \t]+(\S+)$/i，
    // **改的时候要同步改 tests/auth.test.js 里 'bearer abc' 那条用例**。
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return res.status(401).json(UNAUTHORIZED);
    }
    const provided = header.slice('Bearer '.length);
    if (provided.length === 0) {
      // 显式边界：规格要求「Bearer 后面是空 → 401」。
      // （当前实现里它与定长比较的结果一致，但把它写出来是为了不让
      //   正确性依赖「expected 一定非空」这个隐含前提。别当死代码删掉。）
      return res.status(401).json(UNAUTHORIZED);
    }
    // token 实际上**必须是 ASCII**：HTTP 头带不了非 ASCII
    // （undici 会抛 TypeError: Cannot convert argument to aByteString）。
    // 这里的 Buffer.from 默认按 UTF-8 编码，两边编码一致，
    // 所以非 ASCII token 在中间件这一层是能对上的 —— 但它根本到不了这里。
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // **必须先比长度**：crypto.timingSafeEqual 在两个 buffer 长度不等时
    // 直接抛 RangeError（不是返回 false）。短路求值是这条代码的关键。
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      return res.status(401).json(UNAUTHORIZED);
    }
    next();
  };
}
