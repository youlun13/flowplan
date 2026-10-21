import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Chip, cx } from '@/components/ui';
import { db } from '@/db/db';
import { LOG_CATEGORY_LABEL, type ActivityLog, type LogCategory, type Task } from '@/db/schema';
import { calibration, completionHistory, deferralAnalysis, weekStats } from '@/engine/stats';
import { addLocalDays, formatDuration, formatLocalDateShort, localWeekday, weekdayLabel, type LocalDate } from '@/lib/time';

const EMPTY: ActivityLog[] = [];

/** 分類顏色：同一色相不同明度，深色模式一樣可讀 */
const CATEGORY_TONE: Record<LogCategory, string> = {
  task: 'bg-accent',
  study: 'bg-accent/75',
  class: 'bg-hard',
  exercise: 'bg-accent/50',
  meal: 'bg-warn/70',
  commute: 'bg-muted/60',
  rest: 'bg-muted/35',
  other: 'bg-line',
};
const CATEGORY_ORDER: LogCategory[] = ['task', 'study', 'class', 'exercise', 'meal', 'commute', 'rest', 'other'];

export function WeekView({ weekStart, today, tz, tasks, nowMs, onShift }: { weekStart: LocalDate; today: LocalDate; tz: string; tasks: Task[]; nowMs: number; onShift: (n: number) => void }) {
  const weekEnd = addLocalDays(weekStart, 6);
  const logs = useLiveQuery(() => db.logs.where('date').between(weekStart, weekEnd, true, true).toArray(), [weekStart, weekEnd]) ?? EMPTY;
  const days = useMemo(() => weekStats(logs, tasks, weekStart, tz, nowMs), [logs, tasks, weekStart, tz, nowMs]);
  const maxMinutes = Math.max(60, ...days.map((d) => d.totalMinutes));
  const totalMinutes = days.reduce((s, d) => s + d.totalMinutes, 0);
  const totalDone = days.reduce((s, d) => s + d.completedTasks, 0);
  const byCat = useMemo(() => {
    const m: Partial<Record<LogCategory, number>> = {};
    for (const d of days) for (const [c, v] of Object.entries(d.minutesByCategory)) m[c as LogCategory] = (m[c as LogCategory] ?? 0) + (v ?? 0);
    return CATEGORY_ORDER.filter((c) => (m[c] ?? 0) > 0).map((c) => ({ category: c, minutes: Math.round(m[c] ?? 0) }));
  }, [days]);
  const cal = useMemo(() => calibration(tasks), [tasks]);
  const deferral = useMemo(() => deferralAnalysis(tasks), [tasks]);
  const history = useMemo(() => completionHistory(tasks, today, 28, tz), [tasks, today, tz]);
  const historyMax = Math.max(1, ...history.map((h) => h.count));

  return (
    <div>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => onShift(-1)} aria-label="上一週" className="rounded-full p-2 active:bg-surface-2">
          <ChevronLeft size={22} />
        </button>
        <span className="text-[15px] font-semibold tnum">
          {formatLocalDateShort(weekStart)} – {formatLocalDateShort(weekEnd)}
        </span>
        <button type="button" onClick={() => onShift(1)} aria-label="下一週" className="rounded-full p-2 active:bg-surface-2" disabled={weekEnd >= today}>
          <ChevronRight size={22} className={cx(weekEnd >= today && 'opacity-30')} />
        </button>
      </div>

      {/* 每日時數（堆疊長條） */}
      <section className="mt-3 rounded-xl border border-line bg-surface p-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold">每天記錄了多少</h2>
          <span className="text-sm text-muted tnum">
            共 {formatDuration(totalMinutes)} · 完成 {totalDone} 件
          </span>
        </div>
        <div className="mt-3 grid grid-cols-7 items-end gap-2" style={{ height: 140 }} role="img" aria-label="本週每天的記錄時數">
          {days.map((d) => {
            const h = Math.round((d.totalMinutes / maxMinutes) * 120);
            return (
              <div key={d.date} className="flex h-full flex-col justify-end">
                <div className="mb-1 text-center text-[11px] text-muted tnum">{d.totalMinutes > 0 ? `${Math.round((d.totalMinutes / 60) * 10) / 10}h` : ''}</div>
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-md bg-surface-2" style={{ height: Math.max(4, h) }} title={`${d.date} ${formatDuration(d.totalMinutes)}`}>
                  {CATEGORY_ORDER.map((c) => {
                    const v = d.minutesByCategory[c] ?? 0;
                    if (v <= 0 || d.totalMinutes === 0) return null;
                    return <div key={c} className={CATEGORY_TONE[c]} style={{ height: `${(v / d.totalMinutes) * 100}%` }} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-2 text-center text-[11px] text-muted">
          {days.map((d) => (
            <div key={d.date} className={cx(d.date === today && 'font-semibold text-accent')}>
              {weekdayLabel(localWeekday(d.date))}
              <div className="tnum">{d.completedTasks > 0 ? `✓${d.completedTasks}` : ''}</div>
            </div>
          ))}
        </div>
        {byCat.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {byCat.map((b) => (
              <li key={b.category} className="flex items-center gap-1.5">
                <span className={cx('inline-block h-2.5 w-2.5 rounded-sm', CATEGORY_TONE[b.category])} />
                {LOG_CATEGORY_LABEL[b.category]} <span className="tnum">{formatDuration(b.minutes)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 完成歷史 */}
      <section className="mt-3 rounded-xl border border-line bg-surface p-3">
        <h2 className="text-[15px] font-semibold">最近 28 天完成數</h2>
        <div className="mt-2 flex h-10 items-end gap-[2px]" role="img" aria-label="最近 28 天每天完成的任務數">
          {history.map((h) => (
            <div key={h.date} className={cx('flex-1 rounded-sm', h.count > 0 ? 'bg-accent' : 'bg-surface-2')} style={{ height: `${Math.max(8, (h.count / historyMax) * 100)}%` }} title={`${h.date}：${h.count}`} />
          ))}
        </div>
        <div className="mt-1 text-xs text-muted tnum">
          共 {history.reduce((s, h) => s + h.count, 0)} 件 · 平均每天 {Math.round((history.reduce((s, h) => s + h.count, 0) / 28) * 10) / 10} 件
        </div>
      </section>

      {/* 預估準確度 */}
      <section className="mt-3 rounded-xl border border-line bg-surface p-3">
        <h2 className="text-[15px] font-semibold">預估準不準</h2>
        {cal.factor === undefined ? (
          <p className="mt-1 text-sm text-muted">完成並有實際工時的任務至少 3 件後才會計算（目前 {cal.samples} 件）。用「開始」計時或補登綁定任務，就會累積實際工時。</p>
        ) : (
          <>
            <p className="mt-1 text-[15px]">
              實際大約是預估的 <span className="font-semibold tnum">{cal.factor}</span> 倍
              <span className="text-sm text-muted">（{cal.samples} 件，中位數）</span>
            </p>
            <p className="mt-0.5 text-xs text-muted">{cal.factor > 1.15 ? '你常低估：規劃時引擎會自動放大預估（可在設定關閉）。' : cal.factor < 0.85 ? '你常高估：規劃時引擎會自動縮小預估（可在設定關閉）。' : '預估相當準。'}</p>
            {Object.keys(cal.byEnergy).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(['high', 'medium', 'low'] as const).map((e) =>
                  cal.byEnergy[e] ? (
                    <Chip key={e} tone={cal.byEnergy[e]!.factor > 1.15 ? 'warn' : 'neutral'}>
                      {e === 'high' ? '高精力' : e === 'medium' ? '中精力' : '低精力'} ×{cal.byEnergy[e]!.factor}（{cal.byEnergy[e]!.samples}）
                    </Chip>
                  ) : null,
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* 延期分析 */}
      <section className="mt-3 rounded-xl border border-line bg-surface p-3">
        <h2 className="text-[15px] font-semibold">一直被延後的</h2>
        {deferral.items.length === 0 ? (
          <p className="mt-1 text-sm text-muted">沒有被延後過的未完成任務。</p>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-muted">
              未完成任務平均延後 {deferral.averageDefers} 次；{deferral.starving} 件延後 2 次以上。被反覆延後通常代表太大、太模糊，或其實不需要做。
            </p>
            <ul className="mt-2 divide-y divide-line">
              {deferral.items.map(({ task, deferCount }) => (
                <li key={task.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[15px]">{task.title}</span>
                  <Chip tone={deferCount >= 2 ? 'warn' : 'neutral'}>延後 {deferCount} 次</Chip>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
