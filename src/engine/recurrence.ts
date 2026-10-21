/**
 * 週重複行程展開。
 *
 * CalendarEvent 的 startAt/endAt 代表「第一次發生」的時刻；
 * recurrence.byWeekday 指定每週哪幾天重複；每次重複都用相同的牆上時間（App 時區）。
 */
import type { CalendarEvent, EventKind } from '@/db/schema';
import {
  addLocalDays,
  compareLocalDate,
  dayEndMs,
  dayStartMs,
  localDateTimeToMs,
  localWeekday,
  toLocalDate,
  toLocalTime,
  type LocalDate,
} from '@/lib/time';

export interface Occurrence {
  /** `${eventId}` 或 `${eventId}:${date}`（重複行程） */
  id: string;
  eventId: string;
  title: string;
  kind: EventKind;
  location?: string;
  note?: string;
  /** 行程在 App 時區開始的那一天 */
  date: LocalDate;
  startAt: string;
  endAt: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  recurring: boolean;
  isDemo?: boolean;
}

function toOccurrence(ev: CalendarEvent, startMs: number, endMs: number, date: LocalDate): Occurrence {
  return {
    id: ev.recurrence ? `${ev.id}:${date}` : ev.id,
    eventId: ev.id,
    title: ev.title,
    kind: ev.kind,
    location: ev.location,
    note: ev.note,
    date,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    startMs,
    endMs,
    allDay: ev.allDay ?? false,
    recurring: Boolean(ev.recurrence),
    isDemo: ev.isDemo,
  };
}

/**
 * 展開 [fromDate, toDate]（含）範圍內所有行程發生。
 * 一次性行程：只要與範圍有重疊就納入。
 * 重複行程：逐日展開，排除 exceptions 與 until 之後的日期。
 */
export function expandEvents(events: CalendarEvent[], fromDate: LocalDate, toDate: LocalDate, tz: string): Occurrence[] {
  if (compareLocalDate(fromDate, toDate) > 0) return [];
  const rangeStart = dayStartMs(fromDate, tz);
  const rangeEnd = dayEndMs(toDate, tz);
  const out: Occurrence[] = [];

  for (const ev of events) {
    const startMs = new Date(ev.startAt).getTime();
    const endMs = new Date(ev.endAt).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) continue;

    if (!ev.recurrence) {
      if (startMs < rangeEnd && endMs > rangeStart) {
        out.push(toOccurrence(ev, startMs, endMs, toLocalDate(startMs, tz)));
      }
      continue;
    }

    const duration = endMs - startMs;
    const firstDate = toLocalDate(startMs, tz);
    const time = toLocalTime(startMs, tz);
    const byWeekday = new Set(ev.recurrence.byWeekday);
    const exceptions = new Set(ev.recurrence.exceptions ?? []);
    const until = ev.recurrence.until;

    let cursor = compareLocalDate(fromDate, firstDate) > 0 ? fromDate : firstDate;
    // 重複行程若在前一天晚上開始、跨到範圍第一天，也要抓到：往前多看一天
    cursor = addLocalDays(cursor, -1);
    const last = until && compareLocalDate(until, toDate) < 0 ? until : toDate;

    while (compareLocalDate(cursor, last) <= 0) {
      if (
        compareLocalDate(cursor, firstDate) >= 0 &&
        byWeekday.has(localWeekday(cursor)) &&
        !exceptions.has(cursor)
      ) {
        const s = localDateTimeToMs(cursor, time, tz);
        const e = s + duration;
        if (s < rangeEnd && e > rangeStart) out.push(toOccurrence(ev, s, e, cursor));
      }
      cursor = addLocalDays(cursor, 1);
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title, 'zh-Hant'));
  return out;
}

/** 某一天（App 時區）有重疊的行程 */
export function occurrencesOnDate(occurrences: Occurrence[], date: LocalDate, tz: string): Occurrence[] {
  const s = dayStartMs(date, tz);
  const e = dayEndMs(date, tz);
  return occurrences.filter((o) => o.startMs < e && o.endMs > s);
}
