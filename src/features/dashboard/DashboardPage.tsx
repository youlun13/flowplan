import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Play, Square, CircleCheckBig, Plus, Undo2, SkipForward, CalendarClock } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { PageHeader } from '@/components/AppShell';
import { Button, Chip, Empty, Section, Segmented, cx } from '@/components/ui';
import { TaskForm } from '@/components/TaskForm';
import { TaskRow } from '@/components/TaskRow';
import { EventForm } from '@/components/EventForm';
import { DayTimeline } from '@/components/DayTimeline';
import { ElapsedTimer } from '@/components/ElapsedTimer';
import { IncidentSheet } from './IncidentSheet';
import { PlanTodaySheet } from './PlanTodaySheet';
import { ENERGY_LABEL, type Energy, type Task, type WorkBlock } from '@/db/schema';
import { cancelTask, deferTask, setDailyState, setTaskDone, startLog, stopLog } from '@/db/repo';
import { latestRevisionForDate, setBlockStatus, undoRevision } from '@/db/plan';
import { computeAvailability } from '@/engine/availability';
import { pickNextStep } from '@/engine/nextStep';
import type { Occurrence } from '@/engine/recurrence';
import { useEvents, useLogsForDate } from '@/hooks/useData';
import { useNow } from '@/hooks/useNow';
import { useSession } from '@/hooks/useSession';
import { syncConfigured } from '@/sync/engine';
import { usePlanner } from '@/hooks/usePlanner';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { completionForDate, overdueTasks, sortTasks, tasksForDate } from '@/lib/select';
import { addLocalDays, diffLocalDays, formatDuration, formatLocalDateZh, formatTime, timeToMinutes, toLocalTime } from '@/lib/time';

