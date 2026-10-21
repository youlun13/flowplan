import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button, Confirm, ErrorText, Field, Input, Segmented, Sheet, Textarea, Toggle, cx } from './ui';
import { ENERGY_LABEL, PRIORITY_LABEL, type Energy, type Priority, type Task } from '@/db/schema';
import { createTask, deleteTask, updateTask, ValidationError } from '@/db/repo';
import { useTasks } from '@/hooks/useData';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { wouldCreateCycle } from '@/engine/dependencies';
import { calibratedMinutes, calibration } from '@/engine/stats';
import { isOpen } from '@/lib/select';
import { addLocalDays, localDateTimeToIso, todayLocal, toLocalDate, toLocalTime, type LocalDate } from '@/lib/time';

const EST_PRESETS = [15, 30, 45, 60, 90, 120];

export interface TaskFormProps {
  open: boolean;
  onClose: () => void;
  /** 編輯模式 */
  task?: Task;
  /** 新增模式的預設日期 */
  defaultDate?: LocalDate;
}

interface Draft {
  title: string;
  plannedDate: string;
  priority: Priority;
  estimatedMinutes: number;
  dueDate: string;
  dueTime: string;
  energyRequired: Energy;
  splittable: boolean;
  minimumMinutes: string;
  minimumOutcome: string;
  description: string;
  dependencies: string[];
}

function toDraft(task: Task | undefined, tz: string, defaultDate: LocalDate | undefined): Draft {
  return {
    title: task?.title ?? '',
    plannedDate: task?.plannedDate ?? defaultDate ?? '',
    priority: task?.priority ?? 'P2',
    estimatedMinutes: task?.estimatedMinutes ?? 30,
    dueDate: task?.dueAt ? toLocalDate(task.dueAt, tz) : '',
    dueTime: task?.dueAt ? toLocalTime(task.dueAt, tz) : '23:59',
    energyRequired: task?.energyRequired ?? 'medium',
    splittable: task?.splittable ?? true,
    minimumMinutes: task?.minimumMinutes ? String(task.minimumMinutes) : '',
    minimumOutcome: task?.minimumOutcome ?? '',
    description: task?.description ?? '',
    dependencies: task?.dependencies ?? [],
  };
}

