import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/db/db';
import {
  createTask,
  createTaskSeries,
  deleteTaskSeries,
  ensureRecurringInstances,
  setTaskDone,
  skipTaskOccurrence,
  updateTaskInstance,
  updateTaskSeries,
} from '@/db/repo';
import { instanceId, occurrenceDates, repeatLabel } from '@/engine/taskRepeat';
import { addLocalDays } from '@/lib/time';
import type { Task } from '@/db/schema';

const TODAY = '2026-11-20'; // 週五

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('occurrenceDates / repeatLabel（純函數）', () => {
  const series = (repeat: NonNullable<Task['repeat']>, plannedDate = TODAY): Task => ({
    id: 's', title: 'x', status: 'todo', priority: 'P2', estimatedMinutes: 30, energyRequired: 'medium', splittable: true, dependencies: [], deferCount: 0, plannedDate, repeat,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('每天：連續每一天；開始日之後才算', () => {
    expect(occurrenceDates(series({ freq: 'daily', exceptions: [] }, '2026-11-22'), TODAY, '2026-11-25')).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
  });
  it('每週一三五：只挑那幾天，排除例外，重複到之後停止', () => {
    const dates = occurrenceDates(series({ freq: 'weekly', byWeekday: [1, 3, 5], until: '2026-11-27', exceptions: ['2026-11-25'] }), TODAY, '2026-12-05');
    expect(dates).toEqual(['2026-11-20', '2026-11-23', '2026-11-27']);
  });
  it('標籤', () => {
    expect(repeatLabel({ freq: 'daily', exceptions: [] })).toBe('每天');
    expect(repeatLabel({ freq: 'weekly', byWeekday: [5, 1, 3], exceptions: [] })).toBe('每週一三五');
    expect(repeatLabel({ freq: 'weekly', byWeekday: [0, 1, 2, 3, 4, 5, 6], exceptions: [] })).toBe('每天');
    expect(repeatLabel({ freq: 'weekly', byWeekday: [2], until: '2026-12-31', exceptions: [] }, { withUntil: true })).toBe('每週二 · 到 12/31');
  });
});

describe('重複任務（系列 → 每一天的實例）', () => {
  it('建立每天的系列：立刻有 14 天的實例，id 固定，系列本身不是實例', async () => {
    const s = await createTaskSeries({ title: '背單字', estimatedMinutes: 20, repeat: { freq: 'daily', exceptions: [] } }, TODAY);
    expect(s.repeat?.freq).toBe('daily');
    expect(s.plannedDate).toBe(TODAY);
    const instances = await db.tasks.where('seriesId').equals(s.id).toArray();
    expect(instances).toHaveLength(14);
    expect(instances.map((t) => t.id)).toContain(instanceId(s.id, TODAY));
    expect(instances.every((t) => t.title === '背單字' && t.estimatedMinutes === 20 && t.status === 'todo' && !t.repeat)).toBe(true);
    expect(instances.find((t) => t.id === instanceId(s.id, TODAY))?.plannedDate).toBe(TODAY);
  });

  it('再跑 ensure 不會重複生成；跨日會補新的一天、收掉錯過的', async () => {
    const s = await createTaskSeries({ title: '練琴', repeat: { freq: 'daily', exceptions: [] } }, TODAY);
    const again = await ensureRecurringInstances(TODAY);
    expect(again.created).toBe(0);
    expect(await db.tasks.where('seriesId').equals(s.id).count()).toBe(14);

    const tomorrow = addLocalDays(TODAY, 1);
    const r = await ensureRecurringInstances(tomorrow);
    expect(r.created).toBe(1); // 第 15 天
    expect(r.missed).toBe(1); // 今天那一次沒做
    const missed = await db.tasks.get(instanceId(s.id, TODAY));
    expect(missed?.status).toBe('cancelled');
    expect(missed?.missed).toBe(true);
  });

  it('每一天各自完成；開始做過的不會被當成錯過', async () => {
    const s = await createTaskSeries({ title: '跑步', repeat: { freq: 'daily', exceptions: [] } }, TODAY);
    await setTaskDone(instanceId(s.id, TODAY), true);
    expect((await db.tasks.get(instanceId(s.id, addLocalDays(TODAY, 1))))?.status).toBe('todo');
    // 明天那次記了 10 分鐘但沒完成 → 後天跑 ensure 時不收掉（還在逾期裡提醒）
    await db.tasks.update(instanceId(s.id, addLocalDays(TODAY, 1)), { actualMinutes: 10 });
    await ensureRecurringInstances(addLocalDays(TODAY, 2));
    expect((await db.tasks.get(instanceId(s.id, TODAY)))?.status).toBe('done');
    expect((await db.tasks.get(instanceId(s.id, addLocalDays(TODAY, 1))))?.status).toBe('todo');
  });

  it('刪這一次：記成例外，之後不會再長出來', async () => {
    const s = await createTaskSeries({ title: '晨讀', repeat: { freq: 'daily', exceptions: [] } }, TODAY);
    const d = addLocalDays(TODAY, 3);
    await skipTaskOccurrence(instanceId(s.id, d), d);
    expect(await db.tasks.get(instanceId(s.id, d))).toBeUndefined();
    expect((await db.tasks.get(s.id))?.repeat?.exceptions).toEqual([d]);
    await ensureRecurringInstances(TODAY);
    expect(await db.tasks.get(instanceId(s.id, d))).toBeUndefined();
  });

  it('改整個系列：還沒做的跟著改、單獨改過的不動、規則改了會刪掉多的日子', async () => {
    const s = await createTaskSeries({ title: '英文', estimatedMinutes: 30, repeat: { freq: 'daily', exceptions: [] } }, TODAY);
    const d1 = addLocalDays(TODAY, 1);
    await updateTaskInstance(instanceId(s.id, d1), { title: '英文（只改這天）' });
    await setTaskDone(instanceId(s.id, TODAY), true);
    await updateTaskSeries(s.id, { title: '英文 v2', estimatedMinutes: 45, repeat: { freq: 'weekly', byWeekday: [1, 3], exceptions: [] } }, TODAY);
    const all = await db.tasks.where('seriesId').equals(s.id).toArray();
    const open = all.filter((t) => t.status === 'todo');
    // 只剩週一、週三（14 天內 4 天）＋ 單獨改過的那一天（週六）
    expect(open.map((t) => t.occurrenceDate).sort()).toEqual([d1, '2026-11-23', '2026-11-25', '2026-11-30', '2026-12-02']);
    expect(open.find((t) => t.occurrenceDate === '2026-11-23')?.title).toBe('英文 v2');
    expect(open.find((t) => t.occurrenceDate === '2026-11-23')?.estimatedMinutes).toBe(45);
    expect(open.find((t) => t.occurrenceDate === d1)?.title).toBe('英文（只改這天）');
    expect((await db.tasks.get(instanceId(s.id, TODAY)))?.status).toBe('done'); // 做完的留著
  });

  it('停止系列：範本與還沒做的實例刪掉，做完的留著；普通任務不受影響', async () => {
    const plain = await createTask({ title: '普通', plannedDate: TODAY });
    const s = await createTaskSeries({ title: '冥想', repeat: { freq: 'daily', exceptions: [] } }, TODAY);
    await setTaskDone(instanceId(s.id, TODAY), true);
    await deleteTaskSeries(s.id, TODAY);
    expect(await db.tasks.get(s.id)).toBeUndefined();
    const rest = await db.tasks.where('seriesId').equals(s.id).toArray();
    expect(rest).toHaveLength(1);
    expect(rest[0].status).toBe('done');
    expect(await db.tasks.get(plain.id)).toBeDefined();
  });

  it('驗證：每週至少選一天、重複到不能早於開始', async () => {
    await expect(createTaskSeries({ title: 'x', repeat: { freq: 'weekly', byWeekday: [], exceptions: [] } }, TODAY)).rejects.toThrow('至少要選一天');
    await expect(createTaskSeries({ title: 'x', repeat: { freq: 'daily', until: '2026-11-01', exceptions: [] } }, TODAY)).rejects.toThrow('不能早於');
  });
});
