import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, DatabaseBackup, Download, KeyRound, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, useToast } from '../components/ui';
import { api } from '../lib/api';
import { ago, bytes, dateTime } from '../lib/format';

type Settings = { enabled: boolean; hour: string; keep: number; includeKey: boolean };
type Data = { settings: Settings; backups: { name: string; size: number; created: number }[] };

export function BackupPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api<Data>('/backups'), refetchInterval: 30_000 });
  const [form, setForm] = useState<Settings | null>(null);
  const [del, setDel] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['backups'] });
  const run = useMutation({
    mutationFn: () => api<{ name: string; size: number }>('/backups', { method: 'POST' }),
    onSuccess: (r) => { toast('ok', `Backup creato: ${bytes(r.size)}`); refresh(); },
    onError: (e: Error) => toast('err', e.message),
  });
  const save = useMutation({
    mutationFn: (s: Settings) => api<Settings>('/backups/settings', { method: 'PUT', body: s }),
    onSuccess: (s) => { setForm(s); toast('ok', 'Impostazioni salvate'); refresh(); },
    onError: (e: Error) => toast('err', e.message),
  });
  const remove = useMutation({
    mutationFn: (n: string) => api(`/backups/${encodeURIComponent(n)}`, { method: 'DELETE' }),
    onSuccess: () => { toast('ok', 'Backup eliminato'); setDel(null); refresh(); },
  });

  return (
    <div>
      <PageHeader
        title="Backup"
        description="Copia coerente dei database e della configurazione di GIGI OS, verificata con integrity_check e compressa."
        actions={<Button size="sm" variant="primary" onClick={() => run.mutate()} loading={run.isPending}><Play /> Esegui ora</Button>}
      />
      {q.isError && <ErrorBox error={q.error} />}
      {!q.data && !q.isError && <Skeleton className="h-60" />}
      {q.data && form && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Pianificazione" icon={<DatabaseBackup />}>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                Backup automatico giornaliero
              </label>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Orario">{(id) => <Input id={id} type="time" value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })} disabled={!form.enabled} />}</Field>
                <Field label="Copie da tenere">
                  {(id) => (
                    <Select id={id} value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) })}>
                      {[3, 7, 14, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  )}
                </Field>
              </div>
              <label className="flex items-start gap-2 text-[13px]">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--warn)]" checked={form.includeKey} onChange={(e) => setForm({ ...form, includeKey: e.target.checked })} />
                <span>
                  Includi la chiave master
                  <span className="block text-xs text-muted">Senza, il backup non basta a recuperare le credenziali salvate; con, chi ha il file può leggerle.</span>
                </span>
              </label>
              <Button variant="primary" onClick={() => save.mutate(form)} loading={save.isPending}>Salva</Button>
            </div>
          </Card>

          <Card title={`Backup disponibili (${q.data.backups.length})`} className="lg:col-span-2" bodyClassName="!px-0">
            {q.data.backups.length === 0 ? (
              <Empty icon={<DatabaseBackup />} title="Nessun backup ancora" action={<Button size="sm" onClick={() => run.mutate()} loading={run.isPending}><Play /> Crea il primo</Button>} />
            ) : (
              <ul className="divide-y divide-line">
                {q.data.backups.map((b, i) => (
                  <li key={b.name} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{b.name}</div>
                      <div className="text-[11px] text-muted">{dateTime(b.created)} · {ago(b.created)}</div>
                    </div>
                    {i === 0 && <Badge tone="ok">più recente</Badge>}
                    <span className="text-xs text-muted tabular">{bytes(b.size)}</span>
                    <a href={`/api/v1/backups/${encodeURIComponent(b.name)}/download`}><Button size="icon" variant="ghost" aria-label={`Scarica ${b.name}`}><Download /></Button></a>
                    <Button size="icon" variant="ghost" className="hover:text-err" onClick={() => setDel(b.name)} aria-label={`Elimina ${b.name}`}><Trash2 /></Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Cosa contiene e come ripristinare" className="lg:col-span-3">
            <div className="grid gap-4 text-xs text-muted md:grid-cols-2">
              <div className="space-y-1.5">
                <p><b className="text-fg-2">Contenuto:</b> database di GIGI OS (utenti, integrazioni cifrate, regole, audit, layout), database del motore media, <span className="font-mono">.env</span>, <span className="font-mono">compose.yaml</span>{form.includeKey && ', chiave master'}.</p>
                <p><b className="text-fg-2">Non contiene:</b> i tuoi media, i download, i dati di Jellyfin, Armony o Home Assistant (hanno i loro percorsi e i loro backup).</p>
                <p className="flex items-start gap-1.5 text-warn"><AlertTriangle className="mt-px size-3.5 shrink-0" /> I backup stanno sullo stesso disco del server: scaricane periodicamente uno su un altro dispositivo.</p>
                {!form.includeKey && <p className="flex items-start gap-1.5"><KeyRound className="mt-px size-3.5 shrink-0" /> Conserva a parte una copia di <span className="font-mono">/opt/gigi-os/secrets/master.key</span>.</p>}
              </div>
              <ol className="list-decimal space-y-1 pl-4">
                <li><span className="font-mono">cd /opt/gigi-os && docker compose stop</span></li>
                <li><span className="font-mono">tar -xzf backups/&lt;file&gt;.tar.gz -C /tmp/ripristino</span></li>
                <li>Copia <span className="font-mono">data/gigi.sqlite</span> in <span className="font-mono">data/</span> e <span className="font-mono">data/media.sqlite</span> in <span className="font-mono">data/media/</span> (proprietario 1000)</li>
                <li>Se serve, ripristina <span className="font-mono">secrets/master.key</span> (permessi 400, proprietario 1000)</li>
                <li><span className="font-mono">docker compose up -d</span></li>
              </ol>
            </div>
          </Card>
        </div>
      )}
      <Dialog
        open={!!del}
        onClose={() => setDel(null)}
        title="Eliminare questo backup?"
        description={del ?? ''}
        footer={<><Button variant="ghost" onClick={() => setDel(null)}>Annulla</Button><Button variant="danger" onClick={() => del && remove.mutate(del)} loading={remove.isPending}><Trash2 /> Elimina</Button></>}
      >
        <p className="text-xs text-muted">L’operazione è definitiva e viene registrata nell’audit log.</p>
      </Dialog>
    </div>
  );
}
