/**
 * 最終衝突驗證（規則 1 的最後一道鎖）。
 * 不論方案來自規則引擎、使用者手動調整或（第三階段）AI，套用前都必須通過這裡。
 */
import type { Task } from '@/db/schema';
import type { AvailabilityResult } from './availability';
import { overlaps, type Interval } from './intervals';
import { formatTime } from '@/lib/time';

export interface ValidatableBlock {
  taskId: string;
  startMs: number;
  endMs: number;
  isMinimum: boolean;
}

export interface ValidationContext {
  nowMs: number;
  tz: string;
  tasks: Task[];
  availability: AvailabilityResult;
  /** 允許區塊開始時間比 now 早多少（進行中的區塊）；預設 0 */
  pastToleranceMs?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateBlocks(blocks: ValidatableBlock[], ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const tolerance = ctx.pastToleranceMs ?? 0;

  for (const b of blocks) {
    const task = byId.get(b.taskId);
    if (!task) {
      errors.push(`區塊指向不存在的任務（${b.taskId}）`);
      continue;
    }
    if (task.status === 'done' || task.status === 'cancelled') errors.push(`「${task.title}」已${task.status === 'done' ? '完成' : '取消'}，不能再安排`);
    if (!(Number.isFinite(b.startMs) && Number.isFinite(b.endMs)) || b.endMs <= b.startMs) {
      errors.push(`「${task.title}」的區塊時間不合法`);
      continue;
    }
    if (b.startMs < ctx.nowMs - tolerance) errors.push(`「${task.title}」被排在已經過去的時間（${formatTime(b.startMs, ctx.tz)}）`);
    if (b.isMinimum && !task.minimumMinutes) errors.push(`「${task.title}」沒有設定最低工時，不能標記為最低版本`);
    const hits = [...ctx.availability.busyPadded, ...ctx.availability.sleepWindows].filter((h) => overlaps(h, { start: b.startMs, end: b.endMs }));
    if (hits.length) errors.push(`「${task.title}」${formatTime(b.startMs, ctx.tz)}–${formatTime(b.endMs, ctx.tz)} 與固定行程 / 睡眠時段重疊`);
    const ww = ctx.availability.workWindow;
    if (b.startMs < ww.start || b.endMs > ww.end) errors.push(`「${task.title}」超出可工作時段`);
    if (task.dueAt) {
      const due = new Date(task.dueAt).getTime();
      if (b.endMs > due && due > ctx.nowMs) errors.push(`「${task.title}」的區塊結束於截止時間之後`);
    }
  }

  // 區塊之間不得重疊
  const sorted = blocks.slice().sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (overlaps({ start: a.startMs, end: a.endMs }, { start: b.startMs, end: b.endMs })) {
      errors.push(`兩個區塊互相重疊（${formatTime(a.startMs, ctx.tz)} 與 ${formatTime(b.startMs, ctx.tz)}）`);
    }
  }

  // 依賴順序：前置未完成時，前置的所有區塊必須在後續區塊之前結束
  const lastEnd = new Map<string, number>();
  const firstStart = new Map<string, number>();
  for (const b of blocks) {
    lastEnd.set(b.taskId, Math.max(lastEnd.get(b.taskId) ?? 0, b.endMs));
    firstStart.set(b.taskId, Math.min(firstStart.get(b.taskId) ?? Number.POSITIVE_INFINITY, b.startMs));
  }
  for (const b of blocks) {
    const task = byId.get(b.taskId);
    if (!task) continue;
    for (const depId of task.dependencies) {
      const dep = byId.get(depId);
      if (!dep || dep.status === 'done' || dep.status === 'cancelled') continue;
      const depEnd = lastEnd.get(depId);
      if (depEnd === undefined) {
        errors.push(`「${task.title}」的前置「${dep.title}」尚未完成也未安排`);
      } else if (depEnd > (firstStart.get(b.taskId) ?? 0)) {
        errors.push(`「${task.title}」排在前置「${dep.title}」完成之前`);
      }
    }
  }

  return { ok: errors.length === 0, errors: Array.from(new Set(errors)) };
}

export function intervalOf(b: ValidatableBlock): Interval {
  return { start: b.startMs, end: b.endMs };
}
