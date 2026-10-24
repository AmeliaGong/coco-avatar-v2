export const STRUCTURED_MARKER = '__structured__';

// 带引号的 marker token —— 模型输出里必须作为 JSON 键出现才算数。
const MARKER_TOKEN = `"${STRUCTURED_MARKER}"`;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// schemaHint 是「值级示例」—— 模型照着它输出，所以它只描述形状。
// fieldNotes 承载语义（哪个必填、枚举有哪些、false 是什么意思），
// 单独一段渲染，不混进 JSON 里 —— 混进去模型会照抄成输出的一部分。
export function buildStructuredInstruction(schemaHint, fieldNotes) {
  // schemaHint 缺失时 JSON.stringify({[marker]: undefined}) 会产出 "{}"，
  // 指令里就没有 marker 键，模型完全不知道要输出什么 —— 那轮会静默丢掉
  // 结构化输出。拼装期失败远好于每轮静默降级。
  if (schemaHint === undefined || schemaHint === null) {
    throw new Error(
      'buildStructuredInstruction：schemaHint 必填（值级示例），缺失会让指令里没有 marker 键'
    );
  }
  if (typeof schemaHint !== 'object') {
    throw new Error(
      'buildStructuredInstruction：schemaHint 必须是对象或数组（值级示例），不能用字符串/数字'
    );
  }
  if (fieldNotes !== undefined && fieldNotes !== null && !isPlainObject(fieldNotes)) {
    throw new Error(
      'buildStructuredInstruction：fieldNotes 必须是普通对象（字段语义），不能用字符串/数组'
    );
  }

  const lines = [
    '',
    '---',
    '在你这一轮回复的最后，另起一行（可以多行），输出一个 JSON 对象。',
    '整个 JSON 必须能被直接解析，不要用代码块包裹，不要有多余解释文字。格式：',
    JSON.stringify({ [STRUCTURED_MARKER]: schemaHint }, null, 2),
  ];
  if (fieldNotes && Object.keys(fieldNotes).length > 0) {
    lines.push('字段说明（只用于理解，不要出现在你输出的 JSON 里）：');
    for (const [field, note] of Object.entries(fieldNotes)) {
      lines.push(`- ${field}: ${note}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// 从 start 开始做花括号配对扫描，得到 {start, end}（end 为闭区间）。
// 对嵌套对象与字符串里的花括号都是对的。没配平返回 null。
function scanBraceSpan(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

// 找出「真正的」结构化块。
//
// 模型很常见的行为：先在正文里复述一遍格式（把 schema 的占位值原样抄一遍），
// 再给出真正的块。所以不能简单地取第一个 marker —— 那会拿到模板占位值，
// 而占位值往往是非空字符串，校验会放行，然后库里存进一条假卡点。
//
// 规则：收集所有 marker 出现位置，**从后往前**枚举（指令要求结构化块在回复末尾），
// 每个候选都要自己站得住脚才算数：能配平、能 JSON.parse、且顶层有 marker 键。
// 第一个站得住脚的候选就是答案。
export function findStructuredSpan(text) {
  if (!text) return null;

  const candidates = collectMarkerIndexes(text);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const span = spanAt(text, candidates[i]);
    if (span) return span;
  }
  return null;
}

// 一个 marker 候选到底算不算「结构化块」：
// 能配平、能 JSON.parse、且顶层有 marker 键 —— 三条都要满足。
// 「取最后一个」与「取全部」两套行为共用这段判断，判定标准才不会漂。
// 这个 span 是不是嵌在别的对象里。
//
// {"data": {"__structured__": 1}, "note": "x"} —— 内层对象自身「顶层带
// marker 键」，会被误认成结构化块；剥掉它会在正文里留下一段语法非法的
// JSON（'{"data":, "note": "x"}'）给用户看。嵌在别人身上的 marker 不是
// 「这一轮的结构化输出」。
//
// 判据是「起点之前有没有还没配平的 '{'」：有就是嵌在某个对象里。
// 比「前一个字符是不是 ':' 或 ','」准 —— 正文里写「答案: {"__structured__"…」
// 这种紧挨着的冒号会把顶层块也误杀，丢掉的可是整轮的卡点。
function isNestedInObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '}') {
      depth++;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

function spanAt(text, markerIdx) {
  const start = text.lastIndexOf('{', markerIdx);
  if (start < 0) return null;

  if (isNestedInObject(text, start)) return null;

  const span = scanBraceSpan(text, start);
  if (!span) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(span.start, span.end + 1));
  } catch {
    // 这不是结构化块（比如正文里的 "{核心信念}"，或被截断的 JSON）—— 试上一个。
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Object.prototype.hasOwnProperty.call(parsed, STRUCTURED_MARKER)) return null;

  return span;
}

// 收集所有 marker 出现位置。
function collectMarkerIndexes(text) {
  const candidates = [];
  if (!text) return candidates;
  let idx = text.indexOf(MARKER_TOKEN);
  while (idx >= 0) {
    candidates.push(idx);
    idx = text.indexOf(MARKER_TOKEN, idx + 1);
  }
  return candidates;
}

// 找出**所有**站得住脚的结构化块，按出现位置从前往后排。
//
// 为什么需要「全部」：模型复述格式的那份块同样是合法 JSON，正文里留着它
// 就等于把一份占位值 JSON 交给用户看、并存进 messages 表。取最后一个
// （findStructuredSpan）解决的是「答案取哪一份」，解决不了「正文里还留着几份」。
export function findAllStructuredSpans(text) {
  const candidates = collectMarkerIndexes(text);
  const spans = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const span = spanAt(text, candidates[i]);
    if (span) spans.push(span);
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

export function extractStructured(text) {
  const span = findStructuredSpan(text);
  if (!span) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(span.start, span.end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed[STRUCTURED_MARKER];
  return value === undefined || value === null ? null : value;
}

// 模型偶尔用 ```json 围栏包裹结构化块（指令明说不要，但模型常犯），
// 剥掉块之后会残留空围栏，这里顺带清掉紧邻的围栏残留。
function removeTrailingFence(text) {
  return text.replace(/[ \t]*```[A-Za-z0-9_+.-]*[ \t]*\r?\n?$/, '').trimEnd();
}

function removeLeadingFence(text) {
  return text.replace(/^\s*```[A-Za-z0-9_+.-]*[ \t]*\r?\n?/, '').trimStart();
}

export function stripStructured(text) {
  if (!text) return '';
  const span = findStructuredSpan(text);
  // 没认定出块，就一个字都不动 —— 绝不能因为「看起来像」就吃掉正文。
  if (!span) return text;
  const before = removeTrailingFence(text.slice(0, span.start));
  const after = removeLeadingFence(text.slice(span.end + 1));
  return [before, after].filter(Boolean).join('\n\n');
}

// 剥掉**所有**站得住脚的结构化块。
//
// stripStructured 只剥最后一个（findStructuredSpan 的语义）。但模型经常先在
// 正文里复述一遍格式（把 schema 的占位值原样抄一遍），再给出真正的块 ——
// 只剥真块的话，那份复述原样留在正文里，会被当成用户气泡展示、存进
// messages 表，并在下一轮回灌给模型。
//
// 语义与 stripStructured 一致：没认定出块就一个字都不动。
export function stripAllStructured(text) {
  if (!text) return '';
  const spans = findAllStructuredSpans(text);
  if (!spans.length) return text;

  // 同一段文本里 marker 嵌套时会把外块与内块都认出来；
  // 被包住的块随外块一起消失，不要重复处理。
  const kept = [];
  for (const span of spans) {
    const contained = kept.some(k => span.start >= k.start && span.end <= k.end);
    if (!contained) kept.push(span);
  }
  kept.sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const span of kept) {
    out += removeTrailingFence(text.slice(cursor, span.start));
    cursor = span.end + 1;
    // 块后面紧跟的围栏开头（```json）也要清掉，否则会留下空围栏。
    const fence = /^\s*```[A-Za-z0-9_+.-]*[ \t]*\r?\n?/.exec(text.slice(cursor));
    if (fence) cursor += fence[0].length;
  }
  out += removeTrailingFence(text.slice(cursor));
  return out;
}
