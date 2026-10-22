/**
 * 規則引擎：把「現在的狀態」變成「可解釋的候選排程」。
 *
 * 純函數、確定性、零 AI。輸入是今天的任務、硬性行程、既有區塊、精力、突發狀況；
 * 輸出是建議方案（下一步、區塊、未安排項目、警示、理由、差異）。
 * 不寫資料庫；套用與撤銷在 db/repo.ts。
 *
 * 規則對應：
 *  1 固定限制優先      → availability.ts 先扣掉行程、睡眠、緩衝；validate.ts 最後再驗一次
 *  2 期限緊迫          → tier：逾期 > 今天截止 > 48 小時內 > 其他；今天截止的區塊必須在截止前結束
 *  3 優先級            → 同 tier 內 P1 > P2 > P3
 *  4 精力匹配          → 同 tier 同優先級內，精力差距小的先；低精力遇高負荷任務給警示但不跳過
 *  5 最低可行          → 完整版排不下就排 minimumMinutes 的版本，標記 isMinimum 與理由
 *  6 事件觸發          → 只有使用者按「重新規劃」或回報狀況才呼叫 buildPlan
 *  7 反抖動            → 進行中的任務永遠排第一；既有、仍可行的區塊原位保留，只重排受影響的部分
 *  8 反飢餓            → deferCount ≥ 2 的任務在同 tier 內提前，並列入警示；不改動 priority
 *  9 明確降級          → 排不下的任務列在 unscheduled，附原因與建議；今天截止卻排不進去 → feasible=false
 * 10 人保有控制權      → 這裡只產生 proposal，不碰資料
 */
import type { Energy, Task, WorkBlock } from '@/db/schema';
import { computeAvailability, hardConflicts, type AvailabilityResult } from './availability';
import { unmetDependencies } from './dependencies';
import { mergeIntervals, subtractIntervals, totalMinutes, type Interval } from './intervals';
import { dueRisk, isOpen } from '@/lib/select';
import { compareLocalDate, formatDuration, formatTime, toLocalDate, type HHmm, type LocalDate } from '@/lib/time';

/* ------------------------------------ 輸入 ------------------------------------ */

export type Incident =
  | { type: 'replan' }
  | { type: 'overslept'; wakeTime: HHmm }
  | { type: 'lost_time'; startMs: number; endMs: number; title?: string }
  | { type: 'energy'; energy: Energy }
  | { type: 'task_done'; taskId: string }
  | { type: 'overrun'; taskId: string; remainingMinutes: number }
  | { type: 'rest'; minutes: number };

export const INCIDENT_LABEL: Record<Incident['type'], string> = {
  replan: '重新規劃',
  overslept: '睡過頭',
  lost_time: '臨時有事',
  energy: '精力變化',
  task_done: '提早完成',
  overrun: '超時',
  rest: '需要休息',
};

export interface BusyInterval {
  startMs: number;
  endMs: number;
  title: string;
  kind: 'event' | 'incident' | 'rest';
}

export interface PlannerSettings {
  workStart: HHmm;
  workEnd: HHmm;
  sleepStart: HHmm;
  sleepEnd: HHmm;
  bufferMinutes: number;
  breakMinutes: number;
  focusMinutes: number;
  preferDeadlineFirst: boolean;
  energyMatching: boolean;
  allowSplitting: boolean;
}

export interface PlannerInput {
  nowMs: number;
  tz: string;
  settings: PlannerSettings;
  tasks: Task[];
  /** 今天的硬性行程（已展開） */
  busy: BusyInterval[];
  /** 今天已套用的區塊 */
  existingBlocks: WorkBlock[];
  /** 正在計時中的任務 */
  activeTaskId?: string;
  energy?: Energy;
  incident?: Incident;
  /** 明天的概況，用於「延到明天」的建議文字 */
  tomorrow?: { availableMinutes: number; plannedMinutes: number };
  /** 預估工時校正（由歷史算出；undefined = 不校正） */
  calibration?: { factor?: number; byEnergy: Partial<Record<Energy, { factor: number; samples: number }>> };
  /** 使用者指定「先做這個」：該任務排最前面，其他任務的既有區塊全部重排（方案 B 用） */
  pinFirstTaskId?: string;
}

/* ------------------------------------ 輸出 ------------------------------------ */

