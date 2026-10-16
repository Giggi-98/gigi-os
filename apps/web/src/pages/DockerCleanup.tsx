// Eliminazione di immagini, volumi, reti e container fermi, più il riepilogo dello spazio (D-024).
// Ogni eliminazione mostra l'elenco esatto, chiede di scrivere ELIMINA e finisce nell'audit log.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Box, Database, HardDrive, Layers, Network, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Skeleton, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { bytes } from '../lib/format';
import { useContainers } from '../lib/queries';

export type CleanupKind = 'image' | 'volume' | 'network' | 'container';
export type CleanupItem = { id: string; label: string; detail?: ReactNode; warn?: string | null };

export type ImageRow = { id: string; tags: string[]; size: number; created: number; containers: string[]; dangling: boolean; local: boolean };
export type VolumeRow = { name: string; driver: string; mountpoint: string; project: string | null; containers: string[] };
export type NetworkRow = { id: string; name: string; driver: string; subnet: string | null; containers: string[] };

export const useImages = () => useQuery({ queryKey: ['images'], queryFn: () => api<ImageRow[]>('/docker/images') });
export const useVolumes = () => useQuery({ queryKey: ['volumes'], queryFn: () => api<VolumeRow[]>('/docker/volumes') });
export const useNetworks = () => useQuery({ queryKey: ['networks'], queryFn: () => api<NetworkRow[]>('/docker/networks') });

const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);
export const isOwn = (name: string) => name.startsWith('gigi-os_');
export const removableNetwork = (n: NetworkRow) => !BUILTIN_NETWORKS.has(n.name) && !isOwn(n.name) && n.containers.length === 0;

export const imageItem = (i: ImageRow): CleanupItem => ({
  id: i.id,
  label: i.tags.join(', ') || `${i.id.slice(7, 19)} (senza tag)`,
  detail: bytes(i.size),
  warn: i.local && !i.dangling ? 'costruita in locale: non si può riscaricare' : null,
});

const COPY: Record<CleanupKind, { one: string; many: string; impact: string }> = {
  image: {
    one: 'immagine',
    many: 'immagini',
    impact: 'Le immagini vengono rimosse dal disco con tutti i loro tag. Quelle dei registry si possono riscaricare; quelle costruite in locale no.',
  },
  volume: { one: 'volume', many: 'volumi', impact: 'I dati contenuti nei volumi vengono cancellati in modo definitivo. Non esiste un cestino.' },
  network: { one: 'rete', many: 'reti', impact: 'Vengono rimosse solo reti senza container collegati. Uno stack compose le ricrea al prossimo avvio.' },
  container: {
    one: 'container',
    many: 'container',
    impact: 'Il container fermo viene rimosso insieme al suo filesystem interno. I volumi restano (si eliminano dalla scheda Volumi). Per ricrearlo servono il suo compose o il comando originale.',
  },
};

