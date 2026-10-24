// prompt:split —— 从 server.js 里的 SYSTEM_PROMPT 机械地生成
//   tests/fixtures/legacy-chat-prompt.txt（黄金文件）
//   prompts/persona.base.md
//   prompts/scenario.chat.md
// 并校验三者拼装后与黄金文件逐字节相同。
//
// 安全约定：
// - 已经存在的 prompts/*.md 不会被覆盖（那可能是人工编辑过的 prompt）。
//   想重新拆分请先手动删除目标文件。
// - server.js 里不再有 SYSTEM_PROMPT 之后（接入 Prompt Registry 之后），
//   本脚本退化为纯校验：只比对现有文件与黄金文件是否一致。
//
// 用法：
//   npm run prompt:split            # 生成（仅补齐缺失文件）并校验
//   npm run prompt:split -- --force # 强制重新拆分（覆盖已存在的 prompt 文件）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JS = path.join(ROOT, 'server.js');
const GOLDEN = path.join(ROOT, 'tests/fixtures/legacy-chat-prompt.txt');
const PERSONA = path.join(ROOT, 'prompts/persona.base.md');
const SCENARIO = path.join(ROOT, 'prompts/scenario.chat.md');
const MARKER = '【故事模式】';

const force = process.argv.includes('--force');

function extractFromServer() {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!m) return null;
  return m[1].trim();
}

function writeIfMissing(file, content, label) {
  if (fs.existsSync(file) && !force) {
    console.log(`  跳过 ${label}（文件已存在，需要重建请加 --force）`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`  写入 ${label}`);
  return true;
}

const fromServer = extractFromServer();
let golden = null;

if (fromServer) {
  golden = fromServer;
  console.log(`从 server.js 提取到 SYSTEM_PROMPT：${golden.length} 字节`);
  writeIfMissing(GOLDEN, golden + '\n', 'tests/fixtures/legacy-chat-prompt.txt');
} else {
  console.log('server.js 中已无 SYSTEM_PROMPT（已接入 Prompt Registry），只做校验');
}

if (!golden && fs.existsSync(GOLDEN)) {
  golden = fs.readFileSync(GOLDEN, 'utf8').trim();
  console.log(`读取黄金文件：${golden.length} 字节`);
}

if (!golden) {
  console.error('没有可用的 prompt 源：server.js 里没有 SYSTEM_PROMPT，也没有黄金文件');
  process.exit(1);
}

const i = golden.indexOf(MARKER);
if (i < 0) {
  console.error(`黄金文件里找不到边界标记 ${MARKER}`);
  process.exit(1);
}

writeIfMissing(PERSONA, golden.slice(0, i).trim() + '\n', 'prompts/persona.base.md');
writeIfMissing(SCENARIO, golden.slice(i).trim() + '\n', 'prompts/scenario.chat.md');

const base = fs.readFileSync(PERSONA, 'utf8').trim();
const scenario = fs.readFileSync(SCENARIO, 'utf8').trim();
const assembled = `${base}\n\n${scenario}`;

if (assembled === golden) {
  console.log('✓ persona.base + "\\n\\n" + scenario.chat 与黄金文件逐字节相同');
} else {
  console.error('✗ 拼装结果与黄金文件不一致');
  console.error(`  黄金 ${golden.length} 字节 / 拼装 ${assembled.length} 字节`);
  for (let k = 0; k < Math.min(golden.length, assembled.length); k++) {
    if (golden[k] !== assembled[k]) {
      console.error(`  首个差异在第 ${k} 个字符`);
      console.error(`  黄金: ${JSON.stringify(golden.slice(k, k + 40))}`);
      console.error(`  拼装: ${JSON.stringify(assembled.slice(k, k + 40))}`);
      break;
    }
  }
  process.exit(1);
}
