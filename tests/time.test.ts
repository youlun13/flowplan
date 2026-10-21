import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  addLocalMonths,
  dayEndMs,
  dayStartMs,
  diffLocalDays,
  localDateTimeToIso,
  localWeekday,
  minutesIntoDay,
  monthGrid,
  startOfLocalWeek,
  toLocalDate,
  toLocalTime,
} from '@/lib/time';

const TPE = 'Asia/Taipei';

describe('時區工具（Asia/Taipei）', () => {
  it('台北 15:00 等於 UTC 07:00', () => {
    expect(localDateTimeToIso('2026-10-21', '15:00', TPE)).toBe('2026-10-21T07:00:00.000Z');
  });

  it('UTC 深夜在台北已是隔天', () => {
    // 2026-10-21 23:30 台北 = 15:30Z；2026-10-21 16:30Z = 台北 10-22 00:30
    expect(toLocalDate('2026-10-21T15:30:00.000Z', TPE)).toBe('2026-10-21');
    expect(toLocalDate('2026-10-21T16:30:00.000Z', TPE)).toBe('2026-10-22');
    expect(toLocalTime('2026-10-21T16:30:00.000Z', TPE)).toBe('00:30');
    expect(minutesIntoDay('2026-10-21T16:30:00.000Z', TPE)).toBe(30);
  });

  it('一天的起訖為台北 00:00 至隔天 00:00', () => {
    expect(new Date(dayStartMs('2026-10-21', TPE)).toISOString()).toBe('2026-10-20T16:00:00.000Z');
    expect(new Date(dayEndMs('2026-10-21', TPE)).toISOString()).toBe('2026-10-21T16:00:00.000Z');
  });

  it('日期加減跨月、跨年正確', () => {
    expect(addLocalDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addLocalMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(diffLocalDays('2026-10-21', '2026-11-01')).toBe(11);
  });

  it('星期與週起始日', () => {
    expect(localWeekday('2026-10-21')).toBe(3); // 週三
    expect(startOfLocalWeek('2026-10-21', 1)).toBe('2026-10-19'); // 週一起始
    expect(startOfLocalWeek('2026-10-21', 0)).toBe('2026-10-18'); // 週日起始
  });

  it('月曆格子固定 42 格且從週一開始', () => {
    const grid = monthGrid(2026, 10, 1);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-09-28');
    expect(localWeekday(grid[0])).toBe(1);
    expect(grid).toContain('2026-10-01');
    expect(grid).toContain('2026-10-31');
  });
});

describe('有夏令時間的時區也能正確換算（規格 13）', () => {
  it('倫敦 2026-03-29 進入夏令時間後，同一牆上時間對應不同 UTC', () => {
    expect(localDateTimeToIso('2026-03-28', '09:00', 'Europe/London')).toBe('2026-03-28T09:00:00.000Z');
    expect(localDateTimeToIso('2026-03-29', '09:00', 'Europe/London')).toBe('2026-03-29T08:00:00.000Z');
  });
});
