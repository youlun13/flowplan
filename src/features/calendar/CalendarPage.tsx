import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { PageHeader } from '@/components/AppShell';
import { Button, Chip, Empty, Segmented, cx } from '@/components/ui';
import { TaskForm } from '@/components/TaskForm';
import { TaskRow } from '@/components/TaskRow';
import { EventForm } from '@/components/EventForm';
import { DayTimeline } from '@/components/DayTimeline';
import { EVENT_KIND_LABEL, type Task } from '@/db/schema';
import { computeAvailability } from '@/engine/availability';
import { findOverlaps } from '@/engine/intervals';
import { occurrencesOnDate, type Occurrence } from '@/engine/recurrence';
import { useEvents, useOccurrences, useTasks } from '@/hooks/useData';
import { useNow } from '@/hooks/useNow';
import { useSettings } from '@/hooks/useSettings';
import { isDone, sortTasks, tasksForDate } from '@/lib/select';
import {
  addLocalDays,
  addLocalMonths,
  formatDuration,
  formatLocalDateZh,
  formatTime,
  localMonthOf,
  monthGrid,
  startOfLocalWeek,
  timeToMinutes,
  toLocalDate,
  weekdayLabel,
  type LocalDate,
} from '@/lib/time';

type View = 'month' | 'week' | 'day';

