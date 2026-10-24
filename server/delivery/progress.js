// 练习进度计算。纯函数：不碰数据库、不碰时钟（时间由调用方以
// evidences 的 created_at 传进来），所以可以直接单测。

// 连续天数：以**最后一条证据的日期**为终点，向前数连续有证据的自然日。
// 为什么不是从「今天」往回数：来访者可能昨天做了、今天还没做，
// 从今天数会让连续天数在每天早上归零 —— 那是惩罚，不是记录。
export function computeStreak(evidences) {
  const days = new Set();
  for (const e of evidences) {
    const d = typeof e.created_at === 'string' ? e.created_at.slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) days.add(d);
  }
  const sorted = [...days].sort().reverse();
  if (!sorted.length) return 0;
  let streak = 0;
  const end = Date.parse(`${sorted[0]}T00:00:00Z`);
  for (const d of sorted) {
    const cur = Date.parse(`${d}T00:00:00Z`);
    const diffDays = Math.round((end - cur) / 86400000);
    if (diffDays !== streak) break;
    streak += 1;
  }
  return streak;
}

export function computeProgress(practices, evidences) {
  const active = practices.filter(p => p.sort_order >= 0);
  const total = active.length;
  const done = new Set(evidences.map(e => e.practice_id));
  const completed = active.filter(p => done.has(p.id)).length;
  return {
    total,
    completed,
    ratio: total ? completed / total : 0,
    streak_days: computeStreak(evidences),
  };
}

// 当前该练哪一条：第一条还没有证据的练习。
// 「一次一问」：做完一条自动指向下一条，不需要用户点「下一项」。
export function pickCurrentPractice(practices, evidences) {
  const active = practices.filter(p => p.sort_order >= 0);
  const done = new Set(evidences.map(e => e.practice_id));
  return active.find(p => !done.has(p.id)) || null;
}
