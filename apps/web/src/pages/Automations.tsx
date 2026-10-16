import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Moon, Pencil, Plus, Search, Send, Siren, Trash2, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, cx, Dialog, Dot, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Tabs, useToast, type Tone } from '../components/ui';
import { api, type EventRow } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, dateTime } from '../lib/format';
import { byType, useIntegrations, useResource } from '../lib/queries';
import { BotDigestTab } from './BotDigest';

type Channel = { id: string; type: 'homeassistant' | 'ntfy' | 'telegram' | 'webhook'; name: string; config: Record<string, string>; secretFields: string[]; enabled: boolean };
type Rule = { id: string; name: string; enabled: boolean; sources: string[]; minLevel: 'info' | 'warning' | 'error'; matchText: string | null; channels: string[]; throttleMin: number; quietFrom: string | null; quietTo: string | null };
type Sent = { id: number; ts: number; rule_name: string | null; channel: string | null; title: string; status: 'sent' | 'failed' | 'throttled' | 'quiet'; error: string | null };

const SOURCE_LABEL: Record<string, string> = { docker: 'Docker', sistema: 'Sistema', rete: 'Rete', integrazioni: 'Integrazioni', media: 'Media', download: 'Download', backup: 'Backup', sicurezza: 'Sicurezza' };
const LEVEL: Record<string, [string, Tone]> = { info: ['Informazioni', 'info'], warning: ['Avvisi', 'warn'], error: ['Errori', 'err'] };
const TYPE_LABEL: Record<Channel['type'], string> = { homeassistant: 'Home Assistant (app sul telefono)', ntfy: 'ntfy', telegram: 'Telegram', webhook: 'Webhook' };

type Tab = 'rules' | 'channels' | 'bot' | 'history' | 'events';

export function AutomationsPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('rules');
  const channels = useQuery({ queryKey: ['auto-channels'], queryFn: () => api<Channel[]>('/automations/channels'), enabled: isAdmin });
  return (
    <div>
      <PageHeader title="Automazioni" description="Regole su eventi reali del server, con notifiche sui tuoi dispositivi. Antiripetizione e ore di silenzio incluse." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'rules', label: 'Regole' },
          ...(isAdmin
            ? [
                { id: 'channels' as const, label: 'Canali', count: channels.data?.length },
                { id: 'bot' as const, label: 'Bot e digest' },
              ]
            : []),
          { id: 'history', label: 'Notifiche inviate' },
          { id: 'events', label: 'Eventi' },
        ]}
      />
      <div className="mt-4">
        {tab === 'rules' && <RulesTab channels={channels.data ?? []} goChannels={() => setTab('channels')} />}
        {tab === 'channels' && <ChannelsTab channels={channels} />}
        {tab === 'bot' && <BotDigestTab channels={channels.data ?? []} />}
        {tab === 'history' && <HistoryTab channels={channels.data ?? []} />}
        {tab === 'events' && <EventsTab />}
      </div>
    </div>
  );
}

