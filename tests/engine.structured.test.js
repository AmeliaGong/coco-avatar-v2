import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredInstruction,
  extractStructured,
  stripStructured,
  stripAllStructured,
  findAllStructuredSpans,
  STRUCTURED_MARKER,
} from '../server/engine/structuredOutput.js';
import { createModelClient, ModelError } from '../server/engine/modelClient.js';

test('结构化指令里包含 marker 与 schema', () => {
  const instr = buildStructuredInstruction({ title: '卡点标题' });
  assert.ok(instr.includes('"__structured__"'));
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
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) => err instanceof ModelError && err.status === 429
  );
});

// ---------------------------------------------------------------------------
// 新增：模型自由发挥 / 边界场景
// ---------------------------------------------------------------------------

test('模型先复述格式再给真块时，取到的是真块而不是模板占位值', () => {
  const text = [
    '好，我按 {"__structured__": {"title": "...", "evidence_against": ["..."]}} 的格式补充。',
    '{"__structured__": {"title": "我不能停下来", "evidence_against": ["a"]}}',
  ].join('\n');
  const parsed = extractStructured(text);
  assert.deepEqual(parsed, { title: '我不能停下来', evidence_against: ['a'] });
  // 占位值 "..." 绝不能被当成模型的答案
  assert.notEqual(parsed.title, '...');
});

test('结构化块前后都有正文时，剥离后前后正文都在', () => {
  const text = '前面的正文。\n{"__structured__": {"a": 1}}\n后面的正文。';
  const stripped = stripStructured(text);
  assert.ok(stripped.includes('前面的正文。'));
  assert.ok(stripped.includes('后面的正文。'));
  assert.ok(!stripped.includes(STRUCTURED_MARKER));
});

test('正文里的无关成对花括号不会被吃掉', () => {
  // 提到 marker 文字，但没有真正的结构化块
  const text = '你说的 {核心信念} 会被改写，我会输出 "__structured__"。';
  assert.equal(extractStructured(text), null);
  assert.equal(stripStructured(text), text);
  assert.ok(stripStructured(text).includes('{核心信念}'));

  // 无关的合法 JSON（顶层没有 marker 键）也不该被当成结构化块
  const text2 = '正文 { "a": 1 } 结束 "__structured__"';
  assert.equal(extractStructured(text2), null);
  assert.equal(stripStructured(text2), text2);
});

test('结构化块是坏 JSON 时安静降级，不抛错也不删正文', () => {
  const truncated = '这是正文。\n{"__structured__": {"title": "x"';
  assert.equal(extractStructured(truncated), null);
  assert.equal(stripStructured(truncated), truncated);
  assert.ok(stripStructured(truncated).includes('这是正文。'));

  const broken = '这是正文。\n{"__structured__": {"title": "x",}}\n还有正文。';
  assert.equal(extractStructured(broken), null);
  // 没认定出合法的块 → 一个字都不该动
  assert.equal(stripStructured(broken), broken);
  assert.ok(stripStructured(broken).includes('这是正文。'));
  assert.ok(stripStructured(broken).includes('还有正文。'));
});

test('usage 缺 total_tokens 时按 prompt+completion 补齐', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '你好' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  const result = await client({ systemPrompt: 'S', messages: [] });
  assert.equal(result.usage.total_tokens, 30);
});

test('marker 存在但值缺失时返回 null 而不是 undefined', () => {
  assert.equal(extractStructured('{"__structured__": null}'), null);
  assert.equal(extractStructured('{"__structured__": }'), null);
  assert.equal(extractStructured('{"__structured__"}'), null);
  // 有 marker 文字但没有真正的结构化值
  assert.equal(extractStructured('正文 { "a": 1 } 结束 "__structured__"'), null);
});

test('schemaHint 缺失或 fieldNotes 不是普通对象时直接抛错', () => {
  assert.throws(() => buildStructuredInstruction(undefined), /schemaHint/);
  assert.throws(() => buildStructuredInstruction(null), /schemaHint/);
  assert.throws(() => buildStructuredInstruction({}, '不是对象'), /fieldNotes/);
  assert.throws(() => buildStructuredInstruction({}, ['a']), /fieldNotes/);
});

test('网关错误时 ModelError 的 message 里含响应体内容', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 429,
    text: async () => '{"base_resp":{"status_code":1002,"status_msg":"rate limited"}}',
  });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) => err instanceof ModelError && err.message.includes('rate limited')
  );
});

test('网关没有 text() 时也不应该崩', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500 });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) => err instanceof ModelError && err.status === 500
  );
});

test('systemPrompt 缺失时抛错而不是发出坏请求', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ choices: [] }) };
  };
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ messages: [] }),
    (err) => err instanceof Error && /systemPrompt/.test(err.message)
  );
  await assert.rejects(
    () => client({ systemPrompt: '   ', messages: [] }),
    (err) => err instanceof Error && /systemPrompt/.test(err.message)
  );
  assert.equal(called, false);
});

