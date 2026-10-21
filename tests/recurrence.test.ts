import { describe, expect, it } from 'vitest';
import { expandEvents, occurrencesOnDate } from '@/engine/recurrence';
import type { CalendarEvent } from '@/db/schema';
import { localDateTimeToIso, toLocalTime } from '@/lib/time';

const TPE = 'Asia/Taipei';
const iso = (d: string, t: string) => localDateTimeToIso(d, t, TPE);

function event(partial: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'title' | 'startAt' | 'endAt'>): CalendarEvent {
  return { kind: 'class', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...partial };
}

describe('週重複行程展開', () => {
  const weekly = event({
    id: 'math',
    title: '工程數學',
    startAt: iso('2026-10-21', '15:00'), // 週三
    endAt: iso('2026-10-21', '17:00'),
    recurrence: { freq: 'weekly', byWeekday: [1, 3], exceptions: ['2026-10-28'], until: '2026-11-11' },
  });

  it('只在指定星期出現，且保留相同牆上時間', () => {
    const occ = expandEvents([weekly], '2026-10-19', '2026-10-25', TPE);
    expect(occ.map((o) => o.date)).toEqual(['2026-10-21']); // 10-19 週一在第一次發生之前，不展開
    expect(toLocalTime(occ[0].startAt, TPE)).toBe('15:00');
    expect(toLocalTime(occ[0].endAt, TPE)).toBe('17:00');
    expect(occ[0].recurring).toBe(true);
    expect(occ[0].id).toBe('math:2026-10-21');
  });

  it('exceptions 會跳過、until 之後不再出現', () => {
    const occ = expandEvents([weekly], '2026-10-19', '2026-11-30', TPE);
    const dates = occ.map((o) => o.date);
    expect(dates).toEqual(['2026-10-21', '2026-10-26', '2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);
    expect(dates).not.toContain('2026-10-28');
    expect(dates).not.toContain('2026-11-16');
  });

  it('一次性行程只要和範圍重疊就會出現', () => {
    const once = event({ id: 'exam', title: '期中考', kind: 'exam', startAt: iso('2026-10-24', '10:00'), endAt: iso('2026-10-24', '12:00') });
    expect(expandEvents([once], '2026-10-24', '2026-10-24', TPE)).toHaveLength(1);
    expect(expandEvents([once], '2026-10-25', '2026-10-31', TPE)).toHaveLength(0);
  });

  it('跨午夜行程在兩天都看得到（規格 13）', () => {
    const late = event({ id: 'late', title: '夜間實驗', kind: 'other', startAt: iso('2026-10-21', '23:00'), endAt: iso('2026-10-22', '01:00') });
    const occ = expandEvents([late], '2026-10-20', '2026-10-23', TPE);
    expect(occ).toHaveLength(1);
    expect(occurrencesOnDate(occ, '2026-10-21', TPE)).toHaveLength(1);
    expect(occurrencesOnDate(occ, '2026-10-22', TPE)).toHaveLength(1);
    expect(occurrencesOnDate(occ, '2026-10-23', TPE)).toHaveLength(0);
  });

  it('結束早於開始的壞資料不會展開', () => {
    const bad = event({ id: 'bad', title: 'bad', startAt: iso('2026-10-21', '12:00'), endAt: iso('2026-10-21', '11:00') });
    expect(expandEvents([bad], '2026-10-21', '2026-10-21', TPE)).toHaveLength(0);
  });
});
