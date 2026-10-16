// Stack compose: elenco, wizard di creazione/modifica e azioni sugli stack creati da GIGI OS (D-025).
// Gli stack creati fuori da GIGI OS (jellyfin, armony, …) sono mostrati in sola lettura.
import { locale } from '../lib/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Download,
  FileUp,
  Folder,
  FolderPlus,
  History,
  Layers,
  Lock,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Card, cx, Dialog, Dot, Empty, ErrorBox, Field, Input, Select, Skeleton, useToast, type Tone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, dateTime } from '../lib/format';

type StackRow = {
  project: string;
  managed: boolean;
  root: string;
  rel: string;
  dir: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  containers: { name: string; service: string | null; state: string; status: string; image: string }[];
};
type StackDetail = { project: string; root: string; rel: string; dir: string; compose: string; envKeys: string[]; hasPrevious: boolean; marker: { createdAt: number; updatedAt: number; createdBy: string | null; updatedBy: string | null } };
type Finding = { level: 'error' | 'danger' | 'warn' | 'info'; service?: string; message: string };
type Preflight = {
  ok: boolean;
  needsConfirm: boolean;
  dir: string;
  update: boolean;
  services: { name: string; image: string | null; build: boolean; ports: string[]; mounts: string[]; networkMode: string | null; restart: string | null }[];
  findings: Finding[];
};
type Job = { id: string; project: string; action: string; status: 'running' | 'ok' | 'error'; startedAt: number; endedAt: number | null; exitCode: number | null; output: string };
type Root = { label: string; path: string };
type Browse = { path: string; rel: string; dirs: { name: string; stack: string | null; empty: boolean }[] };

const stateTone = (s: StackRow): Tone => {
  if (!s.containers.length) return 'idle';
  const running = s.containers.filter((c) => c.state === 'running').length;
  return running === s.containers.length ? 'ok' : running === 0 ? 'idle' : 'warn';
};
const stateLabel = (s: StackRow) => {
  if (!s.containers.length) return 'nessun container';
  const running = s.containers.filter((c) => c.state === 'running').length;
  return `${running}/${s.containers.length} attivi`;
};