export type ReasonCode =
  | 'IN_PROGRESS'
  | 'OVERDUE'
  | 'DUE_TODAY'
  | 'DUE_SOON'
  | 'P1'
  | 'STARVING'
  | 'ENERGY_FIT'
  | 'KEPT'
  | 'REDUCED'
  | 'SPLIT'
  | 'NO_TIME'
  | 'MIN_NO_TIME'
  | 'DEADLINE_MISSED'
  | 'NOT_SPLITTABLE'
  | 'PINNED';

export interface ProposedBlock {
  id: string;
  taskId: string;
  title: string;
  startMs: number;
  endMs: number;
  minutes: number;
  isMinimum: boolean;
  /** 從既有區塊原位保留 */
  kept: boolean;
  existingId?: string;
  reasonCodes: ReasonCode[];
  /** 給人看的理由 */
  reason: string;
}

export interface UnscheduledItem {
  taskId: string;
  title: string;
  reasonCode: ReasonCode;
  reason: string;
  suggestion: 'defer_tomorrow' | 'reduce' | 'decide';
  neededMinutes: number;
}

export interface PlanDiff {
  added: ProposedBlock[];
  kept: ProposedBlock[];
  moved: Array<{ block: ProposedBlock; fromStartMs: number; fromEndMs: number }>;
  shortened: Array<{ taskId: string; title: string; fromMinutes: number; toMinutes: number }>;
  removed: WorkBlock[];
  deferred: UnscheduledItem[];
}

export interface IncidentEffects {
  createEvent?: { title: string; startMs: number; endMs: number };
  completeTaskId?: string;
  setEnergy?: Energy;
  setWakeTime?: HHmm;
}

export interface NextAction {
  block: ProposedBlock;
  reason: string;
  reasonCodes: ReasonCode[];
  warning?: string;
}

export interface PlanProposal {
  date: LocalDate;
  generatedAt: number;
  trigger: Incident['type'];
  nextAction: NextAction | null;
  blocks: ProposedBlock[];
  unscheduled: UnscheduledItem[];
  warnings: string[];
  explanation: string[];
  diff: PlanDiff;
  effects: IncidentEffects;
  /** false = 有今天截止的任務排不進去 */
  feasible: boolean;
  stats: { availableMinutes: number; plannedMinutes: number; candidateMinutes: number };
  availability: AvailabilityResult;
  /** 候選任務依規則排序後的 id（含排不下的），給「另一個選擇」用 */
  ranked: string[];
  pinnedTaskId?: string;
  /** 今天的固定行程（含狀況加入的行程與休息），給「套用後今日安排」一起列出 */
  busy: BusyInterval[];
}

/* ------------------------------------ 內部 ------------------------------------ */

const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 } as const;
const ENERGY_RANK = { high: 2, medium: 1, low: 0 } as const;
const MIN_CHUNK = 15;

interface Candidate {
  task: Task;
  remaining: number;
  minimum?: number;
  dueMs?: number;
  tier: number;
  placedMinutes: number;
  blocks: ProposedBlock[];
}

function reasonText(codes: ReasonCode[], c: Candidate, tz: string): string {
  const parts: string[] = [];
  if (codes.includes('PINNED')) parts.push('你選擇先做這個');
  if (codes.includes('IN_PROGRESS')) parts.push('進行中');
  if (codes.includes('OVERDUE')) parts.push('已逾期');
  else if (codes.includes('DUE_TODAY')) parts.push(`今天 ${formatTime(c.dueMs!, tz)} 截止`);
  else if (codes.includes('DUE_SOON')) parts.push('48 小時內截止');
  if (codes.includes('P1')) parts.push('P1');
  if (codes.includes('STARVING')) parts.push(`已延後 ${c.task.deferCount} 次`);
  if (codes.includes('REDUCED')) parts.push(`最低版本${c.task.minimumOutcome ? `：${c.task.minimumOutcome}` : ''}`);
  if (codes.includes('ENERGY_FIT')) parts.push('符合目前精力');
  return parts.length ? parts.join('、') : '依優先級與順序排入';
}

function clampMinutes(n: number): number {
  return Math.max(5, Math.round(n));
}

