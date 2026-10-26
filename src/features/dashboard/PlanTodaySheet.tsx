/**
 * 一鍵排今天：打開就把今天剩下的任務排好給你看（整天的安排 + 缺點），套用或不要，一個按鈕。
 * 想先休息再開始可以切一下，會重新排。
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Coffee } from 'lucide-react';
import { Button, Chip, ErrorText, Sheet, Toggle, cx } from '@/components/ui';
import { scheduleRows } from './ProposalView';
import { applyProposal } from '@/db/plan';
import { deferTask } from '@/db/repo';
import type { Incident, PlanProposal } from '@/engine/planner';
import { BREAK_MINUTES, downsidesOf, type BuildArgs } from '@/engine/options';
import { useToast } from '@/hooks/useToast';
import { addLocalDays, formatDuration, formatTime } from '@/lib/time';

export interface PlanTodaySheetProps {
  open: boolean;
  onClose: () => void;
  tz: string;
  buildProposal: (incident?: Incident, args?: BuildArgs) => PlanProposal;
}

export function PlanTodaySheet({ open, onClose, tz, buildProposal }: PlanTodaySheetProps) {
  const toast = useToast();
  const [restFirst, setRestFirst] = useState(false);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    try {
      setProposal(buildProposal({ type: 'replan' }, restFirst ? { restFirstMinutes: BREAK_MINUTES } : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法產生安排');
    }
  }, [open, restFirst, buildProposal]);

  const rows = useMemo(() => (proposal ? scheduleRows(proposal) : []), [proposal]);
  const downsides = useMemo(() => (proposal ? downsidesOf(proposal, tz) : []), [proposal, tz]);
  const hasTasks = Boolean(proposal && proposal.blocks.length > 0);

  async function apply() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      const rev = await applyProposal(proposal, { nowMs: Date.now(), tz });
      toast.show(`今天排好了（${rev.summary}）`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '套用失敗');
    } finally {
      setApplying(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="今天這樣排">
      <ErrorText>{error}</ErrorText>
      {proposal && (
        <div className="space-y-4" data-testid="plan-today">
          <div className="text-[15px] text-muted">
            從現在到 {formatTime(proposal.availability.workWindow.end, tz)} 還有 <span className="text-ink tnum">{formatDuration(proposal.stats.availableMinutes)}</span>，安排了{' '}
            <span className="text-ink tnum">{formatDuration(proposal.stats.plannedMinutes)}</span>
            {proposal.unscheduled.length > 0 && <span className="text-warn">，{proposal.unscheduled.length} 件排不下</span>}。
          </div>

          <Toggle checked={restFirst} onChange={setRestFirst} label={`先休息 ${BREAK_MINUTES} 分鐘再開始`} />

          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[15px] text-muted">今天沒有可以排的任務。先到「任務」加幾件今天要做的事。</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {rows.map((r) => (
                <li key={r.key} className={cx('flex items-start gap-3 px-3 py-2.5', r.kind !== 'block' && 'text-muted')}>
                  <span className="w-[6.6rem] shrink-0 text-[15px] leading-6 tnum">
                    {formatTime(r.startMs, tz)}–{formatTime(r.endMs, tz)}
                  </span>
                  <span className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-[16px] leading-6', r.kind === 'block' && 'text-ink')}>
                    {r.kind === 'rest' && <Coffee size={16} className="shrink-0 text-hard" />}
                    <span className="truncate">{r.title}</span>
                  </span>
                  {r.kind === 'event' && <Chip tone="hard" className="mt-1">行程</Chip>}
                  {r.segments && r.segments > 1 && <Chip className="mt-1">{r.segments} 段</Chip>}
                  {r.isMinimum && <Chip tone="warn" className="mt-1">最低</Chip>}
                </li>
              ))}
            </ul>
          )}

          {downsides.length > 0 && (
            <div>
              <div className="mb-1.5 text-[16px] font-semibold">缺點</div>
              <ul className="space-y-2 text-[15px]">
                {downsides.map((d, i) => (
                  <li key={i} className="flex gap-2">
                    <AlertTriangle size={18} className={cx('mt-0.5 shrink-0', d.severe ? 'text-danger' : 'text-warn')} />
                    <span>
                      {d.text}
                      {d.deferTaskId && d.deferTitle && (
                        <button type="button" className="ml-1 text-accent underline-offset-2 hover:underline" onClick={() => deferTask(d.deferTaskId!, addLocalDays(proposal.date, 1)).then(() => toast.show(`已把「${d.deferTitle}」延到明天`))}>
                          延到明天
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            <Button full className="min-h-12 text-[16px]" onClick={onClose} data-testid="plan-today-cancel">
              不要
            </Button>
            <Button variant="primary" full className="min-h-12 text-[17px]" onClick={apply} disabled={applying || !hasTasks} data-testid="plan-today-apply">
              <Check size={18} /> 套用這個安排
            </Button>
          </div>
          <p className="text-[13px] text-muted">套用後「今日」頁會出現今日排程；還能撤銷。狀況改變時用「我遇到狀況了」重排。</p>
        </div>
      )}
    </Sheet>
  );
}
