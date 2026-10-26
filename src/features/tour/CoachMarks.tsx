/**
 * 第一次使用的導覽：直接在真正的介面上，把要講的那個元件用聚光燈框起來，
 * 拉一條細線到旁邊的說明框。會自動切到對應的頁面。看完（或略過）記在設定裡。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, cx } from '@/components/ui';
import { updateSettings } from '@/db/repo';

interface Step {
  route: string;
  /** data-tour 的值；找不到就只顯示說明框 */
  target?: string;
  title: string;
  body: string;
}

export const TOUR_STEPS: Step[] = [
  { route: '/', target: 'next', title: '現在該做什麼', body: '打開 App 第一眼看這裡。它會從你今天的任務、行程、剩餘時間和精力，挑出現在最該做的一件。按「開始」就計時，做完打勾。' },
  { route: '/', target: 'energy', title: '先說你現在的精力', body: '高 / 中 / 低。精力低的時候，它會把需要高專注的事往後擺，先給你輕鬆的。' },
  { route: '/', target: 'plan-today', title: '任務加好後，一鍵排今天', body: '按一下就把今天剩下的任務排進可用的時間，整天的安排和缺點一起給你看。要不要套用你決定，套用後還能撤銷。' },
  { route: '/', target: 'incident', title: '狀況發生時按這裡', body: '睡過頭、臨時有事、很累、做超時……用一句話描述或選一種。它給你兩個選擇：「拚了」直接做最重要的，或「先喘口氣」休息一下再做輕鬆的。' },
  { route: '/', target: 'add-task', title: '從這裡加今天要做的事', body: '名稱、預估要多久就好；有截止時間或優先級再填。預估不準沒關係，做幾次之後會用實際時間幫你校正。' },
  { route: '/calendar', target: 'add-event', title: '固定行程放日曆', body: '上課、開會、社團這種動不了的時間放這裡，可以每週重複。排程時會自動避開，前後還留緩衝。' },
  { route: '/log', target: 'log', title: '紀錄實際做了什麼', body: '打一行、按開始，結束再按一下。週檢視會告訴你預估準不準、哪些事一直被延後。' },
  { route: '/', target: 'nav', title: '就這五個地方', body: '今日、日曆、任務、紀錄、設定。設定裡可以改可工作時段、登入同步、看使用說明。現在去加第一件今天要做的事吧。' },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8;
const CALLOUT_W = 340;
const GUTTER = 16;

function visibleTarget(name: string): HTMLElement | null {
  const els = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`));
  return els.find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }) ?? null;
}

export function CoachMarks({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [calloutH, setCalloutH] = useState(200);
  const navigate = useNavigate();
  const location = useLocation();
  const calloutRef = useRef<HTMLDivElement>(null);
  const step = TOUR_STEPS[i];
  const last = i === TOUR_STEPS.length - 1;

  // 切到該步驟的頁面
  useEffect(() => {
    if (location.pathname !== step.route) navigate(step.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // 找到目標、捲到看得見、量位置；視窗變動時重量
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const measure = () => {
      if (cancelled) return;
      const el = step.target ? visibleTarget(step.target) : null;
      if (!el) {
        if (tries++ < 20) {
          setTimeout(measure, 50);
          return;
        }
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.top < 80 || r.bottom > vh - 80) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        setTimeout(() => {
          if (cancelled) return;
          const r2 = el.getBoundingClientRect();
          setRect({ top: r2.top, left: r2.left, width: r2.width, height: r2.height });
        }, 60);
        return;
      }
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    setRect(null);
    setTimeout(measure, location.pathname === step.route ? 30 : 150);
    const onChange = () => measure();
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, location.pathname]);

  useLayoutEffect(() => {
    if (calloutRef.current) setCalloutH(calloutRef.current.offsetHeight);
  }, [i, rect]);

  async function finish() {
    await updateSettings({ tourDone: true });
    navigate('/');
    onDone();
  }

  const vw = typeof window !== 'undefined' ? window.innerWidth : 390;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const w = Math.min(CALLOUT_W, vw - GUTTER * 2);

  // 說明框放目標下方（空間夠）或上方；都不夠就置中
  let calloutTop: number;
  let placement: 'below' | 'above' | 'center' = 'center';
  if (rect) {
    const spaceBelow = vh - (rect.top + rect.height + PAD);
    const spaceAbove = rect.top - PAD;
    if (spaceBelow >= calloutH + 40) {
      placement = 'below';
      calloutTop = rect.top + rect.height + PAD + 28;
    } else if (spaceAbove >= calloutH + 40) {
      placement = 'above';
      calloutTop = rect.top - PAD - 28 - calloutH;
    } else {
      calloutTop = Math.max(GUTTER, (vh - calloutH) / 2);
    }
  } else {
    calloutTop = Math.max(GUTTER, (vh - calloutH) / 2);
  }
  const calloutLeft = Math.max(GUTTER, Math.min(vw - GUTTER - w, rect ? rect.left + rect.width / 2 - w / 2 : (vw - w) / 2));

  // 細線：從聚光燈邊緣中點，連到說明框邊緣
  const hole = rect ? { x: rect.left - PAD, y: rect.top - PAD, w: rect.width + PAD * 2, h: rect.height + PAD * 2 } : null;
  let line: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (hole && placement !== 'center') {
    const x = Math.min(Math.max(hole.x + hole.w / 2, calloutLeft + 24), calloutLeft + w - 24);
    line = placement === 'below' ? { x1: hole.x + hole.w / 2, y1: hole.y + hole.h, x2: x, y2: calloutTop } : { x1: hole.x + hole.w / 2, y1: hole.y, x2: x, y2: calloutTop + calloutH };
  }

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="導覽" data-testid="tour">
      <svg className="absolute inset-0 h-full w-full" width={vw} height={vh} aria-hidden="true">
        <defs>
          <mask id="tour-hole">
            <rect x="0" y="0" width={vw} height={vh} fill="white" />
            {hole && <rect x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx="14" fill="black" />}
          </mask>
        </defs>
        <rect x="0" y="0" width={vw} height={vh} fill="rgba(10,12,16,0.62)" mask="url(#tour-hole)" />
        {hole && <rect x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx="14" fill="none" stroke="var(--accent)" strokeWidth="2" data-testid="tour-spotlight" />}
        {line && (
          <>
            <line x1={line.x1} y1={line.y1} x2={line.x1} y2={(line.y1 + line.y2) / 2} stroke="var(--accent)" strokeWidth="1.5" />
            <line x1={line.x1} y1={(line.y1 + line.y2) / 2} x2={line.x2} y2={(line.y1 + line.y2) / 2} stroke="var(--accent)" strokeWidth="1.5" />
            <line x1={line.x2} y1={(line.y1 + line.y2) / 2} x2={line.x2} y2={line.y2} stroke="var(--accent)" strokeWidth="1.5" />
            <circle cx={line.x1} cy={line.y1} r="3.5" fill="var(--accent)" />
          </>
        )}
      </svg>

      <div ref={calloutRef} className="absolute rounded-2xl border border-accent/50 bg-surface p-4 shadow-xl" style={{ top: calloutTop, left: calloutLeft, width: w }} data-testid="tour-callout">
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5">
            {TOUR_STEPS.map((_, k) => (
              <span key={k} className={cx('h-1.5 rounded-full transition-all', k === i ? 'w-5 bg-accent' : 'w-1.5 bg-line')} />
            ))}
          </div>
          <button type="button" className="text-[15px] text-muted" onClick={finish} data-testid="tour-skip">
            略過
          </button>
        </div>
        <h2 className="mt-3 text-[19px] font-semibold leading-tight">{step.title}</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{step.body}</p>
        <div className="mt-4 flex gap-2">
          {i > 0 && (
            <Button className="min-h-11 shrink-0 whitespace-nowrap" onClick={() => setI(i - 1)}>
              上一步
            </Button>
          )}
          <Button variant="primary" full className="min-h-11 text-[16px]" onClick={() => (last ? finish() : setI(i + 1))} data-testid="tour-next">
            {last ? '開始使用' : '下一步'}
          </Button>
        </div>
      </div>
    </div>
  );
}
