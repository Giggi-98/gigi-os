import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, KeyRound, Pencil, Plus, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, StatusBadge, useToast } from '../components/ui';
import { api, type Integration, type IntegrationType } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago } from '../lib/format';
import { useIntegrations } from '../lib/queries';

export function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const ints = useIntegrations();
  const types = useQuery({ queryKey: ['integration-types'], queryFn: () => api<IntegrationType[]>('/integrations/types'), staleTime: Infinity });
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<{ type: string; existing?: Integration } | null>(null);
  const [picker, setPicker] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    const add = params.get('add');
    if (add && isAdmin && types.data && ints.data) {
      const existing = ints.data.find((i) => i.type === add);
      setEditing({ type: add, existing });
      setParams({}, { replace: true });
    }
  }, [params, isAdmin, types.data, ints.data, setParams]);

  const check = useMutation({
    mutationFn: (id: string) => api<Integration>(`/integrations/${id}/check`, { method: 'POST' }),
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      toast(i.status === 'online' ? 'ok' : 'info', `${i.name}: ${i.message ?? i.status}`);
    },
    onError: (e: Error) => toast('err', e.message),
  });

  const configured = new Set(ints.data?.map((i) => i.type));
  const suggestions = (types.data ?? []).filter((t) => t.type !== 'http' && !configured.has(t.type));

  return (
    <div>
      <PageHeader
        title="Integrazioni"
        description="Collegamenti ai servizi del server. Le credenziali sono cifrate (AES-256-GCM) e non vengono mai rimandate al browser."
        actions={
          isAdmin && (
            <Button variant="primary" size="sm" onClick={() => setPicker(true)}>
              <Plus /> Aggiungi integrazione
            </Button>
          )
        }
      />
      {ints.isError && <ErrorBox error={ints.error} />}
      {!ints.data && !ints.isError && <Skeleton className="h-40" />}
      {isAdmin && suggestions.length > 0 && (
        <Card className="mb-4" title="Suggerite per questo server" subtitle="Rilevate durante l’audit: servono solo le credenziali.">
          <div className="flex flex-wrap gap-2">
            {suggestions.map((t) => (
              <Button key={t.type} size="sm" onClick={() => setEditing({ type: t.type })}>
                <Plus /> {t.label}
              </Button>
            ))}
          </div>
        </Card>
      )}
      {ints.data && ints.data.length === 0 && (
        <Card>
          <Empty icon={<PlugZap />} title="Nessuna integrazione" />
        </Card>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ints.data?.map((i) => (
          <Card
            key={i.id}
            title={i.name}
            subtitle={`${i.typeLabel} · ${i.baseUrl}`}
            actions={<StatusBadge status={i.status} />}
          >
            <p className="min-h-8 text-xs text-fg-2">{i.message ?? 'In attesa del primo controllo…'}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {i.capabilities.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span>Controllato {ago(i.lastChecked)}</span>
              {i.latency !== null && <span className="tabular">{i.latency} ms</span>}
              {i.secretFields.length > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <KeyRound className="size-3" /> credenziali cifrate
                </span>
              ) : (
                <span>senza credenziali</span>
              )}
              {i.config.container && <span>container: {i.config.container}</span>}
            </div>
            <div className="mt-3 flex gap-1.5 border-t border-line pt-3">
              <Button size="sm" variant="ghost" onClick={() => check.mutate(i.id)} loading={check.isPending && check.variables === i.id}>
                <RefreshCw /> Verifica
              </Button>
              {isAdmin && (
                <Button size="sm" variant="ghost" onClick={() => setEditing({ type: i.type, existing: i })}>
                  <Pencil /> Modifica
                </Button>
              )}
              <a href={i.webUrl} target="_blank" rel="noreferrer noopener" className="ml-auto">
                <Button size="sm" variant="ghost">
                  Apri <ExternalLink />
                </Button>
              </a>
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={picker} onClose={() => setPicker(false)} title="Aggiungi integrazione" wide>
        <ul className="grid gap-2 sm:grid-cols-2">
          {types.data?.map((t) => (
            <li key={t.type}>
              <button
                className="h-full w-full rounded-xl border border-line bg-surface-2 p-3 text-left hover:border-line-strong"
                onClick={() => {
                  setPicker(false);
                  setEditing({ type: t.type });
                }}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {t.label} {configured.has(t.type) && <CheckCircle2 className="size-3.5 text-ok" />}
                </div>
                <div className="mt-0.5 text-xs text-muted">{t.description}</div>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>

      {editing && types.data && (
        <IntegrationForm
          def={types.data.find((t) => t.type === editing.type)!}
          existing={editing.existing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

type TestResult = { status: Integration['status']; message: string; version?: string | null; latency: number };

function IntegrationForm({ def, existing, onClose }: { def: IntegrationType; existing?: Integration; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? def.defaultName);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? def.defaultUrl);
  const [webUrl, setWebUrl] = useState(existing?.config.webUrl ?? '');
  const [container, setContainer] = useState(existing?.config.container ?? def.defaultContainer ?? '');
  const [auth, setAuth] = useState(existing?.auth ?? def.auth[0].id);
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {});
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [test, setTest] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const method = def.auth.find((a) => a.id === auth) ?? def.auth[0];
  const body = () => ({
    type: def.type,
    name,
    baseUrl,
    auth,
    secret: Object.fromEntries(Object.entries(secret).filter(([, v]) => v)),
    config: { ...config, webUrl, container },
    enabled,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['integrations'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['resource'] });
  };

  const testM = useMutation({
    mutationFn: () => api<TestResult>('/integrations/test', { method: 'POST', body: { ...body(), id: existing?.id } }),
    onSuccess: setTest,
  });
  const saveM = useMutation({
    mutationFn: () =>
      existing ? api<Integration>(`/integrations/${existing.id}`, { method: 'PUT', body: body() }) : api<Integration>('/integrations', { method: 'POST', body: body() }),
    onSuccess: (i) => {
      refresh();
      toast(i.status === 'online' ? 'ok' : 'info', `${i.name} salvata — stato: ${i.message ?? i.status}`);
      onClose();
    },
  });
  const delM = useMutation({
    mutationFn: () => api(`/integrations/${existing!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      toast('ok', `${existing!.name} rimossa`);
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={existing ? `Modifica ${existing.name}` : `Collega ${def.label}`}
      description={def.description}
      footer={
        <>
          {existing && (
            <Button variant="ghost" className="mr-auto text-err" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Rimuovi
            </Button>
          )}
          <Button variant="secondary" onClick={() => testM.mutate()} loading={testM.isPending}>
            Verifica connessione
          </Button>
          <Button variant="primary" onClick={() => saveM.mutate()} loading={saveM.isPending}>
            Salva
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          saveM.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />}</Field>
          <Field label="URL interno API" help="Raggiunto dal server. Solo destinazioni LAN consentite.">
            {(id) => <Input id={id} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required spellCheck={false} />}
          </Field>
          <Field label="URL da aprire nel browser" help={def.defaultWebUrl ? `Predefinito: ${def.defaultWebUrl}` : 'Facoltativo'}>
            {(id) => <Input id={id} value={webUrl} onChange={(e) => setWebUrl(e.target.value)} placeholder={def.defaultWebUrl ?? baseUrl} spellCheck={false} />}
          </Field>
          <Field label="Container Docker associato" help="Collega lo stato del container all’app.">
            {(id) => <Input id={id} value={container} onChange={(e) => setContainer(e.target.value)} placeholder="nessuno" spellCheck={false} />}
          </Field>
        </div>
        {def.auth.length > 1 && (
          <Field label="Autenticazione">
            {(id) => (
              <Select id={id} value={auth} onChange={(e) => setAuth(e.target.value)}>
                {def.auth.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {method.fields.length > 0 && (
          <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
              <KeyRound className="size-3.5" /> {method.label}
            </div>
            {method.fields.map((f) => {
              const stored = existing?.secretFields.includes(f.key) && existing.auth === auth;
              return (
                <Field key={f.key} label={f.label} help={stored ? 'Valore salvato e cifrato. Lascia vuoto per mantenerlo, scrivi per sostituirlo.' : f.help}>
                  {(id) => (
                    <Input
                      id={id}
                      type={f.type}
                      value={secret[f.key] ?? ''}
                      onChange={(e) => setSecret((s) => ({ ...s, [f.key]: e.target.value }))}
                      placeholder={stored ? '•••••••• (salvato)' : ''}
                      autoComplete={f.type === 'password' ? 'new-password' : 'off'}
                      spellCheck={false}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        )}
        {def.configFields.map((f) => (
          <Field key={f.key} label={f.label} help={f.help}>
            {(id) => <Input id={id} value={config[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} />}
          </Field>
        ))}
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Abilitata (controllo di salute ogni minuto)
        </label>
        {test && (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
            <StatusBadge status={test.status} />
            <span className="min-w-0 flex-1 break-words">{test.message}</span>
            <span className="text-xs text-muted tabular">
              {test.version && `v${test.version} · `}
              {test.latency} ms
            </span>
          </div>
        )}
        {(testM.isError || saveM.isError) && <ErrorBox error={testM.error ?? saveM.error} compact />}
        <button type="submit" hidden />
      </form>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Rimuovere ${existing?.name}?`}
        description="Le credenziali cifrate verranno eliminate. Il servizio non viene toccato: smetterà solo di essere monitorato."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Annulla
            </Button>
            <Button variant="danger" onClick={() => delM.mutate()} loading={delM.isPending}>
              Rimuovi
            </Button>
          </>
        }
      >
        {delM.isError ? <ErrorBox error={delM.error} compact /> : <p className="text-xs text-muted">L’operazione viene registrata nell’audit log.</p>}
      </Dialog>
    </Dialog>
  );
}
