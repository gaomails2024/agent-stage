/**
 * 日志/数据库时间的解析 —— 唯一实现。
 *
 * 三种写法语义不同，混起来会错整整一个时区：
 *   1. "2026-10-26 17:50:07"           本机墙上时间（日志、sqlite）
 *   2. "2026-10-26T17:50:07.556Z"      UTC ISO
 *   3. "2026-10-26T17:50:07.556+08:00" 带偏移的 ISO
 *
 * 必须先判断原始格式再补时区。旧实现先把空格替换成 T，之后就无法与 (2)
 * 区分，于是 (1) 被当成 UTC —— 在 UTC+8 上得到 -28800s 的"未来时间"，
 * 导致"刚刚还在动"被永久判成 running（Marvis 就一直卡在 running）。
 */

/** 本机时区偏移，形如 "+08:00" */
export function localOffsetSuffix(at = new Date()) {
  const offMin = -at.getTimezoneOffset(); // 东为正
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * 只有“空格分隔”的才是本机墙上时间。
 * 裸 T（无 Z/偏移）按 UTC 处理，避免 UTC+8 上再差 8 小时。
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
const HAS_ZONE = /[zZ]|[+-]\d{2}:?\d{2}$/;

/**
 * 解析时间并返回"距今多少毫秒"。
 * 无法确定、或算出来是未来的，一律返回 null —— 宁可不判，也不能当成忙。
 */
export function parseLogAgeMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  let s = String(value).trim();
  if (!s) return null;

  const wall = WALL_CLOCK.test(s);
  if (wall) s = s.replace(' ', 'T');

  if (!HAS_ZONE.test(s)) {
    // 墙上时间按本机时区；裸 ISO-T（某些审批记录）按 UTC
    s += wall ? localOffsetSuffix() : 'Z';
  }

  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const age = now - t;
  if (age < 0) return null;
  return age;
}
