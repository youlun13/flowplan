/**
 * ParsedIncident（模型或規則的輸出）→ Incident（規則引擎能吃的事件）。
 * 這裡是「AI 不能幻覺」的防線：任務 id 必須真的存在且未完成，時間必須合法。
 */
import type { ParsedIncident } from './types';
import type { Task } from '@/db/schema';
import type { Incident } from '@/engine/planner';
import { ValidationError } from '@/db/repo';
import { isOpen } from '@/lib/select';
import { localDateTimeToMs, toLocalDate, toLocalTime } from '@/lib/time';

export interface ToIncidentContext {
  nowMs: number;
  tz: string;
  tasks: Task[];
}

export function parsedToIncident(p: ParsedIncident, ctx: ToIncidentContext): Incident {
  const today = toLocalDate(ctx.nowMs, ctx.tz);
  const nowTime = toLocalTime(ctx.nowMs, ctx.tz);
  switch (p.type) {
    case 'overslept':
      return { type: 'overslept', wakeTime: p.wakeTime ?? nowTime };
    case 'lost_time': {
      if (!p.endTime) throw new ValidationError('還不知道臨時的事到幾點結束');
      const startMs = localDateTimeToMs(today, p.startTime ?? nowTime, ctx.tz);
      let endMs = localDateTimeToMs(today, p.endTime, ctx.tz);
      if (endMs <= startMs) endMs += 24 * 3_600_000;
      if (endMs - startMs > 24 * 3_600_000) throw new ValidationError('臨時行程的時間不合理');
      return { type: 'lost_time', startMs, endMs, title: p.title?.trim() || undefined };
    }
    case 'energy':
      if (!p.energy) throw new ValidationError('沒有說明精力是高、中還是低');
      return { type: 'energy', energy: p.energy };
    case 'task_done': {
      const task = requireTask(p.taskId, ctx.tasks);
      return { type: 'task_done', taskId: task.id };
    }
    case 'overrun': {
      const task = requireTask(p.taskId, ctx.tasks);
      return { type: 'overrun', taskId: task.id, remainingMinutes: p.remainingMinutes ?? 30 };
    }
    case 'rest':
      return { type: 'rest', minutes: p.minutes ?? 20 };
    case 'replan':
      return { type: 'replan' };
    default:
      throw new ValidationError('無法判斷這是什麼狀況，請用下方表單選擇');
  }
}

function requireTask(taskId: string | undefined, tasks: Task[]): Task {
  if (!taskId) throw new ValidationError('沒有對到是哪一個任務');
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new ValidationError('指到的任務不存在，已拒絕這個結果');
  if (!isOpen(task)) throw new ValidationError(`「${task.title}」已經完成或取消，不能再套用`);
  return task;
}
