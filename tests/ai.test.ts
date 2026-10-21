import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cnNumber, matchTask, nlParse, parseClock, parseDuration } from '@/ai/nlParse';
import { parsedToIncident } from '@/ai/toIncident';
import { ClaudeProxyProvider } from '@/ai/claudeProxy';
import { resolveIncidentText } from '@/ai/resolve';
import { AiError } from '@/ai/types';
import { clearAllData, createTask, getSettings, updateSettings } from '@/db/repo';
import { getUsage } from '@/db/usage';
import type { Task } from '@/db/schema';
import { localDateTimeToMs, toLocalTime, todayLocal } from '@/lib/time';

const TPE = 'Asia/Taipei';
const tasks = [
  { id: 'la', title: '複習線性代數第 3–4 章（示範）' },
  { id: 'hw', title: '寫線代習題 4.2' },
  { id: 'gym', title: '健身房 45 分鐘' },
  { id: 'mail', title: '回覆社團總務信件' },
];
const ctx = { now: '10:30', tasks };

describe('中文數字與時間', () => {
  it('cnNumber', () => {
    expect(cnNumber('十一')).toBe(11);
    expect(cnNumber('兩')).toBe(2);
    expect(cnNumber('二十五')).toBe(25);
    expect(cnNumber('半')).toBe(0.5);
    expect(cnNumber('15')).toBe(15);
    expect(Number.isNaN(cnNumber('abc'))).toBe(true);
  });
  it('parseClock', () => {
    expect(parseClock('我睡到11點', '11:05')).toBe('11:00');
    expect(parseClock('下午三點半', '10:00')).toBe('15:30');
    expect(parseClock('三點', '10:30')).toBe('15:00'); // 已過去 → 當下午
    expect(parseClock('十一點', '11:05', 'am')).toBe('11:00');
    expect(parseClock('晚上八點', '10:00')).toBe('20:00');
    expect(parseClock('15:30', '10:00')).toBe('15:30');
    expect(parseClock('十一點', '11:05')).toBe('11:00');
    expect(parseClock('沒有時間', '10:00')).toBeUndefined();
  });
  it('parseDuration', () => {
    expect(parseDuration('少了兩小時')).toBe(120);
    expect(parseDuration('一個半小時')).toBe(90);
    expect(parseDuration('半小時')).toBe(30);
    expect(parseDuration('再 40 分鐘')).toBe(40);
    expect(parseDuration('二十分')).toBe(20);
    expect(parseDuration('沒有')).toBeUndefined();
  });
  it('matchTask 用子字串比對，示範標籤不影響', () => {
    expect(matchTask('線代習題寫完了', tasks)?.id).toBe('hw');
    expect(matchTask('線性代數看完了', tasks)?.id).toBe('la');
    expect(matchTask('健身房去完了', tasks)?.id).toBe('gym');
    expect(matchTask('今天好累', tasks)).toBeUndefined();
  });
});

