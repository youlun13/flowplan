/**
 * 跨裝置同步（客戶端）。
 *
 * 流程：
 *   變更追蹤：Dexie hooks 把每次寫入 / 刪除記進 syncQueue（本機）
 *   push：把 syncQueue 對應的紀錄 + tombstones 送到 Worker，拿回合併後的完整快照並套用
 *   pull：帶 since=version 問 Worker，有新版本就套用
 *   套用：同 id 以 updatedAt 新者為準；tombstone 比本機新就刪；套用時關閉追蹤避免回音
 *
 * 單一使用者、最後寫入者勝；不做加密。
 */
import Dexie from 'dexie';
import { db } from '@/db/db';
import type { Settings, SyncMeta, SyncQueueItem } from '@/db/schema';
import { AiError } from '@/ai/types';
import { newId } from '@/lib/id';
import { nowIso } from '@/lib/time';

export const SYNC_TABLES = ['tasks', 'events', 'logs', 'dailyStates', 'workBlocks', 'planRevisions', 'settings'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

type Rec = Record<string, unknown> & { updatedAt?: string };

export interface Snapshot {
  version: number;
  updatedAt: string | null;
  records: Record<SyncTable, Record<string, Rec>>;
  tombstones: Record<string, string>;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'disabled' | 'offline';
  pending: number;
  version: number;
  lastPullAt?: string;
  lastPushAt?: string;
  lastError?: string;
}

export class SyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

/* ------------------------------ 變更追蹤 ------------------------------ */

let tracking = true;
let hooksInstalled = false;
let onQueued: (() => void) | null = null;

function idOf(table: SyncTable, rec: Rec): string | undefined {
  const v = table === 'dailyStates' ? rec.date : rec.id;
  return typeof v === 'string' ? v : undefined;
}

export function installSyncHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const table of SYNC_TABLES) {
    const t = db.table(table);
    t.hook('creating', function (primKey, obj) {
      if (!tracking) return;
      const id = idOf(table, obj as Rec) ?? String(primKey);
      void enqueue(table, id);
    });
    t.hook('updating', function (_mods, primKey) {
      if (!tracking) return;
      void enqueue(table, String(primKey));
    });
    t.hook('deleting', function (primKey) {
      if (!tracking) return;
      void enqueue(table, String(primKey), nowIso());
    });
  }
}

async function enqueue(table: SyncTable, id: string, deletedAt?: string): Promise<void> {
  const key = `${table}:${id}`;
  try {
    const item: SyncQueueItem = deletedAt ? { key, table, id, deletedAt, queuedAt: nowIso() } : { key, table, id, queuedAt: nowIso() };
    // hooks 在呼叫端的交易裡執行，而該交易通常不含 syncQueue / syncMeta：
    // 連同後續的狀態刷新都放到 ignoreTransaction 裡，用獨立交易跑
    await Dexie.ignoreTransaction(async () => {
      await db.syncQueue.put(item);
      onQueued?.();
    });
  } catch {
    /* 佇列寫入失敗不影響主流程 */
  }
}

/** 在 fn 期間停止追蹤（給「清除全部資料」等不應傳到雲端的操作用） */
export async function withoutSyncTracking<T>(fn: () => Promise<T>): Promise<T> {
  return withoutTracking(fn);
}

/** 在 fn 期間停止追蹤（套用遠端變更時用） */
async function withoutTracking<T>(fn: () => Promise<T>): Promise<T> {
  tracking = false;
  try {
    return await fn();
  } finally {
    tracking = true;
  }
}

/* ------------------------------ meta ------------------------------ */

export async function getSyncMeta(): Promise<SyncMeta> {
  const m = await db.syncMeta.get('meta');
  if (m) return m;
  const fresh: SyncMeta = { id: 'meta', version: 0, deviceId: newId() };
  await db.syncMeta.put(fresh);
  return fresh;
}

