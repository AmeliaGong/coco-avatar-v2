#!/usr/bin/env node
// 把本地的 docs/探索者故事/*.md 灌进数据库（explorer_stories 表）。
//
// ⚠️ **这批素材是真人可识别信息**（化名、身份、所在地、职业、诊断词、
// 家庭创伤细节）：
//   - 源文件在 .gitignore 里（仓库是 public 的）；
//   - 脚本本身**不含任何内容** —— 它只描述「怎么读、怎么写」；
//   - 内容只落在数据库里（fly volume），**不进版本库、不进镜像、不进 prompt 文件**。
//
// 用法：
//
//   # 先看一眼会灌什么（不写任何东西）
//   node scripts/seed-explorer-stories.mjs --dry-run
//
//   # 真的写进去（本地库）
//   node scripts/seed-explorer-stories.mjs --apply --url http://localhost:8080 --token <ADMIN_TOKEN>
//
//   # 写进线上库（内容会经过网络到我们自己的服务器，TLS 加密）
//   EXPLORER_SEED_URL=https://coco-avatar-icy-sun-5917.fly.dev \
//   EXPLORER_SEED_TOKEN=<ADMIN_TOKEN> \
//   node scripts/seed-explorer-stories.mjs --apply
//
// 幂等：按 id 覆盖，素材改了重跑一次就行，不会攒出重复行。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExplorerMarkdown } from '../server/engine/explorerSource.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_DIR = path.join(ROOT, 'docs', '探索者故事');

function parseArgs(argv) {
  const args = { apply: false, dryRun: false, url: null, token: null, sourceDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--url') args.url = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
    else if (arg === '--source') args.sourceDir = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`不认识的参数：${arg}`);
  }
  return args;
}

// 素材文件在四个分类子目录里；「故事集.md」是分类索引、不是素材，跳过。
function collectStoryFiles(sourceDir) {
  if (!fs.existsSync(sourceDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const category = entry.name.slice(0, 2); // "01-职场青年…" → "01"
    const dir = path.join(sourceDir, entry.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      if (file === '故事集.md') continue;
      files.push({ path: path.join(dir, file), id: file.replace(/\.md$/, ''), category });
    }
  }
  return files.sort((a, b) => a.id.localeCompare(b.id, 'zh'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      '用法：node scripts/seed-explorer-stories.mjs [--dry-run | --apply] [--url URL] [--token TOKEN] [--source DIR]'
    );
    return;
  }

  const sourceDir = args.sourceDir
    ? path.resolve(args.sourceDir)
    : process.env.EXPLORER_SEED_SOURCE || DEFAULT_SOURCE_DIR;

  const files = collectStoryFiles(sourceDir);
  if (!files.length) {
    console.error(
      `没找到素材文件（${sourceDir}）。\n` +
        '这个目录是本地隐私材料，不在版本库里 —— 请确认它在本地存在。'
    );
    process.exitCode = 1;
    return;
  }

  const stories = [];
  const problems = [];
  for (const file of files) {
    const markdown = fs.readFileSync(file.path, 'utf8');
    const story = parseExplorerMarkdown(markdown, {
      id: file.id,
      fallbackCategory: file.category,
    });
    if (!story) {
      problems.push({ id: file.id, reason: '解析不出姓名或正文分段' });
      continue;
    }
    if (!story.one_liner) problems.push({ id: file.id, reason: '缺「一句话」' });
    if (!story.match_signals.length) problems.push({ id: file.id, reason: '缺「匹配信号」' });
    if (!story.segments.length) problems.push({ id: file.id, reason: '正文没有分段' });
    stories.push(story);
  }

  console.log(`素材目录：${sourceDir}`);
  console.log(`解析出 ${stories.length} 则` + (problems.length ? `，${problems.length} 处告警` : ''));
  for (const s of stories) {
    console.log(
      `  · ${s.name}（${s.id}） 分类=${s.category || '?'} 教育层级=${s.education_level || '-'} ` +
        `分段=${s.segments.length} 信号=${s.match_signals.length}`
    );
  }
  for (const p of problems) console.warn(`  ⚠️ ${p.id}：${p.reason}`);

  if (!args.apply) {
    console.log('\n（dry-run：什么也没写。要真的写，加 --apply。）');
    return;
  }

  const url =
    args.url || process.env.EXPLORER_SEED_URL || 'http://localhost:8080';
  const token = args.token || process.env.EXPLORER_SEED_TOKEN || process.env.ADMIN_TOKEN;
  if (!token) {
    console.error(
      '没有 admin token —— 探索者素材的写入接口要 X-Admin-Token。\n' +
        '用 --token 或 EXPLORER_SEED_TOKEN / ADMIN_TOKEN 传进来。'
    );
    process.exitCode = 1;
    return;
  }

  const endpoint = `${url.replace(/\/$/, '')}/api/admin/explorer-stories`;

  // 分批写：一次一批。
  //
  // 为什么分批：素材是**全文**，一批 15 则的请求体是 153KB 量级（UTF-8
  // 字节数，不是字符数 —— 中文一字 3 字节）。服务端给这个接口放宽到了 2mb，
  // 但分批写有两个好处：将来素材变多也不会撞上限；一批失败只影响那一批，
  // 不用从头再来。
  const BATCH_SIZE = 5;
  let written = 0;
  let rejectedTotal = 0;
  for (let i = 0; i < stories.length; i += BATCH_SIZE) {
    const batch = stories.slice(i, i + BATCH_SIZE);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify({ stories: batch }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `写入失败：HTTP ${res.status}`,
        body,
        `（第 ${i + 1}-${i + batch.length} 则）`
      );
      process.exitCode = 1;
      return;
    }
    written += body.accepted ? body.accepted.length : 0;
    rejectedTotal += body.rejected ? body.rejected.length : 0;
  }
  console.log(
    `\n已写入 ${written} 则 → ${endpoint}` +
      (rejectedTotal ? `（拒收 ${rejectedTotal} 则）` : '')
  );
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
