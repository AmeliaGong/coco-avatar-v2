// 网关规则在**最后一层**的形状 —— 这一层**没有**守卫。
//
// 路由层和引擎层都会在请求发出去之前把「没有可发消息」的请求挡掉
// （路由 400、引擎 empty_history），所以这一层**正常情况下碰不到** 2013。
//
// 但它必须被测，原因有两个：
//   1. 断言「万一发出去了，失败方式是干净的 502，不是崩溃、也不是 200 空气泡」；
//   2. 把网关的真实规则钉在测试里 —— 规则写在注释里，注释会过期；
//      钉在测试里，过期了就会红。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient, ModelError } from '../server/engine/modelClient.js';
import { statusForEngineError, errorBodyForStatus } from '../server/errorStatus.js';
import { createGatewayRuleFetch } from './helpers/gatewayRule.js';

test('网关回 2013（没有可发消息）→ ModelError → 应用层映射成 502', async () => {
  const { fetchImpl, calls } = createGatewayRuleFetch();
  const client = createModelClient({ fetchImpl, apiKey: 'k' });

  let caught = null;
  try {
    await client({ systemPrompt: 'S', messages: [] });
    assert.fail('应当抛错：网关对只有 system 的请求回 2013');
  } catch (err) {
    caught = err;
  }

  // 这一层确实把请求发出去了（守卫在上一层，不在这一层）
  assert.equal(calls.length, 1);

  assert.ok(caught instanceof ModelError, '必须是 ModelError，不是别的错');
  assert.match(caught.message, /2013/);
  assert.match(caught.message, /chat content is empty/);
  // 业务错误裹在 HTTP 200 里 —— status 是网关的 HTTP 状态，不是业务码
  assert.equal(caught.status, 200);

  // 应用层看到 ModelError ⇒ 502（不是 500，也不是一个 200 的空气泡）
  const status = statusForEngineError(caught);
  assert.equal(status, 502);
  // 502 不带内部细节给客户端
  assert.deepEqual(errorBodyForStatus(status, caught), { error: 'AI Gateway error' });
});

test('只有 system 消息的请求 → 网关回 2013（线上验过的规则）', async () => {
  const { fetchImpl } = createGatewayRuleFetch();
  const client = createModelClient({ fetchImpl, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [{ role: 'system', content: 'S2' }] }),
    (err) => err instanceof ModelError && /2013/.test(err.message)
  );
});

test('只有 assistant 消息的请求：网关**接受**（2026-10-24 线上实测）', async () => {
  // 这条钉住一个反直觉的事实：网关的规则是「至少有一条非 system 的非空
  // 消息」，**不是**「最后一条必须是 user」。本平台也没有把后者当规则。
  const { fetchImpl, calls } = createGatewayRuleFetch({ content: '好的。' });
  const client = createModelClient({ fetchImpl, apiKey: 'k' });
  const result = await client({
    systemPrompt: 'S',
    messages: [{ role: 'assistant', content: 'hi' }],
  });
  assert.equal(result.content, '好的。');
  assert.equal(calls.length, 1);
});
