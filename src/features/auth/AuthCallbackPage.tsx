/**
 * 登入回呼頁：Worker 登入成功後跳回 `#/auth?token=…`（失敗則 `#/auth?error=…`）。
 *
 * 做的事（依序）：
 *   1. 把 token 拿去 Worker /auth/me 驗證（不信任網址裡的東西），拿到 email、功能開關
 *   2. 若這台裝置的資料屬於另一個帳號 → 先問要不要清掉本機再切換
 *   3. 存 session（只在 localStorage）、開啟同步與 AI、把本機資料排進第一次推送
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui';
import { PageHeader } from '@/components/AppShell';
import { LOGIN_ERROR_TEXT, proxyUrlOf, setSession, verifySessionToken, type MeResult } from '@/auth/session';
import { DEFAULT_PROXY_URL } from '@/config';
import { clearAllData, countAll, deleteDemoData, getSettings, hasNoOwnData, updateSettings } from '@/db/repo';
import { cloudHasData, enqueueEverything, getSyncMeta, makeTransport, replaceWithRemote, resetSyncVersion, runSync, setSyncAccount } from '@/sync/engine';
import { useToast } from '@/hooks/useToast';

type Phase = { kind: 'working' } | { kind: 'error'; message: string } | { kind: 'switch'; me: MeResult; previous: string } | { kind: 'standalone-hint'; token: string };

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** 這台裝置的資料屬於別的帳號且有資料 → 回傳那個帳號的名字，呼叫端應先問過再清除 */
export async function switchConflict(me: MeResult): Promise<string | null> {
  const meta = await getSyncMeta();
  if (!meta.accountUid || meta.accountUid === me.uid) return null;
  const c = await countAll();
  return c.tasks + c.events + c.logs > 0 ? (meta.accountEmail ?? meta.accountUid) : null;
}

/**
 * 登入後把一切接起來；回傳給使用者看的訊息。
 *
 * 目標：不管哪台裝置，登入同一個帳號就是原本的資料。三種情況：
 *   a. 同一個帳號在這台裝置登入過 → 什麼都不動，繼續同步
 *   b. 這台裝置第一次用這個帳號，雲端已有資料（例如第二台裝置）→ 以雲端為準：
 *      本機只有示範資料就直接清掉、設定也採雲端的；本機有自己的資料則合併進雲端（設定保留本機）
 *   c. 雲端是空的（這個帳號第一次用）→ 把本機資料（含示範）整包推上去，這台裝置就是起點
 *   wipeLocal：換帳號時先清掉本機（上一個人的資料），再走 b
 */
export async function completeLogin(me: MeResult, opts: { wipeLocal: boolean; fetchImpl?: typeof fetch }): Promise<string> {
  const before = await getSettings();
  const meta = await getSyncMeta();
  const sameAccount = meta.accountUid === me.uid;

  if (opts.wipeLocal) {
    await clearAllData();
    // 清掉後保留 Worker 網址（通關密語不保留：那是上一個人的）
    await updateSettings({ ai: { ...before.ai, proxySecret: undefined, enabled: false, provider: 'none' }, demoDataLoaded: true });
  }

  setSession({ token: me.token, uid: me.uid, email: me.email, name: me.name, provider: me.provider, exp: me.exp });

  if (!sameAccount) await resetSyncVersion();
  await setSyncAccount(me.uid, me.email);

  let how: 'continue' | 'adopt-cloud' | 'merge' | 'seed-cloud' | 'no-sync' = 'no-sync';
  if (me.features.sync) {
    const transport = makeTransport(await getSettings(), opts.fetchImpl);
    if (sameAccount && !opts.wipeLocal) {
      how = 'continue';
    } else if (await cloudHasData(transport)) {
      if (opts.wipeLocal || (await hasNoOwnData())) {
        // 新裝置（或剛清過）：雲端才是本尊。舊版殘留的示範資料不推上去，設定採雲端的
        await deleteDemoData();
        await replaceWithRemote(transport, { preferRemoteSettings: true });
        how = 'adopt-cloud';
      } else {
        await enqueueEverything();
        how = 'merge';
      }
    } else {
      await enqueueEverything();
      how = 'seed-cloud';
    }
  }

  const current = await getSettings();
  await updateSettings({
    onboarded: true,
    demoDataLoaded: true, // 登入者永遠不會被塞示範資料
    sync: { enabled: me.features.sync, auto: true },
    ai: { ...current.ai, enabled: me.features.ai ? true : current.ai.enabled, provider: me.features.ai ? 'claude' : current.ai.provider },
  });
  if (me.features.sync) void runSync('登入');

  const parts = [`已用 ${me.email} 登入`];
  if (how === 'adopt-cloud') parts.push('已載入你雲端的資料');
  else if (how === 'merge') parts.push('這台裝置的資料會與雲端合併');
  else if (how === 'seed-cloud') parts.push('同步已開啟，這台裝置的資料會推上雲端');
  else if (how === 'continue') parts.push('同步已開啟');
  else parts.push('Worker 還沒綁定 KV，暫時無法同步');
  if (!me.features.ai) parts.push('Worker 沒有設定 AI 金鑰，AI 助手不可用');
  return parts.join('，');
}

