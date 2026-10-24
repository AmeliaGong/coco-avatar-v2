import './helpers/testEnv.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPromptRegistry,
  versionFor,
  OVERRIDABLE_IDS,
  SCENARIO_IDS,
  PART_FILES,
} from '../server/promptRegistry.js';
import { getDb } from '../db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'tests/fixtures/legacy-chat-prompt.txt');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const PERSONA_V2 = path.join(PROMPTS_DIR, 'persona.v2.md');

beforeEach(() => {
  getDb().prepare('DELETE FROM prompt_scenarios').run();
});

test('黄金文件存在且非空', () => {
  const text = fs.readFileSync(GOLDEN, 'utf8');
  assert.ok(text.trim().length > 1000, '黄金文件内容异常短');
});

test('装配出的 chat prompt 与生产快照逐字节相同（不 trim）', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const golden = fs.readFileSync(GOLDEN, 'utf8');
  assert.equal(registry.getPrompt('chat'), golden);
});

test('装配结果等于 persona.base + "\\n\\n" + scenario.chat 三段拼起来', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const base = registry.readPart('persona.base');
  const scenario = registry.readPart('scenario.chat');
  assert.equal(registry.getPrompt('chat'), `${base.body}\n\n${scenario.body}`);
});

test('内容版本是内容哈希：内容变则版本变，内容不变则版本稳定', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-prompts-'));
  fs.cpSync(PROMPTS_DIR, tmp, { recursive: true });
  const registry = createPromptRegistry({ db: getDb(), promptsDir: tmp });

  const v1 = registry.getPromptMeta('chat').baseVersion;
  const v2 = registry.getPromptMeta('chat').baseVersion;
  assert.equal(v1, v2, '同一份内容的版本应当稳定');
  assert.match(v1, /^[0-9a-f]{8}$/, '版本应当是 8 位十六进制内容哈希');
  assert.equal(v1, versionFor(registry.readPart('persona.base').body));

  fs.appendFileSync(path.join(tmp, 'persona.base.md'), '\n多改一个字');
  const registry2 = createPromptRegistry({ db: getDb(), promptsDir: tmp });
  assert.notEqual(registry2.getPromptMeta('chat').baseVersion, v1);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('数据库覆盖版本的 getPromptMeta 也返回内容哈希', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.chat', '被覆盖的正文');
  const meta = registry.getPromptMeta('chat');
  assert.equal(meta.scenarioVersion, versionFor('被覆盖的正文'));
  assert.equal(meta.source, 'file+db');
});

test('listScenarios 只列四个场景，不含 persona.base，并给出装配后的长度', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const list = registry.listScenarios();
  assert.deepEqual(
    list.map((s) => s.id),
    ['scenario.chat', 'scenario.cbt_quick', 'scenario.cbt_delivery', 'scenario.analysis']
  );
  assert.ok(!list.some((s) => s.id === 'persona.base'), 'persona.base 不是场景');
  for (const item of list) {
    assert.ok(item.promptLength > item.partLength, `${item.id} 的 promptLength 应大于 partLength`);
    assert.equal(
      item.promptLength,
      registry.getPrompt(item.id.replace('scenario.', '')).length
    );
  }
});

test('listParts 列出 persona.base 与 persona.v2', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const ids = registry.listParts().map((p) => p.id);
  assert.ok(ids.includes('persona.base'));
  assert.ok(ids.includes('persona.v2'));
  assert.ok(ids.includes('scenario.chat'));
});

test('readPart 能读 persona.v2，未知 id 抛错', () => {
  const registry = createPromptRegistry({ db: getDb() });
  const v2 = registry.readPart('persona.v2');
  assert.ok(v2.body.length > 100);
  assert.ok(v2.body.includes('转化原则') || v2.body.includes('绝不主动'));
  assert.throws(() => registry.readPart('不存在的id'), /未知的 prompt 片段/);
});

test('setPromptOverride 对拼错的 id 抛错，不会静默建行', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  assert.throws(() => registry.setPromptOverride('scenario.chatt', 'x'), /未知的 prompt 片段/);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM prompt_scenarios').get();
  assert.equal(rows.n, 0, '拼错的 id 不应该留下任何数据行');
});

