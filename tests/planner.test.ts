import { describe, expect, it } from 'vitest';
import { buildPlan, tryPlace, type PlannerInput, type PlannerSettings } from '@/engine/planner';
import { validateBlocks } from '@/engine/validate';
import type { Task, WorkBlock } from '@/db/schema';
import { localDateTimeToIso, localDateTimeToMs, toLocalTime } from '@/lib/time';

const TPE = 'Asia/Taipei';
const D = '2026-10-21';
const ms = (t: string, d = D) => localDateTimeToMs(d, t, TPE);
const iso = (t: string, d = D) => localDateTimeToIso(d, t, TPE);
const hm = (x: number) => toLocalTime(x, TPE);

const settings: PlannerSettings = {
  workStart: '08:00',
  workEnd: '23:00',
  sleepStart: '00:00',
  sleepEnd: '07:30',
  bufferMinutes: 10,
  breakMinutes: 10,
  focusMinutes: 45,
  preferDeadlineFirst: true,
  energyMatching: true,
  allowSplitting: true,
};

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
    plannedDate: D,
    ...p,
  };
}

function block(p: Partial<WorkBlock> & Pick<WorkBlock, 'id' | 'taskId' | 'startAt' | 'endAt'>): WorkBlock {
  return { date: D, status: 'planned', isMinimum: false, createdAt: iso('08:00'), updatedAt: iso('08:00'), ...p };
}

function input(p: Partial<PlannerInput>): PlannerInput {
  return { nowMs: ms('09:00'), tz: TPE, settings, tasks: [], busy: [], existingBlocks: [], ...p };
}

const classBlock = { startMs: ms('15:00'), endMs: ms('17:00'), title: '工程數學', kind: 'event' as const };

describe('tryPlace', () => {
  it('不可拆的任務需要單一連續空檔', () => {
    const windows = [{ start: ms('09:00'), end: ms('09:30') }, { start: ms('10:00'), end: ms('12:00') }];
    expect(tryPlace(windows, 60, { splittable: false, focusMinutes: 45, breakMinutes: 10 })?.map((s) => hm(s.start))).toEqual(['10:00']);
    expect(tryPlace(windows, 150, { splittable: false, focusMinutes: 45, breakMinutes: 10 })).toBeNull();
  });
  it('可拆的任務依專注長度切段並留休息', () => {
    const slots = tryPlace([{ start: ms('09:00'), end: ms('12:00') }], 90, { splittable: true, focusMinutes: 45, breakMinutes: 10 })!;
    expect(slots.map((s) => [hm(s.start), hm(s.end)])).toEqual([
      ['09:00', '09:45'],
      ['09:55', '10:40'],
    ]);
  });
  it('截止時間之前放不下就回傳 null', () => {
    expect(tryPlace([{ start: ms('09:00'), end: ms('12:00') }], 60, { splittable: true, focusMinutes: 45, breakMinutes: 10, notAfterMs: ms('09:30') })).toBeNull();
  });
});

