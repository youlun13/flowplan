/**
 * JSON 匯出 / 匯入。匯入一律先用 Zod 驗證整份檔案，任何一筆不合法就整份拒絕，不做半套。
 */
import { db } from './db';
import { BACKUP_SCHEMA_VERSION, BackupSchema, type Backup } from './schema';
import { getSettings, updateSettings, ValidationError } from './repo';
import { nowIso } from '@/lib/time';

export async function buildBackup(): Promise<Backup> {
  const [tasks, events, logs, dailyStates, workBlocks, planRevisions, settings] = await Promise.all([
    db.tasks.toArray(),
    db.events.toArray(),
    db.logs.toArray(),
    db.dailyStates.toArray(),
    db.workBlocks.toArray(),
    db.planRevisions.toArray(),
    getSettings(),
  ]);
  return {
    app: 'flowplan',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: nowIso(),
    timeZone: settings.timeZone,
    tasks,
    events,
    logs,
    dailyStates,
    workBlocks,
    planRevisions,
    settings,
  };
}

export async function exportBackupJson(): Promise<string> {
  const backup = await buildBackup();
  await updateSettings({ lastBackupAt: backup.exportedAt });
  return JSON.stringify(backup, null, 2);
}

export type ImportMode = 'replace' | 'merge';

export interface ImportResult {
  tasks: number;
  events: number;
  logs: number;
  mode: ImportMode;
}

export function parseBackup(json: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ValidationError('不是有效的 JSON 檔');
  }
  const parsed = BackupSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `（${issue.path.join('.')}）` : '';
    throw new ValidationError(`備份檔格式不正確${where}：${issue?.message ?? ''}`);
  }
  if (parsed.data.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new ValidationError(`備份檔版本（${parsed.data.schemaVersion}）比目前 App 新，請先更新 App`);
  }
  return parsed.data;
}

export async function importBackup(backup: Backup, mode: ImportMode): Promise<ImportResult> {
  await db.transaction('rw', db.tables, async () => {
    if (mode === 'replace') {
      await Promise.all([
        db.tasks.clear(),
        db.events.clear(),
        db.logs.clear(),
        db.dailyStates.clear(),
        db.workBlocks.clear(),
        db.planRevisions.clear(),
      ]);
    }
    await db.tasks.bulkPut(backup.tasks);
    await db.events.bulkPut(backup.events);
    await db.logs.bulkPut(backup.logs);
    await db.dailyStates.bulkPut(backup.dailyStates);
    await db.workBlocks.bulkPut(backup.workBlocks);
    await db.planRevisions.bulkPut(backup.planRevisions);
    if (backup.settings && mode === 'replace') {
      await db.settings.put({ ...backup.settings, updatedAt: nowIso() });
    }
  });
  return { tasks: backup.tasks.length, events: backup.events.length, logs: backup.logs.length, mode };
}
