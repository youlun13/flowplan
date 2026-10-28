import { Check } from 'lucide-react';
import { Chip, cx } from './ui';
import { PRIORITY_LABEL, type Task } from '@/db/schema';
import { setTaskDone } from '@/db/repo';
import { useToast } from '@/hooks/useToast';
import { dueRisk } from '@/lib/select';
import { formatDateTimeZh, formatDuration, formatLocalDateShort } from '@/lib/time';

export function TaskRow({
  task,
  tz,
  nowMs,
  onOpen,
  showDate,
  compact,
}: {
  task: Task;
  tz: string;
  nowMs: number;
  onOpen: (task: Task) => void;
  showDate?: boolean;
  compact?: boolean;
}) {
  const toast = useToast();
  const done = task.status === 'done';
  const risk = dueRisk(task, nowMs, tz);

  async function toggle() {
    try {
      await setTaskDone(task.id, !done);
      if (!done) {
        toast.show(`完成：${task.title}`, 'info', {
          label: '復原',
          onClick: async () => {
            await setTaskDone(task.id, false);
            toast.show(`已復原：${task.title}`);
          },
        });
      }
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '更新失敗', 'danger');
    }
  }

  return (
    <div className={cx('flex items-start gap-3 py-2.5', !compact && 'border-b border-line last:border-b-0')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? '標記為未完成' : '標記為完成'}
        onClick={toggle}
        className={cx(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
          done ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface',
        )}
      >
        {done && <Check size={14} strokeWidth={3} />}
      </button>
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <div className={cx('text-[15px] leading-snug', done && 'text-done line-through')}>{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Chip tone={task.priority === 'P1' ? 'danger' : task.priority === 'P2' ? 'warn' : 'neutral'}>{PRIORITY_LABEL[task.priority]}</Chip>
          <Chip>{formatDuration(task.estimatedMinutes)}</Chip>
          {task.status === 'in_progress' && <Chip tone="accent">進行中</Chip>}
          {task.dueAt && (
            <Chip tone={risk === 'overdue' ? 'danger' : risk === 'today' || risk === 'soon' ? 'warn' : 'neutral'}>
              {risk === 'overdue' ? '逾期 ' : '截止 '}
              {formatDateTimeZh(task.dueAt, tz)}
            </Chip>
          )}
          {showDate && task.plannedDate && <Chip>{formatLocalDateShort(task.plannedDate)}</Chip>}
          {task.deferCount >= 2 && <Chip tone="warn">延後 {task.deferCount} 次</Chip>}
          {task.dependencies.length > 0 && <Chip>有前置</Chip>}
        </div>
      </button>
    </div>
  );
}
