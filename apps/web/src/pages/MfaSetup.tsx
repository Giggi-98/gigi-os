// Configurazione della verifica in due passaggi (D-029): password → QR e codice → codici di recupero.
import { Check, Copy, Download, KeyRound, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, ErrorBox, Field, Input } from '../components/ui';
import { api, ROLE_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

export function CodeInput({ id, value, onChange, recovery = false }: { id: string; value: string; onChange: (v: string) => void; recovery?: boolean }) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(recovery ? e.target.value.slice(0, 20) : e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode={recovery ? 'text' : 'numeric'}
      autoComplete="one-time-code"
      placeholder={recovery ? '123456 oppure ABCD-EFGH' : '123456'}
      className="font-mono tracking-[0.3em]"
      required
    />
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = `GIGI OS — codici di recupero (${new Date().toLocaleString('it-IT')})\nOgni codice vale una sola volta.\n\n${codes.join('\n')}\n`;
  return (
    <div>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface-2 p-3 font-mono text-sm tabular" aria-label="Codici di recupero">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copiati' : 'Copia'}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'gigi-os-codici-recupero.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download /> Scarica .txt
        </Button>
      </div>
    </div>
  );
}

export function MfaEnroll({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!secret) return;
    // Sempre nero su bianco: alcune app non leggono un QR invertito sul tema scuro.
    QRCode.toDataURL(secret.uri, { margin: 2, width: 208, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then(setQr, () => setQr(null));
  }, [secret]);

  const run = (f: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await f();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'password')
    return (
      <form
        className="space-y-3"
        onSubmit={run(async () => {
          setSecret(await api<{ secret: string; uri: string }>('/auth/mfa/begin', { method: 'POST', body: { password } }));
          setPassword('');
          setStep('scan');
        })}
      >
        <p className="text-[13px] text-fg-2">Serve un’app di autenticazione sul telefono: Aegis, 2FAS, Google Authenticator, Microsoft Authenticator o il portachiavi del telefono.</p>
        <Field label="Conferma la tua password">
          {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />}
        </Field>
        {error !== null && <ErrorBox error={error} compact />}
        <Button type="submit" variant="primary" loading={busy}>
          <KeyRound /> Continua
        </Button>
      </form>
    );

  if (step === 'scan' && secret)
    return (
      <form
        className="space-y-4"
        onSubmit={run(async () => {
          const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { method: 'POST', body: { code } });
          setCodes(r.recoveryCodes);
          setStep('codes');
        })}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="mx-auto shrink-0 rounded-xl bg-white p-1 sm:mx-0">
            {qr ? <img src={qr} alt="Codice QR da inquadrare con l’app di autenticazione" width={208} height={208} /> : <div className="size-[208px]" />}
          </div>
          <div className="min-w-0 space-y-2 text-[13px] text-fg-2">
            <p>
              <Smartphone className="mr-1 inline size-4 align-[-3px]" />
              Nell’app scegli «Aggiungi account» e inquadra il codice.
            </p>
            <p className="text-muted">Non puoi inquadrarlo? Inserisci a mano questa chiave (tipo: basata sul tempo):</p>
            <code className="block rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-xs break-all select-all">{secret.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </div>
        </div>
        <Field label="Codice a 6 cifre mostrato dall’app">{(id) => <CodeInput id={id} value={code} onChange={setCode} />}</Field>
        {error !== null && <ErrorBox error={error} compact />}
        <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
          <ShieldCheck /> Attiva
        </Button>
      </form>
    );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
        <strong className="font-medium text-fg">Verifica attiva.</strong> Salva questi codici di recupero fuori da questo PC (gestore di password, foglio stampato). Servono se perdi il telefono:
        ognuno vale una volta e non verranno più mostrati.
      </div>
      <RecoveryCodes codes={codes} />
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4 accent-[var(--accent)]" />
        Ho salvato i codici in un posto sicuro
      </label>
      <Button variant="primary" disabled={!saved} onClick={onDone}>
        <Check /> Fatto
      </Button>
    </div>
  );
}

/** Schermata a pagina intera per admin e operatori che non hanno ancora la 2FA: il backend blocca tutto il resto. */
export function MfaRequiredPage() {
  const { user, refresh, logout } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-xl font-semibold tracking-tight">Attiva la verifica in due passaggi</h1>
          <p className="mt-1 max-w-md text-sm text-muted">
            Il ruolo {user ? ROLE_LABEL[user.role].toLowerCase() : ''} può modificare il server: oltre alla password serve un codice dal telefono. Ci vuole un minuto.
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5" style={{ boxShadow: 'var(--shadow)' }}>
          <MfaEnroll onDone={() => void refresh()} />
        </div>
        <div className="mt-4 text-center">
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            <LogOut /> Esci ({user?.username})
          </Button>
        </div>
      </div>
    </div>
  );
}
