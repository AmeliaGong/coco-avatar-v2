// async 路由的兜底包装（server/asyncRoute.js）。
//
// 这不是「一个工具函数」，而是**一条规矩**：后端所有 async 路由都必须
// 走它。它单独成文件是为了别的模块（server/delivery/*）也能 import 它
// —— 内联在 server.js 里的话，别的模块只能从 server.js import，会形成
// 循环依赖（server.js → delivery/* → server.js）。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { asyncRoute } from '../server/asyncRoute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('server/asyncRoute.js 存在，导出的是函数', () => {
  const file = path.join(__dirname, '..', 'server', 'asyncRoute.js');
  assert.ok(fs.existsSync(file), 'server/asyncRoute.js 不存在');
  assert.equal(typeof asyncRoute, 'function');
});

test('server.js 里不再有内联的 asyncRoute 定义（改成 import）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(
    !/function\s+asyncRoute\s*\(/.test(source),
    'server.js 里又有内联的 asyncRoute 实现了 —— 要 import 独立模块那份'
  );
  assert.ok(
    /import\s*\{[^}]*asyncRoute[^}]*\}\s*from\s*'\.\/server\/asyncRoute\.js'/.test(source),
    'server.js 没有从 server/asyncRoute.js import asyncRoute'
  );
});

test('handler 抛异常时：回 500 JSON，进程不退出', { timeout: 15000 }, async () => {
  const app = express();
  app.get(
    '/boom',
    asyncRoute(async () => {
      throw new Error('boom');
    })
  );
  // 已经发过响应头之后又抛错：不能再去设状态码（那会二次崩溃）
  app.get(
    '/half',
    asyncRoute(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.write('data: 半截\n\n');
      throw new Error('boom after headers');
    })
  );

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Internal server error' });

    // 「进程不退出」：请求还能继续被服务 —— 进程要是崩了，这一句就抛错。
    const half = await fetch(`http://127.0.0.1:${port}/half`);
    assert.equal(half.status, 200);
    assert.ok((await half.text()).includes('data: 半截'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
