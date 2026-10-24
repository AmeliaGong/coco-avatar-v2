import { buildStructuredInstruction, extractStructured, stripStructured } from './structuredOutput.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

export function createCbtEngine({ getPrompt, getPromptMeta, callModel, schemas = {} } = {}) {
  if (!getPrompt) throw new Error('getPrompt is required');
  if (!callModel) throw new Error('callModel is required');

  function buildContextSection(clientContext) {
    const parts = [];
    if (clientContext && clientContext.stuckPoint) {
      const sp = clientContext.stuckPoint;
      const lines = [`卡点：${sp.title || ''}`];
      if (sp.belief) lines.push(`限制性信念：${sp.belief}`);
      if (Array.isArray(sp.evidence_against) && sp.evidence_against.length) {
        lines.push(`已有的反向证据：${sp.evidence_against.join('；')}`);
      }
      parts.push(`--- 这位来访者当前的卡点（已确认）---\n${lines.join('\n')}`);
    }
    if (clientContext && Array.isArray(clientContext.knowledge) && clientContext.knowledge.length) {
      const lines = clientContext.knowledge.map(
        k => `- 【${k.kind || 'note'}】${k.title || ''}：${k.content || ''}`
      );
      parts.push(
        '--- 可参考的教练知识库（仅在相关时使用，不要复述本节标题）---\n' + lines.join('\n')
      );
    }
    return parts.length ? '\n\n' + parts.join('\n\n') : '';
  }

  return async function runCbt({ scenario, history = [], clientContext = null, structuredOutput = null }) {
    let systemPrompt = getPrompt(scenario);
    systemPrompt += buildContextSection(clientContext);

    if (structuredOutput) {
      const entry = schemas[structuredOutput];
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

    const result = await callModel({
      systemPrompt,
      messages: history.map(m => ({ role: m.role, content: m.content })),
    });

    const meta = getPromptMeta ? getPromptMeta(scenario) : null;

    return {
      reply: stripStructured(result.content),
      structured: structuredOutput ? extractStructured(result.content) : null,
      usage: result.usage || null,
      scenario,
      // prompt_version 的含义：装配后 prompt 的**内容哈希来源** ——
      // base 段与 scenario 段各自的内容哈希（Task 4 的 versionFor）。
      // 回答「这次对话是哪两段文本产生的」，而不是「是第几次改动」。
      promptVersion: meta ? `${meta.baseVersion}.${meta.scenarioVersion}` : null,
    };
  };
}
