# FlowPlan — 動態節點式個人計畫系統

> 傳統計畫：預先決定每一步。FlowPlan：預先定義怎麼決定下一步。

本機優先（local-first）、手機優先、零額外付費的個人計畫 Web App。目前完成 **第一、二階段**：可日常使用的日曆、每日 TODO、實際紀錄、設定與備份，以及零 AI 的動態規則引擎（可用時段、硬性限制、截止風險、優先級、精力匹配、最低可行版本、反抖動、反飢餓、明確降級），含「我遇到狀況了」結構化流程、重排預覽 / 差異 / 套用 / 撤銷。

## 安裝與啟動

需求：Node.js 20 以上（開發時使用 22）。

```bash
npm install
npm run dev        # http://localhost:5173（--host 已開，手機可用區網 IP 開）
npm run build      # 型別檢查 + 產出 dist/
npm run preview    # 以正式建置檔啟動 http://localhost:4173
npm test           # Vitest 單元測試（66 個，涵蓋時區、重複展開、可用時段、依賴、規則引擎、驗證器、套用 / 撤銷、資料層）
```

瀏覽器端驗收（需要 Python 版 Playwright 與 Chromium）：

```bash
npm run build && npm run preview -- --port 4173 &
python3 e2e/smoke.py http://localhost:4173/     # 17 項，對應驗收條件 1–4、10、11 與狀況流程
```

## 技術架構

| 層 | 選擇 | 理由 |
|---|---|---|
| 前端 | Vite + React 19 + TypeScript + Tailwind CSS 4 | 純靜態輸出，任何免費靜態主機都能放；不需要 SSR |
| 資料 | IndexedDB（Dexie 4）+ Zod | 本機持久化；Zod schema 同時當 DB 寫入驗證、JSON 匯入驗證、第三階段 AI 輸出驗證 |
| 時間 | date-fns 4 + @date-fns/tz | 固定 App 時區（預設 Asia/Taipei），不看裝置時區 |
| 路由 | react-router（Hash） | 靜態主機不需要伺服器 rewrite |
| 測試 | Vitest + fake-indexeddb；Playwright（Python）做瀏覽器驗收 | 規則引擎是純函數，直接單元測試；Worker 也在 Node 裡直接跑 |
| 伺服器（選用） | 一支 Cloudflare Worker（免費）+ KV | AI 代理（保管金鑰）、跨裝置同步、Google/GitHub 登入；沒有它 App 照常運作 |
| 離線 | vite-plugin-pwa（Workbox） | 正式部署版可加入主畫面、離線開啟 |

規格原本建議 Next.js 與 FullCalendar；改用 Vite 與自建日曆的理由：這是 local-first 的純瀏覽器 App，SSR 沒有好處；自建日曆更輕、手機操作可控、與任務清單聯動自然，MVP 不需要拖曳。

### 目錄

```
src/
  lib/time.ts          時區工具：LocalDate / HH:mm / UTC instant 三種型別的換算
  lib/select.ts        任務查詢、排序、分組（純函數）
  engine/intervals.ts  區間運算（合併、相減、裁切、重疊偵測）
  engine/availability.ts  可用時段 = 可工作時段 − 睡眠保護 − 硬性行程（含緩衝）
  engine/recurrence.ts    週重複行程展開（exceptions / until）
  engine/dependencies.ts  依賴循環檢查、前置是否完成
  engine/nextStep.ts      尚未套用排程時的「下一步」簡易建議
  engine/planner.ts       規則引擎：狀況正規化 → 可用時段 → 候選排序 → 保留可行區塊 → 放入 / 最低版本 / 未安排 → 差異與理由
  engine/validate.ts      最終衝突驗證（套用前必過；第三階段 AI 輸出也走這裡）
  db/schema.ts         Zod 模型（Task, CalendarEvent, ActivityLog, DailyState, WorkBlock, PlanRevision, Settings, Backup）
  db/db.ts             Dexie 資料庫定義
  db/repo.ts           所有寫入（驗證後才寫）
  db/plan.ts           套用 / 撤銷方案（WorkBlock、PlanRevision 快照）
  db/backup.ts         JSON 匯出 / 匯入
  features/tour/       第一次使用的聚光燈導覽（在真正的介面上框元件 + 細線 + 說明框；取代示範資料）
  engine/stats.ts         週統計、預估校正係數、延期分析、完成歷史
  ai/                  自然語言 → 事件：規則解析（nlParse）、Claude Worker provider、降級鏈（resolve）、定價
  sync/engine.ts       跨裝置同步：Dexie hooks 變更追蹤、push/pull、套用快照、自動排程
  auth/session.ts      登入 session（只在 localStorage）、憑證選擇（登入 token 優先，其次通關密語）
  config.ts            建置時注入的預設 Worker 網址
  components/          UI 元件、表單、時間軸
  features/            頁面：今日 / 日曆 / 任務 / 紀錄（日 / 週）/ 設定 / 登入回呼
worker/src/index.js    Cloudflare Worker（零相依）：/v1/ai、/v1/sync、/auth/*
tests/                 Vitest（含直接執行 Worker 的 worker / sync / auth 測試）
e2e/smoke.py           瀏覽器驗收（含假 Worker：AI、同步、登入）
scripts/make-artifact-page.mjs   把 dist/index.html 轉成 claude.ai 預覽用片段（正式部署不需要）
scripts/render-icons.py          把 design/icon-*.svg 轉成 public/ 的 PNG 圖示
design/                          圖示候選（A 分流、B 現在線、C 節點 F）
```

