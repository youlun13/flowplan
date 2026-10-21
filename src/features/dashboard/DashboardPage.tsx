import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Play, Square, CircleCheckBig, Plus } from 'lucide-react';
import { PageHeader } from '@/components/AppShell';
import { Button, Chip, Empty, Section, Segmented, Sheet, cx } from '@/components/ui';
import { TaskForm } from '@/components/TaskForm';
import { TaskRow } from '@/components/TaskRow';
import { EventForm } from '@/components/EventForm';
import { DayTimeline } from '@/components/DayTimeline';
import { ENERGY_LABEL, type Energy, type Task } from '@/db/schema';
import { cancelTask, deferTask, setDailyState, setTaskDone, startLog, stopLog } from '@/db/repo';
import { computeAvailability } from '@/engine/availability';
import { pickNextStep } from '@/engine/nextStep';
import { occurrencesOnDate, type Occurrence } from '@/engine/recurrence';
import { useDailyState, useEvents, useLogsForDate, useOccurrences, useRunningLog, useTasks } from '@/hooks/useData';
import { useNow } from '@/hooks/useNow';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { completionForDate, overdueTasks, sortTasks, tasksForDate } from '@/lib/select';
import { addLocalDays, diffLocalDays, formatDuration, formatLocalDateZh, formatTime, timeToMinutes, toLocalDate, toLocalTime } from '@/lib/time';

