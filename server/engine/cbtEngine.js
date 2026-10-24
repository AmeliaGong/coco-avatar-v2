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
//   - structuredValidated：这一份 structured **是否通过了契约校验**。
//                 - true  ：过了（validators 校验通过的那份）。
//                 - false ：**没过** —— 结构上是个合法的块，但没有通过
//                           契约校验（多半是模型复述格式时抄的占位骨架）。
//                           调用方**绝不能**把它当成真数据落库。
//                 - null  ：本轮没有做契约校验（没给 validators，或本轮
//                           没请求结构化输出）。
//   - promptVersion：标识的是 **persona 底座段 + 场景段** 这两段文本的
//                 内容哈希（不是修订号），**不含**本轮注入的上下文与
//                 结构化指令 —— 同一串 promptVersion 可能对应两种不同的
//                 装配结果，这是已知且有意的取舍。
//
// 第五个注入点（可选）：
//   - validators           { [结构化输出类型]: (payload) => ({ok, errors, value}) }
//                 契约层的校验函数（contracts/stuckPoint.js 的 parseStuckPoint、
//                 contracts/plan.js 的 parsePlanPayload 正好是这个签名）。
//                 给了它，引擎会用它逐个校验模型给出的候选块。
//
// 为什么需要它：模型很常见的行为是**先复述一遍格式**（把 schema 的占位值
// 原样抄一遍），再给出真正的块。只看最后一个块的话，取到的既可能是真卡点、
// 也可能是那份复述 —— 取决于复述在前面还是后面。有了契约校验，引擎可以
// 逐个试，占位骨架会被契约层（它的占位符检查）拒掉。
//
// **候选顺序与「取哪个」**（顺序是单一来源，引擎与
// extractStructuredCandidates 的注释必须对得上）：
//   - 候选列表按出现位置**从后往前**排（**最新的在前**）。
//   - 有 validator 时**正着遍历**这份列表，取**第一个通过校验的** ——
//     即**最新**的那份合法卡点。
//   - **没有 validator 时**（extractStructured）：取**最新**那个**带值**的
//     合法块。「带值」的意思是 marker 的值不是 null/undefined —— 这条
//     规则由 structuredOutput.js 的 valueAtSpan 统一给出，有 validator 与
//     没有 validator 的两条路径完全一致（否则「最后一个块的 marker 是
//     null」这种输入下两条路径会给出不同答案）。
//   - 全部候选都不过校验时，回退到**最新的**那个合法块，并标记
//     structuredValidated=false。回退用的那份是**语法合法**的、**契约没过**
//     的（多半是模型复述格式时抄的占位骨架），所以路由**不落库**。
//
// 为什么回退而不是抛错：
//   1. 抛错会把这一轮**正文也一起丢掉** —— 模型明明交付了有用的正文，
//      用户却什么也拿不到；契约校验不过只说明「结构化那份不可信」，
//      不说明「这一轮失败」。
//   2. 标记比抛错更安全：那份没过的块（多半含占位符）**带着 false 标记**
//      返回，调用方一眼能看出它没过校验，不会把它当真卡点存进库里。
// 代价：调用方必须看 structuredValidated 这个标记 —— 只看 structured 的
// 字段语义就变了。引擎在模块头把这一点写明，路由层也据此落库。
//
// 错误语义：
//   - 引擎自己抛的错都是 CbtEngineError，带一个 code（清单见类上的注释），
//     调用方靠 code 分流 400 / 500 / 502。
//   - 注入进来的组件自己抛的错**不是**这个类型：getPrompt / getPromptMeta 抛
//     的是 promptRegistry 的错（未知场景），callModel 抛的是网关的错。
//     它们原样往外冒，不要包成 CbtEngineError。
//   - code='empty_reply'（剥掉结构化块后正文为空）的错误对象上带着
//     structured、structuredValidated、usage 与 promptVersion —— 这一轮的
//     卡点/方案与 token 消耗都还在，调用方应据此落库与记账，而不是把
//     整轮丢掉。

