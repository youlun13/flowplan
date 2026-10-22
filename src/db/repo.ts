/**
 * 資料存取層。所有寫入都先經 Zod 驗證；UI 不直接碰 Dexie 寫入。
 */
import { db } from './db';
import {
  ActivityLogSchema,
  CalendarEventSchema,
  DailyStateSchema,
  SettingsSchema,
  TaskSchema,
  defaultSettings,
  normalizeSettings,
  settingsNeedsUpgrade,
  type ActivityLog,
  type CalendarEvent,
  type DailyState,
  type Energy,
  type LogCategory,
  type Priority,
  type Settings,
  type Task,
} from './schema';
import { newId } from '@/lib/id';
import { nowIso, toLocalDate, type LocalDate } from '@/lib/time';
import { wouldCreateCycle } from '@/engine/dependencies';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function firstIssue(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: Array<{ message: string; path: (string | number)[] }> }).issues;
    if (issues.length) return issues[0].message;
  }
  return err instanceof Error ? err.message : '資料格式不正確';
}

/* ---------------------------------- Settings ---------------------------------- */

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('default');
  if (existing) {
    const full = normalizeSettings(existing);
    // 舊版本寫入的列缺新欄位（例如 sync）：補齊後寫回，live query 才會拿到完整的設定
    if (settingsNeedsUpgrade(existing as unknown as Record<string, unknown>, full)) {
      const upgraded = { ...full, updatedAt: nowIso() };
      await db.settings.put(upgraded);
      return upgraded;
    }
    return full;
  }
  const fresh = defaultSettings();
  await db.settings.put(fresh);
  return fresh;
}

export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) }, id: 'default' as const, updatedAt: nowIso() };
  const parsed = SettingsSchema.safeParse(next);
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  await db.settings.put(parsed.data);
  return parsed.data;
}

/* ----------------------------------- Tasks ----------------------------------- */

export interface TaskInput {
  title: string;
  description?: string;
  priority?: Priority;
  dueAt?: string;
  plannedDate?: LocalDate;
  estimatedMinutes?: number;
  minimumMinutes?: number;
  minimumOutcome?: string;
  energyRequired?: Energy;
  splittable?: boolean;
  dependencies?: string[];
  isDemo?: boolean;
}

function clean<T extends object>(obj: T): T {
  // 把 undefined / 空字串欄位移除，避免存進 IndexedDB 又讓 Zod optional 失敗
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '' && k !== 'id' && k !== 'title') continue;
    out[k] = v;
  }
  return out as T;
}

export async function createTask(input: TaskInput): Promise<Task> {
  const now = nowIso();
  const candidate = clean({
    id: newId(),
    title: input.title,
    description: input.description,
    status: 'todo' as const,
    priority: input.priority ?? 'P2',
    dueAt: input.dueAt,
    plannedDate: input.plannedDate,
    estimatedMinutes: input.estimatedMinutes ?? 30,
    minimumMinutes: input.minimumMinutes,
    minimumOutcome: input.minimumOutcome,
    energyRequired: input.energyRequired ?? 'medium',
    splittable: input.splittable ?? true,
    dependencies: input.dependencies ?? [],
    deferCount: 0,
    isDemo: input.isDemo,
    createdAt: now,
    updatedAt: now,
  });
  const parsed = TaskSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  if (parsed.data.dependencies.length) {
    const all = await db.tasks.toArray();
    if (wouldCreateCycle(all, parsed.data.id, parsed.data.dependencies)) throw new ValidationError('依賴關係形成循環');
  }
  await db.tasks.add(parsed.data);
  return parsed.data;
}

export async function updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task> {
  const current = await db.tasks.get(id);
  if (!current) throw new ValidationError('找不到這個任務');
  const merged: Record<string, unknown> = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: nowIso() };
  // patch 裡明確給 undefined 代表清空欄位
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
  const parsed = TaskSchema.safeParse(clean(merged));
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  if (patch.dependencies) {
    const all = await db.tasks.toArray();
    if (wouldCreateCycle(all, id, parsed.data.dependencies)) throw new ValidationError('依賴關係形成循環');
  }
  await db.tasks.put(parsed.data);
  return parsed.data;
}

export async function deleteTask(id: string): Promise<void> {
  await db.transaction('rw', db.tasks, db.logs, db.workBlocks, async () => {
    await db.tasks.delete(id);
    await db.workBlocks.where('taskId').equals(id).delete();
    const dependents = await db.tasks.filter((t) => t.dependencies.includes(id)).toArray();
    for (const t of dependents) {
      await db.tasks.put({ ...t, dependencies: t.dependencies.filter((d) => d !== id), updatedAt: nowIso() });
    }
    const linked = await db.logs.where('taskId').equals(id).toArray();
    for (const l of linked) {
      const { taskId: _omit, ...rest } = l;
      void _omit;
      await db.logs.put({ ...rest, updatedAt: nowIso() });
    }
  });
}

