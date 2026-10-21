/**
 * 建置時注入的預設值。GitHub Actions 會把 VITE_FLOWPLAN_PROXY_URL 設成你的 Worker 網址，
 * 讓別人打開 App 時不用自己填 Worker 網址就能登入。本機開發沒設就是空字串。
 */
export const DEFAULT_PROXY_URL: string = ((import.meta.env.VITE_FLOWPLAN_PROXY_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