test('覆盖层可回滚：覆盖 → 再覆盖 → 列表可见 → 激活旧版 → 清除回到文件', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  const fileVersion = registry.getPromptMeta('chat').scenarioVersion;

  registry.setPromptOverride('scenario.chat', '版本一');
  registry.setPromptOverride('scenario.chat', '版本二');

  const versions = registry.listVersions('scenario.chat');
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((v) => v.is_active).length, 1);
  assert.ok(versions.every((v) => typeof v.bodyHash === 'string' && v.bodyHash.length === 8));
  assert.ok(versions.every((v) => v.body === undefined), '列表接口不应返回正文');

  const old = versions.find((v) => !v.is_active);
  registry.activateVersion('scenario.chat', old.revision);
  assert.ok(registry.getPrompt('chat').includes('版本一'));
  assert.equal(registry.listVersions('scenario.chat').filter((v) => v.is_active).length, 1);

  registry.clearOverride('scenario.chat');
  assert.equal(registry.getPromptMeta('chat').scenarioVersion, fileVersion);
  assert.ok(!registry.getPrompt('chat').includes('版本一'));
});

test('activateVersion 指向不存在的版本抛错', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.chat', '版本一');
  assert.throws(() => registry.activateVersion('scenario.chat', 999), /未知的 prompt 版本/);
});

test('clearOverride 之后历史行仍在，只是不再激活', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('scenario.chat', '版本一');
  registry.setPromptOverride('scenario.chat', '版本二');
  registry.clearOverride('scenario.chat');
  const versions = registry.listVersions('scenario.chat');
  assert.equal(versions.length, 2, '历史行不应被删除');
  assert.ok(versions.every((v) => !v.is_active));
});

test('activatePersona 可以把 persona.v2 变成生效的底座', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  const v2 = fs.readFileSync(PERSONA_V2, 'utf8').replace(/\s+$/, '');
  const result = registry.activatePersona('persona.v2');
  assert.equal(result.id, 'persona.base');
  assert.equal(result.from, 'persona.v2');
  const prompt = createPromptRegistry({ db }).getPrompt('chat');
  assert.ok(prompt.includes('【转化原则'), 'chat prompt 应含有 persona.v2 独有的转化原则段');
  assert.ok(prompt.includes(v2.slice(0, 40)), 'chat prompt 应含有 persona.v2 的开头');
  assert.equal(registry.readPart('persona.base').source, 'db');
});

test('activatePersona 对非法来源抛错', () => {
  const registry = createPromptRegistry({ db: getDb() });
  assert.throws(() => registry.activatePersona('乱写的id'), /未知的 persona 来源/);
  assert.throws(() => registry.activatePersona('scenario.chat'), /未知的 persona 来源/);
  // persona.base 自己不能当来源：那等于把当前底座原样再写一遍，
  // 是个空操作，却会在库里留下一条「我改过 prompt」的假记录。
  assert.throws(() => registry.activatePersona('persona.base'), /未知的 persona 来源/);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM prompt_scenarios').get().n,
    0,
    '被拒绝的来源不应该留下任何数据行'
  );
});

test('persona.base 本身也可以被数据库覆盖', () => {
  const db = getDb();
  const registry = createPromptRegistry({ db });
  registry.setPromptOverride('persona.base', '替换掉的底座');
  assert.ok(registry.getPrompt('chat').startsWith('替换掉的底座'));
});

test('getPrompt 对未知场景抛错', () => {
  const registry = createPromptRegistry({ db: getDb() });
  assert.throws(() => registry.getPrompt('不存在的场景'), /未知的 prompt 场景/);
});

test('可覆盖 id 集合与场景 id 清单符合约定', () => {
  assert.deepEqual(SCENARIO_IDS, ['chat', 'cbt_quick', 'cbt_delivery', 'analysis']);
  assert.deepEqual(OVERRIDABLE_IDS, [
    'persona.base',
    'scenario.chat',
    'scenario.cbt_quick',
    'scenario.cbt_delivery',
    'scenario.analysis',
  ]);
  assert.ok(!OVERRIDABLE_IDS.includes('persona.v2'), 'persona.v2 只能作为激活来源');
  assert.ok(PART_FILES['persona.v2'], 'persona.v2 应在部分目录里');
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
});

test('persona.v2 存在但默认不激活', () => {
  const v2 = fs.readFileSync(PERSONA_V2, 'utf8');
  assert.ok(v2.includes('转化原则') || v2.includes('绝不主动'), 'persona.v2 缺少转化原则');
});