## 資料模型

儲存規則：**時刻**存 UTC ISO 字串；**日期**存 `YYYY-MM-DD`（App 時區的當地日期）；**一天中的時間**存 `HH:mm`（App 時區牆上時間）。

| 模型 | 重點欄位 |
|---|---|
| `Task` | 規格表全部欄位 + `deferCount`、`lastDeferredAt`（規則 8 反飢餓）、`isDemo` |
| `CalendarEvent` | `startAt`/`endAt` 為第一次發生；`recurrence { freq:'weekly', byWeekday[], until?, exceptions[] }` |
| `ActivityLog` | 實際紀錄：`date`、`startAt`、`endAt?`（進行中為空）、`category`、`taskId?`；綁定任務時自動累計 `actualMinutes` |
| `DailyState` | 當日精力、起床時間 |
| `Settings` | 可工作時段、睡眠保護、緩衝、專注長度、週起始日、時區、決策偏好、AI（預設關閉）、備份提醒 |
| `WorkBlock` | 已套用的工作區塊：`taskId`、`startAt`/`endAt`、`status planned/active/done/skipped`、`isMinimum`、`reason`、`revisionId` |
| `PlanRevision` | 一次套用：觸發原因、摘要、套用前後區塊快照、附帶效果（建立的行程、完成的任務、精力），供撤銷 |

完整定義見 `src/db/schema.ts`。

## 規則引擎

決策管線（`src/engine/planner.ts`，純函數）：

1. 狀況正規化：睡過頭 / 臨時有事 / 精力變化 / 提早完成 / 超時 / 需要休息 → 新的硬性區間、精力、任務狀態、剩餘工時
2. 可用時段 = 可工作時段 − 睡眠保護 − 硬性行程（含前後緩衝），從現在開始
3. 候選：未完成、前置已完成、今天或之前排定、或 48 小時內截止
4. 排序：進行中 > 截止 tier（逾期 > 今天 > 48 小時內）> 優先級 > 反飢餓 > 精力匹配 > 排定日期
5. 既有仍可行的區塊原位保留；只重排受影響的部分
6. 逐一放入：可拆的任務依專注長度切段、段間留休息；今天截止的任務必須在截止前結束；完整版放不下就放最低版本；都放不下列入未安排並給原因與建議
7. 差異（新增 / 保留 / 移動 / 縮短 / 移除 / 延後）、理由、警示、`feasible`
8. 套用前再經 `validate.ts`：不重疊硬性行程與睡眠、不超出可工作時段、不排在過去、不違反依賴、不安排已完成任務、不指向不存在的任務

| 規則 | 狀態 | 測試 |
|---|---|---|
| 1 固定限制優先 | 可用時段 + 驗證器雙重保證，跨午夜正確 | `availability.test.ts`、`planner.test.ts`（驗收 5、13） |
| 2 期限緊迫 | tier 排序 + 截止前結束的硬性條件 | 驗收 6、7 |
| 3 優先級 | 同 tier 內 P1 > P2 > P3 | 驗收 7 |
| 4 精力匹配 | 同 tier 同優先級內排序；低精力遇高負荷任務警示不跳過 | 規則 4 測試 |
| 5 最低可行 | 完整版放不下 → `minimumMinutes` 版本，標記與說明 | 規則 5 測試 |
| 6 事件觸發 | 只在「規劃今天」或回報狀況時重算 | — |
| 7 反抖動 | 進行中永遠第一；可行的既有區塊原位保留（id 不變） | 規則 7 測試 ×2、`plan-apply.test.ts` |
| 8 反飢餓 | `deferCount ≥ 2` 提前並警示；不改 priority | 規則 8 測試 |
| 9 明確降級 | 未安排項目附原因（放不下 / 最低版本也放不下 / 需要連續空檔 / 截止前不可能）與建議 | 規則 9 測試、驗收 6 |
| 10 人保有控制權 | 預覽不寫資料；套用才寫；可撤銷最近一次 | `plan-apply.test.ts`（驗收 11）、e2e |
| 評分權重 | 沒有可被任意覆寫的分數：硬性限制是過濾器，排序鍵集中在 `buildPlan` 的 `sort` | 確定性測試 |

