# FlowPlan — 動態節點式個人計畫系統

> 傳統計畫：預先決定每一步。FlowPlan：預先定義怎麼決定下一步。

本機優先（local-first）、手機優先、零額外付費的個人計畫 Web App。目前為 **第一階段（Phase 1）**：可日常使用的日曆、每日 TODO、實際紀錄、設定與備份，加上規則引擎的基礎（可用時段、硬性限制、簡易「下一步」）。

## 安裝與啟動

需求：Node.js 20 以上（開發時使用 22）。

```bash
npm install
npm run dev        # http://localhost:5173（--host 已開，手機可用區網 IP 開）
npm run build      # 型別檢查 + 產出 dist/
npm run preview    # 以正式建置檔啟動 http://localhost:4173
npm test           # Vitest 單元測試（41 個，涵蓋時區、重複展開、可用時段、依賴、下一步、資料層）
```

瀏覽器端驗收（需要 Python 版 Playwright 與 Chromium）：

```bash
npm run build && npm run preview -- --port 4173 &
python3 e2e/smoke.py http://localhost:4173/     # 12 項，對應驗收條件 1–4、10
```

## 技術架構

| 層 | 選擇 | 理由 |
|---|---|---|
| 前端 | Vite + React 19 + TypeScript + Tailwind CSS 4 | 純靜態輸出，任何免費靜態主機都能放；不需要 SSR |
| 資料 | IndexedDB（Dexie 4）+ Zod | 本機持久化；Zod schema 同時當 DB 寫入驗證、JSON 匯入驗證、第三階段 AI 輸出驗證 |
| 時間 | date-fns 4 + @date-fns/tz | 固定 App 時區（預設 Asia/Taipei），不看裝置時區 |
| 路由 | react-router（Hash） | 靜態主機不需要伺服器 rewrite |
| 測試 | Vitest + fake-indexeddb；Playwright（Python）做瀏覽器驗收 | 規則引擎是純函數，直接單元測試 |

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
  engine/nextStep.ts      「下一步」簡易版（進行中 > 截止風險 > 優先級 > 精力 > 延後次數）
  db/schema.ts         Zod 模型（Task, CalendarEvent, ActivityLog, DailyState, WorkBlock, PlanRevision, Settings, Backup）
  db/db.ts             Dexie 資料庫定義
  db/repo.ts           所有寫入（驗證後才寫）
  db/backup.ts         JSON 匯出 / 匯入
  db/seed.ts           示範資料（可一鍵刪除）
  components/          UI 元件、表單、時間軸
  features/            五個頁面：今日 / 日曆 / 任務 / 紀錄 / 設定
tests/                 Vitest
e2e/smoke.py           瀏覽器驗收
scripts/make-artifact-page.mjs   把 dist/index.html 轉成 claude.ai 預覽用片段（正式部署不需要）
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
| `WorkBlock`、`PlanRevision` | 第二階段用（表已建，尚未使用） |

完整定義見 `src/db/schema.ts`。

## 規則引擎（第一階段的部分）

| 規則 | 第一階段狀態 | 位置 / 測試 |
|---|---|---|
| 1 固定限制優先 | 已實作：可用時段永遠扣掉行程（含前後緩衝）與睡眠保護；跨午夜正確 | `availability.ts` / `tests/availability.test.ts` |
| 2 期限緊迫 | 簡易版：逾期 > 今天 > 48 小時內 | `nextStep.ts` |
| 3 優先級 | 簡易版 | `nextStep.ts` |
| 4 精力匹配 | 簡易版：低精力遇高負荷任務會警示但不跳過 | `nextStep.ts` |
| 7 反抖動 | 簡易版：進行中的任務永遠排第一 | `nextStep.ts` |
| 8 反飢餓 | 資料已記錄（`deferCount`），畫面顯示「延後 N 次」 | `repo.deferTask` |
| 10 人保有控制權 | 所有寫入都由使用者操作觸發；無自動修改 | — |
| 5、6、9、重排預覽 / 差異 / 撤銷 | **未實作**（第二階段） | — |

## 部署（全部為靜態檔，第一階段零費用）

**已設定自動部署**：push 到 `main` 會觸發 `.github/workflows/deploy.yml`，跑完測試與建置後部署到 GitHub Pages：

