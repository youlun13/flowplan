/**
 * Service Worker 註冊與「有新版本」提示。只在正式部署（絕對 base）時由 vite-plugin-pwa 產生 sw.js；
 * 其他環境 import 會被 virtual 模組以 no-op 取代。
 */
export type PwaUpdateHandler = (reload: () => Promise<void>) => void;

export async function registerPwa(onNeedRefresh: PwaUpdateHandler, onOfflineReady?: () => void): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;
  try {
    const { registerSW } = await import('virtual:pwa-register');
    const update = registerSW({
      immediate: true,
      onNeedRefresh() {
        onNeedRefresh(() => update(true));
      },
      onOfflineReady() {
        onOfflineReady?.();
      },
    });
  } catch {
    // 沒有產生 sw（例如相對 base 的預覽建置）：忽略
  }
}