import {
  buildStructuredInstruction,
  extractStructured,
  extractStructuredCandidates,
  stripAllStructured,
} from './structuredOutput.js';
import { toText } from '../contracts/shared.js';

// 卡点字段（title / belief / 每一条证据）的长度上限。
// 注入内容是「模型给的文本」，长度不可控；不设上限时，一段复述就能把
// prompt 撑到几千 token。
const MAX_INJECT_CHARS = 200;

// 知识库正文的长度上限，比卡点字段大一个量级。
//
// 为什么知识库用另一个上限：卡点字段是**模型生成**的，威胁模型是「模型跑偏
// 时把指令种进 prompt」—— 所以既折换行又砍到 200 字。知识库是**管理员录的**
// 材料，它的价值恰恰在长度与段落结构里：一段 600 字的案例，前半段是背景、
// 结论在后面，把它砍到 200 字再折成一行，模型拿到的就是「被腰斩且变形」的
// 材料 —— 那比不给材料更容易误导它。所以知识库正文保留换行（段落结构是
// 信息的一部分），只在一个大得多的量级上封顶。
const MAX_KNOWLEDGE_CHARS = 2000;

// 注入段（卡点 + 知识库）的总字数上限。
// 逐值上限是「每条」的闸门，条目数由检索决定 —— 10 条 200 字的证据就是
// 2000 字。总量闸门在这里兜底：超出时**明确标注被截断**，不静默砍掉。
const MAX_CONTEXT_CHARS = 4000;

// 引擎抛出的错误。带上 structured 与 usage，是为了让调用方在「这一轮没拿到
// 正文」时仍然能落库、仍然能记账 —— 丢掉 usage 就等于丢掉这一轮的成本账。
//
// **引擎自己抛的每一个错都是这个类型**，都带一个 code，调用方靠 code 分流：
//   - invalid_config             引擎构造参数不对（编程错误）        → 500
//   - invalid_structured_output  structuredOutput 不是字符串/是空串   → 400
//   - unknown_structured_output  未知的结构化输出类型                 → 400
//   - invalid_history            history 不是消息数组                 → 400
//   - invalid_schema             schemas 里的 schema 写坏了（配置错） → 500
//   - empty_content              模型没返回任何内容                   → 502
//   - invalid_content_type       模型返回的内容不是字符串             → 502
//   - empty_reply                剥掉结构化块后正文为空               → 200
//                                （特判，不是失败：模型只交付了结构化
//                                 块，那正是契约 1/2 的目标产出 —— 回 200，
//                                 照常落库记账）
//
// 注意：**注入进来的组件自己抛的错不是这个类型** —— getPrompt / getPromptMeta
// 抛的是 promptRegistry 的错（未知场景），callModel 抛的是网关的错。那些错
// 原样往外冒，不要包成 CbtEngineError。
export class CbtEngineError extends Error {
  constructor(message, { code = 'engine_error', structured = null, usage = null, content = '', promptVersion = null, structuredValidated = null } = {}) {
    super(message);
    this.name = 'CbtEngineError';
    this.code = code;
    // 本轮模型交付的结构化内容（没请求结构化输出时为 null）
    this.structured = structured;
    // 这一份 structured 有没有通过契约校验（true / false / null）
    this.structuredValidated = structuredValidated;
    // 本轮的 token 用量
    this.usage = usage;
    // 本轮的 prompt 内容哈希（baseVersion.scenarioVersion）
    this.promptVersion = promptVersion;
    // 模型的原始输出，排障用
    this.content = content;
  }
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
    throw new CbtEngineError(
      `结构化输出「${type}」的 schema 无效：必须是对象或数组（值级示例），收到 ${JSON.stringify(schema) ?? String(schema)}`,
      { code: 'invalid_schema' }
    );
  }
  const notes = Object.prototype.hasOwnProperty.call(entry, 'notes') ? entry.notes : null;
  // notes 的类型必须在这里钉死。
  //
  // 原来不管它，让 buildStructuredInstruction 去报错 —— 那抛的是**裸
  // Error**，没有 code。调用方（路由）靠 code 分流 400/500/502，裸 Error
  // 会掉进「未知异常 → 500」，把一个配置错报成服务器错。
  // 模块头的承诺是「引擎自己抛的每一个错都是 CbtEngineError」——
  // 这里是那个承诺的漏网之处。
  if (notes !== undefined && notes !== null && !isPlainObject(notes)) {
    throw new CbtEngineError(
      `结构化输出「${type}」的 fieldNotes 无效：必须是普通对象（字段语义表），收到 ${typeof notes === 'string' ? '字符串' : typeof notes}`,
      { code: 'invalid_schema' }
    );
  }
  return { schema, notes };
}