> https://youlun13.github.io/flowplan/

因為 `base: './'` 與 Hash 路由，放在子路徑也能正常運作。其他免費靜態主機（Cloudflare Pages、Vercel）同樣只需 `npm run build` 後上傳 `dist/`；請以當期官方頁面確認免費額度。

第三階段的 AI 代理需要一支伺服器端函式（Cloudflare Pages Functions 或 Vercel Functions）保管金鑰；到時再評估，任何需要付款資訊的步驟都會先列出等你確認。

## 環境變數

第一階段不需要任何環境變數。`.env.example` 只列出第三階段會用到的變數名稱（`ANTHROPIC_API_KEY`、`FLOWPLAN_PROXY_SECRET`、每日上限等），永遠不要把真正的金鑰寫進 repo 或前端。

## 第一階段：已實作 / 未實作 / 如何驗證

**已實作**

- 五格導覽（今日 / 日曆 / 任務 / 紀錄 / 設定），手機底部、桌機左側
- 任務 CRUD、勾選 / 取消、搜尋、狀態過濾、三種排序、依日期分組；完整欄位（截止、精力、可拆、最低工時、最低成果、依賴含循環檢查）
- 固定行程 CRUD、每週重複（星期、截止日、單次例外）、跨午夜行程、重疊警示
- 日曆月 / 週 / 日檢視；選日期即顯示該日行程與任務；日檢視為比例時間軸並顯示可用時段
- 今日總覽：完成率、精力狀態、「下一步」卡（含理由與警示）、開始 / 完成、逾期任務處理（排到今天 / 延到明天 / 編輯 / 取消）、今日行程、計畫 vs 實際時間軸
- 實際紀錄：開始 / 結束計時、補登、空白時段提示、分類摘要、綁定任務自動累計實際工時
- 設定：每日時段、睡眠保護、緩衝、專注長度、週起始日、決策偏好；AI 區塊存在但預設關閉
- JSON 匯出 / 匯入（取代或合併）、複製備份到剪貼簿、刪除示範資料、清除全部、備份提醒、`navigator.storage.persist()`
- PWA manifest 與圖示（可加入主畫面；離線快取為第四階段）
- 深色模式（跟隨系統）

**未實作（照規格排在後面的階段）**

- 第二階段：完整規則引擎、「我遇到狀況了」結構化表單、重排預覽 / 差異 / 套用 / 撤銷、工作區塊
- 第三階段：AI 自然語言解析與解說、provider adapter、代理與額度保護
- 第四階段：跨裝置同步、離線快取、統計、預估工時校正

**如何驗證**

- `npm test`：41 個單元測試，含驗收 1、2、3、8、13（跨午夜、夏令時間、空白 TODO、重疊）、14
- `python3 e2e/smoke.py`：真實 Chromium 操作，含驗收 1–4、10、示範資料刪除、備份匯出
- 驗收 5 的基礎（15:00–17:00 有課時可用時段不含該時段）已由 `availability.test.ts` 覆蓋；「重新規劃不把讀書排進去」要等第二階段的排程器
- 驗收 6、7、9、11 屬第二 / 三階段

## 已知限制

- 資料只存在這台裝置的這個瀏覽器。**iPhone 上 Safari 分頁與「加入主畫面」的 App 是兩份獨立資料**，請固定用同一個入口；要搬資料用匯出 / 匯入。
- Safari 可能清除長期未使用網站的儲存；加入主畫面並定期備份可降低風險。
- 沒有跨裝置同步（第四階段）。
- 在 claude.ai 的預覽環境裡，瀏覽器下載會被擋，請改用「複製備份 JSON」；正式部署後「匯出」正常。
- 時區固定為設定值（預設 Asia/Taipei），人在國外時顯示仍是台北時間。

## 可能產生成本的環節

- 第一階段：**無**。沒有任何網路請求、沒有第三方服務。
- 第三階段起：AI API 呼叫。設計上使用 Max 方案附帶的 API 額度，額度用完 API 只會停止，不會扣款；程式永遠不會開啟 auto-reload 或購買額度。

## 使用手冊

見 `docs/USER_GUIDE.md`。
