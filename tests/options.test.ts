import { describe, expect, it } from 'vitest';
import { buildPlan, type PlannerInput, type PlannerSettings } from '@/engine/planner';
import { buildOptions, consequenceOf, downsidesOf, lightestTask, type BuildArgs } from '@/engine/options';
import type { Task, WorkBlock } from '@/db/schema';
import { localDateTimeToIso, localDateTimeToMs, toLocalTime } from '@/lib/time';

const TPE = 'Asia/Taipei';
const D = '2026-10-21';
const ms = (t: string) => localDateTimeToMs(D, t, TPE);
const iso = (t: string) => localDateTimeToIso(D, t, TPE);
const hm = (x: number) => toLocalTime(x, TPE);

const settings: PlannerSettings = { workStart: '08:00', workEnd: '23:00', sleepStart: '00:00', sleepEnd: '07:30', bufferMinutes: 10, breakMinutes: 10, focusMinutes: 45, preferDeadlineFirst: true, energyMatching: true, allowSplitting: true };

function task(p: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return { status: 'todo', priority: 'P2', estimatedMinutes: 60, energyRequired: 'medium', splittable: true, dependencies: [], deferCount: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', plannedDate: D, ...p };
}
function block(p: Partial<WorkBlock> & Pick<WorkBlock, 'id' | 'taskId' | 'startAt' | 'endAt'>): WorkBlock {
  return { date: D, status: 'planned', isMinimum: false, createdAt: iso('08:00'), updatedAt: iso('08:00'), ...p };
}
function input(p: Partial<PlannerInput>): PlannerInput {
  return { nowMs: ms('09:00'), tz: TPE, settings, tasks: [], busy: [], existingBlocks: [], ...p };
}

const tasks = [
  task({ id: 'urgent', title: '今天截止的報告', priority: 'P1', dueAt: iso('17:00'), estimatedMinutes: 90 }),
  task({ id: 'read', title: '讀英文', priority: 'P2', estimatedMinutes: 45 }),
  task({ id: 'misc', title: '整理筆記', priority: 'P3', estimatedMinutes: 30 }),
];

describe('pinFirstTaskId（方案 B 的底層）', () => {
  it('指定的任務排最前面、理由寫明是你選的；其他任務的既有區塊重排', () => {
    const existing = [block({ id: 'b1', taskId: 'urgent', startAt: iso('09:00'), endAt: iso('10:30') })];
    const a = buildPlan(input({ tasks, existingBlocks: existing }));
    expect(a.nextAction?.block.taskId).toBe('urgent');
    expect(a.ranked).toEqual(['urgent', 'read', 'misc']);

    const b = buildPlan(input({ tasks, existingBlocks: existing, pinFirstTaskId: 'read' }));
    expect(b.nextAction?.block.taskId).toBe('read');
    expect(hm(b.nextAction!.block.startMs)).toBe('09:00');
    expect(b.nextAction?.reason).toContain('你選擇先做這個');
    expect(b.pinnedTaskId).toBe('read');
    // 原本 09:00 的報告區塊被移開，但仍在截止前完成
    const report = b.blocks.filter((x) => x.taskId === 'urgent');
    expect(report.length).toBeGreaterThan(0);
    expect(report.every((x) => x.endMs <= ms('17:00'))).toBe(true);
    expect(b.diff.moved.some((m) => m.block.taskId === 'urgent')).toBe(true);
    expect(b.explanation.join('\n')).toContain('你選擇先做「讀英文」');
  });

  it('進行中的任務仍排在指定任務之前；指定不存在的 id 等於沒指定', () => {
    const t = [task({ id: 'active', title: '進行中', status: 'in_progress', actualMinutes: 10 }), ...tasks];
    const p = buildPlan(input({ tasks: t, pinFirstTaskId: 'read' }));
    expect(p.nextAction?.block.taskId).toBe('active');
    expect(p.ranked.slice(0, 2)).toEqual(['active', 'read']);
    const q = buildPlan(input({ tasks, pinFirstTaskId: 'nope' }));
    expect(q.pinnedTaskId).toBeUndefined();
    expect(q.nextAction?.block.taskId).toBe('urgent');
  });
});

describe('buildOptions（現在要做什麼：拚了 / 先喘口氣）', () => {
  const ctx = { tz: TPE, tasks, nowMs: ms('09:00') };
  const build = (extra: Partial<PlannerInput> = {}) => (args?: BuildArgs) => buildPlan(input({ tasks, ...extra, ...(args ?? {}) }));

  it('A 直接做最重要的；B 先休息 15 分鐘，回來先做最輕鬆的，其餘重排', () => {
    const t = [
      task({ id: 'urgent', title: '今天截止的報告', priority: 'P1', dueAt: iso('17:00'), estimatedMinutes: 90, energyRequired: 'high' }),
      task({ id: 'read', title: '讀英文', priority: 'P2', estimatedMinutes: 45, energyRequired: 'medium' }),
      task({ id: 'misc', title: '整理筆記', priority: 'P3', estimatedMinutes: 30, energyRequired: 'low' }),
    ];
    const opts = buildOptions((args) => buildPlan(input({ tasks: t, ...(args ?? {}) })), { ...ctx, tasks: t });
    expect(opts.map((o) => [o.key, o.label])).toEqual([
      ['A', '拚了'],
      ['B', '先喘口氣'],
    ]);
    expect(opts[0].lead).toMatchObject({ kind: 'task', title: '今天截止的報告' });
    expect(hm(opts[0].lead.startMs)).toBe('09:00');
    const b = opts[1];
    expect(b.lead).toMatchObject({ kind: 'rest', title: '先休息 15 分鐘' });
    expect([hm(b.lead.startMs), hm(b.lead.endMs)]).toEqual(['09:00', '09:15']);
    expect(b.then?.title).toBe('整理筆記'); // 精力需求最低的
    expect(b.then!.startMs).toBeGreaterThanOrEqual(b.lead.endMs);
    expect(b.proposal.busy.some((x) => x.kind === 'rest')).toBe(true);
    // 休息完、輕鬆的做完，截止的報告仍在截止前排進去
    const report = b.proposal.blocks.filter((x) => x.taskId === 'urgent');
    expect(report.length).toBeGreaterThan(0);
    expect(report.every((x) => x.endMs <= ms('17:00'))).toBe(true);
  });

  it('使用者已經選「需要休息」時，B 不再多加休息，改成「先做輕鬆的」', () => {
    const opts = buildOptions(build({ incident: { type: 'rest', minutes: 20 } }), { ...ctx, alreadyResting: true });
    expect(opts[1]?.label).toBe('先做輕鬆的');
    expect(opts[1]?.lead.kind).toBe('task');
  });

  it('沒有任務時只有 A 且沒有下一步', () => {
    const none = buildOptions((args) => buildPlan(input({ tasks: [], ...(args ?? {}) })), { ...ctx, tasks: [] });
    expect(none).toHaveLength(1);
    expect(none[0].proposal.nextAction).toBeNull();
  });

  it('時間不夠時影響句會說有幾件排不下 / 趕不上截止', () => {
    const late = buildOptions((args) => buildPlan(input({ nowMs: ms('21:00'), tasks, ...(args ?? {}) })), { ...ctx, nowMs: ms('21:00') });
    expect(consequenceOf(late[0].proposal)).toMatch(/趕不上截止|排不下/);
  });

  it('lightestTask：精力最低優先，再比時間短', () => {
    const t = [task({ id: 'a', title: 'a', energyRequired: 'high', estimatedMinutes: 10 }), task({ id: 'b', title: 'b', energyRequired: 'low', estimatedMinutes: 60 }), task({ id: 'c', title: 'c', energyRequired: 'low', estimatedMinutes: 20 })];
    expect(lightestTask(['a', 'b', 'c'], t)?.id).toBe('c');
    expect(lightestTask(['a'], t)?.id).toBe('a');
    expect(lightestTask([], t)).toBeUndefined();
  });
});

describe('downsidesOf（細節裡的缺點）', () => {
  it('沒事就空；時間不夠時列出做不完、趕不上截止、只做最低版本、改時間', () => {
    const fine = buildPlan(input({ tasks }));
    expect(downsidesOf(fine, TPE)).toEqual([]);
    const t = [
      task({ id: 'due', title: '今晚截止', dueAt: iso('21:30'), estimatedMinutes: 120, priority: 'P1' }),
      task({ id: 'big', title: '大任務', estimatedMinutes: 180, minimumMinutes: 30, priority: 'P2' }),
      task({ id: 'small', title: '小事', estimatedMinutes: 60, priority: 'P3', splittable: false }),
    ];
    const existing = [block({ id: 'b1', taskId: 'small', startAt: iso('21:00'), endAt: iso('22:00') })];
    const late = buildPlan(input({ nowMs: ms('20:30'), tasks: t, existingBlocks: existing, pinFirstTaskId: 'due' }));
    const texts = downsidesOf(late, TPE).map((d) => d.text).join('\n');
    expect(texts).toMatch(/趕不上截止|做不完|最低版本|改到/);
    expect(downsidesOf(late, TPE).some((d) => d.severe)).toBe(late.unscheduled.some((u) => u.reasonCode === 'DEADLINE_MISSED'));
  });
});
