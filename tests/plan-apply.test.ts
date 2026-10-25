import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/db';
import { clearAllData, createEvent, createTask, getSettings, setTaskDone } from '@/db/repo';
import { applyProposal, latestRevisionForDate, listBlocksForDate, undoRevision } from '@/db/plan';
import { buildPlan, type PlannerInput } from '@/engine/planner';
import { expandEvents } from '@/engine/recurrence';
import { localDateTimeToIso, localDateTimeToMs, todayLocal, toLocalTime } from '@/lib/time';

const TPE = 'Asia/Taipei';
const today = todayLocal(TPE);
const ms = (t: string) => localDateTimeToMs(today, t, TPE);
const iso = (t: string) => localDateTimeToIso(today, t, TPE);

async function plannerInput(nowMs: number, incident?: PlannerInput['incident']): Promise<PlannerInput> {
  const settings = await getSettings();
  const tasks = await db.tasks.toArray();
  const events = await db.events.toArray();
  const busy = expandEvents(events, today, today, TPE).map((o) => ({ startMs: o.startMs, endMs: o.endMs, title: o.title, kind: 'event' as const }));
  return { nowMs, tz: TPE, settings, tasks, busy, existingBlocks: await listBlocksForDate(today), incident };
}

beforeEach(async () => {
  await clearAllData();
});

