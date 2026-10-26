import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ---------------------------------- Button ---------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  full,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; full?: boolean }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 min-h-11 text-[15px] font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none select-none';
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-accent-ink active:opacity-90',
    secondary: 'bg-surface border border-line text-ink active:bg-surface-2',
    ghost: 'text-ink/80 active:bg-surface-2',
    danger: 'bg-danger-soft text-danger active:opacity-90',
  };
  return <button type={type} className={cx(base, styles[variant], full && 'w-full', className)} {...rest} />;
}

/* ----------------------------------- Chip ----------------------------------- */

export function Chip({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'hard' | 'warn' | 'danger' | 'done';
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    accent: 'bg-accent-soft text-accent',
    hard: 'bg-hard-soft text-hard',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
    done: 'bg-surface-2 text-done',
  };
  return <span className={cx('inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium leading-4', tones[tone], className)}>{children}</span>;
}

/* ---------------------------------- Field ----------------------------------- */

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 min-h-11 text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

/**
 * 數字欄位：輸入中以文字保存，所以可以清空、可以刪掉開頭的 0；
 * 只在內容是合法數字時才回報給外面；失焦時若不合法就還原成目前的值。
 * （直接用 value={number} 的話，清空會變成 0，再打 120 就成了「0120」且刪不掉。）
 */
export function NumberInput({ value, onChange, min, max, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const parse = (t: string): number | null => {
    if (!/^\d+$/.test(t.trim())) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    if (min !== undefined && n < min) return null;
    if (max !== undefined && n > max) return null;
    return n;
  };
  return (
    <input
      {...rest}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        const n = parse(text);
        if (n === null) setText(String(value));
        else if (String(n) !== text) setText(String(n)); // 去掉開頭的 0
        rest.onBlur?.(e);
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const n = parse(t);
        if (n !== null) onChange(n);
      }}
      className={cx(inputClass, rest.className)}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputClass, 'py-2.5 min-h-20 resize-y', props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, 'appearance-none pr-8', props.className)} />;
}

/* ------------------------------ Segmented control ------------------------------ */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cx('inline-flex rounded-lg bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-md font-medium transition-colors whitespace-nowrap',
            size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-3 py-2 text-[15px] min-h-10',
            o.value === value ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Toggle --------------------------------- */

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 py-2 text-left">
      <span className="text-[15px]">{label}</span>
      <span className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
      </span>
    </button>
  );
}

/* ---------------------------------- Sheet ----------------------------------- */

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="關閉" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-surface md:max-w-lg md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="關閉" className="-mr-2 rounded-full p-2 text-muted active:bg-surface-2">
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="safe-bottom border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* --------------------------------- Confirm --------------------------------- */

export function Confirm({
  open,
  title,
  message,
  confirmLabel = '確定',
  danger,
  onConfirm,
  onCancel,
  extra,
}: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" role="alertdialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="取消" className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative w-full max-w-sm rounded-2xl bg-surface p-5">
        <h3 className="text-base font-semibold">{title}</h3>
        {message && <div className="mt-2 text-sm text-muted">{message}</div>}
        {extra && <div className="mt-3">{extra}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Empty state -------------------------------- */

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="text-[15px] text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* --------------------------------- Section --------------------------------- */

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mt-6', className)}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {aside && <div className="text-sm text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