describe('規則引擎', () => {
  it('驗收 5：15:00–17:00 有課，讀書不會排進該時段', () => {
    const p = buildPlan(input({ tasks: [task({ id: 'a', title: '讀書', estimatedMinutes: 8 * 60, priority: 'P1' })], busy: [classBlock] }));
    for (const b of p.blocks) {
      expect(b.endMs <= ms('14:50') || b.startMs >= ms('17:10')).toBe(true);
    }
    expect(p.blocks.length).toBeGreaterThan(0);
    expect(validateBlocks(p.blocks, { nowMs: ms('09:00'), tz: TPE, tasks: [task({ id: 'a', title: '讀書', estimatedMinutes: 480 })], availability: p.availability }).ok).toBe(true);
  });

  it('驗收 6：睡過頭兩小時只用剩餘時間，排不下的給縮短 / 延後 / 不可行三種清楚結果', () => {
    const tasks = [
      task({ id: 'full', title: '可縮短', estimatedMinutes: 120, minimumMinutes: 30, minimumOutcome: '做完前 5 題', priority: 'P1', dueAt: iso('12:00') }),
      task({ id: 'gym', title: '健身房', estimatedMinutes: 60, splittable: false, priority: 'P3' }),
      task({ id: 'exam', title: '交作業', estimatedMinutes: 90, priority: 'P1', dueAt: iso('11:30') }),
    ];
    const p = buildPlan(input({ nowMs: ms('10:30'), tasks, busy: [{ startMs: ms('12:00'), endMs: ms('23:00'), title: '整天有事', kind: 'event' }], incident: { type: 'overslept', wakeTime: '10:30' } }));
    expect(p.stats.availableMinutes).toBe(80); // 10:30–11:50
    const full = p.blocks.filter((b) => b.taskId === 'full');
    expect(full.length).toBeGreaterThan(0);
    expect(full[0].isMinimum).toBe(true); // 縮短
    const gym = p.unscheduled.find((u) => u.taskId === 'gym');
    expect(gym?.suggestion).toBe('defer_tomorrow'); // 延後
    const exam = p.unscheduled.find((u) => u.taskId === 'exam');
    expect(exam?.reasonCode).toBe('DEADLINE_MISSED'); // 不可行
    expect(p.feasible).toBe(false);
    expect(p.effects.setWakeTime).toBe('10:30');
  });

  it('驗收 7：明天截止的 P1 優先納入，且不踩硬性行程', () => {
    const tasks = [
      task({ id: 'low', title: '低優先', priority: 'P3', estimatedMinutes: 60 }),
      task({ id: 'p1', title: '明天截止', priority: 'P1', estimatedMinutes: 90, dueAt: iso('10:00', '2026-10-22') }),
    ];
    const p = buildPlan(input({ tasks, busy: [classBlock] }));
    expect(p.nextAction?.block.taskId).toBe('p1');
    expect(p.blocks[0].taskId).toBe('p1');
    for (const b of p.blocks) expect(b.endMs <= ms('14:50') || b.startMs >= ms('17:10')).toBe(true);
  });

  it('驗收 8：已完成的任務不會被安排；提早完成的狀況也一樣', () => {
    const tasks = [task({ id: 'done', title: '做完了', status: 'done', priority: 'P1' }), task({ id: 'b', title: '還沒' })];
    const p = buildPlan(input({ tasks }));
    expect(p.blocks.every((b) => b.taskId !== 'done')).toBe(true);
    const p2 = buildPlan(input({ tasks: [task({ id: 'b', title: '還沒' }), task({ id: 'c', title: '剛做完', priority: 'P1' })], incident: { type: 'task_done', taskId: 'c' } }));
    expect(p2.blocks.every((b) => b.taskId !== 'c')).toBe(true);
    expect(p2.effects.completeTaskId).toBe('c');
  });

  it('規則 5：完整版排不下時排最低版本並標記', () => {
    const tasks = [task({ id: 'a', title: '大任務', estimatedMinutes: 180, minimumMinutes: 40, minimumOutcome: '第一節' })];
    const p = buildPlan(input({ nowMs: ms('21:00'), tasks }));
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0].isMinimum).toBe(true);
    expect(p.blocks[0].minutes).toBe(40);
    expect(p.blocks[0].reasonCodes).toContain('REDUCED');
    expect(p.explanation.join('\n')).toContain('最低版本');
  });

  it('規則 7：進行中的任務永遠排第一，既有可行區塊原位保留', () => {
    const tasks = [task({ id: 'wip', title: '進行中', status: 'in_progress', priority: 'P3' }), task({ id: 'p1', title: 'P1', priority: 'P1' })];
    const existing = [block({ id: 'b1', taskId: 'p1', startAt: iso('14:00'), endAt: iso('14:45') })];
    const p = buildPlan(input({ tasks, existingBlocks: existing, activeTaskId: 'wip' }));
    expect(p.nextAction?.block.taskId).toBe('wip');
    const kept = p.blocks.find((b) => b.existingId === 'b1');
    expect(kept?.kept).toBe(true);
    expect(hm(kept!.startMs)).toBe('14:00');
    expect(p.diff.kept).toHaveLength(1);
  });

  it('規則 7：既有區塊撞到新加入的臨時行程才會被移動', () => {
    const tasks = [task({ id: 'a', title: 'A' }), task({ id: 'b', title: 'B' })];
    const existing = [
      block({ id: 'ba', taskId: 'a', startAt: iso('10:00'), endAt: iso('11:00') }),
      block({ id: 'bb', taskId: 'b', startAt: iso('14:00'), endAt: iso('15:00') }),
    ];
    const p = buildPlan(input({ tasks, existingBlocks: existing, incident: { type: 'lost_time', startMs: ms('13:30'), endMs: ms('15:30'), title: '臨時有事' } }));
    expect(p.diff.kept.map((k) => k.existingId)).toEqual(['ba']);
    expect(p.diff.removed.map((r) => r.id)).toEqual(['bb']);
    expect(p.diff.moved).toHaveLength(1);
    expect(p.diff.moved[0].block.taskId).toBe('b');
    expect(p.effects.createEvent?.title).toBe('臨時有事');
  });

  it('規則 8：被延後 2 次以上的任務在同 tier 內提前並列入警示', () => {
    const tasks = [task({ id: 'x', title: '一般', createdAt: '2026-10-01T00:00:00.000Z' }), task({ id: 's', title: '餓很久', deferCount: 3, createdAt: '2026-10-02T00:00:00.000Z' })];
    const p = buildPlan(input({ tasks }));
    expect(p.blocks[0].taskId).toBe('s');
    expect(p.warnings.join('\n')).toContain('反覆延後');
    expect(tasks[1].priority).toBe('P2'); // 不偷改優先級
  });

  it('規則 4：低精力時高負荷任務給警示，不跳過有截止的責任', () => {
    const tasks = [task({ id: 'hard', title: '證明', energyRequired: 'high', priority: 'P1', dueAt: iso('18:00') })];
    const p = buildPlan(input({ tasks, incident: { type: 'energy', energy: 'low' } }));
    expect(p.nextAction?.block.taskId).toBe('hard');
    expect(p.nextAction?.warning).toBeTruthy();
    expect(p.effects.setEnergy).toBe('low');
  });

  it('規則 9：時間不足時，先保今天截止的任務，其餘明確列為未安排', () => {
    const tasks = [
      task({ id: 'due', title: '今天截止', priority: 'P2', estimatedMinutes: 60, dueAt: iso('22:00') }),
      task({ id: 'big', title: '大工程', priority: 'P1', estimatedMinutes: 300, splittable: false }),
    ];
    const p = buildPlan(input({ nowMs: ms('20:00'), tasks }));
    expect(Array.from(new Set(p.blocks.map((b) => b.taskId)))).toEqual(['due']);
    expect(p.unscheduled[0].taskId).toBe('big');
    expect(p.unscheduled[0].reasonCode).toBe('NOT_SPLITTABLE');
    expect(p.warnings.join('\n')).toContain('時間不夠');
  });

  it('前置未完成的任務不排；超時回報會用剩餘時間重排', () => {
    const tasks = [task({ id: 'a', title: '前置', estimatedMinutes: 30 }), task({ id: 'b', title: '後續', dependencies: ['a'] })];
    const p = buildPlan(input({ tasks }));
    expect(p.blocks.every((b) => b.taskId === 'a')).toBe(true);
    expect(p.explanation.join('\n')).toContain('前置');
    const p2 = buildPlan(input({ tasks: [task({ id: 'a', title: '前置', estimatedMinutes: 30, status: 'in_progress' })], incident: { type: 'overrun', taskId: 'a', remainingMinutes: 75 }, activeTaskId: 'a' }));
    expect(p2.blocks.reduce((s, b) => s + b.minutes, 0)).toBe(75);
  });

  it('規則 13：跨午夜可工作時段 + 睡眠保護，區塊不會踩到 00:00 之後', () => {
    const p = buildPlan(input({ nowMs: ms('22:00'), settings: { ...settings, workEnd: '01:00' }, tasks: [task({ id: 'a', title: '夜讀', estimatedMinutes: 240 })] }));
    for (const b of p.blocks) expect(b.endMs <= ms('00:00', '2026-10-22')).toBe(true);
  });

  it('確定性：同樣輸入兩次得到同樣輸出', () => {
    const tasks = [task({ id: 'a', title: 'A' }), task({ id: 'b', title: 'B', priority: 'P1' }), task({ id: 'c', title: 'C', priority: 'P3', deferCount: 2 })];
    const a = buildPlan(input({ tasks, busy: [classBlock] }));
    const b = buildPlan(input({ tasks, busy: [classBlock] }));
    expect(JSON.stringify(a.blocks)).toBe(JSON.stringify(b.blocks));
    expect(a.explanation).toEqual(b.explanation);
  });

  it('沒有候選任務時回傳空方案而不是捏造', () => {
    const p = buildPlan(input({ tasks: [task({ id: 'far', title: '下週', plannedDate: '2026-11-01' })] }));
    expect(p.blocks).toHaveLength(0);
    expect(p.nextAction).toBeNull();
    expect(p.feasible).toBe(true);
  });
});

