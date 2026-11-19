// 探索者故事（WeStream 探索者社区的真人故事）的运行时通道。
//
// 这个模块只做三件事：
//   1. 存取 explorer_stories 表里的素材（由 scripts/seed-explorer-stories.mjs 写入）；
//   2. 判断「这个会话现在走到探索者线的哪一步」；
//   3. 把该给模型看的东西（目录 / 选中那一则的素材）**组装成结构化材料**。
//
// ⚠️ 三条硬约束：
//
//   1. **内容不进版本库、不进镜像、不进 prompt 文件。**
//      素材只存在于数据库里（fly volume）。仓库是 public 的。
//   2. **没有公开读接口。** 只有 admin 接口与本模块能读到正文 ——
//      地球页那张 stories 表（公开渲染）绝不承载真人故事。
//   3. **原文逐字。** 正文原样交给模型，模型逐字讲；
//      原文章的小标题只是分段记号，**端上不显示**（这里就不把它带出去）。
//
// 为什么需要「状态」：讲一则故事要一段一段讲，而服务端每轮都要重新注入
// 那一则的素材（模型不记得上一轮拿到了什么）。「现在在讲谁、讲到第几段」
// 只能靠状态记着 —— 所以有 explorer_sessions 这张表。

import { createExplorerStore } from './explorerStore.js';

/**
 * 桥接句。
 *
 * 这句话是 prompts/scenario.story.md 里**规定死的**一句（原话就是用户给的那句），
 * 服务端靠它判断「模型刚刚问出了桥接句 ⇒ 下一轮要给目录、让它挑 3 个人」。
 *
 * 为什么靠字符串而不是状态机：桥接句是 prompt 与服务端之间**唯一的约定点**，
 * 它必须逐字出现在 prompt 里（否则模型会改写），所以服务端也只能靠它。
 */
export const BRIDGE_MARKER = '你想听听他们的心路历程吗';

// 用户用序号选人时说的那些话（"1"、"第一个"、"第二个"、"二"…）。
//
// ⚠️ 中文数字要认：用户口语里说"第二个"远多于"第 2 个"，
// 而中文数字写在"第"后面（"第二个"）与单独说（"二"）是两种话，
// 所以两种形状都收。
const ORDINAL_PATTERNS = [
  /第\s*([1-9一二三四五六七八九])\s*(?:个|位|号)?/,
  /^\s*([1-9])\s*$/,
  /^\s*([一二三四五六七八九])\s*$/,
];

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 一条素材的「薄投影」—— 目录里用的（只有一句话画像与匹配信号）。
 *
 * ⚠️ 目录里**不放正文** —— 14 则正文全放进去是几万字，
 * 每轮都塞进 prompt 会把上下文吃光。正文只在用户选定了某一则之后才给。
 */
function toCatalogItem(story) {
  return {
    id: story.id,
    name: story.name,
    aliases: story.aliases,
    one_liner: story.one_liner,
    category: story.category,
    education_level: story.education_level,
    match_signals: story.match_signals,
  };
}

/**
 * 一个人可能有好几个名字（化名、昵称、并列名）。
 *
 * ⚠️ 这里的名字会拿去跟**用户的自由文本**做子串匹配 ⇒ 别名越多，误判越多。
 * 所以别名只收「明显是同一个人」的（并列名、昵称），不收那些常见词。
 */
function namesOf(story) {
  return [story.name, ...(story.aliases || [])].filter(n => typeof n === 'string' && n.trim());
}

/**
 * 在一段文本里找出出现过的目录人名，按**首次出现的位置**排序。
 *
 * 为什么按位置排序：Coco 报候选人是按 1、2、3 的顺序报的，
 * 用户回「2」指的是**她报出来的第 2 个** —— 那就是文本里的第 2 次出现。
 */
