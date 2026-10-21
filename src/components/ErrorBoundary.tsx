/**
 * 最外層的錯誤邊界。
 *
 * 教訓：曾有一版在舊設定列上開啟即崩潰，而「有新版本 → 更新」的提示本身在 React 樹裡，
 * 一崩潰就沒人能按更新，使用者永遠卡在壞版本。所以這裡：
 *   1. 崩潰時先看 Service Worker 有沒有在等待的新版本，有就直接啟用並重新載入（每個分頁只自動做一次，避免迴圈）
 *   2. 沒有就顯示錯誤與「重新載入」，資料不動
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

const RECOVER_FLAG = 'flowplan.autoRecovered';

interface State {
  error: Error | null;
  recovering: boolean;
}

async function waitingServiceWorker(): Promise<ServiceWorker | null> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    return reg?.waiting ?? null;
  } catch {
    return null;
  }
}

/** 啟用等待中的新版本並重新載入；回傳是否有做 */
export async function activateWaitingUpdate(): Promise<boolean> {
  const waiting = await waitingServiceWorker();
  if (!waiting) return false;
  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  waiting.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(reload, 2500);
  return true;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, recovering: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('FlowPlan 崩潰', error, info.componentStack);
    void this.tryAutoRecover();
  }

  private async tryAutoRecover(): Promise<void> {
    let already = false;
    try {
      already = sessionStorage.getItem(RECOVER_FLAG) === '1';
    } catch {
      /* 私密模式 */
    }
    if (already) return;
    const waiting = await waitingServiceWorker();
    if (!waiting) return;
    try {
      sessionStorage.setItem(RECOVER_FLAG, '1');
    } catch {
      /* ignore */
    }
    this.setState({ recovering: true });
    await activateWaitingUpdate();
  }

  render(): ReactNode {
    const { error, recovering } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-md p-6 text-sm">
        <h1 className="text-lg font-semibold">FlowPlan 發生錯誤</h1>
        {recovering ? (
          <p className="mt-2 text-muted">發現新版本，正在更新並重新載入…</p>
        ) : (
          <>
            <p className="mt-2 text-muted">你的資料都還在這台裝置上。先試著重新載入；若一直發生，請把下面這段錯誤訊息回報。</p>
            <pre className="mt-3 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">{error.message}</pre>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="min-h-11 rounded-xl bg-accent px-4 font-semibold text-white" onClick={() => location.reload()}>
                重新載入
              </button>
              <button
                type="button"
                className="min-h-11 rounded-xl border border-line px-4"
                onClick={async () => {
                  const did = await activateWaitingUpdate();
                  if (!did) location.reload();
                }}
              >
                更新到新版本
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
}