export function TaskForm({ open, onClose, task, defaultDate }: TaskFormProps) {
  const settings = useSettings();
  const tz = settings.timeZone;
  const tasks = useTasks();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => toDraft(task, tz, defaultDate));
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(toDraft(task, tz, defaultDate));
      setAdvanced(Boolean(task && (task.dueAt || task.minimumOutcome || task.description || task.dependencies.length)));
      setError(null);
    }
  }, [open, task, tz, defaultDate]);

  const today = todayLocal(tz);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const cal = useMemo(() => calibration(tasks), [tasks]);
  const calHint = useMemo(() => {
    const c = calibratedMinutes(draft.estimatedMinutes, draft.energyRequired, cal);
    if (c.basis === 'none' || Math.abs(c.factor - 1) < 0.1) return null;
    return `你過去${c.basis === 'energy' ? ENERGY_LABEL[draft.energyRequired] + '任務' : ''}實際約是預估的 ${c.factor} 倍，規劃時會以 ${c.minutes} 分計`;
  }, [draft.estimatedMinutes, draft.energyRequired, cal]);

  const dependencyOptions = useMemo(
    () =>
      tasks
        .filter((t) => t.id !== task?.id && isOpen(t))
        .filter((t) => !task || !wouldCreateCycle(tasks, task.id, [t.id]))
        .sort((a, b) => (a.plannedDate ?? '9999').localeCompare(b.plannedDate ?? '9999')),
    [tasks, task],
  );

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      const dueAt = draft.dueDate ? localDateTimeToIso(draft.dueDate, draft.dueTime || '23:59', tz) : undefined;
      const minimumMinutes = draft.minimumMinutes ? Number(draft.minimumMinutes) : undefined;
      if (minimumMinutes !== undefined && minimumMinutes > draft.estimatedMinutes) {
        throw new ValidationError('最低工時不能大於預估工時');
      }
      const payload = {
        title: draft.title,
        description: draft.description || undefined,
        priority: draft.priority,
        dueAt,
        plannedDate: draft.plannedDate || undefined,
        estimatedMinutes: draft.estimatedMinutes,
        minimumMinutes,
        minimumOutcome: draft.minimumOutcome || undefined,
        energyRequired: draft.energyRequired,
        splittable: draft.splittable,
        dependencies: draft.dependencies,
      };
      if (task) {
        await updateTask(task.id, payload);
        toast.show('已更新任務');
      } else {
        await createTask(payload);
        toast.show('已新增任務');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!task) return;
    await deleteTask(task.id);
    setConfirmDelete(false);
    toast.show('已刪除任務');
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={task ? '編輯任務' : '新增任務'}
      footer={
        <div className="flex items-center gap-2">
          {task && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              刪除
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || !draft.title.trim()}>
            {task ? '儲存' : '新增'}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ErrorText>{error}</ErrorText>

        <Field label="任務">
          <Input autoFocus value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="例：複習線代第 3 章" enterKeyHint="done" />
        </Field>

        <Field label="哪天做">
          <div className="flex gap-2">
            <Input type="date" value={draft.plannedDate} onChange={(e) => set('plannedDate', e.target.value)} className="flex-1" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              { label: '今天', value: today },
              { label: '明天', value: addLocalDays(today, 1) },
              { label: '不指定', value: '' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => set('plannedDate', o.value)}
                className={cx('rounded-md px-2.5 py-1 text-sm', draft.plannedDate === o.value ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="優先級">
            <Segmented
              value={draft.priority}
              onChange={(v) => set('priority', v)}
              className="w-full"
              options={(['P1', 'P2', 'P3'] as Priority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            />
          </Field>
          <Field label="預估（分鐘）">
            <Input type="number" inputMode="numeric" min={5} max={1440} step={5} value={draft.estimatedMinutes} onChange={(e) => set('estimatedMinutes', Number(e.target.value))} />
          </Field>
        </div>
        {calHint && <p className="-mt-2 text-xs text-muted">{calHint}</p>}
        <div className="-mt-2 flex flex-wrap gap-1.5">
          {EST_PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set('estimatedMinutes', m)}
              className={cx('rounded-md px-2.5 py-1 text-sm tnum', draft.estimatedMinutes === m ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}
            >
              {m}
            </button>
          ))}
        </div>

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex w-full items-center justify-between py-1 text-sm text-muted">
          <span>進階：截止、精力、最低成果、依賴</span>
          {advanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {advanced && (
          <div className="space-y-4 rounded-xl bg-surface-2/60 p-3">
            <Field label="截止時間" hint="真正的死線；系統用它判斷緊迫度">
              <div className="flex gap-2">
                <Input type="date" value={draft.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="flex-1" />
                <Input type="time" value={draft.dueTime} onChange={(e) => set('dueTime', e.target.value)} className="w-32" disabled={!draft.dueDate} />
              </div>
            </Field>

            <Field label="需要的精力">
              <Segmented
                value={draft.energyRequired}
                onChange={(v) => set('energyRequired', v)}
                className="w-full"
                options={(['high', 'medium', 'low'] as Energy[]).map((e) => ({ value: e, label: ENERGY_LABEL[e].replace('精力', '') }))}
              />
            </Field>

            <Toggle checked={draft.splittable} onChange={(v) => set('splittable', v)} label="可以拆成多段做" />

            <div className="grid grid-cols-[7rem_1fr] gap-3">
              <Field label="最低工時">
                <Input type="number" inputMode="numeric" min={5} step={5} value={draft.minimumMinutes} onChange={(e) => set('minimumMinutes', e.target.value)} placeholder="分鐘" />
              </Field>
              <Field label="最低可接受成果">
                <Input value={draft.minimumOutcome} onChange={(e) => set('minimumOutcome', e.target.value)} placeholder="例：做完前 5 題" />
              </Field>
            </div>

            <Field label="說明">
              <Textarea value={draft.description} onChange={(e) => set('description', e.target.value)} rows={3} />
            </Field>

            {dependencyOptions.length > 0 && (
              <Field label="要先完成的任務">
                <div className="max-h-44 overflow-y-auto rounded-lg border border-line bg-surface">
                  {dependencyOptions.map((t) => {
                    const checked = draft.dependencies.includes(t.id);
                    return (
                      <label key={t.id} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-[var(--accent)]"
                          checked={checked}
                          onChange={(e) => set('dependencies', e.target.checked ? [...draft.dependencies, t.id] : draft.dependencies.filter((d) => d !== t.id))}
                        />
                        <span className="min-w-0 flex-1 truncate text-[15px]">{t.title}</span>
                        {t.plannedDate && <span className="text-xs text-muted tnum">{t.plannedDate.slice(5).replace('-', '/')}</span>}
                      </label>
                    );
                  })}
                </div>
              </Field>
            )}
          </div>
        )}
      </form>

      <Confirm open={confirmDelete} title="刪除這個任務？" message="刪除後無法復原。" confirmLabel="刪除" danger onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
    </Sheet>
  );
}