function findMentions(text, stories) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (const story of stories) {
    for (const name of namesOf(story)) {
      const idx = text.indexOf(name);
      if (idx >= 0) hits.push({ story, name, idx });
    }
  }
  // 同一个人可能被多个别名命中（"某某 / 化名"），只留最早的那次。
  const byStory = new Map();
  for (const hit of hits.sort((a, b) => a.idx - b.idx)) {
    if (!byStory.has(hit.story.id)) byStory.set(hit.story.id, hit);
  }
  return [...byStory.values()].sort((a, b) => a.idx - b.idx);
}

/**
 * 从用户的回复里解析出「他选的是哪一位」。
 *
 * 两种形态：
 *   - 直接说名字（"某某" / "我想听某某"）⇒ 命中目录里的那个人；
 *   - 说序号（"2" / "第二个"）⇒ 指**候选人清单里的第 2 个**。
 *
 * @param {string} userText 用户这一轮说的话
 * @param {Array} candidates 候选清单（按 Coco 报出来的顺序）—— **素材数组本身**
 * @param {Array} stories 全部素材
 * @returns {object|null} 选中的那条素材；没选出来返回 null
 */
export function resolveSelection(userText, candidates, stories) {
  if (typeof userText !== 'string' || !userText.trim()) return null;

  // 形态一：名字。**先看候选清单**（用户在清单里挑的），
  // 再退回全部素材（用户想听一个没被报出来的人 —— 他的选择优先）。
  const inCandidates = findMentions(userText, candidates);
  if (inCandidates.length) return inCandidates[0].story;
  const anywhere = findMentions(userText, stories);
  if (anywhere.length) return anywhere[0].story;

  // 形态二：序号。只在有候选清单时才有意义。
  if (candidates.length >= 2) {
    for (const pattern of ORDINAL_PATTERNS) {
      const m = userText.match(pattern);
      if (!m) continue;
      const raw = m[1];
      const n = /[一二三四五六七八九]/.test(raw) ? CN_NUMERALS[raw] : Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
        // candidates 是**素材数组本身**（不是 {story} 包装）——
        // 调用方传进来的就是 mentioned.map(m => m.story)。
        return candidates[n - 1];
      }
    }
  }
  return null;
}

/**
 * 分段 → 送进上下文的样子。
 *
 * ⚠️ **只带 text，不带 label。**
 * label 是原文章的小标题（内部记号，端上不显示）。它不需要跟着素材
 * 到处走 —— 模型渲染时只取 text（见 cbtEngine 的探索者块），
 * 而让 label 一路传下去，就多了一次「小标题漏进 prompt」的机会。
 * 数据库里仍然留着 label（那是素材的原始分段信息，排障用）。
 */
/**
 * 一段的"指纹"：开头 8 个字（**去掉所有空白**）。
 *
 * 用来判断"模型到底有没有把这一段逐字讲出来"。
 * 去掉空白是必要的 —— 模型输出时的换行、空格不一定跟素材一致。
 * 取 8 个字是权衡：太短会撞车，太长则模型只念了半段就匹配不上。
 */
function segmentHead(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, '');
  if (!flat.length) return '';
  return flat.slice(0, Math.min(8, flat.length));
}

function toRuntimeSegments(segments, start, count) {
  return (Array.isArray(segments) ? segments : [])
    .slice(start, start + count)
    .filter(s => s && typeof s === 'object')
    .map(s => ({ text: typeof s.text === 'string' ? s.text : '' }))
    .filter(s => s.text.trim());
}

