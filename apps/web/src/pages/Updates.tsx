// Aggiornamenti (D-032): solo rilevamento. GIGI OS non aggiorna nulla da solo; per gli stack non suoi mostra il comando.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Boxes, Check, CircleArrowUp, Copy, HardDrive, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Skeleton, useToast, type Tone } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, dateTime } from '../lib/format';

type Img = {
  ref: string;
  containers: string[];
  project: string | null;
  workingDir: string | null;
  status: 'aggiornato' | 'disponibile' | 'locale' | 'errore';
  error: string | null;
  newerVersion: string | null;
  versionError: string | null;
  managedByGigi: boolean;
};
type Result = {
  checkedAt: number;
  images: Img[] | null;
  imagesError: string | null;
  host: {
    supported: boolean;
    packages: { upgradable: number | null; security: number; esm: number; at: number | null } | null;
    apt: { lastUpdate: number | null; lastSuccess: number | null; lastUnattended: number | null };
    unattendedEnabled: boolean;
    kernel: { running: string; newest: string | null; rebootNeeded: boolean };
    aptStale: boolean;
  } | null;
  hostError: string | null;
  apps: { name: string; status: 'aggiornato' | 'disponibile' | 'non configurato' | 'errore'; current: string | null; latest: string | null; detail: string | null }[];
  gigi: { version: string; latest: string | null; source: string | null; error: string | null; url?: string | null };
};

