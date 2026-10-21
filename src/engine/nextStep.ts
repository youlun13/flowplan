/**
 * 「下一步做什麼」—— 第一階段簡易版。
 *
 * 只做可解釋的硬排序，不做時段安排；第二階段的完整規則引擎會取代這裡的評分，
 * 但輸出格式（task + reasonCodes + warning）會保留。
 */
import type { Energy, Task } from '@/db/schema';
import { unmetDependencies } from './dependencies';
import { dueRisk, isOpen } from '@/lib/select';
import { compareLocalDate, toLocalDate } from '@/lib/time';

export interface NextStep {
  task: Task;
  reasonCodes: string[];
  reason: string;
  warning?: string;
}

const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 } as const;
const ENERGY_RANK = { high: 2, medium: 1, low: 0 } as const;

export function pickNextStep(tasks: Task[], nowMs: number, tz: string, energy?: Energy): NextStep | null {
  const today = toLocalDate(nowMs, tz);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const candidates = tasks.filter((t) => {
    if (!isOpen(t)) return false;
    if (unmetDependencies(t, byId).length > 0) return false;
    const risk = dueRisk(t, nowMs, tz);
    const plannedTodayOrPast = Boolean(t.plannedDate && compareLocalDate(t.plannedDate, today) <= 0);
    return t.status === 'in_progress' || plannedTodayOrPast || risk === 'overdue' || risk === 'today' || risk === 'soon';
  });
  if (candidates.length === 0) return null;

  const riskRank = (t: Task) => {
    const r = dueRisk(t, nowMs, tz);
    return r === 'overdue' ? 0 : r === 'today' ? 1 : r === 'soon' ? 2 : 3;
  };

  candidates.sort((a, b) => {
    // 規則 7：已在進行中的先做完
    if ((a.status === 'in_progress') !== (b.status === 'in_progress')) return a.status === 'in_progress' ? -1 : 1;
    // 規則 2：截止風險
    const r = riskRank(a) - riskRank(b);
    if (r !== 0) return r;
    // 規則 3：優先級
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    // 規則 4：精力匹配（同級時才用）
    if (energy) {
      const fit = (t: Task) => Math.abs(ENERGY_RANK[t.energyRequired] - ENERGY_RANK[energy]);
      const e = fit(a) - fit(b);
      if (e !== 0) return e;
    }
    // 規則 8：被延後越多次越先
    const d = b.deferCount - a.deferCount;
    if (d !== 0) return d;
    return (a.plannedDate ?? '9999').localeCompare(b.plannedDate ?? '9999');
  });

  const task = candidates[0];
  const reasonCodes: string[] = [];
  const parts: string[] = [];
  if (task.status === 'in_progress') {
    reasonCodes.push('IN_PROGRESS');
    parts.push('已經在進行中，先把它做完再切換');
  }
  const risk = dueRisk(task, nowMs, tz);
  if (risk === 'overdue') {
    reasonCodes.push('OVERDUE');
    parts.push('已經超過截止時間');
  } else if (risk === 'today') {
    reasonCodes.push('DUE_TODAY');
    parts.push('今天截止');
  } else if (risk === 'soon') {
    reasonCodes.push('DUE_SOON');
    parts.push('48 小時內截止');
  }
  if (task.priority === 'P1') {
    reasonCodes.push('P1');
    parts.push('優先級最高');
  }
  if (task.deferCount >= 2) {
    reasonCodes.push('STARVING');
    parts.push(`已被延後 ${task.deferCount} 次`);
  }
  if (parts.length === 0) parts.push('今天的任務裡優先級最高、最早排定');

  let warning: string | undefined;
  if (energy === 'low' && task.energyRequired === 'high') {
    warning = '你現在精力低，但這件事需要高專注；可以先做最低成果版本，或先休息 15 分鐘再開始。';
  }

  return { task, reasonCodes, reason: parts.join('；'), warning };
}