/**
 * 组装这一轮要给模型看的探索者材料。
 *
 * 返回 null 表示「这一轮不需要探索者材料」（于是 prompt 的字节完全不变）。
 * 返回 { catalog, selected }：
 *   - catalog  —— 目录（挑人用）；**总是**给，因为它只有几 KB，
 *                 而模型随时可能需要它（用户说不喜欢时要换人）。
 *   - selected —— 用户选定了的那一则（讲故事用）；只在真的选定了之后才给。
 *
 * ⚠️ 目录总是给，意味着模型随时看得见这 14 个人 ⇒ **「什么时候可以提她们」
 * 只能靠 prompt 管**（见 prompts/scenario.story.md 的【探索者分支】）。
 * 这是有意的取舍：靠字符串约定会漏（模型改写一句话，约定就失效了），
 * 而漏掉的代价是「用户说想听探索者，模型却不知道有谁」。
 *
 * @param {object} params
 * @param {object} params.db 数据库连接
 * @param {string} params.conversationId 会话 id（用来读状态）
 * @param {Array<{role: string, content: string}>} params.history 交给模型的 history
 * @param {boolean} [params.enabled] 关掉就不返回任何材料
 */
export function buildExplorerContext({ db, conversationId, history, enabled = true }) {
  if (!enabled || !db) return null;

  const store = createExplorerStore({ db });
  const stories = store.listActive();
  if (!stories.length) return null; // 素材还没灌进来（或者被停用了）

  const messages = Array.isArray(history) ? history : [];
  const assistantTexts = messages
    .filter(m => m && m.role === 'assistant' && typeof m.content === 'string')
    .map(m => m.content);
  const userTexts = messages
    .filter(m => m && m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content);
  const userText = userTexts.length ? userTexts[userTexts.length - 1] : '';
  const lastAssistant = assistantTexts.length ? assistantTexts[assistantTexts.length - 1] : '';

  const state = conversationId ? store.getSession(conversationId) : null;
  const catalog = stories.map(toCatalogItem);

  // ── 情况一：已经在讲某一则（telling）────────────────────────────
  //
  // 模型上一轮讲了第 k 段，这一轮要接着讲第 k+1 段 ⇒ 必须再给一次素材。
  // 给的是**接下来的两段**（不是全部）：一次讲一段，多给一段是给模型留余地，
  // 全给等于让它跳着讲。
  if (state && state.phase === 'telling' && state.selected_id) {
    const story = stories.find(s => s.id === state.selected_id);
    if (story) {
      const spokenCount = Math.max(0, assistantTexts.length - state.base_assistant_count);
      // 全部讲完 ⇒ 收口态。
      //
      // 为什么不能继续注入最后一段：start 会被夹在最后一段上，于是模型
      // 每轮都拿到同一段 ⇒ 要么反复重讲，要么自己猜「该收口了」。
      // **收口态不再注入正文**（目录还在 —— 用户想换人仍然可以），
      // 「这是最后一段」由下面那个显式标记在**该讲的那一轮**给出。
      const all = toRuntimeSegments(story.segments, 0, story.segments.length);
      const total = all.length;

      // ── 「已经讲过哪几段」按**内容**判定，不按轮数判定 ──────────
      //
      // 2026-11-19 线上实测的真实故障：模型在用户选人后的第一轮，把整则
      // 故事**讲成了一段简介**（"Lana是个来自大理的00后…"）。
      // 按轮数算的话，那一轮已经算"讲过一段" ⇒ 下一轮直接给第 2 段
      // ⇒ **第 1 段的原文被整段跳过了**，用户只读到简介。
      //
      // 改成按内容算：某一段的**开头几个字**出现在模型说过的话里，
      // 才算那一段真的讲过。讲歪了（讲成简介）⇒ 只是重讲那一段，
      // 故事不会被跳过。
      const covered = new Set();
      const flatSpoken = assistantTexts
        .slice(state.base_assistant_count)
        .map(t => (typeof t === 'string' ? t.replace(/\s+/g, '') : ''));
      for (let i = 0; i < total; i++) {
        const head = segmentHead(all[i].text);
        if (!head) continue;
        for (const text of flatSpoken) {
          if (text && text.includes(head)) {
            covered.add(i);
            break;
          }
        }
      }
      let start = 0;
      while (start < total && covered.has(start)) start++;

      // 兜底：模型有足够的轮次却**一段都没逐字复述** ⇒ 别卡在第一段，
      // 放行一段（否则用户每次说"继续"都回到同一段，永远前进不了）。
      const stuck = covered.size === 0 && spokenCount >= 2;
      if (stuck) start = Math.min(1, Math.max(0, total - 1));

      // 讲完了 ⇒ 收口态。
      const done = start >= total || (start === total - 1 && spokenCount >= total + 1);
      if (total > 0 && done) {
        if (conversationId) {
          store.setSession(conversationId, {
            phase: 'closing',
            selected_id: state.selected_id,
            base_assistant_count: state.base_assistant_count,
          });
        }
        return { catalog, phase: 'closing' };
      }
      const slice = all.slice(start, start + 2);
      return {
        catalog,
        selected: {
          id: story.id,
          name: story.name,
          one_liner: story.one_liner,
          segments: slice,
          guide: story.guide,
          safety: story.safety,
          // 这一轮要讲的是 slice[0]（模型一次讲一段）⇒ 它是不是最后一段？
          is_final: start === total - 1,
          // 上一轮讲成了简介（没逐字复述）⇒ 明确告诉模型"请逐字讲这一段"。
          retry: covered.size === 0 && spokenCount > 0,
        },
        phase: 'telling',
      };
    }
    // 选中的那一则被停用了 → 状态作废，退回 idle。
    if (conversationId) store.resetSession(conversationId);
  }

  // ── 情况二：模型刚报出了候选人，用户在选（awaiting_pick）─────────
  //
  // 「模型报出了候选人」= 最近的 assistant 消息里出现了目录里的人名。
  // 为什么看**最近两条**而不是一条：模型偶尔会把三个人分两条消息报
  // （先报两个、再问"还有一位…"）。
  const recentAssistant = assistantTexts.slice(-2);
  const mentioned = [];
  for (const text of recentAssistant) {
    for (const hit of findMentions(text, stories)) {
      if (!mentioned.some(m => m.story.id === hit.story.id)) mentioned.push(hit);
    }
  }
  const candidates = mentioned.map(m => m.story);

  if (candidates.length && userText) {
    const picked = resolveSelection(userText, candidates, stories);
    if (picked) {
      if (conversationId) {
        store.setSession(conversationId, {
          phase: 'telling',
          selected_id: picked.id,
          base_assistant_count: assistantTexts.length,
        });
      }
      const pickedAll = toRuntimeSegments(picked.segments, 0, picked.segments.length);
      return {
        catalog,
        selected: {
          id: picked.id,
          name: picked.name,
          one_liner: picked.one_liner,
          segments: pickedAll.slice(0, 2),
          guide: picked.guide,
          safety: picked.safety,
          // 只有一段的素材 ⇒ 这一轮就是最后一段
          is_final: pickedAll.length <= 1,
        },
        phase: 'telling',
      };
    }
  }

  // ── 情况三：刚问出桥接句 —— 模型下一轮要挑 3 个人 ──────────────
  //
  // 桥接句之后的那一轮，模型要报出 3 个候选 ⇒ 目录必须在场。
  // （目录反正一直给，这一步只是为了把状态推进到 awaiting_pick，
  //   让下一轮知道「用户正在选」。）
  if (state && state.phase === 'awaiting_pick' && candidates.length) {
    // 还在等人选，但用户没选（"都不喜欢"）—— 目录继续给，让模型换一批。
    return { catalog, phase: 'awaiting_pick' };
  }
  if (lastAssistant.includes(BRIDGE_MARKER)) {
    if (conversationId) {
      store.setSession(conversationId, {
        phase: 'awaiting_pick',
        selected_id: null,
        base_assistant_count: assistantTexts.length,
      });
    }
    return { catalog, phase: 'awaiting_pick' };
  }

  // ── 兜底：还没进探索者线，但目录仍然给 ─────────────────────────
  //
  // 目录一直给是刻意的（见上面的注释）：模型随时可能需要它。
  return { catalog, phase: state ? state.phase : 'idle' };
}

export { findMentions, toCatalogItem };
