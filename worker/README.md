# flowplan-ai（Cloudflare Worker）

一支零相依的 Worker，做三件事：保管 Anthropic API key 並代理 AI 呼叫、用 KV 做跨裝置同步、處理 Google / GitHub 登入。瀏覽器永遠拿不到 API key、OAuth Client Secret 或別人的資料。

## 端點

| 路徑 | 身分 | 說明 |
|---|---|---|
| `GET /v1/health` | 密語或登入 | 回報金鑰、模型、KV、登入設定與目前使用者 |
| `POST /v1/ai` | 密語或登入 | `{ op: "parse_incident" \| "explain_plan", ... }` |
| `GET/POST/DELETE /v1/sync`、`GET /v1/sync/status` | 密語或登入 | 這個身分自己的空間 |
| `GET /auth/providers` | 公開 | 開放哪些登入方式 |
| `GET /auth/:provider/start?redirect=` | — | 跳到 Google / GitHub |
| `GET /auth/:provider/callback` | — | 換 token、查 email、對 `ALLOWED_USERS`、簽 session、跳回 App |
| `GET /auth/me` | 登入 | 驗證 session，回使用者與 Worker 功能；超過 7 天換發新 token |

身分放在 `Authorization: Bearer <通關密語 或 session token>`。通關密語 → 空間 `snapshot`（擁有者）；登入者 → `u:<provider>:<id>:snapshot`。

## 環境變數

| 名稱 | 類型 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | 沒設就只有同步與登入可用 |
| `FLOWPLAN_PROXY_SECRET` | Secret | 單人模式通關密語（可選；登入模式可不設） |
| `FLOWPLAN_SESSION_SECRET` | Secret | 簽 session；沒設就退回用 `FLOWPLAN_PROXY_SECRET` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Secret | Google 登入 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Secret | GitHub 登入（可選） |
| `ALLOWED_USERS` | Text | 可登入的 email，逗號分隔；空的 = 不開放登入 |
| `ALLOWED_ORIGINS` | Text | App 來源；也是登入後允許跳回的網址 |
| `AI_MODEL`、`AI_MAX_OUTPUT_TOKENS` | Text | 預設模型與單次輸出上限 |
| `AI_DAILY_LIMIT_PER_USER` | Text | 每人每日 AI 次數上限（預設 60；需綁 KV） |
| `FLOWPLAN_KV` | KV binding | 同步與每日計數 |

## 防護

通關密語常數時間比較、HMAC-SHA256 簽的 session（60 天）與 state（10 分鐘）、Origin allowlist、redirect 只允許 `ALLOWED_ORIGINS`、email 白名單每次請求都重查（移出清單立即失效）、模型 allowlist、輸出 token 上限、請求大小上限、25 秒逾時、每人每日次數。
真正的費用硬上限請在 Anthropic Console 的 workspace 設 spend limit；這個 Worker 不是帳單的保證。

## 測試

`npm test` 會用 Node 直接執行這支 Worker（`tests/worker.test.ts`、`tests/sync.test.ts`、`tests/auth.test.ts`），上游 Anthropic / Google / GitHub 用假的。
