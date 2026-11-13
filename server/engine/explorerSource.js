// 把**本地**的 docs/探索者故事/*.md 解析成可入库的探索者素材。
//
// ⚠️ 这个模块不包含任何真人内容 —— 它只描述「怎么从 md 里把字段抠出来」。
// 被它读的那批 md 在 .gitignore 里（仓库是 public 的）。
//
// 素材的 md 结构（14 则都遵循同一套模板，细节有出入）：
//
//   # 姓名（副标题）                 ← 标题里的是姓名
//   > 分类 04 情绪与内在卡点 ｜ 编号 04-2
//   ## 一句话                       ← 目录里用的画像
//   ## 字段 | 匹配信号 | ... |        ← 表格行（有的文件叫「人物卡」）
//   ## 匹配定位                      ← 教育层级 / 分类 / 安全边界
//   ## 正文（按原小标题分段 · 原文逐字）
//   ### [段 0] ...                  ← 分段；**小标题只是内部记号**
//   ## 给 Coco Avatar 的使用说明（端上怎么讲）
//   ## 校对备注
//
// 三条规则（从素材录入时就定下的，这里必须守住）：
//   1. **原文逐字** —— 正文一个字都不改、不删（只去掉 markdown 的引用符）；
//   2. **小标题是内部记号，端上不显示** —— 所以 label 单独存，
//      注入时**只给 text**；
//   3. **校对备注不进口** —— 那些是「待确认」的笔误，不是要给用户看的内容。

const SECTION_HEADING = /^##\s+(.*)$/;
const SUBSECTION_HEADING = /^###\s+(.*)$/;

// 把文档切成「二级标题」为界的小节。
// 小节之前的部分（标题 + 分类那几行）单独放在 preamble 里。
export function splitSections(markdown) {
  const lines = String(markdown).split('\n');
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = SECTION_HEADING.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

function sectionByPrefix(sections, prefix) {
  return sections.find(s => s.title.startsWith(prefix)) || null;
}

function bodyOf(section) {
  return section ? section.lines.join('\n') : '';
}

// 去掉 markdown 的引用符（"> "）与行尾空白。
// ⚠️ 只去行首的 "> "，**不动行内的任何字符** —— 原文逐字。
function stripQuote(text) {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*>\s?/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}

// 去掉「[图片]」这类占位（素材里说端上不读它）。
function stripImagePlaceholders(text) {
  return text
    .split('\n')
    .filter(line => !/^\s*\[图片[^\]]*\]\s*$/.test(line))
    .join('\n');
}

