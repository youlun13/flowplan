/**
 * 多人登入（真 Worker 程式碼 + 假的 Google/GitHub 端點 + 記憶體 KV）。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error 純 JS Worker
import worker, { signToken, verifyToken } from '../worker/src/index.js';
import { db } from '@/db/db';
import { clearAllData, createTask, getSettings, updateSettings } from '@/db/repo';
import { getSyncMeta, installSyncHooks, makeTransport, syncNow } from '@/sync/engine';
import { credentialOf, fetchProviders, getSession, resetSessionCache, setSession, verifySessionToken } from '@/auth/session';
import { completeLogin, switchConflict } from '@/features/auth/AuthCallbackPage';

const APP = 'https://youlun13.github.io';
const W = 'https://flowplan-ai.example.workers.dev';

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
    keys: () => [...store.keys()],
  };
}

const baseEnv = {
  ANTHROPIC_API_KEY: 'sk-test',
  FLOWPLAN_PROXY_SECRET: 'passphrase-123',
  FLOWPLAN_SESSION_SECRET: 'session-secret-xyz',
  ALLOWED_ORIGINS: `${APP},http://localhost:5173`,
  ALLOWED_USERS: 'Alice@Example.com, bob@example.com',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  GITHUB_CLIENT_ID: 'ghid',
  GITHUB_CLIENT_SECRET: 'ghsecret',
  AI_MODEL: 'claude-haiku-5-5',
};

/** 假的 Google / GitHub / Anthropic */
const fake = { googleUser: { sub: '111', email: 'alice@example.com', email_verified: true, name: '愛麗絲' } as Record<string, unknown>, githubEmails: [{ email: 'bob@example.com', primary: true, verified: true }] as unknown[] };
const upstreamCalls: Array<{ url: string; body?: string }> = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  upstreamCalls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const body = String(init?.body ?? '');
    if (!body.includes('code=good') || !body.includes('client_secret=gsecret')) return j({ error: 'invalid_grant' }, 400);
    return j({ access_token: 'g-access', id_token: 'x' });
  }
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return j(fake.googleUser);
  if (url.startsWith('https://github.com/login/oauth/access_token')) return j({ access_token: 'gh-access' });
  if (url === 'https://api.github.com/user') return j({ id: 42, login: 'bobby', name: null });
  if (url === 'https://api.github.com/user/emails') return j(fake.githubEmails);
  if (url.startsWith('https://api.anthropic.com')) return j({ content: [{ type: 'tool_use', name: 'report_incident', input: { type: 'rest', minutes: 10, confidence: 0.9, missing: [], note: 'ok' } }], usage: { input_tokens: 10, output_tokens: 5 } });
  return new Response('not found', { status: 404 });
});

beforeEach(() => {
  upstreamCalls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function req(path: string, init: RequestInit & { token?: string; origin?: string | null } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.origin !== null) headers.set('Origin', init.origin ?? APP);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  return new Request(`${W}${path}`, { ...init, headers });
}

/** 走完整個 OAuth 流程，回傳 App 收到的 token */
async function loginVia(provider: 'google' | 'github', env: Record<string, unknown>, code = 'good'): Promise<{ token?: string; error?: string; detail?: string; location: string }> {
  const start = await worker.fetch(req(`/auth/${provider}/start?redirect=${encodeURIComponent(`${APP}/flowplan/`)}`, { origin: null }), env);
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.get('Location')!);
  const state = authUrl.searchParams.get('state')!;
  const cb = await worker.fetch(req(`/auth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`, { origin: null }), env);
  expect(cb.status).toBe(302);
  const location = cb.headers.get('Location')!;
  const hash = new URL(location).hash; // #/auth?token=...
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  return { token: params.get('token') ?? undefined, error: params.get('error') ?? undefined, detail: params.get('detail') ?? undefined, location };
}

