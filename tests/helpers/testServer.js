// 必须是第一个 import：保证 server.js → db.js 求值前 DB_PATH 已指向隔离的临时库。
import './testEnv.js';
import { app } from '../../server.js';

// 在随机端口启动 app，返回 baseUrl 与关闭函数。
export async function createServer() {
  const server = app.listen(0);
  // 监听失败时必须 reject，否则 await 会永远挂住（node:test 默认无超时）。
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
