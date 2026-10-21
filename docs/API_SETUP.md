# API 設定教學（AI 助手、跨裝置同步、多人登入）

FlowPlan 的核心功能不需要任何伺服器。這份教學只在你想要 AI 助手（Part A、B）、跨裝置同步（Part C）、或讓別人用自己的帳號登入（Part D、E）時才需要做。

整體架構（零額外付費）：

```
iPhone / 電腦瀏覽器（GitHub Pages 上的 FlowPlan）
        │  HTTPS + 通關密語（單人）或 Google/GitHub 登入 session（多人）
        ▼
Cloudflare Worker（免費方案）
   ├─ 保管 Anthropic API key ──HTTPS + API key──▶ Anthropic Claude API（Max 方案每月附帶的 US$100 額度）
   ├─ Cloudflare KV（免費）：每個帳號一塊同步空間
   └─ Google / GitHub 登入（OAuth；Client Secret 只在 Worker）
```

金鑰與 OAuth Client Secret 只存在 Worker 的 Secret 裡，瀏覽器永遠看不到；瀏覽器只持有「通關密語」或「登入 session」。

| 模式 | 誰用 | 瀏覽器持有 | 資料空間 |
|---|---|---|---|
| 單人（通關密語） | 只有你 | 你自己填的密語 | KV `snapshot` |
| 多人（登入） | 你和你允許的人 | Google / GitHub 登入後 Worker 簽的 session（60 天） | 每人一塊 `u:<帳號>:snapshot` |

兩種模式可以同時開著；你自己也可以改用登入。

## 零扣費的四道鎖

| 鎖 | 在哪裡設 | 作用 |
|---|---|---|
| 不綁卡、不開自動儲值 | Console Billing | 額度用完 API 直接停止，不會扣款 |
| 組織每月上限 | Console Billing → Spend limits | 總保險絲（建議 US$30） |
| Workspace 每月上限 + 警報 | Console Workspaces → FlowPlan → Spend limits | 真正的硬上限（建議 US$15，50% 警報） |
| App 每日請求上限 + 單次 token 上限 | FlowPlan 設定 → AI 助手 | 輔助保護，不是對帳單的保證 |

## Part A：Anthropic 端（現在就可以做）

前提：Max 5x 已生效滿 7 天；用瀏覽器操作，不要在 Claude App 內操作。

1. **登入 Console、建立組織**
   開 https://platform.claude.com ，用訂 Max 的同一個帳號登入。若要求建立 organization，取名例如 `AIXXL Personal`。不需要綁信用卡。
2. **在 claude.ai 連結組織、領取額度**
   開 https://claude.ai → Settings → Billing → 「API credits」區塊 → 選剛才的組織 → 接受條款 → Link。
   一個方案只能綁一個組織，綁定後自己不能改（要改得找客服）。看不到區塊代表未滿 7 天或不符資格。
3. **確認到帳、設組織上限**
   https://platform.claude.com/settings/billing ：「Promotional credits」應顯示 US$100 與到期日（每個計費週期刷新，用不完不累積）。
   同頁「Spend limits」→ Set limit → 30。若看到 Auto-reload / Add credits，不要開、不要買。
4. **建立 workspace**
   https://platform.claude.com/settings/workspaces → Create workspace → 名稱 `FlowPlan` → Create workspace。
5. **設 workspace 上限與警報**
   點 FlowPlan → Spend limits → 月上限 15、警報 50%。Default Workspace 不能設上限，所以才建新的。
6. **建立 API key**
   https://platform.claude.com/settings/keys → Create key：
   - Name：`flowplan-worker`
   - Expiration：Never（或自訂 1 年）
   - Linked account：Yourself
   - Workspace：FlowPlan
   建立後立刻複製到密碼管理器；關掉畫面就看不到了。
7. **key 的規則**
   只貼到 Cloudflare Worker 的 Secret。不貼到 GitHub、App、聊天視窗。外洩就到 API keys 頁 Disable / Delete，再建新的。
