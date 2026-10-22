import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Wand2 } from 'lucide-react';
import { Button, Chip, ErrorText, Field, Input, Segmented, Select, Sheet, Textarea, cx } from '@/components/ui';
import { ProposalView } from './ProposalView';
import { ENERGY_LABEL, type Energy, type Settings, type Task } from '@/db/schema';
import { applyProposal } from '@/db/plan';
import { INCIDENT_LABEL, type Incident, type PlanProposal } from '@/engine/planner';
import { buildOptions, type BuildArgs, type PlanOption } from '@/engine/options';
import type { Occurrence } from '@/engine/recurrence';
import { aiReady, resolveIncidentText } from '@/ai/resolve';
import { estimateCostUsd, formatUsd } from '@/ai/pricing';
import type { ParsedIncident, ResolveResult } from '@/ai/types';
import { useToast } from '@/hooks/useToast';
import { isOpen } from '@/lib/select';
import { localDateTimeToMs, minutesToTime, timeToMinutes, toLocalTime, type LocalDate } from '@/lib/time';

type Kind = Incident['type'];
const KINDS: Kind[] = ['overslept', 'lost_time', 'energy', 'task_done', 'overrun', 'rest', 'replan'];
const EXAMPLES = ['我睡到十一點', '下午三點到五點臨時有事', '線代習題寫完了', '現在很累', '報告超時還要 40 分鐘'];

export interface IncidentSheetProps {
  open: boolean;
  onClose: () => void;
  today: LocalDate;
  tz: string;
  tasks: Task[];
  occurrences: Occurrence[];
  settings: Settings;
  energy?: Energy;
  activeTaskId?: string;
  buildProposal: (incident?: Incident, args?: BuildArgs) => PlanProposal;
  /** 直接以「重新規劃」開啟並跳到預覽 */
  startWithReplan?: boolean;
}

/**
 * 「我遇到狀況了」
 * 1. 自然語言：規則解析 → （AI）→ 顯示「理解到的狀態」給你確認
 * 2. 結構化表單（永遠可用）
 * 3. 預覽方案 → 套用 / 保留
 */
