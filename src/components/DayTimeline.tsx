import { useMemo } from 'react';
import { cx } from './ui';
import type { ActivityLog, WorkBlock } from '@/db/schema';
import type { Occurrence } from '@/engine/recurrence';
import type { Interval } from '@/engine/intervals';
import { dayEndMs, dayStartMs, formatDuration, formatTime, type LocalDate } from '@/lib/time';

const PX_PER_MIN = 0.9;

interface Props {
  date: LocalDate;
  tz: string;
  occurrences: Occurrence[];
  /** 已套用的工作區塊（計畫欄） */
  blocks?: Array<WorkBlock & { title: string }>;
  logs?: ActivityLog[];
  freeWindows?: Interval[];
  nowMs?: number;
  /** 顯示範圍（分鐘，0–1440），預設依資料與工作時段自動決定 */
  rangeStartMin: number;
  rangeEndMin: number;
  onOccurrenceClick?: (o: Occurrence) => void;
  onLogClick?: (l: ActivityLog) => void;
  onFreeClick?: (w: Interval) => void;
}

/**
 * 一天的比例時間軸。左欄「計畫」= 硬性行程（實心）＋可用時段（虛線）；右欄「實際」= 紀錄。
 */
export function DayTimeline({ date, tz, occurrences, blocks, logs, freeWindows, nowMs, rangeStartMin, rangeEndMin, onOccurrenceClick, onLogClick, onFreeClick }: Props) {
  const dayStart = dayStartMs(date, tz);
  const dayEnd = dayEndMs(date, tz);

  const { startMin, endMin } = useMemo(() => {
    const toMin = (ms: number) => Math.max(0, Math.min(1440, (ms - dayStart) / 60_000));
    let s = rangeStartMin;
    let e = rangeEndMin;
    for (const o of occurrences) {
      s = Math.min(s, toMin(o.startMs));
      e = Math.max(e, toMin(o.endMs));
    }
    for (const b of blocks ?? []) {
      s = Math.min(s, toMin(new Date(b.startAt).getTime()));
      e = Math.max(e, toMin(new Date(b.endAt).getTime()));
    }
    for (const l of logs ?? []) {
      s = Math.min(s, toMin(new Date(l.startAt).getTime()));
      e = Math.max(e, toMin(l.endAt ? new Date(l.endAt).getTime() : (nowMs ?? Date.now())));
    }
    s = Math.floor(s / 60) * 60;
    e = Math.min(1440, Math.ceil(e / 60) * 60);
    return { startMin: s, endMin: Math.max(e, s + 60) };
  }, [occurrences, blocks, logs, rangeStartMin, rangeEndMin, dayStart, nowMs]);

  const height = (endMin - startMin) * PX_PER_MIN;
  const top = (ms: number) => (Math.max(dayStart, Math.min(dayEnd, ms)) - dayStart) / 60_000;
  const place = (sMs: number, eMs: number) => {
    const s = Math.max(top(sMs), startMin);
    const e = Math.min(top(eMs), endMin);
    return { top: (s - startMin) * PX_PER_MIN, height: Math.max(14, (e - s) * PX_PER_MIN) };
  };

  const hours: number[] = [];
  for (let h = startMin; h <= endMin; h += 60) hours.push(h);
  const nowInRange = nowMs !== undefined && nowMs >= dayStart + startMin * 60_000 && nowMs <= dayStart + endMin * 60_000;
  const hasLogs = logs !== undefined;

  return (
    <div className="relative" style={{ height }}>
      {/* 小時刻度 */}
      {hours.map((h) => (
        <div key={h} className="absolute inset-x-0 flex items-start" style={{ top: (h - startMin) * PX_PER_MIN }}>
          <span className="w-11 -translate-y-2 pr-2 text-right text-[11px] text-muted tnum">{String(h / 60).padStart(2, '0')}:00</span>
          <span className="flex-1 border-t border-line" />
        </div>
      ))}

      <div className={cx('absolute inset-y-0 left-11 right-0 grid gap-1', hasLogs ? 'grid-cols-2' : 'grid-cols-1')}>
        {/* 計畫欄 */}
        <div className="relative">
          {freeWindows?.map((w, i) => {
            const p = place(w.start, w.end);
            return (
              <button
                key={`free-${i}`}
                type="button"
                onClick={() => onFreeClick?.(w)}
                className="absolute inset-x-0 rounded-md border border-dashed border-accent/60 bg-accent-soft/40 px-1.5 text-left text-[11px] text-accent"
                style={p}
                aria-label={`可用 ${formatTime(w.start, tz)}–${formatTime(w.end, tz)}`}
              >
                {p.height > 22 && <span className="tnum">可用 {formatDuration((w.end - w.start) / 60_000)}</span>}
              </button>
            );
          })}
          {blocks?.map((b) => {
            const s = new Date(b.startAt).getTime();
            const e = new Date(b.endAt).getTime();
            const p = place(s, e);
            const inactive = b.status === 'done' || b.status === 'skipped';
            return (
              <div
                key={b.id}
                className={cx('absolute inset-x-0 overflow-hidden rounded-md border px-1.5', p.height >= 22 && 'py-0.5', inactive ? 'border-line bg-surface-2 text-done' : 'border-accent bg-accent-soft text-accent')}
                style={p}
                title={`${b.title} ${formatTime(s, tz)}–${formatTime(e, tz)}`}
                aria-label={`排程 ${b.title} ${formatTime(s, tz)}–${formatTime(e, tz)}`}
              >
                {p.height >= 22 && <div className={cx('truncate text-[12px] font-medium leading-4', inactive && 'line-through')}>{b.title}</div>}
                {p.height > 30 && (
                  <div className="text-[11px] leading-4 opacity-80 tnum">
                    {formatTime(s, tz)}–{formatTime(e, tz)}
                    {b.isMinimum && ' · 最低'}
                  </div>
                )}
              </div>
            );
          })}
          {occurrences.map((o) => {
            const p = place(o.startMs, o.endMs);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onOccurrenceClick?.(o)}
                className={cx('absolute inset-x-0 overflow-hidden rounded-md bg-hard px-1.5 text-left text-white', p.height >= 22 && 'py-0.5')}
                style={p}
                title={`${o.title} ${formatTime(o.startMs, tz)}–${formatTime(o.endMs, tz)}`}
              >
                {p.height >= 22 && <div className="truncate text-[12px] font-medium leading-4">{o.title}</div>}
                {p.height > 30 && (
                  <div className="text-[11px] leading-4 opacity-80 tnum">
                    {formatTime(o.startMs, tz)}–{formatTime(o.endMs, tz)}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* 實際欄 */}
        {hasLogs && (
          <div className="relative border-l border-dashed border-line pl-1">
            {logs.map((l) => {
              const s = new Date(l.startAt).getTime();
              const e = l.endAt ? new Date(l.endAt).getTime() : (nowMs ?? Date.now());
              const p = place(s, e);
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => onLogClick?.(l)}
                  className={cx(
                    'absolute inset-x-0 overflow-hidden rounded-md border-l-[3px] px-1.5 text-left',
                    p.height >= 22 && 'py-0.5',
                    l.endAt ? 'border-accent bg-accent-soft text-accent' : 'border-accent bg-accent text-accent-ink',
                  )}
                  style={p}
                  title={`${l.title} ${formatTime(s, tz)}–${l.endAt ? formatTime(e, tz) : '進行中'}`}
                >
                  {p.height >= 22 && <div className="truncate text-[12px] font-medium leading-4">{l.title}</div>}
                  {p.height > 30 && (
                    <div className="text-[11px] leading-4 opacity-80 tnum">
                      {formatTime(s, tz)}–{l.endAt ? formatTime(e, tz) : '進行中'}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 現在 */}
      {nowInRange && nowMs !== undefined && (
        <div className="pointer-events-none absolute left-9 right-0 z-10 flex items-center" style={{ top: (top(nowMs) - startMin) * PX_PER_MIN }}>
          <span className="h-2.5 w-2.5 rounded-full bg-danger" />
          <span className="h-px flex-1 bg-danger" />
        </div>
      )}
    </div>
  );
}