8. **看一眼 Rate limits**
   https://platform.claude.com/usage/limits ：tier 至少 Start（每分鐘 1,000 次請求），對 FlowPlan 綽綽有餘。

## Part B：Cloudflare Worker（第三階段程式完成後做）

> 以下步驟對應 repo 的 `worker/` 目錄；程式完成時會再附上最終版。

1. **建立 Cloudflare 帳號**
   https://dash.cloudflare.com/sign-up ，免費方案，不需要信用卡。
2. **建立 Worker**
   左側 Workers & Pages → Create → Create Worker → 名稱 `flowplan-ai` → Deploy（先部署預設的 Hello World）。
3. **貼上程式碼**
   點進 flowplan-ai → Edit code → 把 `worker/src/index.js` 的內容整個貼上 → Deploy。
4. **設定 Secrets 與變數**
   flowplan-ai → Settings → Variables and Secrets → Add：
   - `ANTHROPIC_API_KEY`（Secret）：Part A 第 6 步的 key
   - `FLOWPLAN_PROXY_SECRET`（Secret）：自己想一組長密語（例如 20 個字以上），之後要填進 App
   - `ALLOWED_ORIGINS`（Text）：`https://youlun13.github.io`（本機測試時再加 `,http://localhost:5173`）
   - `AI_MODEL`（Text）：`claude-haiku-5-5`
   - `AI_MAX_OUTPUT_TOKENS`（Text）：`1024`
   每次改完按 Deploy。
5. **取得 Worker 網址**
   flowplan-ai 概覽頁會顯示 `https://flowplan-ai.<你的子網域>.workers.dev`。
6. **填進 App**
   FlowPlan → 設定 → AI 助手：打開「啟用」、供應商 Claude、Worker 網址、通關密語、模型、每日上限 → 儲存 → 「測試連線」。

## Part C：跨裝置同步（Cloudflare KV，免費）

同步用的是同一個 Worker 與同一組通關密語，資料存在你自己的 Cloudflare KV。做一次就好：

1. **建立 KV namespace**
   Cloudflare dashboard 左側 → Storage & Databases → KV → Create namespace → 名稱 `flowplan-sync` → Create。
2. **綁定到 Worker**
   Workers & Pages → flowplan-ai → Settings → Bindings → Add binding → 類型 KV namespace：
   - Variable name：`FLOWPLAN_KV`（一定要這個名字）
   - KV namespace：選 `flowplan-sync`
   → Save / Deploy。
3. **更新 Worker 程式碼**
   flowplan-ai → Edit code → 把 repo 的 `worker/src/index.js` 最新版整個貼上（第四階段起含同步端點）→ Deploy。
4. **在 App 啟用**
   單人模式：每台裝置：設定 → 跨裝置同步 → 啟用 → 儲存設定。第一台會把本機全部資料推上去；第二台啟用後按「立即同步」就會拉下來。
   多人模式：登入時會自動開啟同步（見 Part D）。
   按「檢查雲端」可看雲端版本與筆數。

**怎麼運作**：每筆資料帶 `updatedAt`，同一筆兩邊都改過時以較新的為準；刪除會以 tombstone 傳到另一台。本機尚未推送的變更不會被雲端覆蓋。有變更後約 4 秒自動推送，回到前景、重新上線、以及每 90 秒拉取一次。

**注意**：資料以明文存在你的 KV（只有知道通關密語或登入的人能讀自己的空間）。KV 免費方案每日 1,000 次寫入 / 100,000 次讀取，FlowPlan 每人一天通常幾十次寫入；兩三個人用綽綽有餘。想清掉雲端：設定 → 進階 → 刪除雲端資料（只刪自己的空間）。

## Part D：Google 登入（多人模式）

做完這段，你允許的人打開 FlowPlan → 設定 → 帳號 → 「用 Google 登入」，就有自己的同步空間，AI 也能用（費用算在你的額度）。全部免費、不需要信用卡；Google 這邊只用「基本資料」權限（email、名字），不需要送審。