/** Dialog di conferma con elenco selezionabile. `initial` = id preselezionati (default: tutti). */
export function DeleteDialog({ kind, items, initial, onClose, onDone }: { kind: CleanupKind; items: CleanupItem[]; initial?: string[]; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sel, setSel] = useState(() => new Set(initial ?? items.map((i) => i.id)));
  const [typed, setTyped] = useState('');
  const [failed, setFailed] = useState<{ id: string; error?: string }[]>([]);
  const copy = COPY[kind];
  const m = useMutation({
    mutationFn: () => api<{ ok: number; failed: number; results: { id: string; ok: boolean; error?: string }[] }>('/docker/cleanup', { method: 'POST', body: { kind, ids: [...sel], confirm: typed } }),
    onSuccess: (r) => {
      for (const k of ['images', 'volumes', 'networks', 'containers', 'docker-df', 'docker-info', 'stacks']) void qc.invalidateQueries({ queryKey: [k] });
      if (r.ok) toast('ok', `Eliminat${r.ok === 1 ? 'o' : 'i'} ${r.ok} ${r.ok === 1 ? copy.one : copy.many} — registrato nell’audit log`);
      if (r.failed) {
        setFailed(r.results.filter((x) => !x.ok));
        setSel(new Set(r.results.filter((x) => !x.ok).map((x) => x.id)));
        setTyped('');
      } else {
        onClose();
        onDone?.();
      }
    },
  });
  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const n = sel.size;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Eliminare ${n} ${n === 1 ? copy.one : copy.many}?`}
      description={copy.impact}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="danger" disabled={typed !== 'ELIMINA' || n === 0} loading={m.isPending} onClick={() => m.mutate()}>
            <Trash2 /> Elimina {n}
          </Button>
        </>
      }
    >
      <ul className="mb-4 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line p-1.5">
        {items.map((i) => {
          const err = failed.find((f) => f.id === i.id)?.error;
          return (
            <li key={i.id}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--err)]" checked={sel.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">{i.label}</span>
                  {i.warn && <span className="block text-[11px] text-warn">{i.warn}</span>}
                  {err && <span className="block text-[11px] text-err">{err}</span>}
                </span>
                {i.detail && <span className="shrink-0 text-xs text-muted tabular">{i.detail}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <Field label="Per confermare scrivi ELIMINA">{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}</Field>
      {m.isError && <div className="mt-3"><ErrorBox error={m.error} compact /></div>}
    </Dialog>
  );
}

type Df = {
  images: { size: number };
  volumes: { count: number; size: number; reclaimable: number; sizes: Record<string, number> };
  buildCache: { count: number; size: number; reclaimable: number };
  containers: { stopped: number; size: number };
};

/** Scheda "Spazio": quanto occupa Docker e cosa si può liberare, con azioni guidate. */
export function SpaceTab() {
  const { isAdmin } = useAuth();
  const df = useQuery({ queryKey: ['docker-df'], queryFn: () => api<Df>('/docker/df'), staleTime: 60_000 });
  const images = useImages();
  const volumes = useVolumes();
  const networks = useNetworks();
  const containers = useContainers();
  const [dialog, setDialog] = useState<{ kind: CleanupKind; items: CleanupItem[]; initial?: string[] } | null>(null);
  const [prune, setPrune] = useState(false);

  const unusedImages = (images.data ?? []).filter((i) => i.containers.length === 0);
  const dangling = unusedImages.filter((i) => i.dangling);
  const orphanVolumes = (volumes.data ?? []).filter((v) => v.containers.length === 0 && !isOwn(v.name));
  const freeNetworks = (networks.data ?? []).filter(removableNetwork);
  const stopped = (containers.data ?? []).filter((c) => c.state !== 'running' && c.controllable);
  const sum = (l: ImageRow[]) => l.reduce((a, i) => a + i.size, 0);
  const volSize = (name: string) => df.data?.volumes.sizes[name] ?? -1;

  const row = (icon: ReactNode, title: string, value: ReactNode, sub: ReactNode, action?: ReactNode) => (
    <div className="flex flex-wrap items-center gap-3 border-b border-line/60 py-3 last:border-0">
      <span className="text-muted [&>svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-xs text-muted">{sub}</div>
      </div>
      <div className="text-right text-[13px] tabular">{value}</div>
      {isAdmin && <div className="w-full sm:w-auto">{action}</div>}
    </div>
  );

  if (images.isError) return <ErrorBox error={images.error} />;
  if (!images.data || !volumes.data || !networks.data) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-4">
      <Card title="Spazio occupato da Docker" subtitle={df.data ? `Immagini ${bytes(df.data.images.size)} · cache di build ${bytes(df.data.buildCache.size)}` : 'Calcolo in corso…'}>
        {row(
          <Layers />,
          'Immagini senza tag (dangling)',
          bytes(sum(dangling)),
          `${dangling.length} residui di build e aggiornamenti: sicure da eliminare`,
          <Button size="sm" disabled={!dangling.length} onClick={() => setDialog({ kind: 'image', items: dangling.map(imageItem) })}><Trash2 /> Elimina</Button>,
        )}
        {row(
          <Layers />,
          'Immagini non usate da alcun container',
          bytes(sum(unusedImages)),
          `${unusedImages.length} immagini. Quelle costruite in locale (es. versioni di rollback) sono escluse dalla preselezione.`,
          <Button
            size="sm"
            disabled={!unusedImages.length}
            onClick={() => setDialog({ kind: 'image', items: unusedImages.map(imageItem), initial: unusedImages.filter((i) => !i.local || i.dangling).map((i) => i.id) })}
          >
            <Trash2 /> Scegli…
          </Button>,
        )}
        {row(
          <Database />,
          'Volumi orfani',
          df.data ? bytes(orphanVolumes.reduce((a, v) => a + Math.max(0, volSize(v.name)), 0)) : '—',
          orphanVolumes.length ? `${orphanVolumes.length} volumi senza container: possono contenere dati ancora utili` : 'Nessun volume orfano',
          <Button
            size="sm"
            disabled={!orphanVolumes.length}
            onClick={() => setDialog({ kind: 'volume', items: orphanVolumes.map((v) => ({ id: v.name, label: v.name, detail: volSize(v.name) >= 0 ? bytes(volSize(v.name)) : undefined })), initial: [] })}
          >
            <Trash2 /> Scegli…
          </Button>,
        )}
        {row(
          <Network />,
          'Reti inutilizzate',
          `${freeNetworks.length}`,
          'Reti create dagli stack senza container collegati',
          <Button size="sm" disabled={!freeNetworks.length} onClick={() => setDialog({ kind: 'network', items: freeNetworks.map((n) => ({ id: n.id, label: n.name, detail: n.driver })) })}><Trash2 /> Elimina</Button>,
        )}
        {row(
          <Box />,
          'Container fermi',
          `${stopped.length}`,
          'Container non in esecuzione e non protetti',
          <Button size="sm" disabled={!stopped.length} onClick={() => setDialog({ kind: 'container', items: stopped.map((c) => ({ id: c.name, label: c.name, detail: c.image })), initial: [] })}><Trash2 /> Scegli…</Button>,
        )}
        {row(
          <HardDrive />,
          'Cache di build',
          df.data ? bytes(df.data.buildCache.reclaimable) : '—',
          df.data ? `${df.data.buildCache.count} voci, ${bytes(df.data.buildCache.size)} in totale. Le build successive (es. GIGI OS, Armony, Apollo) saranno più lente.` : 'Calcolo in corso…',
          <Button size="sm" disabled={!df.data?.buildCache.reclaimable} onClick={() => setPrune(true)}><Trash2 /> Svuota</Button>,
        )}
        {df.isError && <ErrorBox error={df.error} compact />}
      </Card>
      {dialog && <DeleteDialog {...dialog} onClose={() => setDialog(null)} />}
      {prune && <PruneCacheDialog onClose={() => setPrune(false)} />}
    </div>
  );
}

function PruneCacheDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ reclaimed: number }>('/docker/build-cache/prune', { method: 'POST', body: { confirm: typed } }),
    onSuccess: (r) => {
      toast('ok', `Cache di build svuotata: liberati ${bytes(r.reclaimed)}`);
      void qc.invalidateQueries({ queryKey: ['docker-df'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Svuotare la cache di build?"
      description="Elimina i layer intermedi non in uso. Nessun container o immagine taggata viene toccato, ma la prossima build ripartirà da zero."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="danger" disabled={typed !== 'SVUOTA'} loading={m.isPending} onClick={() => m.mutate()}>Svuota</Button>
        </>
      }
    >
      <Field label="Per confermare scrivi SVUOTA">{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
      {m.isError && <div className="mt-3"><ErrorBox error={m.error} compact /></div>}
    </Dialog>
  );
}

export function LocalBadge() {
  return (
    <Badge tone="warn">
      <AlertTriangle className="size-3" /> locale
    </Badge>
  );
}
