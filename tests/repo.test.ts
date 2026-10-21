import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, FlowPlanDB } from '@/db/db';
import {
  addEventException,
  clearAllData,
  createEvent,
  createTask,
  deferTask,
  deleteDemoData,
  deleteTask,
  getSettings,
  setTaskDone,
  startLog,
  stopLog,
  updateSettings,
  updateTask,
} from '@/db/repo';
import { exportBackupJson, importBackup, parseBackup } from '@/db/backup';
import { loadDemoDataIfEmpty } from '@/db/seed';
import { expandEvents } from '@/engine/recurrence';
import { addLocalDays, localDateTimeToIso, todayLocal } from '@/lib/time';

const TPE = 'Asia/Taipei';

beforeEach(async () => {
  await clearAllData();
});

describe('任務持久化', () => {
  it('新增明天的 TODO，重新開啟資料庫後仍存在（驗收 1）', async () => {
    const tomorrow = addLocalDays(todayLocal(TPE), 1);
    const t = await createTask({ title: '明天要做的事', plannedDate: tomorrow });
    const reopened = new FlowPlanDB('flowplan');
    const found = await reopened.tasks.get(t.id);
    expect(found?.title).toBe('明天要做的事');
    expect(found?.plannedDate).toBe(tomorrow);
    expect(found?.status).toBe('todo');
    reopened.close();
  });

  it('編輯名稱、期限、優先級與工時後正確保存（驗收 2）', async () => {
    const t = await createTask({ title: '原名' });
    const due = localDateTimeToIso('2026-11-01', '18:00', TPE);
    await updateTask(t.id, { title: '新名', dueAt: due, priority: 'P1', estimatedMinutes: 90 });
    const found = await db.tasks.get(t.id);
    expect(found).toMatchObject({ title: '新名', dueAt: due, priority: 'P1', estimatedMinutes: 90 });
    expect(found!.updatedAt >= t.updatedAt).toBe(true);
  });

  it('勾選完成與取消勾選（驗收 3）', async () => {
    const t = await createTask({ title: 'x' });
    const done = await setTaskDone(t.id, true);
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeTruthy();
    const undone = await setTaskDone(t.id, false);
    expect(undone.status).toBe('todo');
    expect(undone.completedAt).toBeUndefined();
  });

  it('空白標題、非法工時會被拒絕（規格 13 空白 TODO）', async () => {
    await expect(createTask({ title: '   ' })).rejects.toThrow('任務名稱不能空白');
    await expect(createTask({ title: 'ok', estimatedMinutes: 2 })).rejects.toThrow();
  });

  it('依賴循環會被拒絕', async () => {
    const a = await createTask({ title: 'a' });
    const b = await createTask({ title: 'b', dependencies: [a.id] });
    await expect(updateTask(a.id, { dependencies: [b.id] })).rejects.toThrow('循環');
  });

  it('延後會累計 deferCount（規則 8）', async () => {
    const t = await createTask({ title: 'x', plannedDate: '2026-10-21' });
    await deferTask(t.id, '2026-10-22');
    const d = await deferTask(t.id, '2026-10-23');
    expect(d.plannedDate).toBe('2026-10-23');
    expect(d.deferCount).toBe(2);
    expect(d.lastDeferredAt).toBeTruthy();
  });

  it('刪除任務會清掉其他任務對它的依賴', async () => {
    const a = await createTask({ title: 'a' });
    const b = await createTask({ title: 'b', dependencies: [a.id] });
    await deleteTask(a.id);
    expect((await db.tasks.get(b.id))?.dependencies).toEqual([]);
  });
});

describe('行程', () => {
  it('新增週重複課程並單次例外', async () => {
    const ev = await createEvent({
      title: '線代',
      kind: 'class',
      startAt: localDateTimeToIso('2026-10-21', '15:00', TPE),
      endAt: localDateTimeToIso('2026-10-21', '17:00', TPE),
      recurrence: { byWeekday: [3] },
    });
    await addEventException(ev.id, '2026-10-28');
    const all = await db.events.toArray();
    const occ = expandEvents(all, '2026-10-19', '2026-11-08', TPE);
    expect(occ.map((o) => o.date)).toEqual(['2026-10-21', '2026-11-04']);
  });

  it('結束早於開始會被拒絕', async () => {
    await expect(
      createEvent({ title: 'bad', startAt: localDateTimeToIso('2026-10-21', '15:00', TPE), endAt: localDateTimeToIso('2026-10-21', '14:00', TPE) }),
    ).rejects.toThrow('結束時間必須晚於開始時間');
  });
});

describe('實際紀錄', () => {
  it('開始 / 結束紀錄會把任務設為進行中並累計實際工時', async () => {
    const t = await createTask({ title: '讀書' });
    const log = await startLog({ title: '讀書', taskId: t.id, category: 'task' }, TPE);
    expect((await db.tasks.get(t.id))?.status).toBe('in_progress');
    const end = new Date(new Date(log.startAt).getTime() + 25 * 60_000).toISOString();
    await stopLog(log.id, end, TPE);
    expect((await db.tasks.get(t.id))?.actualMinutes).toBe(25);
  });

  it('開始新紀錄會自動結束前一筆進行中的紀錄', async () => {
    const first = await startLog({ title: '一' }, TPE);
    await startLog({ title: '二' }, TPE);
    expect((await db.logs.get(first.id))?.endAt).toBeTruthy();
    const running = await db.logs.filter((l) => !l.endAt).toArray();
    expect(running).toHaveLength(1);
    expect(running[0].title).toBe('二');
  });
});

describe('備份', () => {
  it('匯出 → 清空 → 匯入（替換）後資料一致', async () => {
    await createTask({ title: 'A', priority: 'P1' });
    await createEvent({ title: 'E', startAt: '2026-10-21T07:00:00.000Z', endAt: '2026-10-21T09:00:00.000Z' });
    await updateSettings({ workStart: '09:00' });
    const json = await exportBackupJson();
    expect((await getSettings()).lastBackupAt).toBeTruthy();
    await clearAllData();
    expect(await db.tasks.count()).toBe(0);
    const result = await importBackup(parseBackup(json), 'replace');
    expect(result).toMatchObject({ tasks: 1, events: 1 });
    expect((await db.tasks.toArray())[0].title).toBe('A');
    expect((await getSettings()).workStart).toBe('09:00');
  });

  it('壞掉的備份檔整份拒絕', () => {
    expect(() => parseBackup('{not json')).toThrow('JSON');
    expect(() => parseBackup(JSON.stringify({ app: 'flowplan', schemaVersion: 1, exportedAt: 'x', tasks: [], events: [] }))).toThrow('格式不正確');
    expect(() =>
      parseBackup(JSON.stringify({ app: 'flowplan', schemaVersion: 1, exportedAt: '2026-10-21T00:00:00.000Z', tasks: [{ id: '1' }], events: [] })),
    ).toThrow('格式不正確');
  });
});

describe('示範資料', () => {
  it('首次載入，再一鍵刪除後資料庫為空', async () => {
    expect(await loadDemoDataIfEmpty(TPE)).toBe(true);
    expect(await db.tasks.count()).toBeGreaterThan(0);
    expect(await loadDemoDataIfEmpty(TPE)).toBe(false);
    await deleteDemoData();
    expect(await db.tasks.count()).toBe(0);
    expect(await db.events.count()).toBe(0);
    expect(await db.logs.count()).toBe(0);
    // 刪除後不會再自動載入
    expect(await loadDemoDataIfEmpty(TPE)).toBe(false);
  });
});