describe('套用 / 撤銷（驗收 11）', () => {
  it('預覽不寫資料；套用後寫入區塊與附帶效果；撤銷後完全還原', async () => {
    const a = await createTask({ title: '線代', priority: 'P1', estimatedMinutes: 60, plannedDate: today });
    const b = await createTask({ title: '健身', priority: 'P3', estimatedMinutes: 45, plannedDate: today, splittable: false });
    await createEvent({ title: '上課', kind: 'class', startAt: iso('15:00'), endAt: iso('17:00') });

    // 預覽
    const nowMs = ms('09:00');
    const proposal = buildPlan(await plannerInput(nowMs, { type: 'lost_time', startMs: ms('10:00'), endMs: ms('11:00'), title: '臨時有事' }));
    expect(proposal.blocks.length).toBeGreaterThan(0);
    expect(await db.workBlocks.count()).toBe(0);
    expect(await db.events.count()).toBe(1); // 取消 = 什麼都沒變

    // 套用
    const rev = await applyProposal(proposal, { nowMs, tz: TPE });
    const blocks = await listBlocksForDate(today);
    expect(blocks.length).toBe(proposal.blocks.length);
    expect(blocks.every((x) => x.status === 'planned' && x.revisionId === rev.id)).toBe(true);
    expect(await db.events.count()).toBe(2); // 臨時行程已加進日曆
    expect((await latestRevisionForDate(today))?.id).toBe(rev.id);
    for (const x of blocks) {
      const s = new Date(x.startAt).getTime();
      const e = new Date(x.endAt).getTime();
      expect(e <= ms('09:50') || (s >= ms('11:10') && e <= ms('14:50')) || s >= ms('17:10')).toBe(true);
    }

    // 撤銷
    await undoRevision(rev.id);
    expect(await db.workBlocks.count()).toBe(0);
    expect(await db.events.count()).toBe(1);
    expect((await db.planRevisions.get(rev.id))?.revertedAt).toBeTruthy();
    expect(await latestRevisionForDate(today)).toBeUndefined();
    await expect(undoRevision(rev.id)).rejects.toThrow('撤銷過了');
    void a;
    void b;
  });

  it('第二次套用會保留仍可行的區塊、只重排受影響的部分；撤銷只允許最近一次', async () => {
    await createTask({ title: 'A', priority: 'P1', estimatedMinutes: 45, plannedDate: today });
    await createTask({ title: 'B', priority: 'P2', estimatedMinutes: 45, plannedDate: today });
    const nowMs = ms('09:00');
    const first = await applyProposal(buildPlan(await plannerInput(nowMs)), { nowMs, tz: TPE });
    const before = await listBlocksForDate(today);
    expect(before).toHaveLength(2);

    // 09:55–10:40 的 B 撞到臨時行程，A 不受影響
    const p2 = buildPlan(await plannerInput(nowMs, { type: 'lost_time', startMs: ms('10:00'), endMs: ms('12:00') }));
    expect(p2.diff.kept).toHaveLength(1);
    expect(p2.diff.kept[0].title).toBe('A');
    expect(p2.diff.moved).toHaveLength(1);
    const second = await applyProposal(p2, { nowMs, tz: TPE });
    const after = await listBlocksForDate(today);
    expect(after.find((x) => x.id === before[0].id)).toBeTruthy(); // A 的區塊 id 不變
    expect(toLocalTime(after.find((x) => x.taskId !== before[0].taskId)!.startAt, TPE)).toBe('12:10');

    await expect(undoRevision(first.id)).rejects.toThrow('最近一次');
    await undoRevision(second.id);
    const restored = await listBlocksForDate(today);
    expect(restored.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
  });

  it('提早完成：套用會把任務標記完成並關閉其區塊；撤銷會回復', async () => {
    const t = await createTask({ title: '快做完的', priority: 'P1', estimatedMinutes: 60, plannedDate: today });
    await createTask({ title: '下一件', estimatedMinutes: 30, plannedDate: today });
    const nowMs = ms('09:00');
    await applyProposal(buildPlan(await plannerInput(nowMs)), { nowMs, tz: TPE });
    const p = buildPlan(await plannerInput(ms('09:20'), { type: 'task_done', taskId: t.id }));
    expect(p.blocks.every((x) => x.taskId !== t.id)).toBe(true);
    const rev = await applyProposal(p, { nowMs: ms('09:20'), tz: TPE });
    expect((await db.tasks.get(t.id))?.status).toBe('done');
    await undoRevision(rev.id);
    expect((await db.tasks.get(t.id))?.status).toBe('todo');
  });

  it('方案被竄改（指向已完成任務）時套用會被拒絕', async () => {
    const t = await createTask({ title: 'X', estimatedMinutes: 30, plannedDate: today });
    const nowMs = ms('09:00');
    const p = buildPlan(await plannerInput(nowMs));
    await setTaskDone(t.id, true);
    await expect(applyProposal(p, { nowMs, tz: TPE })).rejects.toThrow('未通過驗證');
    expect(await db.workBlocks.count()).toBe(0);
  });
});

describe('同一毫秒內連續套用', () => {
  it('第二次的 createdAt 一定比第一次晚，撤銷會撤到最後一次', async () => {
    const { applyProposal, latestRevisionForDate } = await import('@/db/plan');
    const { buildPlan } = await import('@/engine/planner');
    const { createTask, clearAllData } = await import('@/db/repo');
    const { localDateTimeToMs } = await import('@/lib/time');
    await clearAllData();
    const TPE = 'Asia/Taipei';
    const nowMs = localDateTimeToMs('2026-10-21', '09:00', TPE);
    await createTask({ title: 'a', plannedDate: '2026-10-21', estimatedMinutes: 30 });
    const settings = { workStart: '08:00', workEnd: '23:00', sleepStart: '00:00', sleepEnd: '07:30', bufferMinutes: 10, breakMinutes: 10, focusMinutes: 45, preferDeadlineFirst: true, energyMatching: true, allowSplitting: true } as const;
    const { db } = await import('@/db/db');
    const tasks = await db.tasks.toArray();
    const realNow = Date.now;
    Date.now = () => nowMs; // 凍結時鐘，模擬同一毫秒
    try {
      const p1 = buildPlan({ nowMs, tz: TPE, settings, tasks, busy: [], existingBlocks: [] });
      const r1 = await applyProposal(p1, { nowMs, tz: TPE });
      const p2 = buildPlan({ nowMs, tz: TPE, settings, tasks, busy: [], existingBlocks: await db.workBlocks.toArray(), incident: { type: 'rest', minutes: 10 } });
      const r2 = await applyProposal(p2, { nowMs, tz: TPE });
      expect(r2.createdAt > r1.createdAt).toBe(true);
      expect((await latestRevisionForDate('2026-10-21'))?.id).toBe(r2.id);
    } finally {
      Date.now = realNow;
    }
  });
});
