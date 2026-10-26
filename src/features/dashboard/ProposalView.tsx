import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Coffee } from 'lucide-react';
import { Button, Chip, cx } from '@/components/ui';
import type { PlanProposal } from '@/engine/planner';
import { downsidesOf, type PlanOption } from '@/engine/options';
import { deferTask } from '@/db/repo';
import { useToast } from '@/hooks/useToast';
import { addLocalDays, formatDuration, formatTime } from '@/lib/time';

/**
 * 重排結果：只回答「現在要做什麼」。
 * 兩張卡片：「拚了」（直接做最重要的）／「先喘口氣」（休息 15 分鐘，回來先做最輕鬆的）。
 * 每張只有：做什麼、幾點到幾點、一句為什麼、「就這個」、「細節」。
 * 「細節」是明顯的按鈕，展開後只有兩樣：套用後今日安排、缺點。字都用正常大小。
 */
export function ProposalView({ options, tz, onApply, onKeep, applying, keepLabel = '都不要，保留原計畫' }: { options: PlanOption[]; tz: string; onApply: (p: PlanProposal) => void; onKeep: () => void; applying?: boolean; keepLabel?: string }) {
  const a = options[0].proposal;
  const urgent = a.warnings.filter((w) => w.includes('截止') || w.includes('時間不夠'));

  return (
    <div className="space-y-3">
      <div className="text-[15px] text-muted">
        今天還有 <span className="text-ink tnum">{formatDuration(a.stats.availableMinutes)}</span> 可用
        {a.stats.candidateMinutes > a.stats.availableMinutes && <span className="text-warn">，要做的事需要 {formatDuration(a.stats.candidateMinutes)}</span>}
      </div>
      {urgent.length > 0 && (
        <p className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[15px] text-warn">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>{urgent[0]}</span>
        </p>
      )}

      <h3 className="pt-1 text-[17px] font-semibold">現在要做什麼？</h3>
      {options.map((o) => (
        <OptionCard key={o.key} option={o} tz={tz} onPick={() => onApply(o.proposal)} applying={applying} recommended={o.key === 'A'} />
      ))}

      <button type="button" className="w-full py-2 text-[15px] text-muted" onClick={onKeep} data-testid="keep-plan">
        {keepLabel}
      </button>
    </div>
  );
}

function OptionCard({ option, tz, onPick, applying, recommended }: { option: PlanOption; tz: string; onPick: () => void; applying?: boolean; recommended: boolean }) {
  const p = option.proposal;
  const [open, setOpen] = useState(false);
  const lead = option.lead;
  return (
    <section className={cx('rounded-xl border p-4', recommended ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface')} data-testid={`option-${option.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx('text-[15px] font-semibold', recommended ? 'text-accent' : 'text-hard')}>{option.label}</span>
        {!p.feasible && (
          <Chip tone="danger" className="text-sm">
            有截止趕不上
          </Chip>
        )}
        {lead.isMinimum && (
          <Chip tone="warn" className="text-sm">
            最低版本
          </Chip>
        )}
      </div>
      <div className="mt-2 flex items-start gap-2">
        {lead.kind === 'rest' && <Coffee size={24} className="mt-1 shrink-0 text-hard" />}
        <div className="min-w-0">
          <div className="text-[22px] font-semibold leading-tight">{lead.title}</div>
          {lead.endMs > lead.startMs && (
            <div className="mt-1.5 text-[17px] tnum">
              {formatTime(lead.startMs, tz)}–{formatTime(lead.endMs, tz)} <span className="text-muted">· {formatDuration(Math.round((lead.endMs - lead.startMs) / 60_000))}</span>
            </div>
          )}
          {lead.note && <div className="mt-1 text-[15px] text-muted">{lead.note}</div>}
        </div>
      </div>
      {option.then && (
        <div className="mt-3 rounded-lg bg-surface/70 px-3 py-2">
          <div className="text-[15px] text-muted">回來先做</div>
          <div className="text-[17px] font-semibold leading-tight">{option.then.title}</div>
          <div className="text-[15px] tnum">
            {formatTime(option.then.startMs, tz)}–{formatTime(option.then.endMs, tz)} <span className="text-muted">· {option.then.note}</span>
          </div>
        </div>
      )}
      <Button variant="primary" full className="mt-4 min-h-12 text-[17px]" onClick={onPick} disabled={applying}>
        <Check size={18} /> 就這個
      </Button>
      <Button full className="mt-2 min-h-12 text-[16px]" onClick={() => setOpen((v) => !v)} data-testid="details-toggle" aria-expanded={open}>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />} 細節：今日安排、缺點
      </Button>
      {open && <Details proposal={p} tz={tz} />}
    </section>
  );
}

function Details({ proposal, tz }: { proposal: PlanProposal; tz: string }) {
  const toast = useToast();
  const downsides = downsidesOf(proposal, tz);

  return (
    <div className="mt-3 text-[15px]">
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-[16px] font-semibold">套用後今日安排</div>
          {(() => {
            const rows = scheduleRows(proposal);
            return rows.length === 0 ? (
              <p className="text-muted">沒有安排。</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {rows.map((r) => (
                  <li key={r.key} className={cx('flex items-start gap-3 px-3 py-2', r.kind !== 'block' && 'text-muted')}>
                    <span className="w-[6.5rem] shrink-0 text-[15px] leading-6 tnum">
                      {formatTime(r.startMs, tz)}–{formatTime(r.endMs, tz)}
                    </span>
                    <span className={cx('min-w-0 flex-1 text-[15px] leading-6', r.kind === 'block' && 'text-ink')}>{r.title}</span>
                    {r.kind === 'event' && <Chip tone="hard" className="mt-1">行程</Chip>}
                    {r.kind === 'incident' && <Chip tone="hard" className="mt-1">新行程</Chip>}
                    {r.kind === 'rest' && <Chip className="mt-1">休息</Chip>}
                    {r.segments && r.segments > 1 && <Chip className="mt-1">{r.segments} 段</Chip>}
                    {r.isMinimum && <Chip tone="warn" className="mt-1">最低</Chip>}
                  </li>
                ))}
              </ul>
            );
          })()}
        </div>

        <div>
          <div className="mb-1.5 text-[16px] font-semibold">缺點</div>
          {downsides.length === 0 ? (
            <p className="text-muted">沒有明顯缺點：所有事都排得下，也沒有改時間。</p>
          ) : (
            <ul className="space-y-2">
              {downsides.map((d, i) => (
                <li key={i} className="flex gap-2">
                  <AlertTriangle size={18} className={cx('mt-0.5 shrink-0', d.severe ? 'text-danger' : 'text-warn')} />
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
    </div>
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
