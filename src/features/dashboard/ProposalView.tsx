import { AlertTriangle, Check } from 'lucide-react';
import { Button, Chip, cx } from '@/components/ui';
import type { PlanProposal } from '@/engine/planner';
import { downsidesOf, type PlanOption } from '@/engine/options';
import { deferTask } from '@/db/repo';
import { useToast } from '@/hooks/useToast';
import { addLocalDays, formatDuration, formatTime } from '@/lib/time';

/**
 * 重排結果：只回答「現在要做什麼」。
 * 一或兩張卡片（建議 / 另一個選擇），每張：先做什麼、幾點到幾點、為什麼、之後接著什麼、對其他事的影響、「就這個」。
 * 「細節」只放兩樣：套用後今日安排、缺點（做不完的、趕不上的、只做最低版本的、被改時間的）。
 */
export function ProposalView({ options, tz, onApply, onKeep, applying }: { options: PlanOption[]; tz: string; onApply: (p: PlanProposal) => void; onKeep: () => void; applying?: boolean }) {
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
        <OptionCard key={o.key} option={o} tz={tz} onPick={() => onApply(o.proposal)} applying={applying} recommended={o.key === 'A'} />
      ))}

      <button type="button" className="w-full py-2 text-sm text-muted" onClick={onKeep}>
        都不要，保留原計畫
      </button>
    </div>
  );
}

function OptionCard({ option, tz, onPick, applying, recommended }: { option: PlanOption; tz: string; onPick: () => void; applying?: boolean; recommended: boolean }) {
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
      <Details proposal={p} tz={tz} />
    </section>
  );
}

function Details({ proposal, tz }: { proposal: PlanProposal; tz: string }) {
  const toast = useToast();
  const downsides = downsidesOf(proposal, tz);

  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer py-1 text-xs text-muted">細節：套用後今日安排、缺點</summary>
      <div className="mt-2 space-y-3">
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">套用後今日安排</div>
          {(() => {
            const rows = scheduleRows(proposal);
            return rows.length === 0 ? (
              <p className="text-sm text-muted">沒有安排。</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {rows.map((r) => (
                  <li key={r.key} className={cx('flex items-center gap-3 px-3 py-1.5', r.kind !== 'block' && 'text-muted')}>
                    <span className="w-[5.5rem] shrink-0 text-xs tnum">
                      {formatTime(r.startMs, tz)}–{formatTime(r.endMs, tz)}
                    </span>
                    <span className={cx('min-w-0 flex-1 truncate text-sm', r.kind === 'block' && 'text-ink')}>{r.title}</span>
                    {r.kind === 'event' && <Chip tone="hard">行程</Chip>}
                    {r.kind === 'incident' && <Chip tone="hard">新行程</Chip>}
                    {r.kind === 'rest' && <Chip>休息</Chip>}
                    {r.segments && r.segments > 1 && <Chip>{r.segments} 段</Chip>}
                    {r.isMinimum && <Chip tone="warn">最低</Chip>}
                  </li>
                ))}
              </ul>
            );
          })()}
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold text-muted">缺點</div>
          {downsides.length === 0 ? (
            <p className="text-muted">沒有明顯缺點：所有事都排得下，也沒有改時間。</p>
          ) : (
            <ul className="space-y-1">
              {downsides.map((d, i) => (
                <li key={i} className="flex gap-2">
                  <AlertTriangle size={16} className={cx('mt-0.5 shrink-0', d.severe ? 'text-danger' : 'text-warn')} />
                  <span>
                    {d.text}
                    {d.deferTaskId && d.deferTitle && (
                      <button
                        type="button"
                        className="ml-1 text-accent underline-offset-2 hover:underline"
                        onClick={() => deferTask(d.deferTaskId!, addLocalDays(proposal.date, 1)).then(() => toast.show(`已把「${d.deferTitle}」延到明天`))}
                      >
                        延到明天
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}

interface ScheduleRow {
  key: string;
  kind: 'block' | 'event' | 'incident' | 'rest';
  title: string;
  startMs: number;
  endMs: number;
  isMinimum?: boolean;
  /** 同一任務連續幾段（中間只隔休息）合併成一列 */
  segments?: number;
}

const MERGE_GAP_MS = 20 * 60_000;

/** 任務區塊 + 固定行程（含狀況加入的行程、休息）依時間排在一起；只列還沒結束的；同任務連續幾段合併 */
export function scheduleRows(p: PlanProposal): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const blocks = p.blocks.slice().sort((a, b) => a.startMs - b.startMs);
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (last && last.kind === 'block' && last.title === b.title && b.startMs - last.endMs <= MERGE_GAP_MS) {
      last.endMs = b.endMs;
      last.segments = (last.segments ?? 1) + 1;
      last.isMinimum = last.isMinimum || b.isMinimum;
      continue;
    }
    rows.push({ key: b.id, kind: 'block', title: b.title, startMs: b.startMs, endMs: b.endMs, isMinimum: b.isMinimum });
  }
  p.busy
    .filter((b) => b.endMs > p.generatedAt)
    .forEach((b, i) => rows.push({ key: `busy-${i}`, kind: b.kind, title: b.title, startMs: b.startMs, endMs: b.endMs }));
  return rows.sort((a, b) => a.startMs - b.startMs);
}
