import { useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Minus, Plus, SkipForward, Sparkles } from 'lucide-react';
import { Button, Chip, cx } from '@/components/ui';
import type { PlanProposal } from '@/engine/planner';
import type { PlanOption } from '@/engine/options';
import { deferTask } from '@/db/repo';
import { useToast } from '@/hooks/useToast';
import { addLocalDays, formatDuration, formatTime } from '@/lib/time';

/**
 * 重排結果：只回答「現在要做什麼」。
 * 一或兩張卡片（建議 / 另一個選擇），每張：先做什麼、幾點到幾點、為什麼、之後接著什麼、對其他事的影響、「就這個」。
 * 變更對照、完整安排、判斷過程、AI 說明都收在卡片裡的「細節」。
 */
export function ProposalView({ options, tz, onApply, onKeep, applying, explain }: { options: PlanOption[]; tz: string; onApply: (p: PlanProposal) => void; onKeep: () => void; applying?: boolean; explain?: (p: PlanProposal) => Promise<string> }) {
  const a = options[0].proposal;
  const urgent = a.warnings.filter((w) => w.includes('截止') || w.includes('時間不夠'));

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted">
        今天還有 <span className="text-ink tnum">{formatDuration(a.stats.availableMinutes)}</span> 可用
        {a.stats.candidateMinutes > a.stats.availableMinutes && <span className="text-warn">，要做的事需要 {formatDuration(a.stats.candidateMinutes)}</span>}
      </div>
      {urgent.length > 0 && (
        <p className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{urgent[0]}</span>
        </p>
      )}

      <h3 className="pt-1 text-[15px] font-semibold">現在要做什麼？</h3>
      {options.map((o) => (
        <OptionCard key={o.key} option={o} tz={tz} onPick={() => onApply(o.proposal)} applying={applying} explain={explain} recommended={o.key === 'A'} />
      ))}

      <button type="button" className="w-full py-2 text-sm text-muted" onClick={onKeep}>
        都不要，保留原計畫
      </button>
    </div>
  );
}