describe('規則解析', () => {
  it('睡過頭', () => {
    const p = nlParse('我今天睡到十一點', ctx);
    expect(p).toMatchObject({ type: 'overslept', wakeTime: '11:00' });
    expect(p.confidence).toBeGreaterThanOrEqual(0.8);
    expect(nlParse('睡過頭了', ctx)).toMatchObject({ type: 'overslept', wakeTime: '10:30' });
  });
  it('臨時有事：區間', () => {
    const p = nlParse('下午臨時有課，三點到五點', ctx);
    expect(p).toMatchObject({ type: 'lost_time', startTime: '15:00', endTime: '17:00' });
    expect(p.confidence).toBeGreaterThanOrEqual(0.8);
    expect(nlParse('14:00-16:30 要去開會', ctx)).toMatchObject({ type: 'lost_time', startTime: '14:00', endTime: '16:30' });
  });
  it('臨時有事：時長', () => {
    expect(nlParse('突然要去處理事情，接下來少了兩小時', ctx)).toMatchObject({ type: 'lost_time', startTime: '10:30', endTime: '12:30' });
    const vague = nlParse('臨時有事', ctx);
    expect(vague.type).toBe('lost_time');
    expect(vague.missing).toContain('endTime');
    expect(vague.confidence).toBeLessThan(0.8);
  });
  it('提早完成與超時', () => {
    expect(nlParse('線代習題提早寫完了', ctx)).toMatchObject({ type: 'task_done', taskId: 'hw' });
    const over = nlParse('線代習題超時，還需要 40 分鐘', ctx);
    expect(over).toMatchObject({ type: 'overrun', taskId: 'hw', remainingMinutes: 40 });
    expect(over.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it('精力、休息、重排、無法判斷', () => {
    expect(nlParse('我現在精神很差', ctx)).toMatchObject({ type: 'energy', energy: 'low' });
    expect(nlParse('今天精神很好', ctx)).toMatchObject({ type: 'energy', energy: 'high' });
    expect(nlParse('想先休息二十分鐘', ctx)).toMatchObject({ type: 'rest', minutes: 20 });
    expect(nlParse('幫我重排一下', ctx)).toMatchObject({ type: 'replan' });
    expect(nlParse('呃', ctx)).toMatchObject({ type: 'unknown', confidence: 0 });
  });
});

function task(p: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    status: 'todo',
    priority: 'P2',
    estimatedMinutes: 60,
    energyRequired: 'medium',
    splittable: true,
    dependencies: [],
    deferCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...p,
  };
}

describe('AI 輸出 → 事件（驗收 9：拒絕虛構）', () => {
  const now = localDateTimeToMs('2026-10-21', '10:30', TPE);
  const tctx = { nowMs: now, tz: TPE, tasks: [task({ id: 'a', title: 'A' }), task({ id: 'd', title: '完成了', status: 'done' })] };
  it('虛構的任務 id 被拒絕', () => {
    expect(() => parsedToIncident({ type: 'task_done', taskId: 'ghost', confidence: 1, missing: [], note: '' }, tctx)).toThrow('不存在');
  });
  it('已完成的任務不能再被標記', () => {
    expect(() => parsedToIncident({ type: 'overrun', taskId: 'd', confidence: 1, missing: [], note: '' }, tctx)).toThrow('已經完成');
  });
  it('臨時有事缺結束時間被拒絕；跨午夜會加一天', () => {
    expect(() => parsedToIncident({ type: 'lost_time', startTime: '10:00', confidence: 1, missing: ['endTime'], note: '' }, tctx)).toThrow('到幾點');
    const inc = parsedToIncident({ type: 'lost_time', startTime: '23:00', endTime: '01:00', confidence: 1, missing: [], note: '' }, tctx);
    expect(inc.type === 'lost_time' && toLocalTime(inc.endMs, TPE)).toBe('01:00');
    expect(inc.type === 'lost_time' && inc.endMs - inc.startMs).toBe(2 * 3_600_000);
  });
  it('unknown 類型被拒絕', () => {
    expect(() => parsedToIncident({ type: 'unknown', confidence: 0, missing: ['type'], note: '' }, tctx)).toThrow('無法判斷');
  });
});

describe('ClaudeProxyProvider（驗收 9：非法 JSON / API 失敗）', () => {
  const mk = (fetchImpl: typeof fetch) => new ClaudeProxyProvider({ proxyUrl: 'https://w.example', proxySecret: 's', model: 'claude-haiku-5-5', maxOutputTokens: 512, fetchImpl });
  const ctxAi = { now: '10:30', date: '2026-10-21', timeZone: TPE, workStart: '08:00', workEnd: '23:00', tasks: [], events: [] };

  it('Worker 回非法 JSON → bad_response', async () => {
    const p = mk(vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch);
    await expect(p.parseIncident('x', ctxAi)).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('結構不符 Zod → bad_output', async () => {
    const p = mk(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { type: 'dance', confidence: 2 } }), { status: 200 })) as unknown as typeof fetch);
    await expect(p.parseIncident('x', ctxAi)).rejects.toMatchObject({ code: 'bad_output' });
  });
  it('Worker 錯誤碼原樣轉成 AiError；未知碼變 unknown', async () => {
    const p = mk(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'no_credits', message: 'x' } }), { status: 402 })) as unknown as typeof fetch);
    await expect(p.parseIncident('x', ctxAi)).rejects.toMatchObject({ code: 'no_credits' });
    const q = mk(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'weird' } }), { status: 500 })) as unknown as typeof fetch);
    await expect(q.parseIncident('x', ctxAi)).rejects.toMatchObject({ code: 'unknown' });
  });
  it('網路失敗 → network；沒設定 → not_configured', async () => {
    const p = mk(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch);
    await expect(p.parseIncident('x', ctxAi)).rejects.toMatchObject({ code: 'network' });
    const q = new ClaudeProxyProvider({ proxyUrl: '', proxySecret: '', model: 'claude-haiku-5-5', maxOutputTokens: 512 });
    await expect(q.health()).rejects.toBeInstanceOf(AiError);
  });
  it('成功時帶回 usage 與 model，請求帶通關密語且不含任何 API key', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { type: 'energy', energy: 'low', confidence: 0.9, missing: [], note: '累' }, usage: { inputTokens: 700, outputTokens: 50 }, model: 'claude-haiku-5-5' }), { status: 200 }),
    );
    const p = mk(f as unknown as typeof fetch);
    const r = await p.parseIncident('好累', ctxAi);
    expect(r.parsed.type).toBe('energy');
    expect(r.usage.inputTokens).toBe(700);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://w.example/v1/ai');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s');
    expect(JSON.stringify(init)).not.toMatch(/sk-ant|x-api-key/);
  });
});

