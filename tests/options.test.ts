import { describe, expect, it } from 'vitest';
import { buildPlan, type PlannerInput, type PlannerSettings } from '@/engine/planner';
import { buildOptions, consequenceOf, downsidesOf } from '@/engine/options';
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

describe('buildOptions（現在要做什麼：兩個選擇）', () => {
  const build = (extra: Partial<PlannerInput> = {}) => (pin?: string) => buildPlan(input({ tasks, ...extra, pinFirstTaskId: pin }));

  it('A 是建議，B 改先做排序第二的任務；各附影響與之後的安排', () => {
    const opts = buildOptions(build(), TPE);
    expect(opts.map((o) => o.key)).toEqual(['A', 'B']);
    expect(opts[0].proposal.nextAction?.block.taskId).toBe('urgent');
    expect(opts[1].proposal.nextAction?.block.taskId).toBe('read');
    expect(opts[0].after).toContain('讀英文');
    expect(opts[1].after).toContain('今天截止的報告');
    expect(opts[0].consequence).toBe('其他事都排得下');
  });

  it('只有一個候選任務時只給 A；沒有任務時 A 也沒有下一步', () => {
    const one = buildOptions((pin) => buildPlan(input({ tasks: [tasks[0]], pinFirstTaskId: pin })), TPE);
    expect(one).toHaveLength(1);
    const none = buildOptions((pin) => buildPlan(input({ tasks: [], pinFirstTaskId: pin })), TPE);
    expect(none).toHaveLength(1);
    expect(none[0].proposal.nextAction).toBeNull();
  });

  it('時間不夠時影響句會說有幾件排不下 / 趕不上截止', () => {
    const late = buildOptions((pin) => buildPlan(input({ nowMs: ms('21:00'), tasks, pinFirstTaskId: pin })), TPE);
    const a = late[0];
    expect(consequenceOf(a.proposal)).toMatch(/趕不上截止|排不下/);
    if (late[1]) expect(late[1].consequence).toMatch(/趕不上截止|排不下|最低版本|改時間|排得下/);
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