export function DashboardPage() {
  const settings = useSettings();
  const tz = settings.timeZone;
  const nowMs = useNow(30_000);
  const today = toLocalDate(nowMs, tz);
  const tasks = useTasks();
  const events = useEvents();
  const occurrences = useOccurrences(addLocalDays(today, -1), today, tz);
  const logs = useLogsForDate(today);
  const running = useRunningLog();
  const daily = useDailyState(today);
  const toast = useToast();

  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [occEditing, setOccEditing] = useState<Occurrence | null>(null);
  const [incidentOpen, setIncidentOpen] = useState(false);

  const todayTasks = useMemo(() => sortTasks(tasksForDate(tasks, today, tz), 'priority'), [tasks, today, tz]);
  const remaining = todayTasks.filter((t) => t.status !== 'done');
  const completion = completionForDate(tasks, today, tz);
  const overdue = useMemo(() => overdueTasks(tasks, today, nowMs), [tasks, today, nowMs]);

  // 包含昨天開始、跨午夜到今天的行程
  const dayOcc = useMemo(() => occurrencesOnDate(occurrences, today, tz), [occurrences, today, tz]);
  const availability = useMemo(
    () =>
      computeAvailability({
        date: today,
        tz,
        workStart: settings.workStart,
        workEnd: settings.workEnd,
        sleepStart: settings.sleepStart,
        sleepEnd: settings.sleepEnd,
        bufferMinutes: settings.bufferMinutes,
        busy: dayOcc,
        from: nowMs,
      }),
    [today, tz, settings, dayOcc, nowMs],
  );

  const next = useMemo(() => pickNextStep(tasks, nowMs, tz, daily?.energy), [tasks, nowMs, tz, daily?.energy]);
  const runningTask = running?.taskId ? tasks.find((t) => t.id === running.taskId) : undefined;
  const occForEdit = occEditing ? events.find((e) => e.id === occEditing.eventId) : undefined;

  async function startNext(task: Task) {
    try {
      await startLog({ title: task.title, taskId: task.id, category: 'task' }, tz);
      toast.show(`開始：${task.title}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法開始', 'danger');
    }
  }
  async function finishTask(task: Task) {
    try {
      if (running?.taskId === task.id) await stopLog(running.id, undefined, tz);
      await setTaskDone(task.id, true);
      toast.show(`完成：${task.title}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法完成', 'danger');
    }
  }
  async function setEnergy(e: Energy) {
    await setDailyState(today, { energy: e });
  }

  return (
    <div>
      <PageHeader
        title={formatLocalDateZh(today)}
        sub={`已完成 ${completion.done} / ${completion.total}${availability.totalMinutes > 0 ? ` · 今天還可用 ${formatDuration(availability.totalMinutes)}` : ''}`}
        aside={<div className="text-[34px] font-semibold leading-none tnum">{formatTime(nowMs, tz)}</div>}
      />

      {/* 完成率 */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(completion.ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${completion.ratio * 100}%` }} />
      </div>

      {/* 精力 */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm text-muted">現在的精力</span>
        <Segmented
          size="sm"
          value={daily?.energy ?? ('medium' as Energy)}
          onChange={setEnergy}
          options={(['high', 'medium', 'low'] as Energy[]).map((e) => ({ value: e, label: ENERGY_LABEL[e].replace('精力', '') }))}
        />
      </div>

      {/* 進行中 */}
      {running && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-accent">進行中 · 從 {formatTime(running.startAt, tz)} 開始，已 {formatDuration((nowMs - new Date(running.startAt).getTime()) / 60_000)}</div>
            <div className="truncate text-[15px] font-medium">{running.title}</div>
          </div>
          {runningTask && runningTask.status !== 'done' && (
            <Button variant="primary" onClick={() => finishTask(runningTask)} aria-label="完成任務">
              <CircleCheckBig size={18} /> 完成
            </Button>
          )}
          <Button onClick={() => stopLog(running.id, undefined, tz)} aria-label="結束紀錄">
            <Square size={16} /> 結束
          </Button>
        </div>
      )}

      {/* 下一步 */}
      <section className="mt-4 rounded-2xl bg-accent px-4 py-4 text-accent-ink">
        <div className="flex items-center justify-between">
          <span className="text-sm opacity-85">下一步做什麼</span>
          <span className="text-[11px] opacity-70">規則引擎簡易版</span>
        </div>
        {next ? (
          <>
            <button type="button" onClick={() => setEditing(next.task)} className="mt-1 block text-left text-[20px] font-semibold leading-snug">
              {next.task.title}
            </button>
            <p className="mt-1 text-sm opacity-90">
              {next.reason} · 預估 {formatDuration(next.task.estimatedMinutes)}
              {next.task.minimumOutcome && ` · 最低成果：${next.task.minimumOutcome}`}
            </p>
            {next.warning && (
              <p className="mt-2 flex gap-1.5 rounded-lg bg-black/15 px-3 py-2 text-sm">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {next.warning}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              {running?.taskId !== next.task.id ? (
                <Button className="bg-white/95 text-accent" onClick={() => startNext(next.task)}>
                  <Play size={16} /> 開始
                </Button>
              ) : (
                <Button className="bg-white/95 text-accent" onClick={() => finishTask(next.task)}>
                  <CircleCheckBig size={16} /> 完成
                </Button>
              )}
              <Button className="bg-white/15 text-accent-ink" onClick={() => setEditing(next.task)}>
                調整
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-[17px] font-medium">今天沒有待辦，或都完成了。</p>
        )}
      </section>

      <Button full className="mt-3" onClick={() => setIncidentOpen(true)}>
        <AlertTriangle size={18} className="text-warn" /> 我遇到狀況了
      </Button>

      {/* 逾期 */}
      {overdue.length > 0 && (
        <Section title={`逾期未處理（${overdue.length}）`} aside="不會自動消失，請決定怎麼辦">
          <div className="divide-y divide-line rounded-xl border border-warn/40 bg-warn-soft/40 px-3">
            {overdue.map((t) => (
              <OverdueRow key={t.id} task={t} today={today} tz={tz} nowMs={nowMs} onOpen={setEditing} />
            ))}
          </div>
        </Section>
      )}

      {/* 今天剩餘 */}
      <Section
        title={`今天剩餘（${remaining.length}）`}
        aside={
          <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1 text-accent">
            <Plus size={16} /> 新增
          </button>
        }
      >
        {remaining.length === 0 ? (
          <Empty title="今天沒有未完成的任務" hint="從「任務」頁或上方「新增」加入今天要做的事" />
        ) : (
          <div className="rounded-xl border border-line bg-surface px-3">
            {remaining.map((t) => (
              <TaskRow key={t.id} task={t} tz={tz} nowMs={nowMs} onOpen={setEditing} />
            ))}
          </div>
        )}
      </Section>

      {/* 行程 */}
      <Section title={`今天的固定行程（${dayOcc.length}）`} aside={<Link to="/calendar" className="text-accent">日曆</Link>}>
        {dayOcc.length === 0 ? (
          <p className="text-sm text-muted">今天沒有固定行程。</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {dayOcc.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => setOccEditing(o)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
                  <span className={cx('w-24 shrink-0 text-sm tnum', o.endMs < nowMs ? 'text-done' : 'text-ink')}>
                    {formatTime(o.startMs, tz)}–{formatTime(o.endMs, tz)}
                  </span>
                  <span className={cx('min-w-0 flex-1 truncate text-[15px]', o.endMs < nowMs && 'text-done')}>{o.title}</span>
                  {o.location && <span className="truncate text-xs text-muted">{o.location}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 時間軸 */}
      <Section title="時間軸" aside="左：計畫 · 右：實際">
        <div className="rounded-xl border border-line bg-surface p-3 pt-4">
          <DayTimeline
            date={today}
            tz={tz}
            occurrences={dayOcc}
            logs={logs}
            freeWindows={availability.windows}
            nowMs={nowMs}
            rangeStartMin={Math.min(timeToMinutes(settings.workStart), timeToMinutes(toLocalTime(nowMs, tz)))}
            rangeEndMin={timeToMinutes(settings.workEnd) <= timeToMinutes(settings.workStart) ? 1440 : timeToMinutes(settings.workEnd)}
            onOccurrenceClick={setOccEditing}
          />
        </div>
      </Section>

      <BackupReminder />

      <TaskForm open={creating} onClose={() => setCreating(false)} defaultDate={today} />
      <TaskForm open={editing !== null} onClose={() => setEditing(null)} task={editing ?? undefined} />
      <EventForm open={occEditing !== null} onClose={() => setOccEditing(null)} event={occForEdit} occurrence={occEditing ?? undefined} />

      <Sheet open={incidentOpen} onClose={() => setIncidentOpen(false)} title="我遇到狀況了">
        <p className="text-[15px]">動態調整面板（睡過頭、臨時有事、精力變差、提早完成、超時）會在第二階段啟用：系統會依現況重新計算可用時間，提出縮短、延後或不可行的候選方案，讓你預覽差異後再套用。</p>
        <p className="mt-3 text-sm text-muted">現在可以先用這些手動方式：</p>
        <ul className="mt-2 space-y-2 text-sm">
          <li>・把做不到的任務往下延：點任務 → 改「哪天做」。</li>
          <li>・臨時行程：到「日曆」新增固定行程，今天的可用時間會立刻重算。</li>
          <li>・精力變差：在上方切換精力，「下一步」會優先避開高負荷任務並提示風險。</li>
          <li>・提早做完：勾選完成，「下一步」會換成下一件事。</li>
        </ul>
        <div className="mt-4">
          <Button full onClick={() => setIncidentOpen(false)}>
            知道了
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function OverdueRow({ task, today, tz, nowMs, onOpen }: { task: Task; today: string; tz: string; nowMs: number; onOpen: (t: Task) => void }) {
  const toast = useToast();
  const days = task.plannedDate ? diffLocalDays(task.plannedDate, today) : 0;
  return (
    <div className="py-2.5">
      <TaskRow task={task} tz={tz} nowMs={nowMs} onOpen={onOpen} compact showDate />
      <div className="mt-1 flex flex-wrap gap-1.5 pl-9">
        {days > 0 && <Chip tone="warn">已過 {days} 天</Chip>}
        <button type="button" className="rounded-md bg-surface px-2.5 py-1 text-sm text-accent" onClick={() => deferTask(task.id, today).then(() => toast.show('已排到今天'))}>
          排到今天
        </button>
        <button type="button" className="rounded-md bg-surface px-2.5 py-1 text-sm text-accent" onClick={() => deferTask(task.id, addLocalDays(today, 1)).then(() => toast.show('已延到明天'))}>
          延到明天
        </button>
        <button type="button" className="rounded-md bg-surface px-2.5 py-1 text-sm text-muted" onClick={() => onOpen(task)}>
          拆解 / 編輯
        </button>
        <button type="button" className="rounded-md bg-surface px-2.5 py-1 text-sm text-danger" onClick={() => cancelTask(task.id).then(() => toast.show('已取消任務'))}>
          取消
        </button>
      </div>
    </div>
  );
}

function BackupReminder() {
  const settings = useSettings();
  const nowMs = useNow(60_000);
  const since = settings.lastBackupAt ?? settings.firstUsedAt;
  if (!since) return null;
  const days = (nowMs - new Date(since).getTime()) / 86_400_000;
  if (days < settings.backupReminderDays) return null;
  return (
    <div className="mt-6 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
      <div className="font-medium text-warn">{settings.lastBackupAt ? `已 ${Math.floor(days)} 天沒有備份` : '還沒做過備份'}</div>
      <div className="mt-1 text-muted">資料只存在這台裝置的瀏覽器裡。到「設定」匯出 JSON 留一份，清除瀏覽器資料時才不會全部不見。</div>
      <Link to="/settings" className="mt-2 inline-block text-accent">
        前往設定
      </Link>
    </div>
  );
}
