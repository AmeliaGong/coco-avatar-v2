// 契约 1：stuck_point —— 游民纪元急救箱与教练交付共用的卡点结构。
// 游民纪元的小程序（未来）会按同样的结构产出卡点，两边不断链。
//
// 使用顺序：先 validate（校验模型原始输出），再 normalize（结构归一化）。
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

// 字段语义。随 prompt 一起交给模型，让它知道哪个必填、哪个可选。
export const STUCK_POINT_FIELD_NOTES = {
  title: '必填。一句话概括这个卡点，不超过 30 字，不要写症状，写那个限制性的说法本身。',
  belief: '选填。限制性信念的全文原文。',
  evidence_against: '选填。数组，每条是与该信念相反的事实。没有就留空数组，不要编造。',
  emotion: '选填。此刻最主要的那一个情绪。',
  micro_action: '选填。今天就能做完的一件最小的事。',
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
  if (
    value.belief !== undefined &&
    value.belief !== null &&
    typeof value.belief !== 'string'
  ) {
    errors.push('belief: 必须是字符串');
  }
  if (
    value.emotion !== undefined &&
    value.emotion !== null &&
    typeof value.emotion !== 'string'
  ) {
    errors.push('emotion: 必须是字符串');
  }
  if (
    value.micro_action !== undefined &&
    value.micro_action !== null &&
    typeof value.micro_action !== 'string'
  ) {
    errors.push('micro_action: 必须是字符串');
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
    belief: toText(src.belief),
    evidence_against: raw.map(toText).filter((e) => e !== ''),
    emotion: toText(src.emotion),
    micro_action: toText(src.micro_action),
  };
}
