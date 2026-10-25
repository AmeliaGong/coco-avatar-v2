// 教练手法库 —— Coco 自己用过的一套方法。
//
// 为什么要有这一层：教练的干预是有名字、有适用场景、有原话的。
// 那些东西现在只躺在 1v1 转写里，下一次要做同样的判断，只能靠人重读转写。
// 沉淀成库，系统才知道「该怎么打」，14 天 Circle 也从这里取「圈」。
//
// **归档不物理删**：方案里引用过的手法（practices.circle）删了就变成悬空引用。
// 归档（active = 0）之后不再出现在选择列表里，但历史方案还能显示它。

import { randomUUID } from 'node:crypto';

function now() {
  return new Date().toISOString();
}

// 字符串数组的规范化：去空白、去重、丢掉空项。
//
// **为什么去重**：教练可能把同一个 target 写两遍（前端多选 + 手工补），
// 库里留着重复项会让「这一手打的是哪类信念」看起来像有两类。
function toStringArray(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? [value] : []);
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// 存进 DB 前用；读出来时用 safeParse。
function safeParse(text) {
  if (typeof text !== 'string' || !text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// id 的守卫：不是非空字符串就当「不存在」处理。
// **为什么** —— id 会从 URL 参数、请求体进来，一个对象绑进 better-sqlite3
// 会抛 RangeError；在 async handler 里抛出去就是一次 unhandledRejection
// = 进程退出 = 整站掉线（fly.io 单进程）。
function isValidId(id) {
  return typeof id === 'string' && id.trim() !== '';
}

export function createCoachMoveStore({ db }) {
  if (!db) throw new Error('createCoachMoveStore 需要 db');

  function get(id) {
    if (!isValidId(id)) return null;
    const row = db.prepare('SELECT * FROM coach_moves WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      active: row.active ? 1 : 0,
      targets: safeParse(row.targets),
      tags: safeParse(row.tags),
    };
  }

  function create({ name, summary, when_to_use = null, script = null, targets = [], tags = [] } = {}) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) throw new Error('name 必填');
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('summary 必填');
    const dup = db.prepare('SELECT id FROM coach_moves WHERE name = ?').get(n);
    if (dup) throw new Error(`手法名「${n}」已存在`);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO coach_moves (id, name, summary, when_to_use, script, targets, tags, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      id, n, summary.trim(),
      when_to_use ? String(when_to_use) : null,
      script ? String(script) : null,
      JSON.stringify(toStringArray(targets)),
      JSON.stringify(toStringArray(tags)),
      now(), now()
    );
    return get(id);
  }

  function list({ activeOnly = false } = {}) {
    const sql = activeOnly
      ? 'SELECT * FROM coach_moves WHERE active = 1 ORDER BY name ASC'
      : 'SELECT * FROM coach_moves ORDER BY active DESC, name ASC';
    return db.prepare(sql).all().map(r => ({
      ...r,
      active: r.active ? 1 : 0,
      targets: safeParse(r.targets),
      tags: safeParse(r.tags),
    }));
  }

  function update(id, patch = {}) {
    if (!isValidId(id)) throw new Error('手法 id 不合法');
    const cur = get(id);
    if (!cur) throw new Error('手法不存在');
    const name = patch.name !== undefined ? String(patch.name).trim() : cur.name;
    if (!name) throw new Error('name 必填');
    if (name !== cur.name) {
      const dup = db.prepare('SELECT id FROM coach_moves WHERE name = ? AND id <> ?').get(name, id);
      if (dup) throw new Error(`手法名「${name}」已存在`);
    }
    const summary = patch.summary !== undefined ? String(patch.summary).trim() : cur.summary;
    if (!summary) throw new Error('summary 必填');
    db.prepare(
      `UPDATE coach_moves SET name = ?, summary = ?, when_to_use = ?, script = ?, targets = ?, tags = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      name, summary,
      patch.when_to_use !== undefined ? patch.when_to_use : cur.when_to_use,
      patch.script !== undefined ? patch.script : cur.script,
      JSON.stringify(patch.targets !== undefined ? toStringArray(patch.targets) : cur.targets),
      JSON.stringify(patch.tags !== undefined ? toStringArray(patch.tags) : cur.tags),
      now(), id
    );
    return get(id);
  }

  // 归档：不物理删 —— 方案里引用过它，删了就悬空了。
  function archive(id) {
    if (!isValidId(id)) throw new Error('手法 id 不合法');
    db.prepare('UPDATE coach_moves SET active = 0, updated_at = ? WHERE id = ?').run(now(), id);
    return get(id);
  }

  function restore(id) {
    if (!isValidId(id)) throw new Error('手法 id 不合法');
    db.prepare('UPDATE coach_moves SET active = 1, updated_at = ? WHERE id = ?').run(now(), id);
    return get(id);
  }

  // 种子：按名字 upsert，幂等 —— 跑两次不重复、不覆盖教练改过的 summary。
  function seed(list_ = []) {
    const created = [];
    for (const item of list_) {
      const n = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!n) continue;
      const exists = db.prepare('SELECT id FROM coach_moves WHERE name = ?').get(n);
      if (exists) continue;
      created.push(create(item));
    }
    return created;
  }

  return { create, list, get, update, archive, restore, seed };
}

// 种子手法：第一批上线时灌进去，教练在后台自己改写、扩充、归档。
//
// **只写「手法本身」，不写具体来访者的经历** —— 手法是方法，人和数据不进库。
// 幂等：seed() 按名字跳过已存在的，所以跑多少次都一样。
export const SEED_MOVES = [
  {
    name: '换一个基准',
    summary: '同一个表现放在不同的基准下评价，结论会完全不同',
    when_to_use: '来访者用健康期的标准衡量恢复期的自己',
    script: '要不要换一把尺子量一下？',
  },
  {
    name: '先处理再贴标签',
    summary: '先问现在能做什么，再问这是不是我的问题',
    when_to_use: '卡点刚被激活、情绪高的当下',
    script: '现在能做的下一步是什么？',
  },
  {
    name: '问你的心',
    summary: '把注意力从脑子怎么分析转到心里真正要什么',
    when_to_use: '分析了很多但动不了',
    script: '你心里真正想要的是什么？',
  },
  {
    name: '允许自己脆弱',
    summary: '检查来访者是不是不允许自己处在求助者的位置上',
    when_to_use: '拖着状态硬扛健康人的标准',
    script: '你允许自己现在是被照顾的那个人吗？',
  },
  {
    name: '用未来的你需要的支撑来决策',
    summary: '以未来那个需要支撑的自己做决定，而不是此刻硬撑',
    when_to_use: '当下冲动和长期代价冲突的时候',
    script: '未来的你会需要什么样的支撑？',
  },
];
