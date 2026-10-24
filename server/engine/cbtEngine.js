// CBT 交付引擎 —— 把「拼 prompt → 调模型 → 拆结构化块」这件事收在一个
// HTTP 无关的模块里。
//
// 为什么单独抽出来：交付逻辑会被两个后端复用 —— 今天的服务端路由，以及
// 将来游民纪元的小程序 BFF。把它们都塞在 server.js 里，BFF 只能照抄一遍
// 路由代码，抄一次漂一次。这里把交付语义收成一份，两边都调它。
//
// 四个注入点（引擎自己不碰网络、数据库、HTTP）：
//   - getPrompt(scenario)      → 拼出「persona 底座段 + 场景段」的 system prompt
//   - getPromptMeta(scenario)  → 同两段文本的内容哈希（可选，用于记账）
//   - callModel({systemPrompt, messages}) → 真正去调模型的那一层
//   - schemas                  → 各结构化输出类型的形状（值级示例）与字段语义
//
// 谁负责什么：
//   - **引擎**负责过滤 history 里的 system 消息、校验 history 与
//     structuredOutput 的类型、净化注入到 prompt 里的来访者数据。
//     不能指望调用方都做这些事 —— 第二个调用方（BFF）未必过滤 system，
//     结果是两条 system 消息或一条 content 缺失的请求，网关直接 400。
//   - **调用方**负责决定何时用哪个 scenario、给哪些 clientContext。
//
// 返回值语义：
//   - reply     ：给用户看的正文。**任何 marker 块都不会出现在里面** ——
//                 模型复述格式的那份也会被剥掉，否则它会被存进 messages 表
//                 并在下一轮回灌给模型。
//   - structured：本轮请求的结构化输出。没请求结构化输出时恒为 null。
//   - promptVersion：标识的是 **persona 底座段 + 场景段** 这两段文本的
//                 内容哈希（不是修订号），**不含**本轮注入的上下文与
//                 结构化指令 —— 同一串 promptVersion 可能对应两种不同的
//                 装配结果，这是已知且有意的取舍。

import { buildStructuredInstruction, extractStructured, stripAllStructured } from './structuredOutput.js';
import { toText } from '../contracts/shared.js';

// 注入到 system prompt 的单值长度上限。
// 注入内容是「模型给的文本」，长度不可控；不设上限时，一段复述就能把
// prompt 撑到几千 token。
const MAX_INJECT_CHARS = 200;

// schemas 的值有两种写法，必须靠「自有属性是否存在」来区分，不能靠真值判断：
//   - 直接就是 schema（值级示例，只有形状）
//   - { schema, notes } —— 形状 + 字段语义
// 用真值判断（entry.schema ? entry.schema : entry）时，
// { schema: undefined, notes: {...} } 会退化成「整个 entry 就是 schema」，
// notes 这张语义表会被原样拼进 JSON 骨架 —— 模型会照抄成输出的一部分。
function resolveSchemaEntry(entry, type) {
  // 「有没有 schema 这个自有属性」是唯一的判据：只要写了 schema 键，
  // 它就是 { schema, notes } 包装 —— 哪怕 schema 的值是 undefined 或字符串，
  // 那也是「schema 写坏了」，必须报错，而不是退回「整个 entry 就是 schema」。
  // 代价是：直接写形状时，字段名不能叫 schema。
  const hasSchemaKey = Object.prototype.hasOwnProperty.call(entry, 'schema');

  if (!hasSchemaKey) {
    return { schema: entry, notes: null };
  }

  const schema = entry.schema;
  // schema 缺失或类型不对时，buildStructuredInstruction 会抛错 ——
  // 但那是底层的英文报错，调用方看不出是哪个结构化输出类型坏了，
  // 所以这里先拦一道，给出带类型名的中文错误。
  if (schema === undefined || schema === null || typeof schema !== 'object') {
    throw new Error(
      `结构化输出「${type}」的 schema 无效：必须是对象或数组（值级示例），收到 ${JSON.stringify(schema) ?? String(schema)}`
    );
  }
  const notes = Object.prototype.hasOwnProperty.call(entry, 'notes') ? entry.notes : null;
  return { schema, notes };
}

