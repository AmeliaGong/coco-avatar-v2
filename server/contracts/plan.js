// 契约 2：教练分析的产出 —— 一次 1v1 交付的结构化方案。
// worth_practicing 为 false 表示「这一轮只交付诊断，不安排练习」。
//
// 推荐入口是 parsePlanPayload：先 validate，再 normalize，一步步来不得。
// validate 与 normalize 也单独导出（便于分别使用与测试），但它们是
// 「内部步骤」—— 只调 normalize 的话，非法值会一路带到客户端。
//
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
    belief_system: {
      core_new: '核心新信念',
      peripheral: [
        {
          name: '外周信念的名字',
          statement: '这条外周信念是什么',
          new_voice: '针对它的新声音',
        },
      ],
      deferred: ['本期不主攻的议题'],
    },
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
      circle: '这一步用哪个圈',
      scenario: '这一天切入的情景',
      target_belief: '这一天针对的外周信念',
    },
  ],
  worth_practicing: true,
};

// schema 里那些「描述性」的值 —— 它们是给模型看的说明，不是示例数据。
// 模型偶尔会原样抄回来；抄回来的方案看着合法（是字符串、不为空），
// 但内容是假的。这里显式列出来，validate 时直接拦住。
// 注意：vision.horizon 的示例值 '1_year' 是合法枚举值，不是占位值 ——
// 所以既不在清单里，也不接受占位值检查。
export const PLAN_PLACEHOLDERS = [
  '核心限制性信念',
  '反复出现的行为模式',
  '更深一层的成因',
  '核心新信念',
  '外周信念的名字',
  '这条外周信念是什么',
  '针对它的新声音',
  '本期不主攻的议题',
  '未来愿景的一句话标题',
  '2-3 段叙事，用 Coco 的口吻写给客户看',
  '这一步叫什么',
  '这一步在验证什么假设',
  '具体可执行的动作',
  '回填证据时的引导问句',
  '做到什么算完成',
  '这一步用哪个圈',
  '这一天切入的情景',
  '这一天针对的外周信念',
];

const PLAN_PLACEHOLDER_SET = new Set(PLAN_PLACEHOLDERS);

function isPlanPlaceholder(text) {
  return PLAN_PLACEHOLDER_SET.has(typeof text === 'string' ? text.trim() : '');
}

// 信念系统（diagnosis.belief_system）的校验。
//
// **选填**：不给也合法 —— 老方案没有这一块，向后兼容。
// 给了就要给对：外周信念必须有 name（它是靶子的名字，
// practices[].target_belief 要与它逐字一致），deferred 必须是数组。
function validateBeliefSystem(bs) {
  const errors = [];
  if (bs === undefined || bs === null) return errors;
  if (!isPlainObject(bs)) {
    errors.push('diagnosis.belief_system: 必须是对象');
    return errors;
  }
  if (bs.core_new !== undefined && bs.core_new !== null) {
    if (typeof bs.core_new !== 'string' || !bs.core_new.trim()) {
      errors.push('diagnosis.belief_system.core_new: 给了就必须是非空字符串');
    } else if (isPlanPlaceholder(bs.core_new)) {
      errors.push('diagnosis.belief_system.core_new: 不能照抄示例值（模型把提示里的示例原样输出了）');
    }
  }
  if (bs.peripheral !== undefined && bs.peripheral !== null) {
    if (!Array.isArray(bs.peripheral)) {
      errors.push('diagnosis.belief_system.peripheral: 必须是数组');
    } else {
      bs.peripheral.forEach((p, i) => {
        if (!isPlainObject(p)) {
          errors.push(`diagnosis.belief_system.peripheral[${i}]: 必须是对象`);
          return;
        }
        if (typeof p.name !== 'string' || !p.name.trim()) {
          errors.push(`diagnosis.belief_system.peripheral[${i}].name: 必填且必须是非空字符串`);
        } else if (isPlanPlaceholder(p.name)) {
          errors.push(`diagnosis.belief_system.peripheral[${i}].name: 不能照抄示例值（模型把提示里的示例原样输出了）`);
        }
        for (const key of ['statement', 'new_voice']) {
          if (p[key] === undefined || p[key] === null) continue;
          if (typeof p[key] !== 'string' || !p[key].trim()) {
            errors.push(`diagnosis.belief_system.peripheral[${i}].${key}: 给了就必须是非空字符串`);
          } else if (isPlanPlaceholder(p[key])) {
            errors.push(`diagnosis.belief_system.peripheral[${i}].${key}: 不能照抄示例值（模型把提示里的示例原样输出了）`);
          }
        }
      });
    }
  }
  if (bs.deferred !== undefined && bs.deferred !== null) {
    if (!Array.isArray(bs.deferred)) {
      errors.push('diagnosis.belief_system.deferred: 必须是数组');
    } else {
      bs.deferred.forEach((d, i) => {
        if (typeof d !== 'string' || !d.trim()) {
          errors.push(`diagnosis.belief_system.deferred[${i}]: 必须是非空字符串`);
        } else if (isPlanPlaceholder(d)) {
          errors.push(`diagnosis.belief_system.deferred[${i}]: 不能照抄示例值（模型把提示里的示例原样输出了）`);
        }
      });
    }
  }
  return errors;
}

