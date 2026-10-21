import { useEffect, useMemo, useState } from 'react';
import { Button, ErrorText, Field, Input, Segmented, Select, Sheet, cx } from '@/components/ui';
import { ProposalView } from './ProposalView';
import { ENERGY_LABEL, type Energy, type Task } from '@/db/schema';
import { applyProposal } from '@/db/plan';
import { INCIDENT_LABEL, type Incident, type PlanProposal } from '@/engine/planner';
import { useToast } from '@/hooks/useToast';
import { isOpen } from '@/lib/select';
import { localDateTimeToMs, minutesToTime, timeToMinutes, toLocalTime, type LocalDate } from '@/lib/time';

type Kind = Incident['type'];
const KINDS: Kind[] = ['overslept', 'lost_time', 'energy', 'task_done', 'overrun', 'rest', 'replan'];

export interface IncidentSheetProps {
  open: boolean;
  onClose: () => void;
  today: LocalDate;
  tz: string;
  tasks: Task[];
  activeTaskId?: string;
  buildProposal: (incident?: Incident) => PlanProposal;
  /** 直接以「重新規劃」開啟並跳到預覽 */
  startWithReplan?: boolean;
}

/**
 * 「我遇到狀況了」：結構化表單（零 AI）。
 * 第三階段的自然語言輸入只是把這張表自動填好，所以這條路永遠可用。
 */
export function IncidentSheet({ open, onClose, today, tz, tasks, activeTaskId, buildProposal, startWithReplan }: IncidentSheetProps) {
  const toast = useToast();
  const nowTime = toLocalTime(Date.now(), tz);
  const [kind, setKind] = useState<Kind>('overslept');
  const [wakeTime, setWakeTime] = useState(nowTime);
  const [lostStart, setLostStart] = useState(nowTime);
  const [lostEnd, setLostEnd] = useState(minutesToTime(timeToMinutes(nowTime) + 120));
  const [lostTitle, setLostTitle] = useState('');
  const [energy, setEnergy] = useState<Energy>('low');
  const [taskId, setTaskId] = useState('');
  const [remaining, setRemaining] = useState('30');
  const [restMinutes, setRestMinutes] = useState('20');
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const openTasks = useMemo(() => tasks.filter((t) => isOpen(t) && (t.plannedDate === today || t.status === 'in_progress' || !t.plannedDate)), [tasks, today]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const t = toLocalTime(Date.now(), tz);
    setWakeTime(t);
    setLostStart(t);
    setLostEnd(minutesToTime(timeToMinutes(t) + 120));
    setTaskId(activeTaskId ?? openTasks.find((x) => x.status === 'in_progress')?.id ?? openTasks[0]?.id ?? '');
    if (startWithReplan) {
      setKind('replan');
      setProposal(buildProposal({ type: 'replan' }));
    } else {
      setKind('overslept');
      setProposal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function makeIncident(): Incident {
    switch (kind) {
      case 'overslept':
        return { type: 'overslept', wakeTime };
      case 'lost_time': {
        const startMs = localDateTimeToMs(today, lostStart, tz);
        let endMs = localDateTimeToMs(today, lostEnd, tz);
        if (endMs <= startMs) endMs += 24 * 3_600_000;
        return { type: 'lost_time', startMs, endMs, title: lostTitle };
      }
      case 'energy':
        return { type: 'energy', energy };
      case 'task_done':
        return { type: 'task_done', taskId };
      case 'overrun':
        return { type: 'overrun', taskId, remainingMinutes: Number(remaining) || 30 };
      case 'rest':
        return { type: 'rest', minutes: Number(restMinutes) || 20 };
      default:
        return { type: 'replan' };
    }
  }

  function preview() {
    setError(null);
    try {
      if ((kind === 'task_done' || kind === 'overrun') && !taskId) throw new Error('請選擇任務');
      setProposal(buildProposal(makeIncident()));
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法產生方案');
    }
  }

  async function apply() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      const rev = await applyProposal(proposal, { nowMs: Date.now(), tz });
      toast.show(`已套用新計畫（${rev.summary}）`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '套用失敗');
    } finally {
      setApplying(false);
    }
  }

  const title = proposal ? `重排預覽 · ${INCIDENT_LABEL[proposal.trigger]}` : '我遇到狀況了';

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ErrorText>{error}</ErrorText>
      {proposal ? (
        <div className="mt-2">
          <ProposalView proposal={proposal} tz={tz} onApply={apply} onKeep={onClose} applying={applying} />
          <button type="button" className="mt-3 w-full py-2 text-sm text-muted" onClick={() => setProposal(null)}>
            修改狀況描述
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={cx('rounded-lg px-3 py-2 text-sm font-medium', kind === k ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}
              >
                {INCIDENT_LABEL[k]}
              </button>
            ))}
          </div>

          {kind === 'overslept' && (
            <Field label="實際起床時間" hint="系統會從現在開始，用剩餘的可用時間重排">
              <Input type="time" value={wakeTime} onChange={(e) => setWakeTime(e.target.value)} />
            </Field>
          )}
          {kind === 'lost_time' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="從">
                  <Input type="time" value={lostStart} onChange={(e) => setLostStart(e.target.value)} />
                </Field>
                <Field label="到">
                  <Input type="time" value={lostEnd} onChange={(e) => setLostEnd(e.target.value)} />
                </Field>
              </div>
              <Field label="是什麼事（選填）" hint="套用後會以固定行程加進日曆">
                <Input value={lostTitle} onChange={(e) => setLostTitle(e.target.value)} placeholder="臨時有事" />
              </Field>
            </>
          )}
          {kind === 'energy' && (
            <Field label="現在的精力">
              <Segmented value={energy} onChange={setEnergy} className="w-full" options={(['high', 'medium', 'low'] as Energy[]).map((e) => ({ value: e, label: ENERGY_LABEL[e] }))} />
            </Field>
          )}
          {(kind === 'task_done' || kind === 'overrun') && (
            <Field label={kind === 'task_done' ? '哪一件做完了' : '哪一件超時了'}>
              <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                {openTasks.length === 0 && <option value="">沒有未完成的任務</option>}
                {openTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                    {t.status === 'in_progress' ? '（進行中）' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === 'overrun' && (
            <Field label="還需要多少分鐘">
              <Input type="number" inputMode="numeric" min={5} step={5} value={remaining} onChange={(e) => setRemaining(e.target.value)} />
            </Field>
          )}
          {kind === 'rest' && (
            <Field label="休息幾分鐘">
              <Input type="number" inputMode="numeric" min={5} step={5} value={restMinutes} onChange={(e) => setRestMinutes(e.target.value)} />
            </Field>
          )}
          {kind === 'replan' && <p className="text-sm text-muted">不改變任何狀態，只依目前的任務、行程與精力重新計算今天剩下的時間。</p>}

          <Button full variant="primary" onClick={preview}>
            看看怎麼辦
          </Button>
          <p className="text-xs text-muted">預覽不會改動任何資料；看完可以套用、保留原計畫，套用後還能撤銷。</p>
        </div>
      )}
    </Sheet>
  );
}