describe('驗證器（驗收 9 的後端防線）', () => {
  const tasks = [task({ id: 'a', title: 'A', dependencies: [] }), task({ id: 'b', title: 'B', dependencies: ['a'] }), task({ id: 'd', title: '已完成', status: 'done' })];
  const p = buildPlan(input({ tasks, busy: [classBlock] }));
  const ctx = { nowMs: ms('09:00'), tz: TPE, tasks, availability: p.availability };

  it('引擎自己的輸出通過驗證', () => {
    expect(validateBlocks(p.blocks, ctx).ok).toBe(true);
  });
  it('虛構的任務 id 被拒絕', () => {
    const r = validateBlocks([{ taskId: 'ghost', startMs: ms('09:00'), endMs: ms('09:30'), isMinimum: false }], ctx);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('不存在');
  });
  it('踩到硬性行程、已完成任務、依賴順序錯誤都被拒絕', () => {
    const r = validateBlocks(
      [
        { taskId: 'a', startMs: ms('15:30'), endMs: ms('16:00'), isMinimum: false },
        { taskId: 'd', startMs: ms('09:00'), endMs: ms('09:30'), isMinimum: false },
        { taskId: 'b', startMs: ms('10:00'), endMs: ms('10:30'), isMinimum: false },
      ],
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('重疊');
    expect(r.errors.join('\n')).toContain('已完成');
    expect(r.errors.join('\n')).toContain('前置');
  });
  it('區塊彼此重疊、排在過去都被拒絕', () => {
    const r = validateBlocks(
      [
        { taskId: 'a', startMs: ms('10:00'), endMs: ms('11:00'), isMinimum: false },
        { taskId: 'a', startMs: ms('10:30'), endMs: ms('11:30'), isMinimum: false },
        { taskId: 'a', startMs: ms('08:00'), endMs: ms('08:30'), isMinimum: false },
      ],
      ctx,
    );
    expect(r.errors.join('\n')).toContain('互相重疊');
    expect(r.errors.join('\n')).toContain('過去');
  });
});