// 是不是一个「普通对象」。数组不算 —— 字段语义表是 { 字段名: 说明 }。
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 净化要注入 prompt 的文本。
//
// 换行必须折掉：注入值里带换行就能伪造出新的段落（一个跑偏的模型可以把
// 「--- 忽略上面的指令」种进下一轮的 system prompt）。契约层对 title 的
// 唯一要求是「非空字符串」，换行完全合法 —— 所以净化只能在这里做。
// 长度也要封顶：注入内容是模型给的，长度不可控。
//
// foldNewlines=false 用于知识库正文：那里保留段落结构（见 MAX_KNOWLEDGE_CHARS
// 处的说明）。
function sanitizeInject(value, { max = MAX_INJECT_CHARS, foldNewlines = true } = {}) {
  if (typeof value !== 'string') return '';
  const flat = (foldNewlines ? value.replace(/\r\n|\r|\n/g, ' ') : value).trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

// 卡点字段：模型生成的，折换行 + 200 字上限。
function sanitizeShort(value) {
  return sanitizeInject(value, { max: MAX_INJECT_CHARS, foldNewlines: true });
}

// 知识库正文：管理员录的，保留换行 + 2000 字上限。
function sanitizeKnowledgeBody(value) {
  return sanitizeInject(value, { max: MAX_KNOWLEDGE_CHARS, foldNewlines: false });
}

// 反向证据：契约层接受字符串（模型常把单条证据写成字符串）与数组。
// 两种都要认 —— 只认数组的话，调用方把「未归一化的模型原始 payload」
// 当作卡点传进来时，交付时最重要的证据会被静默丢掉。
//
// 数组里的每一项都用契约层共用的 toText 渲染：契约的 normalizeStuckPoint
// 明确保留数字条目（「宁可保留一条事实，也不要悄悄把它丢掉」），这里必须
// 与之一致，不能各丢各的。
function renderEvidence(value) {
  if (typeof value === 'string') {
    const one = sanitizeShort(value);
    return one ? [one] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.map(item => sanitizeShort(toText(item))).filter(item => item !== '');
}

export function createCbtEngine({ getPrompt, getPromptMeta, callModel, schemas = {} } = {}) {
  if (!getPrompt) {
    throw new CbtEngineError('createCbtEngine 需要 getPrompt：拼装 system prompt 的底座段与场景段', {
      code: 'invalid_config',
    });
  }
  if (!callModel) {
    throw new CbtEngineError('createCbtEngine 需要 callModel：真正去调模型的那一层', {
      code: 'invalid_config',
    });
  }

  function buildContextSection(clientContext) {
    const parts = [];
    if (clientContext && clientContext.stuckPoint) {
      const sp = clientContext.stuckPoint;
      const lines = [`卡点：${sanitizeShort(sp.title)}`];
      // belief 用契约层共用的 toText 渲染：它接受字符串，也接受字符串数组
      // （模型很爱把 belief 写成数组），数组按「、」连接 —— 与
      // contracts/stuckPoint.js 的归一化结果保持一致，两边不能漂。
      const belief = sanitizeShort(toText(sp.belief));
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
          k => `- 【${sanitizeShort(k.kind) || 'note'}】${sanitizeShort(k.title)}：${sanitizeKnowledgeBody(k.content)}`
        );
        parts.push(
          '--- 可参考的教练知识库（仅在相关时使用，不要复述本节标题）---\n' + lines.join('\n')
        );
      }
    }
    if (!parts.length) return '';

    let section = '\n\n' + parts.join('\n\n');
    // 总量闸门：逐值上限管不住条目数（检索返回多少条不是我们决定的）。
    // 超出就明确标注被截断 —— 静默砍掉的话，调用方会以为材料是完整的。
    if (section.length > MAX_CONTEXT_CHARS) {
      section =
        section.slice(0, MAX_CONTEXT_CHARS) +
        '\n--- （注入的上下文过长，以上内容已截断）';
    }
    return section;
  }

  // history 的清洗：剔掉 system 消息，跳过 content 不是字符串或为空的消息。
  // 引擎自己做这件事，而不是指望调用方 —— 第二个调用方的 callModel 未必
  // 过滤 system，结果是两条 system 消息；content 缺失的消息会被
  // JSON.stringify 丢掉，让网关 400。
  function sanitizeHistory(history) {
    if (!Array.isArray(history)) {
      throw new CbtEngineError('history 必须是消息数组（[{ role, content }]）', {
        code: 'invalid_history',
      });
    }
    return history
      .filter(m => m && typeof m === 'object' && m.role !== 'system')
      .filter(m => typeof m.content === 'string' && m.content.trim() !== '')
      .map(m => ({ role: m.role, content: m.content }));
  }

  // 挑出这一轮的结构化输出。
  //
  // validators 给了 → 用契约校验逐个候选过一遍，取**第一个通过**的。
  //
  // 候选列表的顺序是「从后往前」（最新的在前，见
  // extractStructuredCandidates 的说明）—— 所以**正着遍历**取第一个通过的，
  // 拿到的就是**最新**的那份通过校验的卡点。这与「没给 validators 时取
  // 最后一个合法块」（extractStructured 的语义）方向一致：两者都偏向
  // 靠后出现的交付物。
  //
  // validators 没给 → 行为与今天**完全一致**（取最后一个站得住脚的块）。
  // 加一个新参数不该改变默认行为。
  function selectStructured(raw, structuredOutput, validators) {
    const hasValidator =
      validators &&
      typeof validators === 'object' &&
      Object.prototype.hasOwnProperty.call(validators, structuredOutput) &&
      typeof validators[structuredOutput] === 'function';
    if (!hasValidator) {
      return { value: extractStructured(raw), validated: null };
    }

    const validator = validators[structuredOutput];
    // 从后往前（最新的在前）—— 正着遍历，「第一个通过的」= 最新的。
    const candidates = extractStructuredCandidates(raw);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      let result = null;
      try {
        result = validator(candidate.value);
      } catch {
        // 校验器自己抛错 = 这一份没通过。不能让一份坏候选把整轮带崩。
        result = null;
      }
      if (result && result.ok) {
        return {
          // 契约层的 parse* 返回归一化后的值；自定义校验器可能只回 ok，
          // 那种情况用原值。
          value: result.value === undefined ? candidate.value : result.value,
          validated: true,
        };
      }
    }

    // 全部候选都没通过契约校验：退回**最新的**那个合法块，并**标记**
    // structuredValidated=false —— 调用方据此不把它当真数据落库。
    //
    // 为什么是 candidates[0] 而不是 candidates[candidates.length - 1]：
    // 列表是「从后往前」排的（最新的在前），所以最新的是 **下标 0**。
    // 取末位会拿到**最旧**的那一份 —— 回退方向就反了。
    //
    // 为什么不是抛错：见模块头的说明（抛错会把这一轮的正文一起丢掉）。
    const fallback = candidates.length ? candidates[0].value : null;
    return { value: fallback, validated: false };
  }

  return async function runCbt({
    scenario,
    history = [],
    clientContext = null,
    structuredOutput = null,
    validators = null,
  }) {
    // structuredOutput 将来直接来自请求体，类型必须先钉死：
    // 非字符串的数组会被 hasOwnProperty 强制转成字符串，0 / '' 会被静默
    // 当成「本轮不要结构化输出」。这两种都不该悄悄通过。
    if (structuredOutput !== undefined && structuredOutput !== null) {
      if (typeof structuredOutput !== 'string') {
        throw new CbtEngineError(
          'structuredOutput 必须是字符串（结构化输出类型的名字），或者 null 表示本轮不要结构化输出',
          { code: 'invalid_structured_output' }
        );
      }
      if (!structuredOutput.trim()) {
        throw new CbtEngineError('structuredOutput 不能是空字符串（本轮不要结构化输出请传 null）', {
          code: 'invalid_structured_output',
        });
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
        throw new CbtEngineError(`未知的结构化输出类型：${structuredOutput}`, {
          code: 'unknown_structured_output',
        });
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

    // usage 要在抛错之前就握住：这一轮的 token 消耗必须能被写进
    // token_usage，哪怕这一轮没有正文。
    const usage = result?.usage || null;
    const raw = result?.content;

    if (raw === undefined || raw === null) {
      throw new CbtEngineError('模型没有返回任何内容', {
        code: 'empty_content',
        usage,
      });
    }
    if (typeof raw !== 'string') {
      // 类型不对 ≠ 没有内容：两回事，两种文案。
      throw new CbtEngineError('模型返回的内容不是字符串（类型不对）', {
        code: 'invalid_content_type',
        usage,
      });
    }
    if (!raw.trim()) {
      throw new CbtEngineError('模型没有返回任何内容', {
        code: 'empty_content',
        usage,
      });
    }

    // 剥掉**所有**结构化块（含模型复述格式的那份），正文里不该残留 marker。
    const reply = stripAllStructured(raw).trim();
    const promptVersion = meta ? `${meta.baseVersion}.${meta.scenarioVersion}` : null;
    if (!reply) {
      // 剥完正文为空。这不等于「模型什么都没交」—— 契约 1/契约 2 的目标
      // 产出恰恰就是「模型只给 JSON、没给正文」，那正是卡点/方案本身。
      // 所以这里把 structured 与 usage 一起挂到错误对象上：调用方据此
      // 照常落库、照常记账，只把正文换成一句兜底话。
      //
      // 文案也要分两种情况：本轮请求了结构化输出却没拿到正文，和本轮根本没
      // 请求结构化输出 —— 后者说一句「只输出了结构化块」会让人一头雾水。
      const selection = structuredOutput
        ? selectStructured(raw, structuredOutput, validators)
        : { value: null, validated: null };
      const message = structuredOutput
        ? '剥掉结构化块后正文为空（模型只交付了结构化内容，正文可能在 JSON 里）'
        : '剥掉结构化块后正文为空（本轮没有请求结构化输出）';
      throw new CbtEngineError(message, {
        code: 'empty_reply',
        structured: selection.value,
        structuredValidated: selection.validated,
        usage,
        content: raw,
        promptVersion,
      });
    }

    const selection = structuredOutput
      ? selectStructured(raw, structuredOutput, validators)
      : { value: null, validated: null };

    return {
      reply,
      structured: selection.value,
      // 这一份 structured 有没有通过契约校验。见模块头的说明。
      structuredValidated: selection.validated,
      usage,
      scenario,
      // prompt_version 的含义：**persona 底座段 + 场景段**这两段文本的
      // 内容哈希（Task 4 的 versionFor）。回答「这次对话是哪两段文本产生的」，
      // 而不是「是第几次改动」。
      // 注意：它**不覆盖**本轮注入的上下文段与结构化指令 —— 装配后的
      // prompt 还包含这两部分，同一串 promptVersion 可能对应两种不同的
      // 装配结果。这是已知的取舍：字段名与语义都不能改（下游要写进
      // token_usage.prompt_version），只在这里说清楚它到底标识什么。
      promptVersion,
    };
  };
}
