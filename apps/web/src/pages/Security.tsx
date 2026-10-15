import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MonitorSmartphone, ScrollText, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cx, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Tabs, useToast } from '../components/ui';
import { api, type Role } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, dateTime } from '../lib/format';

type Tab = 'account' | 'users' | 'audit' | 'posture';

export function SecurityPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('account');
  return (
    <div>
      <PageHeader title="Sicurezza" description="Account, utenti, sessioni e registro delle operazioni." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'account', label: 'Il mio account' },
          ...(isAdmin
            ? [
                { id: 'users' as const, label: 'Utenti' },
                { id: 'audit' as const, label: 'Audit log' },
              ]
            : []),
          { id: 'posture', label: 'Modello di sicurezza' },
        ]}
      />
      <div className="mt-4">
        {tab === 'account' && <Account />}
        {tab === 'users' && <UsersTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'posture' && <Posture />}
      </div>
    </div>
  );
}

function Account() {
  const toast = useToast();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ id: string; current: boolean; createdAt: number; lastSeen: number; ip: string; userAgent: string }[]>('/auth/sessions'),
  });
  const pw = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', body: { current, next } }),
    onSuccess: () => {
      toast('ok', 'Password aggiornata. Le altre sessioni sono state chiuse.');
      setCurrent('');
      setNext('');
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const revoke = useMutation({
    mutationFn: () => api('/auth/sessions/revoke-others', { method: 'POST' }),
    onSuccess: () => {
      toast('ok', 'Altre sessioni chiuse');
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Cambia password" icon={<KeyRound />}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            pw.mutate();
          }}
        >
          <Field label="Password attuale">{(id) => <Input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />}</Field>
          <Field label="Nuova password" help="Almeno 12 caratteri.">
            {(id) => <Input id={id} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={12} />}
          </Field>
          {pw.isError && <ErrorBox error={pw.error} compact />}
          <Button type="submit" variant="primary" loading={pw.isPending}>
            Aggiorna password
          </Button>
        </form>
      </Card>
      <Card
        title="Sessioni attive"
        icon={<MonitorSmartphone />}
        actions={
          <Button size="sm" variant="ghost" onClick={() => revoke.mutate()} loading={revoke.isPending}>
            Chiudi le altre
          </Button>
        }
      >
        {sessions.isError && <ErrorBox error={sessions.error} compact />}
        {!sessions.data && !sessions.isError && <Skeleton className="h-20" />}
        <ul className="space-y-2">
          {sessions.data?.map((s) => (
            <li key={s.id} className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg-2">{s.ip}</span>
                {s.current && <Badge tone="ok">questa sessione</Badge>}
                <span className="ml-auto text-muted">attiva {ago(s.lastSeen)}</span>
              </div>
              <div className="mt-0.5 truncate text-muted" title={s.userAgent}>{s.userAgent}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

type UserRow = { id: string; username: string; role: Role; disabled: boolean; createdAt: number; lastLoginAt: number | null };

function UsersTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' as Role });
  const create = useMutation({
    mutationFn: () => api('/users', { method: 'POST', body: form }),
    onSuccess: () => {
      toast('ok', `Utente ${form.username} creato`);
      setAdding(false);
      setForm({ username: '', password: '', role: 'viewer' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ role: Role; disabled: boolean }> }) => api(`/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e: Error) => toast('err', e.message),
  });
  return (
    <Card
      title="Utenti"
      icon={<Users />}
      subtitle="Ruoli: amministratore (tutto) e sola lettura (stato e metriche, niente log, variabili o azioni)."
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <UserPlus /> Nuovo utente
        </Button>
      }
      bodyClassName="!px-0"
    >
      {users.isError && <ErrorBox error={users.error} />}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-y border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Utente</th>
              <th className="px-3 py-2 font-medium">Ruolo</th>
              <th className="px-3 py-2 font-medium">Ultimo accesso</th>
              <th className="px-4 py-2 text-right font-medium">Stato</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2 font-medium">
                  {u.username} {u.id === user?.id && <Badge tone="accent">tu</Badge>}
                </td>
                <td className="px-3 py-2">
                  <Select
                    className="h-8 w-auto text-xs"
                    value={u.role}
                    disabled={u.id === user?.id}
                    onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as Role } })}
                    aria-label={`Ruolo di ${u.username}`}
                  >
                    <option value="admin">Amministratore</option>
                    <option value="viewer">Sola lettura</option>
                  </Select>
                </td>
                <td className="px-3 py-2 text-xs text-muted">{u.lastLoginAt ? ago(u.lastLoginAt) : 'mai'}</td>
                <td className="px-4 py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={u.id === user?.id}
                    onClick={() => patch.mutate({ id: u.id, body: { disabled: !u.disabled } })}
                    className={cx(u.disabled && 'text-warn')}
                  >
                    {u.disabled ? 'Disabilitato · riattiva' : 'Attivo · disabilita'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Nuovo utente"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Annulla
            </Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}>
              Crea
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Nome utente">{(id) => <Input id={id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />}</Field>
          <Field label="Password iniziale" help="Almeno 12 caratteri.">
            {(id) => <Input id={id} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />}
          </Field>
          <Field label="Ruolo">
            {(id) => (
              <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                <option value="viewer">Sola lettura</option>
                <option value="admin">Amministratore</option>
              </Select>
            )}
          </Field>
          {create.isError && <ErrorBox error={create.error} compact />}
        </div>
      </Dialog>
    </Card>
  );
}

type AuditRow = { id: number; ts: number; username: string | null; action: string; target: string | null; result: 'ok' | 'denied' | 'error'; ip: string | null; details: string | null };

function AuditTab() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditRow[]>('/audit?limit=200'), refetchInterval: 30_000 });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-60" />;
  if (q.data.length === 0) return <Empty icon={<ScrollText />} title="Nessuna operazione registrata" />;
  return (
    <Card bodyClassName="!p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Quando</th>
              <th className="px-3 py-2 font-medium">Utente</th>
              <th className="px-3 py-2 font-medium">Operazione</th>
              <th className="px-3 py-2 font-medium">Oggetto</th>
              <th className="px-3 py-2 font-medium">Esito</th>
              <th className="px-4 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((a) => (
              <tr key={a.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2 text-xs whitespace-nowrap text-muted tabular">{dateTime(a.ts)}</td>
                <td className="px-3 py-2">{a.username ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{a.action}</td>
                <td className="max-w-[240px] truncate px-3 py-2 text-fg-2" title={a.details ?? undefined}>{a.target ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge tone={a.result === 'ok' ? 'ok' : a.result === 'denied' ? 'warn' : 'err'}>{a.result === 'ok' ? 'ok' : a.result === 'denied' ? 'negato' : 'errore'}</Badge>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted">{a.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Posture() {
  const items = [
    ['Accesso', 'Solo LAN (192.168.222.0/24), nessuna porta esposta su Internet. HTTPS con certificato locale.'],
    ['Autenticazione', 'Password con scrypt, sessioni opache con hash nel DB, cookie HttpOnly + Secure + SameSite=Strict, scadenza per inattività.'],
    ['CSRF', 'Token per sessione obbligatorio su ogni modifica + verifica dell’Origin.'],
    ['Brute force', 'Blocco persistente per IP e per utente dopo tentativi falliti; rate limit globale.'],
    ['Permessi', 'Controllo del ruolo nel backend su ogni endpoint. I viewer non vedono log, variabili d’ambiente, comandi o etichette.'],
    ['Docker', 'Il socket Docker è montato solo nel container gigi-agent, senza porte di rete, raggiungibile da gigi-api tramite socket Unix. Solo operazioni nominate (elenco, inspect, log, start/stop/restart). L’agent resta equivalente a root: è isolato, non “innocuo”.'],
    ['Segreti', 'Credenziali delle integrazioni cifrate AES-256-GCM, chiave master in un file separato dal database. Mai restituite al browser né scritte nei log.'],
    ['SSRF', 'Connettori limitati a http/https verso le reti consentite; redirect non seguiti; timeout e limite di dimensione delle risposte.'],
    ['Audit', 'Login, modifiche utenti, integrazioni e azioni Docker registrate con esito e IP (retention 180 giorni).'],
  ];
  return (
    <Card title="Come è protetto GIGI OS" icon={<ShieldCheck />}>
      <dl className="divide-y divide-line">
        {items.map(([k, v]) => (
          <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[160px_1fr]">
            <dt className="text-xs font-medium text-fg-2">{k}</dt>
            <dd className="text-xs leading-relaxed text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
