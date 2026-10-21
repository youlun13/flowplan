import { NavLink, Outlet } from 'react-router-dom';
import { CalendarDays, CircleCheckBig, History, Settings, Sun } from 'lucide-react';
import { cx } from './ui';

const NAV = [
  { to: '/', label: '今日', Icon: Sun, end: true },
  { to: '/calendar', label: '日曆', Icon: CalendarDays },
  { to: '/tasks', label: '任務', Icon: CircleCheckBig },
  { to: '/log', label: '紀錄', Icon: History },
  { to: '/settings', label: '設定', Icon: Settings },
];

export function AppShell() {
  return (
    <div className="min-h-dvh md:flex">
      {/* 桌機：左側導覽列 */}
      <nav className="safe-top hidden w-20 shrink-0 border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:items-center md:gap-1 md:pt-5" aria-label="主選單">
        <div className="mb-4 text-sm font-semibold text-accent">FlowPlan</div>
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx('flex w-16 flex-col items-center gap-1 rounded-lg py-2 text-xs', isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2')
            }
          >
            <Icon size={22} strokeWidth={1.9} />
            {label}
          </NavLink>
        ))}
      </nav>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-3 md:px-8 md:pb-10 md:pt-6">
        <Outlet />
      </main>

      {/* 手機：底部導覽 */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur md:hidden" aria-label="主選單">
        <div className="mx-auto flex max-w-3xl">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cx('flex flex-1 flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] font-medium', isActive ? 'text-accent' : 'text-muted')}
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} strokeWidth={isActive ? 2.3 : 1.8} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function PageHeader({ title, aside, sub }: { title: React.ReactNode; aside?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <header className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight">{title}</h1>
        {sub && <div className="mt-0.5 text-sm text-muted">{sub}</div>}
      </div>
      {aside}
    </header>
  );
}
