/**
 * 時間工具 —— FlowPlan 的時區策略
 *
 * - 所有「時刻」(instant) 以 UTC ISO 字串儲存，例如 2026-10-21T07:00:00.000Z
 * - 所有「日期」(LocalDate) 以 YYYY-MM-DD 儲存，意義是 App 時區的當地日期
 * - 所有「一天中的時間」(HHmm) 以 HH:mm 儲存，意義是 App 時區的牆上時鐘
 * - App 時區固定存在設定裡（預設 Asia/Taipei），不看裝置時區
 */
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

export const DEFAULT_TZ = 'Asia/Taipei';

/** YYYY-MM-DD */
export type LocalDate = string;
/** HH:mm（24 小時制） */
export type HHmm = string;
/** 毫秒時間戳 */
export type Ms = number;

export type Instant = Date | string | number;

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

export function toMs(instant: Instant): Ms {
  if (instant instanceof Date) return instant.getTime();
  if (typeof instant === 'number') return instant;
  return new Date(instant).getTime();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isValidLocalDate(s: unknown): s is LocalDate {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}

export function isValidHHmm(s: unknown): s is HHmm {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function isValidIso(s: unknown): s is string {
  return typeof s === 'string' && !Number.isNaN(new Date(s).getTime());
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function splitDate(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

export function makeLocalDate(y: number, m: number, d: number): LocalDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 某個時刻在指定時區的當地日期 */
export function toLocalDate(instant: Instant, tz: string): LocalDate {
  return format(new TZDate(toMs(instant), tz), 'yyyy-MM-dd');
}

/** 某個時刻在指定時區的牆上時間 HH:mm */
export function toLocalTime(instant: Instant, tz: string): HHmm {
  return format(new TZDate(toMs(instant), tz), 'HH:mm');
}

/** 某個時刻在指定時區是一天中的第幾分鐘（0–1439） */
export function minutesIntoDay(instant: Instant, tz: string): number {
  const d = new TZDate(toMs(instant), tz);
  return d.getHours() * 60 + d.getMinutes();
}

/** 當地日期 + 牆上時間 → 時刻 */
export function localDateTimeToDate(date: LocalDate, time: HHmm, tz: string): Date {
  const [y, m, d] = splitDate(date);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, 0, tz).getTime());
}

export function localDateTimeToMs(date: LocalDate, time: HHmm, tz: string): Ms {
  return localDateTimeToDate(date, time, tz).getTime();
}

export function localDateTimeToIso(date: LocalDate, time: HHmm, tz: string): string {
  return localDateTimeToDate(date, time, tz).toISOString();
}

/** 當地日期的 00:00 時刻（毫秒） */
export function dayStartMs(date: LocalDate, tz: string): Ms {
  return localDateTimeToMs(date, '00:00', tz);
}

/** 當地日期隔天的 00:00 時刻（毫秒），也就是這天的結束（不含） */
export function dayEndMs(date: LocalDate, tz: string): Ms {
  return dayStartMs(addLocalDays(date, 1), tz);
}

export function todayLocal(tz: string, now: Instant = new Date()): LocalDate {
  return toLocalDate(now, tz);
}

export function addLocalDays(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = splitDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return makeLocalDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 0 = 週日 … 6 = 週六 */
export function localWeekday(date: LocalDate): number {
  const [y, m, d] = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_ZH[((weekday % 7) + 7) % 7];
}

export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function diffLocalDays(from: LocalDate, to: LocalDate): number {
  const [y1, m1, d1] = splitDate(from);
  const [y2, m2, d2] = splitDate(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export function timeToMinutes(time: HHmm): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): HHmm {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function startOfLocalWeek(date: LocalDate, weekStartsOn: 0 | 1): LocalDate {
  const wd = localWeekday(date);
  const offset = (wd - weekStartsOn + 7) % 7;
  return addLocalDays(date, -offset);
}

export function localMonthOf(date: LocalDate): { year: number; month: number } {
  const [y, m] = splitDate(date);
  return { year: y, month: m };
}

export function addLocalMonths(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = splitDate(date);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return makeLocalDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 月曆格子：固定 6 週 × 7 天 = 42 格 */
export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1): LocalDate[] {
  const first = makeLocalDate(year, month, 1);
  const gridStart = startOfLocalWeek(first, weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => addLocalDays(gridStart, i));
}

export function formatInTz(instant: Instant, tz: string, pattern: string): string {
  return format(new TZDate(toMs(instant), tz), pattern);
}

export function formatTime(instant: Instant, tz: string): string {
  return formatInTz(instant, tz, 'HH:mm');
}

/** 例：10月21日（三） */
export function formatLocalDateZh(date: LocalDate, withYear = false): string {
  const [y, m, d] = splitDate(date);
  const wd = weekdayLabel(localWeekday(date));
  return withYear ? `${y}年${m}月${d}日（${wd}）` : `${m}月${d}日（${wd}）`;
}

/** 例：10/21 */
export function formatLocalDateShort(date: LocalDate): string {
  const [, m, d] = splitDate(date);
  return `${m}/${d}`;
}

/** 以指定時區顯示「10/21 15:00」 */
export function formatDateTimeZh(instant: Instant, tz: string): string {
  return formatInTz(instant, tz, 'M/d HH:mm');
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} 小時` : `${h} 小時 ${rest} 分`;
}

export function relativeDayLabel(date: LocalDate, today: LocalDate): string {
  const diff = diffLocalDays(today, date);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff === 2) return '後天';
  return formatLocalDateZh(date);
}
