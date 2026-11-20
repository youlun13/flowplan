import { useMemo, useState } from 'react';
import { Plus, Repeat, Search } from 'lucide-react';
import { PageHeader } from '@/components/AppShell';
import { Chip, Empty, Input, Segmented, Select, cx } from '@/components/ui';
import { TaskForm } from '@/components/TaskForm';
import { TaskRow } from '@/components/TaskRow';
import type { Task } from '@/db/schema';
import { useTaskSeries, useTasks } from '@/hooks/useData';
import { repeatLabel } from '@/engine/taskRepeat';
import { addLocalDays, compareLocalDate, formatDuration } from '@/lib/time';
import { useNow } from '@/hooks/useNow';
import { useSettings } from '@/hooks/useSettings';
import { groupTasks, isDone, matchesSearch, sortTasks, type SortKey } from '@/lib/select';
import { toLocalDate } from '@/lib/time';

type Filter = 'open' | 'done' | 'all';

export function TasksPage() {
  const settings = useSettings();
  const tz = settings.timeZone;
  const nowMs = useNow(60_000);
  const today = toLocalDate(nowMs, tz);
  const tasks = useTasks();
  const seriesList = useTaskSeries();
  const repeatById = useMemo(() => new Map(seriesList.map((s) => [s.id, s.repeat!])), [seriesList]);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('open');
  const [sort, setSort] = useState<SortKey>('date');
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  const groups = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (t.status === 'cancelled') return false;
      if (filter === 'open' && isDone(t)) return false;
      if (filter === 'done' && !isDone(t)) return false;
      // 重複任務後天以後的那些不列（「重複」區已經代表它們；日子到了自然會出現在今天／明天）
      if (filter === 'open' && !query && t.seriesId && t.occurrenceDate && compareLocalDate(t.occurrenceDate, addLocalDays(today, 1)) > 0) return false;
      return matchesSearch(t, query);
    });
    const sorted = sortTasks(filtered, sort);
    if (sort !== 'date') return [{ key: 'all', label: '', tasks: sorted }];
    return groupTasks(sorted, today, nowMs, tz);
  }, [tasks, filter, query, sort, today, nowMs, tz]);

  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  return (
    <div>
      <PageHeader
        title="任務"
        aside={
          <button type="button" onClick={() => setCreating(true)} className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink" aria-label="新增任務">
            <Plus size={22} />
          </button>
        }
      />

      <div className="relative">
        <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋任務" className="pl-10" type="search" />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'open', label: '未完成' }, { value: 'done', label: '已完成' }, { value: 'all', label: '全部' }]} />
        <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-auto min-h-9 py-1 text-sm">
          <option value="date">依日期</option>
          <option value="due">依截止</option>
          <option value="priority">依優先級</option>
        </Select>
      </div>

      {total === 0 ? (
        <div className="mt-6">
          <Empty title={query ? '沒有符合的任務' : filter === 'done' ? '還沒有完成的任務' : '還沒有任務'} hint={!query && filter !== 'done' ? '按右上角 + 新增第一個任務' : undefined} />
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="mt-4">
            {g.label && (
              <h2 className={cx('mb-1 text-sm font-semibold', g.key === 'overdue' ? 'text-warn' : g.key === 'today' ? 'text-accent' : 'text-muted')}>
                {g.label} <span className="font-normal text-muted tnum">{g.tasks.length}</span>
              </h2>
            )}
            <div className="rounded-xl border border-line bg-surface px-3">
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} tz={tz} nowMs={nowMs} onOpen={setEditing} showDate={g.key !== 'today' && g.key !== 'tomorrow'} repeatOf={t.seriesId ? repeatById.get(t.seriesId) : undefined} />
              ))}
            </div>
          </section>
        ))
      )}

      {seriesList.length > 0 && !query && filter !== 'done' && (
        <section className="mt-5" data-testid="series-section">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-muted">
            <Repeat size={14} /> 重複 <span className="font-normal tnum">{seriesList.length}</span>
          </h2>
          <div className="rounded-xl border border-line bg-surface px-3">
            {seriesList
              .slice()
              .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'))
              .map((s) => (
                <button key={s.id} type="button" onClick={() => setEditing(s)} className="flex w-full items-center gap-3 border-b border-line py-3 text-left last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] leading-snug">{s.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip tone="accent">{repeatLabel(s.repeat!, { withUntil: true })}</Chip>
                      <Chip>{formatDuration(s.estimatedMinutes)}</Chip>
                    </div>
                  </div>
                </button>
              ))}
          </div>
          <p className="mt-1 text-xs text-muted">點一下可以改規則或停止。每一天的那筆到了今天／明天才會列在上面，各自打勾。</p>
        </section>
      )}

      <TaskForm open={creating} onClose={() => setCreating(false)} defaultDate={today} />
      <TaskForm open={editing !== null} onClose={() => setEditing(null)} task={editing ?? undefined} />
    </div>
  );
}
