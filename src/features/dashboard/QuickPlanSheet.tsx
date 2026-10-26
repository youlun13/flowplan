/**
 * 快速排今天：把要做的事打出來（一行一件），解析成任務 → 加入今天 → 立刻給「拚了 / 先喘口氣」兩個方案。
 * 套用與否由使用者決定；不套用時任務仍留在今天的清單裡。
 */
import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, Chip, ErrorText, Sheet, Textarea } from '@/components/ui';
import { ProposalView } from './ProposalView';
import { PRIORITY_LABEL, type Settings, type Task } from '@/db/schema';
import { createTask } from '@/db/repo';
import { db } from '@/db/db';
import { applyProposal } from '@/db/plan';
import type { Incident, PlanProposal } from '@/engine/planner';
import { buildOptions, type BuildArgs, type PlanOption } from '@/engine/options';
import { parseQuickTasks, quickTaskDueAt } from '@/engine/quickTasks';
import { useToast } from '@/hooks/useToast';
import { formatDuration, type LocalDate } from '@/lib/time';

export interface QuickPlanSheetProps {
  open: boolean;
  onClose: () => void;
  today: LocalDate;
  tz: string;
  settings: Settings;
  buildProposalWith: (tasks: Task[], incident?: Incident, args?: BuildArgs) => PlanProposal;
}

const PLACEHOLDER = `一行一件，可以順手寫時間和截止：
讀英文 60
寫報告 1.5h 17:00前 !
整理筆記 30
背單字`;

export function QuickPlanSheet({ open, onClose, today, tz, settings, buildProposalWith }: QuickPlanSheetProps) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [options, setOptions] = useState<PlanOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseQuickTasks(text), [text]);
  const total = parsed.reduce((s, t) => s + t.estimatedMinutes, 0);

  function reset() {
    setText('');
    setOptions(null);
    setError(null);
    setBusy(false);
  }

  async function addAndPlan() {
    if (parsed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const t of parsed) {
        await createTask({ title: t.title, estimatedMinutes: t.estimatedMinutes, priority: t.priority, plannedDate: today, dueAt: quickTaskDueAt(t, today, tz) });
      }
      const fresh = await db.tasks.toArray();
      const opts = buildOptions((args) => buildProposalWith(fresh, { type: 'replan' }, args), { tz, tasks: fresh, nowMs: Date.now() });
      setOptions(opts);
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法加入');
    } finally {
      setBusy(false);
    }
  }

  async function apply(p: PlanProposal) {
    setBusy(true);
    try {
      const rev = await applyProposal(p, { nowMs: Date.now(), tz });
      toast.show(`已加入 ${parsed.length} 件並套用（${rev.summary}）`);
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '套用失敗');
    } finally {
      setBusy(false);
    }
  }

  function keep() {
    toast.show(`已加入 ${parsed.length} 件到今天，沒有排程`);
    reset();
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (options) keep();
        else {
          reset();
          onClose();
        }
      }}
      title={options ? '今天這樣排好嗎？' : '今天要做什麼？'}
    >
      <ErrorText>{error}</ErrorText>
      {options ? (
        <div className="mt-2">
          <p className="mb-3 text-[15px] text-muted">已把 {parsed.length} 件加進今天。選一個方案套用，或不排程、只留任務。</p>
          <ProposalView options={options} tz={tz} onApply={apply} onKeep={keep} applying={busy} keepLabel="只加任務，不排程" />
        </div>
      ) : (
        <div className="space-y-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={PLACEHOLDER} autoFocus className="text-[16px]" data-testid="quick-text" />
          <p className="text-[13px] text-muted">
            寫法：名稱後面接時間（60、1.5h、30分），「17:00前」是截止，「!」是優先級高，「低」是不急。沒寫時間就當 {formatDuration(30)}。
          </p>
          {parsed.length > 0 && (
            <div className="rounded-xl border border-line bg-surface">
              <ul className="divide-y divide-line">
                {parsed.map((t, i) => (
                  <li key={i} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[15px]">{t.title}</span>
                    {t.priority !== 'P2' && <Chip tone={t.priority === 'P1' ? 'warn' : 'neutral'}>{PRIORITY_LABEL[t.priority]}</Chip>}
                    {t.dueTime && <Chip tone="danger">{t.dueTime} 前</Chip>}
                    <span className={t.explicitMinutes ? 'text-[15px] tnum' : 'text-[15px] text-muted tnum'}>{formatDuration(t.estimatedMinutes)}</span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-3 py-2 text-[13px] text-muted">
                共 {parsed.length} 件 · {formatDuration(total)}
                {settings.workEnd && ` · 可工作到 ${settings.workEnd}`}
              </div>
            </div>
          )}
          <Button variant="primary" full className="min-h-12 text-[17px]" onClick={addAndPlan} disabled={busy || parsed.length === 0} data-testid="quick-plan">
            <Sparkles size={18} /> 加入並幫我排今天
          </Button>
          <p className="text-[13px] text-muted">排出來的只是建議，看完再決定要不要套用；已經在今天清單裡的任務也會一起排。</p>
        </div>
      )}
    </Sheet>
  );
}
