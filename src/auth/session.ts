/**
 * 登入 session（多人模式）。
 *
 * 流程：App → Worker /auth/:provider/start → Google/GitHub → Worker callback → 回 App `#/auth?token=…`
 * Worker 用 HMAC 簽的 session token 只存在這台裝置的 localStorage，不進 Dexie、不備份、不同步。
 * 之後呼叫 AI 與同步時，Authorization 改帶這個 token（取代通關密語）。
 */
import { AiError } from '@/ai/types';
import type { Settings } from '@/db/schema';

export type Provider = 'google' | 'github';

export interface Session {
  token: string;
  uid: string;
  email: string;
  name: string;
  provider: Provider;
  /** 秒（epoch） */
  exp: number;
}

export interface ProviderInfo {
  id: Provider;
  label: string;
}

export interface ProvidersResult {
  providers: ProviderInfo[];
  passphrase: boolean;
  allowlist: boolean;
  configuredProviders: number;
}

const STORAGE_KEY = 'flowplan.session';
const listeners = new Set<() => void>();
let cache: Session | null | undefined;

function readStorage(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.token !== 'string' || typeof s.uid !== 'string' || typeof s.email !== 'string' || typeof s.exp !== 'number') return null;
    return { token: s.token, uid: s.uid, email: s.email, name: typeof s.name === 'string' ? s.name : '', provider: s.provider === 'github' ? 'github' : 'google', exp: s.exp };
  } catch {
    return null;
  }
}

/** 純讀取（給 useSyncExternalStore 用，不能有副作用）；過期就視同沒登入，由 Worker 的 session_expired 觸發真正清除 */
export function getSession(): Session | null {
  if (cache === undefined) cache = readStorage();
  if (cache && cache.exp * 1000 < Date.now()) return null;
  return cache;
}

export function setSession(s: Session | null): void {
  cache = s;
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 私密模式等情況：只留在記憶體 */
  }
  for (const l of listeners) l();
}

export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 測試用：清掉記憶體快取 */
export function resetSessionCache(): void {
  cache = undefined;
}

/** 實際要用的 Worker 網址：設定裡的優先，其次是建置時注入的預設 */
export function proxyUrlOf(settings: Settings, fallback = ''): string {
  return (settings.ai.proxyUrl || fallback).replace(/\/+$/, '');
}

/** Authorization 要帶的憑證：登入 token 優先，其次通關密語 */
export function credentialOf(settings: Settings): string {
  return getSession()?.token || settings.ai.proxySecret || '';
}

/** App 自己的網址（不含 hash），讓 Worker 登入後跳回來 */
export function appUrl(): string {
  return `${location.origin}${location.pathname}${location.search}`;
}

export function loginUrl(proxyUrl: string, provider: Provider): string {
  return `${proxyUrl.replace(/\/+$/, '')}/auth/${provider}/start?redirect=${encodeURIComponent(appUrl())}`;
}

/** Worker 回 401 session_expired / unauthorized 時，登入 token 已經沒用了，清掉讓畫面顯示「請重新登入」 */
export function dropSessionIfRejected(code: string): void {
  if ((code === 'session_expired' || code === 'unauthorized' || code === 'not_allowed') && getSession()) setSession(null);
}

async function getJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch {
    throw new AiError('network');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AiError('bad_response');
  }
  if (!body || typeof body !== 'object' || typeof (body as { ok?: unknown }).ok !== 'boolean') throw new AiError('bad_response');
  return body as { ok: boolean; result?: unknown; error?: { code?: string; message?: string } };
}

export async function fetchProviders(proxyUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProvidersResult> {
  const r = await getJson(`${proxyUrl.replace(/\/+$/, '')}/auth/providers`, { method: 'GET' }, fetchImpl);
  if (!r.ok) {
    // 舊版 Worker 沒有 /auth/*：會因為沒帶密語回 unauthorized，或回 not_found
    if (r.error?.code === 'unauthorized' || r.error?.code === 'not_found') throw new AiError('worker_outdated');
    throw new AiError('unknown', r.error?.message);
  }
  const res = (r.result ?? {}) as Partial<ProvidersResult>;
  const providers = Array.isArray(res.providers) ? res.providers.filter((p): p is ProviderInfo => p && (p.id === 'google' || p.id === 'github')) : [];
  return { providers, passphrase: Boolean(res.passphrase), allowlist: Boolean(res.allowlist), configuredProviders: Number(res.configuredProviders ?? 0) };
}

export interface MeResult extends Session {
  features: { ai: boolean; sync: boolean };
}

/** 向 Worker 驗證 token，拿回使用者資料（可能順便換發新 token） */
export async function verifySessionToken(proxyUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<MeResult> {
  const r = await getJson(`${proxyUrl.replace(/\/+$/, '')}/auth/me`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, fetchImpl);
  if (!r.ok) {
    const code = r.error?.code ?? 'unknown';
    if (code === 'session_expired' || code === 'not_allowed' || code === 'forbidden_origin' || code === 'unauthorized') throw new AiError(code, r.error?.message);
    throw new AiError('unknown', r.error?.message);
  }
  const m = (r.result ?? {}) as Partial<MeResult> & { token?: string };
  if (typeof m.uid !== 'string' || typeof m.email !== 'string' || typeof m.exp !== 'number') throw new AiError('bad_response');
  return {
    token: typeof m.token === 'string' && m.token ? m.token : token,
    uid: m.uid,
    email: m.email,
    name: typeof m.name === 'string' ? m.name : '',
    provider: m.provider === 'github' ? 'github' : 'google',
    exp: m.exp,
    features: { ai: Boolean(m.features?.ai), sync: Boolean(m.features?.sync) },
  };
}

export const LOGIN_ERROR_TEXT: Record<string, string> = {
  login_cancelled: '你取消了登入',
  login_failed: '登入失敗',
  not_allowed: '這個帳號不在 Worker 的允許清單（ALLOWED_USERS）裡，請擁有者加入後再試',
  session_expired: '登入已過期或失效，請重新登入',
};
