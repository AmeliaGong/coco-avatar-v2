// 两个契约模块共用的归一化规则。
//
// 为什么单独抽出来：stuck_point 和方案 payload 会被游民纪元的小程序
// BFF 拿去对接，两边同名字段（title、belief……）的处理规则必须一致。
// 规则各写一份，迟早会漂移 —— 而漂移会变成「同一份数据在两个产品里
// 长相不一样」这种极难查的问题。

// 是不是一个「普通对象」。数组不算：JSON 数组不是卡点也不是方案。
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 转成文本。空值变空串，非字符串的标量保留其字符串形态（0 是 0，
// 不是空 —— 用 `||` 会把 0 吞掉，那是在丢信息）。
export function toText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  return '';
}

// 转成数字。数字字符串（模型常这么写）也算；无法解析返回 null。
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 读布尔值。模型经常把 false 写成字符串 "false" 或数字 0 ——
// 只认 `=== false` 会让「这一轮不安排练习」的判断整个失效。
export function toBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return fallback;
}

// 这个值能不能被理解成一个布尔值。用于 validate：不能理解就报错，
// 而不是悄悄用默认值把它吞掉。
export function isBooleanLike(value) {
  if (typeof value === 'boolean') return true;
  if (value === 1 || value === 0) return true;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    return t === 'true' || t === 'false';
  }
  return false;
}