function tierOf(task: Task, nowMs: number, tz: string): number {
  const r = dueRisk(task, nowMs, tz);
  return r === 'overdue' ? 0 : r === 'today' ? 1 : r === 'soon' ? 2 : 3;
}

/** 在 windows 裡放 minutes 分鐘；回傳切好的區段，放不下回傳 null。不修改 windows。 */
export function tryPlace(
  windows: Interval[],
  minutes: number,
  opts: { splittable: boolean; focusMinutes: number; breakMinutes: number; notAfterMs?: number },
): Interval[] | null {
  const need = minutes * 60_000;
  const breakMs = opts.breakMinutes * 60_000;
  const limit = opts.notAfterMs ?? Number.POSITIVE_INFINITY;

  if (!opts.splittable) {
    for (const w of windows) {
      const end = w.start + need;
      if (end <= w.end && end <= limit) return [{ start: w.start, end }];
    }
    return null;
  }

  const slots: Interval[] = [];
  let left = need;
  const chunk = Math.max(MIN_CHUNK, opts.focusMinutes) * 60_000;
  const minChunk = MIN_CHUNK * 60_000;
  for (const w of windows) {
    let cursor = w.start;
    while (left > 0 && cursor < w.end && cursor < limit) {
      const room = Math.min(w.end, limit) - cursor;
      const take = Math.min(left, chunk, room);
      if (take < Math.min(minChunk, left)) break; // 這個視窗剩的太零碎
      slots.push({ start: cursor, end: cursor + take });
      left -= take;
      cursor += take + breakMs;
    }
    if (left <= 0) break;
  }
  return left <= 0 ? slots : null;
}

/** 區塊前後都留休息，避免兩個區塊背靠背 */
function consume(windows: Interval[], slots: Interval[], breakMs: number): Interval[] {
  return subtractIntervals(
    windows,
    slots.map((s) => ({ start: s.start - breakMs, end: s.end + breakMs })),
  );
}

function containedInWindows(windows: Interval[], i: Interval): boolean {
  return windows.some((w) => i.start >= w.start && i.end <= w.end);
}

/* ------------------------------------ 主流程 ------------------------------------ */

