import { Sheet } from '@/components/ui';

interface Topic {
  title: string;
  items: string[];
}

/** 使用說明（與 docs/USER_GUIDE.md 同步維護） */
const TOPICS: Topic[] = [
  {
    title: '第一次使用',
    items: [
      '示範資料的標題都有「（示範）」，看懂每個區塊後到「設定 → 刪除示範資料」一鍵清掉。',
      'iPhone：Safari 開啟後「分享 → 加入主畫面」，之後固定從主畫面開。Safari 分頁與主畫面 App 是兩份獨立資料。',
      '先到「設定」把可工作時段、睡眠保護、行程前後緩衝改成你的實際習慣，這些決定「可用時間」怎麼算。',
    ],
  },
  {
    title: '每天怎麼用',
    items: [
      '早上：開「今日」，切換精力；處理「逾期未處理」（排到今天 / 延到明天 / 編輯 / 取消），它們不會自己消失；按「規劃今天」看排程再套用。',
      '白天：做完就按「完成」或勾選；換一件事到「紀錄」輸入後按「開始」，上一筆會自動結束；臨時有事就按「我遇到狀況了」。',
      '晚上：到「紀錄」看空白時段補登；到「任務」把明天要做的事設好「哪天做」。',
    ],
  },
  {
    title: '下一步卡片',
    items: [
      '還沒排程時顯示「建議」：只依進行中、截止、優先級、精力給一個答案。',
      '按「規劃今天」或回報狀況並套用後，卡片變成「已套用的排程」，顯示區塊時間與理由；時間軸左欄出現綠色區塊。',
      '「開始」會同時開始一筆實際紀錄；「跳過」只跳過這個區塊，任務還在。',
    ],
  },
  {
    title: '我遇到狀況了',
    items: [
      '可以先用一句話描述（例如「我睡到十一點」「下午三點到五點臨時有事」「線代習題寫完了」），按「解析」會先用內建規則理解；看不懂才會呼叫 AI（需在設定開啟）。理解結果會先給你確認，不會自動套用。',
      '也可以直接選一種狀況：睡過頭、臨時有事（套用後會加進日曆）、精力變化、提早完成、超時、需要休息、單純重排。',
      '預覽會列出：建議的下一步、變更前後對照、套用後完整排程、排不下的任務與原因、規則引擎的判斷過程。',
      '預覽不改任何資料；「保留原計畫」什麼都不會動；套用後可按「撤銷」回到套用前（含加進去的行程與標記完成的任務）。',
      '規則固定不變：固定行程與睡眠永遠優先 → 截止風險 → 優先級 → 精力匹配 → 排不下就改排最低版本 → 還是排不下就明確列出，不會假裝排得下。',
    ],
  },
  {
    title: '任務欄位',
    items: [
      '哪天做：想排進某一天才填；不填會進「未排日期」。',
      '優先級：高＝不做會出事；中＝應該做；低＝有空再做。',
      '截止時間：只填真正的死線，系統用它算緊迫度。',
      '最低工時 / 最低成果：時間不夠時引擎會改排這個版本，所以寫具體一點，例如「做完前 5 題」。',
      '可以拆成多段：打開後引擎會依「一次專注」的長度切段、段間留休息。',
      '要先完成的任務：前置沒完成，這個任務不會被安排也不會出現在下一步。',
    ],
  },
  {
    title: '固定行程',
    items: [
      '每週的課：新增時打開「每週重複」，勾星期幾，填「重複到」學期結束日。',
      '某一週停課：點那一次 → 「刪這一次」，其他週不受影響。修改重複行程會套用到整個系列。',
      '日曆的「日」檢視會畫出可用時段；點空白時段可直接新增行程。',
    ],
  },
  {
    title: '紀錄',
    items: [
      '「開始」是計時；「補登」是事後填幾點到幾點做了什麼；空白時段會提示，點一下就能補。',
      '綁定任務的紀錄會自動累計到任務的實際工時，之後重排會用剩餘工時計算。',
    ],
  },
  {
    title: 'AI 助手（選用）',
    items: [
      '關閉時一切照常。開啟後，只有規則看不懂的句子才會送到你自己的 Cloudflare Worker，再由 Worker 呼叫 Claude；瀏覽器永遠拿不到 API key。',
      '送出的內容只有：你那句描述、現在時刻、今天的任務標題與行程時間。不含備註、紀錄或其他天的資料。',
      'AI 的回答一律經過結構驗證與任務 id 核對；指到不存在或已完成的任務會被拒絕並告訴你。',
      '設定頁會顯示今天的請求次數與估計費用；真正的硬上限在 Anthropic Console 的 workspace spend limit。',
    ],
  },
  {
    title: '登入與多人使用（選用）',
    items: [
      '設定 → 帳號 → 「用 Google 登入」。登入後 AI 助手與跨裝置同步都不需要通關密語，資料存在你自己的帳號空間，別人看不到。',
      '只有 Worker 擁有者加進允許清單的 email 能登入；不在清單會看到「不在允許清單」，請擁有者在 Cloudflare 的 ALLOWED_USERS 加上你的 email。',
      '登入有效 60 天，期間用 App 會自動延長。到期或擁有者換密鑰時會提示重新登入，本機資料不受影響。',
      '同一台裝置換帳號登入時，會先問要不要清除本機資料，避免把別人的資料推進你的空間。借用別人的裝置請用「登出並清除此裝置資料」。',
      '主畫面的 FlowPlan 登入時若停在瀏覽器畫面，登入頁會給一段「登入碼」，回 App → 設定 → 帳號 → 貼上即可。',
    ],
  },
  {
    title: '備份與資料',
    items: [
      '資料只存在這台裝置的這個瀏覽器。清除瀏覽器資料會全部不見，請定期「匯出 JSON 備份」。',
      '換裝置或從 Safari 搬到主畫面 App：匯出後在另一邊「匯入 JSON（取代）」。',
      '超過設定天數沒備份，「今日」頁會提醒。',
    ],
  },
];

export function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="使用說明">
      <div className="space-y-2">
        {TOPICS.map((t, i) => (
          <details key={t.title} open={i === 0} className="group rounded-xl border border-line bg-surface">
            <summary className="cursor-pointer list-none px-3 py-2.5 text-[15px] font-semibold marker:content-none">
              {t.title}
              <span className="float-right text-muted transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <ul className="space-y-2 border-t border-line px-3 py-2.5 text-sm leading-relaxed">
              {t.items.map((line) => (
                <li key={line} className="flex gap-2">
                  <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-muted" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
        <p className="pt-1 text-xs text-muted">完整版在專案的 docs/USER_GUIDE.md。</p>
      </div>
    </Sheet>
  );
}