async function setSyncMeta(patch: Partial<SyncMeta>): Promise<void> {
  const cur = await getSyncMeta();
  const next: Record<string, unknown> = { ...cur, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  await db.syncMeta.put(next as SyncMeta);
}

export async function pendingCount(): Promise<number> {
  return db.syncQueue.count();
}

/* ------------------------------ 傳輸 ------------------------------ */

export type PullResult = { unchanged: true; version: number } | { unchanged?: false; snapshot: Snapshot };

export interface SyncTransport {
  pull(since: number): Promise<PullResult>;
  push(payload: { baseVersion: number; records: Partial<Record<SyncTable, Record<string, Rec>>>; tombstones: Record<string, string> }): Promise<{ snapshot: Snapshot }>;
  remove(): Promise<void>;
  status(): Promise<{ configured: boolean; version?: number; updatedAt?: string | null; counts?: Record<string, number> }>;
}

export function makeTransport(settings: Settings, fetchImpl: typeof fetch = fetch): SyncTransport {
  const base = (settings.ai.proxyUrl ?? '').replace(/\/+$/, '');
  const secret = settings.ai.proxySecret ?? '';
  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!base || !secret) throw new AiError('not_configured');
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${secret}`, 'content-type': 'application/json' } });
    } catch {
      throw new AiError('network');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AiError('bad_response');
    }
    const env = body as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    if (!env || typeof env !== 'object' || env.ok !== true) {
      const code = env?.error?.code;
      if (code === 'sync_not_configured') throw new SyncError('sync_not_configured', 'Worker 還沒綁定 KV（FLOWPLAN_KV），請照 API_SETUP.md Part C 設定');
      if (code === 'unauthorized') throw new AiError('unauthorized');
      if (code === 'forbidden_origin') throw new AiError('forbidden_origin');
      throw new SyncError('sync_failed', env?.error?.message ?? '同步失敗');
    }
    return env.result;
  }
  return {
    pull: (since) => call(`/v1/sync?since=${since}`) as Promise<PullResult>,
    push: (payload) => call('/v1/sync', { method: 'POST', body: JSON.stringify(payload) }) as Promise<{ snapshot: Snapshot }>,
    remove: async () => {
      await call('/v1/sync', { method: 'DELETE' });
    },
    status: () => call('/v1/sync/status') as Promise<{ configured: boolean; version?: number; updatedAt?: string | null; counts?: Record<string, number> }>,
  };
}

/* ------------------------------ 套用快照 ------------------------------ */

function stampOf(rec: Rec | undefined): string {
  return typeof rec?.updatedAt === 'string' ? rec.updatedAt : '';
}

function mergeSettings(local: Settings | undefined, remote: Settings): Settings {
  if (!local) return remote;
  return { ...remote, ai: { ...remote.ai, proxySecret: local.ai.proxySecret ?? remote.ai.proxySecret, proxyUrl: local.ai.proxyUrl ?? remote.ai.proxyUrl } };
}

/** 把遠端快照合併進本機（新者勝、tombstone 刪除）；本機尚未推送的變更不被覆蓋 */
export async function applySnapshot(snapshot: Snapshot): Promise<{ upserted: number; deleted: number }> {
  let upserted = 0;
  let deleted = 0;
  await withoutTracking(async () => {
    await db.transaction('rw', [db.tasks, db.events, db.logs, db.dailyStates, db.workBlocks, db.planRevisions, db.settings, db.syncQueue], async () => {
      const pending = new Set((await db.syncQueue.toArray()).map((q) => q.key));
      for (const table of SYNC_TABLES) {
        const t = db.table(table);
        const remote = snapshot.records?.[table] ?? {};
        for (const [id, rec] of Object.entries(remote)) {
          if (pending.has(`${table}:${id}`)) continue;
          const local = (await t.get(id)) as Rec | undefined;
          if (local && stampOf(local) >= stampOf(rec)) continue;
          const toPut = table === 'settings' ? mergeSettings(local as Settings | undefined, rec as unknown as Settings) : rec;
          await t.put(toPut);
          upserted += 1;
        }
      }
      for (const [key, deletedAt] of Object.entries(snapshot.tombstones ?? {})) {
        if (pending.has(key)) continue;
        const [table, id] = key.split(':') as [SyncTable, string];
        if (!SYNC_TABLES.includes(table) || !id) continue;
        const t = db.table(table);
        const local = (await t.get(id)) as Rec | undefined;
        if (local && stampOf(local) <= deletedAt) {
          await t.delete(id);
          deleted += 1;
        }
      }
    });
  });
  return { upserted, deleted };
}

/* ------------------------------ push / pull ------------------------------ */

async function collectChanges(): Promise<{ records: Partial<Record<SyncTable, Record<string, Rec>>>; tombstones: Record<string, string>; keys: string[] }> {
  const queue = await db.syncQueue.toArray();
  const records: Partial<Record<SyncTable, Record<string, Rec>>> = {};
  const tombstones: Record<string, string> = {};
  for (const q of queue) {
    const table = q.table as SyncTable;
    if (!SYNC_TABLES.includes(table)) continue;
    if (q.deletedAt) {
      tombstones[q.key] = q.deletedAt;
      continue;
    }
    const rec = (await db.table(table).get(q.id)) as Rec | undefined;
    if (!rec) {
      tombstones[q.key] = q.queuedAt;
      continue;
    }
    const out: Rec = { ...rec };
    if (table === 'settings') {
      const s = out as unknown as Settings;
      out.ai = { ...s.ai, proxySecret: undefined };
    }
    (records[table] ??= {})[q.id] = out;
  }
  return { records, tombstones, keys: queue.map((q) => q.key) };
}

export async function syncNow(transport: SyncTransport): Promise<{ pushed: number; pulled: { upserted: number; deleted: number }; version: number }> {
  const meta = await getSyncMeta();
  const changes = await collectChanges();
  const pushed = changes.keys.length;
  let snapshot: Snapshot;
  if (pushed > 0) {
    const r = await transport.push({ baseVersion: meta.version, records: changes.records, tombstones: changes.tombstones });
    snapshot = r.snapshot;
    await db.syncQueue.bulkDelete(changes.keys);
    await setSyncMeta({ lastPushAt: nowIso(), lastError: undefined });
  } else {
    const r = await transport.pull(meta.version);
    if ('unchanged' in r && r.unchanged) {
      await setSyncMeta({ lastPullAt: nowIso(), lastError: undefined });
      return { pushed: 0, pulled: { upserted: 0, deleted: 0 }, version: r.version };
    }
    snapshot = (r as { snapshot: Snapshot }).snapshot;
  }
  const pulled = await applySnapshot(snapshot);
  await setSyncMeta({ version: snapshot.version, lastPullAt: nowIso(), lastError: undefined });
  return { pushed, pulled, version: snapshot.version };
}

/** 第一次啟用：把本機所有資料排進佇列，整包推上去 */
export async function enqueueEverything(): Promise<number> {
  let n = 0;
  for (const table of SYNC_TABLES) {
    const rows = (await db.table(table).toArray()) as Rec[];
    for (const rec of rows) {
      const id = idOf(table, rec);
      if (!id) continue;
      await db.syncQueue.put({ key: `${table}:${id}`, table, id, queuedAt: nowIso() });
      n += 1;
    }
  }
  return n;
}

/** 以雲端為準：清空本機（設定除外）後套用遠端快照 */
export async function replaceWithRemote(transport: SyncTransport): Promise<{ upserted: number; deleted: number; version: number }> {
  const r = await transport.pull(-1);
  if ('unchanged' in r && r.unchanged) return { upserted: 0, deleted: 0, version: r.version };
  const snapshot = (r as { snapshot: Snapshot }).snapshot;
  await withoutTracking(async () => {
    await db.transaction('rw', [db.tasks, db.events, db.logs, db.dailyStates, db.workBlocks, db.planRevisions, db.syncQueue], async () => {
      await Promise.all([db.tasks.clear(), db.events.clear(), db.logs.clear(), db.dailyStates.clear(), db.workBlocks.clear(), db.planRevisions.clear(), db.syncQueue.clear()]);
    });
  });
  const applied = await applySnapshot(snapshot);
  await setSyncMeta({ version: snapshot.version, lastPullAt: nowIso(), lastError: undefined });
  return { ...applied, version: snapshot.version };
}

/* ------------------------------ 自動排程 ------------------------------ */

type Listener = (s: SyncStatus) => void;
const listeners = new Set<Listener>();
let current: SyncStatus = { state: 'disabled', pending: 0, version: 0 };
let pushTimer: number | undefined;
let pullTimer: number | undefined;
let running = false;
let getTransport: (() => Promise<SyncTransport | null>) | null = null;

export function subscribeSync(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

export async function refreshSyncStatus(patch: Partial<SyncStatus> = {}): Promise<void> {
  const { meta, pending } = await Dexie.ignoreTransaction(async () => ({ meta: await getSyncMeta(), pending: await pendingCount() }));
  const next: SyncStatus = { ...current, pending, version: meta.version, lastPullAt: meta.lastPullAt, lastPushAt: meta.lastPushAt, lastError: meta.lastError, ...patch };
  current = next;
  for (const l of listeners) l(current);
}

export async function runSync(reason: string): Promise<void> {
  if (running || !getTransport) return;
  const transport = await getTransport();
  if (!transport) {
    await refreshSyncStatus({ state: 'disabled' });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await refreshSyncStatus({ state: 'offline' });
    return;
  }
  running = true;
  await refreshSyncStatus({ state: 'syncing' });
  try {
    await syncNow(transport);
    await refreshSyncStatus({ state: 'idle', lastError: undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '同步失敗';
    await setSyncMeta({ lastError: `${msg}（${reason}）` });
    await refreshSyncStatus({ state: 'error', lastError: `${msg}（${reason}）` });
  } finally {
    running = false;
  }
}

export function schedulePush(delayMs = 4000): void {
  if (!getTransport) return;
  if (pushTimer) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = undefined;
    void runSync('自動推送');
  }, delayMs);
  void refreshSyncStatus();
}

/**
 * 啟動自動同步：進佇列後 4 秒推送；回到前景 / 上線時拉取；頁面可見時每 90 秒拉取一次。
 */
export function startAutoSync(transportFactory: () => Promise<SyncTransport | null>): () => void {
  getTransport = transportFactory;
  installSyncHooks();
  onQueued = () => schedulePush();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void runSync('回到前景');
  };
  const onOnline = () => void runSync('重新上線');
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  pullTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void runSync('定時');
  }, 90_000);
  void runSync('啟動');
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    if (pullTimer) window.clearInterval(pullTimer);
    if (pushTimer) window.clearTimeout(pushTimer);
    getTransport = null;
    onQueued = null;
  };
}
