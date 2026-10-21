import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Play, Plus, Square } from 'lucide-react';
import { PageHeader } from '@/components/AppShell';
import { Button, Chip, Empty, Input, Select, cx } from '@/components/ui';
import { LogForm } from '@/components/LogForm';
import { LOG_CATEGORY_LABEL, type ActivityLog, type LogCategory } from '@/db/schema';
import { startLog, stopLog } from '@/db/repo';
import { useLogsForDate, useOccurrences, useRunningLog, useTasks } from '@/hooks/useData';
import { useNow } from '@/hooks/useNow';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { isOpen } from '@/lib/select';
import { addLocalDays, dayStartMs, formatDuration, formatTime, localDateTimeToMs, relativeDayLabel, toLocalDate, toLocalTime, type LocalDate } from '@/lib/time';

interface Row {
  kind: 'log' | 'gap';
  log?: ActivityLog;
  startMs: number;
  endMs: number;
}

export function LogPage() {
  const settings = useSettings();
  const tz = settings.timeZone;
  const nowMs = useNow(15_000);
  const today = toLocalDate(nowMs, tz);
  const [date, setDate] = useState<LocalDate>(today);
  const logs = useLogsForDate(date);
  const running = useRunningLog();
  const tasks = useTasks();
  const occurrences = useOccurrences(date, date, tz);
  const toast = useToast();

  const [quickTitle, setQuickTitle] = useState('');
  const [quickTask, setQuickTask] = useState('');
  const [editing, setEditing] = useState<ActivityLog | null>(null);
  const [adding, setAdding] = useState<{ start?: string; end?: string } | null>(null);

  const openTasks = useMemo(() => tasks.filter((t) => isOpen(t) && (t.plannedDate === date || !t.plannedDate)), [tasks, date]);

  // 時間列：紀錄之間插入空白段
  const rows = useMemo<Row[]>(() => {
    const sorted = logs.slice().sort((a, b) => a.startAt.localeCompare(b.startAt));
    const out: Row[] = [];
    const dayStart = dayStartMs(date, tz);
    const floor = Math.max(dayStart, localDateTimeToMs(date, settings.sleepEnd, tz));
    let cursor = floor;
    for (const l of sorted) {
      const s = new Date(l.startAt).getTime();
      const e = l.endAt ? new Date(l.endAt).getTime() : nowMs;
      if (s - cursor >= 15 * 60_000) out.push({ kind: 'gap', startMs: cursor, endMs: s });
      out.push({ kind: 'log', log: l, startMs: s, endMs: e });
      cursor = Math.max(cursor, e);
    }
    if (date === today && nowMs - cursor >= 15 * 60_000) out.push({ kind: 'gap', startMs: cursor, endMs: nowMs });
    return out;
  }, [logs, date, tz, settings.sleepEnd, nowMs, today]);

  const summary = useMemo(() => {
    const byCat = new Map<LogCategory, number>();
    let total = 0;
    for (const l of logs) {
      const mins = ((l.endAt ? new Date(l.endAt).getTime() : nowMs) - new Date(l.startAt).getTime()) / 60_000;
      total += mins;
      byCat.set(l.category, (byCat.get(l.category) ?? 0) + mins);
    }
    const top = Array.from(byCat.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return { total, top };
  }, [logs, nowMs]);

  async function quickStart() {
    const task = openTasks.find((t) => t.id === quickTask);
    const title = quickTitle.trim() || task?.title;
    if (!title) return;
    try {
      await startLog({ title, taskId: task?.id, category: task ? 'task' : 'other' }, tz);
      setQuickTitle('');
      setQuickTask('');
      toast.show(`開始：${title}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法開始', 'danger');
    }
  }

  async function stop() {
    if (!running) return;
    await stopLog(running.id, undefined, tz);
    toast.show('已結束紀錄');
  }

  return (
    <div>
      <PageHeader title="紀錄" sub="今天實際上幾點到幾點做了什麼" />

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setDate(addLocalDays(date, -1))} aria-label="前一天" className="rounded-full p-2 active:bg-surface-2">
          <ChevronLeft size={22} />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{relativeDayLabel(date, today)}</span>
          {date !== today && (
            <button type="button" onClick={() => setDate(today)} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted">
              今天
            </button>
          )}
        </div>
        <button type="button" onClick={() => setDate(addLocalDays(date, 1))} aria-label="後一天" className="rounded-full p-2 active:bg-surface-2" disabled={date >= today}>
          <ChevronRight size={22} className={cx(date >= today && 'opacity-30')} />
        </button>
      </div>

      {/* 進行中 / 快速開始 */}
      {running ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-accent px-4 py-3 text-accent-ink">
          <div className="min-w-0 flex-1">
            <div className="text-xs opacity-80">
              進行中 · {formatTime(running.startAt, tz)} 起，已 {formatDuration((nowMs - new Date(running.startAt).getTime()) / 60_000)}
            </div>
            <div className="truncate text-[16px] font-semibold">{running.title}</div>
          </div>
          <Button className="bg-white/95 text-accent" onClick={stop}>
            <Square size={16} /> 結束
          </Button>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-line bg-surface p-3">
          <div className="flex gap-2">
            <Input value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)} placeholder="現在開始做什麼？" onKeyDown={(e) => e.key === 'Enter' && quickStart()} />
            <Button variant="primary" onClick={quickStart} disabled={!quickTitle.trim() && !quickTask} className="shrink-0 whitespace-nowrap">
              <Play size={16} /> 開始
            </Button>
          </div>
          {openTasks.length > 0 && (
            <Select value={quickTask} onChange={(e) => setQuickTask(e.target.value)} className="mt-2 min-h-10 text-sm">
              <option value="">或選一個任務（會累計實際工時）</option>
              {openTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}

      {/* 摘要 */}
      <div className="mt-4 flex items-baseline justify-between gap-3">
        <div className="text-sm text-muted">
          已記錄 <span className="text-ink tnum">{formatDuration(summary.total)}</span>
          {summary.top.length > 0 && <span> · {summary.top.map(([c, m]) => `${LOG_CATEGORY_LABEL[c]} ${formatDuration(m)}`).join('、')}</span>}
        </div>
        <button type="button" onClick={() => setAdding({})} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-accent">
          <Plus size={16} /> 補登
        </button>
      </div>

      {/* 列表 */}
      {rows.length === 0 ? (
        <div className="mt-3">
          <Empty title={date === today ? '今天還沒有紀錄' : '這天沒有紀錄'} hint="用上方「開始」計時，或「補登」填入幾點到幾點做了什麼" />
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
          {rows.map((r, i) =>
            r.kind === 'gap' ? (
              <li key={`gap-${i}`}>
                <button
                  type="button"
                  onClick={() => setAdding({ start: formatTime(r.startMs, tz), end: formatTime(r.endMs, tz) })}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-muted"
                >
                  <span className="w-24 shrink-0 tnum">
                    {formatTime(r.startMs, tz)}–{formatTime(r.endMs, tz)}
                  </span>
                  <span className="flex-1 italic">空白 {formatDuration((r.endMs - r.startMs) / 60_000)} · 點此補登</span>
                </button>
              </li>
            ) : (
              <li key={r.log!.id}>
                <button type="button" onClick={() => setEditing(r.log!)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
                  <span className="w-24 shrink-0 text-sm tnum">
                    {formatTime(r.startMs, tz)}–{r.log!.endAt ? formatTime(r.endMs, tz) : '…'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">{r.log!.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <Chip tone={r.log!.taskId ? 'accent' : 'neutral'}>{LOG_CATEGORY_LABEL[r.log!.category]}</Chip>
                      <span className="text-xs text-muted tnum">{formatDuration((r.endMs - r.startMs) / 60_000)}</span>
                      {occurrences.some((o) => o.startMs < r.endMs && r.startMs < o.endMs && o.title === r.log!.title) && <Chip tone="hard">行程</Chip>}
                    </span>
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      <LogForm open={editing !== null} onClose={() => setEditing(null)} log={editing ?? undefined} />
      <LogForm
        open={adding !== null}
        onClose={() => setAdding(null)}
        defaultDate={date}
        defaultStart={adding?.start ?? (date === today ? undefined : '09:00')}
        defaultEnd={adding?.end ?? (date === today ? toLocalTime(nowMs, tz) : undefined)}
      />
    </div>
  );
}
