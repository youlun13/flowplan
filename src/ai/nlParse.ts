/**
 * 規則式中文狀況解析（零成本、離線、即時）。
 *
 * 目標是吃掉最常見的日常句型；吃不掉的交給 AI，AI 也不行就回到結構化表單。
 * 輸出與模型相同的 ParsedIncident 結構，confidence 代表這條規則有多確定。
 */
import type { ParsedIncident } from './types';
import { minutesToTime, timeToMinutes, type HHmm } from '@/lib/time';

export interface NlTask {
  id: string;
  title: string;
}

export interface NlContext {
  now: HHmm;
  tasks: NlTask[];
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十一」「二十五」「兩」「半」→ 數字；回傳 NaN 代表不是數字 */
export function cnNumber(s: string): number {
  const t = s.trim();
  if (!t) return Number.NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === '半') return 0.5;
  let total = 0;
  let cur = 0;
  let sawTen = false;
  for (const ch of t) {
    if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
      sawTen = true;
    } else if (ch in CN_DIGITS) {
      cur = CN_DIGITS[ch];
    } else if (ch === '半') {
      total += cur;
      cur = 0;
      total += 0.5;
    } else {
      return Number.NaN;
    }
  }
  total += cur;
  if (!sawTen && t.length > 1 && !t.includes('半')) {
    // 例如「一二」這種不合法
    return Number.NaN;
  }
  return total;
}

