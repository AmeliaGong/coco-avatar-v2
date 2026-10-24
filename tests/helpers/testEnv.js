// 必须在任何会 import db.js 的模块之前被加载。
// ESM 的模块求值顺序遵循 import 顺序，所以只要这个文件排在第一位，
// process.env.DB_PATH 就一定在 db.js 求值前被设置好。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const DB_PATH = path.join(os.tmpdir(), `coco-test-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.MINIMAX_API_KEY = 'test-key-not-used';
process.env.ADMIN_PASSWORD = 'test-admin';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
// 指向一个不可达的本地端口：测试里的对话请求会立刻失败（不产生网络流量、不会挂起）。
// 必须是无条件赋值：如果开发者 shell 里导出了真实的 MINIMAX_API_URL，
// 套件就会带着真 key 打向生产网关 —— 这是项目明令禁止的。
process.env.MINIMAX_API_URL = 'http://127.0.0.1:9/unreachable';

// 清理临时测试库及其 WAL/SHM 兄弟文件（退出时同步执行，不能用异步 API）。
process.on('exit', () => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // 文件可能已被移除或正在被占用；清理失败不应影响测试结果。
    }
  }
});