export function AuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const started = useRef(false);

  async function finish(me: MeResult, wipeLocal: boolean) {
    setPhase({ kind: 'working' });
    try {
      const msg = await completeLogin(me, { wipeLocal });
      toast.show(msg);
      navigate('/settings', { replace: true });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : '登入失敗' });
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const error = params.get('error');
    const detail = params.get('detail');
    const token = params.get('token');
    if (error) {
      setPhase({ kind: 'error', message: `${LOGIN_ERROR_TEXT[error] ?? '登入失敗'}${detail ? `（${detail}）` : ''}` });
      return;
    }
    if (!token) {
      navigate('/settings', { replace: true });
      return;
    }
    (async () => {
      try {
        const settings = await getSettings();
        const proxyUrl = proxyUrlOf(settings, DEFAULT_PROXY_URL);
        if (!proxyUrl) throw new Error('還沒設定 Worker 網址');
        const me = await verifySessionToken(proxyUrl, token);
        const previous = await switchConflict(me);
        if (previous) {
          setPhase({ kind: 'switch', me, previous });
          return;
        }
        await finish(me, false);
      } catch (e) {
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : '登入失敗' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const token = params.get('token');

  return (
    <div>
      <PageHeader title="登入" />
      <section className="mt-2 rounded-xl border border-line bg-surface p-4">
        {phase.kind === 'working' && <p className="text-sm text-muted">正在向 Worker 確認登入…</p>}
        {phase.kind === 'error' && (
          <>
            <p className="text-sm text-danger">{phase.message}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => navigate('/settings', { replace: true })}>
                回設定
              </Button>
            </div>
          </>
        )}
        {phase.kind === 'switch' && (
          <>
            <p className="text-sm">
              這台裝置上的資料屬於 <b>{phase.previous}</b>。改用 <b>{phase.me.email}</b> 登入會先清除這台裝置的本機資料（{phase.previous} 的雲端資料不受影響），再從雲端載入你的資料。
            </p>
            <p className="mt-2 text-xs text-warn">若 {phase.previous} 還有沒推送的變更，會遺失。</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="danger" onClick={() => finish(phase.me, true)}>
                清除本機並改用 {phase.me.email}
              </Button>
              <Button onClick={() => navigate('/settings', { replace: true })}>取消</Button>
            </div>
          </>
        )}
        {token && phase.kind === 'working' && !isStandalone() && (
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer">從主畫面的 FlowPlan 開啟卻停在這一頁？</summary>
            <p className="mt-1">複製下面的登入碼，回到主畫面的 FlowPlan → 設定 → 帳號 → 「貼上登入碼」。</p>
            <textarea readOnly value={token} rows={3} className="mt-2 w-full rounded-lg border border-line bg-surface-2 p-2 font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
          </details>
        )}
      </section>
    </div>
  );
}
