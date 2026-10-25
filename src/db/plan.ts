/**
 * 套用 / 撤銷排程方案（規則 10：人確認後才寫入；可撤銷）。
 *
 * applyProposal：在一個交易裡
 *   1. 再驗證一次方案（規則 1 的最後一道鎖）
 *   2. 以方案取代這一天的 planned/active 區塊（保留的區塊沿用原 id）
 *   3. 執行附帶效果：建立臨時行程、標記任務完成、更新精力 / 起床時間
 *   4. 寫入 PlanRevision，含套用前後快照
 * undoRevision：把快照還原，並回復附帶效果
 */
import { db } from './db';
import { createEvent, deleteEvent, setDailyState, setTaskDone, updateTask, ValidationError } from './repo';
import { WorkBlockSchema, type PlanRevision, type WorkBlock } from './schema';
import type { PlanProposal } from '@/engine/planner';
import { validateBlocks } from '@/engine/validate';
import { newId } from '@/lib/id';
import { nowIso, type LocalDate } from '@/lib/time';

export async function listBlocksForDate(date: LocalDate): Promise<WorkBlock[]> {
  return db.workBlocks.where('date').equals(date).sortBy('startAt');
}

export async function latestRevisionForDate(date: LocalDate): Promise<PlanRevision | undefined> {
  const list = await db.planRevisions.where('date').equals(date).sortBy('createdAt');
  return list.reverse().find((r) => r.applied && !r.revertedAt);
}

export async function applyProposal(proposal: PlanProposal, opts: { nowMs: number; tz: string }): Promise<PlanRevision> {
  const tasks = await db.tasks.toArray();
  const check = validateBlocks(proposal.blocks, {
    nowMs: opts.nowMs,
    tz: opts.tz,
    tasks,
    availability: proposal.availability,
    // 方案產生到按下套用之間可能過了幾分鐘，給 15 分鐘寬限
    pastToleranceMs: 15 * 60_000,
  });
  if (!check.ok) throw new ValidationError(`方案未通過驗證：${check.errors[0]}`);

  const now = nowIso();
  const revisionId = newId();

  return db.transaction('rw', [db.workBlocks, db.planRevisions, db.tasks, db.events, db.dailyStates, db.logs, db.settings], async () => {
    const blocksBefore = await listBlocksForDate(proposal.date);
    const keepIds = new Set(proposal.blocks.filter((b) => b.kept && b.existingId).map((b) => b.existingId!));

    // 取代 planned/active 區塊；done/skipped 的歷史保留
    for (const b of blocksBefore) {
      if ((b.status === 'planned' || b.status === 'active') && !keepIds.has(b.id)) await db.workBlocks.delete(b.id);
    }
    for (const pb of proposal.blocks) {
      if (pb.kept && pb.existingId) continue;
      const wb = WorkBlockSchema.parse({
        id: newId(),
        taskId: pb.taskId,
        date: proposal.date,
        startAt: new Date(pb.startMs).toISOString(),
        endAt: new Date(pb.endMs).toISOString(),
        status: 'planned',
        isMinimum: pb.isMinimum,
        revisionId,
        reason: pb.reason,
        createdAt: now,
        updatedAt: now,
      });
      await db.workBlocks.add(wb);
    }

    // 附帶效果
    const payload: PlanRevision['payload'] = { blocksBefore, blocksAfter: [] };
    if (proposal.effects.createEvent) {
      const ev = await createEvent({
        title: proposal.effects.createEvent.title,
        kind: 'other',
        startAt: new Date(proposal.effects.createEvent.startMs).toISOString(),
        endAt: new Date(proposal.effects.createEvent.endMs).toISOString(),
      });
      payload.createdEventId = ev.id;
    }
    if (proposal.effects.completeTaskId) {
      const t = await db.tasks.get(proposal.effects.completeTaskId);
      if (t) {
        payload.completedTaskId = t.id;
        payload.previousTaskStatus = t.status;
        await setTaskDone(t.id, true);
      }
    }
    const daily = await db.dailyStates.get(proposal.date);
    if (proposal.effects.setEnergy) {
      payload.previousEnergy = daily?.energy;
      payload.energySet = proposal.effects.setEnergy;
      await setDailyState(proposal.date, { energy: proposal.effects.setEnergy });
    }
    if (proposal.effects.setWakeTime) await setDailyState(proposal.date, { wakeTime: proposal.effects.setWakeTime });

    payload.blocksAfter = await listBlocksForDate(proposal.date);
    // 「最近一次」靠 createdAt 排序；同一毫秒內連續套用時往後推 1ms，確保撤銷永遠撤到最後那一次
    const prev = await db.planRevisions.where('date').equals(proposal.date).sortBy('createdAt');
    const lastAt = prev.length ? prev[prev.length - 1].createdAt : undefined;
    const createdAt = lastAt && lastAt >= now ? new Date(new Date(lastAt).getTime() + 1).toISOString() : now;
    const revision: PlanRevision = {
      id: revisionId,
      date: proposal.date,
      createdAt,
      trigger: proposal.trigger,
      applied: true,
      appliedAt: now,
      summary: summarize(proposal),
      payload,
    };
    await db.planRevisions.add(revision);
    return revision;
  });
}