export function StacksTab() {
  const { isAdmin } = useAuth();
  const q = useQuery({ queryKey: ['stacks'], queryFn: () => api<StackRow[]>('/stacks'), refetchInterval: 15_000 });
  const [wizard, setWizard] = useState<StackDetail | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-48 w-full" />;
  const managed = q.data.filter((s) => s.managed);
  const external = q.data.filter((s) => !s.managed);
  return (
    <div className="space-y-4">
      <Card
        title="Stack creati da GIGI OS"
        subtitle="Compose scritti o caricati dal wizard: modificabili, aggiornabili e rimovibili da qui."
        actions={isAdmin && <Button size="sm" variant="primary" onClick={() => setWizard('new')}><Plus /> Nuovo stack</Button>}
        bodyClassName="!p-0"
      >
        {managed.length === 0 ? (
          <Empty icon={<Layers />} title="Nessuno stack creato da GIGI OS">
            {isAdmin ? 'Crea il primo con «Nuovo stack»: scegli la cartella, scrivi o carica il compose, verifica e avvia.' : 'Solo gli amministratori possono creare stack.'}
          </Empty>
        ) : (
          <ul>
            {managed.map((s) => (
              <li key={s.project} className="border-t border-line/60">
                <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2" onClick={() => isAdmin && setOpen(s.project)} disabled={!isAdmin}>
                  <Dot tone={stateTone(s)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{s.project}</div>
                    <div className="truncate font-mono text-[11px] text-muted">{s.dir}</div>
                  </div>
                  <Badge tone={stateTone(s)}>{stateLabel(s)}</Badge>
                  <span className="hidden text-xs text-muted sm:inline">agg. {ago(s.updatedAt)}</span>
                  {isAdmin && <ChevronRight className="size-4 text-muted" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Altri stack sul server" subtitle="Creati fuori da GIGI OS: solo consultazione, nessuna azione possibile da qui." bodyClassName="!p-0">
        <ul>
          {external.map((s) => (
            <li key={s.project} className="flex items-center gap-3 border-t border-line/60 px-4 py-2.5">
              <Dot tone={stateTone(s)} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{s.project}</div>
                <div className="truncate font-mono text-[11px] text-muted">{s.dir || 'percorso sconosciuto'}</div>
              </div>
              <span className="hidden max-w-[40%] truncate text-xs text-muted md:inline">{s.containers.map((c) => c.name).join(', ')}</span>
              <Badge tone={stateTone(s)}>{stateLabel(s)}</Badge>
              <Lock className="size-3.5 text-muted" aria-label="Sola lettura" />
            </li>
          ))}
        </ul>
      </Card>
      {open && <StackDrawer project={open} onClose={() => setOpen(null)} onEdit={(d) => { setOpen(null); setWizard(d); }} />}
      {wizard && <StackWizard edit={wizard === 'new' ? null : wizard} onClose={() => setWizard(null)} />}
    </div>
  );
}

// ───────────── Pannello laterale ─────────────

function Drawer({ title, subtitle, onClose, children, actions }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('dialog[open]') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col border-l border-line-strong bg-bg-2 pt-[env(safe-area-inset-top,0px)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate font-mono text-xs text-muted">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Chiudi"><X /></Button>
        </div>
        {actions && <div className="flex flex-wrap gap-1.5 border-b border-line px-5 py-2.5">{actions}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

type Action = 'up' | 'stop' | 'restart' | 'pull' | 'down' | 'remove' | 'rollback';
const ACTIONS: Record<Action, { label: string; icon: ReactNode; impact: string; confirm: boolean; volumes?: boolean }> = {
  up: { label: 'Avvia', icon: <Power />, impact: 'Crea o avvia i container secondo il compose attuale.', confirm: false },
  pull: { label: 'Aggiorna immagini', icon: <Download />, impact: 'Scarica le versioni più recenti delle immagini e ricrea i container che cambiano.', confirm: false },
  restart: { label: 'Riavvia', icon: <RotateCw />, impact: 'I servizi dello stack saranno irraggiungibili per qualche secondo.', confirm: true },
  stop: { label: 'Ferma', icon: <Square />, impact: 'I container vengono fermati ma non rimossi.', confirm: true },
  rollback: { label: 'Ripristina precedente', icon: <History />, impact: 'Torna al compose salvato prima dell’ultima modifica e lo riapplica (le due versioni vengono scambiate).', confirm: true },
  down: { label: 'Down', icon: <Square />, impact: 'Ferma e rimuove container e reti dello stack. I file del compose restano: «Avvia» lo ricrea.', confirm: true, volumes: true },
  remove: {
    label: 'Rimuovi stack',
    icon: <Trash2 />,
    impact: 'Esegue down e cancella compose.yaml, .env e i file di GIGI OS. Le altre cartelle dell’app (es. ./data) restano sul disco.',
    confirm: true,
    volumes: true,
  },
};

function StackDrawer({ project, onClose, onEdit }: { project: string; onClose: () => void; onEdit: (d: StackDetail) => void }) {
  const d = useQuery({ queryKey: ['stack', project], queryFn: () => api<StackDetail>(`/stacks/${project}`) });
  const list = useQuery({ queryKey: ['stacks'], queryFn: () => api<StackRow[]>('/stacks'), refetchInterval: 5_000 });
  const row = list.data?.find((s) => s.project === project);
  const [action, setAction] = useState<Action | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const running = row?.containers.some((c) => c.state === 'running');
  const btn = (a: Action, variant: 'secondary' | 'danger' = 'secondary') => (
    <Button size="sm" variant={variant} onClick={() => setAction(a)}>{ACTIONS[a].icon} {ACTIONS[a].label}</Button>
  );
  return (
    <Drawer
      title={project}
      subtitle={d.data?.dir ?? row?.dir}
      onClose={onClose}
      actions={
        d.data && (
          <>
            <Button size="sm" variant="primary" onClick={() => onEdit(d.data!)}><Pencil /> Modifica compose</Button>
            {running ? btn('restart') : btn('up')}
            {btn('pull')}
            {running && btn('stop')}
            {d.data.hasPrevious && btn('rollback')}
            <span className="flex-1" />
            {btn('down', 'danger')}
            {btn('remove', 'danger')}
          </>
        )
      }
    >
      {d.isError && <ErrorBox error={d.error} />}
      {!d.data && !d.isError && <Skeleton className="h-40 w-full" />}
      {d.data && (
        <div className="space-y-4">
          {job && <JobOutput id={job} onDone={() => void list.refetch()} />}
          <Card title="Container">
            {row?.containers.length ? (
              <ul className="space-y-1.5">
                {row.containers.map((c) => (
                  <li key={c.name} className="flex items-center gap-2 text-[13px]">
                    <Dot tone={c.state === 'running' ? 'ok' : 'idle'} />
                    <span className="font-medium">{c.name}</span>
                    <span className="truncate font-mono text-xs text-muted">{c.image}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted">{c.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">Nessun container: lo stack non è avviato.</p>
            )}
          </Card>
          <Card title="compose.yaml" subtitle={`Aggiornato ${dateTime(d.data.marker.updatedAt)}${d.data.marker.updatedBy ? ` da ${d.data.marker.updatedBy}` : ''}`}>
            <pre className="max-h-96 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-fg-2">{d.data.compose}</pre>
          </Card>
          <Card title="Variabili (.env)" subtitle="I valori sono salvati sul server con permessi 0600 e non vengono mai mostrati.">
            {d.data.envKeys.length ? (
              <div className="flex flex-wrap gap-1">{d.data.envKeys.map((k) => <Badge key={k}>{k}</Badge>)}</div>
            ) : (
              <p className="text-xs text-muted">Nessuna variabile.</p>
            )}
          </Card>
        </div>
      )}
      {action && <ActionDialog project={project} action={action} onClose={() => setAction(null)} onJob={(id) => { setJob(id); setAction(null); }} onRemoved={onClose} />}
    </Drawer>
  );
}

function ActionDialog({ project, action, onClose, onJob, onRemoved }: { project: string; action: Action; onClose: () => void; onJob: (id: string) => void; onRemoved: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const a = ACTIONS[action];
  const [confirm, setConfirm] = useState('');
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [volumesConfirm, setVolumesConfirm] = useState('');
  const m = useMutation({
    mutationFn: () => api<Job>(`/stacks/${project}/actions`, { method: 'POST', body: { action, confirm: a.confirm ? confirm : undefined, removeVolumes, volumesConfirm: removeVolumes ? volumesConfirm : undefined } }),
    onSuccess: (j) => {
      toast('ok', `${a.label}: ${project} — operazione avviata e registrata nell’audit log`);
      void qc.invalidateQueries({ queryKey: ['stacks'] });
      if (action === 'remove') {
        onRemoved();
        return;
      }
      onJob(j.id);
    },
  });
  const ready = (!a.confirm || confirm === project) && (!removeVolumes || volumesConfirm === 'ELIMINA');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${a.label}: ${project}?`}
      description={a.impact}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant={a.confirm ? 'danger' : 'primary'} disabled={!ready} loading={m.isPending} onClick={() => m.mutate()}>{a.label}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {a.confirm && (
          <Field label={`Per confermare digita ${project}`}>{(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />}</Field>
        )}
        {a.volumes && (
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5 size-4 [--check:var(--err)]" checked={removeVolumes} onChange={(e) => setRemoveVolumes(e.target.checked)} />
            <span>Elimina anche i volumi dello stack <span className="block text-xs text-muted">I dati nei volumi Docker vengono cancellati in modo definitivo. Le cartelle montate (bind) non vengono toccate.</span></span>
          </label>
        )}
        {removeVolumes && (
          <Field label="Per eliminare i volumi scrivi ELIMINA">{(id) => <Input id={id} value={volumesConfirm} onChange={(e) => setVolumesConfirm(e.target.value)} autoComplete="off" />}</Field>
        )}
        {action === 'remove' && <p className="text-xs text-muted">L’avanzamento della rimozione è visibile nell’audit log; lo stack sparirà dall’elenco al termine.</p>}
        {m.isError && <ErrorBox error={m.error} compact />}
      </div>
    </Dialog>
  );
}

/** Output di un'operazione lunga (pull/up/down), aggiornato ogni secondo finché è in corso. */
function JobOutput({ id, onDone }: { id: string; onDone?: (j: Job) => void }) {
  const q = useQuery({
    queryKey: ['stack-job', id],
    queryFn: () => api<Job>(`/stacks/jobs/${id}`),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== 'running' ? false : 1000),
  });
  const j = q.data;
  useEffect(() => {
    if (j && j.status !== 'running') onDone?.(j);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j?.status]);
  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <Badge tone={!j || j.status === 'running' ? 'info' : j.status === 'ok' ? 'ok' : 'err'}>
          <Dot tone={!j || j.status === 'running' ? 'info' : j.status === 'ok' ? 'ok' : 'err'} pulse={!j || j.status === 'running'} />
          {!j || j.status === 'running' ? 'In corso…' : j.status === 'ok' ? 'Completato' : `Errore${j.exitCode != null ? ` (codice ${j.exitCode})` : ''}`}
        </Badge>
        {j?.endedAt && <span className="text-muted">in {Math.max(1, Math.round((j.endedAt - j.startedAt) / 1000))} s</span>}
      </div>
      {q.isError ? (
        <div className="p-3"><ErrorBox error={q.error} compact /></div>
      ) : (
        <pre className="max-h-80 overflow-auto bg-[#07080b] p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-[#d7dae0]" role="log">{j?.output || 'Avvio…'}</pre>
      )}
    </div>
  );
}

// ───────────── Wizard ─────────────

// Docker accetta solo un IP davanti alla porta: quello della pagina se è un IPv4, altrimenti un segnaposto da sostituire
const LAN_IP = /^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname) ? window.location.hostname : 'IP_LAN';

const TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      # Solo LAN: le porte pubblicate su 0.0.0.0 scavalcano UFW
      - "${LAN_IP}:8081:80"
    volumes:
      - ./data:/usr/share/nginx/html:ro
`;

type EnvRow = { key: string; value: string; saved: boolean };
const STEPS = ['Posizione', 'Compose', 'Verifica', 'Avvio'] as const;
const LEVEL: Record<Finding['level'], { tone: Tone; label: string }> = {
  error: { tone: 'err', label: 'Bloccante' },
  danger: { tone: 'err', label: 'Rischio alto' },
  warn: { tone: 'warn', label: 'Attenzione' },
  info: { tone: 'info', label: 'Nota' },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 63);

function StackWizard({ edit, onClose }: { edit: StackDetail | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [root, setRoot] = useState(edit?.root ?? '');
  const [base, setBase] = useState(edit ? edit.rel.split('/').slice(0, -1).join('/') : '');
  const [folder, setFolder] = useState(edit ? edit.rel.split('/').at(-1) ?? '' : '');
  const [project, setProject] = useState(edit?.project ?? '');
  const [projectTouched, setProjectTouched] = useState(!!edit);
  const [compose, setCompose] = useState(edit?.compose ?? TEMPLATE);
  const [env, setEnv] = useState<EnvRow[]>(() => (edit?.envKeys ?? []).map((k) => ({ key: k, value: '', saved: true })));
  const [pull, setPull] = useState<'missing' | 'always'>('missing');
  const [confirm, setConfirm] = useState('');
  const [pf, setPf] = useState<Preflight | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  const roots = useQuery({ queryKey: ['stack-roots'], queryFn: () => api<Root[]>('/stacks/roots'), enabled: !edit });
  useEffect(() => {
    if (!root && roots.data?.length) setRoot(roots.data[0].label);
  }, [roots.data, root]);
  const browse = useQuery({
    queryKey: ['stack-browse', root, base],
    queryFn: () => api<Browse>(`/stacks/browse?${new URLSearchParams({ root, path: base })}`),
    enabled: !edit && !!root,
  });
  useEffect(() => {
    if (!projectTouched) setProject(slug(folder));
  }, [folder, projectTouched]);

  const rel = [base, folder].filter(Boolean).join('/');
  const rootPath = edit ? edit.dir.slice(0, edit.dir.length - edit.rel.length - 1) : roots.data?.find((r) => r.label === root)?.path ?? '';
  const fullPath = rel ? `${rootPath}/${rel}` : rootPath;
  const existing = browse.data?.dirs.find((d) => d.name === folder);
  const folderOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(folder);
  const projectOk = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(project);
  const envOk = env.every((r) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key)) && new Set(env.map((r) => r.key)).size === env.length;
  const envBody = Object.fromEntries(env.map((r) => [r.key, r.saved && r.value === '' ? null : r.value]));
  const body = { root, path: rel, project, compose, env: envBody };

  const check = useMutation({
    mutationFn: () => api<Preflight>('/stacks/preflight', { method: 'POST', body }),
    onSuccess: (r) => {
      setPf(r);
      setConfirm('');
      setStep(2);
    },
  });
  const deploy = useMutation({
    mutationFn: () => api<{ job: Job }>('/stacks/deploy', { method: 'POST', body: { ...body, pull, confirm: pf?.needsConfirm ? confirm : undefined } }),
    onSuccess: (r) => {
      setJob(r.job);
      setStep(3);
      void qc.invalidateQueries({ queryKey: ['stacks'] });
      void qc.invalidateQueries({ queryKey: ['stack', project] });
    },
    onError: (e) => {
      const f = (e as ApiError).body as { findings?: Finding[] } | undefined;
      if (f?.findings && pf) setPf({ ...pf, findings: f.findings, ok: !f.findings.some((x) => x.level === 'error') });
    },
  });

  const loadFile = (f: File | undefined, target: 'compose' | 'env') => {
    if (!f) return;
    if (f.size > 200_000) return toast('err', 'File troppo grande (max 200 KB)');
    void f.text().then((t) => {
      if (target === 'compose') setCompose(t);
      else {
        const rows: EnvRow[] = [...env];
        for (const line of t.split('\n')) {
          const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
          if (!m || line.trim().startsWith('#')) continue;
          let v = m[2];
          if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
          const i = rows.findIndex((r) => r.key === m[1]);
          if (i >= 0) rows[i] = { ...rows[i], value: v };
          else rows.push({ key: m[1], value: v, saved: false });
        }
        setEnv(rows);
        toast('ok', `${f.name}: variabili importate`);
      }
    });
  };

  const canNext0 = !!root && folderOk && projectOk && (!existing || existing.empty || existing.stack === project || !!edit);
  const blockingCount = pf?.findings.filter((f) => f.level === 'error').length ?? 0;

  return (
    <Drawer title={edit ? `Modifica stack ${edit.project}` : 'Nuovo stack'} subtitle={fullPath || undefined} onClose={() => (deploy.isPending ? undefined : onClose())}>
      <ol className="mb-5 flex flex-wrap gap-1.5 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className={cx('flex items-center gap-1.5 rounded-full px-2.5 py-1', i === step ? 'bg-accent-soft text-accent' : i < step ? 'text-fg-2' : 'text-muted')}>
            <span className={cx('grid size-4 place-items-center rounded-full text-[10px] font-semibold', i <= step ? 'bg-accent text-white' : 'bg-surface-3')}>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-4">
          {edit ? (
            <Card title="Posizione">
              <p className="text-[13px]">Lo stack resta in <span className="font-mono">{edit.dir}</span> con il nome <b>{edit.project}</b>.</p>
            </Card>
          ) : (
            <>
              <Card title="Dove salvare lo stack" subtitle="Ogni stack ha la sua cartella con compose.yaml, .env e i dati relativi (./data).">
                <div className="space-y-3">
                  {roots.isError && <ErrorBox error={roots.error} compact />}
                  {roots.data && roots.data.length > 1 && (
                    <Field label="Radice">{(id) => (
                      <Select id={id} value={root} onChange={(e) => { setRoot(e.target.value); setBase(''); }}>
                        {roots.data.map((r) => <option key={r.label} value={r.label}>{r.label} — {r.path}</option>)}
                      </Select>
                    )}</Field>
                  )}
                  <div>
                    <div className="mb-1.5 flex flex-wrap items-center gap-1 font-mono text-xs">
                      <button className="text-accent hover:underline" onClick={() => setBase('')}>{rootPath || '…'}</button>
                      {base.split('/').filter(Boolean).map((seg, i, arr) => (
                        <span key={i} className="flex items-center gap-1">
                          <span className="text-muted">/</span>
                          <button className="text-accent hover:underline" onClick={() => setBase(arr.slice(0, i + 1).join('/'))}>{seg}</button>
                        </span>
                      ))}
                    </div>
                    <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
                      {browse.isError && <div className="p-2"><ErrorBox error={browse.error} compact /></div>}
                      {browse.data?.dirs.length === 0 && <p className="px-3 py-2.5 text-xs text-muted">Cartella vuota: crea la cartella dello stack qui sotto.</p>}
                      {browse.data?.dirs.map((d) => (
                        <div key={d.name} className={cx('flex items-center gap-2 border-b border-line/60 px-3 py-1.5 text-[13px] last:border-0', folder === d.name && 'bg-surface-2')}>
                          <Folder className="size-4 text-muted" />
                          <span className="min-w-0 flex-1 truncate">{d.name}</span>
                          {d.stack ? <Badge tone="accent">stack {d.stack}</Badge> : d.empty ? <Badge>vuota</Badge> : null}
                          {!d.stack && base.split('/').filter(Boolean).length < 2 && (
                            <Button size="sm" variant="ghost" onClick={() => { setBase([base, d.name].filter(Boolean).join('/')); setFolder(''); }}>Apri</Button>
                          )}
                          {(d.empty && !d.stack) && <Button size="sm" variant="ghost" onClick={() => setFolder(d.name)}>Usa</Button>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <Field
                    label="Cartella dello stack"
                    help={folder && !folderOk ? undefined : existing ? (existing.stack ? `Contiene già lo stack «${existing.stack}»` : existing.empty ? 'Cartella esistente e vuota: verrà usata' : 'La cartella esiste e non è vuota: scegline un’altra') : 'Verrà creata al momento dell’avvio.'}
                    error={folder && !folderOk ? 'Solo lettere, numeri, punto, trattino e underscore' : null}
                  >
                    {(id) => (
                      <div className="flex items-center gap-2">
                        <FolderPlus className="size-4 shrink-0 text-muted" />
                        <Input id={id} value={folder} onChange={(e) => setFolder(e.target.value.trim())} placeholder="es. uptime-kuma" autoComplete="off" spellCheck={false} />
                      </div>
                    )}
                  </Field>
                </div>
              </Card>
              <Card title="Nome dello stack">
                <Field label="Nome progetto compose" help="Prefisso di container, reti e volumi. Deve essere diverso dagli stack esistenti." error={project && !projectOk ? 'Minuscole, numeri, - e _' : null}>
                  {(id) => <Input id={id} value={project} onChange={(e) => { setProject(e.target.value); setProjectTouched(true); }} placeholder="es. uptime-kuma" autoComplete="off" spellCheck={false} />}
                </Field>
              </Card>
            </>
          )}
          <div className="flex justify-end">
            <Button variant="primary" disabled={!canNext0} onClick={() => setStep(1)}>Avanti <ArrowRight /></Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <Card
            title="compose.yaml"
            subtitle="Scrivilo qui o carica un file. Percorsi relativi come ./data finiscono nella cartella dello stack."
            actions={
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-xs font-medium hover:bg-surface-3">
                <FileUp className="size-4" /> Carica file
                <input type="file" accept=".yml,.yaml,text/yaml,application/x-yaml" className="sr-only" onChange={(e) => { loadFile(e.target.files?.[0], 'compose'); e.target.value = ''; }} />
              </label>
            }
          >
            <textarea
              className="h-[42vh] min-h-64 w-full rounded-lg border border-line-strong bg-bg-2 p-3 font-mono text-xs leading-5 text-fg focus:border-accent focus:outline-none"
              value={compose}
              onChange={(e) => setCompose(e.target.value)}
              spellCheck={false}
              aria-label="Contenuto del compose"
            />
            <p className="mt-1.5 text-[11px] text-muted">{compose.length.toLocaleString(locale)} caratteri · indenta con spazi, non con tabulazioni</p>
          </Card>
          <Card
            title="Variabili (.env)"
            subtitle="Metti qui password e token e richiamali nel compose come ${NOME}: i valori non vengono mai rimostrati."
            actions={
              <>
                <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-fg-2 hover:bg-surface-3">
                  <FileUp className="size-4" /> Importa .env
                  <input type="file" accept=".env,text/plain" className="sr-only" onChange={(e) => { loadFile(e.target.files?.[0], 'env'); e.target.value = ''; }} />
                </label>
                <Button size="sm" variant="ghost" onClick={() => setEnv([...env, { key: '', value: '', saved: false }])}><Plus /> Aggiungi</Button>
              </>
            }
          >
            {env.length === 0 ? (
              <p className="text-xs text-muted">Nessuna variabile.</p>
            ) : (
              <div className="space-y-1.5">
                {env.map((r, i) => (
                  <div key={i} className="flex gap-1.5">
                    <Input className="w-2/5 font-mono text-xs" value={r.key} placeholder="NOME" aria-label="Nome variabile" disabled={r.saved} onChange={(e) => setEnv(env.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x)))} />
                    <Input
                      className="flex-1 font-mono text-xs"
                      type="password"
                      value={r.value}
                      placeholder={r.saved ? 'valore salvato — lascia vuoto per mantenerlo' : 'valore'}
                      aria-label={`Valore di ${r.key || 'variabile'}`}
                      autoComplete="new-password"
                      onChange={(e) => setEnv(env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    />
                    <Button variant="ghost" size="icon" aria-label={`Rimuovi ${r.key}`} onClick={() => setEnv(env.filter((_, j) => j !== i))}><X /></Button>
                  </div>
                ))}
                {!envOk && <p className="text-xs text-err">Nomi non validi o duplicati (lettere, numeri e _ ; non possono iniziare con un numero).</p>}
              </div>
            )}
          </Card>
          {check.isError && <ErrorBox error={check.error} />}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}><ArrowLeft /> Indietro</Button>
            <Button variant="primary" disabled={!compose.trim() || !envOk} loading={check.isPending} onClick={() => check.mutate()}>Verifica <ArrowRight /></Button>
          </div>
        </div>
      )}

      {step === 2 && pf && (
        <div className="space-y-4">
          <Card title="Servizi" subtitle={`${pf.update ? 'Aggiornamento' : 'Nuovo stack'} in ${pf.dir}`} bodyClassName="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[13px]">
                <thead className="border-y border-line text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Servizio</th>
                    <th className="px-3 py-2 font-medium">Porte</th>
                    <th className="px-4 py-2 font-medium">Mount</th>
                  </tr>
                </thead>
                <tbody>
                  {pf.services.map((s) => (
                    <tr key={s.name} className="border-b border-line/60 align-top last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{s.name}</div>
                        <div className="font-mono text-[11px] text-muted">{s.image ?? (s.build ? 'build locale' : '—')}</div>
                        {s.networkMode && <Badge className="mt-1">rete {s.networkMode}</Badge>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{s.ports.join('\n') || '—'}</td>
                      <td className="px-4 py-2 font-mono text-[11px] break-all whitespace-pre-line text-fg-2">{s.mounts.join('\n') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Controlli" subtitle={pf.findings.length ? undefined : 'Nessun problema rilevato.'}>
            <ul className="space-y-1.5">
              {pf.findings.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <Badge tone={LEVEL[f.level].tone} className="shrink-0">{LEVEL[f.level].label}</Badge>
                  <span className="min-w-0 whitespace-pre-wrap">
                    {f.service && <b className="font-mono text-xs">{f.service}: </b>}
                    {f.message}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {pf.ok ? (
            <Card>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Immagini" help="«Sempre» scarica comunque l’ultima versione dei tag (es. latest).">
                  {(id) => (
                    <Select id={id} value={pull} onChange={(e) => setPull(e.target.value as 'missing' | 'always')}>
                      <option value="missing">Scarica solo se mancanti</option>
                      <option value="always">Scarica sempre l’ultima versione</option>
                    </Select>
                  )}
                </Field>
                {pf.needsConfirm && (
                  <Field label={`Ci sono avvisi: per confermare digita ${project}`}>
                    {(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />}
                  </Field>
                )}
              </div>
            </Card>
          ) : (
            <ErrorBox error={{ message: `${blockingCount} problem${blockingCount === 1 ? 'a bloccante' : 'i bloccanti'}: correggi il compose o la posizione e verifica di nuovo.` }} />
          )}
          {deploy.isError && <ErrorBox error={deploy.error} />}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}><ArrowLeft /> Modifica</Button>
            <Button variant="primary" disabled={!pf.ok || (pf.needsConfirm && confirm !== project)} loading={deploy.isPending} onClick={() => deploy.mutate()}>
              <Play /> {pf.update ? 'Applica modifiche' : 'Crea e avvia'}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && job && (
        <div className="space-y-4">
          <JobOutput id={job.id} onDone={(j) => { void qc.invalidateQueries({ queryKey: ['stacks'] }); void qc.invalidateQueries({ queryKey: ['containers'] }); if (j.status === 'ok') toast('ok', `Stack ${project} avviato`); }} />
          <p className="text-xs text-muted">I file sono già salvati in {fullPath}. Se l’avvio fallisce puoi correggere il compose da «Modifica compose» nello stack.</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Chiudi</Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
