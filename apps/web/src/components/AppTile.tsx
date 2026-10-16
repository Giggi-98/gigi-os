// Tile del launcher, condiviso da pagina App, widget e Ctrl+K.
import { ExternalLink } from 'lucide-react';
import type { AppStatus, LauncherApp } from '../lib/api';
import { cx, Dot, type Tone } from './ui';

export const APP_STATUS: Record<AppStatus, { tone: Tone; label: string }> = {
  online: { tone: 'ok', label: 'Online' },
  degraded: { tone: 'warn', label: 'Con problemi' },
  offline: { tone: 'err', label: 'Offline' },
  unknown: { tone: 'idle', label: 'Non verificata' },
};

export const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
};

export function AppIcon({ app, size = 'md' }: { app: Pick<LauncherApp, 'name' | 'icon' | 'color'>; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'size-7 rounded-lg text-xs' : 'size-10 rounded-xl text-base';
  if (app.icon) return <img src={app.icon} alt="" className={cx(box, 'shrink-0 bg-surface-3 object-contain p-1')} loading="lazy" />;
  return (
    <span
      className={cx(box, 'flex shrink-0 items-center justify-center font-semibold text-white')}
      style={{ background: `var(--${app.color})` }}
      aria-hidden
    >
      {app.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function LauncherTile({ app, compact = false, children }: { app: LauncherApp; compact?: boolean; children?: React.ReactNode }) {
  const s = APP_STATUS[app.status];
  return (
    <div className="group relative flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3 transition-colors hover:border-line-strong focus-within:border-accent">
      <AppIcon app={app} size={compact ? 'sm' : 'md'} />
      <div className="min-w-0 flex-1">
        <a
          href={app.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-[13px] font-medium after:absolute after:inset-0 after:rounded-xl focus:outline-none"
          title={`Apri ${app.name} (${app.url})`}
        >
          {app.name}
        </a>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
          <Dot tone={s.tone} pulse={app.status === 'online'} />
          <span className="truncate">{compact ? s.label : `${s.label} · ${hostOf(app.url)}`}</span>
        </div>
      </div>
      {!children && <ExternalLink className="size-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
      {children && <div className="relative z-10 flex shrink-0 items-center gap-0.5">{children}</div>}
    </div>
  );
}
