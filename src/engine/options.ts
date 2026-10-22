/**
 * 把規則引擎的結果包成「現在要做什麼」的兩個選擇：
 *   A「拚了」：規則引擎的建議——直接做最重要（通常也最難）的那件
 *   B「先喘口氣」：先休息幾分鐘站起來動一動，回來先做最輕鬆的那件，其餘依規則重排
 * 純函數；沒有任務可排時只給 A。
 */
import type { PlanProposal, ProposedBlock } from './planner';
import type { Task } from '@/db/schema';
import { formatDuration, formatTime } from '@/lib/time';

export const BREAK_MINUTES = 15;

export interface OptionLead {
  title: string;
  startMs: number;
  endMs: number;
  /** 一句話：為什麼 / 做什麼 */
  note: string;
  kind: 'task' | 'rest';
  isMinimum?: boolean;
}

export interface PlanOption {
  key: 'A' | 'B';
  /** 卡片小標：拚了 / 先喘口氣 */
  label: string;
  proposal: PlanProposal;
  /** 卡片主區：現在立刻做的事（任務或休息） */
  lead: OptionLead;
  /** 休息完接著做的事（只有 B 有） */
  then?: OptionLead;
  /** 這個選擇對其他事情的影響，一句話 */
  consequence: string;
  /** 之後接著做什麼（最多三件） */
  after: string;
}

export interface BuildArgs {
  pinFirstTaskId?: string;
  restFirstMinutes?: number;
}

const ENERGY_RANK = { low: 0, medium: 1, high: 2 } as const;

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

function leadOfBlock(b: ProposedBlock, note: string): OptionLead {
  return { title: b.title, startMs: b.startMs, endMs: b.endMs, note, kind: 'task', isMinimum: b.isMinimum };
}

/** 最輕鬆的候選：精力需求最低，再比預估時間最短 */
export function lightestTask(ranked: string[], tasks: Task[]): Task | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cands = ranked.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t) && t!.status !== 'in_progress');
  if (cands.length === 0) return undefined;
  return cands.slice().sort((a, b) => ENERGY_RANK[a.energyRequired] - ENERGY_RANK[b.energyRequired] || a.estimatedMinutes - b.estimatedMinutes)[0];
}

export function buildOptions(build: (args?: BuildArgs) => PlanProposal, ctx: { tz: string; tasks: Task[]; nowMs: number; alreadyResting?: boolean }): PlanOption[] {
  const { tz, tasks, nowMs } = ctx;
  const a = build();
  const options: PlanOption[] = [];
  if (a.nextAction) {
    options.push({ key: 'A', label: '拚了', proposal: a, lead: leadOfBlock(a.nextAction.block, a.nextAction.reason), consequence: consequenceOf(a), after: afterOf(a, tz) });
  } else {
    options.push({ key: 'A', label: '建議', proposal: a, lead: { title: '今天沒有可以安排的任務', startMs: nowMs, endMs: nowMs, note: '', kind: 'task' }, consequence: consequenceOf(a), after: '' });
    return options;
  }

  // B：先休息，再做最輕鬆的
  const light = lightestTask(a.ranked, tasks);
  const restMinutes = ctx.alreadyResting ? 0 : BREAK_MINUTES;
  const b = build({ pinFirstTaskId: light?.id, restFirstMinutes: restMinutes || undefined });
  if (!b.nextAction) return options;
  const sameAsA = restMinutes === 0 && b.nextAction.block.taskId === a.nextAction.block.taskId;
  if (sameAsA) return options;

  const lightNote = light && light.id === b.nextAction.block.taskId ? (ENERGY_RANK[light.energyRequired] === 0 ? '最不花腦力的一件' : `手上最輕鬆的一件（${formatDuration(light.estimatedMinutes)}）`) : b.nextAction.reason;
  const then = leadOfBlock(b.nextAction.block, lightNote);
  if (restMinutes > 0) {
    options.push({
      key: 'B',
      label: '先喘口氣',
      proposal: b,
      lead: { title: `先休息 ${restMinutes} 分鐘`, startMs: nowMs, endMs: nowMs + restMinutes * 60_000, note: '站起來動一動、喝口水，回來再做', kind: 'rest' },
      then,
      consequence: consequenceOf(b),
      after: afterOf(b, tz),
    });
  } else {
    options.push({ key: 'B', label: '先做輕鬆的', proposal: b, lead: then, consequence: consequenceOf(b), after: afterOf(b, tz) });
  }
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
