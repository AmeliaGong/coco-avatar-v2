// 契约 1：stuck_point —— 游民纪元急救箱与教练交付共用的卡点结构。
// 游民纪元的小程序（未来）会按同样的结构产出卡点，两边不断链。
//
// 推荐入口是 parseStuckPoint：先 validate，再 normalize，一步步来不得。
// validate 与 normalize 也单独导出（便于分别使用与测试），但它们是
// 「内部步骤」—— 只调 normalize 的话，非法值会一路带到客户端。
//
// normalize 只保证结构统一，不负责「修正」业务内容。
//
// 纯函数：不依赖数据库、HTTP、时钟，方便被 BFF 复用到另一个项目。

import { isPlainObject, toText } from './shared.js';

// 喂给模型的结构提示。值级示例 —— 模型照着这个形状输出，所以这里
// 每个值都是一个「合法的示例值」，不是字段说明。
export const STUCK_POINT_SCHEMA = {
  title: '卡点的一句话概括，不超过 30 字',
  belief: '限制性信念全文',
  evidence_against: ['一条与该信念相反的事实'],
  emotion: '此刻的主要情绪',
  micro_action: '今天可以做的一件最小的事',
};

// schema 里那些「描述性」的值 —— 它们是给模型看的说明，不是示例数据。
// 模型偶尔会原样抄回来；抄回来的卡点看着合法（是字符串、不为空），
// 但内容是假的。这里显式列出来，validate 时直接拦住。
export const STUCK_POINT_PLACEHOLDERS = [
  '卡点的一句话概括，不超过 30 字',
  '限制性信念全文',
  '一条与该信念相反的事实',
  '此刻的主要情绪',
  '今天可以做的一件最小的事',
];

const STUCK_POINT_PLACEHOLDER_SET = new Set(STUCK_POINT_PLACEHOLDERS);

function isStuckPointPlaceholder(text) {
  return STUCK_POINT_PLACEHOLDER_SET.has(typeof text === 'string' ? text.trim() : '');
}

// 字段语义。随 prompt 一起交给模型，让它知道哪个必填、哪个可选。
export const STUCK_POINT_FIELD_NOTES = {
  title: '必填。一句话概括这个卡点，不超过 30 字，不要写症状，写那个限制性的说法本身。',
  belief: '选填。限制性信念的全文原文。可以是一个字符串，也可以是数组（多项时用顿号连接）。',
  evidence_against: '选填。数组，每条是与该信念相反的事实。没有就留空数组，不要编造。',
  emotion: '选填。此刻最主要的那一个情绪。可以是一个字符串，也可以是数组（多项时用顿号连接）。',
  micro_action: '选填。今天就能做完的一件最小的事。可以是一个字符串，也可以是数组（多项时用顿号连接）。',
};

export function validateStuckPoint(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['stuck_point 必须是一个对象'] };
  }
  if (typeof value.title !== 'string' || !value.title.trim()) {
    errors.push('title: 必填且必须是非空字符串');
  }
  // 字符串也接受：模型经常把单条证据写成字符串，normalize 会包成数组。
  // 在这里报错等于把一份好卡点整个丢掉。
  if (
    value.evidence_against !== undefined &&
    value.evidence_against !== null &&
    typeof value.evidence_against !== 'string' &&
    !Array.isArray(value.evidence_against)
  ) {
    errors.push('evidence_against: 必须是数组或字符串');
  }
  // belief / emotion / micro_action 接受字符串或字符串数组。模型很爱
  // 把单个情绪写成数组（emotion: ['焦虑']）—— 硬拒非字符串等于把一
  // 份好卡点整个丢掉，而它本来可以拍平成一句人话。数字、布尔、对象
  // 则没有这样的余地，直接报错。
  for (const key of ['belief', 'emotion', 'micro_action']) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') continue;
    if (Array.isArray(v) && v.every((item) => typeof item === 'string')) continue;
    errors.push(`${key}: 必须是字符串或字符串数组`);
  }
  // 照抄示例值的防线：模型把提示里的占位串原样输出来时，字段看着
  // 合法（是非空字符串），内容却是假的。这里必须拦住，否则库里会
  // 安静地存进一条「卡点的一句话概括，不超过 30 字」。
  if (typeof value.title === 'string' && isStuckPointPlaceholder(value.title)) {
    errors.push('title: 不能照抄示例值（模型把提示里的示例原样输出了）');
  }
  for (const key of ['belief', 'emotion', 'micro_action']) {
    const v = value[key];
    if (typeof v === 'string') {
      if (isStuckPointPlaceholder(v)) {
        errors.push(`${key}: 不能照抄示例值（模型把提示里的示例原样输出了）`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (isStuckPointPlaceholder(item)) {
          errors.push(`${key}[${i}]: 不能照抄示例值（模型把提示里的示例原样输出了）`);
        }
      });
    }
  }
  if (typeof value.evidence_against === 'string') {
    if (isStuckPointPlaceholder(value.evidence_against)) {
      errors.push('evidence_against: 不能照抄示例值（模型把提示里的示例原样输出了）');
    }
  } else if (Array.isArray(value.evidence_against)) {
    value.evidence_against.forEach((item, i) => {
      if (isStuckPointPlaceholder(item)) {
        errors.push(`evidence_against[${i}]: 不能照抄示例值（模型把提示里的示例原样输出了）`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeStuckPoint(value) {
  const src = isPlainObject(value) ? value : {};
  const raw =
    src.evidence_against === undefined || src.evidence_against === null
      ? []
      : Array.isArray(src.evidence_against)
        ? src.evidence_against
        : [src.evidence_against];
  return {
    title: toText(src.title),
    // 数组值由 toText 拍平成「、」连接的文本（emotion: ['焦虑'] → '焦虑'）。
    belief: toText(src.belief),
    // 数组里的元素逐项 toText：数字条目会保留成字符串。这是有意的
    // 选择 —— 宁可保留一条事实，也不要悄悄把它丢掉。
    evidence_against: raw.map(toText).filter((e) => e !== ''),
    emotion: toText(src.emotion),
    micro_action: toText(src.micro_action),
  };
}

// 原子入口：先校验，通过了才归一化。
// validate/normalize 仍单独导出（便于分别使用与测试），但对外的
// 推荐入口是这个 —— 否则调用方很容易只调 normalize，把非法值
// 悄悄带进下游。
export function parseStuckPoint(value) {
  const result = validateStuckPoint(value);
  if (!result.ok) return { ok: false, errors: result.errors, value: null };
  return { ok: true, errors: [], value: normalizeStuckPoint(value) };
}
