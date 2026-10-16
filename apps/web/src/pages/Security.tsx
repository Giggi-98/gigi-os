import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MonitorSmartphone, ScrollText, ShieldCheck, ShieldOff, Smartphone, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cx, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Tabs, useToast } from '../components/ui';
import { api, ROLE_LABEL, type Role } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, dateTime } from '../lib/format';
import { CodeInput, MfaEnroll, RecoveryCodes } from './MfaSetup';

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
      <MfaCard />
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

function MfaCard() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['mfa'], queryFn: () => api<{ enabled: boolean; required: boolean; recoveryLeft: number }>('/auth/mfa') });
  const [dialog, setDialog] = useState<'enroll' | 'recovery' | 'disable' | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const close = () => {
    setDialog(null);
    setCode('');
    setPassword('');
    setCodes(null);
  };
  const recovery = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/auth/mfa/recovery', { method: 'POST', body: { code } }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      void qc.invalidateQueries({ queryKey: ['mfa'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api<{ setupRequired: boolean }>('/auth/mfa/disable', { method: 'POST', body: { password, code } }),
    onSuccess: () => {
      close();
      toast('info', 'Verifica in due passaggi disattivata');
      void qc.invalidateQueries({ queryKey: ['mfa'] });
      void refresh();
    },
  });
  const m = q.data;
  return (
    <Card
      title="Verifica in due passaggi"
      icon={<Smartphone />}
      subtitle={m?.required ? 'Obbligatoria per il tuo ruolo.' : 'Facoltativa per il tuo ruolo, consigliata.'}
      className="lg:col-span-2"
    >
      {q.isError && <ErrorBox error={q.error} compact />}
      {!m && !q.isError && <Skeleton className="h-12" />}
      {m && (
        <div className="flex flex-wrap items-center gap-3">
          {m.enabled ? <Badge tone="ok">attiva</Badge> : <Badge tone="warn">non attiva</Badge>}
          {m.enabled && (
            <span className={cx('text-xs', m.recoveryLeft <= 3 ? 'text-warn' : 'text-muted')}>
              {m.recoveryLeft} codici di recupero disponibili
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {!m.enabled && (
              <Button size="sm" variant="primary" onClick={() => setDialog('enroll')}>
                <ShieldCheck /> Attiva
              </Button>
            )}
            {m.enabled && (
              <>
                <Button size="sm" onClick={() => setDialog('recovery')}>
                  <KeyRound /> Nuovi codici di recupero
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDialog('disable')}>
                  <ShieldOff /> {m.required ? 'Cambia telefono' : 'Disattiva'}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      <Dialog open={dialog === 'enroll'} onClose={close} title="Attiva la verifica in due passaggi">
        {dialog === 'enroll' && (
          <MfaEnroll
            onDone={() => {
              close();
              toast('ok', 'Verifica in due passaggi attiva. Le altre sessioni sono state chiuse.');
              void qc.invalidateQueries({ queryKey: ['mfa'] });
              void qc.invalidateQueries({ queryKey: ['sessions'] });
              void refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={dialog === 'recovery'}
        onClose={close}
        title="Nuovi codici di recupero"
        description={codes ? undefined : 'I codici attuali smetteranno di funzionare.'}
        footer={
          codes ? (
            <Button variant="primary" onClick={close}>
              Fatto
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Annulla
              </Button>
              <Button variant="primary" onClick={() => recovery.mutate()} loading={recovery.isPending} disabled={code.length !== 6}>
                Genera
              </Button>
            </>
          )
        }
      >
        {codes ? (
          <RecoveryCodes codes={codes} />
        ) : (
          <div className="space-y-3">
            <Field label="Codice a 6 cifre dell’app">{(id) => <CodeInput id={id} value={code} onChange={setCode} />}</Field>
            {recovery.isError && <ErrorBox error={recovery.error} compact />}
          </div>
        )}
      </Dialog>
      <Dialog
        open={dialog === 'disable'}
        onClose={close}
        title={m?.required ? 'Cambia telefono' : 'Disattiva la verifica in due passaggi'}
        description={
          m?.required
            ? 'La configurazione attuale viene rimossa e GIGI OS ti chiede subito di collegare il nuovo telefono.'
            : 'Dopo, per accedere basterà la password.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Annulla
            </Button>
            <Button variant="danger" onClick={() => disable.mutate()} loading={disable.isPending} disabled={!password || code.length < 6}>
              {m?.required ? 'Rimuovi e ricollega' : 'Disattiva'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}</Field>
          <Field label="Codice dell’app o di recupero">{(id) => <CodeInput id={id} value={code} onChange={setCode} recovery />}</Field>
          {disable.isError && <ErrorBox error={disable.error} compact />}
        </div>
      </Dialog>
    </Card>
  );
}

type UserRow = { id: string; username: string; role: Role; disabled: boolean; createdAt: number; lastLoginAt: number | null; mfa: boolean; mfaRequired: boolean };

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
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const reset = useMutation({
    mutationFn: (u: UserRow) => api(`/users/${u.id}/mfa`, { method: 'DELETE' }),
    onSuccess: (_r, u) => {
      toast('ok', `Verifica in due passaggi azzerata per ${u.username}`);
      setResetting(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e: Error) => toast('err', e.message),
  });
  return (
    <Card
      title="Utenti"
      icon={<Users />}
      subtitle="Ruoli e verifica in due passaggi, obbligatoria per amministratori e operatori."
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
              <th className="px-3 py-2 font-medium">2FA</th>
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
                    {(['admin', 'operator', 'viewer'] as const).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {u.mfa ? <Badge tone="ok">attiva</Badge> : u.mfaRequired ? <Badge tone="warn">da configurare</Badge> : <Badge tone="idle">no</Badge>}
                    {u.mfa && u.id !== user?.id && (
                      <Button size="sm" variant="ghost" onClick={() => setResetting(u)} aria-label={`Azzera la verifica in due passaggi di ${u.username}`}>
                        Azzera
                      </Button>
                    )}
                  </div>
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
      <dl className="grid gap-x-6 gap-y-1.5 border-t border-line px-4 pt-3 text-xs sm:grid-cols-3">
        {(
          [
            ['admin', 'Tutto, compresi stack, file, utenti, integrazioni ed eliminazioni.'],
            ['operator', 'Avvia e riavvia container, legge i log, gestisce i download e la revisione dei media. Non ferma container e non elimina file.'],
            ['viewer', 'Stato, metriche e liste. Niente log, variabili o azioni.'],
          ] as const
        ).map(([r, d]) => (
          <div key={r}>
            <dt className="font-medium text-fg-2">{ROLE_LABEL[r]}</dt>
            <dd className="text-muted">{d}</dd>
          </div>
        ))}
      </dl>
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
                <option value="viewer">{ROLE_LABEL.viewer}</option>
                <option value="operator">{ROLE_LABEL.operator}</option>
                <option value="admin">{ROLE_LABEL.admin}</option>
              </Select>
            )}
          </Field>
          {form.role !== 'viewer' && <p className="text-xs text-muted">Al primo accesso dovrà collegare un’app di autenticazione.</p>}
          {create.isError && <ErrorBox error={create.error} compact />}
        </div>
      </Dialog>
      <Dialog
        open={!!resetting}
        onClose={() => setResetting(null)}
        title={`Azzerare la verifica in due passaggi di ${resetting?.username}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetting(null)}>
              Annulla
            </Button>
            <Button variant="danger" onClick={() => resetting && reset.mutate(resetting)} loading={reset.isPending}>
              Azzera
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-fg-2">
          Usalo se ha perso il telefono e i codici di recupero. Le sue sessioni vengono chiuse; al prossimo accesso, se il ruolo la richiede, dovrà configurarla di nuovo. L’operazione va
          nell’audit.
        </p>
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
    ['Autenticazione', 'Password con scrypt, sessioni opache con hash nel DB, cookie HttpOnly + Secure + SameSite=Strict, scadenza per inattività. Verifica in due passaggi TOTP obbligatoria per amministratori e operatori, con codici di recupero monouso.'],
    ['CSRF', 'Token per sessione obbligatorio su ogni modifica + verifica dell’Origin.'],
    ['Brute force', 'Blocco persistente per IP e per utente dopo tentativi falliti; rate limit globale.'],
    ['Permessi', 'Controllo del ruolo nel backend su ogni endpoint. Gli operatori avviano e riavviano container, vedono i log oscurati, gestiscono i download e la revisione dei media; non fermano container e non toccano stack, file, utenti, integrazioni o eliminazioni. La sola lettura non vede log, variabili d’ambiente, comandi o etichette.'],
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
