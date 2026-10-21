import { useEffect, useState } from 'react';
import { Button, Confirm, ErrorText, Field, Input, Segmented, Sheet, Textarea, Toggle, cx } from './ui';
import { EVENT_KIND_LABEL, type CalendarEvent, type EventKind } from '@/db/schema';
import { addEventException, createEvent, deleteEvent, updateEvent, ValidationError } from '@/db/repo';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import type { Occurrence } from '@/engine/recurrence';
import { localDateTimeToIso, localWeekday, minutesToTime, timeToMinutes, toLocalDate, toLocalTime, weekdayLabel, type LocalDate } from '@/lib/time';

export interface EventFormProps {
  open: boolean;
  onClose: () => void;
  /** 編輯模式：原始行程 */
  event?: CalendarEvent;
  /** 若是從某一次重複行程點進來，提供它讓「只刪這一次」可用 */
  occurrence?: Occurrence;
  defaultDate?: LocalDate;
  defaultStart?: string;
}

interface Draft {
  title: string;
  kind: EventKind;
  date: string;
  start: string;
  end: string;
  location: string;
  note: string;
  repeat: boolean;
  byWeekday: number[];
  until: string;
}

function toDraft(ev: CalendarEvent | undefined, tz: string, defaultDate?: LocalDate, defaultStart?: string): Draft {
  if (ev) {
    return {
      title: ev.title,
      kind: ev.kind,
      date: toLocalDate(ev.startAt, tz),
      start: toLocalTime(ev.startAt, tz),
      end: toLocalTime(ev.endAt, tz),
      location: ev.location ?? '',
      note: ev.note ?? '',
      repeat: Boolean(ev.recurrence),
      byWeekday: ev.recurrence?.byWeekday ?? [localWeekday(toLocalDate(ev.startAt, tz))],
      until: ev.recurrence?.until ?? '',
    };
  }
  const date = defaultDate ?? toLocalDate(Date.now(), tz);
  const start = defaultStart ?? '09:00';
  return {
    title: '',
    kind: 'class',
    date,
    start,
    end: minutesToTime(timeToMinutes(start) + 60),
    location: '',
    note: '',
    repeat: false,
    byWeekday: [localWeekday(date)],
    until: '',
  };
}

export function EventForm({ open, onClose, event, occurrence, defaultDate, defaultStart }: EventFormProps) {
  const settings = useSettings();
  const tz = settings.timeZone;
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => toDraft(event, tz, defaultDate, defaultStart));
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'one' | 'series' | 'single'>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(toDraft(event, tz, defaultDate, defaultStart));
      setError(null);
    }
  }, [open, event, tz, defaultDate, defaultStart]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      if (!draft.date) throw new ValidationError('請選擇日期');
      if (!draft.start || !draft.end) throw new ValidationError('請填寫開始與結束時間');
      const startAt = localDateTimeToIso(draft.date, draft.start, tz);
      // 結束時間不晚於開始時間 → 視為跨午夜到隔天
      const endDate = timeToMinutes(draft.end) <= timeToMinutes(draft.start) ? nextDay(draft.date) : draft.date;
      const endAt = localDateTimeToIso(endDate, draft.end, tz);
      if (draft.repeat && draft.byWeekday.length === 0) throw new ValidationError('每週重複至少要選一天');
      const recurrence = draft.repeat ? { byWeekday: [...draft.byWeekday].sort(), until: draft.until || undefined } : undefined;
      const base = {
        title: draft.title,
        kind: draft.kind,
        location: draft.location || undefined,
        note: draft.note || undefined,
        startAt,
        endAt,
      };
      if (event) {
        await updateEvent(event.id, {
          ...base,
          recurrence: recurrence ? { freq: 'weekly', byWeekday: recurrence.byWeekday, until: recurrence.until, exceptions: event.recurrence?.exceptions ?? [] } : undefined,
        });
        toast.show('已更新行程');
      } else {
        await createEvent({ ...base, recurrence });
        toast.show('已新增行程');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  async function doDelete(mode: 'one' | 'series' | 'single') {
    if (!event) return;
    try {
      if (mode === 'one' && occurrence) {
        await addEventException(event.id, occurrence.date);
        toast.show('已刪除這一次');
      } else {
        await deleteEvent(event.id);
        toast.show('已刪除行程');
      }
      setConfirm(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '刪除失敗');
      setConfirm(null);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={event ? '編輯行程' : '新增固定行程'}
      footer={
        <div className="flex items-center gap-2">
          {event && !event.recurrence && (
            <Button variant="danger" onClick={() => setConfirm('single')}>
              刪除
            </Button>
          )}
          {event && event.recurrence && (
            <>
              {occurrence && (
                <Button variant="danger" onClick={() => setConfirm('one')}>
                  刪這一次
                </Button>
              )}
              <Button variant="danger" onClick={() => setConfirm('series')}>
                刪整個系列
              </Button>
            </>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || !draft.title.trim()}>
            {event ? '儲存' : '新增'}
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
        {event?.recurrence && <p className="rounded-lg bg-hard-soft px-3 py-2 text-sm text-hard">這是每週重複的行程，修改會套用到整個系列。</p>}

        <Field label="行程">
          <Input autoFocus value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="例：工程數學" />
        </Field>

        <Field label="類型">
          <Segmented
            value={draft.kind}
            onChange={(v) => set('kind', v)}
            className="w-full"
            options={(['class', 'exam', 'appointment', 'other'] as EventKind[]).map((k) => ({ value: k, label: EVENT_KIND_LABEL[k] }))}
          />
        </Field>

        <Field label={draft.repeat ? '第一次日期' : '日期'}>
          <Input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="開始">
            <Input type="time" value={draft.start} onChange={(e) => set('start', e.target.value)} />
          </Field>
          <Field label="結束" hint={timeToMinutes(draft.end) <= timeToMinutes(draft.start) ? '跨到隔天' : undefined}>
            <Input type="time" value={draft.end} onChange={(e) => set('end', e.target.value)} />
          </Field>
        </div>

        <Toggle checked={draft.repeat} onChange={(v) => set('repeat', v)} label="每週重複" />

        {draft.repeat && (
          <div className="space-y-3 rounded-xl bg-surface-2/60 p-3">
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
                const on = draft.byWeekday.includes(wd);
                return (
                  <button
                    key={wd}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set('byWeekday', on ? draft.byWeekday.filter((d) => d !== wd) : [...draft.byWeekday, wd])}
                    className={cx('h-10 flex-1 rounded-lg text-sm font-medium', on ? 'bg-hard text-white' : 'bg-surface text-muted border border-line')}
                  >
                    {weekdayLabel(wd)}
                  </button>
                );
              })}
            </div>
            <Field label="重複到（可留空）">
              <Input type="date" value={draft.until} onChange={(e) => set('until', e.target.value)} />
            </Field>
          </div>
        )}

        <Field label="地點">
          <Input value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="選填" />
        </Field>
        <Field label="備註">
          <Textarea value={draft.note} onChange={(e) => set('note', e.target.value)} rows={2} />
        </Field>
      </form>

      <Confirm
        open={confirm !== null}
        title={confirm === 'one' ? '只刪除這一次？' : confirm === 'series' ? '刪除整個系列？' : '刪除這個行程？'}
        message={confirm === 'one' ? `${occurrence?.date ?? ''} 這一次會從日曆移除，其他週不受影響。` : '刪除後無法復原。'}
        confirmLabel="刪除"
        danger
        onConfirm={() => confirm && doDelete(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </Sheet>
  );
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