// 从正文小节里切出各段。
// 小标题（`### [段 1] 原小标题：一、逃离压抑的原生家庭`）只作为 **label**
// 存下来 —— 它是内部记号，端上不显示。
export function parseSegments(section) {
  if (!section) return [];
  const lines = section.lines;
  const segments = [];
  let current = null;
  for (const line of lines) {
    const m = SUBSECTION_HEADING.exec(line);
    if (m) {
      if (current) segments.push(current);
      current = { label: m[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) segments.push(current);

  return segments
    .map(seg => ({
      label: seg.label,
      text: stripImagePlaceholders(stripQuote(seg.lines.join('\n'))).trim(),
    }))
    .filter(seg => seg.text);
}

// 从标题里取姓名：「# 某某 / 化名（副标题）」
// → name = 某某，aliases = [化名]。
//
// ⚠️ **这里只能用假例子** —— 仓库是 public 的，真人姓名不能出现在
// 被版本库跟踪的文件里（哪怕只是注释）。
export function parseName(titleLine) {
  const h1 = /^#\s+(.*)$/m.exec(titleLine);
  if (!h1) return { name: '', aliases: [] };
  // 去掉括号里的副标题（「（Gap · 00 后的自我教育探索）」）。
  const head = h1[1].split('（')[0].trim();
  const parts = head.split('/').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { name: '', aliases: [] };
  return { name: parts[0], aliases: parts.slice(1) };
}

// 匹配信号：表格行 `| 匹配信号 | 用户说「A」「B」时优先推这则 |`
// → 信号数组（去掉「」，去掉「用户说」与「时优先推这则」这些壳）。
export function parseMatchSignals(markdown) {
  const row = /^\|\s*匹配信号\s*\|(.*)\|\s*$/m.exec(markdown);
  if (!row) return [];
  const cell = row[1];
  const quoted = [...cell.matchAll(/「([^」]*)」/g)].map(m => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted;
  // 没有引号就退回按顿号/逗号切
  return cell
    .replace(/用户说|时优先推这则|优先推这则/g, '')
    .split(/[、，,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

// 教育层级：`- **教育层级**：**L3 给别人的教育** —— …`
// → { level: 'L3', label: 'L3 给别人的教育' }
export function parseEducationLevel(markdown) {
  const m = /-\s*\*\*教育层级\*\*：\s*\*\*(.+?)\*\*/m.exec(markdown);
  if (!m) return null;
  const label = m[1].trim();
  const level = /L[0-3]/.exec(label);
  return { level: level ? level[0] : null, label };
}

// 分类：`- **分类**：03（主线）；跨 02（…）` → 主导分类码 '03'
// 备选：抬头那行 `> 分类 04 情绪与内在卡点 ｜ 编号 04-2`
export function parseCategory(markdown) {
  const bullet = /-\s*\*\*分类\*\*：\s*(\d{2})/m.exec(markdown);
  if (bullet) return bullet[1];
  const header = />\s*分类\s*(\d{2})/m.exec(markdown);
  if (header) return header[1];
  return null;
}

// 安全边界：`匹配定位` 里以 🛡 开头的那些条目（只有部分素材有）。
export function parseSafety(sections) {
  const section = sectionByPrefix(sections, '匹配定位');
  if (!section) return null;
  const bullets = [];
  for (const line of section.lines) {
    if (/^\s*-\s*🛡/.test(line)) bullets.push(line.replace(/^\s*-\s*/, '').trim());
  }
  if (!bullets.length) return null;
  return bullets.join('\n');
}

// 使用说明：给 Coco 的「怎么讲」。整节收进来（它本来就是写给端上的）。
function parseGuide(sections) {
  const section = sectionByPrefix(sections, '给 Coco Avatar 的使用说明');
  if (!section) return null;
  const body = bodyOf(section).trim();
  return body || null;
}

// 一句话：目录里用的画像。
//
// ⚠️ **画像会被模型转述给用户**（"她当时比我更拧巴，她怎么走出来的"），
// 所以它比正文更需要小心：诊断词与创伤画面不能出现在画像里。
// ⇒ 画像走一道**脱敏**（见 redactProfile）。
//
// 正文（原文）**不走**这道脱敏 —— 原文逐字不改，素材自己的「安全边界」
// 负责约束模型怎么讲（不复制诊断词、不渲染画面）。
const PROFILE_REDACTIONS = [
  // 长词先替换（下面两条覆盖上面两条的子串）
  ['重度抑郁和中度焦虑', '情绪与焦虑上的严重困扰'],
  ['双相情感障碍', '严重的情绪困扰'],
  ['想结束生命', '最艰难的时候'],
  ['抑郁', '情绪低落'],
  ['自杀', '最极端的念头'],
];

/**
 * 画像脱敏：把诊断词与轻生的说法换成中性表达。
 *
 * ⚠️ **只对画像生效**，不碰正文（原文逐字）。
 * 换掉的不是事实，是「画像里不出现临床词」这件事 ——
 * 素材的安全边界明确要求「端上不复制诊断词、不给医疗建议」。
 */
export function redactProfile(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  for (const [from, to] of PROFILE_REDACTIONS) {
    out = out.split(from).join(to);
  }
  return out;
}

function parseOneLiner(sections) {
  const section = sectionByPrefix(sections, '一句话');
  if (!section) return '';
  const body = stripQuote(bodyOf(section));
  // 取第一段（空行分隔）
  const first = body.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)[0] || '';
  return redactProfile(first);
}

/**
 * 解析一则素材。
 *
 * @param {string} markdown md 全文
 * @param {object} [opts]
 * @param {string} [opts.id] 素材 id（默认取文件名）
 * @param {string} [opts.fallbackCategory] 分类兜底（从目录名推）
 * @returns {object|null} 素材记录；解析不出来返回 null
 */
export function parseExplorerMarkdown(markdown, opts = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const { preamble, sections } = splitSections(markdown);
  const { name, aliases } = parseName(preamble.join('\n'));
  if (!name) return null;

  const segments = parseSegments(sectionByPrefix(sections, '正文'));
  if (!segments.length) return null;

  const edu = parseEducationLevel(markdown);
  const oneLiner = parseOneLiner(sections);

  return {
    id: opts.id || '',
    name,
    aliases,
    category: parseCategory(markdown) || opts.fallbackCategory || null,
    education_level: edu ? edu.level : null,
    education_label: edu ? edu.label : null,
    one_liner: oneLiner,
    match_signals: parseMatchSignals(markdown),
    tags: [],
    segments,
    guide: parseGuide(sections),
    safety: parseSafety(sections),
  };
}
