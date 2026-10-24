// 必须在任何会 import db.js 的模块之前被加载。
// ESM 的模块求值顺序遵循 import 顺序，所以只要这个文件排在第一位，
// process.env.DB_PATH 就一定在 db.js 求值前被设置好。
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DB_PATH = path.join(os.tmpdir(), `coco-test-${randomUUID()}.db`);
process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'test-key-not-used';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin';
process.env.INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';
// 指向一个不可达的本地端口：测试里的对话请求会立刻失败（不产生网络流量、不会挂起）。
process.env.MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'http://127.0.0.1:9/unreachable';
