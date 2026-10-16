// Launcher delle app (D-030): lista condivisa; aggiunta, modifica, ordine e proposte solo per gli admin.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, LayoutGrid, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppIcon, hostOf, LauncherTile } from '../components/AppTile';
import { Badge, Button, cx, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, useToast } from '../components/ui';
import { api, type Integration, type LauncherApp, type LauncherCandidate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useContainers, useIntegrations } from '../lib/queries';

export const useLauncher = () => useQuery({ queryKey: ['launcher'], queryFn: () => api<LauncherApp[]>('/launcher'), refetchInterval: 60_000 });

const COLORS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'];
const GROUP_BY_TYPE: Record<string, string> = { jellyfin: 'Media', apollo: 'Media', navidrome: 'Media', armony: 'Media', qbittorrent: 'Download', homeassistant: 'Casa' };
// Per le proposte da porta (senza integrazione) si riconosce il nome: è solo un suggerimento modificabile.
const GROUP_BY_NAME: [RegExp, string][] = [
  [/jellyfin|apollo|navidrome|armony|plex|emby/i, 'Media'],
  [/home assistant/i, 'Casa'],
  [/qbittorrent|transmission/i, 'Download'],
];
const suggestGroup = (c: LauncherCandidate) => (c.type ? GROUP_BY_TYPE[c.type] : undefined) ?? GROUP_BY_NAME.find(([re]) => re.test(c.name))?.[1] ?? '';

export function groupApps(apps: LauncherApp[]) {
  const m = new Map<string, LauncherApp[]>();
  for (const a of apps) {
    const g = a.group || 'Altre';
    m.set(g, [...(m.get(g) ?? []), a]);
  }
  return [...m.entries()];
}

type Form = { name: string; url: string; group: string; color: string; container: string | null; integrationId: string | null };
const empty: Form = { name: '', url: 'http://', group: '', color: 'chart-1', container: null, integrationId: null };

export function AppsPage() {
  const { isAdmin } = useAuth();
  const q = useLauncher();
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<LauncherApp | 'new' | null>(null);
  const [discover, setDiscover] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const apps = useMemo(() => q.data ?? [], [q.data]);
  const order = useMutation({
    mutationFn: (ids: string[]) => api('/launcher/order', { method: 'PUT', body: { ids } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['launcher'] }),
    onError: (e: Error) => toast('err', e.message),
  });
  const move = (id: string, dir: -1 | 1) => {
    const ids = apps.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    qc.setQueryData<LauncherApp[]>(['launcher'], (old) => ids.map((x) => old!.find((a) => a.id === x)!));
    order.mutate(ids);
  };

  return (
    <div>
      <PageHeader
        title="App"
        description="Le applicazioni del mini PC in un posto solo. Si aprono in una nuova scheda; lo stato arriva da container, integrazioni o da un controllo ogni 2 minuti."
        actions={
          isAdmin && (
            <>
              {apps.length > 1 && (
                <Button size="sm" variant={ordering ? 'primary' : 'secondary'} onClick={() => setOrdering(!ordering)}>
                  {ordering ? <Check /> : <ArrowDown />} {ordering ? 'Fine' : 'Riordina'}
                </Button>
              )}
              <Button size="sm" onClick={() => setDiscover(true)}>
                <Search /> Cerca app
              </Button>
              <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
                <Plus /> Aggiungi
              </Button>
            </>
          )
        }
      />
      {q.isError && <ErrorBox error={q.error} />}
      {!q.data && !q.isError && <Skeleton className="h-40 w-full" />}
      {q.data && apps.length === 0 && (
        <Empty
          icon={<LayoutGrid />}
          title="Nessuna app nel launcher"
          action={
            isAdmin ? (
              <Button size="sm" variant="primary" onClick={() => setDiscover(true)}>
                <Search /> Cerca le app del mini PC
              </Button>
            ) : undefined
          }
        >
          {isAdmin ? 'GIGI OS può proporre le app dalle integrazioni e dalle porte in ascolto: scegli tu quali aggiungere.' : 'Un amministratore non ha ancora aggiunto app.'}
        </Empty>
      )}
      <div className="space-y-6">
        {groupApps(apps).map(([g, list]) => (
          <section key={g} aria-label={g}>
            <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{g}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
              {list.map((a) => (
                <LauncherTile key={a.id} app={a}>
                  {isAdmin && ordering && (
                    <>
                      <Button size="icon" variant="ghost" aria-label={`Sposta ${a.name} prima`} onClick={() => move(a.id, -1)} disabled={apps[0]?.id === a.id}>
                        <ArrowUp />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label={`Sposta ${a.name} dopo`} onClick={() => move(a.id, 1)} disabled={apps[apps.length - 1]?.id === a.id}>
                        <ArrowDown />
                      </Button>
                    </>
                  )}
                  {isAdmin && !ordering && (
                    <Button size="icon" variant="ghost" aria-label={`Modifica ${a.name}`} onClick={() => setEdit(a)}>
                      <Pencil />
                    </Button>
                  )}
                </LauncherTile>
              ))}
            </div>
          </section>
        ))}
      </div>
      {edit && <EditDialog app={edit === 'new' ? null : edit} groups={[...new Set(apps.map((a) => a.group).filter(Boolean))]} onClose={() => setEdit(null)} />}
      {discover && <DiscoverDialog onClose={() => setDiscover(false)} />}
    </div>
  );
}

