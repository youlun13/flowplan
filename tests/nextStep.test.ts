import { describe, expect, it } from 'vitest';
import { pickNextStep } from '@/engine/nextStep';
import type { Task } from '@/db/schema';
import { localDateTimeToIso, localDateTimeToMs } from '@/lib/time';

const TPE = 'Asia/Taipei';
const now = localDateTimeToMs('2026-10-21', '09:00', TPE);

function task(p: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    status: 'todo',
    priority: 'P2',
    estimatedMinutes: 30,
    energyRequired: 'medium',
    splittable: true,
    dependencies: [],
    deferCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    plannedDate: '2026-10-21',
    ...p,
  };
}

describe('下一步（簡易版）', () => {
  it('已完成的任務不會再被安排（驗收 8）', () => {
    const r = pickNextStep([task({ id: 'a', title: '做完了', status: 'done', priority: 'P1' }), task({ id: 'b', title: '還沒', priority: 'P3' })], now, TPE);
    expect(r?.task.id).toBe('b');
  });

  it('進行中優先於截止，截止優先於優先級', () => {
    const list = [
      task({ id: 'p1', title: 'P1', priority: 'P1' }),
      task({ id: 'due', title: '今天截止', priority: 'P3', dueAt: localDateTimeToIso('2026-10-21', '18:00', TPE) }),
      task({ id: 'wip', title: '進行中', priority: 'P3', status: 'in_progress' }),
    ];
    expect(pickNextStep(list, now, TPE)?.task.id).toBe('wip');
    expect(pickNextStep(list.filter((t) => t.id !== 'wip'), now, TPE)?.task.id).toBe('due');
    expect(pickNextStep(list.filter((t) => t.id === 'p1'), now, TPE)?.task.id).toBe('p1');
  });

  it('前置未完成的任務不是候選', () => {
    const list = [task({ id: 'a', title: '前置' }), task({ id: 'b', title: '後續', priority: 'P1', dependencies: ['a'] })];
    expect(pickNextStep(list, now, TPE)?.task.id).toBe('a');
  });

  it('低精力時遇到高負荷任務會給警示但不跳過（規則 4）', () => {
    const r = pickNextStep([task({ id: 'hard', title: '證明題', priority: 'P1', energyRequired: 'high' })], now, TPE, 'low');
    expect(r?.task.id).toBe('hard');
    expect(r?.warning).toBeTruthy();
  });

  it('沒有今天或近期任務時回傳 null', () => {
    expect(pickNextStep([task({ id: 'far', title: '下週', plannedDate: '2026-10-30' })], now, TPE)).toBeNull();
  });
});