const tagOf = (ref: string) => {
  const name = ref.split('@')[0];
  const i = name.lastIndexOf(':');
  return i > name.lastIndexOf('/') ? name.slice(i + 1) : 'latest';
};
const newer = (a: string | null, b: string) => {
  if (!a) return false;
  const x = a.replace(/^v/, '').split('.').map(Number);
  const y = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

function imgState(i: Img): [string, Tone] {
  if (i.status === 'locale') return ['costruita in locale', 'idle'];
  if (i.status === 'errore') return ['non verificabile', 'err'];
  if (i.newerVersion) return [`versione ${i.newerVersion}`, 'accent'];
  if (i.status === 'disponibile') return ['nuova immagine', 'accent'];
  return ['aggiornata', 'ok'];
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 truncate rounded bg-surface-2 px-2 py-1 font-mono text-[11px]" title={cmd}>
        {cmd}
      </code>
      <Button size="icon" variant="ghost" aria-label="Copia il comando" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => setOk(true))}>
        {ok ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function Todo({ i }: { i: Img }) {
  if (i.status === 'locale') return <span className="text-xs text-muted">Si aggiorna ricostruendola dal suo progetto</span>;
  if (i.status === 'errore') return <span className="text-xs text-muted" title={i.error ?? undefined}>{i.error ?? 'Registry non raggiungibile'}</span>;
  if (!i.newerVersion && i.status !== 'disponibile') return <span className="text-xs text-muted">—</span>;
  if (i.managedByGigi)
    return (
      <Link to="/docker?tab=stacks" className="text-xs text-accent hover:underline">
        {i.newerVersion ? `Cambia il tag in ${i.newerVersion} e aggiorna da Docker → Stack` : 'Aggiorna da Docker → Stack'}
      </Link>
    );
  const cmd = i.workingDir ? `cd ${i.workingDir} && docker compose pull && docker compose up -d` : `docker pull ${i.ref}`;
  return (
    <div className="space-y-1">
      {i.newerVersion && (
        <p className="text-xs text-fg-2">
          Nel compose cambia <code className="font-mono">{tagOf(i.ref)}</code> in <code className="font-mono">{i.newerVersion}</code>, poi:
        </p>
      )}
      <CopyCmd cmd={cmd} />
    </div>
  );
}

export function UpdatesPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['updates'], queryFn: () => api<Result | null>('/updates'), refetchInterval: 60_000 });
  const check = useMutation({
    mutationFn: () => api<Result>('/updates/check', { method: 'POST' }),
    onSuccess: (r) => {
      qc.setQueryData(['updates'], r);
      toast('ok', 'Controllo completato');
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const r = q.data;
  const imgs = [...(r?.images ?? [])].sort((a, b) => Number(!!b.newerVersion || b.status === 'disponibile') - Number(!!a.newerVersion || a.status === 'disponibile') || a.ref.localeCompare(b.ref));
  const toUpdate = imgs.filter((i) => i.newerVersion || i.status === 'disponibile').length;
  const h = r?.host;
  const gigiNew = !!r && newer(r.gigi.latest, r.gigi.version);

  return (
    <div>
      <PageHeader
        title="Aggiornamenti"
        description={`Solo rilevamento: GIGI OS non aggiorna nulla da solo. Controllo automatico ogni 12 ore${r ? ` · ultimo ${ago(r.checkedAt)}` : ''}.`}
        actions={
          isAdmin && (
            <Button size="sm" variant="primary" onClick={() => check.mutate()} loading={check.isPending}>
              <RefreshCw /> Controlla ora
            </Button>
          )
        }
      />
      {q.isError && <ErrorBox error={q.error} />}
      {q.isPending && <Skeleton className="h-48 w-full" />}
      {q.data === null && (
        <Empty icon={<CircleArrowUp />} title="Nessun controllo ancora">
          Il primo parte 2 minuti dopo l’avvio di GIGI OS{isAdmin ? ', oppure usa «Controlla ora».' : '.'}
        </Empty>
      )}
      {r && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card
            title="Container"
            icon={<Boxes />}
            subtitle={r.images ? (toUpdate ? `${toUpdate} da aggiornare su ${imgs.length} immagini` : `Tutte le ${imgs.length} immagini verificabili sono aggiornate`) : undefined}
            className="xl:col-span-3"
            bodyClassName="!px-0"
          >
            {r.imagesError && (
              <div className="px-4">
                <ErrorBox error={new Error(r.imagesError)} compact />
              </div>
            )}
            {r.images && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[13px]">
                  <thead className="border-y border-line text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-medium">Container</th>
                      <th className="px-3 py-2 font-medium">Immagine</th>
                      <th className="px-3 py-2 font-medium">Stato</th>
                      <th className="px-4 py-2 font-medium">Cosa fare</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imgs.map((i) => {
                      const [label, tone] = imgState(i);
                      return (
                        <tr key={i.ref} className="border-b border-line/60 align-top last:border-0">
                          <td className="px-4 py-2.5 font-medium">{i.containers.join(', ')}</td>
                          <td className="max-w-[260px] truncate px-3 py-2.5 font-mono text-xs text-fg-2" title={i.ref}>
                            {i.ref}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge tone={tone}>{label}</Badge>
                            {i.versionError && <div className="mt-1 text-[11px] text-muted" title={i.versionError}>versioni non controllate</div>}
                          </td>
                          <td className="max-w-[420px] px-4 py-2.5">
                            <Todo i={i} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-4 pt-3 text-[11px] text-muted">
              «Nuova immagine»: il tag in uso (es. latest) punta a un’immagine più recente. «Versione»: per un tag fissato esiste un numero più alto. Le immagini costruite in locale non si possono confrontare.
            </p>
          </Card>

          <Card title="Sistema operativo" icon={<HardDrive />} className="xl:col-span-2">
            {r.hostError && <ErrorBox error={new Error(r.hostError)} compact />}
            {h && !h.supported && <p className="text-xs text-muted">Non disponibile su questo sistema: servono i file di apt di Debian/Ubuntu.</p>}
            {h?.supported && (
              <dl className="divide-y divide-line text-[13px]">
                <Row k="Pacchetti">
                  {h.packages?.upgradable === null || !h.packages ? (
                    'sconosciuto'
                  ) : h.packages.upgradable ? (
                    <>
                      <Badge tone={h.packages.security ? 'warn' : 'accent'}>{h.packages.upgradable} da aggiornare</Badge>
                      {h.packages.security > 0 && <span className="ml-2 text-xs text-warn">{h.packages.security} di sicurezza</span>}
                    </>
                  ) : (
                    <Badge tone="ok">aggiornati</Badge>
                  )}
                  {h.packages?.esm ? <span className="ml-2 text-xs text-muted">+{h.packages.esm} con Ubuntu Pro (ESM)</span> : null}
                  {h.packages?.at && <div className="mt-0.5 text-[11px] text-muted">dati del {dateTime(h.packages.at)}</div>}
                </Row>
                <Row k="Indici dei pacchetti">
                  {h.apt.lastSuccess ? `aggiornati ${ago(h.apt.lastSuccess)}` : 'mai'}
                  {h.aptStale && (
                    <div className="mt-1 text-xs text-warn">
                      Da più di 2 giorni apt non riesce ad aggiornarli (ultimo tentativo {ago(h.apt.lastUpdate!)}). Esegui <code className="font-mono whitespace-nowrap">sudo apt update</code> per vedere quale sorgente non risponde.
                    </div>
                  )}
                </Row>
                <Row k="Aggiornamenti automatici">
                  {h.unattendedEnabled ? <Badge tone="ok">attivi</Badge> : <Badge>non attivi</Badge>}
                  {h.apt.lastUnattended && <span className="ml-2 text-xs text-muted">ultimo giro {ago(h.apt.lastUnattended)}</span>}
                </Row>
                <Row k="Kernel">
                  <span className="font-mono text-xs">{h.kernel.running}</span>
                  {h.kernel.rebootNeeded && (
                    <div className="mt-1">
                      <Badge tone="warn">riavvio necessario</Badge> <span className="text-xs text-muted">installato {h.kernel.newest}</span>
                    </div>
                  )}
                </Row>
              </dl>
            )}
          </Card>

          <Card title="App e GIGI OS" icon={<AppWindow />}>
            <dl className="divide-y divide-line text-[13px]">
              {r.apps.map((a) => (
                <Row key={a.name} k={a.name}>
                  <Badge tone={a.status === 'disponibile' ? 'accent' : a.status === 'aggiornato' ? 'ok' : a.status === 'errore' ? 'err' : 'idle'}>{a.status}</Badge>
                  {(a.current || a.latest) && (
                    <span className="ml-2 font-mono text-xs text-muted">
                      {a.current}
                      {a.latest ? ` → ${a.latest}` : ''}
                    </span>
                  )}
                  {a.status === 'errore' && a.detail && <div className="mt-0.5 text-[11px] text-muted">{a.detail}</div>}
                </Row>
              ))}
              <Row k="GIGI OS">
                <span className="font-mono text-xs">{r.gigi.version}</span>
                {gigiNew && <Badge tone="accent" className="ml-2">{r.gigi.latest} disponibile</Badge>}
                {gigiNew && r.gigi.url && (
                  <a href={r.gigi.url} target="_blank" rel="noreferrer" className="ml-2 text-xs text-accent hover:underline">
                    Novità
                  </a>
                )}
                {gigiNew && (
                  <div className="mt-1.5 space-y-1 text-[11px] text-muted">
                    <div>Sul server, nella cartella di GIGI OS (backup e ripristino automatici se qualcosa va storto):</div>
                    <CopyCmd cmd="sudo ./update.sh" />
                  </div>
                )}
                {r.gigi.source && !r.gigi.error && !r.gigi.latest && <div className="mt-0.5 text-[11px] text-muted">Nessuna versione pubblicata su {r.gigi.source}</div>}
                {!r.gigi.source && <div className="mt-0.5 text-[11px] text-muted">Controllo delle release non configurato (GIGI_RELEASE_REPO)</div>}
                {r.gigi.error && <div className="mt-0.5 text-[11px] text-muted">{r.gigi.error}</div>}
              </Row>
            </dl>
          </Card>
        </div>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[170px_1fr]">
      <dt className="text-xs font-medium text-fg-2">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
