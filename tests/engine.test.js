// 引擎测试不需要数据库，但仍然先加载 testEnv —— 与其他测试文件保持一致，
// 避免整套测试里出现两套环境约定。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCbtEngine } from '../server/engine/cbtEngine.js';

function makeEngine({ reply = '好的', structured = null, promptText = 'SYSTEM PROMPT' } = {}) {
  const calls = [];
  const callModel = async ({ systemPrompt, messages }) => {
    calls.push({ systemPrompt, messages });
    const body = structured
      ? `${reply}\n{"__structured__": ${JSON.stringify(structured)}}`
      : reply;
    return { content: body, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  };
  const engine = createCbtEngine({
    getPrompt: () => promptText,
    callModel,
    schemas: { stuck_point: { title: '卡点标题', belief: '限制性信念' } },
  });
  return { engine, calls };
}

test('引擎把场景 prompt 与历史消息传给模型', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'chat',
    // 历史里带一个多余字段：传给模型的每条消息只应该有 role 与 content，
    // 别的字段（比如内部 id、时间戳）不能顺手带进请求体。
    history: [{ role: 'user', content: '你好', id: 'm1', ts: 123 }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, 'SYSTEM PROMPT');
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: '你好' }]);
});

test('引擎返回剥离了结构化块的回复', async () => {
  const { engine } = makeEngine({
    reply: '这是正文。',
    structured: { title: '我不能停下来' },
  });
  const result = await engine({
    scenario: 'cbt_quick',
    history: [{ role: 'user', content: 'x' }],
    structuredOutput: 'stuck_point',
  });
  assert.equal(result.reply, '这是正文。');
  assert.deepEqual(result.structured, { title: '我不能停下来' });
});

test('引擎把 schema 提示拼进 system prompt', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'cbt_quick',
    history: [],
    structuredOutput: 'stuck_point',
  });
  assert.ok(calls[0].systemPrompt.includes('__structured__'));
  assert.ok(calls[0].systemPrompt.includes('卡点标题'));
});

test('schemas 传 { schema, notes } 时字段说明也进 system prompt', async () => {
  const calls = [];
  const callModel = async ({ systemPrompt }) => {
    calls.push({ systemPrompt });
    return { content: 'ok', usage: { total_tokens: 1 } };
  };
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel,
    schemas: {
      plan: {
        schema: { worth_practicing: true },
        notes: { worth_practicing: 'false 表示这一轮只交付诊断' },
      },
    },
  });
  await engine({ scenario: 'analysis', history: [], structuredOutput: 'plan' });
  assert.ok(calls[0].systemPrompt.includes('__structured__'));
  assert.ok(calls[0].systemPrompt.includes('false 表示这一轮只交付诊断'));
  // 说明只进「字段说明」段，绝不能混进 JSON 骨架 —— 混进去模型会照抄成输出的一部分。
  const skeleton = JSON.stringify({ __structured__: { worth_practicing: true } }, null, 2);
  assert.ok(calls[0].systemPrompt.includes(skeleton));
  assert.ok(!calls[0].systemPrompt.includes('"notes"'));
});

test('引擎把卡点与知识库注入 system prompt', async () => {
  const { engine, calls } = makeEngine();
  await engine({
    scenario: 'cbt_delivery',
    history: [],
    clientContext: {
      stuckPoint: { title: '我不能停下来', belief: '停下来就会被抛弃' },
      knowledge: [{ kind: 'case', title: '一个案例', content: '案例正文' }],
    },
  });
  assert.ok(calls[0].systemPrompt.includes('我不能停下来'));
  assert.ok(calls[0].systemPrompt.includes('案例正文'));
});

test('没有请求结构化输出时不追加 schema 指令', async () => {
  const { engine, calls } = makeEngine();
  const result = await engine({ scenario: 'chat', history: [] });
  assert.ok(!calls[0].systemPrompt.includes('__structured__'));
  assert.equal(result.structured, null);
});

