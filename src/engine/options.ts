/**
 * 把規則引擎的結果包成「現在要做什麼」的兩個選擇：
 *   A：規則引擎的建議（下一步 = 排序最前的任務）
 *   B：改先做排序第二的任務，其餘依規則重排
 * 兩者結果一樣（或沒有第二個候選）就只給一個。純函數。
 */
import type { PlanProposal } from './planner';
import { formatDuration, formatTime } from '@/lib/time';

export interface PlanOption {
  key: 'A' | 'B';
  /** 卡片上的小標 */
  label: string;
  proposal: PlanProposal;
  /** 這個選擇對其他事情的影響，一句話 */
  consequence: string;
  /** 之後接著做什麼（最多三件） */
  after: string;
}

export function consequenceOf(p: PlanProposal): string {
  const parts: string[] = [];
  const missed = p.unscheduled.filter((u) => u.reasonCode === 'DEADLINE_MISSED').length;
  if (missed) parts.push(`${missed} 件趕不上截止`);
  const other = p.unscheduled.length - missed;
  if (other) parts.push(`${other} 件今天排不下`);
  const minimum = new Set(p.blocks.filter((b) => b.isMinimum).map((b) => b.taskId)).size;
  if (minimum) parts.push(`${minimum} 件只做最低版本`);
  if (p.diff.moved.length) parts.push(`${p.diff.moved.length} 件改時間`);
  return parts.length ? parts.join('、') : '其他事都排得下';
}

export function afterOf(p: PlanProposal, tz: string): string {
  const firstTask = p.nextAction?.block.taskId;
  const seen = new Set<string>();
  const rest: string[] = [];
  for (const b of p.blocks) {
    if (b.taskId === firstTask || seen.has(b.taskId)) continue;
    seen.add(b.taskId);
    rest.push(`${formatTime(b.startMs, tz)} ${b.title}`);
  }
  if (rest.length === 0) return p.nextAction ? '之後沒有別的安排' : '';
  const shown = rest.slice(0, 3).join('、');
  return rest.length > 3 ? `${shown}…（共 ${rest.length} 件）` : shown;
}

export function buildOptions(build: (pinFirstTaskId?: string) => PlanProposal, tz: string): PlanOption[] {
  const a = build();
  const options: PlanOption[] = [{ key: 'A', label: '建議', proposal: a, consequence: consequenceOf(a), after: afterOf(a, tz) }];
  const firstId = a.nextAction?.block.taskId;
  if (!firstId) return options;
  const altId = a.ranked.find((id) => id !== firstId);
  if (!altId) return options;
  const b = build(altId);
  if (!b.nextAction || b.nextAction.block.taskId === firstId) return options;
  options.push({ key: 'B', label: '另一個選擇', proposal: b, consequence: consequenceOf(b), after: afterOf(b, tz) });
  return options;
}

export interface Downside {
  text: string;
  severe?: boolean;
  deferTaskId?: string;
  deferTitle?: string;
}

/** 這個方案的代價，用人話列出：做不完的、趕不上截止的、只做最低版本的、被改時間的、其他警示 */
export function downsidesOf(p: PlanProposal, tz: string): Downside[] {
  const out: Downside[] = [];
  for (const u of p.unscheduled) {
    const severe = u.reasonCode === 'DEADLINE_MISSED';
    out.push({
      text: severe ? `「${u.title}」趕不上截止：${u.reason}` : `「${u.title}」今天做不完：${u.reason}`,
      severe,
      deferTaskId: u.suggestion === 'defer_tomorrow' ? u.taskId : undefined,
      deferTitle: u.suggestion === 'defer_tomorrow' ? u.title : undefined,
    });
  }
  const minimumSeen = new Set<string>();
  for (const b of p.blocks) {
    if (!b.isMinimum || minimumSeen.has(b.taskId)) continue;
    minimumSeen.add(b.taskId);
    const minutes = p.blocks.filter((x) => x.taskId === b.taskId).reduce((s, x) => s + x.minutes, 0);
    out.push({ text: `「${b.title}」時間不夠，只做最低版本（${formatDuration(minutes)}）` });
  }
  for (const m of p.diff.moved) {
    out.push({ text: `「${m.block.title}」從 ${formatTime(m.fromStartMs, tz)} 改到 ${formatTime(m.block.startMs, tz)}` });
  }
  for (const s of p.diff.shortened) {
    if (minimumSeen.has(s.taskId)) continue;
    out.push({ text: `「${s.title}」縮短：${formatDuration(s.fromMinutes)} → ${formatDuration(s.toMinutes)}` });
  }
  for (const w of p.warnings) {
    // 截止 / 時間不夠的警示已由上面的項目涵蓋
    if (w.includes('無法在截止前') || w.startsWith('今天的時間不夠')) continue;
    out.push({ text: w });
  }
  return out;
}