export async function undoRevision(revisionId: string): Promise<void> {
  const rev = await db.planRevisions.get(revisionId);
  if (!rev) throw new ValidationError('找不到這次套用的紀錄');
  if (rev.revertedAt) throw new ValidationError('這次套用已經撤銷過了');
  const latest = await latestRevisionForDate(rev.date);
  if (latest && latest.id !== rev.id) throw new ValidationError('只能撤銷最近一次套用');

  await db.transaction('rw', [db.workBlocks, db.planRevisions, db.tasks, db.events, db.dailyStates, db.logs, db.settings], async () => {
    const current = await listBlocksForDate(rev.date);
    for (const b of current) await db.workBlocks.delete(b.id);
    for (const raw of rev.payload.blocksBefore) {
      const parsed = WorkBlockSchema.safeParse(raw);
      if (parsed.success) await db.workBlocks.put(parsed.data);
    }
    if (rev.payload.createdEventId) await deleteEvent(rev.payload.createdEventId);
    if (rev.payload.completedTaskId) {
      const t = await db.tasks.get(rev.payload.completedTaskId);
      if (t && t.status === 'done') {
        await updateTask(t.id, { status: rev.payload.previousTaskStatus ?? 'todo', completedAt: undefined });
      }
    }
    if (rev.payload.energySet) {
      await setDailyState(rev.date, { energy: rev.payload.previousEnergy });
    }
    await db.planRevisions.put({ ...rev, revertedAt: nowIso() });
  });
}

/** 任務完成時，把它今天還沒做的區塊標成 done */
export async function closeBlocksForTask(taskId: string, date: LocalDate): Promise<void> {
  const blocks = await db.workBlocks.where('taskId').equals(taskId).toArray();
  for (const b of blocks) {
    if (b.date === date && (b.status === 'planned' || b.status === 'active')) {
      await db.workBlocks.put({ ...b, status: 'done', endedAt: nowIso(), updatedAt: nowIso() });
    }
  }
}

export async function setBlockStatus(id: string, status: WorkBlock['status']): Promise<void> {
  const b = await db.workBlocks.get(id);
  if (!b) return;
  const now = nowIso();
  await db.workBlocks.put({
    ...b,
    status,
    startedAt: status === 'active' ? (b.startedAt ?? now) : b.startedAt,
    endedAt: status === 'done' || status === 'skipped' ? now : b.endedAt,
    updatedAt: now,
  });
}

function summarize(p: PlanProposal): string {
  const parts: string[] = [];
  if (p.diff.kept.length) parts.push(`保留 ${p.diff.kept.length}`);
  if (p.diff.added.length) parts.push(`新增 ${p.diff.added.length}`);
  if (p.diff.moved.length) parts.push(`移動 ${p.diff.moved.length}`);
  if (p.diff.shortened.length) parts.push(`縮短 ${p.diff.shortened.length}`);
  if (p.diff.removed.length - p.diff.moved.length > 0) parts.push(`移除 ${p.diff.removed.length - p.diff.moved.length}`);
  if (p.unscheduled.length) parts.push(`未安排 ${p.unscheduled.length}`);
  return parts.length ? parts.join('、') : '無變更';
}
