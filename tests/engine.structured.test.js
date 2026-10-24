import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredInstruction,
  extractStructured,
  stripStructured,
  STRUCTURED_MARKER,
} from '../server/engine/structuredOutput.js';

test('结构化指令里包含 marker 与 schema', () => {
  const instr = buildStructuredInstruction({ title: '卡点标题' });
  assert.ok(instr.includes(STRUCTURED_MARKER));
  assert.ok(instr.includes('卡点标题'));
});

test('字段说明单独成段，不混进 JSON 里', () => {
  const schema = { worth_practicing: true };
  const instr = buildStructuredInstruction(schema, {
    worth_practicing: 'false 表示这一轮只交付诊断',
  });
  // 说明文字必须在指令里
  assert.ok(instr.includes('worth_practicing: false 表示这一轮只交付诊断'));
  // JSON 块必须还是「纯形状」—— 说明混进去模型会照抄进输出
  const expectedJson = JSON.stringify({ [STRUCTURED_MARKER]: schema }, null, 2);
  assert.ok(instr.includes(expectedJson));
});

test('能从回复中提取结构化对象', () => {
  const text = [
    '很好，这个触发场景已经很清晰了。',
    '{"__structured__": {"title": "我不能停下来", "evidence_against": ["a"]}}',
  ].join('\n');
  const parsed = extractStructured(text);
  assert.deepEqual(parsed, { title: '我不能停下来', evidence_against: ['a'] });
});

test('结构化 JSON 里有嵌套对象与字符串中的花括号时仍能正确提取', () => {
  const text = [
    '正文',
    '{"__structured__": {"diagnosis": {"core_belief": "他是 {这样} 的"}, "n": 1}}',
  ].join('\n');
  const parsed = extractStructured(text);
  assert.equal(parsed.diagnosis.core_belief, '他是 {这样} 的');
  assert.equal(parsed.n, 1);
});

test('没有 marker 时返回 null', () => {
  assert.equal(extractStructured('只是一段普通回复'), null);
});

test('剥离结构化块后正文干净', () => {
  const text = '这是正文。\n{"__structured__": {"title": "x"}}';
  const stripped = stripStructured(text);
  assert.ok(!stripped.includes(STRUCTURED_MARKER));
  assert.ok(stripped.includes('这是正文。'));
});

test('剥离后不留多余空行', () => {
  const text = '正文\n\n\n{"__structured__": {"a": 1}}';
  const stripped = stripStructured(text);
  assert.ok(!stripped.includes('\n\n\n'));
});

test('模型客户端把 MiniMax 响应解析成 content 与 usage', async () => {
  const { createModelClient } = await import('../server/engine/modelClient.js');
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    };
  };
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  const result = await client({
    systemPrompt: 'SYSTEM',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.content, '你好');
  assert.equal(result.usage.total_tokens, 30);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'SYSTEM');
  assert.equal(body.messages[1].content, 'hi');
});

test('模型网关报错时抛出带状态码的 ModelError', async () => {
  const { createModelClient, ModelError } = await import('../server/engine/modelClient.js');
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) => err instanceof ModelError && err.status === 429
  );
});
