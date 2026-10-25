// async 路由的兜底包装。
//
// 为什么需要它：Express 4 **不接** async handler 抛出的异常 —— 一个
// rejected promise 会变成 unhandledRejection → Node 默认让进程直接退出
// （不退出的话请求会一直挂着，客户端拿不到任何响应）。
//
// 所以凡是 async 的路由都要包一层：出错 → 记日志 + 500。
//
// 这是**一条规矩**，不是一个工具函数：后端所有 async 路由都必须走它
// （server.js 的 /api/chat、server/delivery/* 的那些路由……）。所以它
// 单独成文件，而不是塞在某一份路由代码里 —— 那样别的模块只能从那一份
// 里 import，会形成循环依赖（server.js → delivery/* → server.js）。
//
// 已经发过响应头（res.headersSent）就**不能**再设状态码/写 body ——
// 那样会抛 "Cannot set headers after they are sent"，把一个「流写到一半
// 断了」的问题变成二次崩溃。这种情况只记日志，让连接自然结束。
export function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(err => {
        console.error('Unhandled error in async route:', err);
        if (res.headersSent) {
          res.end();
          return;
        }
        res.status(500).json({ error: 'Internal server error' });
      });
  };
}
