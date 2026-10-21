/**
 * 資料模型（單一事實來源）。
 * Zod schema 同時用於：DB 寫入驗證、JSON 匯入驗證、（第三階段）AI 輸出驗證。
 */
import { z } from 'zod';
import { DEFAULT_TZ, isValidHHmm, isValidIso, isValidLocalDate } from '@/lib/time';

export const IsoDateTime = z.string().refine(isValidIso, '必須是 ISO 時刻字串');
export const LocalDateSchema = z.string().refine(isValidLocalDate, '必須是 YYYY-MM-DD');
export const HHmmSchema = z.string().refine(isValidHHmm, '必須是 HH:mm');
export const Id = z.string().min(1);

export const PrioritySchema = z.enum(['P1', 'P2', 'P3']);
export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'deferred', 'cancelled']);
export const EnergySchema = z.enum(['high', 'medium', 'low']);
export const EventKindSchema = z.enum(['class', 'exam', 'appointment', 'other']);
export const LogCategorySchema = z.enum(['task', 'class', 'study', 'rest', 'meal', 'commute', 'exercise', 'other']);

export type Priority = z.infer<typeof PrioritySchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Energy = z.infer<typeof EnergySchema>;
export type EventKind = z.infer<typeof EventKindSchema>;
export type LogCategory = z.infer<typeof LogCategorySchema>;

