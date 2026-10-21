import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './hooks/useToast';
import { getSettings, hasOnlyDemoData } from './db/repo';
import { WelcomePage } from './features/welcome/WelcomePage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { TasksPage } from './features/tasks/TasksPage';
import { LogPage } from './features/log/LogPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { registerPwa } from './pwa';
import { makeTransport, startAutoSync, syncConfigured } from './sync/engine';
import { useSettings } from './hooks/useSettings';
import { useSession } from './hooks/useSession';
import { AuthCallbackPage } from './features/auth/AuthCallbackPage';
import { Button } from './components/ui';

/** 設定裡開了同步、且已登入或有通關密語，就啟動自動同步；關掉就停 */
function SyncRunner() {
  const settings = useSettings();
  const session = useSession();
  const enabled = settings.sync.enabled && settings.sync.auto && syncConfigured(settings);
  useEffect(() => {
    if (!enabled) return;
    const stop = startAutoSync(async () => {
      const { getSettings } = await import('./db/repo');
      const s = await getSettings();
      if (!s.sync.enabled || !syncConfigured(s)) return null;
      return makeTransport(s);
    });
    return stop;
    // session 變動（登入 / 登出）時重新評估
  }, [enabled, session?.uid]);
  return null;
}

/**
 * 第一次打開的門：這台裝置沒有自己的資料、沒登入、也還沒選過「本機使用」→ 先看歡迎畫面（登入 / 本機）。
 * 登入回呼頁永遠放行。示範資料不再在啟動時自動塞進去，由歡迎畫面的「本機使用」決定。
 */
function Gate() {
  const settings = useSettings();
  const session = useSession();
  const location = useLocation();
  const onlyDemo = useLiveQuery(() => hasOnlyDemoData(), []);
  if (location.pathname === '/auth') return <AppRoutes />;
  if (onlyDemo === undefined) return null;
  if (!session && !settings.onboarded && onlyDemo) return <WelcomePage />;
  return <AppRoutes />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="log" element={<LogPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="auth" element={<AuthCallbackPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

async function bootstrap(): Promise<void> {
  await getSettings(); // 確保設定列存在且欄位完整
  // 要求瀏覽器盡量不要自動清除本機資料（iOS Safari 對加入主畫面的 PWA 最有效）
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* 不支援就算了 */
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState<null | (() => Promise<void>)>(null);

  useEffect(() => {
    bootstrap()
      .then(() => setReady(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void registerPwa((doReload) => setReload(() => doReload));
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">FlowPlan 無法啟動</h1>
        <p className="mt-2 text-sm text-muted">本機資料庫開啟失敗：{error}</p>
        <p className="mt-2 text-sm text-muted">請確認瀏覽器允許網站儲存資料（私密瀏覽模式下 IndexedDB 可能不可用）。</p>
      </div>
    );
  }
  if (!ready) return <div className="p-6 text-sm text-muted">載入中…</div>;

  return (
    <ToastProvider>
      <SyncRunner />
      {reload && (
        <div className="safe-top fixed inset-x-0 top-0 z-[80] flex justify-center px-4 pt-2">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2 text-sm shadow-lg">
            <span>FlowPlan 有新版本</span>
            <Button variant="primary" className="min-h-9 px-3 text-sm" onClick={() => reload()}>
              更新
            </Button>
            <button type="button" className="text-muted" onClick={() => setReload(null)}>
              稍後
            </button>
          </div>
        </div>
      )}
      <HashRouter>
        <Gate />
      </HashRouter>
    </ToastProvider>
  );
}
