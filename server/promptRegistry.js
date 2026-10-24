import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts'
);

// 部分目录：有哪些「部分」可以管理（读、覆盖、激活）。
// 与「prompt 怎么拼」是两件事 —— persona.base 是底座，scenario.* 是场景，persona.v2 是备用底座。
export const PART_FILES = {
  'persona.base': 'persona.base.md',
  'persona.v2': 'persona.v2.md',
  'scenario.chat': 'scenario.chat.md',
  'scenario.cbt_quick': 'scenario.cbt_quick.md',
  'scenario.cbt_delivery': 'scenario.cbt_delivery.md',
  'scenario.analysis': 'scenario.analysis.md',
};

// 可覆盖（可写数据库覆盖版本）的部分 id。persona.v2 只能作为激活来源，不能被覆盖。
export const OVERRIDABLE_IDS = [
  'persona.base',
  'scenario.chat',
  'scenario.cbt_quick',
  'scenario.cbt_delivery',
  'scenario.analysis',
];

// 场景 id（用户请求体里的 scenario 字段取值域）。供路由做白名单。
export const SCENARIO_IDS = ['chat', 'cbt_quick', 'cbt_delivery', 'analysis'];

// 内容版本号 = 内容哈希。文件和数据库覆盖层共用同一套编号空间：
// 回答「这次对话是哪些文本产生的」靠的是内容，不是修订号。
export function versionFor(body) {
  return createHash('sha1').update(String(body)).digest('hex').slice(0, 8);
}

// 只去尾部空白、保留开头。生产 prompt 以一个换行开头，那个换行是内容的一部分，不能被吃掉。
function stripTrailing(body) {
  return body.replace(/\s+$/, '');
}

function assertOverridable(id) {
  if (!OVERRIDABLE_IDS.includes(id)) {
    throw new Error(`未知的 prompt 场景：${id}`);
  }
}

export function createPromptRegistry({ db, promptsDir = PROMPTS_DIR } = {}) {
  function readOverride(id) {
    if (!db) return null;
    const row = db
      .prepare(
        'SELECT body, version FROM prompt_scenarios WHERE id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1'
      )
      .get(id);
    if (!row) return null;
    return {
      body: row.body,
      version: versionFor(row.body),
      revision: row.version,
      source: 'db',
    };
  }

  function readFile(id) {
    const file = PART_FILES[id];
    if (!file) return null;
    const full = path.join(promptsDir, file);
    if (!fs.existsSync(full)) return null;
    const body = stripTrailing(fs.readFileSync(full, 'utf8'));
    return { body, version: versionFor(body), source: 'file' };
  }

  function getPart(id) {
    if (!PART_FILES[id]) throw new Error(`未知的 prompt 场景：${id}`);
    // 覆盖层只对 persona.base 与场景生效；persona.v2 永远读文件。
    if (OVERRIDABLE_IDS.includes(id)) {
      const override = readOverride(id);
      if (override) return override;
    }
    const fromFile = readFile(id);
    if (fromFile) return fromFile;
    throw new Error(`未知的 prompt 场景：${id}`);
  }

  function getPrompt(scenarioId) {
    if (!SCENARIO_IDS.includes(scenarioId)) {
      throw new Error(`未知的 prompt 场景：${scenarioId}`);
    }
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return `${base.body}\n\n${scenario.body}`;
  }

  function getPromptMeta(scenarioId) {
    if (!SCENARIO_IDS.includes(scenarioId)) {
      throw new Error(`未知的 prompt 场景：${scenarioId}`);
    }
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return {
      scenarioId,
      // 内容版本（哈希）—— 回答「这段文本是哪个版本」
      baseVersion: base.version,
      scenarioVersion: scenario.version,
      // 修订号（数据库里的整数）—— 回答「这是第几次改动」
      baseRevision: base.revision ?? null,
      scenarioRevision: scenario.revision ?? null,
      source: `${base.source}+${scenario.source}`,
    };
  }

  function setPromptOverride(id, body) {
    assertOverridable(id);
    const maxRow = db
      .prepare('SELECT MAX(version) AS v FROM prompt_scenarios WHERE id = ?')
      .get(id);
    const revision = (maxRow && maxRow.v ? maxRow.v : 0) + 1;
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO prompt_scenarios (id, version, body, is_active, updated_at) VALUES (?, ?, ?, 1, ?)'
    ).run(id, revision, body, new Date().toISOString());
    return { id, version: revision, bodyHash: versionFor(body) };
  }

  // 该 id 的所有版本，按整数修订号倒序。不返回正文 —— 列表接口不该灌进大段 prompt。
  function listVersions(id) {
    return db
      .prepare(
        'SELECT id, version, is_active, updated_at, body FROM prompt_scenarios WHERE id = ? ORDER BY version DESC'
      )
      .all(id)
      .map((row) => ({
        id: row.id,
        version: row.version,
        updated_at: row.updated_at,
        is_active: row.is_active === 1,
        bodyHash: versionFor(row.body),
      }));
  }

  // 回滚：停用当前激活版本，激活指定版本。
  function activateVersion(id, version) {
    assertOverridable(id);
    const row = db
      .prepare('SELECT version FROM prompt_scenarios WHERE id = ? AND version = ?')
      .get(id, version);
    if (!row) throw new Error(`未知的 prompt 版本：${id}#${version}`);
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    db.prepare(
      'UPDATE prompt_scenarios SET is_active = 1, updated_at = ? WHERE id = ? AND version = ?'
    ).run(new Date().toISOString(), id, version);
    return { id, version };
  }

  // 回到文件内容：停用全部覆盖版本，历史行保留（不删）。
  function clearOverride(id) {
    assertOverridable(id);
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    return { id, cleared: true };
  }

  // 把备用 persona 文件的内容写进 persona.base 的覆盖版本 ——
  // 「启用 persona.v2」从此是一次数据库写入，不需要重新部署。
  function activatePersona(sourceId) {
    // 来源必须是「只读文件、不可被覆盖」的备用底座（今天只有 persona.v2）。
    // persona.base 自己不能当来源 —— 那等于把当前底座原样再写一遍，是个空操作，
    // 却会在数据库里留下一条「我改过 prompt」的假记录。
    if (
      !PART_FILES[sourceId] ||
      !sourceId.startsWith('persona.') ||
      OVERRIDABLE_IDS.includes(sourceId)
    ) {
      throw new Error(`未知的 persona 来源：${sourceId}`);
    }
    const source = readFile(sourceId);
    if (!source) throw new Error(`未知的 persona 来源：${sourceId}`);
    const result = setPromptOverride('persona.base', source.body);
    return { id: 'persona.base', version: result.version, from: sourceId, bodyHash: result.bodyHash };
  }

  function listScenarios() {
    return SCENARIO_IDS.map((scenarioId) => {
      const id = `scenario.${scenarioId}`;
      const part = readOverride(id) || readFile(id);
      const prompt = getPrompt(scenarioId);
      return {
        id,
        version: part ? part.version : null,
        source: part ? part.source : 'missing',
        partLength: part ? part.body.length : 0,
        promptLength: prompt.length,
      };
    });
  }

  // 所有可管理的部分（含 persona.v2 与 persona.base）。
  function listParts() {
    return Object.keys(PART_FILES).map((id) => {
      const part = getPart(id);
      return {
        id,
        version: part.version,
        source: part.source,
        length: part.body.length,
      };
    });
  }

  return {
    getPrompt,
    getPromptMeta,
    setPromptOverride,
    listScenarios,
    listParts,
    listVersions,
    activateVersion,
    clearOverride,
    activatePersona,
    readPart: getPart,
  };
}
