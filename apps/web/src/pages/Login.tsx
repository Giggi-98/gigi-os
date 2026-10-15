import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Field, Input } from '../components/ui';

export function Login({ setup }: { setup: boolean }) {
  const { setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) return setError(new Error('Le password non coincidono'));
    setBusy(true);
    try {
      const r = await api<{ user: User }>(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: setup ? { username, password, setupToken: token.trim() } : { username, password },
      });
      setUser(r.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-xl font-semibold tracking-tight">{setup ? 'Configura GIGI OS' : 'Accedi a GIGI OS'}</h1>
          <p className="mt-1 text-sm text-muted">{setup ? 'Crea il primo account amministratore.' : 'Homelab control center · Gigi-Mini-Pc'}</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-surface p-5" style={{ boxShadow: 'var(--shadow)' }}>
          {setup && (
            <Field label="Codice di setup" help={<>Lo trovi con <code className="font-mono">docker logs gigi-api</code>. È monouso.</>}>
              {(id) => <Input id={id} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="one-time-code" required autoFocus />}
            </Field>
          )}
          <Field label="Nome utente">
            {(id) => (
              <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus={!setup} minLength={3} />
            )}
          </Field>
          <Field label="Password" help={setup ? 'Almeno 12 caratteri. Una frase lunga è l’ideale.' : undefined}>
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
            <Field label="Conferma password">
              {(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />}
            </Field>
          )}
          {error !== null && <ErrorBox error={error} compact />}
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : setup ? <ShieldCheck /> : <KeyRound />}
            {setup ? 'Crea amministratore' : 'Accedi'}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-muted">Accesso consentito solo dalla rete locale.</p>
      </div>
    </div>
  );
}