// 外周信念的名字清单。靶子要命中它 —— 靶子写了一个不存在的信念，
// 等于这一天的练习没有落点，教练在编辑器里也看不出来。
// 只有在 belief_system 给了 peripheral 时才有清单；没给就是空清单，
// 靶子可以自由写。
function peripheralNames(diagnosis) {
  const bs = isPlainObject(diagnosis) ? diagnosis.belief_system : null;
  if (!isPlainObject(bs) || !Array.isArray(bs.peripheral)) return [];
  return bs.peripheral
    .filter(isPlainObject)
    .map((p) => (typeof p.name === 'string' ? p.name.trim() : ''))
    .filter(Boolean);
}

// 字段语义。随 prompt 一起交给模型 —— 少了这一段，模型根本不知道
// worth_practicing 还有个有意义的 false 状态，会一律输出 true，
// 「不是每个卡点都值得做练习」这个开关就永远不触发。
export const PLAN_FIELD_NOTES = {
  'diagnosis.core_belief': '必填。核心限制性信念 —— 要引用来访者原话片段，不要写"缺乏安全感"这类通用判断。',
  'diagnosis.pattern': '必填。反复出现的行为模式。',
  'diagnosis.root_cause': '必填。更深一层的成因。',
  'diagnosis.belief_system':
    '选填（对象）。这一期的信念系统 —— 一条核心新信念、若干条有名字的外周信念、以及本期不主攻的议题。核心限制性信念是"问题"，这个是"这一期打算怎么打"。给了它，练习项就能说明自己打的是哪一条。',
  'diagnosis.belief_system.core_new':
    '选填。这一期要长出来的核心新信念 —— 一句话，是核心限制性信念的反面。',
  'diagnosis.belief_system.peripheral':
    '选填（数组）。这一期要处理的外周信念，每一条都要有 name。name 是靶子的名字，练习项的 target_belief 必须与某一条的 name 完全一致。',
  'diagnosis.belief_system.peripheral[].name':
    '必填（当这条在 peripheral 里）。这条外周信念的名字，要短、要能一眼认出是哪一条（比如"怕未来"这种三五个字的短名字）。',
  'diagnosis.belief_system.peripheral[].statement':
    '选填。这条外周信念到底是什么 —— 引用来访者原话或它的真实表现。',
  'diagnosis.belief_system.peripheral[].new_voice':
    '选填。针对它的新声音 —— 拿来替换掉旧信念的那句话。',
  'diagnosis.belief_system.deferred':
    '选填（字符串数组）。本期不主攻的议题。写了它，用户才知道这一期不会去碰哪些东西。',
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
  'practices[].circle':
    '选填。用的哪一个教练手法（圈）。要落在教练手法库已经有的那一条上 —— 不要发明库里没有的新圈，库里有相近的就用相近的。',
  'practices[].scenario':
    '选填。这一天切入的具体情景。同一个圈配不同的情景，才撑得起一个多天的周期；多天周期里，每一天的 scenario 都要不同，否则就是同一个练习重复 N 天。',
  'practices[].target_belief':
    '选填。这一天针对的那条外周信念的名称，必须和 diagnosis.belief_system.peripheral 里某一条的 name 完全一致。没有 belief_system 时可以自由写。',
  worth_practicing:
    '必填（布尔）。true 表示这一轮安排练习；false 表示这一轮只交付诊断、不安排练习，此时 practices 必须是空数组。如果这位来访者的卡点靠自助练习就能解开，或者当下最需要的是先做一件具体的事而不是长期练习，就设 false。',
};

