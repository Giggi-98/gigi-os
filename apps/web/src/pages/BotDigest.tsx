// Bot Telegram e digest (D-031): impostazioni per gli admin e collegamento del proprio account Telegram.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, ExternalLink, Newspaper, Send, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, Select, Skeleton, useToast, type Tone } from '../components/ui';
import { api } from '../lib/api';
import { ago, dateTime } from '../lib/format';

type Channel = { id: string; type: string; name: string; enabled: boolean };
type Link = { tgUserId: string; name: string | null; createdAt: number; lastUsedAt: number | null; username: string };
type BotInfo = { settings: { channelId: string | null; enabled: boolean }; status: { state: 'spento' | 'attivo' | 'errore'; bot: string | null; lastOk: number | null; lastError: string | null }; links: Link[] };
type DigestSettings = { daily: { enabled: boolean; time: string }; weekly: { enabled: boolean; day: number; time: string }; channels: string[] };

const STATE: Record<BotInfo['status']['state'], [string, Tone]> = { attivo: ['attivo', 'ok'], spento: ['spento', 'idle'], errore: ['errore', 'err'] };
const DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const COMMANDS: [string, string][] = [
  ['/stato', 'risorse, dischi con previsione, container e integrazioni da controllare'],
  ['/download', 'download in corso; operatori e admin hanno ⏸/▶️'],
  ['/media', 'contenuti da rivedere; operatori e admin importano (con conferma) o ignorano'],
  ['/digest', 'riepilogo delle ultime 24 ore'],
  ['/scollega', 'scollega l’account Telegram'],
];

export function BotDigestTab({ channels }: { channels: Channel[] }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <BotCard channels={channels.filter((c) => c.type === 'telegram')} />
      <DigestCard channels={channels} />
    </div>
  );
}

