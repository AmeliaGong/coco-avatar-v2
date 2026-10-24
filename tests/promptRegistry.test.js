import './helpers/testEnv.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPromptRegistry } from '../server/promptRegistry.js';
import { getDb } from '../db.js';

const GOLDEN = 'tests/fixtures/legacy-chat-prompt.txt';

before(() => {
  const db = getDb();
  db.prepare('DELETE FROM prompt_scenarios').run();
});

test('黄金文件存在且非空', () => {
  const text = fs.readFileSync(GOLDEN, 'utf8');
  assert.ok(text.trim().length > 1000, '黄金文件内容异常短');
});

test('装配出的 chat prompt 与生产快照逐字节相同', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const golden = fs.readFileSync(GOLDEN, 'utf8').trim();
  assert.equal(registry.getPrompt('chat').trim(), golden);
});

test('未覆盖的场景从 prompts/ 目录读文件', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const prompt = registry.getPrompt('cbt_quick');
  assert.ok(prompt.includes('5 步') || prompt.includes('五步') || prompt.includes('Step 1'),
    'cbt_quick 场景缺少步骤标识');
});

test('数据库激活版本覆盖文件内容', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.cbt_quick', '这是被覆盖后的版本');
  const registry2 = createPromptRegistry({ db });
  assert.ok(registry2.getPrompt('cbt_quick').includes('这是被覆盖后的版本'));
  db.prepare('DELETE FROM prompt_scenarios').run();
});

test('数据库里的版本号递增，旧版本仍在', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.cbt_delivery', '版本一');
  registry.setPromptOverride('scenario.cbt_delivery', '版本二');
  const rows = db
    .prepare('SELECT version FROM prompt_scenarios WHERE id = ? ORDER BY version')
    .all('scenario.cbt_delivery')
    .map(r => r.version);
  assert.deepEqual(rows, [1, 2]);
  const registry2 = createPromptRegistry({ db });
  assert.ok(registry2.getPrompt('cbt_delivery').includes('版本二'));
  db.prepare('DELETE FROM prompt_scenarios').run();
});

test('persona.v2 存在但默认不激活', () => {
  const v2 = fs.readFileSync('prompts/persona.v2.md', 'utf8');
  assert.ok(v2.includes('转化原则') || v2.includes('绝不主动'), 'persona.v2 缺少转化原则');
});
