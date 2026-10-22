/**
 * 第一次使用的導覽：幾張卡片講清楚五個頁面各做什麼，像一般 App 的 onboarding。
 * 不塞示範資料；看完（或略過）就記在設定裡，設定 → 使用說明可以再看一次。
 */
import { useState } from 'react';
import { CalendarDays, CheckSquare, History, LifeBuoy, Sun } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { updateSettings } from '@/db/repo';

const STEPS = [
  {
    icon: Sun,
    title: '今日：現在該做什麼',
    body: '打開 App 第一眼就是「下一步」：從你今天的任務、行程、剩餘時間和精力，挑出現在最該做的一件。按「開始」就計時，做完打勾。',
  },
  {
    icon: CheckSquare,
    title: '任務：先加幾件今天要做的事',
    body: '名稱、預估要多久、哪天做；有截止時間或優先級就填，沒有也沒關係。預估不準沒差——做幾次之後 FlowPlan 會用實際時間幫你校正。',
  },
  {
    icon: CalendarDays,
    title: '日曆：固定的行程',
    body: '上課、開會、社團這種動不了的時間放這裡，可以每週重複。排程時會自動避開，前後還會留緩衝。',
  },
  {
    icon: LifeBuoy,
    title: '狀況發生時：按「我遇到狀況了」',
    body: '睡過頭、臨時有事、很累、做超時……用一句話描述或選一種。它會給你兩個選擇：「拚了」直接做最重要的，或「先喘口氣」休息一下再做輕鬆的。選一個就好，隨時能撤銷。',
  },
  {
    icon: History,
    title: '紀錄：實際做了什麼',
    body: '從幾點到幾點做了什麼，開始 / 結束一按就好。週檢視會告訴你預估準不準、哪些事一直被延後。',
  },
];

export function TourSheet({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const Icon = step.icon;
  const last = i === STEPS.length - 1;

  async function finish() {
    await updateSettings({ tourDone: true });
    onDone();
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/40 md:items-center" role="dialog" aria-modal="true" aria-label="導覽" data-testid="tour">
      <div className="safe-bottom w-full max-w-md rounded-t-2xl bg-surface px-6 pb-6 pt-6 md:rounded-2xl">
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, k) => (
              <span key={k} className={cx('h-1.5 rounded-full transition-all', k === i ? 'w-6 bg-accent' : 'w-1.5 bg-line')} />
            ))}
          </div>
          <button type="button" className="text-[15px] text-muted" onClick={finish} data-testid="tour-skip">
            略過
          </button>
        </div>
        <div className="mt-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Icon size={32} />
        </div>
        <h2 className="mt-4 text-[22px] font-semibold leading-tight">{step.title}</h2>
        <p className="mt-2 min-h-[6.5rem] text-[16px] leading-relaxed text-muted">{step.body}</p>
        <div className="mt-6 flex gap-2">
          {i > 0 && (
            <Button className="min-h-12" onClick={() => setI(i - 1)}>
              上一步
            </Button>
          )}
          <Button variant="primary" full className="min-h-12 text-[17px]" onClick={() => (last ? finish() : setI(i + 1))} data-testid="tour-next">
            {last ? '開始使用' : '下一步'}
          </Button>
        </div>
      </div>
    </div>
  );
}
