import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, Loader2, WifiOff, X, XCircle } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import type { IntegrationStatus } from '../lib/api';

export const cx = clsx;

// ───────── Superfici ─────────
export function Card({
  title,
  icon,
  actions,
  children,
  className,
  bodyClassName,
  subtitle,
  dragHandle,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  subtitle?: ReactNode;
  dragHandle?: boolean;
}) {
  return (
    <section
      className={cx('flex min-w-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface', className)}
      style={{ boxShadow: 'var(--shadow)' }}
    >
      {(title || actions) && (
        <header className={cx('flex flex-wrap items-center gap-2 px-4 pt-3.5 pb-2', dragHandle && 'drag-handle cursor-grab active:cursor-grabbing')}>
          {icon && <span className="text-muted [&>svg]:size-4">{icon}</span>}
          {/* Almeno 10rem per titolo e sottotitolo: se le azioni non ci stanno, passano sotto invece di schiacciarli */}
          <div className="min-w-0 flex-1 basis-40">
            <h2 className="truncate text-[13px] font-medium tracking-tight text-fg-2">{title}</h2>
            {subtitle && <p className="line-clamp-2 text-xs text-pretty text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>{actions}</div>}
        </header>
      )}
      <div className={cx('min-h-0 flex-1 px-4 pb-4', !title && !actions && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ───────── Controlli ─────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-[13px]',
        size === 'icon' && 'size-8',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-2',
        variant === 'secondary' && 'border border-line-strong bg-surface-2 text-fg hover:bg-surface-3',
        variant === 'ghost' && 'text-fg-2 hover:bg-surface-3 hover:text-fg',
        variant === 'danger' && 'bg-err text-white hover:opacity-90',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
});

/** w-full predefinito solo se il chiamante non specifica una larghezza propria. */
const width = (className?: string) => (/(^|\s)(w-|min-w-|flex-1)/.test(className ?? '') ? '' : 'w-full');

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        width(className),
        'h-9 rounded-lg border border-line-strong bg-bg-2 px-3 text-[13px] text-fg placeholder:text-muted focus:border-accent focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(width(className), 'h-9 rounded-lg border border-line-strong bg-bg-2 px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, help, children, error }: { label: string; help?: ReactNode; children: (id: string) => ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-fg-2">
        {label}
      </label>
      {children(id)}
      {help && !error && <p className="text-xs text-muted">{help}</p>}
      {error && <p className="text-xs text-err">{error}</p>}
    </div>
  );
}

// ───────── Stato ─────────
const TONE: Record<string, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  err: 'bg-err-soft text-err',
  info: 'bg-info-soft text-info',
  idle: 'bg-surface-3 text-muted',
  accent: 'bg-accent-soft text-accent',
};
export type Tone = keyof typeof TONE;

export function Badge({ tone = 'idle', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', TONE[tone], className)}>{children}</span>;
}

const DOT: Record<string, string> = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', info: 'bg-info', idle: 'bg-idle', accent: 'bg-accent' };
export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', DOT[tone], pulse && 'pulse-dot')} />;
}

export const STATUS: Record<IntegrationStatus | 'unknown', { tone: Tone; label: string }> = {
  online: { tone: 'ok', label: 'Online' },
  unhealthy: { tone: 'warn', label: 'Non in salute' },
  offline: { tone: 'err', label: 'Offline' },
  unauthorized: { tone: 'err', label: 'Accesso negato' },
  unconfigured: { tone: 'info', label: 'Da configurare' },
  unsupported: { tone: 'idle', label: 'Non supportato' },
  error: { tone: 'err', label: 'Errore' },
  disabled: { tone: 'idle', label: 'Disabilitata' },
  unknown: { tone: 'idle', label: 'In verifica' },
};

export function StatusBadge({ status }: { status: IntegrationStatus | null }) {
  const s = STATUS[status ?? 'unknown'];
  return (
    <Badge tone={s.tone}>
      <Dot tone={s.tone} pulse={status === 'online'} />
      {s.label}
    </Badge>
  );
}

