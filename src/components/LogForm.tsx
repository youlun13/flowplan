import { useEffect, useMemo, useState } from 'react';
import { Button, Confirm, ErrorText, Field, Input, Select, Sheet, Textarea } from './ui';
import { LOG_CATEGORY_LABEL, type ActivityLog, type LogCategory } from '@/db/schema';
import { createLog, deleteLog, updateLog, ValidationError } from '@/db/repo';
import { useOccurrences, useTasks } from '@/hooks/useData';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { isOpen } from '@/lib/select';
import { localDateTimeToIso, minutesToTime, timeToMinutes, toLocalDate, toLocalTime, type LocalDate } from '@/lib/time';

export interface LogFormProps {
  open: boolean;
  onClose: () => void;
  log?: ActivityLog;
  defaultDate?: LocalDate;
  defaultStart?: string;
  defaultEnd?: string;
}

interface Draft {
  title: string;
  category: LogCategory;
  date: string;
  start: string;
  end: string;
  taskId: string;
  note: string;
}

export function LogForm({ open, onClose, log, defaultDate, defaultStart, defaultEnd }: LogFormProps) {
  const settings = useSettings();
  const tz = settings.timeZone;
  const toast = useToast();
  const tasks = useTasks();
  const nowDate = toLocalDate(Date.now(), tz);
  const date = log ? toLocalDate(log.startAt, tz) : (defaultDate ?? nowDate);
  const occurrences = useOccurrences(date, date, tz);

  const build = (): Draft => {
    if (log) {
      return {
        title: log.title,
        category: log.category,
        date,
        start: toLocalTime(log.startAt, tz),
        end: log.endAt ? toLocalTime(log.endAt, tz) : toLocalTime(Date.now(), tz),
        taskId: log.taskId ?? '',
        note: log.note ?? '',
      };
    }
    const start = defaultStart ?? minutesToTime(Math.floor(timeToMinutes(toLocalTime(Date.now(), tz)) / 5) * 5 - 30);
    return { title: '', category: 'other', date, start, end: defaultEnd ?? minutesToTime(timeToMinutes(start) + 30), taskId: '', note: '' };
  };

  const [draft, setDraft] = useState<Draft>(build);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(build());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, log, defaultDate, defaultStart, defaultEnd]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const suggestions = useMemo(() => {
    const titles = new Set<string>();
    for (const o of occurrences) titles.add(o.title);
    for (const t of tasks) if (isOpen(t) && (t.plannedDate === date || !t.plannedDate)) titles.add(t.title);
    return Array.from(titles);
  }, [occurrences, tasks, date]);

  const openTasks = useMemo(() => tasks.filter((t) => isOpen(t) || t.id === draft.taskId), [tasks, draft.taskId]);

  async function submit() {
    setError(null);
    try {
      if (!draft.date || !draft.start || !draft.end) throw new ValidationError('請填寫日期與時間');
      const startAt = localDateTimeToIso(draft.date, draft.start, tz);
      const endDate = timeToMinutes(draft.end) <= timeToMinutes(draft.start) ? nextDay(draft.date) : draft.date;
      const endAt = localDateTimeToIso(endDate, draft.end, tz);
      const payload = {
        title: draft.title,
        category: draft.taskId && draft.category === 'other' ? ('task' as const) : draft.category,
        startAt,
        endAt,
        taskId: draft.taskId || undefined,
        note: draft.note || undefined,
      };
      if (log) {
        await updateLog(log.id, payload, tz);
        toast.show('已更新紀錄');
      } else {
        await createLog(payload, tz);
        toast.show('已補登紀錄');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    }
  }

  async function remove() {
    if (!log) return;
    await deleteLog(log.id);
    setConfirmDelete(false);
    toast.show('已刪除紀錄');
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={log ? '編輯紀錄' : '補登紀錄'}
      footer={
        <div className="flex items-center gap-2">
          {log && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              刪除
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={!draft.title.trim()}>
            {log ? '儲存' : '補登'}
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
        <Field label="做了什麼">
          <Input autoFocus list="log-title-suggestions" value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="例：寫線代習題" />
          <datalist id="log-title-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="分類">
            <Select value={draft.category} onChange={(e) => set('category', e.target.value as LogCategory)}>
              {(Object.keys(LOG_CATEGORY_LABEL) as LogCategory[]).map((c) => (
                <option key={c} value={c}>
                  {LOG_CATEGORY_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="日期">
            <Input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="從">
            <Input type="time" value={draft.start} onChange={(e) => set('start', e.target.value)} />
          </Field>
          <Field label="到" hint={timeToMinutes(draft.end) <= timeToMinutes(draft.start) ? '跨到隔天' : undefined}>
            <Input type="time" value={draft.end} onChange={(e) => set('end', e.target.value)} />
          </Field>
        </div>
        <Field label="對應的任務（選填）" hint="綁定後會自動累計到任務的實際工時">
          <Select value={draft.taskId} onChange={(e) => set('taskId', e.target.value)}>
            <option value="">不綁定</option>
            {openTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="備註">
          <Textarea value={draft.note} onChange={(e) => set('note', e.target.value)} rows={2} />
        </Field>
      </form>
      <Confirm open={confirmDelete} title="刪除這筆紀錄？" confirmLabel="刪除" danger onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
    </Sheet>
  );
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