function BotCard({ channels }: { channels: Channel[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['telegram-bot'], queryFn: () => api<BotInfo>('/telegram/bot'), refetchInterval: 10_000 });
  const save = useMutation({
    mutationFn: (s: BotInfo['settings']) => api('/telegram/bot', { method: 'PUT', body: s }),
    // La casella risponde subito; se il server rifiuta, si torna allo stato precedente
    onMutate: (s) => {
      const prev = qc.getQueryData<BotInfo>(['telegram-bot']);
      if (prev) qc.setQueryData<BotInfo>(['telegram-bot'], { ...prev, settings: s });
      return { prev };
    },
    onError: (e: Error, _s, ctx) => {
      if (ctx?.prev) qc.setQueryData(['telegram-bot'], ctx.prev);
      toast('err', e.message);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['telegram-bot'] }),
  });
  const unlink = useMutation({
    mutationFn: (tg: string) => api(`/telegram/links/${tg}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', 'Account Telegram scollegato');
      void qc.invalidateQueries({ queryKey: ['telegram-bot'] });
    },
  });
  const b = q.data;
  const channelId = b?.settings.channelId ?? channels[0]?.id ?? null;
  return (
    <Card title="Bot Telegram" icon={<Bot />} subtitle="Comandi dal telefono, con i permessi dell’utente collegato." className="xl:row-span-2">
      {q.isError && <ErrorBox error={q.error} compact />}
      {!b && !q.isError && <Skeleton className="h-24" />}
      {b && channels.length === 0 && <Empty title="Nessun canale Telegram">Crea prima un canale Telegram nella scheda Canali: il bot usa lo stesso token.</Empty>}
      {b && channels.length > 0 && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Bot (canale Telegram)">
              {(id) => (
                <Select id={id} value={channelId ?? ''} onChange={(e) => save.mutate({ channelId: e.target.value, enabled: b.settings.enabled })}>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-3 text-[13px]">
              <input
                type="checkbox"
                className="size-4 [--check:var(--accent)]"
                checked={b.settings.enabled}
                disabled={save.isPending}
                onChange={(e) => save.mutate({ channelId, enabled: e.target.checked })}
              />
              Comandi dal telefono
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={STATE[b.status.state][1]}>{STATE[b.status.state][0]}</Badge>
            {b.status.bot && <span className="font-mono text-fg-2">{b.status.bot}</span>}
            {b.status.lastOk && b.status.state === 'attivo' && <span className="text-muted">ultimo contatto {ago(b.status.lastOk)}</span>}
            {b.status.state === 'errore' && b.status.lastError && <span className="text-err">{b.status.lastError}</span>}
          </div>
          <dl className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
            {COMMANDS.map(([c, d]) => (
              <div key={c} className="flex gap-2 py-0.5">
                <dt className="w-20 shrink-0 font-mono text-fg-2">{c}</dt>
                <dd className="text-muted">{d}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted">
            Ognuno collega il proprio account da <strong className="font-medium text-fg-2">Sicurezza → Il mio account → Telegram</strong>. Messaggi da account non collegati e da gruppi vengono ignorati; ogni azione va nell’audit.
          </p>
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-fg-2">Account collegati</h3>
            {b.links.length === 0 ? (
              <p className="text-xs text-muted">Nessuno, per ora.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {b.links.map((l) => (
                  <li key={l.tgUserId} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{l.username}</span> <span className="text-muted">· {l.name ?? l.tgUserId}</span>
                      <div className="text-[11px] text-muted">collegato {ago(l.createdAt)}{l.lastUsedAt ? ` · ultimo uso ${ago(l.lastUsedAt)}` : ''}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => unlink.mutate(l.tgUserId)} aria-label={`Scollega ${l.name ?? l.tgUserId}`}>
                      <Unlink /> Scollega
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function DigestCard({ channels }: { channels: Channel[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['digest'], queryFn: () => api<{ settings: DigestSettings; lastSent: { daily: number | null; weekly: number | null } }>('/digest') });
  const [s, setS] = useState<DigestSettings | null>(null);
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => {
    if (q.data && !s) setS(q.data.settings);
  }, [q.data, s]);
  const save = useMutation({
    mutationFn: () => api<DigestSettings>('/digest', { method: 'PUT', body: s }),
    onSuccess: (r) => {
      setS(r);
      toast('ok', 'Digest salvato');
      void qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const prev = useMutation({ mutationFn: (kind: 'daily' | 'weekly') => api<{ title: string; body: string }>(`/digest/preview?kind=${kind}`), onSuccess: setPreview, onError: (e: Error) => toast('err', e.message) });
  const send = useMutation({
    mutationFn: (kind: 'daily' | 'weekly') => api<{ channel: string; ok: boolean; error?: string }[]>('/digest/send', { method: 'POST', body: { kind } }),
    onSuccess: (r) => {
      const bad = r.filter((x) => !x.ok);
      toast(bad.length ? 'err' : 'ok', bad.length ? `Non inviato: ${bad.map((x) => x.error).join('; ')}` : `Digest inviato su ${r.length} canali`);
    },
    onError: (e: Error) => toast('err', e.message),
  });
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!s || !q.data) return <Skeleton className="h-48" />;
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data.settings);
  return (
    <Card title="Digest" icon={<Newspaper />} subtitle="Riepilogo di risorse, dischi, backup, download ed eventi.">
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={s.daily.enabled} onChange={(e) => setS({ ...s, daily: { ...s.daily, enabled: e.target.checked } })} />
            Ogni giorno alle
            <Input type="time" className="h-8 w-28" value={s.daily.time} onChange={(e) => setS({ ...s, daily: { ...s.daily, time: e.target.value } })} aria-label="Ora del digest giornaliero" />
          </label>
          <label className="flex flex-wrap items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={s.weekly.enabled} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, enabled: e.target.checked } })} />
            Ogni settimana il
            <Select className="h-8 w-auto" value={s.weekly.day} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, day: Number(e.target.value) } })} aria-label="Giorno del digest settimanale">
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
            alle
            <Input type="time" className="h-8 w-28" value={s.weekly.time} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, time: e.target.value } })} aria-label="Ora del digest settimanale" />
          </label>
          <p className="text-[11px] text-muted">Se coincidono, quel giorno arriva solo il settimanale. Se GIGI OS era spento all’ora prevista, parte entro 3 ore; mai due volte.</p>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-fg-2">Dove inviarlo</legend>
          {channels.length === 0 && <p className="text-xs text-muted">Nessun canale: creane uno nella scheda Canali.</p>}
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 [--check:var(--accent)]"
                  checked={s.channels.includes(c.id)}
                  onChange={(e) => setS({ ...s, channels: e.target.checked ? [...s.channels, c.id] : s.channels.filter((x) => x !== c.id) })}
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="text-[11px] text-muted">
          Ultimo giornaliero: {q.data.lastSent.daily ? dateTime(q.data.lastSent.daily) : 'mai'} · ultimo settimanale: {q.data.lastSent.weekly ? dateTime(q.data.lastSent.weekly) : 'mai'}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
            <Check /> Salva
          </Button>
          <Button size="sm" onClick={() => prev.mutate('daily')} loading={prev.isPending && prev.variables === 'daily'}>
            Anteprima giornaliero
          </Button>
          <Button size="sm" onClick={() => prev.mutate('weekly')} loading={prev.isPending && prev.variables === 'weekly'}>
            Anteprima settimanale
          </Button>
          <Button size="sm" variant="ghost" onClick={() => send.mutate('daily')} loading={send.isPending} disabled={dirty || s.channels.length === 0} title={dirty ? 'Salva prima le modifiche' : undefined}>
            <Send /> Invia ora
          </Button>
        </div>
      </div>
      <Dialog open={!!preview} onClose={() => setPreview(null)} title={preview?.title ?? ''} description="Anteprima con i dati di adesso: non viene inviato nulla.">
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-2 p-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{preview?.body}</pre>
      </Dialog>
    </Card>
  );
}

/** Scheda «Telegram» in Sicurezza → Il mio account. */
export function TelegramLinkCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ['telegram-me'], queryFn: () => api<{ available: boolean; bot: string | null; links: Link[] }>('/telegram/me') });
  const [code, setCode] = useState<{ code: string; expiresAt: number; bot: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  // Mentre il codice è valido controlla ogni 4 s se il collegamento è avvenuto
  useEffect(() => {
    if (!code) return;
    const n = me.data?.links.length ?? 0;
    const t = setInterval(async () => {
      const r = await qc.fetchQuery({ queryKey: ['telegram-me'], queryFn: () => api<{ available: boolean; bot: string | null; links: Link[] }>('/telegram/me'), staleTime: 0 });
      if (r.links.length > n) {
        setCode(null);
        toast('ok', 'Telegram collegato');
      } else if (Date.now() > code.expiresAt) setCode(null);
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  const gen = useMutation({ mutationFn: () => api<{ code: string; expiresAt: number; bot: string | null }>('/telegram/link-code', { method: 'POST' }), onSuccess: setCode, onError: (e: Error) => toast('err', e.message) });
  const unlink = useMutation({
    mutationFn: (tg: string) => api(`/telegram/links/${tg}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', 'Account Telegram scollegato');
      void qc.invalidateQueries({ queryKey: ['telegram-me'] });
    },
  });
  const d = me.data;
  const cmd = code ? `/collega ${code.code}` : '';
  return (
    <Card title="Telegram" icon={<Send />} subtitle="Usa il bot dal telefono con i permessi del tuo ruolo." className="lg:col-span-2">
      {me.isError && <ErrorBox error={me.error} compact />}
      {!d && !me.isError && <Skeleton className="h-10" />}
      {d && !d.available && d.links.length === 0 && <p className="text-xs text-muted">Il bot non è attivo. Un amministratore può abilitarlo in Automazioni → Bot e digest.</p>}
      {d && (d.available || d.links.length > 0) && (
        <div className="space-y-3">
          {d.links.map((l) => (
            <div key={l.tgUserId} className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
              <Badge tone="ok">collegato</Badge>
              <span className="min-w-0 flex-1 truncate">
                {l.name ?? l.tgUserId} <span className="text-xs text-muted">· {l.lastUsedAt ? `ultimo uso ${ago(l.lastUsedAt)}` : `dal ${dateTime(l.createdAt)}`}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => unlink.mutate(l.tgUserId)}>
                <Unlink /> Scollega
              </Button>
            </div>
          ))}
          {d.available && !code && (
            <Button size="sm" variant={d.links.length ? 'secondary' : 'primary'} onClick={() => gen.mutate()} loading={gen.isPending}>
              <Send /> {d.links.length ? 'Collega un altro account' : 'Collega Telegram'}
            </Button>
          )}
          {code && (
            <div className="rounded-xl border border-accent/40 bg-accent-soft p-3 text-[13px]">
              <p>
                Apri {code.bot ? <strong className="font-medium">{code.bot}</strong> : 'il bot'} su Telegram e invia questo messaggio entro 10 minuti:
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-surface px-3 py-1.5 font-mono text-base tracking-wider select-all">{cmd}</code>
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(cmd).then(() => setCopied(true));
                  }}
                >
                  {copied ? <Check /> : <Copy />} {copied ? 'Copiato' : 'Copia'}
                </Button>
                {code.bot && (
                  <a className="inline-flex items-center gap-1 text-xs text-accent hover:underline" href={`https://t.me/${code.bot.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-3.5" /> Apri il bot
                  </a>
                )}
              </div>
              <p className="mt-2 text-xs text-muted">Il codice vale una volta sola. Questa scheda si aggiorna da sola quando il collegamento riesce.</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
