import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, FlowPlanDB } from '@/db/db';
import {
  addEventException,
  clearAllData,
  createEvent,
  createTask,
  deferTask,
  deleteTask,
  getSettings,
  setTaskDone,
  startLog,
  stopLog,
  updateSettings,
  updateTask,
} from '@/db/repo';
import { exportBackupJson, importBackup, parseBackup } from '@/db/backup';
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

  it('不小心按到完成 → 取消完成會把一起被結束的排程區塊還原（早就做完的區塊不動）', async () => {
    const t = await createTask({ title: 'x' });
    const now = new Date().toISOString();
    const base = { taskId: t.id, date: '2026-10-28', startAt: now, endAt: now, isMinimum: false, createdAt: now, updatedAt: now } as const;
    await db.workBlocks.bulkPut([
      { ...base, id: 'b-planned', status: 'planned' },
      { ...base, id: 'b-active', status: 'active' },
      { ...base, id: 'b-old-done', status: 'done', endedAt: '2026-10-28T01:00:00.000Z' },
    ]);
    await setTaskDone(t.id, true);
    expect((await db.workBlocks.get('b-planned'))!.status).toBe('done');
    expect((await db.workBlocks.get('b-active'))!.status).toBe('done');
    await setTaskDone(t.id, false);
    expect((await db.workBlocks.get('b-planned'))!.status).toBe('planned');
    expect((await db.workBlocks.get('b-active'))!.status).toBe('planned');
    expect((await db.workBlocks.get('b-planned'))!.endedAt).toBeUndefined();
    expect((await db.workBlocks.get('b-old-done'))!.status).toBe('done');
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

describe('舊版殘留的示範資料', () => {
  it('啟動時自動刪掉（含其區塊），自己的資料不受影響；舊備份匯入時也會濾掉', async () => {
    const { purgeDemoData, hasNoOwnData } = await import('@/db/repo');
    const { importBackup, parseBackup, exportBackupJson } = await import('@/db/backup');
    expect(await hasNoOwnData()).toBe(true);
    const demo = await createTask({ title: '舊示範', plannedDate: '2026-10-21', isDemo: true } as never);
    await createTask({ title: '自己的', plannedDate: '2026-10-21' });
    await db.workBlocks.put({ id: 'wb', taskId: demo.id, date: '2026-10-21', startAt: '2026-10-21T01:00:00.000Z', endAt: '2026-10-21T02:00:00.000Z', status: 'planned', isMinimum: false, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' });
    expect(await purgeDemoData()).toBe(1);
    expect((await db.tasks.toArray()).map((t) => t.title)).toEqual(['自己的']);
    expect(await db.workBlocks.count()).toBe(0);
    expect(await purgeDemoData()).toBe(0);
    // 舊備份裡的示範資料不匯入
    const json = await exportBackupJson();
    const backup = parseBackup(json);
    backup.tasks.push({ ...backup.tasks[0], id: 'demo-2', title: '備份裡的示範', isDemo: true });
    await importBackup(backup, 'replace');
    expect((await db.tasks.toArray()).map((t) => t.title)).toEqual(['自己的']);
  });
});

describe('舊版設定列升級', () => {
  it('第一階段寫入、沒有 sync / useCalibration 欄位的設定列：讀取時補齊並寫回，live query 也拿得到完整欄位', async () => {
    const { normalizeSettings } = await import('@/db/schema');
    const { getSettings } = await import('@/db/repo');
    const { db } = await import('@/db/db');
    const legacy = {
      id: 'default', timeZone: 'Asia/Taipei', weekStartsOn: 1, workStart: '08:00', workEnd: '23:00', sleepStart: '00:00', sleepEnd: '07:30',
      bufferMinutes: 10, breakMinutes: 10, focusMinutes: 45, preferDeadlineFirst: true, energyMatching: true, allowSplitting: true,
      ai: { enabled: false, provider: 'none', maxOutputTokens: 1024, dailyLimit: 30 }, demoDataLoaded: true, backupReminderDays: 7, updatedAt: '2026-10-01T00:00:00.000Z',
    };
    await db.settings.put(legacy as never);
    // live query 會拿到原始列：normalizeSettings 必須補出 sync
    expect(normalizeSettings(legacy).sync).toEqual({ enabled: false, auto: true });
    expect(normalizeSettings(legacy).useCalibration).toBe(true);
    expect(normalizeSettings({ id: 'default', garbage: true }).workStart).toBe('08:00');
    const s = await getSettings();
    expect(s.sync).toEqual({ enabled: false, auto: true });
    const row = (await db.settings.get('default')) as unknown as Record<string, unknown>;
    expect(row.sync).toEqual({ enabled: false, auto: true });
    expect(row.useCalibration).toBe(true);
  });
});