export function buildPlan(input: PlannerInput): PlanProposal {
  const { nowMs, tz, settings, incident } = input;
  const date = toLocalDate(nowMs, tz);
  const warnings: string[] = [];
  const explanation: string[] = [];
  const effects: IncidentEffects = {};
  let energy = input.energy;

  // 1. 把突發狀況正規化成狀態變化
  const busy: BusyInterval[] = input.busy.slice();
  let doneTaskId: string | undefined;
  let overrun: { taskId: string; remainingMinutes: number } | undefined;
  if (incident) {
    switch (incident.type) {
      case 'overslept':
        effects.setWakeTime = incident.wakeTime;
        explanation.push(`今天 ${incident.wakeTime} 起床，從現在（${formatTime(nowMs, tz)}）開始重排。`);
        break;
      case 'lost_time': {
        const title = incident.title?.trim() || '臨時有事';
        busy.push({ startMs: incident.startMs, endMs: incident.endMs, title, kind: 'incident' });
        effects.createEvent = { title, startMs: incident.startMs, endMs: incident.endMs };
        explanation.push(`${formatTime(incident.startMs, tz)}–${formatTime(incident.endMs, tz)}「${title}」視為固定行程，套用後會加進日曆。`);
        break;
      }
      case 'energy':
        energy = incident.energy;
        effects.setEnergy = incident.energy;
        explanation.push(`精力改為「${incident.energy === 'high' ? '高' : incident.energy === 'medium' ? '中' : '低'}」。`);
        break;
      case 'task_done':
        doneTaskId = incident.taskId;
        effects.completeTaskId = incident.taskId;
        break;
      case 'overrun':
        overrun = { taskId: incident.taskId, remainingMinutes: clampMinutes(incident.remainingMinutes) };
        break;
      case 'rest':
        busy.push({ startMs: nowMs, endMs: nowMs + incident.minutes * 60_000, title: '休息', kind: 'rest' });
        explanation.push(`先休息 ${incident.minutes} 分鐘，之後再開始。`);
        break;
      case 'replan':
        break;
    }
  }

  // 2. 可用時段（規則 1）
  const availability = computeAvailability({
    date,
    tz,
    workStart: settings.workStart,
    workEnd: settings.workEnd,
    sleepStart: settings.sleepStart,
    sleepEnd: settings.sleepEnd,
    bufferMinutes: settings.bufferMinutes,
    busy: busy.map((b) => ({ startMs: b.startMs, endMs: b.endMs })),
    from: nowMs,
    minWindowMinutes: MIN_CHUNK,
  });
  let windows = availability.windows.map((w) => ({ ...w }));
  const availableMinutes = Math.round(totalMinutes(windows));
  const breakMs = settings.breakMinutes * 60_000;

  // 3. 候選任務
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const today = date;
  const candidates: Candidate[] = [];
  const blockedByDeps: Task[] = [];
  const calibratedTitles: string[] = [];
  for (const task of input.tasks) {
    if (!isOpen(task) || task.id === doneTaskId) continue;
    const risk = dueRisk(task, nowMs, tz);
    const plannedTodayOrPast = Boolean(task.plannedDate && compareLocalDate(task.plannedDate, today) <= 0);
    const relevant = task.status === 'in_progress' || task.id === input.activeTaskId || plannedTodayOrPast || risk === 'overdue' || risk === 'today' || risk === 'soon';
    if (!relevant) continue;
    if (unmetDependencies(task, byId).length > 0) {
      blockedByDeps.push(task);
      continue;
    }
    // 校正：用歷史「實際 / 預估」比例調整預估（同精力優先）
    const calFactor = input.calibration ? (input.calibration.byEnergy[task.energyRequired]?.factor ?? input.calibration.factor ?? 1) : 1;
    const estimated = clampMinutes(task.estimatedMinutes * calFactor);
    let remaining = clampMinutes(estimated - (task.actualMinutes ?? 0));
    if (task.status !== 'in_progress' && task.actualMinutes === undefined) remaining = estimated;
    if (overrun && overrun.taskId === task.id) remaining = overrun.remainingMinutes;
    if (calFactor !== 1 && Math.abs(calFactor - 1) >= 0.1) calibratedTitles.push(`${task.title}（×${calFactor}）`);
    const minimum = task.minimumMinutes && task.minimumMinutes < remaining ? task.minimumMinutes : undefined;
    candidates.push({
      task,
      remaining,
      minimum,
      dueMs: task.dueAt ? new Date(task.dueAt).getTime() : undefined,
      tier: tierOf(task, nowMs, tz),
      placedMinutes: 0,
      blocks: [],
    });
  }
  const candidateMinutes = candidates.reduce((s, c) => s + c.remaining, 0);

  // 4. 排序（規則 2、3、4、7、8）；使用者指定先做的任務排在進行中之後、其他之前
  const isActive = (c: Candidate) => c.task.status === 'in_progress' || c.task.id === input.activeTaskId;
  const pinnedId = input.pinFirstTaskId && candidates.some((c) => c.task.id === input.pinFirstTaskId) ? input.pinFirstTaskId : undefined;
  const isPinned = (c: Candidate) => c.task.id === pinnedId;
  candidates.sort((a, b) => {
    if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const tier = a.tier - b.tier;
    const pri = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
    if (settings.preferDeadlineFirst) {
      if (tier !== 0) return tier;
      if (pri !== 0) return pri;
    } else {
      if (pri !== 0) return pri;
      if (tier !== 0) return tier;
    }
    const starveA = a.task.deferCount >= 2 ? 1 : 0;
    const starveB = b.task.deferCount >= 2 ? 1 : 0;
    if (starveA !== starveB) return starveB - starveA;
    if (settings.energyMatching && energy) {
      const fit = (c: Candidate) => Math.abs(ENERGY_RANK[c.task.energyRequired] - ENERGY_RANK[energy]);
      const e = fit(a) - fit(b);
      if (e !== 0) return e;
    }
    const d = (a.task.plannedDate ?? '9999').localeCompare(b.task.plannedDate ?? '9999');
    if (d !== 0) return d;
    return a.task.createdAt.localeCompare(b.task.createdAt);
  });

  // 5. 既有區塊：仍可行的原位保留（規則 7）
  const removed: WorkBlock[] = [];
  const keptBlocks: ProposedBlock[] = [];
  const candById = new Map(candidates.map((c) => [c.task.id, c]));
  const existing = input.existingBlocks
    .filter((b) => b.status === 'planned' || b.status === 'active')
    .slice()
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  for (const b of existing) {
    const s = new Date(b.startAt).getTime();
    const e = new Date(b.endAt).getTime();
    const cand = candById.get(b.taskId);
    const interval = { start: Math.max(s, nowMs), end: e };
    const stillValid =
      cand !== undefined &&
      // 指定先做某任務時，其他任務的既有區塊全部重排，讓它真的排在最前面
      (pinnedId === undefined || b.taskId === pinnedId || isActive(cand)) &&
      e > nowMs &&
      interval.end - interval.start >= MIN_CHUNK * 60_000 &&
      hardConflicts(interval, availability).length === 0 &&
      containedInWindows(windows, interval) &&
      (cand.dueMs === undefined || cand.tier > 1 || e <= cand.dueMs) &&
      !(overrun && overrun.taskId === b.taskId);
    if (!stillValid) {
      removed.push(b);
      continue;
    }
    const minutes = Math.round((interval.end - interval.start) / 60_000);
    const pb: ProposedBlock = {
      id: b.id,
      taskId: b.taskId,
      title: cand.task.title,
      startMs: interval.start,
      endMs: interval.end,
      minutes,
      isMinimum: b.isMinimum,
      kept: true,
      existingId: b.id,
      reasonCodes: ['KEPT'],
      reason: b.reason ?? '原本的安排不受影響',
    };
    keptBlocks.push(pb);
    cand.blocks.push(pb);
    cand.placedMinutes += minutes;
    windows = consume(windows, [interval], breakMs);
  }

  // 6. 逐一放入（規則 5、9）
  const unscheduled: UnscheduledItem[] = [];
  let seq = 0;
  const makeId = () => `p${++seq}`;
  for (const c of candidates) {
    const need = Math.max(0, c.remaining - c.placedMinutes);
    if (need < 5) continue;
    const codes: ReasonCode[] = [];
    if (isActive(c)) codes.push('IN_PROGRESS');
    if (c.tier === 0) codes.push('OVERDUE');
    else if (c.tier === 1) codes.push('DUE_TODAY');
    else if (c.tier === 2) codes.push('DUE_SOON');
    if (c.task.priority === 'P1') codes.push('P1');
    if (c.task.deferCount >= 2) codes.push('STARVING');
    if (isPinned(c)) codes.push('PINNED');

    const splittable = c.task.splittable && settings.allowSplitting;
    const notAfterMs = c.dueMs !== undefined && c.tier <= 1 ? c.dueMs : undefined;
    const opts = { splittable, focusMinutes: settings.focusMinutes, breakMinutes: settings.breakMinutes, notAfterMs };

    let slots = tryPlace(windows, need, opts);
    let isMinimum = false;
    if (!slots && c.minimum !== undefined) {
      const minNeed = Math.max(0, c.minimum - c.placedMinutes);
      if (minNeed >= 5) {
        slots = tryPlace(windows, minNeed, opts);
        isMinimum = slots !== null;
      } else {
        slots = [];
      }
    }

    if (!slots) {
      const title = c.task.title;
      if (notAfterMs !== undefined) {
        unscheduled.push({
          taskId: c.task.id,
          title,
          reasonCode: 'DEADLINE_MISSED',
          reason: `截止 ${formatTime(notAfterMs, tz)} 之前排不進 ${formatDuration(c.minimum ?? need)}，需要你決定：縮小範圍、移開其他事，或接受延遲`,
          suggestion: 'decide',
          neededMinutes: c.minimum ?? need,
        });
      } else if (!splittable && c.task.splittable === false) {
        unscheduled.push({
          taskId: c.task.id,
          title,
          reasonCode: 'NOT_SPLITTABLE',
          reason: `需要連續 ${formatDuration(c.minimum ?? need)} 的空檔，今天沒有`,
          suggestion: 'defer_tomorrow',
          neededMinutes: c.minimum ?? need,
        });
      } else {
        unscheduled.push({
          taskId: c.task.id,
          title,
          reasonCode: c.minimum !== undefined ? 'MIN_NO_TIME' : 'NO_TIME',
          reason: c.minimum !== undefined ? `連最低版本 ${formatDuration(c.minimum)} 都排不下` : `今天剩餘時間放不下 ${formatDuration(need)}`,
          suggestion: c.minimum === undefined && c.task.splittable ? 'reduce' : 'defer_tomorrow',
          neededMinutes: c.minimum ?? need,
        });
      }
      continue;
    }

    if (isMinimum) codes.push('REDUCED');
    if (slots.length > 1) codes.push('SPLIT');
    if (settings.energyMatching && energy && ENERGY_RANK[c.task.energyRequired] === ENERGY_RANK[energy]) codes.push('ENERGY_FIT');
    const reason = reasonText(codes, c, tz);
    for (const s of slots) {
      const pb: ProposedBlock = {
        id: makeId(),
        taskId: c.task.id,
        title: c.task.title,
        startMs: s.start,
        endMs: s.end,
        minutes: Math.round((s.end - s.start) / 60_000),
        isMinimum,
        kept: false,
        reasonCodes: codes,
        reason,
      };
      c.blocks.push(pb);
      c.placedMinutes += pb.minutes;
    }
    windows = consume(windows, slots, breakMs);
  }

  // 7. 彙整
  const blocks = candidates
    .flatMap((c) => c.blocks)
    .sort((a, b) => a.startMs - b.startMs);
  const plannedMinutes = blocks.reduce((s, b) => s + b.minutes, 0);

  // 下一步
  let nextAction: NextAction | null = null;
  if (blocks.length > 0) {
    const activeCand = candidates.find((c) => isActive(c) && c.blocks.length > 0);
    const pinnedCand = candidates.find((c) => isPinned(c) && c.blocks.length > 0);
    const lead = activeCand ?? pinnedCand;
    const first = lead ? lead.blocks.slice().sort((a, b) => a.startMs - b.startMs)[0] : blocks[0];
    const cand = candById.get(first.taskId)!;
    const parts: string[] = [];
    if (first.reasonCodes.includes('IN_PROGRESS') || first.kept && isActive(cand)) parts.push('已在進行中，先把它做完');
    if (isPinned(cand)) parts.push('你選擇先做這個');
    if (cand.tier === 0) parts.push('已超過截止時間');
    else if (cand.tier === 1) parts.push(`今天 ${formatTime(cand.dueMs!, tz)} 截止`);
    else if (cand.tier === 2) parts.push('48 小時內截止');
    if (cand.task.priority === 'P1') parts.push('優先級最高');
    if (cand.task.deferCount >= 2) parts.push(`已被延後 ${cand.task.deferCount} 次`);
    if (first.isMinimum) parts.push(`時間不夠，先做最低版本${cand.task.minimumOutcome ? `：${cand.task.minimumOutcome}` : ''}`);
    if (parts.length === 0) parts.push('目前可用時段裡優先級最高、最早排定');
    let warning: string | undefined;
    if (energy === 'low' && cand.task.energyRequired === 'high') {
      warning = '你現在精力低，但這件事需要高專注；可以先做最低成果版本，或先休息 15 分鐘再開始。';
    }
    nextAction = { block: first, reason: parts.join('；'), reasonCodes: first.reasonCodes, warning };
  }

  // 差異
  const existingByTask = new Map<string, WorkBlock[]>();
  for (const b of existing) existingByTask.set(b.taskId, [...(existingByTask.get(b.taskId) ?? []), b]);
  const moved: PlanDiff['moved'] = [];
  const added: ProposedBlock[] = [];
  for (const b of blocks) {
    if (b.kept) continue;
    const prev = existingByTask.get(b.taskId)?.find((e) => removed.includes(e));
    if (prev) {
      moved.push({ block: b, fromStartMs: new Date(prev.startAt).getTime(), fromEndMs: new Date(prev.endAt).getTime() });
      existingByTask.set(b.taskId, existingByTask.get(b.taskId)!.filter((e) => e !== prev));
    } else added.push(b);
  }
  const shortened: PlanDiff['shortened'] = [];
  for (const c of candidates) {
    const before = (existingByTask.get(c.task.id) ?? []).concat(removed.filter((r) => r.taskId === c.task.id));
    const beforeMinutes = existing.filter((e) => e.taskId === c.task.id).reduce((s, e) => s + (new Date(e.endAt).getTime() - new Date(e.startAt).getTime()) / 60_000, 0);
    void before;
    if (beforeMinutes > 0 && c.placedMinutes > 0 && c.placedMinutes < beforeMinutes - 1) {
      shortened.push({ taskId: c.task.id, title: c.task.title, fromMinutes: Math.round(beforeMinutes), toMinutes: c.placedMinutes });
    }
  }
  const diff: PlanDiff = { added, kept: keptBlocks, moved, shortened, removed, deferred: unscheduled };

  // 說明與警示
  if (pinnedId) explanation.push(`你選擇先做「${candById.get(pinnedId)!.task.title}」，其餘任務依規則重排。`);
  explanation.unshift(
    `從 ${formatTime(nowMs, tz)} 到 ${formatTime(availability.workWindow.end, tz)}，扣掉 ${busy.length} 個行程、睡眠與緩衝，還有 ${formatDuration(availableMinutes)} 可用；候選任務共需 ${formatDuration(candidateMinutes)}。`,
  );
  for (const c of candidates) {
    if (c.blocks.length === 0) continue;
    const first = c.blocks[0];
    const why: string[] = [];
    if (first.reasonCodes.includes('KEPT') && c.blocks.every((b) => b.kept)) {
      explanation.push(`「${c.task.title}」原本的安排不受影響，保留。`);
      continue;
    }
    if (c.tier === 0) why.push('已逾期');
    else if (c.tier === 1) why.push('今天截止');
    else if (c.tier === 2) why.push('48 小時內截止');
    why.push(`${c.task.priority}`);
    if (c.task.deferCount >= 2) why.push(`已延後 ${c.task.deferCount} 次`);
    const times = c.blocks.map((b) => `${formatTime(b.startMs, tz)}–${formatTime(b.endMs, tz)}`).join('、');
    if (first.isMinimum) {
      explanation.push(`「${c.task.title}」完整版 ${formatDuration(c.remaining)} 排不下，改排最低版本 ${formatDuration(c.placedMinutes)}（${times}）${c.task.minimumOutcome ? `：${c.task.minimumOutcome}` : ''}。`);
    } else {
      explanation.push(`「${c.task.title}」排在 ${times}（${why.join('、')}）。`);
    }
  }
  for (const u of unscheduled) {
    const tomorrowHint =
      input.tomorrow && u.suggestion === 'defer_tomorrow'
        ? `，明天約有 ${formatDuration(Math.max(0, input.tomorrow.availableMinutes - input.tomorrow.plannedMinutes))} 空檔`
        : '';
    explanation.push(`「${u.title}」今天排不進去：${u.reason}${tomorrowHint}。`);
  }
  for (const t of blockedByDeps) {
    explanation.push(`「${t.title}」的前置任務還沒完成，先不排。`);
  }
  if (calibratedTitles.length) explanation.push(`依你過去的實際 / 預估比例調整了工時：${calibratedTitles.join('、')}。可在設定關閉。`);

  const starving = candidates.filter((c) => c.task.deferCount >= 2);
  if (starving.length) warnings.push(`這些任務已被反覆延後：${starving.map((c) => `${c.task.title}（${c.task.deferCount} 次）`).join('、')}。考慮固定保留一段時間，或重新評估是否還需要做。`);
  if (candidateMinutes > availableMinutes) warnings.push(`今天的時間不夠做完所有候選任務：需要 ${formatDuration(candidateMinutes)}，只有 ${formatDuration(availableMinutes)}。`);
  const missed = unscheduled.filter((u) => u.reasonCode === 'DEADLINE_MISSED');
  for (const m of missed) warnings.push(`「${m.title}」無法在截止前完成，需要你決定取捨。`);
  if (nextAction?.warning) warnings.push(nextAction.warning);

  return {
    date,
    generatedAt: nowMs,
    trigger: incident?.type ?? 'replan',
    nextAction,
    blocks,
    unscheduled,
    warnings,
    explanation,
    diff,
    effects,
    feasible: missed.length === 0,
    stats: { availableMinutes, plannedMinutes, candidateMinutes },
    availability: { ...availability, windows: mergeIntervals(availability.windows) },
    ranked: candidates.map((c) => c.task.id),
    pinnedTaskId: pinnedId,
    busy: busy.slice().sort((a, b) => a.startMs - b.startMs),
  };
}
