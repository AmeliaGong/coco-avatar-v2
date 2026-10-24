// 鉴权中间件。
//
// **约定：本模块不 import db.js，也不 import server.js。**
//   - import db.js 会让模块在 import 时就去连数据库（副作用 + 测试难隔离）；
//   - import server.js 会造成循环依赖（server.js → auth.js → server.js）。
// 所以 db 一定是**注入进来**的，依赖只允许是标准库。
import crypto from 'node:crypto';

// token 长度上限。超长 token 直接拒绝，不进 SQL、不进日志
// （与 Task 8 给 /api/chat 加的 client_id / conversation_id 上限同一个理由）。
const MAX_TOKEN_LENGTH = 256;

// Admin 会话鉴权：请求头 X-Admin-Token。
//
// **密码校验不在这里** —— 它在 POST /api/admin/login 里（比对 ADMIN_PASSWORD
// 然后往 admin_sessions 表写一条随机 token）。本中间件只负责一件事：
// 判断「这个会话 token 现在还有效吗」。
//
// options 里可以带上 adminPassword，但这里**刻意不解构它** ——
// 中间件用不到它，留一个「收下但不用」的死参数只会误导后来的人。
// 保留在签名里是因为后续可能会用到。
export function createRequireAdmin({ db }) {
  return function requireAdmin(req, res, next) {
    const token = req.headers?.['x-admin-token'];
    // token 必须是**非空字符串**：req.headers 的值在 Node/Express 里通常是
    // 字符串，但不保证（重复头可能给数组，测试里的假 req 也可能是对象）。
    // 把非字符串丢给 better-sqlite3 会抛 RangeError，在 async handler 里
    // 抛出去会**打死整个进程**（fly.io 单进程 ⇒ 全站崩）。
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const session = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
    if (!session || new Date(session.expires_at) < new Date()) {
      if (session) {
        // 用注入进来的 db 删除过期会话。
        db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
      }
      return res.status(401).json({ error: 'Unauthorized' });
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
export function createRequireInternal({ serviceToken } = {}) {
  // serviceToken 没给 / 给空串 → 回落到环境变量。
  // process.env 取出来一定是字符串，风险只在参数上 —— 参数是对象时
  // 直接当作「未配置」，否则 Buffer.from(对象) 会抛错。
  const raw =
    serviceToken === undefined || serviceToken === null || serviceToken === ''
      ? process.env.INTERNAL_SERVICE_TOKEN
      : serviceToken;
  const expected = typeof raw === 'string' && raw.length > 0 ? raw : '';

  return function requireInternal(req, res, next) {
    if (!expected) {
      // 没配服务间密钥是**配置缺失**，不是鉴权失败 → 503。
      return res.status(503).json({ error: 'INTERNAL_SERVICE_TOKEN not configured' });
    }
    const header = req.headers?.['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const provided = header.slice('Bearer '.length);
    if (provided.length === 0) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // **必须先比长度**：crypto.timingSafeEqual 在两个 buffer 长度不等时
    // 直接抛 RangeError（不是返回 false）。短路求值是这条代码的关键。
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}