test('没请求结构化输出时即便模型自己吐了结构化块，structured 仍然是 null', async () => {
  // 模型偶尔会自作主张多吐一个结构化块。这轮没要结构化输出，
  // 就不该凭空多出一个 structured 对象（下游会当成业务数据存库）。
  const { engine } = makeEngine({ reply: '好的', structured: { title: '多余' } });
  const result = await engine({ scenario: 'chat', history: [] });
  assert.equal(result.structured, null);
  assert.equal(result.reply, '好的');
});

test('引擎返回 usage 与场景标识', async () => {
  const { engine } = makeEngine();
  const result = await engine({ scenario: 'chat', history: [] });
  assert.equal(result.usage.total_tokens, 3);
  assert.equal(result.scenario, 'chat');
});

test('promptVersion 是 base 与 scenario 两个内容哈希用点连接', async () => {
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    getPromptMeta: () => ({
      baseVersion: 'a1b2c3d4',
      scenarioVersion: 'e5f60718',
      // 修订号是整数版本，不是内容哈希 —— promptVersion 里不能出现它们。
      baseRevision: 3,
      scenarioRevision: 7,
    }),
    callModel: async () => ({ content: 'ok', usage: { total_tokens: 1 } }),
  });
  const result = await engine({ scenario: 'chat', history: [] });
  assert.equal(result.promptVersion, 'a1b2c3d4.e5f60718');
});

test('没有 getPromptMeta 时 promptVersion 为 null', async () => {
  const { engine } = makeEngine();
  const result = await engine({ scenario: 'chat', history: [] });
  assert.equal(result.promptVersion, null);
});

test('未知结构化输出类型直接报错且不调用模型', async () => {
  const calls = [];
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel: async () => {
      calls.push(1);
      return { content: 'ok', usage: { total_tokens: 1 } };
    },
    schemas: { stuck_point: { title: '卡点标题' } },
  });
  await assert.rejects(
    () => engine({ scenario: 'chat', history: [], structuredOutput: 'nope' }),
    /未知的结构化输出类型：nope/
  );
  assert.equal(calls.length, 0);
});

test('原型链上的键名不是合法的结构化输出类型', async () => {
  // schemas 是普通对象，schemas['__proto__'] 会拿到 Object.prototype，
  // schemas['constructor'] 会拿到 Object —— 都不能当成已知类型，
  // 否则会带着垃圾骨架去调模型。structuredOutput 将来直接来自请求体。
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const calls = [];
    const engine = createCbtEngine({
      getPrompt: () => 'SYSTEM',
      callModel: async () => {
        calls.push(1);
        return { content: 'ok', usage: { total_tokens: 1 } };
      },
      schemas: { stuck_point: { title: '卡点标题' } },
    });
    await assert.rejects(
      () => engine({ scenario: 'chat', history: [], structuredOutput: key }),
      new RegExp(`未知的结构化输出类型：${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    assert.equal(calls.length, 0, `结构化输出类型 ${key} 不该调用模型`);
  }
});

test('schema 存在但无效时报错且不调用模型', async () => {
  const calls = [];
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel: async () => {
      calls.push(1);
      return { content: 'ok', usage: { total_tokens: 1 } };
    },
    schemas: {
      plan: {
        schema: undefined,
        notes: { worth_practicing: 'false 表示这一轮只交付诊断' },
      },
    },
  });
  await assert.rejects(
    () => engine({ scenario: 'analysis', history: [], structuredOutput: 'plan' }),
    (err) => {
      // 错误要说清楚是哪个类型的 schema 不对，而不是把 notes 当成 schema 拼进去。
      assert.match(err.message, /schema/);
      assert.match(err.message, /plan/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('schema 是字符串时同样报错且不调用模型', async () => {
  const calls = [];
  const engine = createCbtEngine({
    getPrompt: () => 'SYSTEM',
    callModel: async () => {
      calls.push(1);
      return { content: 'ok', usage: { total_tokens: 1 } };
    },
    schemas: { plan: { schema: 'worth_practicing' } },
  });
  await assert.rejects(
    () => engine({ scenario: 'analysis', history: [], structuredOutput: 'plan' }),
    /schema/
  );
  assert.equal(calls.length, 0);
});
