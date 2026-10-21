/**
 * 統計與校正（純函數）。
 *
 * - 週統計：每日各分類實際時數、完成任務數
 * - 預估校正：已完成且有實際工時的任務，實際 / 預估 的中位數（整體與依精力分組）
 * - 延期分析：被延後次數最多的未完成任務
 */
import type { ActivityLog, Energy, LogCategory, Task } from '@/db/schema';
import { addLocalDays, toLocalDate, type LocalDate } from '@/lib/time';

export interface DayStat {
  date: LocalDate;
  minutesByCategory: Partial<Record<LogCategory, number>>;
  totalMinutes: number;
  completedTasks: number;
  plannedTasks: number;
}

export function weekStats(logs: ActivityLog[], tasks: Task[], weekStart: LocalDate, tz: string, nowMs: number): DayStat[] {
  const days: DayStat[] = Array.from({ length: 7 }, (_, i) => ({ date: addLocalDays(weekStart, i), minutesByCategory: {}, totalMinutes: 0, completedTasks: 0, plannedTasks: 0 }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const l of logs) {
    const d = byDate.get(l.date);
    if (!d) continue;
    const end = l.endAt ? new Date(l.endAt).getTime() : nowMs;
    const mins = Math.max(0, (end - new Date(l.startAt).getTime()) / 60_000);
    d.minutesByCategory[l.category] = (d.minutesByCategory[l.category] ?? 0) + mins;
    d.totalMinutes += mins;
  }
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
    if (t.completedAt) {
      const d = byDate.get(toLocalDate(t.completedAt, tz));
      if (d) d.completedTasks += 1;
    }
    if (t.plannedDate) {
      const d = byDate.get(t.plannedDate);
      if (d) d.plannedTasks += 1;
    }
  }
  for (const d of days) d.totalMinutes = Math.round(d.totalMinutes);
  return days;
}

export interface CalibrationResult {
  /** 整體中位數（實際 / 預估）；樣本不足為 undefined */
  factor?: number;
  samples: number;
  byEnergy: Partial<Record<Energy, { factor: number; samples: number }>>;
  /** 最近一筆樣本的日期 */
  latestAt?: string;
}

export const CALIBRATION_MIN_SAMPLES = 3;

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 以已完成任務的「實際 / 預估」比例算校正係數；極端值裁到 0.25–4 */
export function calibration(tasks: Task[]): CalibrationResult {
  const samples: Array<{ ratio: number; energy: Energy; at: string }> = [];
  for (const t of tasks) {
    if (t.status !== 'done' || !t.actualMinutes || t.actualMinutes < 5 || !t.estimatedMinutes) continue;
    const ratio = Math.min(4, Math.max(0.25, t.actualMinutes / t.estimatedMinutes));
    samples.push({ ratio, energy: t.energyRequired, at: t.completedAt ?? t.updatedAt });
  }
  const byEnergy: CalibrationResult['byEnergy'] = {};
  for (const e of ['high', 'medium', 'low'] as Energy[]) {
    const xs = samples.filter((s) => s.energy === e).map((s) => s.ratio);
    if (xs.length >= CALIBRATION_MIN_SAMPLES) byEnergy[e] = { factor: round2(median(xs)), samples: xs.length };
  }
  const latest = samples.map((s) => s.at).sort().pop();
  return {
    factor: samples.length >= CALIBRATION_MIN_SAMPLES ? round2(median(samples.map((s) => s.ratio))) : undefined,
    samples: samples.length,
    byEnergy,
    latestAt: latest,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 給某個任務的校正後預估（優先用同精力的係數） */
export function calibratedMinutes(estimated: number, energy: Energy, cal: CalibrationResult | undefined): { minutes: number; factor: number; basis: 'energy' | 'overall' | 'none' } {
  if (!cal) return { minutes: estimated, factor: 1, basis: 'none' };
  const e = cal.byEnergy[energy];
  if (e) return { minutes: Math.round(estimated * e.factor), factor: e.factor, basis: 'energy' };
  if (cal.factor) return { minutes: Math.round(estimated * cal.factor), factor: cal.factor, basis: 'overall' };
  return { minutes: estimated, factor: 1, basis: 'none' };
}

export interface DeferralItem {
  task: Task;
  deferCount: number;
}

export function deferralAnalysis(tasks: Task[]): { items: DeferralItem[]; averageDefers: number; starving: number } {
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const items = open
    .filter((t) => t.deferCount > 0)
    .map((t) => ({ task: t, deferCount: t.deferCount }))
    .sort((a, b) => b.deferCount - a.deferCount)
    .slice(0, 5);
  const total = open.reduce((s, t) => s + t.deferCount, 0);
  return { items, averageDefers: open.length ? Math.round((total / open.length) * 10) / 10 : 0, starving: open.filter((t) => t.deferCount >= 2).length };
}

/** 完成歷史：最近 N 天每天完成數（給 sparkline） */
export function completionHistory(tasks: Task[], today: LocalDate, days: number, tz: string): Array<{ date: LocalDate; count: number }> {
  const out = Array.from({ length: days }, (_, i) => ({ date: addLocalDays(today, i - days + 1), count: 0 }));
  const idx = new Map(out.map((d, i) => [d.date, i]));
  for (const t of tasks) {
    if (!t.completedAt) continue;
    const i = idx.get(toLocalDate(t.completedAt, tz));
    if (i !== undefined) out[i].count += 1;
  }
  return out;
}
