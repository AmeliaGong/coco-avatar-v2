// 契约 2：教练分析的产出 —— 一次 1v1 交付的结构化方案。
// worth_practicing 为 false 表示「这一轮只交付诊断，不安排练习」。

export const PLAN_HORIZONS = ['3_months', '1_year', 'life'];

export const PLAN_SCHEMA = {
  diagnosis: {
    core_belief: '核心限制性信念',
    pattern: '反复出现的行为模式',
    root_cause: '更深一层的成因',
  },
  vision: {
    title: '未来愿景的一句话标题',
    narrative: '2-3 段叙事，用 Coco 的口吻写给客户看',
    horizon: '3_months | 1_year | life',
  },
  practices: [
    {
      day: 1,
      title: '这一步叫什么',
      intent: '这一步在验证什么假设',
      action: '具体可执行的动作',
      evidence_prompt: '回填证据时的引导问句',
      success_criteria: '做到什么算完成',
    },
  ],
  worth_practicing: true,
};

export function validatePlanPayload(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['方案 payload 必须是一个对象'] };
  }
  if (!value.diagnosis || typeof value.diagnosis !== 'object') {
    errors.push('diagnosis 必填');
  }
  if (!value.vision || typeof value.vision !== 'object') {
    errors.push('vision 必填');
  } else if (!PLAN_HORIZONS.includes(value.vision.horizon)) {
    errors.push(`vision.horizon 必须是 ${PLAN_HORIZONS.join(' / ')} 之一`);
  }
  if (!Array.isArray(value.practices)) {
    errors.push('practices 必须是数组');
  }
  return { ok: errors.length === 0, errors };
}

export function normalizePlanPayload(value) {
  const src = value && typeof value === 'object' ? value : {};
  const diagnosis = src.diagnosis && typeof src.diagnosis === 'object' ? src.diagnosis : {};
  const vision = src.vision && typeof src.vision === 'object' ? src.vision : {};
  const worthPracticing = src.worth_practicing !== false;
  const practices = Array.isArray(src.practices) ? src.practices : [];
  return {
    diagnosis: {
      core_belief: String(diagnosis.core_belief || ''),
      pattern: String(diagnosis.pattern || ''),
      root_cause: String(diagnosis.root_cause || ''),
    },
    vision: {
      title: String(vision.title || ''),
      narrative: String(vision.narrative || ''),
      horizon: PLAN_HORIZONS.includes(vision.horizon) ? vision.horizon : '1_year',
    },
    practices: worthPracticing
      ? practices
          .filter(p => p && typeof p === 'object')
          .map((p, i) => ({
            day: Number.isFinite(p.day) ? p.day : i + 1,
            title: String(p.title || ''),
            intent: String(p.intent || ''),
            action: String(p.action || ''),
            evidence_prompt: String(p.evidence_prompt || ''),
            success_criteria: String(p.success_criteria || ''),
          }))
      : [],
    worth_practicing: worthPracticing,
  };
}
