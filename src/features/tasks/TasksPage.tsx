import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/AppShell';
import { Empty, Input, Segmented, Select, cx } from '@/components/ui';
import { TaskForm } from '@/components/TaskForm';
import { TaskRow } from '@/components/TaskRow';
import type { Task } from '@/db/schema';
import { useTasks } from '@/hooks/useData';
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
                <TaskRow key={t.id} task={t} tz={tz} nowMs={nowMs} onOpen={setEditing} showDate={g.key !== 'today' && g.key !== 'tomorrow'} />
              ))}
            </div>
          </section>
        ))
      )}

      <TaskForm open={creating} onClose={() => setCreating(false)} defaultDate={today} />
      <TaskForm open={editing !== null} onClose={() => setEditing(null)} task={editing ?? undefined} />
    </div>
  );
}