export function DashboardPage() {
  const nowMs = useNow(30_000);
  const { today, tz, tasks, todayOcc, blocks, running, daily, settings, buildProposal } = usePlanner(nowMs);
  const events = useEvents();
  const logs = useLogsForDate(today);
  const latestRevision = useLiveQuery(() => latestRevisionForDate(today), [today, blocks]);
  const toast = useToast();

  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [occEditing, setOccEditing] = useState<Occurrence | null>(null);
  const [incident, setIncident] = useState<null | { replan: boolean }>(null);
  const [planToday, setPlanToday] = useState(false);

  const todayTasks = useMemo(() => sortTasks(tasksForDate(tasks, today, tz), 'priority'), [tasks, today, tz]);
  const remaining = todayTasks.filter((t) => t.status !== 'done');
  const completion = completionForDate(tasks, today, tz);
  const overdue = useMemo(() => overdueTasks(tasks, today, nowMs), [tasks, today, nowMs]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

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
        busy: todayOcc,
        from: nowMs,
      }),
    [today, tz, settings, todayOcc, nowMs],
  );

  // 已套用的排程：目前 / 下一個區塊
  const openBlocks = useMemo(
    () => blocks.filter((b) => (b.status === 'planned' || b.status === 'active') && tasksById.get(b.taskId) && tasksById.get(b.taskId)!.status !== 'done' && new Date(b.endAt).getTime() > nowMs),
    [blocks, tasksById, nowMs],
  );
  const currentBlock = openBlocks.find((b) => new Date(b.startAt).getTime() <= nowMs) ?? openBlocks[0];
  const missedBlocks = blocks.filter((b) => b.status === 'planned' && new Date(b.endAt).getTime() <= nowMs && tasksById.get(b.taskId)?.status !== 'done');
  const suggestion = useMemo(() => (currentBlock ? null : pickNextStep(tasks, nowMs, tz, daily?.energy)), [currentBlock, tasks, nowMs, tz, daily?.energy]);
  const nextTask = currentBlock ? tasksById.get(currentBlock.taskId) : suggestion?.task;
  const runningTask = running?.taskId ? tasksById.get(running.taskId) : undefined;
  const occForEdit = occEditing ? events.find((e) => e.id === occEditing.eventId) : undefined;

  async function start(task: Task, block?: WorkBlock) {
    try {
      await startLog({ title: task.title, taskId: task.id, category: 'task' }, tz);
      if (block) await setBlockStatus(block.id, 'active');
      toast.show(`開始：${task.title}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法開始', 'danger');
    }
  }
  async function finish(task: Task) {
    try {
      if (running?.taskId === task.id) await stopLog(running.id, undefined, tz);
      await setTaskDone(task.id, true);
      toast.show(`完成：${task.title}`, 'info', {
        label: '復原',
        onClick: async () => {
          await setTaskDone(task.id, false);
          toast.show(`已復原：${task.title}`);
        },
      });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法完成', 'danger');
    }
  }
  async function undo() {
    if (!latestRevision) return;
    try {
      await undoRevision(latestRevision.id);
      toast.show('已撤銷最近一次套用');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法撤銷', 'danger');
    }
  }

  return (
    <div>
      <PageHeader
        title={formatLocalDateZh(today)}
        sub={`已完成 ${completion.done} / ${completion.total}${availability.totalMinutes > 0 ? ` · 今天還可用 ${formatDuration(availability.totalMinutes)}` : ''}`}
        aside={<div className="text-[34px] font-semibold leading-none tnum">{formatTime(nowMs, tz)}</div>}
      />

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(completion.ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${completion.ratio * 100}%` }} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3" data-tour="energy">
        <span className="text-sm text-muted">現在的精力</span>
        <Segmented
          size="sm"
          value={daily?.energy ?? ('medium' as Energy)}
          onChange={(e) => setDailyState(today, { energy: e })}
          options={(['high', 'medium', 'low'] as Energy[]).map((e) => ({ value: e, label: ENERGY_LABEL[e].replace('精力', '') }))}
        />
      </div>

      {running && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-accent">進行中 · 從 {formatTime(running.startAt, tz)} 開始</div>
            <div className="truncate text-[15px] font-medium">{running.title}</div>
            <ElapsedTimer startAt={running.startAt} className="block text-[26px] font-semibold leading-tight text-accent" />
          </div>
          {runningTask && runningTask.status !== 'done' && (
            <Button variant="primary" onClick={() => finish(runningTask)} aria-label="完成任務">
              <CircleCheckBig size={18} /> 完成
            </Button>
          )}
          <Button onClick={() => stopLog(running.id, undefined, tz)} aria-label="結束紀錄">
            <Square size={16} /> 結束
          </Button>
        </div>
      )}

      {/* 下一步 */}
      <section className="mt-4 rounded-2xl bg-accent px-4 py-4 text-accent-ink" data-tour="next">
        <div className="flex items-center justify-between">
          <span className="text-sm opacity-85">{currentBlock ? '下一步（已套用的排程）' : '下一步（建議，尚未排程）'}</span>
          {currentBlock && (
            <span className="text-[12px] opacity-80 tnum">
              {formatTime(currentBlock.startAt, tz)}–{formatTime(currentBlock.endAt, tz)}
            </span>
          )}
        </div>
        {nextTask ? (
          <>
            <button type="button" onClick={() => setEditing(nextTask)} className="mt-1 block text-left text-[20px] font-semibold leading-snug">
              {nextTask.title}
              {currentBlock?.isMinimum && <span className="ml-2 align-middle rounded-md bg-white/20 px-1.5 py-0.5 text-xs font-medium">最低版本</span>}
            </button>
            <p className="mt-1 text-sm opacity-90">
              {currentBlock ? currentBlock.reason ?? '依套用的排程' : suggestion?.reason}
              {!currentBlock && ` · 預估 ${formatDuration(nextTask.estimatedMinutes)}`}
              {nextTask.minimumOutcome && (!currentBlock || currentBlock.isMinimum) && ` · 最低成果：${nextTask.minimumOutcome}`}
            </p>
            {suggestion?.warning && (
              <p className="mt-2 flex gap-1.5 rounded-lg bg-black/15 px-3 py-2 text-sm">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {suggestion.warning}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {running?.taskId !== nextTask.id ? (
                <Button className="bg-white/95 text-accent" onClick={() => start(nextTask, currentBlock)}>
                  <Play size={16} /> 開始
                </Button>
              ) : (
                <Button className="bg-white/95 text-accent" onClick={() => finish(nextTask)}>
                  <CircleCheckBig size={16} /> 完成
                </Button>
              )}
              {!currentBlock && (
                <Button className="bg-white/15 text-accent-ink" onClick={() => setPlanToday(true)}>
                  <CalendarClock size={16} /> 規劃今天
                </Button>
              )}
              {currentBlock && (
                <Button className="bg-white/15 text-accent-ink" onClick={() => setBlockStatus(currentBlock.id, 'skipped').then(() => toast.show('已跳過這個區塊'))}>
                  <SkipForward size={16} /> 跳過
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="mt-1 text-[17px] font-medium">今天沒有待辦，或都完成了。</p>
        )}
      </section>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button className="min-h-12" onClick={() => setPlanToday(true)} data-tour="plan-today" data-testid="open-plan-today">
          <CalendarClock size={18} className="text-accent" /> 一鍵排今天
        </Button>
        <Button className="min-h-12" onClick={() => setIncident({ replan: false })} data-tour="incident">
          <AlertTriangle size={18} className="text-warn" /> 我遇到狀況了
        </Button>
      </div>

      {/* 最近套用 / 撤銷 */}
      {latestRevision && (
        <div className="mt-2 flex items-center justify-between rounded-lg bg-surface-2/70 px-3 py-2 text-sm">
          <span className="text-muted">
            {formatTime(latestRevision.appliedAt ?? latestRevision.createdAt, tz)} 套用 · {latestRevision.summary}
          </span>
          <button type="button" onClick={undo} className="flex items-center gap-1 text-accent">
            <Undo2 size={16} /> 撤銷
          </button>
        </div>
      )}

      {/* 今日排程 */}
      {blocks.length > 0 && (
        <Section title="今日排程" aside={missedBlocks.length > 0 ? `${missedBlocks.length} 個區塊已過時，重新規劃可清掉` : undefined}>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {blocks.map((b) => {
              const t = tasksById.get(b.taskId);
              const past = new Date(b.endAt).getTime() <= nowMs;
              const done = b.status === 'done' || t?.status === 'done';
              const skipped = b.status === 'skipped';
              return (
                <li key={b.id} className={cx('flex items-center gap-3 px-3 py-2', (done || skipped || past) && 'text-done')}>
                  <span className="w-24 shrink-0 text-sm tnum">
                    {formatTime(b.startAt, tz)}–{formatTime(b.endAt, tz)}
                  </span>
                  <button type="button" onClick={() => t && setEditing(t)} className="min-w-0 flex-1 text-left">
                    <span className={cx('block truncate text-[15px]', done && 'line-through')}>{t?.title ?? '（任務已刪除）'}</span>
                    {b.reason && !done && <span className="block truncate text-xs text-muted">{b.reason}</span>}
                  </button>
                  {b.isMinimum && !done && <Chip tone="warn">最低</Chip>}
                  {done ? <Chip tone="done">完成</Chip> : skipped ? <Chip>跳過</Chip> : b.status === 'active' ? <Chip tone="accent">進行中</Chip> : past ? <Chip>已過</Chip> : null}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {overdue.length > 0 && (
        <Section title={`逾期未處理（${overdue.length}）`} aside="不會自動消失，請決定怎麼辦">
          <div className="divide-y divide-line rounded-xl border border-warn/40 bg-warn-soft/40 px-3">
            {overdue.map((t) => (
              <OverdueRow key={t.id} task={t} today={today} tz={tz} nowMs={nowMs} onOpen={setEditing} />
            ))}
          </div>
        </Section>
      )}

      <Section
        title={`今天剩餘（${remaining.length}）`}
        aside={
          <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1 text-accent" data-tour="add-task">
            <Plus size={16} /> 新增
          </button>
        }
      >
        {remaining.length === 0 ? (
          <Empty
            title="今天還沒有任務"
            hint="加一件今天要做的事，FlowPlan 就會告訴你現在該做什麼"
            action={
              <Button variant="primary" onClick={() => setCreating(true)} data-testid="dashboard-add-task">
                <Plus size={16} /> 新增任務
              </Button>
            }
          />
        ) : (
          <div className="rounded-xl border border-line bg-surface px-3">
            {remaining.map((t) => (
              <TaskRow key={t.id} task={t} tz={tz} nowMs={nowMs} onOpen={setEditing} />
            ))}
          </div>
        )}
      </Section>

      <Section title={`今天的固定行程（${todayOcc.length}）`} aside={<Link to="/calendar" className="text-accent">日曆</Link>}>
        {todayOcc.length === 0 ? (
          <p className="text-sm text-muted">今天沒有固定行程。</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {todayOcc.map((o) => (
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

      <Section title="時間軸" aside="左：計畫 · 右：實際">
        <div className="rounded-xl border border-line bg-surface p-3 pt-4">
          <DayTimeline
            date={today}
            tz={tz}
            occurrences={todayOcc}
            blocks={blocks.map((b) => ({ ...b, title: tasksById.get(b.taskId)?.title ?? '' }))}
            logs={logs}
            freeWindows={availability.windows}
            nowMs={nowMs}
            rangeStartMin={Math.min(timeToMinutes(settings.workStart), timeToMinutes(toLocalTime(nowMs, tz)))}
            rangeEndMin={timeToMinutes(settings.workEnd) <= timeToMinutes(settings.workStart) ? 1440 : timeToMinutes(settings.workEnd)}
            onOccurrenceClick={setOccEditing}
          />
        </div>
      </Section>

      <ReloginReminder />
      <BackupReminder />

      <TaskForm open={creating} onClose={() => setCreating(false)} defaultDate={today} />
      <TaskForm open={editing !== null} onClose={() => setEditing(null)} task={editing ?? undefined} />
      <EventForm open={occEditing !== null} onClose={() => setOccEditing(null)} event={occForEdit} occurrence={occEditing ?? undefined} />
      <IncidentSheet
        open={incident !== null}
        onClose={() => setIncident(null)}
        today={today}
        tz={tz}
        tasks={tasks}
        occurrences={todayOcc}
        settings={settings}
        energy={daily?.energy}
        activeTaskId={running?.taskId}
        buildProposal={buildProposal}
        startWithReplan={incident?.replan}
      />
      <PlanTodaySheet open={planToday} onClose={() => setPlanToday(false)} tz={tz} buildProposal={buildProposal} />
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

/** 同步開著但憑證沒了（登入過期、被移出清單、登出後沒關同步）→ 提醒重新登入，資料不受影響 */
function ReloginReminder() {
  const settings = useSettings();
  const session = useSession();
  if (!settings.sync.enabled || session || syncConfigured(settings)) return null;
  return (
    <div className="mt-6 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
      <div className="font-medium text-warn">同步已暫停：請重新登入</div>
      <div className="mt-1 text-muted">這台裝置的資料都還在，但在重新登入之前不會與其他裝置同步，AI 助手也暫停。</div>
      <Link to="/settings" className="mt-2 inline-block text-accent">
        前往設定登入
      </Link>
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
