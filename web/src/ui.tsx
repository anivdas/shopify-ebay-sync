import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------- Router ----------------
const RouterCtx = createContext<{ path: string; navigate: (to: string) => void }>({ path: '/', navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const onPop = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    history.pushState(null, '', to);
    setPath(to);
    window.scrollTo({ top: 0 });
  }, []);
  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>;
}

export const useRouter = () => useContext(RouterCtx);

export function Link({ to, className, children, onClick }: { to: string; className?: string; children: ReactNode; onClick?: () => void }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------------- Toasts ----------------
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="card animate-in pointer-events-auto flex items-start gap-3 p-3.5 shadow-lg dark:bg-zinc-900">
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : t.kind === 'error' ? <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-brand-500" />}
            <p className="text-sm">{t.text}</p>
            <button className="ml-auto text-zinc-400 hover:text-zinc-600" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action with loading state + success/error toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast('success', typeof success === 'function' ? success(r) : success);
        return r;
      } catch (e) {
        toast('error', (e as Error).message);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------------- Primitives ----------------
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin', className)} />;
}

export function Button({
  variant = 'secondary',
  loading,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean }) {
  return (
    <button className={cx(`btn-${variant}`, className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300',
  red: 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300',
  amber: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300',
  blue: 'bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300',
  violet: 'bg-brand-500/10 text-brand-700 ring-brand-500/20 dark:text-brand-300',
  gray: 'bg-zinc-500/10 text-zinc-600 ring-zinc-500/20 dark:text-zinc-300',
};

export function Badge({ color = 'gray', children, className, title }: { color?: keyof typeof BADGE; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset', BADGE[color], className)}>
      {children}
    </span>
  );
}

export const STATUS: Record<string, { label: string; color: keyof typeof BADGE }> = {
  draft: { label: 'Draft', color: 'gray' },
  published: { label: 'Live', color: 'green' },
  out_of_stock: { label: 'Out of stock', color: 'amber' },
  paused: { label: 'Paused (rule)', color: 'amber' },
  ended: { label: 'Ended', color: 'gray' },
  error: { label: 'Error', color: 'red' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, color: 'gray' as const };
  return (
    <Badge color={s.color}>
      <span className={cx('size-1.5 rounded-full', s.color === 'green' ? 'bg-emerald-500' : s.color === 'amber' ? 'bg-amber-500' : s.color === 'red' ? 'bg-rose-500' : 'bg-zinc-400')} />
      {s.label}
    </Badge>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3', disabled && 'cursor-not-allowed opacity-60')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-brand-500' : 'bg-zinc-300 dark:bg-white/15')}
      >
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition', checked && 'translate-x-4')} />
      </button>
      {(label || description) && (
        <span>
          {label && <span className="block text-sm font-medium">{label}</span>}
          {description && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4 dark:border-white/[0.06]">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 rounded-2xl bg-brand-500/10 p-3 text-brand-500">{icon}</div>}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Callout({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'error' | 'success'; title?: ReactNode; children?: ReactNode }) {
  const styles = {
    info: 'border-sky-500/20 bg-sky-500/[0.06] text-sky-900 dark:text-sky-200',
    warn: 'border-amber-500/25 bg-amber-500/[0.07] text-amber-900 dark:text-amber-200',
    error: 'border-rose-500/25 bg-rose-500/[0.07] text-rose-900 dark:text-rose-200',
    success: 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-900 dark:text-emerald-200',
  }[kind];
  const Icon = kind === 'warn' ? AlertTriangle : kind === 'error' ? XCircle : kind === 'success' ? CheckCircle2 : Info;
  return (
    <div className={cx('flex gap-3 rounded-xl border p-3.5 text-sm', styles)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-sm" onClick={onClose} />
      <div className={cx('card animate-in relative flex max-h-[90vh] w-full flex-col shadow-2xl dark:bg-zinc-900', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-white/[0.06]">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost -mr-2 p-1.5">
            <X className="size-4" />
          </button>
        </header>
        <div className="scrollbar-thin overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3.5 dark:border-white/[0.06]">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="animate-slide absolute top-0 right-0 flex h-full w-full max-w-2xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-white/10 dark:bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-white/[0.06]">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost -mr-2 p-1.5">
            <X className="size-4" />
          </button>
        </header>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3.5 dark:border-white/[0.06]">{footer}</footer>}
      </aside>
    </div>
  );
}

// ---------------- Confirm ----------------
const ConfirmCtx = createContext<(o: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ title: string; body?: ReactNode; confirm?: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback((o: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title}
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
              {state?.confirm ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="text-sm text-zinc-600 dark:text-zinc-300">{state?.body}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

// ---------------- Data viz ----------------
export function Stat({ label, value, sub, icon, tone = 'default', onClick }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: 'default' | 'warn' | 'bad' | 'good'; onClick?: () => void }) {
  const ring = { default: '', warn: 'ring-1 ring-amber-500/30', bad: 'ring-1 ring-rose-500/30', good: '' }[tone];
  return (
    <button onClick={onClick} disabled={!onClick} className={cx('card group p-4 text-left transition enabled:hover:-translate-y-0.5 enabled:hover:shadow-md', ring)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
        {icon && <span className="text-zinc-400 transition group-hover:text-brand-500">{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </button>
  );
}

export function BarChart({ data, height = 140, format = (v: number) => String(v) }: { data: { label: string; value: number }[]; height?: number; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <div className="flex items-center justify-center text-xs text-zinc-400" style={{ height }}>No data yet</div>;
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="group relative flex h-full flex-1 flex-col justify-end">
          <div className="rounded-t-md bg-gradient-to-t from-brand-600 to-brand-400 opacity-80 transition group-hover:opacity-100" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />
          <div className="pointer-events-none absolute -top-8 left-1/2 z-10 hidden -translate-x-1/2 rounded-md bg-zinc-900 px-2 py-1 text-[11px] whitespace-nowrap text-white group-hover:block dark:bg-zinc-700">
            {d.label}: {format(d.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LineChart({ series, height = 160 }: { series: { name: string; color: string; points: (number | null)[] }[]; height?: number }) {
  const all = series.flatMap((s) => s.points).filter((v): v is number => v !== null);
  if (all.length < 2) return <div className="flex items-center justify-center text-xs text-zinc-400" style={{ height }}>Not enough history yet</div>;
  const min = Math.min(...all) * 0.97;
  const max = Math.max(...all) * 1.03;
  const n = Math.max(...series.map((s) => s.points.length));
  const W = 600;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => height - ((v - min) / (max - min || 1)) * height;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full overflow-visible" style={{ height }} preserveAspectRatio="none">
        {series.map((s) => {
          const pts = s.points.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
          return <polyline key={s.name} points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />;
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="scrollbar-thin flex gap-1 overflow-x-auto rounded-xl bg-zinc-100 p-1 dark:bg-white/[0.04]">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition',
            value === t.value ? 'bg-white text-zinc-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-zinc-200 px-1.5 text-[10px] dark:bg-white/10">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input readOnly className="input font-mono text-xs" value={value} onFocus={(e) => e.target.select()} />
      <Button
        onClick={() => {
          navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
