// 结构化输出类型的单一来源（server/structuredTypes.js）。
//
// 白名单、引擎的 schemas、契约的 validators 必须出自同一张表 —— 否则
// 改了其中一份另两份就会漂，表现是「白名单里有的类型引擎却不认」
// （引擎抛 unknown_structured_output → 400）或反之。
import './helpers/testEnv.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRUCTURED_OUTPUT_TYPES,
  STRUCTURED_OUTPUT_TYPE_NAMES,
  STRUCTURED_SCHEMAS,
  STRUCTURED_VALIDATORS,
} from '../server/structuredTypes.js';

test('白名单、schemas、validators 出自同一张表', () => {
  assert.deepEqual(
    STRUCTURED_OUTPUT_TYPE_NAMES,
    Object.keys(STRUCTURED_OUTPUT_TYPES)
  );
  assert.deepEqual(STRUCTURED_OUTPUT_TYPE_NAMES, Object.keys(STRUCTURED_SCHEMAS));
  assert.deepEqual(STRUCTURED_OUTPUT_TYPE_NAMES, Object.keys(STRUCTURED_VALIDATORS));
});

test('白名单里正好是契约 1 与契约 2 这两种输出', () => {
  assert.deepEqual(STRUCTURED_OUTPUT_TYPE_NAMES.slice().sort(), ['plan', 'stuck_point']);
});

test('每个类型的形状、语义、校验函数都齐了', () => {
  for (const type of STRUCTURED_OUTPUT_TYPE_NAMES) {
    const def = STRUCTURED_OUTPUT_TYPES[type];
    assert.ok(def.schema && typeof def.schema === 'object', `${type} 缺形状`);
    assert.ok(def.notes && typeof def.notes === 'object', `${type} 缺字段语义`);
    assert.equal(typeof def.parse, 'function', `${type} 缺校验函数`);
    // 给引擎的那两份必须与表里一致
    assert.equal(STRUCTURED_SCHEMAS[type].schema, def.schema);
    assert.equal(STRUCTURED_SCHEMAS[type].notes, def.notes);
    assert.equal(STRUCTURED_VALIDATORS[type], def.parse);
  }
});