export function containerTone(state: string, health: string | null): Tone {
  if (health === 'unhealthy') return 'err';
  if (state === 'running') return health === 'starting' ? 'warn' : 'ok';
  if (state === 'restarting') return 'warn';
  if (state === 'exited' || state === 'dead') return 'err';
  return 'idle';
}

export function containerLabel(state: string, health: string | null) {
  if (health === 'unhealthy') return 'Unhealthy';
  if (state === 'running') return health === 'healthy' ? 'Healthy' : health === 'starting' ? 'Avvio' : 'In esecuzione';
  return ({ exited: 'Fermo', created: 'Creato', paused: 'In pausa', restarting: 'Riavvio', dead: 'Morto' } as Record<string, string>)[state] ?? state;
}

// ───────── Misure ─────────
export function meterTone(p: number, warn = 75, err = 90): Tone {
  return p >= err ? 'err' : p >= warn ? 'warn' : 'ok';
}

export function Meter({ value, tone, className, label }: { value: number; tone?: Tone; className?: string; label?: string }) {
  const t = tone ?? meterTone(value);
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div className={cx('h-full rounded-full transition-[width] duration-500', DOT[t])} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Ring({ value, size = 76, stroke = 7, tone, children, label }: { value: number; size?: number; stroke?: number; tone?: Tone; children?: ReactNode; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const t = tone ?? meterTone(v);
  const color = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', info: 'var(--info)', idle: 'var(--idle)', accent: 'var(--accent)' }[t];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="meter" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

// ───────── Stati vuoti / errori / caricamento ─────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-md', className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1.5 px-4 py-6 text-center">
      {icon && <div className="mb-1 text-muted [&>svg]:size-6">{icon}</div>}
      <p className="text-sm font-medium text-fg-2">{title}</p>
      {children && <div className="max-w-sm text-xs text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error, compact }: { error: unknown; compact?: boolean }) {
  const e = error as { message?: string; status?: number };
  const offline = e?.status === 0 || e?.status === 503 || e?.status === 502;
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <div className={cx('flex items-start gap-2 rounded-lg border border-err/25 bg-err-soft text-err', compact ? 'px-2.5 py-2 text-xs' : 'px-3 py-2.5 text-[13px]')}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{e?.message ?? 'Errore sconosciuto'}</span>
    </div>
  );
}

// ───────── Dialog (dialog nativo: focus, Esc e backdrop gestiti dal browser) ─────────
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx(
        'm-auto max-h-[90vh] w-[calc(100%-2rem)] rounded-2xl border border-line-strong bg-surface p-0 text-fg backdrop:bg-black/60 backdrop:backdrop-blur-[2px]',
        wide ? 'max-w-2xl' : 'max-w-md',
      )}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <div className="mt-0.5 text-[13px] text-muted">{description}</div>}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Chiudi">
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ───────── Tabs ─────────
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; count?: number }[] }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors',
            value === it.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg-2',
          )}
        >
          {it.label}
          {it.count !== undefined && <span className="rounded bg-surface-3 px-1.5 text-[11px] text-muted tabular">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ───────── Toast ─────────
type Toast = { id: number; tone: 'ok' | 'err' | 'info'; text: string };
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), tone === 'err' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-50 flex w-[min(380px,calc(100%-2rem))] flex-col gap-2">
        {items.map((t) => {
          const Icon = t.tone === 'ok' ? CheckCircle2 : t.tone === 'err' ? XCircle : Info;
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line-strong bg-surface-2 px-3.5 py-3 text-[13px] shadow-xl"
            >
              <Icon className={cx('mt-px size-4 shrink-0', t.tone === 'ok' ? 'text-ok' : t.tone === 'err' ? 'text-err' : 'text-info')} />
              <span className="min-w-0 break-words">{t.text}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Kv({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted">{k}</dt>
      <dd className={cx('min-w-0 truncate text-right text-[13px] text-fg-2', mono && 'font-mono text-xs')}>{children}</dd>
    </div>
  );
}