function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[：]/g, ':')
    .replace(/[～〜~]/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUM = '(\\d{1,2}|[一二兩三四五六七八九十]+)';

/**
 * 解析「下午三點半」「15:30」「11點」「晚上八點」→ HH:mm
 * bias：沒寫上下午時怎麼猜。'am' 偏早上（起床時間）；'auto' = 已經過去超過一小時就當下午。
 */
export function parseClock(text: string, nowHHmm?: HHmm, bias: 'am' | 'auto' = 'auto', periodHint?: string): HHmm | undefined {
  const t = normalize(text);
  const m = t.match(new RegExp(`(凌晨|早上|上午|中午|下午|傍晚|晚上|半夜)?\\s*${NUM}\\s*(?::|點)\\s*(半|\\d{1,2}|[一二三四五六七八九十]+分?)?`));
  if (!m) return undefined;
  const period = m[1] || periodHint;
  let hour = cnNumber(m[2]);
  if (Number.isNaN(hour) || hour > 24) return undefined;
  let minute = 0;
  if (m[3]) {
    if (m[3] === '半') minute = 30;
    else {
      const raw = m[3].replace('分', '');
      const n = cnNumber(raw);
      // 「11點5」通常是 11:05；「3點15」是 3:15
      minute = Number.isNaN(n) ? 0 : n;
    }
  }
  if (period === '下午' || period === '傍晚' || period === '晚上') {
    if (hour < 12) hour += 12;
  } else if (period === '凌晨' || period === '半夜') {
    if (hour === 12) hour = 0;
  } else if (period === '中午') {
    if (hour < 11) hour += 12;
  } else if (!period && nowHHmm && bias === 'auto') {
    // 沒寫上下午：這個時間已經過去超過一小時，而且 +12 還在今天 → 當作下午
    const nowMin = timeToMinutes(nowHHmm);
    const asIs = hour * 60 + minute;
    if (hour < 12 && nowMin - asIs > 60 && hour + 12 <= 23) hour += 12;
  }
  if (hour > 23 || minute > 59) return undefined;
  return minutesToTime(hour * 60 + minute);
}

/** 解析「兩小時」「一個半小時」「40 分鐘」「半小時」→ 分鐘 */
export function parseDuration(text: string): number | undefined {
  const t = normalize(text);
  const h = t.match(new RegExp(`(${NUM}|半)\\s*個?\\s*(半)?\\s*(小時|hr|h)`, 'i'));
  if (h) {
    const base = h[1] === '半' ? 0.5 : cnNumber(h[1]);
    if (!Number.isNaN(base)) return Math.round((base + (h[3] ? 0.5 : 0)) * 60);
  }
  const m = t.match(new RegExp(`${NUM}\\s*(分鐘|分|min)`, 'i'));
  if (m) {
    const n = cnNumber(m[1]);
    if (!Number.isNaN(n)) return Math.round(n);
  }
  return undefined;
}

/** 在任務清單裡找最像的任務；回傳 id 與分數（0–1） */
export function matchTask(text: string, tasks: NlTask[]): { id: string; score: number; title: string } | undefined {
  const t = normalize(text).toLowerCase();
  let best: { id: string; score: number; title: string } | undefined;
  for (const task of tasks) {
    const title = task.title.replace(/[（(].*?[）)]/g, '').trim();
    if (!title) continue;
    const lower = title.toLowerCase();
    let score = 0;
    if (t.includes(lower)) score = 1;
    else {
      // 最長共同子字串（≥ 2 字）；長標題只要對到 3 個字以上就算強匹配
      let longest = 0;
      for (let i = 0; i < lower.length; i++) {
        for (let j = i + 2; j <= lower.length; j++) {
          const sub = lower.slice(i, j);
          if (/^[\s，,。、的了 ]+$/.test(sub)) continue;
          if (t.includes(sub)) longest = Math.max(longest, j - i);
        }
      }
      score = Math.min(1, longest / Math.min(lower.length, 6));
    }
    if (score > 0 && (!best || score > best.score)) best = { id: task.id, score, title: task.title };
  }
  return best && best.score >= 0.5 ? best : undefined;
}

export function nlParse(text: string, ctx: NlContext): ParsedIncident {
  const t = normalize(text);
  const nowMin = timeToMinutes(ctx.now);
  const base = { missing: [] as string[], note: '' };

  // 1. 臨時有事：明確區間
  const range = t.match(new RegExp(`((?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\\s*${NUM}\\s*(?::|點)\\s*(?:半|\\d{1,2})?)\\s*(?:到|至|~|-|–)\\s*((?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\\s*${NUM}\\s*(?::|點)?\\s*(?:半|\\d{1,2})?)`));
  const busyWords = /(臨時|突然|有事|要去|出門|開會|被叫|沒空|不能(做|工作|讀)|要處理|被抓去|要回|家教|打工|約了|面試|看醫生)/;
  if (range && !/睡|起床/.test(t)) {
    const hint = (t.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|半夜)/) ?? [])[1];
    const start = parseClock(range[1], ctx.now, 'auto', hint);
    // NUM 本身是擷取群組，所以結束時間是 range[3]
    let endText = range[3];
    if (!/[:點]/.test(endText)) endText = `${endText}點`;
    const end = parseClock(endText, ctx.now, 'auto', hint);
    if (start && end) {
      const title = t.replace(range[0], '').replace(busyWords, '$1').replace(/[，,。！!、\s]+/g, ' ').trim();
      return { type: 'lost_time', startTime: start, endTime: end, title: title.length > 1 && title.length <= 20 ? title : undefined, confidence: 0.9, ...base, note: `${start}–${end} 不能工作` };
    }
  }

  // 2. 睡過頭
  if (/(睡到|睡過頭|起床|賴床|剛醒|睡太晚|睡晚了|睡死)/.test(t)) {
    const explicit = parseClock(t, ctx.now, 'am');
    const wake = explicit ?? ctx.now;
    return { type: 'overslept', wakeTime: wake, confidence: explicit ? 0.9 : 0.75, ...base, note: `今天 ${wake} 才開始` };
  }

  // 3. 臨時有事：以時長描述（少了兩小時 / 接下來一小時不能做）
  const dur = parseDuration(t);
  if (busyWords.test(t) || /少了|損失|沒了/.test(t)) {
    if (dur) {
      const start = ctx.now;
      const end = minutesToTime(Math.min(nowMin + dur, 23 * 60 + 59));
      return { type: 'lost_time', startTime: start, endTime: end, confidence: 0.8, ...base, note: `從現在起 ${dur} 分鐘不能工作` };
    }
    if (busyWords.test(t)) {
      return { type: 'lost_time', startTime: ctx.now, confidence: 0.5, missing: ['endTime'], note: '臨時有事，但不知道到幾點' };
    }
  }

  // 4. 提早完成（需要對到任務）
  if (/(做完|完成|寫完|弄完|搞定|結束|交了|交出去)/.test(t)) {
    const m = matchTask(t, ctx.tasks);
    if (m) return { type: 'task_done', taskId: m.id, confidence: Math.min(0.95, 0.6 + m.score * 0.35), ...base, note: `「${m.title}」已完成` };
    return { type: 'task_done', confidence: 0.4, missing: ['taskId'], note: '有東西做完了，但對不到任務' };
  }

  // 5. 超時
  if (/(超時|還沒(做|弄|寫)完|還需要|再給我|做不完|還要|來不及|比想的久|比預期久|卡住)/.test(t)) {
    const m = matchTask(t, ctx.tasks);
    const rem = dur;
    return {
      type: 'overrun',
      taskId: m?.id,
      remainingMinutes: rem,
      confidence: m && rem ? 0.85 : 0.45,
      missing: [...(m ? [] : ['taskId']), ...(rem ? [] : ['remainingMinutes'])],
      note: m ? `「${m.title}」超時${rem ? `，還需要 ${rem} 分鐘` : ''}` : '有任務超時，但對不到是哪一個',
    };
  }

  // 6. 休息
  if (/(休息|小睡|躺一下|喘口氣|午睡|先睡)/.test(t)) {
    return { type: 'rest', minutes: dur ?? 20, confidence: dur ? 0.9 : 0.75, ...base, note: `先休息 ${dur ?? 20} 分鐘` };
  }

  // 7. 精力
  if (/(精神很好|狀態很好|精力充沛|很有精神|超有勁|滿血)/.test(t)) return { type: 'energy', energy: 'high', confidence: 0.85, ...base, note: '精力高' };
  if (/(累|疲|沒精神|精神(很|不|超)?(差|好|不好)|想睡|狀態(很|不|超)?(差|不好)|提不起勁|沒力|頭痛|不舒服|低落)/.test(t)) {
    return { type: 'energy', energy: 'low', confidence: 0.85, ...base, note: '精力低' };
  }
  if (/(精力|狀態)\s*(還好|普通|一般|中)/.test(t)) return { type: 'energy', energy: 'medium', confidence: 0.8, ...base, note: '精力中等' };

  // 8. 純重排
  if (/(重排|重新(規劃|安排|排)|怎麼辦|接下來|下一步|幫我排)/.test(t)) return { type: 'replan', confidence: 0.7, ...base, note: '重新規劃今天' };

  return { type: 'unknown', confidence: 0, missing: ['type'], note: '規則解析無法判斷這是什麼狀況' };
}
