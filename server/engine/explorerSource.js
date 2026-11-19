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
//
// ⚠️ 2026-11-19 补一条：**编辑说明也不进口**（见下面的「编辑说明」）。
// 素材的正文里混着写给端上的说明（「**端上处理**：……」）与结构标签
// （「【个人项目】」）—— 它们一旦进 prompt，模型就会**照着念出来**，
// 用户会听到"这是写给端上的说明"这种内部话。
// 剔掉的是**编辑说明**，不是原文。

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

// ── 编辑说明 / 结构标签：不是原文，端上不能出现 ──────────────────
//
// 素材的正文里混着三类**不是原文**的东西：
//   1. 「**端上处理**：……」—— 写给端上的说明（怎么介绍、要什么钩子）；
//   2. 「【个人项目】」「【生命故事】」这类**结构标签**（原文的分区标题）；
//   3. 「▲某个时期：20岁之前」这类**排版注解**。
//
// 不剔掉的话，模型会把它们**当正文念出来** —— 用户读到的是
// "端上处理：…"这种内部说明。
//
// ⚠️ 剔的只是**编辑说明**，原文一个字都不动。

// 「**端上处理**：……」这类写给端上的说明（独占一行或独占一段）。
const EDITORIAL_MARK = /^\s*\*\*端上处理\*\*/;
// 结构标签：【个人项目】/【生命故事】/【个人简介】…
// 第 1 组是标签名，第 2 组是标签后面**同行**的正文。
const TAG_LINE = /^\s*【([^】]*)】\s*(.*)$/;
// 「关键词：……」这类标签行（是清单，不是散文）。
const KEYWORD_LINE = /^\s*(关键词|标签|Tags?)\s*[:：]/i;
// 分隔线（markdown 的排版，不是内容）。
const RULE_LINE = /^\s*[-*_]{3,}\s*$/;

// 「人物卡 / 人物简介 / 履历清单 / 非叙事」这类小节是**人物卡**，不是故事段。
// 它们的讲法不一样（2-3 句介绍），所以要单独标出来。
const INTRO_LABEL = /(人物卡|人物简介|个人简介|履历清单|事实卡|非叙事)/;
// 「【如何与你进行学习互动】」这类小节是**互动说明** —— 既不是故事，
// 也不是人物介绍 ⇒ 整段不要。
const NON_STORY_LABEL = /(如何与你进行学习互动|学习互动)/;
// 人物卡里的「互动/话题/交流」小块 —— 那是"能聊什么"，不是"她是谁"。
const NON_INTRO_CARD_TAG = /(互动|话题|交流)/;

/**
 * 剔掉编辑说明与结构标签，**保留原文**。
 *
 * 规则（逐行）：
 *   - 一段里只要有一行是「**端上处理**：」⇒ **整段丢掉**
 *     （说明常常横跨两行，只删打头那行会留下半截说明）；
 *   - 独占一行的结构标签（`【生命故事】`）⇒ 整行丢掉；
 *   - 跟在正文后面的结构标签（`【个人简介】热爱公益…`）⇒ 只去掉标签本身；
 *   - 分隔线、关键词行 ⇒ 丢掉；
 *   - 其它行 ⇒ **一字不改**。
 */
export function stripEditorial(text) {
  if (typeof text !== 'string' || !text) return '';
  const kept = [];
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n');
    if (lines.some(l => EDITORIAL_MARK.test(l))) continue;
    const out = [];
    for (const line of lines) {
      if (RULE_LINE.test(line)) continue;
      if (KEYWORD_LINE.test(line)) continue;
      const tag = TAG_LINE.exec(line);
      if (tag) {
        const rest = tag[2].trim();
        if (!rest) continue; // 独占一行的结构标签 ⇒ 整行丢掉
        out.push(rest); // 标签后面有正文 ⇒ 只去掉标签本身
        continue;
      }
      out.push(line);
    }
    const cleaned = out.join('\n').trim();
    if (cleaned) kept.push(cleaned);
  }
  return kept.join('\n\n');
}

/**
 * 去掉排版注解：「▲某个时期：20岁之前，按部就班地上学……」
 *
 * 注解（`▲xxx：`）是原文的**排版标记**，不是正文 ——
 * 但它后面常常紧接着正文，所以只吃注解本身：
 *   - 剩下的是散文 ⇒ 留下（`▲某个时期：20岁之前，按部就班…` ⇒
 *     留下「20岁之前，按部就班…」）；
 *   - 剩下的只是一个年龄/年份（`▲释放时期：20-23岁`）⇒ 整行丢掉。
 *
 * ⚠️ 注解**可能出现在段的中间**（有一则素材的第 6 段就是），
 * 所以按**段落**处理，不是只处理第一行。
 */
const ANNOTATION = /^▲[^：:]*[：:]\s*(.*)$/;
// 只剩年份/年龄的那种（"26-27岁"、"20-23岁"）⇒ 整行都是注解。
const AGE_ONLY = /^[\d\-\s　岁～~到至.年]*$/;

function stripAnnotations(text) {
  if (typeof text !== 'string' || !text) return '';
  const kept = [];
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n');
    const m = ANNOTATION.exec(lines[0]);
    if (m) {
      const rest = m[1].trim();
      lines[0] = AGE_ONLY.test(rest) ? '' : rest;
    }
    const cleaned = lines.join('\n').trim();
    if (cleaned) kept.push(cleaned);
  }
  return kept.join('\n\n');
}