function EditDialog({ app, groups, onClose }: { app: LauncherApp | null; groups: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const containers = useContainers();
  const integrations = useIntegrations();
  const [f, setF] = useState<Form>(app ? { name: app.name, url: app.url, group: app.group, color: app.color, container: app.container, integrationId: app.integrationId } : empty);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = (msg: string) => {
    toast('ok', msg);
    void qc.invalidateQueries({ queryKey: ['launcher'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => (app ? api(`/launcher/${app.id}`, { method: 'PATCH', body: f }) : api<{ icon: boolean }>('/launcher', { method: 'POST', body: f })),
    onSuccess: () => done(app ? `${f.name} aggiornata` : `${f.name} aggiunta`),
  });
  const remove = useMutation({ mutationFn: () => api(`/launcher/${app!.id}`, { method: 'DELETE' }), onSuccess: () => done(`${app!.name} rimossa dal launcher`) });
  const icon = useMutation({
    mutationFn: () => api<{ icon: boolean }>(`/launcher/${app!.id}/icon`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(r.icon ? 'ok' : 'info', r.icon ? 'Icona aggiornata' : 'Icona non trovata: resta l’iniziale colorata');
      void qc.invalidateQueries({ queryKey: ['launcher'] });
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={app ? `Modifica ${app.name}` : 'Aggiungi un’app'}
      footer={
        <>
          {app && (
            <Button variant="ghost" className="mr-auto text-err" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Rimuovi
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name.trim() || !/^https?:\/\/.+/.test(f.url)}>
            Salva
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Nome">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} autoFocus />}</Field>
        <Field label="Indirizzo" help={`Quello che apri dal browser, per esempio http://${window.location.hostname}:8096`}>
          {(id) => <Input id={id} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} inputMode="url" spellCheck={false} />}
        </Field>
        <Field label="Gruppo" help="Facoltativo: Media, Casa, Server…">
          {(id) => (
            <>
              <Input id={id} value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} list="launcher-groups" maxLength={30} />
              <datalist id="launcher-groups">
                {[...new Set([...groups, 'Media', 'Casa', 'Server', 'Download'])].map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-fg-2">Colore (se manca l’icona)</legend>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <label key={c} className="cursor-pointer">
                <input type="radio" name="color" value={c} checked={f.color === c} onChange={() => setF({ ...f, color: c })} className="peer sr-only" />
                <span className="block size-7 rounded-lg ring-offset-2 ring-offset-surface peer-checked:ring-2 peer-checked:ring-fg peer-focus-visible:ring-2 peer-focus-visible:ring-accent" style={{ background: `var(--${c})` }} />
                <span className="sr-only">{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stato dal container" help="Facoltativo">
            {(id) => (
              <Select id={id} value={f.container ?? ''} onChange={(e) => setF({ ...f, container: e.target.value || null })}>
                <option value="">Nessuno</option>
                {containers.data?.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Stato dall’integrazione" help="Facoltativo">
            {(id) => (
              <Select id={id} value={f.integrationId ?? ''} onChange={(e) => setF({ ...f, integrationId: e.target.value || null })}>
                <option value="">Nessuna</option>
                {integrations.data?.map((i: Integration) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {app && (
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2">
            <AppIcon app={{ ...app, color: f.color }} />
            <span className="text-xs text-muted">{app.icon ? 'Icona scaricata dall’app' : 'Nessuna icona trovata: viene mostrata l’iniziale'}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => icon.mutate()} loading={icon.isPending}>
              <RefreshCw /> Aggiorna icona
            </Button>
          </div>
        )}
        {save.isError && <ErrorBox error={save.error} compact />}
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Rimuovere ${app?.name} dal launcher?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Annulla
            </Button>
            <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending}>
              Rimuovi
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-fg-2">Sparisce solo il collegamento: l’app e il suo container non vengono toccati.</p>
      </Dialog>
    </Dialog>
  );
}

function DiscoverDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['launcher-discover'], queryFn: () => api<LauncherCandidate[]>('/launcher/discover', { method: 'POST' }), staleTime: 0, gcTime: 0, retry: 0 });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const selectable = (q.data ?? []).filter((c) => c.openable && !c.added);
  const chosen = sel ?? new Set(selectable.map((c) => c.url));
  const add = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const c of selectable.filter((x) => chosen.has(x.url))) {
        await api('/launcher', {
          method: 'POST',
          body: { name: c.name, url: c.url, group: suggestGroup(c), color: COLORS[n % COLORS.length], container: c.container, integrationId: c.integrationId },
        });
        n++;
      }
      return n;
    },
    onSuccess: (n) => {
      toast('ok', `${n} app aggiunte al launcher`);
      void qc.invalidateQueries({ queryKey: ['launcher'] });
      onClose();
    },
    onError: (e: Error) => {
      toast('err', e.message);
      void qc.invalidateQueries({ queryKey: ['launcher'] });
    },
  });
  const toggle = (url: string) => {
    const s = new Set(chosen);
    if (s.has(url)) s.delete(url);
    else s.add(url);
    setSel(s);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title="Cerca le app del mini PC"
      description="Proposte dalle integrazioni configurate e dalle porte web in ascolto sull’IP LAN. Non viene salvato nulla finché non confermi."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
          <Button variant="primary" onClick={() => add.mutate()} loading={add.isPending} disabled={chosen.size === 0 || !q.data}>
            <Plus /> Aggiungi {chosen.size ? `(${chosen.size})` : ''}
          </Button>
        </>
      }
    >
      {q.isError && <ErrorBox error={q.error} compact />}
      {q.isPending && (
        <div className="space-y-2" aria-busy="true">
          <p className="text-xs text-muted">Controllo integrazioni e porte in ascolto…</p>
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {q.data && q.data.length === 0 && <Empty title="Nessuna app trovata">Puoi sempre aggiungerne una a mano.</Empty>}
      {q.data && q.data.length > 0 && (
        <ul className="space-y-1.5">
          {q.data.map((c) => {
            const disabled = !c.openable || c.added;
            return (
              <li key={c.url + c.name}>
                <label className={cx('flex items-start gap-3 rounded-lg border border-line px-3 py-2.5', disabled ? 'opacity-60' : 'cursor-pointer hover:border-line-strong')}>
                  <input type="checkbox" className="mt-0.5 size-4 [--check:var(--accent)]" disabled={disabled} checked={!disabled && chosen.has(c.url)} onChange={() => toggle(c.url)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{c.name}</span>
                      <Badge tone={c.source === 'integrazione' ? 'accent' : 'idle'}>{c.source}</Badge>
                      {c.added && <Badge tone="ok">già nel launcher</Badge>}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-muted">{hostOf(c.url)}</div>
                    {c.reason && <div className="mt-1 text-xs text-warn">{c.reason}</div>}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
