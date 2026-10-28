import { useNow } from '@/hooks/useNow';
import { cx } from './ui';

/** 時:分:秒，每秒跳；以開始時間算，背景回來也是對的 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function ElapsedTimer({ startAt, className }: { startAt: string; className?: string }) {
  const nowMs = useNow(1000);
  const startMs = new Date(startAt).getTime();
  return (
    <span className={cx('tnum tabular-nums', className)} data-testid="elapsed-timer" aria-label="已經過時間">
      {formatElapsed(nowMs - startMs)}
    </span>
  );
}