/** 勾選 / 取消勾選 */
export async function setTaskDone(id: string, done: boolean): Promise<Task> {
  const current = await db.tasks.get(id);
  if (!current) throw new ValidationError('找不到這個任務');
  if (done) {
    const minutes = await loggedMinutesForTask(id);
    const updated = await updateTask(id, {
      status: 'done',
      completedAt: nowIso(),
      actualMinutes: minutes > 0 ? Math.round(minutes) : current.actualMinutes,
    });
    // 還沒做的排程區塊一併結束，之後重排不會再安排它
    const blocks = await db.workBlocks.where('taskId').equals(id).toArray();
    for (const b of blocks) {
      if (b.status === 'planned' || b.status === 'active') await db.workBlocks.put({ ...b, status: 'done', endedAt: nowIso(), updatedAt: nowIso() });
    }
    return updated;
  }
  return updateTask(id, { status: 'todo', completedAt: undefined });
}

/** 延後到某天（規則 8：記錄延後次數） */
export async function deferTask(id: string, toDate: LocalDate): Promise<Task> {
  const current = await db.tasks.get(id);
  if (!current) throw new ValidationError('找不到這個任務');
  return updateTask(id, {
    plannedDate: toDate,
    status: current.status === 'in_progress' ? 'in_progress' : 'todo',
    deferCount: current.deferCount + 1,
    lastDeferredAt: nowIso(),
  });
}

export async function cancelTask(id: string): Promise<Task> {
  return updateTask(id, { status: 'cancelled' });
}

export async function loggedMinutesForTask(taskId: string): Promise<number> {
  const logs = await db.logs.where('taskId').equals(taskId).toArray();
  return logs.reduce((sum, l) => {
    if (!l.endAt) return sum;
    return sum + (new Date(l.endAt).getTime() - new Date(l.startAt).getTime()) / 60_000;
  }, 0);
}

/* ----------------------------------- Events ----------------------------------- */

export interface EventInput {
  title: string;
  kind?: CalendarEvent['kind'];
  location?: string;
  note?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  recurrence?: { byWeekday: number[]; until?: LocalDate };
  isDemo?: boolean;
}

export async function createEvent(input: EventInput): Promise<CalendarEvent> {
  const now = nowIso();
  const candidate = clean({
    id: newId(),
    title: input.title,
    kind: input.kind ?? 'other',
    location: input.location,
    note: input.note,
    startAt: input.startAt,
    endAt: input.endAt,
    allDay: input.allDay,
    recurrence: input.recurrence
      ? clean({ freq: 'weekly' as const, byWeekday: input.recurrence.byWeekday, until: input.recurrence.until, exceptions: [] })
      : undefined,
    isDemo: input.isDemo,
    createdAt: now,
    updatedAt: now,
  });
  const parsed = CalendarEventSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  await db.events.add(parsed.data);
  return parsed.data;
}

export async function updateEvent(id: string, patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt'>>): Promise<CalendarEvent> {
  const current = await db.events.get(id);
  if (!current) throw new ValidationError('找不到這個行程');
  const merged: Record<string, unknown> = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: nowIso() };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
  const parsed = CalendarEventSchema.safeParse(clean(merged));
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  await db.events.put(parsed.data);
  return parsed.data;
}

export async function deleteEvent(id: string): Promise<void> {
  await db.events.delete(id);
}

/** 只刪除重複行程的某一次 */
export async function addEventException(id: string, date: LocalDate): Promise<CalendarEvent> {
  const current = await db.events.get(id);
  if (!current?.recurrence) throw new ValidationError('這不是重複行程');
  const exceptions = Array.from(new Set([...current.recurrence.exceptions, date]));
  return updateEvent(id, { recurrence: { ...current.recurrence, exceptions } });
}

/* ------------------------------------ Logs ------------------------------------ */

export interface LogInput {
  title: string;
  category?: LogCategory;
  startAt: string;
  endAt?: string;
  taskId?: string;
  eventId?: string;
  note?: string;
  isDemo?: boolean;
}

export async function createLog(input: LogInput, tz: string): Promise<ActivityLog> {
  const now = nowIso();
  const candidate = clean({
    id: newId(),
    date: toLocalDate(input.startAt, tz),
    title: input.title,
    category: input.category ?? (input.taskId ? 'task' : 'other'),
    startAt: input.startAt,
    endAt: input.endAt,
    taskId: input.taskId,
    eventId: input.eventId,
    note: input.note,
    isDemo: input.isDemo,
    createdAt: now,
    updatedAt: now,
  });
  const parsed = ActivityLogSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  await db.logs.add(parsed.data);
  return parsed.data;
}

