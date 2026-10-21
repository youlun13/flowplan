import Dexie, { type Table } from 'dexie';
import type { ActivityLog, AiUsageDay, CalendarEvent, DailyState, PlanRevision, Settings, SyncMeta, SyncQueueItem, Task, WorkBlock } from './schema';

export class FlowPlanDB extends Dexie {
  tasks!: Table<Task, string>;
  events!: Table<CalendarEvent, string>;
  logs!: Table<ActivityLog, string>;
  dailyStates!: Table<DailyState, string>;
  workBlocks!: Table<WorkBlock, string>;
  planRevisions!: Table<PlanRevision, string>;
  settings!: Table<Settings, string>;
  aiUsage!: Table<AiUsageDay, string>;
  syncQueue!: Table<SyncQueueItem, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor(name = 'flowplan') {
    super(name);
    this.version(1).stores({
      tasks: 'id, status, priority, plannedDate, dueAt, updatedAt',
      events: 'id, startAt, endAt, updatedAt',
      logs: 'id, date, startAt, taskId, eventId',
      dailyStates: 'date',
      workBlocks: 'id, taskId, date, status',
      planRevisions: 'id, createdAt',
      settings: 'id',
    });
    this.version(2).stores({
      planRevisions: 'id, date, createdAt',
    });
    this.version(3).stores({
      aiUsage: 'date',
    });
    this.version(4).stores({
      syncQueue: 'key, table, queuedAt',
      syncMeta: 'id',
    });
  }
}

export const db = new FlowPlanDB();
