/**
 * 「把今天要做的事打出來」的解析：每行（或用、，,；分隔）一件事，純規則、零成本。
 *
 *   讀英文 60          → 60 分鐘
 *   寫報告 1.5h        → 90 分鐘
 *   整理筆記 30分       → 30 分鐘
 *   交作業 17:00前 !    → 截止今天 17:00、優先級高
 *   背單字              → 沒寫時間就用預設（30 分鐘）
 *
 * 只抓「時間長度」「截止」「!」三種標記，其餘全部當標題。
 */
import type { Priority } from '@/db/schema';
import { localDateTimeToIso, type HHmm, type LocalDate } from '@/lib/time';

export const DEFAULT_QUICK_MINUTES = 30;

export interface QuickTask {
  title: string;
  estimatedMinutes: number;
  priority: Priority;
  /** HH:mm（今天） */
  dueTime?: HHmm;
  /** 時間是使用者寫的，還是預設 */
  explicitMinutes: boolean;
}

const HOUR_RE = /(\d+(?:\.\d+)?)\s*(?:小時|hr?s?|小时)(?:\s*(\d+)\s*(?:分鐘|分|min|m))?/i;
const MIN_RE = /(\d+)\s*(?:分鐘|分|mins?|m)(?![a-z])/i;
const BARE_NUM_RE = /(?:^|\s)(\d{1,3})\s*$/;
const DUE_RE = /(?:(\d{1,2})(?::|：)(\d{2})|(?:下午|晚上|中午)?\s*(\d{1,2})\s*點(?:(\d{1,2})分?|半)?)\s*(?:前|之前|截止|到期|due)/i;
const PM_WORDS = /(下午|晚上)/;

function clampMinutes(n: number): number {
  return Math.max(5, Math.min(1440, Math.round(n / 5) * 5));
}

export function parseQuickLine(raw: string): QuickTask | null {
  let s = raw.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim();
  if (!s) return null;

  let priority: Priority = 'P2';
  const bangs = (s.match(/[!！]/g) ?? []).length;
  if (bangs > 0) {
    priority = 'P1';
    s = s.replace(/[!！]/g, ' ');
  }
  if (/(?:^|\s)(低|不急|low)(?:\s|$)/.test(s)) {
    priority = 'P3';
    s = s.replace(/(?:^|\s)(低|不急|low)(?=\s|$)/, ' ');
  }

  let dueTime: HHmm | undefined;
  const due = s.match(DUE_RE);
  if (due) {
    let h: number;
    let m = 0;
    if (due[1]) {
      h = Number(due[1]);
      m = Number(due[2]);
    } else {
      h = Number(due[3]);
      if (due[4]) m = Number(due[4]);
      else if (/半/.test(due[0])) m = 30;
      if (PM_WORDS.test(due[0]) && h < 12) h += 12;
    }
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) dueTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` as HHmm;
    s = s.replace(due[0], ' ');
  }

  let minutes: number | undefined;
  const hour = s.match(HOUR_RE);
  if (hour) {
    minutes = Number(hour[1]) * 60 + (hour[2] ? Number(hour[2]) : 0);
    s = s.replace(hour[0], ' ');
  } else {
    const min = s.match(MIN_RE);
    if (min) {
      minutes = Number(min[1]);
      s = s.replace(min[0], ' ');
    } else {
      const bare = s.match(BARE_NUM_RE);
      if (bare) {
        minutes = Number(bare[1]);
        s = s.replace(bare[0], ' ');
      }
    }
  }

  const title = s.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return {
    title: title.slice(0, 120),
    estimatedMinutes: minutes !== undefined && minutes > 0 ? clampMinutes(minutes) : DEFAULT_QUICK_MINUTES,
    priority,
    dueTime,
    explicitMinutes: minutes !== undefined && minutes > 0,
  };
}

export function parseQuickTasks(text: string): QuickTask[] {
  const lines = text
    .split(/\n|、|，|,|；|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: QuickTask[] = [];
  for (const l of lines) {
    const t = parseQuickLine(l);
    if (t) out.push(t);
  }
  return out;
}

export function quickTaskDueAt(t: QuickTask, date: LocalDate, tz: string): string | undefined {
  return t.dueTime ? localDateTimeToIso(date, t.dueTime, tz) : undefined;
}