/**
 * 小标题的正文里也留着原文章的小标题（原文那一行小标题）。
 *
 * prompt 里明说了**端上不许显示小标题** —— 但模型看到的是一整段文字，
 * 它分不清哪一行是标题。所以解析的时候就把**重复的小标题行**去掉。
 *
 * 判据：段**开头**的那几行里，有一行和某个小标题（从 label 里抽出来的）
 * 几乎一模一样 ⇒ 那是标题，不是正文。
 */
function titleOf(label) {
  let t = String(label || '').replace(/^\[\s*段\s*\d+\s*[a-z]?\s*\]\s*/i, '').trim();
  const m = /原小标题[^：:]*[：:]\s*(.+)$/.exec(t);
  if (m) return m[1].trim();
  const q = /[「『](.+?)[」』]/.exec(t);
  if (q) return q[1].trim();
  return t;
}

function normTitle(text) {
  return String(text || '').replace(/[\s　「」『』“”"'‘’（）()【】[\]]/g, '');
}

// 段开头的小标题行 ⇒ 去掉。
function stripLeadingTitles(text, titles) {
  if (!titles.length) return text;
  const paras = text.split('\n\n');
  const head = [];
  const rest = [];
  let count = 0;
  for (const para of paras) {
    if (count < 3) head.push(para);
    else rest.push(para);
    count += 1;
  }
  const keptHead = head.filter(para => {
    const lines = para.split('\n');
    if (lines.length !== 1) return true; // 只看独占一行的标题
    const line = normTitle(lines[0]);
    if (!line) return true;
    return !titles.some(t => {
      const nt = normTitle(t);
      return nt && line.startsWith(nt) && line.length - nt.length <= 12;
    });
  });
  return [...keptHead, ...rest].join('\n\n');
}

// ── 人物卡（介绍）───────────────────────────────────────────────
//
// 有些素材的正文第 0 段只有一句「**端上处理**：……」的说明，
// 真正的介绍写在上面那个「人物卡 / 事实卡」小节里（引文正文，
// 表格是字段、不是给端上读的）。
//
// ⇒ 解析出那份引文正文，当成「介绍」用（2-3 句讲清她是谁）。

// 把引文正文按「【…】标签」切成小块。
function cardBlocks(prose) {
  const blocks = [];
  let current = { tag: '', lines: [] };
  for (const line of prose.split('\n')) {
    const tag = TAG_LINE.exec(line);
    if (tag) {
      blocks.push(current);
      current = { tag: tag[1], lines: [] };
      if (tag[2].trim()) current.lines.push(tag[2].trim());
      continue;
    }
    current.lines.push(line);
  }
  blocks.push(current);
  return blocks;
}

// 人物卡 / 事实卡 小节里的**引文正文**（表格是字段，不给端上读）。
export function parseCard(sections) {
  const section =
    sectionByPrefix(sections, '人物卡') || sectionByPrefix(sections, '事实卡');
  if (!section) return '';
  const body = stripQuote(bodyOf(section));
  const proseLines = [];
  for (const line of body.split('\n')) {
    if (/^\s*\|/.test(line)) break; // 表格开始 ⇒ 前面的才是引文正文
    proseLines.push(line);
  }
  const kept = [];
  for (const block of cardBlocks(proseLines.join('\n'))) {
    if (NON_INTRO_CARD_TAG.test(block.tag)) continue; // 互动说明 ⇒ 不是介绍
    const text = stripEditorial(block.lines.join('\n')).trim();
    if (text) kept.push(text);
  }
  return kept.join('\n\n');
}

// 从正文小节里切出各段。
// 小标题（`### [段 1] 原小标题：一、逃离压抑的原生家庭`）只作为 **label**
// 存下来 —— 它是内部记号，端上不显示。
export function parseSegments(section, { card = '' } = {}) {
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

  // 全部小标题（正文里重复出现的小标题行要靠它认出来）。
  const titles = segments.map(seg => titleOf(seg.label)).filter(Boolean);

  return segments
    .map(seg => {
      const raw = stripImagePlaceholders(stripQuote(seg.lines.join('\n'))).trim();
      const text = stripAnnotations(stripEditorial(raw));
      return { label: seg.label, text: stripLeadingTitles(text, titles) };
    })
    // 「如何与你进行学习互动」这类小节：既不是故事，也不是介绍 ⇒ 整段不要。
    .filter(seg => !NON_STORY_LABEL.test(seg.label))
    .map(seg => {
      // 人物卡段：**不是故事段**，讲法不一样（2-3 句介绍）。
      // 正文为空（只剩「端上处理」说明）⇒ 用上面「人物卡」小节的引文补上；
      // 正文与人物卡都有 ⇒ 两份都要（人物卡里有正文没有的细节）。
      if (!INTRO_LABEL.test(seg.label)) return { label: seg.label, text: seg.text };
      const text = mergeIntro(seg.text, card);
      if (!text) return null;
      return { label: seg.label, text, kind: 'intro' };
    })
    .filter(seg => seg && seg.text);
}

// 介绍 = 段自己的正文 + 人物卡里**段里没有的**那些小块。
function mergeIntro(body, card) {
  const parts = [];
  if (body) parts.push(body);
  if (card) {
    for (const block of card.split('\n\n')) {
      const probe = normTitle(block).slice(0, 12);
      if (!probe) continue;
      // 段里已经有的（有一则素材的人物卡与开篇重复）⇒ 不重复给。
      if (parts.some(p => normTitle(p).includes(probe))) continue;
      parts.push(block);
    }
  }
  return parts.join('\n\n');
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

  const card = parseCard(sections);
  const segments = parseSegments(sectionByPrefix(sections, '正文'), { card });
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