### D-1 在 Google Cloud 建立 OAuth 用戶端（一次就好，約 10 分鐘）

1. **開 Google Cloud Console**：https://console.cloud.google.com ，用你的 Google 帳號登入。第一次會要你同意服務條款；不需要啟用計費。
2. **建立專案**：上方「選取專案」→「新增專案」→ 名稱 `FlowPlan` → 建立，然後切換到這個專案。
3. **開 Google Auth Platform（OAuth 同意畫面）**：左側選單「API 和服務」→「OAuth 同意畫面」（或在上方搜尋列打 `OAuth`）。新專案會顯示「尚未設定」→ 按「開始使用 / Get started」。
4. **填四個區塊**：
   - 應用程式資訊：名稱 `FlowPlan`、使用者支援電子郵件選你自己。
   - 目標對象（Audience）：選「外部 / External」（只有 Google Workspace 公司帳號才需要內部）。
   - 聯絡資訊：你的 email。
   - 同意政策 → 建立。
5. **加測試使用者**：左側「目標對象 / Audience」→「測試使用者」→「新增使用者」→ 把會登入的 Google 帳號 email 都加進去（含你自己）。
   App 在「測試中」狀態時，只有這份名單的人能登入，最多 100 人；這對我們來說剛好是第二道門。
   （之後若想免維護這份名單，同一頁按「發布應用程式」即可；只用 email/profile 權限不需要 Google 審核。）
6. **建立用戶端**：左側「用戶端 / Clients」→「建立用戶端 / Create client」：
   - 應用程式類型：**網頁應用程式**
   - 名稱：`flowplan-worker`
   - 「已授權的 JavaScript 來源」：留空
   - 「已授權的重新導向 URI」→ 新增：`https://flowplan-ai.allen-youlun.workers.dev/auth/google/callback`
     （就是你的 Worker 網址 + `/auth/google/callback`；一個字都不能差，含 https 與結尾沒有斜線）
   - 建立。
7. **複製用戶端 ID 與用戶端密碼**：畫面會跳出「已建立 OAuth 用戶端」，把「用戶端 ID」（`xxxx.apps.googleusercontent.com`）和「用戶端密碼」（`GOCSPX-…`）存進密碼管理器。密碼關掉視窗就不再顯示（可在用戶端頁重新產生）。
   和 Anthropic 金鑰一樣：**只貼到 Cloudflare Worker 的 Secret**，不貼到 GitHub、App 或聊天視窗。

### D-2 Worker 加設定

Cloudflare → Workers & Pages → flowplan-ai → Settings → Variables and Secrets → Add：

| 名稱 | 類型 | 值 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Secret | D-1 第 7 步的用戶端 ID |
| `GOOGLE_CLIENT_SECRET` | Secret | D-1 第 7 步的用戶端密碼 |
| `ALLOWED_USERS` | Text | 允許登入的 email，逗號分隔，例如 `you@gmail.com, friend@gmail.com` |
| `FLOWPLAN_SESSION_SECRET` | Secret | 隨便一組長亂碼（20 字以上）；用來簽登入 session。沒設會退回用 `FLOWPLAN_PROXY_SECRET`，但分開設比較好：之後想讓所有人重新登入，只要換這個 |
| `AI_DAILY_LIMIT_PER_USER` | Text | 每人每天最多幾次 AI（預設 60；要綁 KV 才會計數） |

每次改完按 Deploy。然後：

8. **貼最新版 Worker 程式**：Edit code → 整個換成 repo 的 `worker/src/index.js` → Deploy。
9. **確認**：瀏覽器直接開 `https://flowplan-ai.allen-youlun.workers.dev/auth/providers`，應該看到 `"providers":[{"id":"google","label":"Google"}]`。若是 `[]`，代表 `ALLOWED_USERS` 空的或 Google 的兩個 Secret 沒設好。

### D-3（可選）GitHub 登入