## 部署（全部為靜態檔，第一階段零費用）

**已設定自動部署**：push 到 `main` 會觸發 `.github/workflows/deploy.yml`，跑完測試與建置後部署到 GitHub Pages：

> https://youlun13.github.io/flowplan/

因為 `base: './'` 與 Hash 路由，放在子路徑也能正常運作。其他免費靜態主機（Cloudflare Pages、Vercel）同樣只需 `npm run build` 後上傳 `dist/`；請以當期官方頁面確認免費額度。

AI 代理、同步與登入都在同一支 Cloudflare Worker（`worker/`，免費方案、不需付款資訊），靜態網站留在 GitHub Pages；步驟見 `docs/API_SETUP.md`（Part A/B：AI；Part C：KV 同步；Part D/E：登入與邀請別人）。

CI 建置時把 `FLOWPLAN_BASE=/flowplan/` 給 Vite（絕對路徑才開 PWA 離線快取），並把 `VITE_FLOWPLAN_PROXY_URL` 設成 Worker 網址，讓別人不用自己填。

## 環境變數

前端只有建置時的 `VITE_FLOWPLAN_PROXY_URL`（Worker 網址，不是秘密）。`.env.example` 列出 Worker 端的變數：`ANTHROPIC_API_KEY`、`FLOWPLAN_PROXY_SECRET`、`FLOWPLAN_SESSION_SECRET`、`GOOGLE_CLIENT_ID/SECRET`、`GITHUB_CLIENT_ID/SECRET`、`ALLOWED_USERS`、`ALLOWED_ORIGINS`、`AI_MODEL`、`AI_MAX_OUTPUT_TOKENS`、`AI_DAILY_LIMIT_PER_USER`，加上 KV 綁定 `FLOWPLAN_KV`；設定在 Cloudflare Worker 的 Variables and Secrets / Bindings。永遠不要把真正的金鑰寫進 repo 或前端。

## 已實作 / 未實作 / 如何驗證

**已實作**

- 五格導覽（今日 / 日曆 / 任務 / 紀錄 / 設定），手機底部、桌機左側
- 任務 CRUD、勾選 / 取消、搜尋、狀態過濾、三種排序、依日期分組；完整欄位（截止、精力、可拆、最低工時、最低成果、依賴含循環檢查）
- 固定行程 CRUD、每週重複（星期、截止日、單次例外）、跨午夜行程、重疊警示
- 日曆月 / 週 / 日檢視；選日期即顯示該日行程與任務；日檢視為比例時間軸並顯示可用時段
- 今日總覽：完成率、精力狀態、「下一步」卡（含理由與警示）、開始 / 完成、逾期任務處理（排到今天 / 延到明天 / 編輯 / 取消）、今日行程、計畫 vs 實際時間軸
- 實際紀錄：開始 / 結束計時、補登、空白時段提示、分類摘要、綁定任務自動累計實際工時
- 設定：每日時段、睡眠保護、緩衝、專注長度、週起始日、決策偏好；AI 區塊存在但預設關閉
- JSON 匯出 / 匯入（取代或合併）、複製備份到剪貼簿、清除全部、備份提醒、`navigator.storage.persist()`
- PWA manifest 與圖示（可加入主畫面）；正式部署版有 Service Worker 離線快取與「有新版本 → 更新」提示
- 深色模式（跟隨系統）
- 第二階段：「我遇到狀況了」結構化表單（睡過頭 / 臨時有事 / 精力變化 / 提早完成 / 超時 / 需要休息 / 單純重排）、重排結果以「現在要做什麼」呈現：「拚了」（直接做最重要的）／「先喘口氣」（休息 15 分鐘，回來先做最輕鬆的，其餘重排）兩張卡片；細節只有套用後今日安排（含固定行程與休息）與缺點；套用、撤銷最近一次、今日排程列表與時間軸區塊、區塊開始 / 跳過
- 第三階段：自然語言輸入 → 規則解析 / AI 解析 → 「理解到的狀態」確認 → 預覽；Cloudflare Worker 代理與 Claude provider；AI 白話說明；設定頁 AI 區塊（啟用、Worker 網址、通關密語、模型、每日上限、測試連線、今日 / 累計用量與估計費用）；備份不匯出通關密語