export function CalendarPage() {
  const settings = useSettings();
  const tz = settings.timeZone;
  const nowMs = useNow(60_000);
  const today = toLocalDate(nowMs, tz);
  const tasks = useTasks();
  const events = useEvents();

  const [view, setView] = useState<View>('month');
  const [selected, setSelected] = useState<LocalDate>(today);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [creatingEvent, setCreatingEvent] = useState<{ start?: string } | null>(null);
  const [occEditing, setOccEditing] = useState<Occurrence | null>(null);

  // 顯示範圍
  const { year, month } = localMonthOf(selected);
  const grid = useMemo(() => monthGrid(year, month, settings.weekStartsOn), [year, month, settings.weekStartsOn]);
  const weekStart = startOfLocalWeek(selected, settings.weekStartsOn);
  const rangeFrom = view === 'month' ? addLocalDays(grid[0], -1) : view === 'week' ? addLocalDays(weekStart, -1) : addLocalDays(selected, -1);
  const rangeTo = view === 'month' ? grid[41] : view === 'week' ? addLocalDays(weekStart, 6) : selected;
  const occurrences = useOccurrences(rangeFrom, rangeTo, tz);

  const occByDate = useMemo(() => {
    const map = new Map<LocalDate, Occurrence[]>();
    const dates = view === 'month' ? grid : view === 'week' ? Array.from({ length: 7 }, (_, i) => addLocalDays(weekStart, i)) : [selected];
    for (const d of dates) map.set(d, occurrencesOnDate(occurrences, d, tz));
    return map;
  }, [occurrences, grid, weekStart, selected, view, tz]);

  const taskCountByDate = useMemo(() => {
    const map = new Map<LocalDate, { open: number; total: number }>();
    for (const t of tasks) {
      if (t.status === 'cancelled') continue;
      const d = t.plannedDate ?? (t.dueAt ? toLocalDate(t.dueAt, tz) : undefined);
      if (!d) continue;
      const cur = map.get(d) ?? { open: 0, total: 0 };
      cur.total += 1;
      if (!isDone(t)) cur.open += 1;
      map.set(d, cur);
    }
    return map;
  }, [tasks, tz]);

  const selectedTasks = useMemo(() => sortTasks(tasksForDate(tasks, selected, tz), 'priority'), [tasks, selected, tz]);
  const selectedOcc = occByDate.get(selected) ?? occurrencesOnDate(occurrences, selected, tz);
  const overlapPairs = useMemo(() => findOverlaps(selectedOcc.map((o) => ({ ...o, start: o.startMs, end: o.endMs }))), [selectedOcc]);

  const availability = useMemo(
    () =>
      computeAvailability({
        date: selected,
        tz,
        workStart: settings.workStart,
        workEnd: settings.workEnd,
        sleepStart: settings.sleepStart,
        sleepEnd: settings.sleepEnd,
        bufferMinutes: settings.bufferMinutes,
        busy: selectedOcc,
      }),
    [selected, tz, settings, selectedOcc],
  );

  function shift(n: number) {
    if (view === 'month') setSelected(addLocalMonths(selected, n));
    else if (view === 'week') setSelected(addLocalDays(selected, 7 * n));
    else setSelected(addLocalDays(selected, n));
  }

  const headerTitle = view === 'month' ? `${year} 年 ${month} 月` : view === 'week' ? `${formatLocalDateZh(weekStart)} 起的一週` : formatLocalDateZh(selected, true);
  const occForEdit = occEditing ? events.find((e) => e.id === occEditing.eventId) : undefined;
  const weekdays = settings.weekStartsOn === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];

  return (
    <div>
      <PageHeader
        title="日曆"
        aside={<Segmented size="sm" value={view} onChange={setView} options={[{ value: 'month', label: '月' }, { value: 'week', label: '週' }, { value: 'day', label: '日' }]} />}
      />

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => shift(-1)} aria-label="上一個" className="rounded-full p-2 active:bg-surface-2">
          <ChevronLeft size={22} />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{headerTitle}</span>
          {selected !== today && (
            <button type="button" onClick={() => setSelected(today)} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted">
              今天
            </button>
          )}
        </div>
        <button type="button" onClick={() => shift(1)} aria-label="下一個" className="rounded-full p-2 active:bg-surface-2">
          <ChevronRight size={22} />
        </button>
      </div>

      {view === 'month' && (
        <div className="mt-2">
          <div className="grid grid-cols-7 text-center text-xs text-muted">
            {weekdays.map((wd) => (
              <div key={wd} className="py-1">
                {weekdayLabel(wd)}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-1">
            {grid.map((d) => {
              const inMonth = localMonthOf(d).month === month;
              const occ = occByDate.get(d) ?? [];
              const tc = taskCountByDate.get(d);
              const isSel = d === selected;
              const isToday = d === today;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setSelected(d)}
                  aria-label={formatLocalDateZh(d, true)}
                  aria-pressed={isSel}
                  className={cx('flex h-14 flex-col items-center rounded-lg pt-1', isSel ? 'bg-accent-soft' : 'active:bg-surface-2', !inMonth && 'opacity-40')}
                >
                  <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-sm tnum', isToday && 'bg-accent text-accent-ink font-semibold', isSel && !isToday && 'font-semibold text-accent')}>
                    {Number(d.slice(8))}
                  </span>
                  <span className="mt-1 flex h-1.5 items-center gap-0.5">
                    {occ.slice(0, 3).map((o) => (
                      <span key={o.id} className="h-1.5 w-1.5 rounded-full bg-hard" />
                    ))}
                  </span>
                  {tc && tc.total > 0 && <span className={cx('mt-0.5 text-[10px] leading-3 tnum', tc.open > 0 ? 'text-accent' : 'text-done')}>{tc.open > 0 ? tc.open : '✓'}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {view === 'week' && (
        <div className="mt-3 space-y-2">
          {Array.from({ length: 7 }, (_, i) => addLocalDays(weekStart, i)).map((d) => {
            const occ = occByDate.get(d) ?? [];
            const dayTasks = sortTasks(tasksForDate(tasks, d, tz), 'priority');
            const isToday = d === today;
            return (
              <div key={d} className={cx('rounded-xl border bg-surface', isToday ? 'border-accent/50' : 'border-line')}>
                <button type="button" onClick={() => { setSelected(d); setView('day'); }} className="flex w-full items-center justify-between px-3 py-2 text-left">
                  <span className={cx('text-[15px] font-semibold', isToday && 'text-accent')}>{formatLocalDateZh(d)}</span>
                  <span className="text-xs text-muted">
                    {occ.length} 行程 · {dayTasks.filter((t) => !isDone(t)).length} 待辦
                  </span>
                </button>
                {(occ.length > 0 || dayTasks.length > 0) && (
                  <div className="border-t border-line px-3 pb-1">
                    {occ.map((o) => (
                      <button key={o.id} type="button" onClick={() => setOccEditing(o)} className="flex w-full items-center gap-3 py-1.5 text-left">
                        <span className="w-24 shrink-0 text-sm text-hard tnum">
                          {formatTime(o.startMs, tz)}–{formatTime(o.endMs, tz)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[15px]">{o.title}</span>
                      </button>
                    ))}
                    {dayTasks.map((t) => (
                      <TaskRow key={t.id} task={t} tz={tz} nowMs={nowMs} onOpen={setEditingTask} compact />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === 'day' && (
        <div className="mt-3 rounded-xl border border-line bg-surface p-3 pt-4">
          <DayTimeline
            date={selected}
            tz={tz}
            occurrences={selectedOcc}
            freeWindows={availability.windows}
            nowMs={selected === today ? nowMs : undefined}
            rangeStartMin={timeToMinutes(settings.workStart)}
            rangeEndMin={timeToMinutes(settings.workEnd) <= timeToMinutes(settings.workStart) ? 1440 : timeToMinutes(settings.workEnd)}
            onOccurrenceClick={setOccEditing}
            onFreeClick={(w) => setCreatingEvent({ start: formatTime(w.start, tz) })}
          />
        </div>
      )}

      {view !== 'week' && (
        <>
          <div className="mt-5 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">{selected === today ? '今天' : formatLocalDateZh(selected)}</h2>
            <div className="flex gap-2">
              <Button onClick={() => setCreatingEvent({})} className="min-h-9 px-3 text-sm">
                <Plus size={16} /> 行程
              </Button>
              <Button variant="primary" onClick={() => setCreatingTask(true)} className="min-h-9 px-3 text-sm">
                <Plus size={16} /> 任務
              </Button>
            </div>
          </div>

          {overlapPairs.length > 0 && (
            <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              有 {overlapPairs.length} 組行程時間重疊：{overlapPairs.map(([a, b]) => `${a.title} / ${b.title}`).join('；')}
            </p>
          )}

          <div className="mt-2 rounded-xl border border-line bg-surface">
            <div className="px-3 py-2 text-xs text-muted">固定行程 · 可用 {formatDuration(availability.totalMinutes)}</div>
            {selectedOcc.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-muted">沒有行程。</p>
            ) : (
              <ul className="divide-y divide-line border-t border-line">
                {selectedOcc.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => setOccEditing(o)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
                      <span className="w-24 shrink-0 text-sm tnum">
                        {formatTime(o.startMs, tz)}–{formatTime(o.endMs, tz)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[15px]">{o.title}</span>
                      <Chip tone="hard">{EVENT_KIND_LABEL[o.kind]}</Chip>
                      {o.recurring && <Chip>每週</Chip>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-line bg-surface">
            <div className="px-3 py-2 text-xs text-muted">任務</div>
            {selectedTasks.length === 0 ? (
              <div className="px-3 pb-3">
                <Empty title="這天還沒有任務" />
              </div>
            ) : (
              <div className="border-t border-line px-3">
                {selectedTasks.map((t) => (
                  <TaskRow key={t.id} task={t} tz={tz} nowMs={nowMs} onOpen={setEditingTask} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <TaskForm open={creatingTask} onClose={() => setCreatingTask(false)} defaultDate={selected} />
      <TaskForm open={editingTask !== null} onClose={() => setEditingTask(null)} task={editingTask ?? undefined} />
      <EventForm open={creatingEvent !== null} onClose={() => setCreatingEvent(null)} defaultDate={selected} defaultStart={creatingEvent?.start} />
      <EventForm open={occEditing !== null} onClose={() => setOccEditing(null)} event={occForEdit} occurrence={occEditing ?? undefined} />
    </div>
  );
}
