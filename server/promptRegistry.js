import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts'
);

// id -> 文件名。未在数据库中被覆盖的场景从这里读取。
const SCENARIO_FILES = {
  'scenario.chat': 'scenario.chat.md',
  'scenario.cbt_quick': 'scenario.cbt_quick.md',
  'scenario.cbt_delivery': 'scenario.cbt_delivery.md',
  'scenario.analysis': 'scenario.analysis.md',
  'persona.base': 'persona.base.md',
};

export function createPromptRegistry({ db, promptsDir = PROMPTS_DIR } = {}) {
  function readOverride(id) {
    const row = db
      .prepare(
        'SELECT body, version FROM prompt_scenarios WHERE id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1'
      )
      .get(id);
    return row ? { body: row.body, version: row.version, source: 'db' } : null;
  }

  function readFile(id) {
    const file = SCENARIO_FILES[id];
    if (!file) return null;
    const full = path.join(promptsDir, file);
    if (!fs.existsSync(full)) return null;
    return { body: fs.readFileSync(full, 'utf8').trim(), version: 0, source: 'file' };
  }

  function getPart(id) {
    const override = readOverride(id);
    if (override) return override;
    const fromFile = readFile(id);
    if (fromFile) return fromFile;
    throw new Error(`未知的 prompt 场景：${id}`);
  }

  function getPrompt(scenarioId) {
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return `${base.body}\n\n${scenario.body}`;
  }

  function getPromptMeta(scenarioId) {
    const base = getPart('persona.base');
    const scenario = getPart(`scenario.${scenarioId}`);
    return {
      scenarioId,
      baseVersion: base.version,
      scenarioVersion: scenario.version,
      source: `${base.source}+${scenario.source}`,
    };
  }

  function setPromptOverride(id, body) {
    const maxRow = db
      .prepare('SELECT MAX(version) AS v FROM prompt_scenarios WHERE id = ?')
      .get(id);
    const version = (maxRow && maxRow.v ? maxRow.v : 0) + 1;
    db.prepare('UPDATE prompt_scenarios SET is_active = 0 WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO prompt_scenarios (id, version, body, is_active, updated_at) VALUES (?, ?, ?, 1, ?)'
    ).run(id, version, body, new Date().toISOString());
    return { id, version };
  }

  function listScenarios() {
    return Object.keys(SCENARIO_FILES).map(id => {
      const part = readOverride(id) || readFile(id);
      return {
        id,
        version: part ? part.version : null,
        source: part ? part.source : 'missing',
        length: part ? part.body.length : 0,
      };
    });
  }

  return { getPrompt, getPromptMeta, setPromptOverride, listScenarios, readPart: getPart };
}