export function IncidentSheet({ open, onClose, today, tz, tasks, occurrences, settings, energy: dailyEnergy, activeTaskId, buildProposal, startWithReplan }: IncidentSheetProps) {
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
  const [options, setOptions] = useState<PlanOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const [nlText, setNlText] = useState('');
  const [resolving, setResolving] = useState(false);
  const [understood, setUnderstood] = useState<ResolveResult | null>(null);
  const [showForm, setShowForm] = useState(false);

  const ai = aiReady(settings);
  const openTasks = useMemo(() => tasks.filter((t) => isOpen(t) && (t.plannedDate === today || t.status === 'in_progress' || !t.plannedDate)), [tasks, today]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNlText('');
    setUnderstood(null);
    setShowForm(false);
    const t = toLocalTime(Date.now(), tz);
    setWakeTime(t);
    setLostStart(t);
    setLostEnd(minutesToTime(timeToMinutes(t) + 120));
    setLostTitle('');
    setTaskId(activeTaskId ?? openTasks.find((x) => x.status === 'in_progress')?.id ?? openTasks[0]?.id ?? '');
    if (startWithReplan) {
      setKind('replan');
      setOptions(buildOptions((args) => buildProposal({ type: 'replan' }, args), { tz, tasks, nowMs: Date.now() }));
    } else {
      setKind('overslept');
      setOptions(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function prefill(p: ParsedIncident) {
    if (p.type !== 'unknown') setKind(p.type);
    if (p.wakeTime) setWakeTime(p.wakeTime);
    if (p.startTime) setLostStart(p.startTime);
    if (p.endTime) setLostEnd(p.endTime);
    if (p.title) setLostTitle(p.title);
    if (p.energy) setEnergy(p.energy);
    if (p.taskId) setTaskId(p.taskId);
    if (p.remainingMinutes) setRemaining(String(p.remainingMinutes));
    if (p.minutes) setRestMinutes(String(p.minutes));
  }

  async function resolve() {
    const text = nlText.trim();
    if (!text) return;
    setError(null);
    setResolving(true);
    try {
      const r = await resolveIncidentText(text, { nowMs: Date.now(), tz, tasks, occurrences, settings, energy: dailyEnergy });
      setUnderstood(r);
      prefill(r.parsed);
      setShowForm(!r.incident);
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析失敗');
      setShowForm(true);
    } finally {
      setResolving(false);
    }
  }

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

  function preview(incident?: Incident) {
    setError(null);
    try {
      const inc = incident ?? makeIncident();
      if ((inc.type === 'task_done' || inc.type === 'overrun') && !inc.taskId) throw new Error('請選擇任務');
      setOptions(buildOptions((args) => buildProposal(inc, args), { tz, tasks, nowMs: Date.now(), alreadyResting: inc.type === 'rest' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法產生方案');
    }
  }

  async function apply(proposal: PlanProposal) {
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

  const title = options ? `重排 · ${INCIDENT_LABEL[options[0].proposal.trigger]}` : '我遇到狀況了';

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ErrorText>{error}</ErrorText>
      {options ? (
        <div className="mt-2">
          <ProposalView options={options} tz={tz} onApply={apply} onKeep={onClose} applying={applying} />
          <button type="button" className="w-full py-2 text-sm text-muted" onClick={() => setOptions(null)}>
            修改狀況描述
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 自然語言 */}
          <div className="rounded-xl border border-line bg-surface p-3">
            <Textarea
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              rows={2}
              placeholder="用一句話說發生什麼事，例如：我睡到十一點"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void resolve();
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => setNlText(ex)} className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-xs text-muted">
                    {ex}
                  </button>
                ))}
              </div>
              <Button variant="primary" onClick={resolve} disabled={resolving || !nlText.trim()} className="shrink-0 whitespace-nowrap">
                <Wand2 size={16} /> {resolving ? '解析中…' : '解析'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">
              {ai.ok ? '先用規則解析；看不懂才會呼叫 AI，解析結果會先給你確認。' : '目前只用規則解析（AI 未啟用，可在設定頁開啟）。'}
            </p>
          </div>

          {/* 理解到的狀態 */}
          {understood && (
            <div className={cx('rounded-xl border p-3', understood.incident ? 'border-accent/40 bg-accent-soft/50' : 'border-warn/40 bg-warn-soft/50')}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{understood.incident ? '理解到的狀態' : '還缺一點資訊'}</span>
                <Chip tone={understood.source === 'ai' ? 'accent' : 'neutral'}>{understood.source === 'ai' ? 'AI' : '規則'}</Chip>
                {understood.usage && understood.model && <Chip>{formatUsd(estimateCostUsd(understood.model, understood.usage.inputTokens, understood.usage.outputTokens))}</Chip>}
                <Chip>{INCIDENT_LABEL[understood.parsed.type as Kind] ?? '無法判斷'}</Chip>
              </div>
              <p className="mt-1 text-[15px]">{understood.parsed.note || '（沒有說明）'}</p>
              {understood.notice && <p className="mt-1 text-xs text-warn">{understood.notice}</p>}
              {understood.incident && (
                <div className="mt-2 flex gap-2">
                  <Button variant="primary" onClick={() => preview(understood.incident)}>
                    正確，看看怎麼辦
                  </Button>
                  <Button onClick={() => setShowForm(true)}>改一下</Button>
                </div>
              )}
              {!understood.incident && <p className="mt-1 text-xs text-muted">已把理解到的部分填進下方表單，補完再按「看看怎麼辦」。</p>}
            </div>
          )}

          {/* 結構化表單 */}
          {(showForm || !understood) && (
            <>
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

              <Button full variant="primary" onClick={() => preview()}>
                <Sparkles size={16} /> 看看怎麼辦
              </Button>
            </>
          )}
          <p className="text-xs text-muted">預覽不會改動任何資料；看完可以套用、保留原計畫，套用後還能撤銷。</p>
        </div>
      )}
    </Sheet>
  );
}
