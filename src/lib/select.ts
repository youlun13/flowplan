/**
 * 純函數的查詢 / 排序 / 分組，供各頁面共用。資料量小，一律在記憶體操作。
 */
import type { Priority, Task } from '@/db/schema';
import { compareLocalDate, toLocalDate, type LocalDate } from './time';

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

export function isOpen(t: Task): boolean {
  return t.status === 'todo' || t.status === 'in_progress' || t.status === 'deferred';
}

export function isDone(t: Task): boolean {
  return t.status === 'done';
}

/** 屬於某一天的任務：排在那天，或沒排日期但截止在那天 */
export function tasksForDate(tasks: Task[], date: LocalDate, tz: string): Task[] {
  return tasks.filter((t) => {
    if (t.status === 'cancelled') return false;
    if (t.plannedDate) return t.plannedDate === date;
    if (t.dueAt) return toLocalDate(t.dueAt, tz) === date;
    return false;
  });
}

export function completionForDate(tasks: Task[], date: LocalDate, tz: string): { done: number; total: number; ratio: number } {
  const list = tasksForDate(tasks, date, tz);
  const done = list.filter(isDone).length;
  return { done, total: list.length, ratio: list.length ? done / list.length : 0 };
}

/** 逾期：排程日已過、或截止時間已過，且尚未完成 */
export function overdueTasks(tasks: Task[], today: LocalDate, nowMs: number): Task[] {
  return tasks.filter((t) => {
    if (!isOpen(t)) return false;
    const plannedPast = Boolean(t.plannedDate && compareLocalDate(t.plannedDate, today) < 0);
    const duePast = Boolean(t.dueAt && new Date(t.dueAt).getTime() < nowMs);
    return plannedPast || duePast;
  });
}

export function unscheduledTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => isOpen(t) && !t.plannedDate && !t.dueAt);
}

export type DueRisk = 'overdue' | 'today' | 'soon' | 'later' | 'none';

export function dueRisk(t: Task, nowMs: number, tz: string): DueRisk {
  if (!t.dueAt) return 'none';
  const due = new Date(t.dueAt).getTime();
  if (due < nowMs) return 'overdue';
  if (toLocalDate(due, tz) === toLocalDate(nowMs, tz)) return 'today';
  if (due - nowMs <= 48 * 3_600_000) return 'soon';
  return 'later';
}

export type SortKey = 'due' | 'priority' | 'date';

export function sortTasks(tasks: Task[], by: SortKey): Task[] {
  const dueMs = (t: Task) => (t.dueAt ? new Date(t.dueAt).getTime() : Number.POSITIVE_INFINITY);
  const dateKey = (t: Task) => t.plannedDate ?? '9999-99-99';
  const cmpPriority = (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  const cmpDue = (a: Task, b: Task) => dueMs(a) - dueMs(b);
  const cmpDate = (a: Task, b: Task) => compareLocalDate(dateKey(a), dateKey(b));
  const chain = (fns: Array<(a: Task, b: Task) => number>) => (a: Task, b: Task) => {
    for (const f of fns) {
      const r = f(a, b);
      if (r !== 0) return r;
    }
    return a.createdAt.localeCompare(b.createdAt);
  };
  const cmp =
    by === 'due' ? chain([cmpDue, cmpPriority, cmpDate]) : by === 'priority' ? chain([cmpPriority, cmpDue, cmpDate]) : chain([cmpDate, cmpPriority, cmpDue]);
  return tasks.slice().sort(cmp);
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

/** 任務頁的分組：逾期 / 今天 / 明天 / 之後 / 未排日期 / 已完成 */
export function groupTasks(tasks: Task[], today: LocalDate, nowMs: number, tz: string): TaskGroup[] {
  const tomorrow = addDays(today, 1);
  const groups: Record<string, Task[]> = { overdue: [], today: [], tomorrow: [], later: [], unscheduled: [], done: [] };
  const overdueIds = new Set(overdueTasks(tasks, today, nowMs).map((t) => t.id));
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
    if (isDone(t)) groups.done.push(t);
    else if (overdueIds.has(t.id)) groups.overdue.push(t);
    else {
      const date = t.plannedDate ?? (t.dueAt ? toLocalDate(t.dueAt, tz) : undefined);
      if (!date) groups.unscheduled.push(t);
      else if (date === today) groups.today.push(t);
      else if (date === tomorrow) groups.tomorrow.push(t);
      else groups.later.push(t);
    }
  }
  const labels: Record<string, string> = {
    overdue: '逾期未處理',
    today: '今天',
    tomorrow: '明天',
    later: '之後',
    unscheduled: '未排日期',
    done: '已完成',
  };
  return Object.entries(groups)
    .filter(([, list]) => list.length > 0)
    .map(([key, list]) => ({ key, label: labels[key], tasks: list }));
}

function addDays(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function matchesSearch(t: Task, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return t.title.toLowerCase().includes(s) || (t.description ?? '').toLowerCase().includes(s) || (t.minimumOutcome ?? '').toLowerCase().includes(s);
}
