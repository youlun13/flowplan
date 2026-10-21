import { useState } from 'react';
import { AlertTriangle, ArrowRight, Minus, Plus, SkipForward, Sparkles } from 'lucide-react';
import { Button, Chip, cx } from '@/components/ui';
import type { PlanProposal } from '@/engine/planner';
import { deferTask } from '@/db/repo';
import { useToast } from '@/hooks/useToast';
import { addLocalDays, formatDuration, formatTime } from '@/lib/time';

/**
 * 重排方案的預覽：下一步、變更前後對照、完整排程、未安排項目、警示、理由。
 * 這裡只顯示；按「套用」才由呼叫端寫入。
 */
export function ProposalView({ proposal, tz, onApply, onKeep, applying, explain }: { proposal: PlanProposal; tz: string; onApply: () => void; onKeep: () => void; applying?: boolean; explain?: (p: PlanProposal) => Promise<string> }) {
  const toast = useToast();
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);

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
  const { diff, stats } = proposal;
  const hasChange = diff.added.length + diff.moved.length + diff.shortened.length + diff.removed.length > 0 || proposal.effects.createEvent || proposal.effects.completeTaskId || proposal.effects.setEnergy;

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        可用 <span className="text-ink tnum">{formatDuration(stats.availableMinutes)}</span> · 安排 <span className="text-ink tnum">{formatDuration(stats.plannedMinutes)}</span>
        {proposal.unscheduled.length > 0 && (
          <>
            {' '}
            · <span className="text-warn">{proposal.unscheduled.length} 項排不下</span>
          </>
        )}
      </div>

      {proposal.warnings.map((w, i) => (
        <p key={i} className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{w}</span>
        </p>
      ))}

      {!proposal.feasible && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">這個方案不是完整可行的：有今天截止的任務排不進去。你可以先套用其他部分，再決定那項怎麼辦。</p>}

      {/* 下一步 */}
      <section className="rounded-xl bg-accent px-4 py-3 text-accent-ink">
        <div className="text-xs opacity-80">建議的下一步</div>
        {proposal.nextAction ? (
          <>
            <div className="mt-0.5 text-[17px] font-semibold">{proposal.nextAction.block.title}</div>
            <div className="text-sm opacity-90 tnum">
              {formatTime(proposal.nextAction.block.startMs, tz)}–{formatTime(proposal.nextAction.block.endMs, tz)} · {proposal.nextAction.reason}
            </div>
          </>
        ) : (
          <div className="mt-0.5 text-[15px]">今天沒有可以安排的任務。</div>
        )}
      </section>

      {/* 變更 */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">變更</h3>
        {!hasChange && diff.kept.length > 0 && <p className="text-sm text-muted">所有既有安排都還可行，沒有變更。</p>}
        {!hasChange && diff.kept.length === 0 && diff.added.length === 0 && <p className="text-sm text-muted">沒有變更。</p>}
        <ul className="space-y-1 text-sm">
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
                {b.isMinimum && <Chip tone="warn" className="ml-1">最低版本</Chip>}
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
                {u.title}：今天排不進去（{u.reason}）
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
        </ul>
      </section>

      {/* 完整排程 */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">套用後的今日排程</h3>
        {proposal.blocks.length === 0 ? (
          <p className="text-sm text-muted">沒有區塊。</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {proposal.blocks.map((b) => (
              <li key={b.id} className={cx('flex items-center gap-3 px-3 py-2', b.kept && 'text-muted')}>
                <span className="w-24 shrink-0 text-sm tnum">
                  {formatTime(b.startMs, tz)}–{formatTime(b.endMs, tz)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-ink">{b.title}</span>
                  <span className="block truncate text-xs text-muted">{b.reason}</span>
                </span>
                {b.isMinimum && <Chip tone="warn">最低</Chip>}
                {b.kept && <Chip>保留</Chip>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* AI 白話說明（可選） */}
      {explain && (
        <div className="rounded-lg border border-line px-3 py-2 text-sm">
          {explanation ? (
            <p>{explanation}</p>
          ) : (
            <button type="button" onClick={runExplain} disabled={explaining} className="flex items-center gap-1.5 text-accent disabled:opacity-50">
              <Sparkles size={16} /> {explaining ? 'AI 整理中…' : '請 AI 用白話說明這個方案（算一次請求）'}
            </button>
          )}
        </div>
      )}

      {/* 理由 */}
      <details className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
        <summary className="cursor-pointer text-muted">規則引擎的判斷過程</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {proposal.explanation.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>

      <div className="flex gap-2">
        <Button full onClick={onKeep}>
          保留原計畫
        </Button>
        <Button full variant="primary" onClick={onApply} disabled={applying}>
          套用新計畫
        </Button>
      </div>
    </div>
  );
}