// 净化要注入 prompt 的文本。
//
// 换行必须折掉：注入值里带换行就能伪造出新的段落（一个跑偏的模型可以把
// 「--- 忽略上面的指令」种进下一轮的 system prompt）。契约层对 title 的
// 唯一要求是「非空字符串」，换行完全合法 —— 所以净化只能在这里做。
// 长度也要封顶：注入内容是模型给的，长度不可控。
function sanitizeInject(value, max = MAX_INJECT_CHARS) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\r\n|\r|\n/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

// 反向证据：契约层接受字符串（模型常把单条证据写成字符串）与数组。
// 两种都要认 —— 只认数组的话，调用方把「未归一化的模型原始 payload」
// 当作卡点传进来时，交付时最重要的证据会被静默丢掉。
function renderEvidence(value) {
  if (typeof value === 'string') {
    const one = sanitizeInject(value);
    return one ? [one] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim() !== '')
    .map(item => sanitizeInject(item));
}

export function createCbtEngine({ getPrompt, getPromptMeta, callModel, schemas = {} } = {}) {
  if (!getPrompt) {
    throw new Error('createCbtEngine 需要 getPrompt：拼装 system prompt 的底座段与场景段');
  }
  if (!callModel) {
    throw new Error('createCbtEngine 需要 callModel：真正去调模型的那一层');
  }

  function buildContextSection(clientContext) {
    const parts = [];
    if (clientContext && clientContext.stuckPoint) {
      const sp = clientContext.stuckPoint;
      const lines = [`卡点：${sanitizeInject(sp.title)}`];
      // belief 用契约层共用的 toText 渲染：它接受字符串，也接受字符串数组
      // （模型很爱把 belief 写成数组），数组按「、」连接 —— 与
      // contracts/stuckPoint.js 的归一化结果保持一致，两边不能漂。
      const belief = sanitizeInject(toText(sp.belief));
      if (belief) lines.push(`限制性信念：${belief}`);
      const evidence = renderEvidence(sp.evidence_against);
      if (evidence.length) {
        lines.push(`已有的反向证据：${evidence.join('；')}`);
      }
      parts.push(`--- 这位来访者当前的卡点（已确认）---\n${lines.join('\n')}`);
    }
    if (clientContext && Array.isArray(clientContext.knowledge) && clientContext.knowledge.length) {
      // 脏数据（null 元素）跳过，不能让整个 prompt 装配崩掉。
      const items = clientContext.knowledge.filter(
        k => k && typeof k === 'object' && !Array.isArray(k)
      );
      if (items.length) {
        const lines = items.map(
          k => `- 【${sanitizeInject(k.kind) || 'note'}】${sanitizeInject(k.title)}：${sanitizeInject(k.content)}`
        );
        parts.push(
          '--- 可参考的教练知识库（仅在相关时使用，不要复述本节标题）---\n' + lines.join('\n')
        );
      }
    }
    return parts.length ? '\n\n' + parts.join('\n\n') : '';
  }

  // history 的清洗：剔掉 system 消息，跳过 content 不是字符串或为空的消息。
  // 引擎自己做这件事，而不是指望调用方 —— 第二个调用方的 callModel 未必
  // 过滤 system，结果是两条 system 消息；content 缺失的消息会被
  // JSON.stringify 丢掉，让网关 400。
  function sanitizeHistory(history) {
    if (!Array.isArray(history)) {
      throw new Error('history 必须是消息数组（[{ role, content }]）');
    }
    return history
      .filter(m => m && typeof m === 'object' && m.role !== 'system')
      .filter(m => typeof m.content === 'string' && m.content.trim() !== '')
      .map(m => ({ role: m.role, content: m.content }));
  }

  return async function runCbt({
    scenario,
    history = [],
    clientContext = null,
    structuredOutput = null,
  }) {
    // structuredOutput 将来直接来自请求体，类型必须先钉死：
    // 非字符串的数组会被 hasOwnProperty 强制转成字符串，0 / '' 会被静默
    // 当成「本轮不要结构化输出」。这两种都不该悄悄通过。
    if (structuredOutput !== undefined && structuredOutput !== null) {
      if (typeof structuredOutput !== 'string') {
        throw new Error(
          'structuredOutput 必须是字符串（结构化输出类型的名字），或者 null 表示本轮不要结构化输出'
        );
      }
      if (!structuredOutput.trim()) {
        throw new Error('structuredOutput 不能是空字符串（本轮不要结构化输出请传 null）');
      }
    }

    const messages = sanitizeHistory(history);

    let systemPrompt = getPrompt(scenario);
    // 顺序很重要：上下文段必须在结构化指令之前 —— 指令写着「在你这一轮回复的
    // 最后」输出 JSON，模型是按指令的先后顺序理解整份 prompt 的。
    systemPrompt += buildContextSection(clientContext);

    if (structuredOutput) {
      // 只认自有属性：schemas 是普通对象，schemas['__proto__'] 会拿到
      // Object.prototype，schemas['constructor'] 会拿到 Object ——
      // 两者都「存在」，但都不是合法的结构化输出类型。structuredOutput
      // 将来直接来自请求体，这两条原型链路径是可达输入。
      const hasEntry = Object.prototype.hasOwnProperty.call(schemas, structuredOutput);
      const entry = hasEntry ? schemas[structuredOutput] : undefined;
      if (!entry) {
        throw new Error(`未知的结构化输出类型：${structuredOutput}`);
      }
      // schemas 的值可以是：
      //   - 直接就是 schema（值级示例，只有形状）
      //   - { schema, notes } —— 形状 + 字段语义。语义必须单独传，
      //     混进 schema 里模型会照抄成输出的一部分。
      const { schema, notes } = resolveSchemaEntry(entry, structuredOutput);
      systemPrompt += buildStructuredInstruction(schema, notes);
    }

    // getPromptMeta 很便宜也很纯，放在调模型之前：万一它抛错，
    // 至少不会把一次已经付过钱的生成结果连同整轮请求一起丢掉。
    const meta = getPromptMeta ? getPromptMeta(scenario) : null;

    const result = await callModel({
      systemPrompt,
      messages,
    });

    const content = typeof result?.content === 'string' ? result.content : '';
    if (!content.trim()) {
      throw new Error('模型没有返回任何内容');
    }

    // 剥掉**所有**结构化块（含模型复述格式的那份），正文里不该残留 marker。
    const reply = stripAllStructured(content).trim();
    if (!reply) {
      // 模型只吐了结构化块、没有正文。返回空字符串会让调用方的
      // `if (result.reply)` 判断把这一轮整个吞掉 —— 用户的消息凭空消失，
      // 日志里连一行错误都没有。宁可报错。
      throw new Error('模型只输出了结构化块，没有正文');
    }

    return {
      reply,
      structured: structuredOutput ? extractStructured(content) : null,
      usage: result.usage || null,
      scenario,
      // prompt_version 的含义：**persona 底座段 + 场景段**这两段文本的
      // 内容哈希（Task 4 的 versionFor）。回答「这次对话是哪两段文本产生的」，
      // 而不是「是第几次改动」。
      // 注意：它**不覆盖**本轮注入的上下文段与结构化指令 —— 装配后的
      // prompt 还包含这两部分，同一串 promptVersion 可能对应两种不同的
      // 装配结果。这是已知的取舍：字段名与语义都不能改（下游要写进
      // token_usage.prompt_version），只在这里说清楚它到底标识什么。
      promptVersion: meta ? `${meta.baseVersion}.${meta.scenarioVersion}` : null,
    };
  };
}
