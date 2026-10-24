// 结构化输出类型的**单一来源**。
//
// 路由对「结构化输出」需要三样东西：
//   1. 白名单：哪些 structured_output 合法（不合法 → 400）；
//   2. 给模型看的形状与语义（schema + fieldNotes）；
//   3. 契约层的校验函数（parseStuckPoint / parsePlanPayload）。
//
// 这三样如果各写一份，改了其中一份另两份就会漂 —— 表现是「白名单里
// 有的类型引擎却不认」（引擎抛 unknown_structured_output → 400），
// 或者「引擎认的类型路由先给 400 了」。所以这里只写一张表，其余全从
// 它派生。
//
// 派生关系：
//   STRUCTURED_OUTPUT_TYPES      —— 权威表（类型名 → 形状/语义/校验函数）
//   STRUCTURED_OUTPUT_TYPE_NAMES —— 白名单（Object.keys）
//   STRUCTURED_SCHEMAS           —— 给引擎的 schemas
//   STRUCTURED_VALIDATORS        —— 给引擎的 validators
import {
  STUCK_POINT_SCHEMA,
  STUCK_POINT_FIELD_NOTES,
  parseStuckPoint,
} from './contracts/stuckPoint.js';
import {
  PLAN_SCHEMA,
  PLAN_FIELD_NOTES,
  parsePlanPayload,
} from './contracts/plan.js';

export const STRUCTURED_OUTPUT_TYPES = {
  stuck_point: {
    schema: STUCK_POINT_SCHEMA,
    notes: STUCK_POINT_FIELD_NOTES,
    parse: parseStuckPoint,
  },
  plan: {
    schema: PLAN_SCHEMA,
    notes: PLAN_FIELD_NOTES,
    parse: parsePlanPayload,
  },
};

// 白名单：合法的 structured_output 取值。
export const STRUCTURED_OUTPUT_TYPE_NAMES = Object.keys(STRUCTURED_OUTPUT_TYPES);

// 给引擎的 schemas：形状给模型看，语义（哪个必填、枚举、false 什么
// 意思）必须一起给 —— 只给形状的话模型不知道 worth_practicing 还有个
// 有意义的 false 状态，会一律输出 true。
export const STRUCTURED_SCHEMAS = Object.fromEntries(
  Object.entries(STRUCTURED_OUTPUT_TYPES).map(([type, def]) => [
    type,
    { schema: def.schema, notes: def.notes },
  ])
);

// 给引擎的 validators：签名正好是 (payload) => ({ok, errors, value})。
// 模型复述格式时抄的占位串会被拒掉 —— 这正是「落库的是真卡点、不是
// 占位骨架」的实现方式。
export const STRUCTURED_VALIDATORS = Object.fromEntries(
  Object.entries(STRUCTURED_OUTPUT_TYPES).map(([type, def]) => [type, def.parse])
);
