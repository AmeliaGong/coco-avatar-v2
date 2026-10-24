// prompt:split —— 从 server.js 里的 SYSTEM_PROMPT 机械地拆出
//   prompts/persona.base.md
//   prompts/scenario.chat.md
// 并校验两者拼装后与「原始字节」逐字节相同。
//
// 三条约定（别改）：
// 1. tests/fixtures/legacy-chat-prompt.txt 是**参考**，不是**产物**。
//    它是生产 prompt 的字节级快照，是回归锚点。脚本永远不会顺手重写它。
// 2. --force 只重建 prompts/*.md，永远不碰黄金文件。
//    （把黄金文件一起重写等于「把回归锚点洗白」—— 改了线上 prompt 再 --force，
//      脚本照样会打印「✓ 逐字节相同」，回归保护就白设了。）
// 3. 重新基线黄金文件是**独立动作**：--rebaseline，且要求 server.js 里
//    仍然存在 SYSTEM_PROMPT 字面量（没有字面量就没有可信的新基线来源）。
//
// 用法：
//   npm run prompt:split                    # 生成（仅补齐缺失文件）并校验
//   npm run prompt:split -- --force         # 强制重新拆分 prompts/*.md（不碰黄金文件）
//   npm run prompt:split -- --rebaseline    # 重新基线黄金文件（需要 server.js 里有 SYSTEM_PROMPT）

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
const rebaseline = process.argv.includes('--rebaseline');

// 只去尾部空白，保留开头。生产 prompt 以一个换行开头 —— 那是内容的一部分。
function stripTrailing(s) {
  return s.replace(/\s+$/, '');
}

// 取捕获组，不 trim：生产 prompt 的原始字节（含前导换行、不含结尾换行）。
function extractFromServer() {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!m) return null;
  return m[1];
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

function describe(s) {
  return `${s.length} 字符 / ${Buffer.byteLength(s, 'utf8')} 字节`;
}

function diff(golden, assembled) {
  for (let k = 0; k < Math.min(golden.length, assembled.length); k++) {
    if (golden[k] !== assembled[k]) {
      console.error(`  首个差异在第 ${k} 个字符`);
      console.error(`  参考: ${JSON.stringify(golden.slice(k, k + 40))}`);
      console.error(`  拼装: ${JSON.stringify(assembled.slice(k, k + 40))}`);
      return;
    }
  }
  console.error('  前缀完全相同，差异在长度');
}

const fromServer = extractFromServer();

// 黄金文件：原始字节读取，不 trim。
let goldenFile = fs.existsSync(GOLDEN) ? fs.readFileSync(GOLDEN, 'utf8') : null;

if (rebaseline) {
  if (!fromServer) {
    console.error('✗ 无法重新基线：server.js 里已经没有 SYSTEM_PROMPT 字面量，没有可信的新基线来源');
    process.exit(1);
  }
  console.warn('⚠ 正在重新基线黄金文件 —— 这会让旧的生产快照失去回归保护');
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, fromServer);
  goldenFile = fromServer;
  console.log(`  写入 tests/fixtures/legacy-chat-prompt.txt（${describe(goldenFile)}）`);
}

// 拆分用的源：优先 server.js 里的字面量（那是生产真身），否则用黄金文件。
const source = fromServer || goldenFile;
if (!source) {
  console.error('没有可用的 prompt 源：server.js 里没有 SYSTEM_PROMPT，也没有黄金文件');
  process.exit(1);
}
if (fromServer) {
  console.log(`从 server.js 提取到 SYSTEM_PROMPT：${describe(fromServer)}`);
} else {
  console.log('server.js 中已无 SYSTEM_PROMPT（已接入 Prompt Registry），只做校验');
}
if (!rebaseline && goldenFile) {
  console.log(`读取黄金文件：${describe(goldenFile)}`);
}

const i = source.indexOf(MARKER);
if (i < 0) {
  console.error(`prompt 源里找不到边界标记 ${MARKER}`);
  process.exit(1);
}

// persona 部分保留前导换行（那是生产 prompt 的一部分），只去尾部空白；
// scenario 部分从标记开始，同样只去尾部空白。写盘时各补一个结尾换行（文件惯例）。
const personaPart = stripTrailing(source.slice(0, i));
const scenarioPart = stripTrailing(source.slice(i));
writeIfMissing(PERSONA, personaPart + '\n', 'prompts/persona.base.md');
writeIfMissing(SCENARIO, scenarioPart + '\n', 'prompts/scenario.chat.md');

const base = stripTrailing(fs.readFileSync(PERSONA, 'utf8'));
const scenario = stripTrailing(fs.readFileSync(SCENARIO, 'utf8'));
const assembled = `${base}\n\n${scenario}`;

let ok = true;

// 与黄金文件比 —— 黄金文件是回归锚点，这是最重要的一条校验。
if (goldenFile) {
  if (assembled === goldenFile) {
    console.log('✓ persona.base + "\\n\\n" + scenario.chat 与黄金文件逐字节相同');
  } else {
    ok = false;
    console.error('✗ 拼装结果与黄金文件不一致');
    console.error(`  黄金 ${describe(goldenFile)} / 拼装 ${describe(assembled)}`);
    diff(goldenFile, assembled);
  }
}

// 与 server.js 里的字面量比 —— 只有它还在的时候才有得比。
if (fromServer) {
  if (assembled === fromServer) {
    console.log('✓ persona.base + "\\n\\n" + scenario.chat 与 server.js 中的 SYSTEM_PROMPT 逐字节相同');
  } else {
    ok = false;
    console.error('✗ 拼装结果与 server.js 中的 SYSTEM_PROMPT 不一致');
    console.error(`  字面量 ${describe(fromServer)} / 拼装 ${describe(assembled)}`);
    diff(fromServer, assembled);
  }
}

if (!ok) process.exit(1);
