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

/** 某一天是否在規則內（不看 exceptions） */
export function matchesRule(repeat: TaskRepeat, date: LocalDate): boolean {
  if (repeat.freq === 'daily') return true;
  const days = repeat.byWeekday ?? [];
  return days.includes(localWeekday(date));
}

/** 系列在 [from, to]（含）之間應該出現的日期，已排除 exceptions、開始日之前、until 之後 */
export function occurrenceDates(series: Task, from: LocalDate, to: LocalDate): LocalDate[] {
  const repeat = series.repeat;
  if (!repeat) return [];
  const start = series.plannedDate && compareLocalDate(series.plannedDate, from) > 0 ? series.plannedDate : from;
  const end = repeat.until && compareLocalDate(repeat.until, to) < 0 ? repeat.until : to;
  const out: LocalDate[] = [];
  const skip = new Set(repeat.exceptions ?? []);
  let cursor = start;
  let guard = 0;
  while (compareLocalDate(cursor, end) <= 0 && guard++ < 400) {
    if (matchesRule(repeat, cursor) && !skip.has(cursor)) out.push(cursor);
    cursor = addLocalDays(cursor, 1);
  }
  return out;
}

/** 「每天」「每週一三五」「每週一三五 · 到 12/31」 */
export function repeatLabel(repeat: TaskRepeat, opts: { withUntil?: boolean } = {}): string {
  let base: string;
  if (repeat.freq === 'daily') base = '每天';
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