export async function updateLog(id: string, patch: Partial<Omit<ActivityLog, 'id' | 'createdAt'>>, tz: string): Promise<ActivityLog> {
  const current = await db.logs.get(id);
  if (!current) throw new ValidationError('找不到這筆紀錄');
  const merged: Record<string, unknown> = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: nowIso() };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
  if (typeof merged.startAt === 'string') merged.date = toLocalDate(merged.startAt, tz);
  const parsed = ActivityLogSchema.safeParse(clean(merged));
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  await db.logs.put(parsed.data);
  return parsed.data;
}

export async function deleteLog(id: string): Promise<void> {
  await db.logs.delete(id);
}

export async function getRunningLog(): Promise<ActivityLog | undefined> {
  return db.logs.filter((l) => !l.endAt).first();
}

/** 開始一筆「現在進行中」的紀錄；同時結束任何正在進行的紀錄 */
export async function startLog(input: Omit<LogInput, 'startAt' | 'endAt'>, tz: string): Promise<ActivityLog> {
  const now = nowIso();
  return db.transaction('rw', db.logs, db.tasks, async () => {
    const running = await getRunningLog();
    if (running) await stopLog(running.id, now, tz);
    const created = await createLog({ ...input, startAt: now }, tz);
    if (input.taskId) {
      const t = await db.tasks.get(input.taskId);
      if (t && t.status === 'todo') await db.tasks.put({ ...t, status: 'in_progress', updatedAt: now });
    }
    return created;
  });
}

/** 結束一筆紀錄；若綁定任務，累計實際工時 */
export async function stopLog(id: string, endAt: string = nowIso(), tz?: string): Promise<ActivityLog> {
  const current = await db.logs.get(id);
  if (!current) throw new ValidationError('找不到這筆紀錄');
  // 紀錄至少 1 分鐘，避免 0 分鐘的空紀錄
  const safeEnd = new Date(endAt).getTime() - new Date(current.startAt).getTime() < 60_000
    ? new Date(new Date(current.startAt).getTime() + 60_000).toISOString()
    : endAt;
  const updated = await updateLog(id, { endAt: safeEnd }, tz ?? 'Asia/Taipei');
  if (updated.taskId) {
    const minutes = await loggedMinutesForTask(updated.taskId);
    const t = await db.tasks.get(updated.taskId);
    if (t) await db.tasks.put({ ...t, actualMinutes: Math.round(minutes), updatedAt: nowIso() });
  }
  return updated;
}

/* ---------------------------------- DailyState ---------------------------------- */

export async function setDailyState(date: LocalDate, patch: Partial<Omit<DailyState, 'date' | 'updatedAt'>>): Promise<DailyState> {
  const current = (await db.dailyStates.get(date)) ?? { date, updatedAt: nowIso() };
  const parsed = DailyStateSchema.safeParse(clean({ ...current, ...patch, date, updatedAt: nowIso() }));
  if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
  await db.dailyStates.put(parsed.data);
  return parsed.data;
}

/* ------------------------------------ Demo ------------------------------------ */

/** 一鍵刪除示範資料。settings.demoDataLoaded 保持 true，代表「已經示範過」，之後不會再自動載入 */
export async function deleteDemoData(): Promise<void> {
  await db.transaction('rw', db.tasks, db.events, db.logs, async () => {
    await db.tasks.filter((t) => Boolean(t.isDemo)).delete();
    await db.events.filter((e) => Boolean(e.isDemo)).delete();
    await db.logs.filter((l) => Boolean(l.isDemo)).delete();
  });
}

/** 這台裝置沒有自己的資料（舊版留下的示範資料不算）；歡迎畫面與「登入既有帳號時以雲端為準」用 */
export async function hasNoOwnData(): Promise<boolean> {
  const [tasks, events, logs] = await Promise.all([
    db.tasks.filter((t) => !t.isDemo).count(),
    db.events.filter((e) => !e.isDemo).count(),
    db.logs.filter((l) => !l.isDemo).count(),
  ]);
  return tasks + events + logs === 0;
}

export async function clearAllData(): Promise<void> {
  // 清空本機不應被當成「刪除」傳到雲端；用 ignoreTransaction 外的旗標由 sync engine 控制
  const { withoutSyncTracking } = await import('@/sync/engine');
  await withoutSyncTracking(async () => {
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
  });
}

export async function countAll(): Promise<{ tasks: number; events: number; logs: number }> {
  const [tasks, events, logs] = await Promise.all([db.tasks.count(), db.events.count(), db.logs.count()]);
  return { tasks, events, logs };
}
