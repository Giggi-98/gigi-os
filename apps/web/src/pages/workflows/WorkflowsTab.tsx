// Scheda «Flussi» di Automazioni (D-041): elenco, modelli pronti, conferme in attesa.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCheck, Workflow } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, cx, Dialog, Empty, ErrorBox, Field, Input, Skeleton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ago, dateTime } from '../../lib/format';
import { RUN_STATUS, type Approval, type Catalog, type RunStatus, type WorkflowRow } from './types';
import { NodeIcon } from './icons';

export function WorkflowsTab() {
  const { isAdmin } = useAuth();
  return (
    <div className="space-y-4">
      <ApprovalsCard />
      {isAdmin ? <WorkflowList /> : <Card><p className="text-xs text-muted">Creare e modificare i flussi è riservato agli amministratori. Qui sopra trovi le conferme che ti chiedono.</p></Card>}
    </div>
  );
}

function WorkflowList() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowRow[]>('/workflows'), refetchInterval: 15_000 });
  const catalog = useQuery({ queryKey: ['workflow-catalog'], queryFn: () => api<Catalog>('/workflows/catalog'), staleTime: Infinity });
  const [creating, setCreating] = useState(false);
  const [template, setTemplate] = useState('borollo');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/workflows', { method: 'POST', body: { template, name: name.trim() || undefined } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      nav(`/automazioni/flussi/${r.id}`);
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const toggle = useMutation({
    mutationFn: (w: WorkflowRow) => api(`/workflows/${w.id}`, { method: 'PUT', body: { enabled: !w.enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (e: Error) => toast('err', e.message),
  });
  const typeOf = (t: string) => catalog.data?.nodes.find((n) => n.type === t);
  return (
    <Card
      title="Flussi"
      icon={<Workflow />}
      subtitle="Collega ricezioni (webhook, API, GitHub, eventi, orari, Telegram), logica e azioni in un editor grafico."
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus /> Nuovo flusso
        </Button>
      }
      bodyClassName="!p-0"
    >
      {list.isError && <div className="p-4"><ErrorBox error={list.error} compact /></div>}
      {!list.data && !list.isError && <Skeleton className="m-4 h-24" />}
      {list.data?.length === 0 && (
        <Empty icon={<Workflow />} title="Nessun flusso" action={<Button size="sm" onClick={() => setCreating(true)}><Plus /> Crea il primo</Button>}>
          Parti da un modello: «Borollo: film confermato» è già pronto da adattare.
        </Empty>
      )}
      {!!list.data?.length && (
        <ul className="divide-y divide-line">
          {list.data.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <label className="flex items-center" title={w.enabled ? 'Attivo: clic per spegnere' : 'Spento: clic per attivare'}>
                <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={w.enabled} onChange={() => toggle.mutate(w)} aria-label={`${w.enabled ? 'Spegni' : 'Attiva'} ${w.name}`} />
              </label>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => nav(`/automazioni/flussi/${w.id}`)}>
                <div className="truncate text-[13px] font-medium text-fg hover:text-accent">{w.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {w.triggers.map((t) => (
                    <span key={t.name} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5">
                      <NodeIcon name={typeOf(t.type)?.icon ?? 'Zap'} className="size-3" /> {t.name}
                    </span>
                  ))}
                  <span>· {w.nodes} blocchi</span>
                </div>
              </button>
              <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted">
                {w.week.waiting > 0 && <Badge tone="warn">{w.week.waiting} in attesa</Badge>}
                {w.week.errors > 0 && <Badge tone="err">{w.week.errors} errori in 7 giorni</Badge>}
                {w.lastRun ? (
                  <span title={w.lastRun.error ?? undefined}>
                    <Badge tone={RUN_STATUS[w.lastRun.status as RunStatus]?.[1] ?? 'idle'}>{RUN_STATUS[w.lastRun.status as RunStatus]?.[0] ?? w.lastRun.status}</Badge> {ago(w.lastRun.at)}
                  </span>
                ) : (
                  <span>mai eseguito</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Nuovo flusso"
        description="Si crea spento: lo adatti nell’editor e lo attivi quando è pronto."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Annulla</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}>Crea e apri</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Modello" className="space-y-2">
            {catalog.data?.templates.map((t) => (
              <label key={t.id} className={cx('flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[13px]', template === t.id ? 'border-accent/60 bg-accent-soft/40' : 'border-line hover:border-line-strong')}>
                <input type="radio" name="wf-template" className="mt-0.5 size-4 [--check:var(--accent)]" checked={template === t.id} onChange={() => setTemplate(t.id)} />
                <span>
                  <span className="font-medium">{t.name}</span>
                  <span className="block text-xs text-muted">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
          <Field label="Nome (facoltativo)">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
        </div>
      </Dialog>
    </Card>
  );
}

/** Conferme chieste dai flussi: le stesse arrivano su Telegram, la prima risposta vale. */
export function ApprovalsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['workflow-approvals'], queryFn: () => api<Approval[]>('/workflow-approvals'), refetchInterval: 15_000 });
  const decide = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: number | null }) => api<{ choice: string | null }>(`/workflow-approvals/${id}`, { method: 'POST', body: { choice } }),
    onSuccess: (r) => {
      toast('ok', r.choice ? `Confermato: ${r.choice}` : 'Rifiutato');
      void qc.invalidateQueries({ queryKey: ['workflow-approvals'] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (e: Error) => {
      toast('err', e.message);
      void qc.invalidateQueries({ queryKey: ['workflow-approvals'] });
    },
  });
  if (!q.data?.length) return null;
  return (
    <Card title="Conferme in attesa" icon={<UserCheck />} subtitle="Le ricevi anche su Telegram: vale la prima risposta.">
      <ul className="space-y-3">
        {q.data.map((a) => (
          <li key={a.id} className="rounded-xl border border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
              <span className="font-medium text-fg-2">{a.workflow}</span>
              <span>· {ago(a.createdAt)}</span>
              {a.expiresAt && <span>· scade {dateTime(a.expiresAt)}</span>}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[13px]">{a.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {a.options.map((o, i) => (
                <Button key={i} size="sm" variant={i === 0 ? 'primary' : 'secondary'} onClick={() => decide.mutate({ id: a.id, choice: i })} disabled={decide.isPending}>
                  {o}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: a.id, choice: null })} disabled={decide.isPending}>
                Rifiuta
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
