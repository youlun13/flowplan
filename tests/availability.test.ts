import { describe, expect, it } from 'vitest';
import { computeAvailability, hardConflicts } from '@/engine/availability';
import { mergeIntervals, subtractIntervals, findOverlaps } from '@/engine/intervals';
import { localDateTimeToMs, toLocalTime } from '@/lib/time';

const TPE = 'Asia/Taipei';
const ms = (d: string, t: string) => localDateTimeToMs(d, t, TPE);
const fmt = (x: number) => toLocalTime(x, TPE);

const base = {
  date: '2026-10-21',
  tz: TPE,
  workStart: '08:00',
  workEnd: '23:00',
  sleepStart: '00:00',
  sleepEnd: '07:30',
  bufferMinutes: 10,
};

describe('區間運算', () => {
  it('merge 與 subtract', () => {
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }])).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 50, end: 60 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 50 },
      { start: 60, end: 100 },
    ]);
  });

  it('找出重疊行程', () => {
    const list = [
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 5, end: 15 },
      { id: 'c', start: 20, end: 30 },
    ];
    const pairs = findOverlaps(list);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('可用時段（規則 1：硬性限制優先）', () => {
  it('15:00–17:00 有課時，可用時段不含課程與前後緩衝（驗收 5）', () => {
    const r = computeAvailability({ ...base, busy: [{ startMs: ms('2026-10-21', '15:00'), endMs: ms('2026-10-21', '17:00') }] });
    const windows = r.windows.map((w) => [fmt(w.start), fmt(w.end)]);
    expect(windows).toEqual([
      ['08:00', '14:50'],
      ['17:10', '23:00'],
    ]);
    // 任何落在課程內的候選時段都會被標記衝突
    expect(hardConflicts({ start: ms('2026-10-21', '15:30'), end: ms('2026-10-21', '16:00') }, r)).toHaveLength(1);
    expect(hardConflicts({ start: ms('2026-10-21', '13:00'), end: ms('2026-10-21', '14:00') }, r)).toHaveLength(0);
  });

  it('睡過頭兩小時：只用剩餘時間（驗收 6 的基礎）', () => {
    const full = computeAvailability({ ...base, busy: [] });
    const lateStart = computeAvailability({ ...base, busy: [], from: ms('2026-10-21', '10:00') });
    expect(full.totalMinutes).toBe(15 * 60);
    expect(lateStart.totalMinutes).toBe(13 * 60);
    expect(fmt(lateStart.windows[0].start)).toBe('10:00');
  });

  it('睡眠保護跨午夜：可工作到凌晨 01:00 時，00:00 之後被擋掉', () => {
    const r = computeAvailability({ ...base, workEnd: '01:00', busy: [] });
    expect(r.windows.map((w) => [fmt(w.start), fmt(w.end)])).toEqual([['08:00', '00:00']]);
  });

  it('睡眠區間不跨午夜（例如 13:00–14:00 午睡）也能正確扣除', () => {
    const r = computeAvailability({ ...base, sleepStart: '13:00', sleepEnd: '14:00', busy: [] });
    expect(r.windows.map((w) => [fmt(w.start), fmt(w.end)])).toEqual([
      ['08:00', '13:00'],
      ['14:00', '23:00'],
    ]);
  });

  it('零碎時段會被忽略', () => {
    const r = computeAvailability({
      ...base,
      busy: [
        { startMs: ms('2026-10-21', '09:00'), endMs: ms('2026-10-21', '12:00') },
        { startMs: ms('2026-10-21', '12:25'), endMs: ms('2026-10-21', '14:00') },
      ],
      minWindowMinutes: 15,
    });
    // 12:10–12:15 只有 5 分鐘，捨棄
    expect(r.windows.map((w) => [fmt(w.start), fmt(w.end)])).toEqual([
      ['08:00', '08:50'],
      ['14:10', '23:00'],
    ]);
  });

  it('重疊的硬性行程會合併，不會重複扣除', () => {
    const r = computeAvailability({
      ...base,
      bufferMinutes: 0,
      busy: [
        { startMs: ms('2026-10-21', '10:00'), endMs: ms('2026-10-21', '12:00') },
        { startMs: ms('2026-10-21', '11:00'), endMs: ms('2026-10-21', '13:00') },
      ],
    });
    expect(r.totalMinutes).toBe(15 * 60 - 3 * 60);
  });
});