export const TaskSchema = z.object({
  id: Id,
  title: z.string().trim().min(1, '任務名稱不能空白').max(200),
  description: z.string().max(4000).optional(),
  status: TaskStatusSchema,
  priority: PrioritySchema,
  dueAt: IsoDateTime.optional(),
  plannedDate: LocalDateSchema.optional(),
  estimatedMinutes: z.number().int().min(5).max(24 * 60),
  minimumMinutes: z.number().int().min(5).max(24 * 60).optional(),
  minimumOutcome: z.string().max(500).optional(),
  energyRequired: EnergySchema,
  splittable: z.boolean(),
  dependencies: z.array(Id),
  completedAt: IsoDateTime.optional(),
  actualMinutes: z.number().int().min(0).optional(),
  /** 規則 8（反飢餓）需要：被延後的次數與最近一次延後時間 */
  deferCount: z.number().int().min(0),
  lastDeferredAt: IsoDateTime.optional(),
  isDemo: z.boolean().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Task = z.infer<typeof TaskSchema>;

export const RecurrenceSchema = z.object({
  freq: z.literal('weekly'),
  /** 0 = 週日 … 6 = 週六 */
  byWeekday: z.array(z.number().int().min(0).max(6)).min(1),
  until: LocalDateSchema.optional(),
  /** 被單次刪除的日期 */
  exceptions: z.array(LocalDateSchema).default([]),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const CalendarEventSchema = z
  .object({
    id: Id,
    title: z.string().trim().min(1, '行程名稱不能空白').max(200),
    kind: EventKindSchema,
    location: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
    /** 第一次發生的時刻；重複行程以此的牆上時間為準 */
    startAt: IsoDateTime,
    endAt: IsoDateTime,
    allDay: z.boolean().optional(),
    recurrence: RecurrenceSchema.optional(),
    isDemo: z.boolean().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .refine((e) => new Date(e.endAt).getTime() > new Date(e.startAt).getTime(), {
    message: '結束時間必須晚於開始時間',
    path: ['endAt'],
  });
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const ActivityLogSchema = z
  .object({
    id: Id,
    /** 在 App 時區屬於哪一天（以開始時間為準） */
    date: LocalDateSchema,
    title: z.string().trim().min(1, '請填寫做了什麼').max(200),
    category: LogCategorySchema,
    startAt: IsoDateTime,
    /** 進行中的紀錄沒有 endAt */
    endAt: IsoDateTime.optional(),
    taskId: Id.optional(),
    eventId: Id.optional(),
    note: z.string().max(2000).optional(),
    isDemo: z.boolean().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .refine((l) => !l.endAt || new Date(l.endAt).getTime() > new Date(l.startAt).getTime(), {
    message: '結束時間必須晚於開始時間',
    path: ['endAt'],
  });
export type ActivityLog = z.infer<typeof ActivityLogSchema>;

export const DailyStateSchema = z.object({
  date: LocalDateSchema,
  energy: EnergySchema.optional(),
  wakeTime: HHmmSchema.optional(),
  note: z.string().max(1000).optional(),
  updatedAt: IsoDateTime,
});
export type DailyState = z.infer<typeof DailyStateSchema>;

/** 由任務拆出、已套用到某一天的工作區塊 */
export const WorkBlockSchema = z.object({
  id: Id,
  taskId: Id,
  date: LocalDateSchema,
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  status: z.enum(['planned', 'active', 'done', 'skipped']),
  /** 是最低成果版本 */
  isMinimum: z.boolean(),
  /** 由哪一次 PlanRevision 建立 */
  revisionId: Id.optional(),
  /** 為什麼排在這裡（規則引擎的理由，給人看） */
  reason: z.string().max(300).optional(),
  startedAt: IsoDateTime.optional(),
  pausedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkBlock = z.infer<typeof WorkBlockSchema>;

/** 一次重新規劃：觸發原因、摘要、套用前後快照（供撤銷） */
export const PlanRevisionSchema = z.object({
  id: Id,
  date: LocalDateSchema,
  createdAt: IsoDateTime,
  trigger: z.string(),
  applied: z.boolean(),
  appliedAt: IsoDateTime.optional(),
  revertedAt: IsoDateTime.optional(),
  summary: z.string(),
  payload: z.object({
    /** 套用前這一天的所有區塊 */
    blocksBefore: z.array(z.unknown()),
    /** 套用後這一天的所有區塊 */
    blocksAfter: z.array(z.unknown()),
    createdEventId: Id.optional(),
    completedTaskId: Id.optional(),
    previousTaskStatus: TaskStatusSchema.optional(),
    previousEnergy: EnergySchema.optional(),
    energySet: EnergySchema.optional(),
  }),
});
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

export const AiProviderSchema = z.enum(['none', 'claude', 'gemini', 'groq']);

export const SettingsSchema = z.object({
  id: z.literal('default'),
  timeZone: z.string().min(1),
  weekStartsOn: z.union([z.literal(0), z.literal(1)]),
  workStart: HHmmSchema,
  workEnd: HHmmSchema,
  sleepStart: HHmmSchema,
  sleepEnd: HHmmSchema,
  bufferMinutes: z.number().int().min(0).max(120),
  /** 兩個工作區塊之間的休息 */
  breakMinutes: z.number().int().min(0).max(60),
  focusMinutes: z.number().int().min(10).max(240),
  preferDeadlineFirst: z.boolean(),
  energyMatching: z.boolean(),
  allowSplitting: z.boolean(),
  ai: z.object({
    enabled: z.boolean(),
    provider: AiProviderSchema,
    model: z.string().optional(),
    maxOutputTokens: z.number().int().min(128).max(8192),
    dailyLimit: z.number().int().min(0).max(1000),
    /** Cloudflare Worker 網址，例如 https://flowplan-ai.xxx.workers.dev */
    proxyUrl: z.string().max(300).optional(),
    /** 通關密語（不是 API key）；只存在這台裝置，匯出備份時會略過 */
    proxySecret: z.string().max(300).optional(),
  }),
  sync: z
    .object({
      enabled: z.boolean(),
      /** 自動：有變更時延遲推送、回到前景時拉取 */
      auto: z.boolean(),
    })
    .default({ enabled: false, auto: true }),
  /** 規則引擎是否用歷史校正係數調整預估工時 */
  useCalibration: z.boolean().default(true),
  demoDataLoaded: z.boolean(),
  firstUsedAt: IsoDateTime.optional(),
  lastBackupAt: IsoDateTime.optional(),
  backupReminderDays: z.number().int().min(1).max(90),
  updatedAt: IsoDateTime,
});
export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(now = new Date().toISOString()): Settings {
  return {
    id: 'default',
    timeZone: DEFAULT_TZ,
    weekStartsOn: 1,
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
    ai: { enabled: false, provider: 'none', model: 'claude-haiku-5-5', maxOutputTokens: 1024, dailyLimit: 30 },
    sync: { enabled: false, auto: true },
    useCalibration: true,
    demoDataLoaded: false,
    firstUsedAt: now,
    backupReminderDays: 7,
    updatedAt: now,
  };
}

/** 每日 AI 用量（只在本機） */
export const AiUsageSchema = z.object({
  date: LocalDateSchema,
  calls: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  updatedAt: IsoDateTime,
});
export type AiUsageDay = z.infer<typeof AiUsageSchema>;

/** 待同步的變更（本機） */
export const SyncQueueSchema = z.object({
  /** `${table}:${id}` */
  key: z.string(),
  table: z.string(),
  id: z.string(),
  /** 有值代表刪除 */
  deletedAt: IsoDateTime.optional(),
  queuedAt: IsoDateTime,
});
export type SyncQueueItem = z.infer<typeof SyncQueueSchema>;

export const SyncMetaSchema = z.object({
  id: z.literal('meta'),
  version: z.number().int().min(0),
  lastPullAt: IsoDateTime.optional(),
  lastPushAt: IsoDateTime.optional(),
  lastError: z.string().optional(),
  deviceId: z.string(),
  /** 這台裝置的資料屬於哪個登入帳號（多人模式）；通關密語模式為空 */
  accountUid: z.string().optional(),
  accountEmail: z.string().optional(),
});
export type SyncMeta = z.infer<typeof SyncMetaSchema>;

export const BACKUP_SCHEMA_VERSION = 1;

export const BackupSchema = z.object({
  app: z.literal('flowplan'),
  schemaVersion: z.number().int(),
  exportedAt: IsoDateTime,
  timeZone: z.string().optional(),
  tasks: z.array(TaskSchema),
  events: z.array(CalendarEventSchema),
  logs: z.array(ActivityLogSchema).default([]),
  dailyStates: z.array(DailyStateSchema).default([]),
  workBlocks: z.array(WorkBlockSchema).default([]),
  planRevisions: z.array(PlanRevisionSchema).default([]),
  settings: SettingsSchema.optional(),
});
export type Backup = z.infer<typeof BackupSchema>;

export const PRIORITY_LABEL: Record<Priority, string> = { P1: '高', P2: '中', P3: '低' };
export const ENERGY_LABEL: Record<Energy, string> = { high: '高精力', medium: '中精力', low: '低精力' };
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待辦',
  in_progress: '進行中',
  done: '已完成',
  deferred: '已延後',
  cancelled: '已取消',
};
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  class: '課程',
  exam: '考試',
  appointment: '預約',
  other: '其他',
};
export const LOG_CATEGORY_LABEL: Record<LogCategory, string> = {
  task: '任務',
  class: '上課',
  study: '讀書',
  rest: '休息',
  meal: '用餐',
  commute: '通勤',
  exercise: '運動',
  other: '其他',
};
