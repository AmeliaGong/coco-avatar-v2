// 两个忽略文件的**语义正好相反**，各写错一次 ⇒ 各自钉一条断言：
//
//   .gitignore    —— 规则：只有**前导或中间**带斜杠的模式才相对根目录锚定；
//                    **只带尾部斜杠不算锚定** ⇒ `data/` 在任意层级都命中
//                    ⇒ 曾经把 `src/data/stories.ts`（前端源码）一起忽略掉，
//                    那个文件从来没被提交 ⇒ 干净 clone 之后 `npm run build` 必失败。
//
//   .dockerignore —— 规则：模式拿**相对构建上下文的完整路径**去匹配；
//                    **不带斜杠的模式只匹配根目录那一层** ⇒ `data` 不会误伤
//                    `src/data/`，但 `*.db` 也**匹配不到** `data/coco.db`
//                    ⇒ 本地库（可能有 PII）会跟着 `COPY . .` 进镜像。
//
// 这里用 `git check-ignore`（**真的 git 实现**，不是我们复写的）判 .gitignore；
// .dockerignore 没有等价的 CLI，所以下面复写一份 Docker 的匹配规则。
// 那份规则的每一个分支都对着**真的 Docker**（29.2.1）实测过：
//   · `data`       ⇒ 命中根 `data/`，**不**命中 `src/data/`
//   · `*.db`       ⇒ 命中根级 `x.db`，**不**命中 `data/coco.db`
//   · `/data` 与 `data/` ⇒ 都命中根 `data/`，都不命中 `src/data/`
//   · `**/*.db`    ⇒ 命中任意深度（含根级，`**` 可以匹配零层）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readIgnoreFile(name) {
  return readFileSync(path.join(repoRoot, name), 'utf8');
}

// 取出一份忽略文件里真正生效的模式（去掉注释与空行）。
function patternsOf(name) {
  return readIgnoreFile(name)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// Docker 的模式 → 正则：
//   - 开头的前导 `/` 只是「锚定根目录」，匹配时去掉；
//   - 结尾的 `/` 只是「这是目录」，匹配时去掉；
//   - `**/`  → 可匹配零层或多层目录；
//   - `**`   → 任意字符（含 `/`）；
//   - `*`    → 任意字符，**不跨 `/`**；
//   - `?`    → 任意一个字符，不跨 `/`。
// 关键点：因为匹配的是**完整相对路径**，一个不带斜杠的模式天然只匹配根目录
// 那一层（`data` ≠ `src/data`）—— 这就是它跟 gitignore 相反的地方。
function dockerPatternToRegExp(pattern) {
  let p = pattern;
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);

  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

// 一个路径被排除，当且仅当：某个模式命中它本身，或命中它的**某一级祖先目录**
// （命中目录 ⇒ 目录下的东西全都不进镜像）。
function dockerExcludes(patterns, relPath) {
  const parts = relPath.split('/');
  const prefixes = [];
  for (let i = 1; i <= parts.length; i += 1) prefixes.push(parts.slice(0, i).join('/'));

  return prefixes.some(prefix =>
    patterns.some(pattern => dockerPatternToRegExp(pattern).test(prefix))
  );
}

function gitIgnores(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relPath], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

test('.dockerignore：本地 SQLite 库不能进镜像（`COPY . .` 会把 build context 整个打进去）', () => {
  const patterns = patternsOf('.dockerignore');

  assert.equal(
    dockerExcludes(patterns, 'data/coco.db'),
    true,
    'data/coco.db 必须在镜像之外 —— 里面有本地会话内容（可能是 PII）'
  );
  assert.equal(dockerExcludes(patterns, 'data/coco.db-wal'), true, 'WAL 也要挡');
  assert.equal(dockerExcludes(patterns, 'data/coco.db-shm'), true, 'SHM 也要挡');
});

test('.dockerignore：不能误伤前端源码 `src/data/stories.ts`（`main` 上干净 clone 构建必失败）', () => {
  const patterns = patternsOf('.dockerignore');

  assert.equal(
    dockerExcludes(patterns, 'src/data/stories.ts'),
    false,
    'src/data/stories.ts 必须进镜像 —— src/pages/GlobeScene.tsx 与 StoryPage.tsx 都 import 它'
  );
});

test('.dockerignore：`docs` / `tests` / `scripts` 只排掉根目录那一份', () => {
  const patterns = patternsOf('.dockerignore');

  assert.equal(dockerExcludes(patterns, 'docs/plan.md'), true, '根目录 docs 要排掉');
  assert.equal(dockerExcludes(patterns, 'tests/api.chat.test.js'), true, '根目录 tests 要排掉');
  // 源码头里没有同名目录，但这条断言钉住的是「不带斜杠只匹配根目录」这条规则。
  assert.equal(dockerExcludes(patterns, 'src/docs/plan.md'), false, 'src/ 下的同名目录不能被排掉');
});

test('.gitignore：根目录的 `data/` 要忽略，`src/data/` 不能忽略', () => {
  assert.equal(gitIgnores('data/coco.db'), true, '根目录 data/ 是本地库，必须忽略');
  assert.equal(
    gitIgnores('src/data/stories.ts'),
    false,
    'src/data/stories.ts 是前端源码 —— 它被忽略过一次，导致干净 clone 之后 npm run build 必失败'
  );
});
