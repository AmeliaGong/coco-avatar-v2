// 契约 1：stuck_point —— 游民纪元急救箱与教练交付共用的卡点结构。
// 游民纪元的小程序（未来）会按同样的结构产出卡点，两边不断链。

export const STUCK_POINT_SCHEMA = {
  title: '卡点的一句话概括，不超过 30 字',
  belief: '限制性信念全文',
  evidence_against: ['一条与该信念相反的事实'],
  emotion: '此刻的主要情绪',
  micro_action: '今天可以做的一件最小的事',
};

export function validateStuckPoint(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['stuck_point 必须是一个对象'] };
  }
  if (typeof value.title !== 'string' || !value.title.trim()) {
    errors.push('title 必填且必须是非空字符串');
  }
  if (value.evidence_against !== undefined && !Array.isArray(value.evidence_against)) {
    errors.push('evidence_against 必须是数组');
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeStuckPoint(value) {
  const src = value && typeof value === 'object' ? value : {};
  const evidence = src.evidence_against === undefined
    ? []
    : (Array.isArray(src.evidence_against) ? src.evidence_against : [src.evidence_against]);
  return {
    title: typeof src.title === 'string' ? src.title.trim() : '',
    belief: typeof src.belief === 'string' ? src.belief.trim() : '',
    evidence_against: evidence
      .filter(e => typeof e === 'string' && e.trim())
      .map(e => e.trim()),
    emotion: typeof src.emotion === 'string' ? src.emotion.trim() : '',
    micro_action: typeof src.micro_action === 'string' ? src.micro_action.trim() : '',
  };
}
