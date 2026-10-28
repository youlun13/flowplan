import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface ToastItem {
  id: number;
  text: string;
  tone: 'info' | 'danger';
  action?: ToastAction;
}

interface ToastApi {
  /** 顯示提示；給 action 會多一顆按鈕（例如「復原」），並停留久一點 */
  show: (text: string, tone?: 'info' | 'danger', action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (text: string, tone: 'info' | 'danger' = 'info', action?: ToastAction) => {
      const id = ++seq.current;
      setItems((list) => [...list, { id, text, tone, action }]);
      window.setTimeout(() => dismiss(id), action ? 7000 : tone === 'danger' ? 4500 : 2200);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={
              'flex max-w-md items-center gap-3 rounded-lg py-2.5 pl-4 shadow-lg ' +
              (t.action ? 'pointer-events-auto pr-2 text-[15px] ' : 'pr-4 text-sm ') +
              (t.tone === 'danger' ? 'bg-danger text-white' : 'bg-ink text-bg')
            }
            data-testid="toast"
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="min-h-10 shrink-0 rounded-md bg-bg/15 px-3 text-[15px] font-semibold text-bg underline underline-offset-4 active:bg-bg/25"
                data-testid="toast-action"
                onClick={async () => {
                  dismiss(t.id);
                  await t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