describe('Worker：登入流程', () => {
  it('/auth/providers 公開；沒有 ALLOWED_USERS 就不開放登入', async () => {
    const r = await (await worker.fetch(req('/auth/providers'), baseEnv)).json();
    expect(r.result.providers.map((p: { id: string }) => p.id)).toEqual(['google', 'github']);
    expect(r.result.passphrase).toBe(true);
    const r2 = await (await worker.fetch(req('/auth/providers'), { ...baseEnv, ALLOWED_USERS: '' })).json();
    expect(r2.result.providers).toEqual([]);
    expect(r2.result.configuredProviders).toBe(2);
    const r3 = await (await worker.fetch(req('/auth/providers'), { ...baseEnv, GOOGLE_CLIENT_SECRET: '' })).json();
    expect(r3.result.providers.map((p: { id: string }) => p.id)).toEqual(['github']);
  });

  it('start 會跳到 Google，帶 client_id / redirect_uri / 簽過的 state；redirect 不在允許清單 → 400', async () => {
    const r = await worker.fetch(req(`/auth/google/start?redirect=${encodeURIComponent(`${APP}/flowplan/`)}`, { origin: null }), baseEnv);
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get('Location')!);
    expect(u.origin).toBe('https://accounts.google.com');
    expect(u.searchParams.get('client_id')).toBe('gid');
    expect(u.searchParams.get('redirect_uri')).toBe(`${W}/auth/google/callback`);
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    const state = await verifyToken('session-secret-xyz', u.searchParams.get('state'));
    expect(state).toMatchObject({ t: 'state', p: 'google', r: `${APP}/flowplan/` });
    const bad = await worker.fetch(req('/auth/google/start?redirect=https://evil.example/', { origin: null }), baseEnv);
    expect(bad.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Google 登入成功 → 302 回 App 帶 token；token 可過 /auth/me；email 大小寫不敏感', async () => {
    const { token, error } = await loginVia('google', baseEnv);
    expect(error).toBeUndefined();
    expect(token).toBeTruthy();
    // 換 token 時帶了 client_secret，且瀏覽器端從未看到
    expect(upstreamCalls.find((c) => c.url.includes('oauth2.googleapis.com/token'))?.body).toContain('client_secret=gsecret');
    const me = await (await worker.fetch(req('/auth/me', { token }), baseEnv)).json();
    expect(me.ok).toBe(true);
    expect(me.result).toMatchObject({ uid: 'google:111', email: 'alice@example.com', name: '愛麗絲', provider: 'google', features: { ai: true, sync: false } });
    expect(me.result.token).toBeUndefined(); // 剛簽的不用換發
  });

  it('不在允許清單 / 未驗證 email / 壞的 code / 使用者取消 → 回 App 帶 error，不簽 token', async () => {
    fake.googleUser = { sub: '999', email: 'mallory@example.com', email_verified: true, name: 'M' };
    expect(await loginVia('google', baseEnv)).toMatchObject({ error: 'not_allowed', detail: 'mallory@example.com' });
    fake.googleUser = { sub: '111', email: 'alice@example.com', email_verified: false };
    expect((await loginVia('google', baseEnv)).error).toBe('login_failed');
    fake.googleUser = { sub: '111', email: 'alice@example.com', email_verified: true, name: '愛麗絲' };
    expect((await loginVia('google', baseEnv, 'bad')).error).toBe('login_failed');
    const start = await worker.fetch(req(`/auth/google/start?redirect=${encodeURIComponent(APP + '/')}`, { origin: null }), baseEnv);
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const cancelled = await worker.fetch(req(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`, { origin: null }), baseEnv);
    expect(cancelled.headers.get('Location')).toContain('error=login_cancelled');
    // 假 state → 400 HTML，不碰上游
    const forged = await worker.fetch(req('/auth/google/callback?code=good&state=abc.def', { origin: null }), baseEnv);
    expect(forged.status).toBe(400);
    expect(upstreamCalls.filter((c) => c.url.includes('oauth2.googleapis.com/token') && c.body?.includes('code=good')).length).toBe(2);
  });

  it('GitHub：從 /user/emails 取 primary 且 verified 的 email', async () => {
    const { token } = await loginVia('github', baseEnv);
    const me = await (await worker.fetch(req('/auth/me', { token }), baseEnv)).json();
    expect(me.result).toMatchObject({ uid: 'github:42', email: 'bob@example.com', name: 'bobby', provider: 'github' });
    expect(upstreamCalls.some((c) => c.url === 'https://api.github.com/user/emails')).toBe(true);
    fake.githubEmails = [{ email: 'bob@example.com', primary: true, verified: false }];
    expect((await loginVia('github', baseEnv)).error).toBe('login_failed');
    fake.githubEmails = [{ email: 'bob@example.com', primary: true, verified: true }];
  });

  it('session 過期 / 竄改 / 事後被移出清單 → 401 或 403，且 App 端會丟掉 session', async () => {
    const expired = await signToken('session-secret-xyz', { t: 'session', v: 1, uid: 'google:111', email: 'alice@example.com', provider: 'google', iat: 1, exp: 2 });
    const r1 = await (await worker.fetch(req('/v1/health', { token: expired }), baseEnv)).json();
    expect(r1.error.code).toBe('session_expired');
    const forged = await signToken('wrong-secret', { t: 'session', v: 1, uid: 'google:111', email: 'alice@example.com', provider: 'google', iat: 1, exp: 9e9 });
    const r2 = await worker.fetch(req('/v1/health', { token: forged }), baseEnv);
    expect(r2.status).toBe(401);
    const { token } = await loginVia('google', baseEnv);
    const r3 = await worker.fetch(req('/v1/health', { token }), { ...baseEnv, ALLOWED_USERS: 'bob@example.com' });
    expect(r3.status).toBe(403);
    expect((await r3.json()).error.code).toBe('not_allowed');
    // 通關密語照舊可用
    const r4 = await (await worker.fetch(req('/v1/health', { token: 'passphrase-123' }), baseEnv)).json();
    expect(r4.result.user).toBeNull();
    expect(r4.result.auth).toMatchObject({ passphrase: true, providers: ['google', 'github'], allowlist: 2 });
  });

  it('超過 7 天的 session，/auth/me 會換發新 token', async () => {
    const old = await signToken('session-secret-xyz', { t: 'session', v: 1, uid: 'google:111', email: 'alice@example.com', name: 'A', provider: 'google', iat: Math.floor(Date.now() / 1000) - 8 * 86400, exp: Math.floor(Date.now() / 1000) + 86400 });
    const me = await (await worker.fetch(req('/auth/me', { token: old }), baseEnv)).json();
    expect(me.result.token).toBeTruthy();
    const fresh = await verifyToken('session-secret-xyz', me.result.token);
    expect(fresh.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 50 * 86400);
  });

  it('沒設 FLOWPLAN_SESSION_SECRET 時退回用通關密語簽章', async () => {
    const env = { ...baseEnv, FLOWPLAN_SESSION_SECRET: '' };
    const { token } = await loginVia('google', env);
    expect(await verifyToken('passphrase-123', token)).toMatchObject({ uid: 'google:111' });
  });
});

describe('Worker：每個登入者各自的資料空間', () => {
  it('A 推的資料 B 看不到；通關密語（擁有者）另有自己的空間；刪除只刪自己的', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const a = (await loginVia('google', env)).token!;
    const b = (await loginVia('github', env)).token!;
    const push = (token: string, id: string) =>
      worker.fetch(req('/v1/sync', { method: 'POST', token, body: JSON.stringify({ baseVersion: 0, records: { tasks: { [id]: { id, title: id, updatedAt: '2026-10-21T00:00:00.000Z' } } }, tombstones: {} }) }), env);
    await push(a, 'task-a');
    await push('passphrase-123', 'task-owner');
    const pullB = await (await worker.fetch(req('/v1/sync', { token: b }), env)).json();
    expect(Object.keys(pullB.result.snapshot.records.tasks)).toEqual([]);
    const pullA = await (await worker.fetch(req('/v1/sync', { token: a }), env)).json();
    expect(Object.keys(pullA.result.snapshot.records.tasks)).toEqual(['task-a']);
    const pullOwner = await (await worker.fetch(req('/v1/sync', { token: 'passphrase-123' }), env)).json();
    expect(Object.keys(pullOwner.result.snapshot.records.tasks)).toEqual(['task-owner']);
    expect(kv.keys().sort()).toEqual(['snapshot', 'u:google:111:snapshot'].sort());
    await worker.fetch(req('/v1/sync', { method: 'DELETE', token: a }), env);
    expect(kv.keys()).toEqual(['snapshot']);
    const st = await (await worker.fetch(req('/v1/sync/status', { token: a }), env)).json();
    expect(st.result).toMatchObject({ configured: true, version: 0 });
  });

  it('每人每日 AI 上限在伺服器端計數（需 KV）', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv, AI_DAILY_LIMIT_PER_USER: '2' };
    const a = (await loginVia('google', env)).token!;
    const call = (token: string) => worker.fetch(req('/v1/ai', { method: 'POST', token, body: JSON.stringify({ op: 'parse_incident', text: '想休息', context: {} }) }), env);
    expect((await call(a)).status).toBe(200);
    expect((await call(a)).status).toBe(200);
    const third = await call(a);
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe('daily_limit');
    // 別人的額度不受影響
    expect((await call('passphrase-123')).status).toBe(200);
    expect(upstreamCalls.filter((c) => c.url.startsWith('https://api.anthropic.com')).length).toBe(3);
  });
});

describe('App 端：登入後的同步與帳號切換', () => {
  beforeEach(async () => {
    await clearAllData();
    await db.syncQueue.clear();
    await db.syncMeta.clear();
    resetSessionCache();
    setSession(null);
    installSyncHooks();
  });

  function viaWorker(env: Record<string, unknown>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      headers.set('Origin', APP);
      return worker.fetch(new Request(String(input), { ...init, headers }), env);
    }) as typeof fetch;
  }

  it('憑證：登入 token 優先於通關密語；fetchProviders / verifySessionToken 走真 Worker', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const settings = await updateSettings({ ai: { enabled: false, provider: 'none', proxyUrl: W, proxySecret: 'passphrase-123', model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    expect(credentialOf(settings)).toBe('passphrase-123');
    const providers = await fetchProviders(W, viaWorker(env));
    expect(providers.providers.map((p) => p.id)).toEqual(['google', 'github']);
    const { token } = await loginVia('google', env);
    const me = await verifySessionToken(W, token!, viaWorker(env));
    expect(me).toMatchObject({ uid: 'google:111', email: 'alice@example.com', features: { ai: true, sync: true } });
    setSession({ token: me.token, uid: me.uid, email: me.email, name: me.name, provider: me.provider, exp: me.exp });
    expect(credentialOf(settings)).toBe(me.token);
    await expect(verifySessionToken(W, 'bad.token', viaWorker(env))).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('completeLogin：第一次登入把本機資料推進自己的空間；同帳號再登入不重推；換帳號先清本機再載雲端', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const f = viaWorker(env);
    await updateSettings({ ai: { enabled: false, provider: 'none', proxyUrl: W, model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    await createTask({ title: 'Alice 的任務', plannedDate: '2026-10-21' });
    await db.syncQueue.clear(); // 模擬「登入前的舊資料」：沒有待推送佇列

    const alice = await verifySessionToken(W, (await loginVia('google', env)).token!, f);
    expect(await switchConflict(alice)).toBeNull();
    const msg = await completeLogin(alice, { wipeLocal: false, fetchImpl: f });
    expect(msg).toContain('alice@example.com');
    expect((await getSettings()).sync).toEqual({ enabled: true, auto: true });
    expect((await getSettings()).ai).toMatchObject({ enabled: true, provider: 'claude' });
    expect((await getSyncMeta()).accountUid).toBe('google:111');
    expect(getSession()?.email).toBe('alice@example.com');
    // completeLogin 把本機資料排進佇列；實際推送（runSync 需要 SyncRunner）這裡手動做
    await syncNow(makeTransport(await getSettings(), f));
    const cloudA = JSON.parse((await kv.get('u:google:111:snapshot')) as string);
    expect(Object.values(cloudA.records.tasks).map((t) => (t as { title: string }).title)).toEqual(['Alice 的任務']);

    // 同一個帳號再登入（例如 token 換發）→ 不會把全部資料重新排進佇列（只有設定本身因為被更新而排隊）
    await completeLogin(alice, { wipeLocal: false, fetchImpl: f });
    expect((await db.syncQueue.toArray()).every((q) => q.table === 'settings')).toBe(true);

    // Bob 在同一台裝置登入 → 有衝突，要先問
    const bob = await verifySessionToken(W, (await loginVia('github', env)).token!, f);
    expect(await switchConflict(bob)).toBe('alice@example.com');
    // Bob 雲端先有自己的資料
    await worker.fetch(req('/v1/sync', { method: 'POST', token: bob.token, body: JSON.stringify({ baseVersion: 0, records: { tasks: { 'bob-1': { id: 'bob-1', title: 'Bob 的任務', status: 'todo', priority: 'P2', estimatedMinutes: 30, energyRequired: 'medium', splittable: true, dependencies: [], deferCount: 0, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' } } }, tombstones: {} }) }), env);
    await completeLogin(bob, { wipeLocal: true, fetchImpl: f });
    const titles = (await db.tasks.toArray()).map((t) => t.title);
    expect(titles).toEqual(['Bob 的任務']);
    expect((await getSyncMeta()).accountUid).toBe('github:42');
    expect((await getSettings()).ai.proxyUrl).toBe(W); // Worker 網址保留
    expect((await getSettings()).ai.proxySecret).toBeUndefined();
    // Alice 的雲端沒被動到
    expect(Object.keys(JSON.parse((await kv.get('u:google:111:snapshot')) as string).records.tasks)).toHaveLength(1);
  });
  it('新裝置登入既有帳號：設定採雲端的、雲端任務拉下來（登入就是原本的）', async () => {
    const kv = memoryKv();
    const env = { ...baseEnv, FLOWPLAN_KV: kv };
    const f = viaWorker(env);
    // 雲端：Alice 之前在第一台裝置留下的資料與設定
    const aliceToken = (await loginVia('google', env)).token!;
    await worker.fetch(req('/v1/sync', { method: 'POST', token: aliceToken, body: JSON.stringify({ baseVersion: 0, records: {
      tasks: { 'a-1': { id: 'a-1', title: 'Alice 的任務', status: 'todo', priority: 'P2', estimatedMinutes: 30, energyRequired: 'medium', splittable: true, dependencies: [], deferCount: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' } },
      settings: { default: { ...(await getSettings()), workStart: '09:30', focusMinutes: 60, ai: { enabled: true, provider: 'claude', model: 'claude-haiku-5-5', maxOutputTokens: 1024, dailyLimit: 30, proxyUrl: 'https://old-device' }, sync: { enabled: true, auto: true }, updatedAt: '2026-10-01T00:00:00.000Z' } },
    }, tombstones: {} }) }), env);
    // 這台新裝置：沒有資料，只有剛寫入的預設設定（updatedAt 比雲端新）
    await updateSettings({ ai: { enabled: false, provider: 'none', proxyUrl: W, model: 'claude-haiku-5-5', maxOutputTokens: 512, dailyLimit: 30 } });
    expect((await db.tasks.toArray()).length).toBe(0);

    const alice = await verifySessionToken(W, aliceToken, f);
    const msg = await completeLogin(alice, { wipeLocal: false, fetchImpl: f });
    expect(msg).toContain('已載入你雲端的資料');
    expect((await db.tasks.toArray()).map((t) => t.title)).toEqual(['Alice 的任務']);
    const s = await getSettings();
    expect(s.workStart).toBe('09:30');
    expect(s.focusMinutes).toBe(60);
    expect(s.ai.proxyUrl).toBe(W); // 本機的 Worker 網址保留，不被雲端的舊網址蓋掉
    expect(s.sync).toEqual({ enabled: true, auto: true });
    // 推送後雲端只有 Alice 的任務
    await syncNow(makeTransport(await getSettings(), f));
    const cloud = JSON.parse((await kv.get('u:google:111:snapshot')) as string);
    expect(Object.values(cloud.records.tasks).map((t) => (t as { title: string }).title)).toEqual(['Alice 的任務']);
    expect(cloud.records.settings.default.workStart).toBe('09:30');
  });
});