export function validatePlanPayload(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['方案 payload 必须是一个对象'] };
  }
  // 字段说明（PLAN_FIELD_NOTES）承诺的必填项，这里必须真的拦住 ——
  // 说明说必填、校验放行，等于告诉模型「漏了也没事」，那这份说明
  // 就是假的。子字段只在父对象存在时才查，避免报一堆噪声错误。
  if (!isPlainObject(value.diagnosis)) {
    errors.push('diagnosis: 必填');
  } else {
    for (const key of ['core_belief', 'pattern', 'root_cause']) {
      const v = value.diagnosis[key];
      if (typeof v !== 'string' || !v.trim()) {
        errors.push(`diagnosis.${key}: 必填且必须是非空字符串`);
      }
    }
    errors.push(...validateBeliefSystem(value.diagnosis.belief_system));
  }
  if (!isPlainObject(value.vision)) {
    errors.push('vision: 必填');
  } else {
    for (const key of ['title', 'narrative']) {
      const v = value.vision[key];
      if (typeof v !== 'string' || !v.trim()) {
        errors.push(`vision.${key}: 必填且必须是非空字符串`);
      }
    }
    if (!PLAN_HORIZONS.includes(value.vision.horizon)) {
      errors.push(`vision.horizon: 必须是 ${PLAN_HORIZONS.join(' / ')} 之一`);
    }
  }
  // 照抄示例值的防线：模型把提示里的占位串原样输出来时，字段看着
  // 合法（是非空字符串），内容却是假的。这里必须拦住。
  // vision.horizon 不查 —— '1_year' 是合法枚举值，不是占位值。
  if (isPlainObject(value.diagnosis)) {
    for (const key of ['core_belief', 'pattern', 'root_cause']) {
      const v = value.diagnosis[key];
      if (isPlanPlaceholder(v)) {
        errors.push(`diagnosis.${key}: 不能照抄示例值（模型把提示里的示例原样输出了）`);
      }
    }
  }
  if (isPlainObject(value.vision)) {
    for (const key of ['title', 'narrative']) {
      const v = value.vision[key];
      if (isPlanPlaceholder(v)) {
        errors.push(`vision.${key}: 不能照抄示例值（模型把提示里的示例原样输出了）`);
      }
    }
  }
  // worth_practicing 必填：它决定 practices 该不该存在。先判定它，
  // 再据此决定 practices 的规则。
  let worthPracticing;
  if (value.worth_practicing === undefined || value.worth_practicing === null) {
    errors.push('worth_practicing: 必填且必须是布尔值');
  } else if (!isBooleanLike(value.worth_practicing)) {
    errors.push('worth_practicing: 必须是布尔值');
  } else {
    worthPracticing = toBoolean(value.worth_practicing, undefined);
  }
  if (worthPracticing === true) {
    // 说了要练习却没给练习 —— 来访者拿到一份「有方案」但里面是空的。
    if (!Array.isArray(value.practices)) {
      errors.push('practices: 必填且必须是数组');
    } else {
      const names = peripheralNames(value.diagnosis);
      const nameSet = new Set(names);
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
        if (p.day !== undefined && p.day !== null) {
          const day = toNumber(p.day);
          if (day === null || !Number.isInteger(day)) {
            errors.push(`practices[${i}].day: 必须是整数`);
          }
        }
        // 照抄示例值的防线：practices 里每一段描述性的字段都要查。
        for (const key of ['title', 'intent', 'action', 'evidence_prompt', 'success_criteria']) {
          if (isPlanPlaceholder(p[key])) {
            errors.push(
              `practices[${i}].${key}: 不能照抄示例值（模型把提示里的示例原样输出了）`,
            );
          }
        }
        // 圈 / 情景 / 靶子：给了就必须填。给了空串等于「有这个字段
        // 但没填」，下游会当成没填 —— 不如直接报错。
        for (const key of ['circle', 'scenario', 'target_belief']) {
          if (p[key] === undefined || p[key] === null) continue;
          if (typeof p[key] !== 'string' || !p[key].trim()) {
            errors.push(`practices[${i}].${key}: 给了就必须是非空字符串`);
          } else if (isPlanPlaceholder(p[key])) {
            errors.push(
              `practices[${i}].${key}: 不能照抄示例值（模型把提示里的示例原样输出了）`,
            );
          }
        }
        // 靶子必须命中外周信念名单（名单非空时才查）。
        const tb = typeof p.target_belief === 'string' ? p.target_belief.trim() : '';
        if (tb && names.length && !nameSet.has(tb)) {
          errors.push(
            `practices[${i}].target_belief: 「${tb}」不在 diagnosis.belief_system.peripheral 的名单里`,
          );
        }
      });
    }
  } else if (worthPracticing === false) {
    // 不安排练习时 practices 可以整个不写（当作空数组），但写了就
    // 必须真的是空数组 —— 里面藏着步骤却标着「不练习」，那是自相矛盾。
    if (value.practices !== undefined && value.practices !== null) {
      if (!Array.isArray(value.practices)) {
        errors.push('practices: 必须是数组');
      } else if (value.practices.length > 0) {
        errors.push('practices: worth_practicing 为 false 时必须是空数组');
      }
    }
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
      belief_system: normalizeBeliefSystem(diagnosis.belief_system),
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
            // 圈 / 情景 / 靶子：没给就是 null（区别于「给了但是空的」，
            // 那种情况 validate 已经拦下了）。
            circle: optionalText(p.circle),
            scenario: optionalText(p.scenario),
            target_belief: optionalText(p.target_belief),
          }))
      : [],
    worth_practicing: worthPracticing,
  };
}

