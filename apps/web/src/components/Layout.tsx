import {
  Activity,
  Boxes,
  ChevronsLeft,
  ChevronsRight,
  Clapperboard,
  FolderTree,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Music2,
  Network,
  PlugZap,
  Server,
  ShieldCheck,
  Sun,
  Workflow,
  Wand2,
  DatabaseBackup,
  Download,
  LayoutGrid,
  CircleArrowUp,
  Search,
  X,
} from 'lucide-react';
import { CommandPalette, usePaletteShortcut } from './CommandPalette';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ROLE_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOverview } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { Badge, Button, cx, Dot } from './ui';

/** `requires`: la voce compare solo se esiste un'integrazione di quel tipo (es. app specifiche come Armony). */
type Item = { to: string; label: string; icon: ReactNode; soon?: boolean; requires?: string };
export const NAV: { group: string; items: Item[] }[] = [
  {
    group: 'Panoramica',
    items: [
      { to: '/', label: 'Dashboard', icon: <LayoutDashboard /> },
      { to: '/app', label: 'App', icon: <LayoutGrid /> },
    ],
  },
  {
    group: 'Infrastruttura',
    items: [
      { to: '/sistema', label: 'Sistema', icon: <Server /> },
      { to: '/aggiornamenti', label: 'Aggiornamenti', icon: <CircleArrowUp /> },
      { to: '/rete', label: 'Rete', icon: <Network /> },
      { to: '/docker', label: 'Docker', icon: <Boxes /> },
      { to: '/file', label: 'File', icon: <FolderTree /> },
    ],
  },
  {
    group: 'Servizi',
    items: [
      { to: '/media', label: 'Media', icon: <Clapperboard /> },
      { to: '/download', label: 'Download', icon: <Download /> },
      { to: '/media-automation', label: 'Media automation', icon: <Wand2 /> },
      { to: '/armony', label: 'Armony', icon: <Music2 />, requires: 'armony' },
    ],
  },
  {
    group: 'Configurazione',
    items: [
      { to: '/automazioni', label: 'Automazioni', icon: <Workflow /> },
      { to: '/integrazioni', label: 'Integrazioni', icon: <PlugZap /> },
      { to: '/sicurezza', label: 'Sicurezza', icon: <ShieldCheck /> },
      { to: '/backup', label: 'Backup', icon: <DatabaseBackup /> },
    ],
  },
];

function readCollapsed() {
  try {
    return localStorage.getItem('gigi-sidebar') === '1';
  } catch {
    return false;
  }
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteShortcut(openPalette);
  const loc = useLocation();
  const overview = useOverview();
  const typeKey = [...new Set((overview.data?.integrations ?? []).map((i) => i.type))].sort().join(',');
  const { nav, pages } = useMemo(() => {
    const types = new Set(typeKey.split(','));
    const nav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.requires || types.has(i.requires)) })).filter((g) => g.items.length);
    return { nav, pages: nav.flatMap((g) => g.items.map((i) => ({ to: i.to, label: i.label, icon: i.icon, group: g.group }))) };
  }, [typeKey]);

  useEffect(() => setMobileOpen(false), [loc.pathname]);
  useEffect(() => {
    try {
      localStorage.setItem('gigi-sidebar', collapsed ? '1' : '0');
    } catch {}
  }, [collapsed]);

  const sys = overview.data?.system;
  const problems =
    (overview.data?.containers?.unhealthy.length ?? 0) +
    (overview.data?.containers?.list.filter((c) => c.state !== 'running').length ?? 0) +
    (overview.data?.integrations.filter((i) => ['offline', 'unhealthy', 'unauthorized', 'error'].includes(i.status ?? '')).length ?? 0);
  const hostTone = overview.isError ? 'err' : problems > 0 ? 'warn' : sys ? 'ok' : 'idle';

  const sidebar = (mobile: boolean) => (
    <nav aria-label="Navigazione principale" className="flex h-full flex-col">
      <div className={cx('flex h-14 items-center gap-2.5 px-4', collapsed && !mobile && 'justify-center px-0')}>
        <img src="/favicon.svg" alt="" className="size-7" />
        {(!collapsed || mobile) && (
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">GIGI OS</div>
            <div className="text-[11px] text-muted">Homelab control center</div>
          </div>
        )}
        {mobile && (
          <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setMobileOpen(false)} aria-label="Chiudi menu">
            <X />
          </Button>
        )}
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-2.5 py-2">
        {nav.map((g) => (
          <div key={g.group}>
            {(!collapsed || mobile) && <div className="mb-1 px-2 text-[11px] font-medium tracking-wide text-muted uppercase">{g.group}</div>}
            <ul className="space-y-0.5">
              {g.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    end={it.to === '/'}
                    title={collapsed && !mobile ? it.label : undefined}
                    className={({ isActive }) =>
                      cx(
                        'flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
                        collapsed && !mobile && 'justify-center',
                        isActive ? 'bg-surface-3 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                        it.soon && !isActive && 'text-muted',
                      )
                    }
                  >
                    {it.icon}
                    {(!collapsed || mobile) && <span className="flex-1 truncate">{it.label}</span>}
                    {(!collapsed || mobile) && it.soon && <Badge className="!text-[10px]">presto</Badge>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {!mobile && (
        <div className="border-t border-line p-2.5">
          <Button
            variant="ghost"
            size="sm"
            className={cx('w-full', collapsed ? 'justify-center' : 'justify-start')}
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Espandi barra laterale' : 'Comprimi barra laterale'}
          >
            {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
            {!collapsed && 'Comprimi'}
          </Button>
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className={cx('hidden shrink-0 border-r border-line bg-bg-2 transition-[width] duration-200 md:block', collapsed ? 'w-[60px]' : 'w-[232px]')}>
        {sidebar(false)}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[260px] border-r border-line bg-bg-2 pt-[env(safe-area-inset-top,0px)]">{sidebar(true)}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur md:px-6">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Apri menu">
            <Menu />
          </Button>
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <Dot tone={hostTone} pulse={hostTone === 'ok'} />
            <span className="truncate font-medium">{sys?.hostname ?? 'GIGI OS'}</span>
            {sys && (
              <span className="hidden truncate text-muted sm:inline">
                · {sys.os} · <Activity className="inline size-3.5 align-[-2px]" /> {Math.round(sys.cpu.usage)}% CPU
              </span>
            )}
            {problems > 0 && <Badge tone="warn">{problems} da verificare</Badge>}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={openPalette} aria-label="Cerca (Ctrl+K)" className="gap-2 text-muted">
              <Search />
              <span className="hidden lg:inline">Cerca</span>
              <kbd className="hidden rounded border border-line px-1.5 py-0.5 font-sans text-[10px] lg:inline">Ctrl K</kbd>
            </Button>
            <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro'}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <div className="mx-1 hidden h-5 w-px bg-line sm:block" />
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-[13px] font-medium">{user?.username}</div>
              <div className="text-[11px] text-muted">{user ? ROLE_LABEL[user.role] : ''}</div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="Esci">
              <LogOut />
            </Button>
          </div>
        </header>
        {paletteOpen && <CommandPalette open onClose={() => setPaletteOpen(false)} pages={pages} />}
        <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] md:px-6">
          <div className="mx-auto max-w-[1600px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
