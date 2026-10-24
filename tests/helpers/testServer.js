// 必须是第一个 import：保证 server.js → db.js 求值前 DB_PATH 已指向隔离的临时库。
import './testEnv.js';
import { app } from '../../server.js';

// 在随机端口启动 app，返回 baseUrl 与关闭函数。
export async function createServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
