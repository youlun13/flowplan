import { describe, expect, it } from 'vitest';
import { calibratedMinutes, calibration, completionHistory, deferralAnalysis, weekStats } from '@/engine/stats';
import { buildPlan, type PlannerInput } from '@/engine/planner';
import type { ActivityLog, Task } from '@/db/schema';
import { localDateTimeToIso, localDateTimeToMs } from '@/lib/time';

const TPE = 'Asia/Taipei';
const iso = (d: string, t: string) => localDateTimeToIso(d, t, TPE);

function task(p: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    status: 'todo',
    priority: 'P2',
    estimatedMinutes: 60,
    energyRequired: 'medium',
    splittable: true,
    dependencies: [],
    deferCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...p,
  };
}
function log(p: Partial<ActivityLog> & Pick<ActivityLog, 'id' | 'date' | 'startAt' | 'endAt'>): ActivityLog {
  return { title: 'x', category: 'study', createdAt: p.startAt, updatedAt: p.startAt, ...p };
}

describe('週統計', () => {
  it('依日期與分類加總，完成數按 completedAt 的當地日期算', () => {
    const logs = [
      log({ id: '1', date: '2026-10-19', startAt: iso('2026-10-19', '09:00'), endAt: iso('2026-10-19', '10:30'), category: 'study' }),
      log({ id: '2', date: '2026-10-19', startAt: iso('2026-10-19', '12:00'), endAt: iso('2026-10-19', '12:30'), category: 'meal' }),
      log({ id: '3', date: '2026-10-26', startAt: iso('2026-10-26', '09:00'), endAt: iso('2026-10-26', '10:00') }), // 下週，不算
    ];
    const tasks = [task({ id: 'a', title: 'a', status: 'done', completedAt: iso('2026-10-21', '23:50') }), task({ id: 'b', title: 'b', plannedDate: '2026-10-21' })];
    const days = weekStats(logs, tasks, '2026-10-19', TPE, localDateTimeToMs('2026-10-21', '12:00', TPE));
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: '2026-10-19', totalMinutes: 120, minutesByCategory: { study: 90, meal: 30 } });
    expect(days[2]).toMatchObject({ date: '2026-10-21', completedTasks: 1, plannedTasks: 1 });
    expect(days.reduce((s, d) => s + d.totalMinutes, 0)).toBe(120);
  });
});

describe('預估校正', () => {
  it('樣本不足不給係數；足夠時取中位數並依精力分組', () => {
    expect(calibration([task({ id: 'a', title: 'a', status: 'done', actualMinutes: 90 })]).factor).toBeUndefined();
    const tasks = [
      task({ id: 'a', title: 'a', status: 'done', estimatedMinutes: 60, actualMinutes: 90, energyRequired: 'high' }),
      task({ id: 'b', title: 'b', status: 'done', estimatedMinutes: 60, actualMinutes: 120, energyRequired: 'high' }),
      task({ id: 'c', title: 'c', status: 'done', estimatedMinutes: 60, actualMinutes: 60, energyRequired: 'high' }),
      task({ id: 'd', title: 'd', status: 'done', estimatedMinutes: 60, actualMinutes: 30, energyRequired: 'low' }),
      task({ id: 'e', title: 'e', status: 'todo', estimatedMinutes: 60, actualMinutes: 600 }), // 未完成不算
    ];
    const c = calibration(tasks);
    expect(c.samples).toBe(4);
    expect(c.factor).toBe(1.25); // 中位數 of [1.5, 2, 1, 0.5] = (1+1.5)/2
    expect(c.byEnergy.high).toEqual({ factor: 1.5, samples: 3 });
    expect(c.byEnergy.low).toBeUndefined();
    expect(calibratedMinutes(40, 'high', c)).toEqual({ minutes: 60, factor: 1.5, basis: 'energy' });
    expect(calibratedMinutes(40, 'low', c)).toEqual({ minutes: 50, factor: 1.25, basis: 'overall' });
    expect(calibratedMinutes(40, 'low', undefined).basis).toBe('none');
  });

  it('極端值裁切到 0.25–4', () => {
    const tasks = ['a', 'b', 'c'].map((id) => task({ id, title: id, status: 'done', estimatedMinutes: 10, actualMinutes: 600 }));
    expect(calibration(tasks).factor).toBe(4);
  });

  it('規則引擎有校正時用校正後工時，並在說明裡交代', () => {
    const settings = { workStart: '08:00', workEnd: '23:00', sleepStart: '00:00', sleepEnd: '07:30', bufferMinutes: 10, breakMinutes: 10, focusMinutes: 45, preferDeadlineFirst: true, energyMatching: true, allowSplitting: true };
    const input: PlannerInput = { nowMs: localDateTimeToMs('2026-10-21', '09:00', TPE), tz: TPE, settings, tasks: [task({ id: 'x', title: '讀書', estimatedMinutes: 60, plannedDate: '2026-10-21', energyRequired: 'high' })], busy: [], existingBlocks: [] };
    const plain = buildPlan(input);
    const cal = buildPlan({ ...input, calibration: { factor: 1.5, byEnergy: { high: { factor: 2, samples: 3 } } } });
    expect(plain.stats.plannedMinutes).toBe(60);
    expect(cal.stats.plannedMinutes).toBe(120);
    expect(cal.explanation.join('\n')).toContain('×2');
  });
});

describe('延期分析與完成歷史', () => {
  it('列出延後最多的未完成任務，算平均與飢餓數', () => {
    const tasks = [
      task({ id: 'a', title: 'a', deferCount: 3 }),
      task({ id: 'b', title: 'b', deferCount: 1 }),
      task({ id: 'c', title: 'c', deferCount: 5, status: 'done' }), // 已完成不算
      task({ id: 'd', title: 'd' }),
    ];
    const r = deferralAnalysis(tasks);
    expect(r.items.map((i) => i.task.id)).toEqual(['a', 'b']);
    expect(r.averageDefers).toBe(1.3);
    expect(r.starving).toBe(1);
  });
  it('完成歷史覆蓋最近 N 天', () => {
    const tasks = [task({ id: 'a', title: 'a', status: 'done', completedAt: iso('2026-10-21', '10:00') }), task({ id: 'b', title: 'b', status: 'done', completedAt: iso('2026-10-01', '10:00') })];
    const h = completionHistory(tasks, '2026-10-21', 7, TPE);
    expect(h).toHaveLength(7);
    expect(h[6]).toEqual({ date: '2026-10-21', count: 1 });
    expect(h.reduce((s, d) => s + d.count, 0)).toBe(1);
  });
});
