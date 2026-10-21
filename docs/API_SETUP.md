# API 設定教學（第三階段：AI 助手）

FlowPlan 的核心功能不需要 AI。這份教學只在你想啟用「用一句話描述狀況」時才需要做。

整體架構（零額外付費）：

```
iPhone / 電腦瀏覽器（GitHub Pages 上的 FlowPlan）
        │  HTTPS + 通關密語
        ▼
Cloudflare Worker（免費方案，保管 Anthropic API key）
        │  HTTPS + API key
        ▼
Anthropic Claude API（用 Max 方案每月附帶的 US$100 額度）
```

金鑰只存在 Worker 的 Secret 裡，瀏覽器永遠看不到；瀏覽器只持有一組「通關密語」，用來避免陌生人透過你的 Worker 燒額度。

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
   每台裝置：設定 → 跨裝置同步 → 啟用 → 儲存設定。第一台會把本機全部資料推上去；第二台啟用後按「立即同步」就會拉下來。
   按「檢查雲端」可看雲端版本與筆數。

**怎麼運作**：每筆資料帶 `updatedAt`，同一筆兩邊都改過時以較新的為準；刪除會以 tombstone 傳到另一台。本機尚未推送的變更不會被雲端覆蓋。有變更後約 4 秒自動推送，回到前景、重新上線、以及每 90 秒拉取一次。

**注意**：資料以明文存在你的 KV（只有知道通關密語的人能讀）。KV 免費方案每日 1,000 次寫入 / 100,000 次讀取，FlowPlan 一天通常幾十次寫入。想清掉雲端：設定 → 進階 → 刪除雲端資料。

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