// 选填的文本字段：没给或者给的是空白，都归一成 null。
// 归一成 '' 而不是 null 的话，调用方分不清「没这个字段」和
// 「这个字段是空的」—— 前者是真的没这回事，后者是模型没填。
function optionalText(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

// 信念系统的归一化。没给 → null（老方案向后兼容）。
function normalizeBeliefSystem(bs) {
  if (!isPlainObject(bs)) return null;
  const peripheral = Array.isArray(bs.peripheral)
    ? bs.peripheral.filter(isPlainObject).map((p) => ({
        name: toText(p.name),
        statement: optionalText(p.statement),
        new_voice: optionalText(p.new_voice),
      }))
    : [];
  const deferred = Array.isArray(bs.deferred)
    ? bs.deferred.filter((d) => typeof d === 'string').map((d) => d.trim()).filter(Boolean)
    : [];
  return {
    core_new: optionalText(bs.core_new),
    peripheral,
    deferred,
  };
}

// 原子入口：先校验，通过了才归一化。
// validate/normalize 仍单独导出（便于分别使用与测试），但对外的
// 推荐入口是这个 —— 否则调用方很容易只调 normalize，把非法值
// 悄悄带进下游。
export function parsePlanPayload(value) {
  const result = validatePlanPayload(value);
  if (!result.ok) return { ok: false, errors: result.errors, value: null };
  return { ok: true, errors: [], value: normalizePlanPayload(value) };
}
