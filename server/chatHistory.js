// /api/chat 的**上下文策略**：模型这一轮看到的对话，从哪来、留多少。
//
// 为什么单独成文件：这两件事以前是路由里的隐含行为，但它们各有各的坑，
// 而且都**不是路由里改判据能补救的**：
//
//   1. 上下文从哪来 —— 客户端每轮都把**整段对话**重发一遍。那份重发是
//      冗余的（库里已经存着完整的对话，前端刷新后也是从库里把对话拉回来
//      显示的 —— 库才是事实），而且它是**调用方可以伪造**的：谁拿到
//      conversation_id，谁就能往模型上下文里塞假的历史。
//
//   2. 留多少 —— history 以前**没有长度上限**（计划文档里记着这个已知
//      残留：MAX_CONTEXT_CHARS 只管注入的 clientContext，不管 history）。
//      以前唯一兜住它的是请求体的 100kb 上限 —— 而那个上限正在被挪走
//      （前端不再重发整段对话 ⇒ 请求体不再随对话变长 ⇒ 100kb 这道闸门
//      就管不到模型上下文了）。不另设一道，历史就会一直涨到模型不吃为止。

/**
 * 交给模型的 history 的字符上限（所有消息的 content 长度之和）。
 *
 * 为什么是这个数：
 *
 *   - 线上出问题的那个会话：整段对话 42,006 字符 = 23,545 prompt tokens
 *     （约 0.56 token/字符）。这个上限是她现有对话的 ~2.9 倍 ⇒ 她不会
 *     因为上限而丢掉任何上下文。
 *   - 最坏情况 ≈ 67k tokens，加上 system prompt（~5.8k 字符）≈ 70k
 *     tokens，在 MiniMax 的上下文窗口之内。
 *   - 它把「一次对话的 token 花费随轮数平方地涨」压成线性：再长的对话，
 *     每轮也只付这个数的钱。
 *
 * 超限时丢的是**最旧**的轮次（教练分析那条路读的是整段对话，不受影响 ——
 * 见 server/delivery/adminRoutes.js，它从库里读，不经过这里）。
 */
export const MAX_HISTORY_CHARS = 120000;

/**
 * 把 history 裁到 maxChars 个字符以内。
 *
 * 规则：
 *   - 从**最旧**的开始丢（最近的话最重要）；
 *   - **最后一条 user 消息永远留着** —— 它就是这一轮刚说的话，
 *     模型必须看见它（否则会出现「模型没听见这句，库里却存了」的
 *     那种不一致）。
 *   - 一条消息都不裁成半截（半句话对模型是噪音）。
 *
 * 不改入参，返回新数组。
 */
export function capHistory(history, maxChars = MAX_HISTORY_CHARS) {
  if (!Array.isArray(history) || history.length === 0) return [];

  // 最后一条 user 消息的位置 —— 它必须留下。
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const kept = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const len = typeof m?.content === 'string' ? m.content.length : 0;
    const mustKeep = i === lastUserIdx;
    if (!mustKeep && total + len > maxChars) break; // 装不下了：从最旧的开始丢
    kept.unshift(m);
    total += len;
  }
  return kept;
}

/**
 * 用**库里已有的对话**拼出交给模型的 history。
 *
 * @param {Array<{role: string, content: string}>} priorRows 库里这个会话
 *   已有的消息（按 id 升序）。
 * @param {string|null} userContent 这一轮新说的话（null = 这一轮没有
 *   新的用户发言）。
 * @returns {Array<{role: string, content: string}>}
 */
export function historyFromRows(priorRows, userContent) {
  const history = priorRows.map(r => ({ role: r.role, content: r.content }));
  if (userContent !== null && userContent !== undefined) {
    history.push({ role: 'user', content: userContent });
  }
  return history;
}
