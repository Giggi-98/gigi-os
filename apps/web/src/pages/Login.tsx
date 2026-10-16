import { t, tn, tr } from '../lib/i18n';
import { ArrowLeft, KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError, type LoginResult, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Field, Input, useToast } from '../components/ui';
import { CodeInput } from './MfaSetup';

export function Login({ setup }: { setup: boolean }) {
  const { setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [trustDays, setTrustDays] = useState(0);
  const [remember, setRemember] = useState(false);
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) return setError(new Error(t('Le password non coincidono')));
    setBusy(true);
    try {
      const r = await api<LoginResult>(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: setup ? { username, password, setupToken: token.trim() } : { username, password },
      });
      if ('mfaRequired' in r) {
        setTicket(r.ticket);
        setTrustDays(r.trustDays ?? 0);
        setPassword('');
      } else setUser(r.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ user: User; recoveryLeft?: number }>('/auth/login/mfa', { method: 'POST', body: { ticket, code, remember: trustDays > 0 && remember } });
      if (r.recoveryLeft !== undefined)
        toast(r.recoveryLeft <= 3 ? 'err' : 'info', t('Codice di recupero usato: ne restano {n}. Puoi generarne di nuovi in Sicurezza.', { n: r.recoveryLeft }));
      setUser(r.user);
    } catch (err) {
      if (err instanceof ApiError && (err.body as { code?: string })?.code === 'ticket_expired') {
        setTicket(null);
        setCode('');
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (ticket)
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-7 flex flex-col items-center text-center">
            <img src="/favicon.svg" alt="" className="mb-4 size-12" />
            <h1 className="text-xl font-semibold tracking-tight">{t('Verifica in due passaggi')}</h1>
            <p className="mt-1 text-sm text-muted">{useRecovery ? t('Inserisci uno dei codici di recupero salvati.') : t('Apri l’app di autenticazione sul telefono.')}</p>
          </div>
          <form onSubmit={submitCode} className="space-y-4 rounded-2xl border border-line bg-surface p-5" style={{ boxShadow: 'var(--shadow)' }}>
            <Field label={useRecovery ? t('Codice di recupero') : t('Codice a 6 cifre per {user}', { user: username })}>
              {(id) => <CodeInput id={id} value={code} onChange={setCode} recovery={useRecovery} />}
            </Field>
            {trustDays > 0 && (
              <label className="flex items-start gap-2 text-[13px] text-fg-2">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 size-4 [--check:var(--accent)]" />
                <span>
                  {tn(trustDays, 'Ricorda questo dispositivo per 1 giorno', 'Ricorda questo dispositivo per {n} giorni')}
                  <span className="block text-xs text-muted">{t('Su questo browser il codice non verrà chiesto. Non usarlo su computer condivisi.')}</span>
                </span>
              </label>
            )}
            {error !== null && <ErrorBox error={error} compact />}
            <Button type="submit" variant="primary" className="w-full" disabled={busy || (!useRecovery && code.length !== 6)}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {t('Verifica')}
            </Button>
            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted hover:text-fg"
                onClick={() => {
                  setTicket(null);
                  setCode('');
                  setError(null);
                }}
              >
                <ArrowLeft className="size-3.5" />{' '}{t('Indietro')}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-accent hover:underline"
                onClick={() => {
                  setUseRecovery(!useRecovery);
                  setCode('');
                }}
              >
                {useRecovery ? <Smartphone className="size-3.5" /> : <KeyRound className="size-3.5" />}
                {useRecovery ? t('Usa l’app') : t('Usa un codice di recupero')}
              </button>
            </div>
          </form>
        </div>
      </div>
    );

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-xl font-semibold tracking-tight">{setup ? t('Configura GIGI OS') : t('Accedi a GIGI OS')}</h1>
          <p className="mt-1 text-sm text-muted">{setup ? t('Crea il primo account amministratore.') : 'Homelab control center'}</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-surface p-5" style={{ boxShadow: 'var(--shadow)' }}>
          {setup && (
            <Field label={t('Codice di setup')} help={tr('Lo trovi con {cmd}. È monouso.', { cmd: <code className="font-mono">docker logs gigi-api</code> })}>
              {(id) => <Input id={id} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="one-time-code" required autoFocus />}
            </Field>
          )}
          <Field label={t('Nome utente')}>
            {(id) => (
              <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus={!setup} minLength={3} />
            )}
          </Field>
          <Field label={t('Password')} help={setup ? t('Almeno 12 caratteri. Una frase lunga è l’ideale.') : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setup ? 'new-password' : 'current-password'}
                required
                minLength={setup ? 12 : 1}
              />
            )}
          </Field>
          {setup && (
            <Field label={t('Conferma password')}>
              {(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />}
            </Field>
          )}
          {error !== null && <ErrorBox error={error} compact />}
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : setup ? <ShieldCheck /> : <KeyRound />}
            {setup ? t('Crea amministratore') : t('Accedi')}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-muted">{t('Accesso consentito solo dalla rete locale.')}</p>
      </div>
    </div>
  );
}
