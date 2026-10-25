// 引擎错误 → HTTP 状态码的映射。
//
// 这张表是「客户端看到什么状态码」的唯一真相。它被抽成独立模块就是为了
// 能逐条测：表里多一行、少一行、或者某行映射错了，这里都会红。
//
// （表里哪些条目在当前链路上到不了、为什么到不了，写在 server/errorStatus.js
// 的注释里。）
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelError } from '../server/engine/modelClient.js';
import {
  ENGINE_ERROR_STATUS,
  statusForEngineError,
  errorBodyForStatus,
} from '../server/errorStatus.js';

test('表里的每个错误码都映射到说好的状态码', () => {
  for (const [code, status] of Object.entries(ENGINE_ERROR_STATUS)) {
    assert.equal(
      statusForEngineError({ code }),
      status,
      `错误码 ${code} 的状态码映射不对`
    );
  }
});

test('映射表的完整内容（加一条或改一条，这里都必须跟着改）', () => {
  assert.deepEqual(ENGINE_ERROR_STATUS, {
    invalid_structured_output: 400,
    unknown_structured_output: 400,
    invalid_history: 400,
    // 请求本身没有内容（网关的底线是「至少一条非 system 的非空消息」，
    // 这一点线上验过：只有 system 的请求会被回 2013）⇒ 400，
    // 不是 502 —— 502 的语义是「AI 侧挂了」。
    empty_history: 400,
    invalid_config: 500,
    invalid_schema: 500,
    empty_content: 502,
    invalid_content_type: 502,
  });
});

test('empty_reply 不在表里（它走特判分支，回 200）', () => {
  // 它不是失败：模型只交付了结构化块，那正是契约 1/2 的目标产出。
  assert.equal('empty_reply' in ENGINE_ERROR_STATUS, false);
});

test('网关的 ModelError → 502', () => {
  assert.equal(statusForEngineError(new ModelError('网关炸了', 500)), 502);
  // 同形的对象也一样（跨模块边界的 instanceof 不可靠，用 name 判）
  assert.equal(statusForEngineError({ name: 'ModelError', message: 'x' }), 502);
});

test('不认识 / 没有 code 的错 → 500', () => {
  assert.equal(statusForEngineError({ code: 'some_new_code' }), 500);
  assert.equal(statusForEngineError(new Error('boom')), 500);
  assert.equal(statusForEngineError(null), 500);
  assert.equal(statusForEngineError(undefined), 500);
  assert.equal(statusForEngineError('不是对象'), 500);
});

test('400 可以带原因，500 / 502 不带内部细节', () => {
  assert.deepEqual(errorBodyForStatus(400, { message: 'messages 必须是数组' }), {
    error: 'messages 必须是数组',
  });
  assert.deepEqual(errorBodyForStatus(500, { message: 'SQLITE_CONSTRAINT: ...' }), {
    error: 'Internal server error',
  });
  assert.deepEqual(errorBodyForStatus(502, { message: '网关原始报文 SECRET' }), {
    error: 'AI Gateway error',
  });
  // 400 没有 message 时也有话可说
  assert.deepEqual(errorBodyForStatus(400, null), { error: 'Bad request' });
});
