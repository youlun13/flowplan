/**
 * 重複任務：純函數。系列（有 repeat 的任務）→ 哪些日期該出現、實例 id、標籤。
 */
import type { Task, TaskRepeat } from '@/db/schema';
import { addLocalDays, compareLocalDate, localWeekday, weekdayLabel, type LocalDate } from '@/lib/time';

/** 預設生成多少天內的實例（含今天） */
export const REPEAT_HORIZON_DAYS = 14;

/** 實例 id 固定由系列 id 與日期組成：兩台裝置各自生成也不會重複 */
export function instanceId(seriesId: string, date: LocalDate): string {
  return `${seriesId}:${date}`;
}

export function isSeries(t: Task): boolean {
  return Boolean(t.repeat);
}

export function isInstance(t: Task): boolean {
  return Boolean(t.seriesId);
}

/** 某一天是否在規則內（不看 exceptions）；anchor = 系列開始日，「每幾天」從它起算 */
export function matchesRule(repeat: TaskRepeat, date: LocalDate, anchor: LocalDate): boolean {
  if (repeat.freq === 'daily') return true;
  if (repeat.freq === 'every_n_days') {
    const n = repeat.intervalDays ?? 2;
    const diff = daysBetween(anchor, date);
    return diff >= 0 && diff % n === 0;
  }
  const days = repeat.byWeekday ?? [];
  return days.includes(localWeekday(date));
}

function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 系列在 [from, to]（含）之間應該出現的日期，已排除 exceptions、開始日之前、until 之後 */
export function occurrenceDates(series: Task, from: LocalDate, to: LocalDate): LocalDate[] {
  const repeat = series.repeat;
  if (!repeat) return [];
  const anchor = series.plannedDate ?? from;
  const start = compareLocalDate(anchor, from) > 0 ? anchor : from;
  const end = repeat.until && compareLocalDate(repeat.until, to) < 0 ? repeat.until : to;
  const out: LocalDate[] = [];
  const skip = new Set(repeat.exceptions ?? []);
  let cursor = start;
  let guard = 0;
  while (compareLocalDate(cursor, end) <= 0 && guard++ < 400) {
    if (matchesRule(repeat, cursor, anchor) && !skip.has(cursor)) out.push(cursor);
    cursor = addLocalDays(cursor, 1);
  }
  return out;
}

/** 「每天」「每週一三五」「每週一三五 · 到 12/31」 */
export function repeatLabel(repeat: TaskRepeat, opts: { withUntil?: boolean } = {}): string {
  let base: string;
  if (repeat.freq === 'daily') base = '每天';
  else if (repeat.freq === 'every_n_days') base = `每 ${repeat.intervalDays ?? 2} 天`;
  else {
    const days = [...(repeat.byWeekday ?? [])].sort((a, b) => a - b);
    base = days.length === 7 ? '每天' : days.length === 0 ? '每週' : `每週${days.map((d) => weekdayLabel(d)).join('')}`;
  }
  if (opts.withUntil && repeat.until) {
    const [, m, d] = repeat.until.split('-');
    base += ` · 到 ${Number(m)}/${Number(d)}`;
  }
  return base;
}

/** 系列範本上會複製到每一次實例的欄位 */
export const SERIES_COPY_FIELDS = ['title', 'description', 'priority', 'estimatedMinutes', 'minimumMinutes', 'minimumOutcome', 'energyRequired', 'splittable'] as const;
export type SeriesCopyField = (typeof SERIES_COPY_FIELDS)[number];
