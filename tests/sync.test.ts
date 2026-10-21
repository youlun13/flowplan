import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
// @ts-expect-error 純 JS Worker
import worker, { mergeSnapshot, emptySnapshot } from '../worker/src/index.js';
import { db } from '@/db/db';
import { clearAllData, createTask, deleteTask, getSettings, updateSettings, updateTask } from '@/db/repo';
import { applySnapshot, enqueueEverything, installSyncHooks, makeTransport, pendingCount, syncNow, type Snapshot } from '@/sync/engine';

/* ---------------- 記憶體 KV + Worker 當假伺服器 ---------------- */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    size: () => store.size,
  };
}

function fetchVia(env: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    headers.set('Origin', 'https://youlun13.github.io');
    return worker.fetch(new Request(url, { ...init, headers }), env);
  }) as typeof fetch;
}

const baseEnv = { ANTHROPIC_API_KEY: 'sk-test', FLOWPLAN_PROXY_SECRET: 's', ALLOWED_ORIGINS: 'https://youlun13.github.io', AI_MODEL: 'claude-haiku-5-5', AI_MAX_OUTPUT_TOKENS: '1024' };

describe('Worker 合併規則', () => {
  it('新者勝、tombstone 刪除、舊的 upsert 被忽略', () => {
    const a = { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', title: 'old' };
    const { snapshot: s1 } = mergeSnapshot(emptySnapshot(), { records: { tasks: { a } }, tombstones: {} });
    const { snapshot: s2, stats } = mergeSnapshot(s1, { records: { tasks: { a: { ...a, updatedAt: '2026-01-02T00:00:00.000Z', title: 'new' } } }, tombstones: {} });
    expect(stats.applied).toBe(1);
    expect(s2.records.tasks.a.title).toBe('new');
    const { stats: st3 } = mergeSnapshot(s2, { records: { tasks: { a } }, tombstones: {} });
    expect(st3.ignored).toBe(1);
    const { snapshot: s4, stats: st4 } = mergeSnapshot(s2, { records: {}, tombstones: { 'tasks:a': '2026-01-03T00:00:00.000Z' } });
    expect(st4.deleted).toBe(1);
    expect(s4.records.tasks.a).toBeUndefined();
    // tombstone 之後，更舊的 upsert 不會復活
    const { stats: st5 } = mergeSnapshot(s4, { records: { tasks: { a } }, tombstones: {} });
    expect(st5.ignored).toBe(1);
  });

  it('沒綁 KV → sync_not_configured；health 回報 sync=false', async () => {
    const r = await worker.fetch(new Request('https://w/v1/sync', { headers: { Authorization: 'Bearer s' } }), baseEnv);
    expect(r.status).toBe(501);
    expect((await r.json()).error.code).toBe('sync_not_configured');
    const h = await (await worker.fetch(new Request('https://w/v1/health', { headers: { Authorization: 'Bearer s' } }), baseEnv)).json();
    expect(h.result.sync).toBe(false);
  });
});

describe('客戶端同步（兩台裝置透過同一個 Worker）', () => {
  beforeEach(async () => {
    await clearAllData();
    await db.syncQueue.clear();
    await db.syncMeta.clear();
    installSyncHooks();
  });

  it('push 後清佇列；版本遞增；pull 無變更時回 unchanged', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const transport = makeTransport(await updateSettings({ ai: { enabled: false, provider: 'none', proxyUrl: 'https://w', proxySecret: 's', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } }), fetchVia(env));
    await createTask({ title: '同步我', plannedDate: '2026-10-21' });
    expect(await pendingCount()).toBeGreaterThan(0);
    const r = await syncNow(transport);
    expect(r.pushed).toBeGreaterThan(0);
    expect(r.version).toBe(1);
    expect(await pendingCount()).toBe(0);
    const r2 = await syncNow(transport);
    expect(r2.pushed).toBe(0);
    expect(r2.version).toBe(1);
    const status = await transport.status();
    expect(status.configured).toBe(true);
    expect(status.counts?.tasks).toBe(1);
  });

  it('裝置 B 以雲端快照建立相同資料；A 刪除後 B 也被刪；B 的新編輯會回到 A', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const settings = await updateSettings({ ai: { enabled: false, provider: 'none', proxyUrl: 'https://w', proxySecret: 's', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    const transport = makeTransport(settings, fetchVia(env));

    // 裝置 A：兩個任務，推上去
    const t1 = await createTask({ title: 'A1', plannedDate: '2026-10-21' });
    const t2 = await createTask({ title: 'A2', plannedDate: '2026-10-21' });
    await syncNow(transport);

    // 模擬裝置 B：直接從 Worker 拉快照（B 是空的）
    const pulled = await transport.pull(0);
    const snapB = (pulled as { snapshot: Snapshot }).snapshot;
    expect(Object.keys(snapB.records.tasks).sort()).toEqual([t1.id, t2.id].sort());

    // 裝置 A 刪除 A2 並推送
    await deleteTask(t2.id);
    await syncNow(transport);
    const after = (await transport.pull(0)) as { snapshot: Snapshot };
    expect(after.snapshot.records.tasks[t2.id]).toBeUndefined();
    expect(after.snapshot.tombstones[`tasks:${t2.id}`]).toBeTruthy();

    // 裝置 B 編輯 A1（較新的 updatedAt）並推送；A 拉回後看到新標題
    const edited = { ...after.snapshot.records.tasks[t1.id], title: 'A1 by B', updatedAt: new Date(Date.now() + 60_000).toISOString() };
    await transport.push({ baseVersion: after.snapshot.version, records: { tasks: { [t1.id]: edited } }, tombstones: {} });
    const r = await syncNow(transport);
    expect(r.pulled.upserted).toBe(1);
    expect((await db.tasks.get(t1.id))?.title).toBe('A1 by B');
  });

  it('本機尚未推送的變更不會被遠端快照覆蓋；套用快照不會再進佇列（無回音）', async () => {
    const t = await createTask({ title: '本機較新', plannedDate: '2026-10-21' });
    await db.syncQueue.clear();
    await updateTask(t.id, { title: '本機改過' }); // 進佇列
    const remote: Snapshot = { version: 5, updatedAt: null, records: { tasks: { [t.id]: { ...(await db.tasks.get(t.id))!, title: '遠端', updatedAt: new Date(Date.now() + 999_999).toISOString() } }, events: {}, logs: {}, dailyStates: {}, workBlocks: {}, planRevisions: {}, settings: {} }, tombstones: {} };
    const before = await pendingCount();
    const r = await applySnapshot(remote);
    expect(r.upserted).toBe(0);
    expect((await db.tasks.get(t.id))?.title).toBe('本機改過');
    expect(await pendingCount()).toBe(before);
  });

  it('settings 同步時不帶通關密語，套用時保留本機密語', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const settings = await updateSettings({ workStart: '09:30', ai: { enabled: false, provider: 'none', proxyUrl: 'https://w', proxySecret: 'local-secret', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    const transport = makeTransport(settings, fetchVia({ ...env, FLOWPLAN_PROXY_SECRET: 'local-secret' }));
    await enqueueEverything();
    await syncNow(transport);
    const snap = ((await transport.pull(0)) as { snapshot: Snapshot }).snapshot;
    const remoteSettings = snap.records.settings.default as unknown as { ai: { proxySecret?: string }; workStart: string };
    expect(remoteSettings.ai.proxySecret).toBeUndefined();
    expect(remoteSettings.workStart).toBe('09:30');
    // 遠端 settings 比本機新 → 套用，但密語仍是本機的
    const newer = { ...snap.records.settings.default, workStart: '10:00', updatedAt: new Date(Date.now() + 60_000).toISOString() };
    await applySnapshot({ ...snap, version: 99, records: { ...snap.records, settings: { default: newer } } });
    const local = await getSettings();
    expect(local.workStart).toBe('10:00');
    expect(local.ai.proxySecret).toBe('local-secret');
  });

  it('全新資料庫可以安裝 hooks 並啟動（indexedDB 重建）', async () => {
    const fresh = new Dexie('flowplan-fresh', { indexedDB: new IDBFactory() });
    fresh.version(1).stores({ tasks: 'id' });
    await fresh.open();
    expect(fresh.isOpen()).toBe(true);
    fresh.close();
  });
});