function RulesTab({ channels, goChannels }: { channels: Channel[]; goChannels: () => void }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['auto-rules'], queryFn: () => api<Rule[]>('/automations/rules') });
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const save = useMutation({
    mutationFn: (r: Rule) => api(`/automations/rules/${r.id}`, { method: 'PUT', body: { ...r, id: undefined } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auto-rules'] }),
    onError: (e: Error) => toast('err', e.message),
  });
  const chName = (id: string) => channels.find((c) => c.id === id)?.name ?? 'canale rimosso';
  if (rules.isError) return <ErrorBox error={rules.error} />;
  if (!rules.data) return <Skeleton className="h-48" />;
  return (
    <>
      {isAdmin && channels.length === 0 && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <Bell className="size-5 text-accent" />
            <p className="min-w-0 flex-1 text-xs text-muted">
              <span className="block text-[13px] font-medium text-fg-2">Aggiungi un canale per ricevere le notifiche</span>
              Con Home Assistant arrivano sull’app del telefono (se associata a HA) o nel pannello di HA; in alternativa ntfy o Telegram.
            </p>
            <Button size="sm" variant="primary" onClick={goChannels}><Plus /> Aggiungi canale</Button>
          </div>
        </Card>
      )}
      <div className="mb-3 flex justify-end">
        {isAdmin && <Button size="sm" onClick={() => setEdit('new')}><Plus /> Nuova regola</Button>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {rules.data.map((r) => (
          <Card key={r.id} className={cx(!r.enabled && 'opacity-70')}>
            <div className="flex items-start gap-3">
              <span className={cx('mt-0.5 [&>svg]:size-4', r.enabled ? 'text-accent' : 'text-muted')}>{r.enabled ? <Bell /> : <BellOff />}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{r.name}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(r.sources.length ? r.sources : ['tutte le sorgenti']).map((s) => <Badge key={s}>{SOURCE_LABEL[s] ?? s}</Badge>)}
                  <Badge tone={LEVEL[r.minLevel][1]}>da {LEVEL[r.minLevel][0].toLowerCase()}</Badge>
                  {r.matchText && <Badge tone="accent">contiene «{r.matchText}»</Badge>}
                  {r.quietFrom && r.quietTo && <Badge><Moon className="size-3" /> {r.quietFrom}–{r.quietTo}</Badge>}
                </div>
                <p className="mt-2 text-xs text-muted">
                  {r.channels.length ? `→ ${r.channels.map(chName).join(', ')}` : 'Nessun canale: la regola non invia nulla'}
                  {r.throttleMin > 0 && ` · non ripete lo stesso avviso per ${r.throttleMin >= 60 ? `${Math.round(r.throttleMin / 60)} h` : `${r.throttleMin} min`}`}
                </p>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 items-center gap-1">
                  <label className="relative inline-flex cursor-pointer items-center" title={r.enabled ? 'Disattiva' : 'Attiva'}>
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={r.enabled}
                      onChange={(e) => save.mutate({ ...r, enabled: e.target.checked })}
                      aria-label={`${r.enabled ? 'Disattiva' : 'Attiva'} ${r.name}`}
                    />
                    <span className="h-5 w-9 rounded-full bg-surface-3 transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
                    <span className="absolute left-0.5 size-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                  </label>
                  <Button size="icon" variant="ghost" onClick={() => setEdit(r)} aria-label={`Modifica ${r.name}`}><Pencil /></Button>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      {edit && <RuleDialog rule={edit === 'new' ? null : edit} channels={channels} onClose={() => setEdit(null)} />}
    </>
  );
}

function RuleDialog({ rule, channels, onClose }: { rule: Rule | null; channels: Channel[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Omit<Rule, 'id'>>(
    rule ?? { name: '', enabled: true, sources: [], minLevel: 'warning', matchText: null, channels: [], throttleMin: 30, quietFrom: null, quietTo: null },
  );
  const [quiet, setQuiet] = useState(!!(rule?.quietFrom && rule?.quietTo));
  const body = () => ({ ...f, matchText: f.matchText?.trim() || null, quietFrom: quiet ? f.quietFrom ?? '23:00' : null, quietTo: quiet ? f.quietTo ?? '07:30' : null });
  const save = useMutation({
    mutationFn: () => (rule ? api(`/automations/rules/${rule.id}`, { method: 'PUT', body: body() }) : api('/automations/rules', { method: 'POST', body: body() })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auto-rules'] }); toast('ok', 'Regola salvata'); onClose(); },
  });
  const del = useMutation({
    mutationFn: () => api(`/automations/rules/${rule!.id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auto-rules'] }); toast('ok', 'Regola eliminata'); onClose(); },
  });
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={rule ? `Modifica «${rule.name}»` : 'Nuova regola'}
      footer={
        <>
          {rule && <Button variant="ghost" className="mr-auto text-err" onClick={() => del.mutate()} loading={del.isPending}><Trash2 /> Elimina</Button>}
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name.trim()}>Salva</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />}</Field>
        <div>
          <div className="mb-1.5 text-xs font-medium text-fg-2">Quando arriva un evento da</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(SOURCE_LABEL).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setF({ ...f, sources: toggle(f.sources, k) })}
                aria-pressed={f.sources.includes(k)}
                className={cx('rounded-lg border px-2.5 py-1 text-xs', f.sources.includes(k) ? 'border-accent bg-accent-soft text-fg' : 'border-line-strong text-muted hover:text-fg')}
              >
                {l}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">Nessuna selezione = tutte le sorgenti.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Livello minimo">
            {(id) => (
              <Select id={id} value={f.minLevel} onChange={(e) => setF({ ...f, minLevel: e.target.value as Rule['minLevel'] })}>
                <option value="info">Informazioni e superiori</option>
                <option value="warning">Avvisi ed errori</option>
                <option value="error">Solo errori</option>
              </Select>
            )}
          </Field>
          <Field label="Solo se il testo contiene" help="Facoltativo, es. «jellyfin» o «disco».">
            {(id) => <Input id={id} value={f.matchText ?? ''} onChange={(e) => setF({ ...f, matchText: e.target.value })} />}
          </Field>
          <Field label="Non ripetere lo stesso avviso per">
            {(id) => (
              <Select id={id} value={f.throttleMin} onChange={(e) => setF({ ...f, throttleMin: Number(e.target.value) })}>
                {[[0, 'Sempre inviare'], [15, '15 minuti'], [30, '30 minuti'], [60, '1 ora'], [180, '3 ore'], [360, '6 ore'], [1440, '24 ore']].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium text-fg-2">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
              Ore di silenzio (gli errori passano comunque)
            </label>
            <div className="flex items-center gap-2">
              <Input type="time" disabled={!quiet} value={f.quietFrom ?? '23:00'} onChange={(e) => setF({ ...f, quietFrom: e.target.value })} aria-label="Silenzio dalle" />
              <span className="text-xs text-muted">→</span>
              <Input type="time" disabled={!quiet} value={f.quietTo ?? '07:30'} onChange={(e) => setF({ ...f, quietTo: e.target.value })} aria-label="Silenzio fino alle" />
            </div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-fg-2">Invia a</div>
          {channels.length === 0 ? (
            <p className="text-xs text-muted">Nessun canale configurato (scheda «Canali»).</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setF({ ...f, channels: toggle(f.channels, c.id) })}
                  aria-pressed={f.channels.includes(c.id)}
                  className={cx('rounded-lg border px-2.5 py-1 text-xs', f.channels.includes(c.id) ? 'border-accent bg-accent-soft text-fg' : 'border-line-strong text-muted hover:text-fg')}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {(save.isError || del.isError) && <ErrorBox error={save.error ?? del.error} compact />}
      </div>
    </Dialog>
  );
}

function ChannelsTab({ channels }: { channels: ReturnType<typeof useQuery<Channel[]>> }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Channel | 'new' | null>(null);
  const test = useMutation({
    mutationFn: (id: string) => api(`/automations/channels/${id}/test`, { method: 'POST' }),
    onSuccess: () => toast('ok', 'Notifica di prova inviata'),
    onError: (e: Error) => toast('err', `Invio non riuscito: ${e.message}`),
  });
  if (channels.isError) return <ErrorBox error={channels.error} />;
  if (!channels.data) return <Skeleton className="h-40" />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="primary" onClick={() => setEdit('new')}><Plus /> Nuovo canale</Button>
      </div>
      {channels.data.length === 0 ? (
        <Card><Empty icon={<Send />} title="Nessun canale di notifica" /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {channels.data.map((c) => (
            <Card key={c.id} title={c.name} subtitle={TYPE_LABEL[c.type]}>
              <p className="font-mono text-xs break-all text-muted">
                {c.type === 'homeassistant' ? c.config.service : c.type === 'ntfy' ? `${c.config.server}/${c.config.topic}` : c.type === 'telegram' ? `chat ${c.config.chatId}` : c.config.url}
              </p>
              <div className="mt-3 flex gap-1.5 border-t border-line pt-3">
                <Button size="sm" variant="ghost" onClick={() => test.mutate(c.id)} loading={test.isPending && test.variables === c.id}><Send /> Prova</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(c)}><Pencil /> Modifica</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit && <ChannelDialog channel={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function ChannelDialog({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ints = useIntegrations();
  const ha = byType(ints.data, 'homeassistant');
  const services = useResource<string[]>(ha, 'notify', '', 300_000);
  const [type, setType] = useState<Channel['type']>(channel?.type ?? 'homeassistant');
  const [name, setName] = useState(channel?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(channel?.config ?? { server: 'https://ntfy.sh' });
  const [secret, setSecret] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setConfig((c) => ({ ...c, [k]: v }));
  const stored = (k: string) => channel?.secretFields.includes(k);
  const save = useMutation({
    mutationFn: () => {
      const body = { type, name: name.trim() || TYPE_LABEL[type], config, secret: Object.fromEntries(Object.entries(secret).filter(([, v]) => v)) };
      return channel ? api(`/automations/channels/${channel.id}`, { method: 'PUT', body }) : api('/automations/channels', { method: 'POST', body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auto-channels'] }); toast('ok', 'Canale salvato: usa «Prova» per verificarlo'); onClose(); },
  });
  const del = useMutation({
    mutationFn: () => api(`/automations/channels/${channel!.id}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['auto-channels'] }); void qc.invalidateQueries({ queryKey: ['auto-rules'] }); onClose(); },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={channel ? `Modifica «${channel.name}»` : 'Nuovo canale di notifica'}
      footer={
        <>
          {channel && <Button variant="ghost" className="mr-auto text-err" onClick={() => del.mutate()} loading={del.isPending}><Trash2 /> Elimina</Button>}
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Salva</Button>
        </>
      }
    >
      <div className="space-y-3">
        {!channel && (
          <Field label="Tipo">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as Channel['type'])}>
                {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label="Nome">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPE_LABEL[type]} />}</Field>
        {type === 'homeassistant' &&
          (!ha ? (
            <p className="text-xs text-warn">Collega prima Home Assistant nelle Integrazioni.</p>
          ) : (
            <Field label="Servizio di notifica" help="Le app mobili di Home Assistant compaiono come notify.mobile_app_…">
              {(id) => (
                <Select id={id} value={config.service ?? ''} onChange={(e) => set('service', e.target.value)}>
                  <option value="">Scegli…</option>
                  {services.data?.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              )}
            </Field>
          ))}
        {type === 'ntfy' && (
          <>
            <Field label="Server">{(id) => <Input id={id} value={config.server ?? ''} onChange={(e) => set('server', e.target.value)} />}</Field>
            <Field label="Topic" help="Scegli un nome difficile da indovinare: su ntfy.sh i topic sono pubblici.">{(id) => <Input id={id} value={config.topic ?? ''} onChange={(e) => set('topic', e.target.value)} />}</Field>
            <Field label="Token di accesso (facoltativo)" help={stored('token') ? 'Salvato: lascia vuoto per mantenerlo.' : undefined}>
              {(id) => <Input id={id} type="password" value={secret.token ?? ''} onChange={(e) => setSecret({ ...secret, token: e.target.value })} autoComplete="new-password" />}
            </Field>
          </>
        )}
        {type === 'telegram' && (
          <>
            <Field label="Token del bot" help={stored('botToken') ? 'Salvato: lascia vuoto per mantenerlo.' : 'Crealo con @BotFather su Telegram (/newbot).'}>
              {(id) => <Input id={id} type="password" value={secret.botToken ?? ''} onChange={(e) => setSecret({ ...secret, botToken: e.target.value })} autoComplete="new-password" />}
            </Field>
            <TelegramDetect token={secret.botToken} channelId={channel?.id} chatId={config.chatId ?? ''} onPick={(id, name) => { set('chatId', id); if (!name.trim()) return; setName((n) => n || `Telegram · ${name}`); }} />
            <Field label="Chat ID" help="Compilato da «Rileva», oppure inseriscilo a mano.">{(id) => <Input id={id} value={config.chatId ?? ''} onChange={(e) => set('chatId', e.target.value)} inputMode="numeric" />}</Field>
          </>
        )}
        {type === 'webhook' && (
          <>
            <Field label="URL" help="Riceve un POST JSON {source, level, title, details, ts}.">{(id) => <Input id={id} value={config.url ?? ''} onChange={(e) => set('url', e.target.value)} />}</Field>
            <Field label="Header Authorization (facoltativo)" help={stored('authHeader') ? 'Salvato: lascia vuoto per mantenerlo.' : undefined}>
              {(id) => <Input id={id} type="password" value={secret.authHeader ?? ''} onChange={(e) => setSecret({ ...secret, authHeader: e.target.value })} autoComplete="new-password" />}
            </Field>
          </>
        )}
        {(save.isError || del.isError) && <ErrorBox error={save.error ?? del.error} compact />}
      </div>
    </Dialog>
  );
}

type Detected = { bot: string; botName: string; chats: { id: string; type: string; name: string; lastSeen: number }[] };

function TelegramDetect({ token, channelId, chatId, onPick }: { token?: string; channelId?: string; chatId: string; onPick: (id: string, name: string) => void }) {
  const d = useMutation({
    mutationFn: () => api<Detected>('/automations/telegram/detect', { method: 'POST', body: token ? { botToken: token } : { channelId } }),
    onSuccess: (r) => {
      if (r.chats.length === 1) onPick(r.chats[0].id, r.chats[0].name);
    },
  });
  const canRun = !!token || !!channelId;
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted">
          Scrivi un messaggio qualsiasi al bot (anche <span className="font-mono">/start</span>) dall’account o dal gruppo che deve ricevere le notifiche, poi premi «Rileva».
        </p>
        <Button size="sm" onClick={() => d.mutate()} loading={d.isPending} disabled={!canRun}>
          <Search /> Rileva chat
        </Button>
      </div>
      {d.isError && <div className="mt-2"><ErrorBox error={d.error} compact /></div>}
      {d.data && (
        <div className="mt-2.5">
          <p className="mb-1.5 text-xs text-fg-2">Bot {d.data.bot} · {d.data.chats.length ? 'scegli la chat:' : 'nessun messaggio ricevuto: scrivi al bot e riprova.'}</p>
          <ul className="space-y-1">
            {d.data.chats.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onPick(c.id, c.name)}
                  className={cx('flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs', chatId === c.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong')}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                  <Badge>{c.type}</Badge>
                  <span className="font-mono text-[11px] text-muted">{c.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const SENT: Record<Sent['status'], [string, Tone]> = { sent: ['inviata', 'ok'], failed: ['non riuscita', 'err'], throttled: ['non ripetuta', 'idle'], quiet: ['ore di silenzio', 'idle'] };

function HistoryTab({ channels }: { channels: Channel[] }) {
  const h = useQuery({ queryKey: ['auto-history'], queryFn: () => api<Sent[]>('/automations/history?limit=200'), refetchInterval: 15_000 });
  if (h.isError) return <ErrorBox error={h.error} />;
  if (!h.data) return <Skeleton className="h-40" />;
  if (!h.data.length) return <Card><Empty icon={<Workflow />} title="Nessuna notifica ancora">Compariranno qui quando una regola attiva incontra un evento.</Empty></Card>;
  return (
    <Card bodyClassName="!p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line text-xs text-muted">
            <tr><th className="px-4 py-2 font-medium">Quando</th><th className="px-3 py-2 font-medium">Evento</th><th className="px-3 py-2 font-medium">Regola → canale</th><th className="px-4 py-2 font-medium">Esito</th></tr>
          </thead>
          <tbody>
            {h.data.map((n) => (
              <tr key={n.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2 text-xs whitespace-nowrap text-muted tabular">{dateTime(n.ts)}</td>
                <td className="max-w-[320px] truncate px-3 py-2" title={n.title}>{n.title}</td>
                <td className="px-3 py-2 text-xs text-fg-2">{n.rule_name ?? '—'}{n.channel && ` → ${channels.find((c) => c.id === n.channel)?.name ?? 'canale'}`}</td>
                <td className="px-4 py-2"><Badge tone={SENT[n.status][1]}>{SENT[n.status][0]}</Badge>{n.error && <div className="mt-0.5 max-w-[260px] truncate text-[11px] text-err" title={n.error}>{n.error}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function EventsTab() {
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');
  const ev = useQuery({ queryKey: ['events', level], queryFn: () => api<EventRow[]>(`/events?limit=300${level ? `&level=${level}` : ''}`), refetchInterval: 15_000 });
  const rows = useMemo(() => (ev.data ?? []).filter((e) => !source || e.source === source), [ev.data, source]);
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="w-auto" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Livello">
          <option value="">Tutti i livelli</option><option value="error">Errori</option><option value="warning">Avvisi</option><option value="info">Informazioni</option>
        </Select>
        <Select className="w-auto" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Sorgente">
          <option value="">Tutte le sorgenti</option>
          {Object.entries(SOURCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </div>
      {ev.isError && <ErrorBox error={ev.error} />}
      {!ev.data && !ev.isError && <Skeleton className="h-40" />}
      {ev.data && (rows.length === 0 ? <Card><Empty icon={<Siren />} title="Nessun evento" /></Card> : (
        <Card bodyClassName="!p-0">
          <ul className="divide-y divide-line">
            {rows.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                <span className="mt-1.5"><Dot tone={e.level === 'error' ? 'err' : e.level === 'warning' ? 'warn' : 'info'} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{e.title}</div>
                  {e.details && <div className="truncate text-xs text-muted">{e.details}</div>}
                </div>
                <Badge>{SOURCE_LABEL[e.source] ?? e.source}</Badge>
                <span className="w-24 shrink-0 text-right text-xs text-muted">{ago(e.ts)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}
