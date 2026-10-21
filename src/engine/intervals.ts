/**
 * 時間區間運算（純函數，毫秒時間戳）。
 * 可用時段、硬性衝突檢查、重疊偵測都建立在這裡。
 */
export interface Interval {
  start: number;
  end: number;
}

export function isEmptyInterval(i: Interval): boolean {
  return i.end <= i.start;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function durationMinutes(i: Interval): number {
  return Math.max(0, (i.end - i.start) / 60_000);
}

export function totalMinutes(list: Interval[]): number {
  return list.reduce((sum, i) => sum + durationMinutes(i), 0);
}

/** 排序並合併重疊/相鄰區間 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((i) => !isEmptyInterval(i))
    .slice()
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** base − blockers */
export function subtractIntervals(base: Interval[], blockers: Interval[]): Interval[] {
  const blocks = mergeIntervals(blockers);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const blk of blocks) {
      if (blk.end <= cursor) continue;
      if (blk.start >= b.end) break;
      if (blk.start > cursor) out.push({ start: cursor, end: blk.start });
      cursor = Math.max(cursor, blk.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

/** 把區間裁切到 [from, to) */
export function clipIntervals(list: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const i of list) {
    const s = Math.max(i.start, from);
    const e = Math.min(i.end, to);
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

export function padInterval(i: Interval, beforeMs: number, afterMs: number): Interval {
  return { start: i.start - beforeMs, end: i.end + afterMs };
}

/** 回傳所有兩兩重疊的配對（用於重疊行程警示） */
export function findOverlaps<T extends Interval>(list: T[]): Array<[T, T]> {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  const out: Array<[T, T]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start >= sorted[i].end) break;
      if (overlaps(sorted[i], sorted[j])) out.push([sorted[i], sorted[j]]);
    }
  }
  return out;
}