function OptionCard({ option, tz, onPick, applying, explain, recommended }: { option: PlanOption; tz: string; onPick: () => void; applying?: boolean; explain?: (p: PlanProposal) => Promise<string>; recommended: boolean }) {
  const p = option.proposal;
  const next = p.nextAction;
  return (
    <section className={cx('rounded-xl border p-4', recommended ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface')} data-testid={`option-${option.key}`}>
      <div className="flex items-center justify-between">
        <span className={cx('text-xs font-medium', recommended ? 'text-accent' : 'text-muted')}>{option.label}</span>
        {!p.feasible && <Chip tone="danger">有截止趕不上</Chip>}
      </div>
      {next ? (
        <>
          <div className="mt-1 text-[19px] font-semibold leading-tight">{next.block.title}</div>
          <div className="mt-1 text-sm tnum">
            {formatTime(next.block.startMs, tz)}–{formatTime(next.block.endMs, tz)}
            {next.block.isMinimum && <Chip tone="warn" className="ml-1.5">最低版本</Chip>}
          </div>
          <div className="mt-0.5 text-xs text-muted">{next.reason}</div>
        </>
      ) : (
        <div className="mt-1 text-[15px]">今天沒有可以安排的任務</div>
      )}
      <div className="mt-3 space-y-0.5 text-xs text-muted">
        {option.after && <div>之後：{option.after}</div>}
        <div>影響：{option.consequence}</div>
      </div>
      <Button variant="primary" full className="mt-3" onClick={onPick} disabled={applying}>
        <Check size={16} /> 就這個
      </Button>
      <Details proposal={p} tz={tz} explain={explain} />
    </section>
  );
}

function Details({ proposal, tz, explain }: { proposal: PlanProposal; tz: string; explain?: (p: PlanProposal) => Promise<string> }) {
  const toast = useToast();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const { diff } = proposal;

  async function runExplain() {
    if (!explain) return;
    setExplaining(true);
    try {
      setExplanation(await explain(proposal));
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'AI 說明失敗', 'danger');
    } finally {
      setExplaining(false);
    }
  }

  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer py-1 text-xs text-muted">細節：完整安排、變更、判斷過程</summary>
      <div className="mt-2 space-y-3">
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">套用後的今日安排</div>
          {proposal.blocks.length === 0 ? (
            <p className="text-sm text-muted">沒有區塊。</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {proposal.blocks.map((b) => (
                <li key={b.id} className={cx('flex items-center gap-3 px-3 py-1.5', b.kept && 'text-muted')}>
                  <span className="w-[5.5rem] shrink-0 text-xs tnum">
                    {formatTime(b.startMs, tz)}–{formatTime(b.endMs, tz)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{b.title}</span>
                  {b.isMinimum && <Chip tone="warn">最低</Chip>}
                  {b.kept && <Chip>不變</Chip>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold text-muted">變更</div>
          <ul className="space-y-1">
            {proposal.effects.createEvent && (
              <li className="flex gap-2">
                <Plus size={16} className="mt-0.5 shrink-0 text-hard" />
                <span>
                  加入固定行程「{proposal.effects.createEvent.title}」{formatTime(proposal.effects.createEvent.startMs, tz)}–{formatTime(proposal.effects.createEvent.endMs, tz)}
                </span>
              </li>
            )}
            {proposal.effects.completeTaskId && (
              <li className="flex gap-2">
                <Minus size={16} className="mt-0.5 shrink-0 text-done" />
                <span>標記任務完成</span>
              </li>
            )}
            {diff.added.map((b) => (
              <li key={b.id} className="flex gap-2">
                <Plus size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  <span className="tnum">{formatTime(b.startMs, tz)}–{formatTime(b.endMs, tz)}</span> {b.title}
                </span>
              </li>
            ))}
            {diff.moved.map(({ block, fromStartMs, fromEndMs }) => (
              <li key={block.id} className="flex gap-2">
                <ArrowRight size={16} className="mt-0.5 shrink-0 text-warn" />
                <span>
                  {block.title}：<span className="text-muted line-through tnum">{formatTime(fromStartMs, tz)}–{formatTime(fromEndMs, tz)}</span> →{' '}
                  <span className="tnum">{formatTime(block.startMs, tz)}–{formatTime(block.endMs, tz)}</span>
                </span>
              </li>
            ))}
            {diff.shortened.map((s) => (
              <li key={s.taskId} className="flex gap-2">
                <Minus size={16} className="mt-0.5 shrink-0 text-warn" />
                <span>
                  {s.title}：{formatDuration(s.fromMinutes)} → {formatDuration(s.toMinutes)}
                </span>
              </li>
            ))}
            {diff.removed
              .filter((r) => !diff.moved.some((m) => m.block.taskId === r.taskId))
              .map((r) => (
                <li key={r.id} className="flex gap-2">
                  <Minus size={16} className="mt-0.5 shrink-0 text-danger" />
                  <span>
                    移除 <span className="tnum">{formatTime(r.startAt, tz)}–{formatTime(r.endAt, tz)}</span> 的區塊
                  </span>
                </li>
              ))}
            {diff.deferred.map((u) => (
              <li key={u.taskId} className="flex gap-2">
                <SkipForward size={16} className="mt-0.5 shrink-0 text-danger" />
                <span>
                  {u.title}：{u.reason}
                  {u.suggestion === 'defer_tomorrow' && (
                    <button
                      type="button"
                      className="ml-1 text-accent underline-offset-2 hover:underline"
                      onClick={() => deferTask(u.taskId, addLocalDays(proposal.date, 1)).then(() => toast.show(`已把「${u.title}」延到明天`))}
                    >
                      延到明天
                    </button>
                  )}
                </span>
              </li>
            ))}
            {diff.added.length + diff.moved.length + diff.shortened.length + diff.removed.length + diff.deferred.length === 0 && !proposal.effects.createEvent && !proposal.effects.completeTaskId && (
              <li className="text-muted">沒有變更。</li>
            )}
          </ul>
        </div>

        {proposal.warnings.length > 0 && (
          <ul className="space-y-1">
            {proposal.warnings.map((w, i) => (
              <li key={i} className="flex gap-2 text-warn">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        <div>
          <div className="mb-1 text-xs font-semibold text-muted">規則引擎的判斷過程</div>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            {proposal.explanation.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>

        {explain && (
          <div className="rounded-lg border border-line px-3 py-2">
            {explanation ? (
              <p>{explanation}</p>
            ) : (
              <button type="button" onClick={runExplain} disabled={explaining} className="flex items-center gap-1.5 text-accent disabled:opacity-50">
                <Sparkles size={16} /> {explaining ? 'AI 整理中…' : '請 AI 用白話說明（算一次請求）'}
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
