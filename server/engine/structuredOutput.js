export const STRUCTURED_MARKER = '__structured__';

// schemaHint 是「值级示例」—— 模型照着它输出，所以它只描述形状。
// fieldNotes 承载语义（哪个必填、枚举有哪些、false 是什么意思），
// 单独一段渲染，不混进 JSON 里 —— 混进去模型会照抄成输出的一部分。
export function buildStructuredInstruction(schemaHint, fieldNotes) {
  const lines = [
    '',
    '---',
    '在你这一轮回复的最后，另起一行，输出一个 JSON 对象。',
    '这一行只能是 JSON，不要用代码块包裹，不要有多余解释文字。格式：',
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

// 找到 marker 所在的 JSON 对象边界。返回 {start, end}，end 为闭区间。
// 没找到返回 null。
export function findStructuredSpan(text) {
  if (!text) return null;
  const marker = `"${STRUCTURED_MARKER}"`;
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;
  const start = text.lastIndexOf('{', markerIdx);
  if (start < 0) return null;

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

export function extractStructured(text) {
  const span = findStructuredSpan(text);
  if (!span) return null;
  try {
    const parsed = JSON.parse(text.slice(span.start, span.end + 1));
    const value = parsed[STRUCTURED_MARKER];
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

export function stripStructured(text) {
  if (!text) return '';
  const span = findStructuredSpan(text);
  if (!span) return text;
  const before = text.slice(0, span.start).trimEnd();
  const after = text.slice(span.end + 1).trimStart();
  return [before, after].filter(Boolean).join('\n\n');
}