test('调用方传入的 system 消息被剔除，请求体里只有一条 system', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '你好' } }] }),
    };
  };
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await client({
    systemPrompt: 'SYSTEM',
    messages: [
      { role: 'system', content: '调用方自己塞的 system' },
      { role: 'user', content: 'hi' },
    ],
  });
  const body = JSON.parse(calls[0].init.body);
  const systemMessages = body.messages.filter(m => m.role === 'system');
  assert.equal(systemMessages.length, 1);
  assert.equal(systemMessages[0].content, 'SYSTEM');
  assert.ok(!JSON.stringify(body.messages).includes('调用方自己塞的 system'));
});

test('200 但业务错误码非零且没有内容时抛 ModelError', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      base_resp: { status_code: 1004, status_msg: 'insufficient balance' },
      choices: [],
    }),
  });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) =>
      err instanceof ModelError && err.message.includes('insufficient balance')
  );
});

test('200 但完全没有内容时抛 ModelError（不留下空白气泡）', async () => {
  // 一次「成功」但什么都没返回的调用。以前这里会安静地返回空字符串，
  // 用户收到一个空白气泡，日志里什么都不留。
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) =>
      err instanceof ModelError &&
      err.status === 200 &&
      err.message.includes('没有返回任何内容')
  );
});

test('200 且业务错误码非零但有内容时不误伤，正常返回', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      base_resp: { status_code: 1004, status_msg: 'insufficient balance' },
      choices: [{ message: { content: '你好' } }],
    }),
  });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  const result = await client({ systemPrompt: 'S', messages: [] });
  assert.equal(result.content, '你好');
});

test('网关返回无法解析的响应时抛 ModelError 而不是原生 SyntaxError', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  });
  const client = createModelClient({ fetchImpl: fakeFetch, apiKey: 'k' });
  await assert.rejects(
    () => client({ systemPrompt: 'S', messages: [] }),
    (err) => err instanceof ModelError && err.status === 200
  );
});

test('模型用 ```json 围栏包裹结构化块时，剥离后不残留空围栏', () => {
  const text = '这是正文。\n```json\n{"__structured__": {"a": 1}}\n```';
  const stripped = stripStructured(text);
  assert.ok(!stripped.includes('```'));
  assert.ok(stripped.includes('这是正文。'));
  assert.deepEqual(extractStructured(text), { a: 1 });
});

test('指令里的 JSON 块仍以 "__structured__" 作为键出现', () => {
  const instr = buildStructuredInstruction({ title: '卡点标题' });
  assert.ok(instr.includes('"__structured__"'));
  const expectedJson = JSON.stringify({ [STRUCTURED_MARKER]: { title: '卡点标题' } }, null, 2);
  assert.ok(instr.includes(expectedJson));
});

// ---------------------------------------------------------------------------
// 剥掉「所有」结构化块（模型复述格式的那份也得剥掉）
// ---------------------------------------------------------------------------

test('findAllStructuredSpans 找出全部站得住脚的块', () => {
  const text = [
    '好，我按 {"__structured__": {"title": "..."}} 的格式补充。',
    '{"__structured__": {"title": "我不能停下来"}}',
  ].join('\n');
  const spans = findAllStructuredSpans(text);
  assert.equal(spans.length, 2);
  // 没有 marker 的文本里一块都没有
  assert.deepEqual(findAllStructuredSpans('只是一段普通回复'), []);
});

test('stripAllStructured 把复述的那份也剥掉，正文里不留 marker', () => {
  const text = [
    '好，我按 {"__structured__": {"title": "卡点的一句话概括"}} 的格式补充。',
    '{"__structured__": {"title": "我不能停下来"}}',
  ].join('\n');
  const stripped = stripAllStructured(text);
  assert.ok(!stripped.includes(STRUCTURED_MARKER));
  assert.ok(!stripped.includes('卡点的一句话概括'));
  assert.ok(stripped.includes('的格式补充'));
});

test('stripAllStructured 没认定出块时一个字都不动', () => {
  const text = '你说的 {核心信念} 会被改写，我会输出 "__structured__"。';
  assert.equal(stripAllStructured(text), text);
  const broken = '这是正文。\n{"__structured__": {"title": "x"';
  assert.equal(stripAllStructured(broken), broken);
});

test('stripAllStructured 清掉多个块留下的围栏残留', () => {
  const text = [
    '正文一',
    '```json',
    '{"__structured__": {"a": 1}}',
    '```',
    '正文二',
    '{"__structured__": {"b": 2}}',
  ].join('\n');
  const stripped = stripAllStructured(text);
  assert.ok(!stripped.includes('```'));
  assert.ok(!stripped.includes(STRUCTURED_MARKER));
  assert.ok(stripped.includes('正文一'));
  assert.ok(stripped.includes('正文二'));
});

test('stripStructured 的语义不变：只剥最后一个块', () => {
  // 与 stripAllStructured 的分工：stripStructured 保留「只剥最后一个」的行为，
  // extractStructured 也仍然取最后一个有效块。这条断言是为了防止有人
  // 「顺手」把 stripStructured 改成剥全部，悄悄改了既有语义。
  const text = [
    '复述 {"__structured__": {"title": "卡点的一句话概括"}}',
    '{"__structured__": {"title": "我不能停下来"}}',
  ].join('\n');
  const stripped = stripStructured(text);
  assert.ok(stripped.includes('卡点的一句话概括'));
  assert.deepEqual(extractStructured(text), { title: '我不能停下来' });
});