- 第四階段：跨裝置同步（同一支 Worker + Cloudflare KV；Dexie hooks 追蹤變更、4 秒去抖推送、回前景 / 上線 / 每 90 秒拉取；同 id 以 updatedAt 新者為準、tombstone 刪除、本機未推送的變更不會被覆蓋；設定頁立即同步 / 檢查雲端 / 以雲端為準 / 刪除雲端）、離線快取、紀錄頁週檢視（每日分類時數、28 天完成趨勢、預估準不準、一直被延後的）、預估工時校正（≥3 筆完成樣本取實際 / 預估中位數，依精力分組，規則引擎用校正後工時並在說明交代；可在設定關閉）
- 歡迎畫面與導覽：新裝置先選「登入」或「本機使用」，接著聚光燈導覽（框住真正的元件、細線連到說明框、自動切頁，7 步）；示範資料已從產品移除，舊版本留下的（含雲端）會在啟動與同步時自動刪除；登入既有帳號的新裝置以雲端為準（設定採雲端）
- 多人登入：Google / GitHub OAuth 由 Worker 處理，email 白名單（`ALLOWED_USERS`）每次請求重查，每人獨立 KV 空間、每人每日 AI 次數上限；App 端登入回呼頁、帳號區塊、換帳號保護（先問再清本機）、登出 / 登出並清除、貼上登入碼（主畫面 App 備援）；session 只在 localStorage，不備份不同步

**未實作**

- Gemini / Groq provider（Worker 端預留 provider 切換，App 端選項先停用）
- 外部行事曆匯入（ICS / Google Calendar）
- 雲端資料加密（KV 內是明文，只有本人與 Worker 擁有者能讀）

**如何驗證**

- `npm test`：132 個單元測試，含驗收 1、2、3、5、6、7、8、9（Worker 錯誤正規化、非法 JSON、結構不符、虛構 id、已完成任務）、10（AI 關閉 / 失敗 / 達上限都退回規則）、11、13（跨午夜、夏令時間、空白 TODO、重疊）、14；同步合併規則與兩台裝置往返；登入流程（state 簽章、白名單、未驗證 email、過期 / 竄改 session、換發、每人空間隔離、每日上限）
- `python3 e2e/smoke.py`：真實 Chromium 操作 47 項，含驗收 1–4、9（假 Worker 回 HTML / 虛構 id / 503）、10、11、12（請求只帶憑證；備份不含密語）、同步往返、登入 → 推進自己的空間 → 擁有者空間不變 → 登出
- 真實 Anthropic / Google 呼叫未在 CI 測（需要金鑰）；部署 Worker 後用設定頁「測試連線」、實際登入與一次解析驗證

## 已知限制

- 沒開同步時資料只存在這台裝置的這個瀏覽器。**iPhone 上 Safari 分頁與「加入主畫面」的 App 是兩份獨立資料**；開同步（或登入）後兩邊會合併，否則要搬資料用匯出 / 匯入。
- Safari 可能清除長期未使用網站的儲存；加入主畫面、開同步、定期備份可降低風險。
- 同步是「最後寫入者勝」：同一筆資料兩台都改過，以 updatedAt 較新的為準，不做欄位級合併。
- KV 免費方案每日 1,000 次寫入（全部使用者共用，每次推送算一次）；超過約 20 個活躍使用者應改用 D1。
- 雲端資料為明文；登入者的資料 Worker 擁有者在 Cloudflare 後台看得到。
- 在 claude.ai 的預覽環境裡，瀏覽器下載會被擋，請改用「複製備份 JSON」；正式部署後「匯出」正常。
- 時區固定為設定值（預設 Asia/Taipei），人在國外時顯示仍是台北時間。

## 可能產生成本的環節

- 第一階段：**無**。沒有任何網路請求、沒有第三方服務。
- 第三階段（選用）：AI API 呼叫。使用 Max 方案附帶的 API 額度，額度用完 API 只會停止，不會扣款；程式永遠不會開啟 auto-reload 或購買額度。五道鎖：不綁卡 / 組織月上限 / workspace 月上限 / Worker 每人每日次數 / App 每日次數與 token 上限。Cloudflare Worker 免費方案每日 100,000 次請求，FlowPlan 用量遠低於此（以當期官方頁面為準）。
- 第四階段與多人登入：Cloudflare KV 免費方案（每日 100,000 次讀、1,000 次寫、1 GB）、Google / GitHub OAuth 應用程式註冊免費；別人用 AI 的費用算在你的額度。

## 使用手冊

見 `docs/USER_GUIDE.md`。
