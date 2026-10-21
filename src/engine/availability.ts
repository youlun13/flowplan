/**
 * 可用時段計算（規則 1：固定限制優先）。
 *
 * 可用時段 = 可工作時段 − 睡眠保護 − 硬性行程（含前後緩衝）
 * 所有輸出都是毫秒區間；呼叫端用 App 時區顯示。
 */
import { clipIntervals, mergeIntervals, padInterval, subtractIntervals, totalMinutes, type Interval } from './intervals';
import { addLocalDays, localDateTimeToMs, timeToMinutes, type HHmm, type LocalDate } from '@/lib/time';

export interface AvailabilityInput {
  date: LocalDate;
  tz: string;
  workStart: HHmm;
  workEnd: HHmm;
  sleepStart: HHmm;
  sleepEnd: HHmm;
  /** 每個硬性行程前後要留的緩衝（分鐘） */
  bufferMinutes: number;
  /** 硬性行程（已展開） */
  busy: Array<{ startMs: number; endMs: number }>;
  /** 只計算這個時刻之後（例如 now） */
  from?: number;
  /** 短於此分鐘數的零碎時段忽略 */
  minWindowMinutes?: number;
}

export interface AvailabilityResult {
  windows: Interval[];
  totalMinutes: number;
  workWindow: Interval;
  sleepWindows: Interval[];
  busyPadded: Interval[];
}

/** 某天的可工作區間；若結束時間不晚於開始時間，視為跨到隔天 */
export function workWindowFor(date: LocalDate, workStart: HHmm, workEnd: HHmm, tz: string): Interval {
  const start = localDateTimeToMs(date, workStart, tz);
  const endDate = timeToMinutes(workEnd) <= timeToMinutes(workStart) ? addLocalDays(date, 1) : date;
  const end = localDateTimeToMs(endDate, workEnd, tz);
  return { start, end };
}

/** 睡眠區間（涵蓋前一天、當天、隔天開始的三段，確保跨午夜情況完整） */
export function sleepWindowsAround(date: LocalDate, sleepStart: HHmm, sleepEnd: HHmm, tz: string): Interval[] {
  const crossesMidnight = timeToMinutes(sleepEnd) <= timeToMinutes(sleepStart);
  const out: Interval[] = [];
  for (const offset of [-1, 0, 1]) {
    const d = addLocalDays(date, offset);
    const start = localDateTimeToMs(d, sleepStart, tz);
    const end = localDateTimeToMs(crossesMidnight ? addLocalDays(d, 1) : d, sleepEnd, tz);
    if (end > start) out.push({ start, end });
  }
  return mergeIntervals(out);
}

export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const workWindow = workWindowFor(input.date, input.workStart, input.workEnd, input.tz);
  const sleepWindows = sleepWindowsAround(input.date, input.sleepStart, input.sleepEnd, input.tz);
  const pad = Math.max(0, input.bufferMinutes) * 60_000;
  const busyPadded = mergeIntervals(
    input.busy
      .filter((b) => b.endMs > b.startMs)
      .map((b) => padInterval({ start: b.startMs, end: b.endMs }, pad, pad)),
  );

  let windows = subtractIntervals([workWindow], [...sleepWindows, ...busyPadded]);
  if (input.from !== undefined) windows = clipIntervals(windows, input.from, Number.POSITIVE_INFINITY);
  const minMs = (input.minWindowMinutes ?? 10) * 60_000;
  windows = windows.filter((w) => w.end - w.start >= minMs);

  return { windows, totalMinutes: Math.round(totalMinutes(windows)), workWindow, sleepWindows, busyPadded };
}

/** 檢查某個區間是否碰到任何硬性限制（行程 / 睡眠）；回傳碰到的區間 */
export function hardConflicts(candidate: Interval, result: AvailabilityResult): Interval[] {
  const hits: Interval[] = [];
  for (const b of [...result.busyPadded, ...result.sleepWindows]) {
    if (candidate.start < b.end && b.start < candidate.end) hits.push(b);
  }
  return hits;
}
