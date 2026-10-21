/**
 * 第一次打開（這台裝置沒有自己的資料、也沒登入）才會看到的歡迎畫面。
 * 像一般 App：先登入 → 載入你在其他裝置的資料；不想登入就選「先在這台裝置使用」。
 * 示範資料只在選本機模式時才載入，登入者永遠不會被塞示範資料。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { useToast } from '@/hooks/useToast';
import { fetchProviders, loginUrl, proxyUrlOf, type ProvidersResult } from '@/auth/session';
import { DEFAULT_PROXY_URL } from '@/config';
import { AiError } from '@/ai/types';
import { updateSettings } from '@/db/repo';
import { loadDemoDataIfEmpty } from '@/db/seed';

export function WelcomePage() {
  const settings = useSettings();
  const toast = useToast();
  const navigate = useNavigate();
  const proxyUrl = proxyUrlOf(settings, DEFAULT_PROXY_URL);
  const [providers, setProviders] = useState<ProvidersResult | 'loading' | 'unavailable' | 'outdated'>(proxyUrl ? 'loading' : 'unavailable');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!proxyUrl) return;
    let cancelled = false;
    fetchProviders(proxyUrl)
      .then((r) => {
        if (!cancelled) setProviders(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setProviders(e instanceof AiError && e.code === 'worker_outdated' ? 'outdated' : 'unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [proxyUrl]);

  async function useLocally(withDemo: boolean) {
    setBusy(true);
    try {
      if (withDemo) await loadDemoDataIfEmpty(settings.timeZone);
      await updateSettings({ onboarded: true, demoDataLoaded: true });
      navigate('/', { replace: true });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '無法開始', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const list = typeof providers === 'object' ? providers.providers : [];

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <img src="./icon.svg" alt="" width={72} height={72} className="rounded-2xl" />
      <h1 className="mt-5 text-2xl font-semibold">FlowPlan</h1>
      <p className="mt-1 text-sm text-muted">根據現況告訴你現在該做什麼的個人計畫。</p>

      <div className="mt-8 space-y-3">
        {providers === 'loading' && <p className="text-sm text-muted">正在確認登入方式…</p>}
        {list.map((p) => (
          <a key={p.id} href={loginUrl(proxyUrl, p.id)} className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[15px] font-semibold text-white active:opacity-80" data-testid={`welcome-login-${p.id}`}>
            <LogIn size={18} /> 用 {p.label} 登入
          </a>
        ))}
        {list.length > 0 && <p className="text-xs text-muted">登入後會載入你在其他裝置的資料；之後每台裝置登入同一個帳號就是同一份。</p>}
        {providers === 'unavailable' && proxyUrl && <p className="text-xs text-muted">目前連不到 Worker，可以先在這台裝置使用，之後再到設定登入。</p>}
        {providers === 'outdated' && <p className="text-xs text-warn">Worker 還是舊版（沒有登入功能）。擁有者把最新的 worker/src/index.js 貼上 Cloudflare 並 Deploy 後，重新整理這頁就會出現登入按鈕。</p>}
        {typeof providers === 'object' && list.length === 0 && <p className="text-xs text-muted">這個 Worker 沒有開放登入；可先在本機使用，或到設定填通關密語。</p>}

        <Button full onClick={() => useLocally(true)} disabled={busy} className="min-h-12" data-testid="welcome-local">
          <Smartphone size={18} className="mr-2" /> 先在這台裝置使用
        </Button>
        <p className="text-xs text-muted">資料只存在這台裝置，會先放幾筆示範資料讓你看懂怎麼用（可一鍵刪除）。之後隨時可到設定登入或匯入備份。</p>
        <button type="button" className="text-xs text-muted underline" onClick={() => useLocally(false)} disabled={busy}>
          從空白開始（不要示範資料）
        </button>
      </div>
    </div>
  );
}