給沒有 Google 帳號、但有 GitHub 的人。https://github.com/settings/developers → OAuth Apps → New OAuth App：
- Application name `FlowPlan`、Homepage URL `https://youlun13.github.io/flowplan/`
- Authorization callback URL：`https://flowplan-ai.allen-youlun.workers.dev/auth/github/callback`
- Register → Generate a new client secret → 把 Client ID 與 secret 設成 Worker 的 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`（Secret）。
登入者的 GitHub 帳號必須有已驗證的 email，而且那個 email 要在 `ALLOWED_USERS` 裡。

### 登入怎麼運作（給想知道的人）

1. App 跳到 Worker `/auth/google/start`，Worker 簽一個 10 分鐘的 state 後把人送去 Google。
2. Google 問「要用哪個帳號登入 FlowPlan？」，同意後帶著一次性的授權碼回 Worker `/auth/google/callback`。
3. Worker 用 Client Secret 跟 Google 換 token、查 email（必須已驗證）、對 `ALLOWED_USERS`，通過就簽一個 60 天的 session（HMAC-SHA256），把人送回 App。
4. App 用 session 問 Worker `/auth/me` 確認後才存起來（只在這台裝置的 localStorage，不備份、不同步）。之後 AI 與同步都帶這個 session。
5. 每次請求 Worker 都重查 `ALLOWED_USERS`：把 email 移出清單，那個人立刻失效；換 `FLOWPLAN_SESSION_SECRET`，所有人要重新登入。

## Part E：邀請別人用

1. 把對方的 Google email 加進 Worker 的 `ALLOWED_USERS`（和 Google Cloud 的測試使用者，若 App 還在測試中）→ Deploy。
2. 傳給對方：`https://youlun13.github.io/flowplan/` 。Worker 網址已經內建在正式版裡（`.github/workflows/deploy.yml` 的 `VITE_FLOWPLAN_PROXY_URL`），對方不用填。
3. 對方：設定 → 帳號 → 「用 Google 登入」→ 選帳號 → 回到 App 看到「已用 xxx 登入」。
4. 登入後資料怎麼走（目標：不管哪台裝置，登入就是原本的）：
   - 這個帳號第一次用（雲端空的）：這台裝置的資料（含示範資料）整包推上雲端，之後以它為本尊。
   - 另一台裝置再登入（雲端已有資料）：那台若只有示範資料，示範資料直接清掉、設定也採雲端的，一登入就是原本的；那台若已有自己的資料，則與雲端合併。
   - 示範資料不想要：設定 → 資料 → 「刪除示範資料」，會同步刪到所有裝置。
5. 想停掉某個人：從 `ALLOWED_USERS` 拿掉 → Deploy；對方下次操作會看到「不在允許清單」，本機資料仍在，但不再同步也不能用 AI。想連雲端資料一起清：Cloudflare → KV → flowplan-sync → 刪掉 `u:google:<id>:snapshot` 那把 key。

費用：每個人用 AI 都算在你的 Anthropic 額度；Haiku 5.5 一次解析約 US$0.001，一個人一天 20 次、一個月不到 US$1。Worker 的 `AI_DAILY_LIMIT_PER_USER` 與 Anthropic workspace 的 spend limit 仍是硬上限。

## 用量與費用怎麼看

- Console：https://platform.claude.com/cost （按 workspace 篩選 FlowPlan）。
- App：設定 → AI 助手會顯示今天的請求次數、token 與估計費用（以模型定價換算，僅供參考）。
- 預估：Haiku 5.5 一次狀況解析約 US$0.001；一天 20 次、一個月不到 US$1。Sonnet 5.5 約 20 倍。

## 沒有 Claude 額度時

App 會自動降級，核心功能不受影響：

1. Claude（Worker）失敗或額度耗盡 → 顯示橫幅
2. 其他免費供應商（之後透過同一個 Worker 切換）
3. 規則式中文快速解析（「睡到 11 點」「少了兩小時」「很累」「XX 做完了」「臨時三點到五點有事」）
4. 結構化狀況表單（永遠可用）
