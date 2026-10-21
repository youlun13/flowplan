import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './hooks/useToast';
import { getSettings } from './db/repo';
import { loadDemoDataIfEmpty } from './db/seed';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { TasksPage } from './features/tasks/TasksPage';
import { LogPage } from './features/log/LogPage';
import { SettingsPage } from './features/settings/SettingsPage';

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  await loadDemoDataIfEmpty(settings.timeZone);
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

  useEffect(() => {
    bootstrap()
      .then(() => setReady(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
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
      <HashRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="log" element={<LogPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </HashRouter>
    </ToastProvider>
  );
}