describe('降級鏈（驗收 10：無 key 也能用）', () => {
  beforeEach(async () => {
    await clearAllData();
  });
  const today = todayLocal(TPE);
  const nowMs = localDateTimeToMs(today, '10:30', TPE);

  it('規則夠確定時不呼叫 AI', async () => {
    const t = await createTask({ title: '寫線代習題 4.2', plannedDate: today });
    const settings = await updateSettings({ ai: { enabled: true, provider: 'claude', proxyUrl: 'https://w.example', proxySecret: 's', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    const f = vi.fn();
    const r = await resolveIncidentText('線代習題寫完了', { nowMs, tz: TPE, tasks: [await taskById(t.id)], occurrences: [], settings }, f as unknown as typeof fetch);
    expect(r.source).toBe('rules');
    expect(r.incident).toMatchObject({ type: 'task_done', taskId: t.id });
    expect(f).not.toHaveBeenCalled();
  });

  it('AI 關閉時用規則結果並附說明；完全沒 key 也不會壞', async () => {
    const settings = await getSettings();
    const r = await resolveIncidentText('臨時有事', { nowMs, tz: TPE, tasks: [], occurrences: [], settings });
    expect(r.source).toBe('rules');
    expect(r.notice).toContain('AI 助手未啟用');
    expect(r.incident).toBeUndefined(); // 缺 endTime，交給表單補
    expect(r.parsed.type).toBe('lost_time');
  });

  it('規則不確定且 AI 可用 → 呼叫 AI，記錄用量，並核對 task id', async () => {
    const t = await createTask({ title: '微積分報告', plannedDate: today });
    const settings = await updateSettings({ ai: { enabled: true, provider: 'claude', proxyUrl: 'https://w.example', proxySecret: 's', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { type: 'task_done', taskId: t.id, confidence: 0.9, missing: [], note: '報告交了' }, usage: { inputTokens: 900, outputTokens: 40 }, model: 'claude-haiku-5-5' }), { status: 200 }),
    );
    const r = await resolveIncidentText('報告剛剛交出去了耶', { nowMs, tz: TPE, tasks: [await taskById(t.id)], occurrences: [], settings }, f as unknown as typeof fetch);
    expect(r.source).toBe('ai');
    expect(r.incident).toMatchObject({ type: 'task_done', taskId: t.id });
    expect((await getUsage(today)).calls).toBe(1);

    // AI 回虛構 id → 轉換失敗，notice 說明，不會變成事件
    const g = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { type: 'task_done', taskId: 'ghost', confidence: 0.9, missing: [], note: '' }, usage: { inputTokens: 1, outputTokens: 1 } }), { status: 200 }));
    const r2 = await resolveIncidentText('報告交出去了耶', { nowMs, tz: TPE, tasks: [await taskById(t.id)], occurrences: [], settings }, g as unknown as typeof fetch);
    expect(r2.incident).toBeUndefined();
    expect(r2.notice).toContain('不存在');
  });

  it('AI 失敗 → 退回規則結果並說明原因；達每日上限不再呼叫', async () => {
    const settings = await updateSettings({ ai: { enabled: true, provider: 'claude', proxyUrl: 'https://w.example', proxySecret: 's', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 1 } });
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'no_credits', message: 'low' } }), { status: 402 }));
    const r = await resolveIncidentText('報告交出去了耶', { nowMs, tz: TPE, tasks: [], occurrences: [], settings }, f as unknown as typeof fetch);
    expect(r.source).toBe('rules');
    expect(r.notice).toContain('額度已用完');
    expect(f).toHaveBeenCalledTimes(1);

    const g = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { type: 'replan', confidence: 0.9, missing: [], note: '' }, usage: { inputTokens: 1, outputTokens: 1 } }), { status: 200 }));
    await resolveIncidentText('報告交出去了耶', { nowMs, tz: TPE, tasks: [], occurrences: [], settings }, g as unknown as typeof fetch);
    const r3 = await resolveIncidentText('報告交出去了耶', { nowMs, tz: TPE, tasks: [], occurrences: [], settings }, g as unknown as typeof fetch);
    expect(g).toHaveBeenCalledTimes(1);
    expect(r3.notice).toContain('上限');
  });
});

async function taskById(id: string): Promise<Task> {
  const { db } = await import('@/db/db');
  return (await db.tasks.get(id))!;
}
