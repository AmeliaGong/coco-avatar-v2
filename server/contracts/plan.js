// 契约 2：教练分析的产出 —— 一次 1v1 交付的结构化方案。
// worth_practicing 为 false 表示「这一轮只交付诊断，不安排练习」。
//
// 使用顺序：先 validate（校验模型原始输出），再 normalize（结构归一化）。
// normalize 只保证结构统一，不负责「修正」业务内容 —— 尤其不会替模型
// 编造一个它没给过的 vision.horizon。
//
// 纯函数：不依赖数据库、HTTP、时钟，方便被 BFF 复用到另一个项目。

import { isBooleanLike, isPlainObject, toBoolean, toNumber, toText } from './shared.js';

export const PLAN_HORIZONS = ['3_months', '1_year', 'life'];

// 喂给模型的结构提示。值级示例 —— 模型照着这个形状输出，所以这里
// 每个值都是一个「合法的示例值」。
// horizon 写成一个具体合法值（'1_year'）而不是 '3_months | 1_year | life'
// —— 后者会被模型原样抄进输出，变成非法值。
export const PLAN_SCHEMA = {
  diagnosis: {
    core_belief: '核心限制性信念',
    pattern: '反复出现的行为模式',
    root_cause: '更深一层的成因',
  },
  vision: {
    title: '未来愿景的一句话标题',
    narrative: '2-3 段叙事，用 Coco 的口吻写给客户看',
    horizon: '1_year',
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

// 字段语义。随 prompt 一起交给模型 —— 少了这一段，模型根本不知道
// worth_practicing 还有个有意义的 false 状态，会一律输出 true，
// 「不是每个卡点都值得做练习」这个开关就永远不触发。
export const PLAN_FIELD_NOTES = {
  'diagnosis.core_belief': '必填。核心限制性信念 —— 要引用来访者原话片段，不要写"缺乏安全感"这类通用判断。',
  'diagnosis.pattern': '必填。反复出现的行为模式。',
  'diagnosis.root_cause': '必填。更深一层的成因。',
  'vision.title': '必填。未来愿景的一句话标题。',
  'vision.narrative': '必填。2-3 段叙事，用 Coco 的口吻、第二人称"你"写给来访者看，让他读完有画面。',
  'vision.horizon': '必填。只能取 "3_months"（三个月）、"1_year"（一年）、"life"（一生）三者之一，不要输出竖线分隔的选项串。',
  practices: '必填（数组）。worth_practicing 为 false 时给空数组。',
  'practices[].day': '选填。整数，从 1 开始；不给就按顺序编号。',
  'practices[].title': '必填。这一步叫什么。',
  'practices[].intent': '选填。这一步在验证什么假设。',
  'practices[].action': '必填。今天就能开始的具体动作，不能是"多反思自己"这种空话。',
  'practices[].evidence_prompt': '选填。回填证据时问用户的引导问句。',
  'practices[].success_criteria': '选填。做到什么算完成。',
  worth_practicing:
    '必填（布尔）。true 表示这一轮安排练习；false 表示这一轮只交付诊断、不安排练习，此时 practices 必须是空数组。如果这位来访者的卡点靠自助练习就能解开，或者当下最需要的是先做一件具体的事而不是长期练习，就设 false。',
};

export function validatePlanPayload(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['方案 payload 必须是一个对象'] };
  }
  if (!isPlainObject(value.diagnosis)) {
    errors.push('diagnosis: 必填');
  }
  if (!isPlainObject(value.vision)) {
    errors.push('vision: 必填');
  } else if (!PLAN_HORIZONS.includes(value.vision.horizon)) {
    errors.push(`vision.horizon: 必须是 ${PLAN_HORIZONS.join(' / ')} 之一`);
  }
  if (!Array.isArray(value.practices)) {
    errors.push('practices: 必须是数组');
  } else {
    value.practices.forEach((p, i) => {
      if (!isPlainObject(p)) {
        errors.push(`practices[${i}]: 必须是对象`);
        return;
      }
      if (typeof p.title !== 'string' || !p.title.trim()) {
        errors.push(`practices[${i}].title: 必填且必须是非空字符串`);
      }
      // action 缺失意味着来访者拿到一个「做不了」的练习，却没有任何
      // 地方报错 —— 这里必须拦住。
      if (typeof p.action !== 'string' || !p.action.trim()) {
        errors.push(`practices[${i}].action: 必填且必须是非空字符串`);
      }
      if (p.day !== undefined && p.day !== null && toNumber(p.day) === null) {
        errors.push(`practices[${i}].day: 必须是数字`);
      }
    });
  }
  if (
    value.worth_practicing !== undefined &&
    value.worth_practicing !== null &&
    !isBooleanLike(value.worth_practicing)
  ) {
    errors.push('worth_practicing: 必须是布尔值');
  }
  return { ok: errors.length === 0, errors };
}

export function normalizePlanPayload(value) {
  const src = isPlainObject(value) ? value : {};
  const diagnosis = isPlainObject(src.diagnosis) ? src.diagnosis : {};
  const vision = isPlainObject(src.vision) ? src.vision : {};
  // 缺省按「要练习」处理；显式的 false（或 "false" / 0）才关掉练习。
  const worthPracticing = toBoolean(src.worth_practicing, true);
  const practices = Array.isArray(src.practices) ? src.practices : [];
  return {
    diagnosis: {
      core_belief: toText(diagnosis.core_belief),
      pattern: toText(diagnosis.pattern),
      root_cause: toText(diagnosis.root_cause),
    },
    vision: {
      title: toText(vision.title),
      narrative: toText(vision.narrative),
      // 不做兜底：模型给了非法值就原样留着，交给 validate 报错。
      // 悄悄改写成 '1_year' 是在替客户做一个模型从没做过的决定。
      horizon: toText(vision.horizon),
    },
    practices: worthPracticing
      ? practices
          .filter(isPlainObject)
          .map((p, i) => ({
            day: toNumber(p.day) ?? i + 1,
            title: toText(p.title),
            intent: toText(p.intent),
            action: toText(p.action),
            evidence_prompt: toText(p.evidence_prompt),
            success_criteria: toText(p.success_criteria),
          }))
      : [],
    worth_practicing: worthPracticing,
  };
}
