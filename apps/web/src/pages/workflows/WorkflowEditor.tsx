// Editor grafico dei flussi (D-041) con React Flow (MIT): blocchi trascinabili, collegamenti tra uscite e ingressi,
// configurazione a destra, esecuzioni con il dettaglio di ogni passo.
import '@xyflow/react/dist/style.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { ArrowLeft, Check, Copy, History, KeyRound, Play, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, cx, ErrorBox, Field, Input, Select, Skeleton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { ago, dateTime } from '../../lib/format';
import { NodeIcon } from './icons';
import { defaults, outputsOf, RUN_STATUS, type Catalog, type Config, type Field as FieldDef, type Graph, type NodeType, type RunDetail, type RunRow, type Workflow } from './types';

type NData = { t: NodeType; name: string; config: Config; run?: 'ok' | 'error' | 'waiting' | null };
type FNode = Node<NData, 'gigi'>;
type Channel = { id: string; name: string; type: string; enabled: boolean };

const CAT: Record<NodeType['category'], { label: string; chip: string; ring: string }> = {
  trigger: { label: 'Ricezione', chip: 'bg-info-soft text-info', ring: 'border-info/50' },
  logic: { label: 'Logica', chip: 'bg-warn-soft text-warn', ring: 'border-warn/50' },
  action: { label: 'Azioni', chip: 'bg-ok-soft text-ok', ring: 'border-ok/50' },
};
const rid = (p: string) => `${p}${Math.random().toString(36).slice(2, 10)}`;

const GigiNode = memo(function GigiNode({ data, selected }: NodeProps<FNode>) {
  const t = data.t;
  const outs = outputsOf(t, data.config);
  const run = data.run;
  return (
    <div
      className={cx(
        'w-[210px] rounded-xl border bg-surface text-left',
        selected ? 'border-accent ring-2 ring-accent/30' : run === 'error' ? 'border-err ring-2 ring-err/25' : run === 'waiting' ? 'border-warn ring-2 ring-warn/25' : run === 'ok' ? 'border-ok/70' : 'border-line',
      )}
      style={{ boxShadow: 'var(--shadow)' }}
    >
      {t.category !== 'trigger' && <Handle type="target" position={Position.Left} className="!size-3 !border-2 !border-surface !bg-muted" />}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg', CAT[t.category].chip)}>
          <NodeIcon name={t.icon} className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-fg">{data.name}</div>
          <div className="truncate text-[10px] text-muted">{t.label}</div>
        </div>
      </div>
      {outs.length > 0 && (
        <div className="border-t border-line py-1">
          {outs.map((o) => (
            <div key={o.id} className="relative flex h-6 items-center justify-end pr-3 text-[10px] text-muted">
              {o.label}
              <Handle type="source" id={o.id} position={Position.Right} className="!size-3 !border-2 !border-surface !bg-accent" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
const nodeTypes = { gigi: GigiNode };

export function WorkflowEditorPage() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

function toGraph(nodes: FNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.t.type, name: n.data.name.trim(), config: n.data.config, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, port: e.sourceHandle ?? 'out', target: e.target })),
  };
}

function Editor() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const rf = useReactFlow();
  const wf = useQuery({ queryKey: ['workflow', id], queryFn: () => api<Workflow>(`/workflows/${id}`) });
  const catalog = useQuery({ queryKey: ['workflow-catalog'], queryFn: () => api<Catalog>('/workflows/catalog'), staleTime: Infinity });
  const channels = useQuery({ queryKey: ['auto-channels'], queryFn: () => api<Channel[]>('/automations/channels') });
  const [nodes, setNodes] = useState<FNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const loaded = useRef(false);
  const types = useMemo(() => new Map((catalog.data?.nodes ?? []).map((t) => [t.type, t])), [catalog.data]);

  useEffect(() => {
    if (loaded.current || !wf.data || !catalog.data) return;
    loaded.current = true;
    setName(wf.data.name);
    setNodes(wf.data.graph.nodes.filter((n) => types.has(n.type)).map((n) => ({ id: n.id, type: 'gigi', position: n.position, data: { t: types.get(n.type)!, name: n.name, config: n.config } })));
    setEdges(wf.data.graph.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.port, target: e.target })));
  }, [wf.data, catalog.data, types]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const onNodesChange = useCallback((ch: NodeChange<FNode>[]) => {
    setNodes((ns) => applyNodeChanges(ch, ns));
    if (ch.some((c) => c.type === 'remove' || (c.type === 'position' && !c.dragging))) setDirty(true);
    for (const c of ch) if (c.type === 'select') setSelected((s) => (c.selected ? c.id : s === c.id ? null : s));
  }, []);
  const onEdgesChange = useCallback((ch: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(ch, es));
    if (ch.some((c) => c.type === 'remove')) setDirty(true);
  }, []);
  // Niente ingressi nei blocchi di ricezione, niente doppioni, niente cicli
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const target = nodes.find((n) => n.id === c.target);
      if (!target || c.source === c.target || target.data.t.category === 'trigger') return false;
      if (edges.some((e) => e.source === c.source && (e.sourceHandle ?? 'out') === (c.sourceHandle ?? 'out') && e.target === c.target)) return false;
      const seen = new Set<string>();
      const reaches = (from: string): boolean => {
        if (from === c.source) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return edges.filter((e) => e.source === from).some((e) => reaches(e.target));
      };
      return !reaches(c.target!);
    },
    [nodes, edges],
  );
  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => [...es, { id: rid('e'), source: c.source, sourceHandle: c.sourceHandle ?? 'out', target: c.target }]);
    setDirty(true);
  }, []);

  const addNode = (t: NodeType) => {
    const base = t.label.replace(/[()]/g, '').slice(0, 40);
    let n = base;
    for (let i = 2; nodes.some((x) => x.data.name.toLowerCase() === n.toLowerCase()); i++) n = `${base} ${i}`;
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const node: FNode = { id: rid('n'), type: 'gigi', position: { x: center.x - 105 + Math.random() * 40, y: center.y - 40 + Math.random() * 40 }, data: { t, name: n, config: defaults(t) }, selected: true };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), node]);
    setSelected(node.id);
    setDirty(true);
  };

  const patchNode = (nid: string, p: Partial<Pick<NData, 'name' | 'config'>>) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...p } } : n)));
    // Uscite tolte (es. una strada di «Scegli strada»): via anche i loro collegamenti
    if (p.config) {
      const node = nodes.find((n) => n.id === nid);
      if (node) {
        const ports = new Set(outputsOf(node.data.t, p.config).map((o) => o.id));
        setEdges((es) => es.filter((e) => e.source !== nid || ports.has(e.sourceHandle ?? 'out')));
      }
    }
    setDirty(true);
  };
  const removeNode = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSelected(null);
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (p: { enabled?: boolean } = {}) => api<Workflow>(`/workflows/${id}`, { method: 'PUT', body: { name, graph: toGraph(nodes, edges), ...p } }),
    onSuccess: (r) => {
      qc.setQueryData(['workflow', id], (old: Workflow | undefined) => ({ ...(old ?? r), ...r }));
      void qc.invalidateQueries({ queryKey: ['workflow', id] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      setDirty(false);
      toast('ok', 'Flusso salvato');
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const run = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync({});
      const trig = nodes.find((n) => n.id === selected && n.data.t.category === 'trigger');
      return api<{ runId: string }>(`/workflows/${id}/run`, { method: 'POST', body: trig ? { nodeId: trig.id } : {} });
    },
    onSuccess: (r) => {
      setShowRuns(true);
      setRunId(r.runId);
      void qc.invalidateQueries({ queryKey: ['workflow-runs', id] });
    },
    onError: (e: Error) => toast('err', e.message),
  });
  const del = useMutation({
    mutationFn: () => api(`/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      nav('/automazioni?tab=flows');
    },
    onError: (e: Error) => toast('err', e.message),
  });

  // Esecuzione scelta: i blocchi si colorano con l'esito del loro ultimo passo
  const detail = useQuery({
    queryKey: ['workflow-run', runId],
    queryFn: () => api<RunDetail>(`/workflow-runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && ['running'].includes(q.state.data.status) ? 1500 : false),
  });
  useEffect(() => {
    const st = new Map<string, 'ok' | 'error' | 'waiting'>();
    for (const s of detail.data?.steps ?? []) if (s.status !== 'skipped') st.set(s.nodeId, s.status);
    setNodes((ns) => ns.map((n) => (n.data.run === (st.get(n.id) ?? null) ? n : { ...n, data: { ...n.data, run: st.get(n.id) ?? null } })));
  }, [detail.data]);

  if (wf.isError) return <ErrorBox error={wf.error} />;
  if (catalog.isError) return <ErrorBox error={catalog.error} />;
  if (!wf.data || !catalog.data) return <Skeleton className="h-[70vh]" />;
  const sel = nodes.find((n) => n.id === selected) ?? null;
  const saved = new Set(wf.data.graph.nodes.map((n) => n.id));
  const enabled = wf.data.enabled;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (!dirty || window.confirm('Ci sono modifiche non salvate: uscire comunque?')) nav('/automazioni?tab=flows');
          }}
        >
          <ArrowLeft /> Flussi
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          aria-label="Nome del flusso"
          className="h-8 max-w-xs font-medium"
          maxLength={80}
        />
        <Badge tone={enabled ? 'ok' : 'idle'}>{enabled ? 'attivo' : 'spento'}</Badge>
        {dirty && <span className="text-xs text-warn">modifiche non salvate</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowRuns((v) => !v)} aria-pressed={showRuns}>
            <History /> Esecuzioni
          </Button>
          <Button size="sm" onClick={() => run.mutate()} loading={run.isPending} title="Esegue dal blocco di ricezione selezionato (o dall’avvio manuale) con i dati di prova o con l’ultimo evento ricevuto">
            <Play /> Esegui
          </Button>
          <Button size="sm" onClick={() => save.mutate({ enabled: !enabled })} loading={save.isPending && save.variables?.enabled !== undefined}>
            {enabled ? 'Spegni' : 'Attiva'}
          </Button>
          <Button size="sm" variant="primary" onClick={() => save.mutate({})} loading={save.isPending && save.variables?.enabled === undefined} disabled={!dirty}>
            <Save /> Salva
          </Button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[210px_minmax(0,1fr)_340px]">
        <Palette catalog={catalog.data} onAdd={addNode} />
        <div className="flex min-w-0 flex-col gap-3">
          <div className="h-[62vh] min-h-[420px] overflow-hidden rounded-2xl border border-line bg-bg-2">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              deleteKeyCode={['Delete', 'Backspace']}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.2}
              proOptions={{ hideAttribution: false }}
              defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
              colorMode={document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}
            >
              <Background gap={20} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {showRuns && <RunsPanel wfId={id} runId={runId} onPick={setRunId} detail={detail.data ?? null} onClose={() => { setShowRuns(false); setRunId(null); }} />}
        </div>
        <div className="min-w-0">
          {sel ? (
            <NodePanel
              key={sel.id}
              wfId={id}
              node={sel}
              saved={saved.has(sel.id) && !dirty}
              wf={wf.data}
              channels={channels.data ?? []}
              allNames={nodes.filter((n) => n.id !== sel.id).map((n) => n.data.name.toLowerCase())}
              onChange={(p) => patchNode(sel.id, p)}
              onRemove={() => removeNode(sel.id)}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['workflow', id] })}
            />
          ) : (
            <Help onDelete={() => window.confirm(`Eliminare il flusso «${wf.data.name}» con tutto il suo storico?`) && del.mutate()} />
          )}
        </div>
      </div>
    </div>
  );
}

function Palette({ catalog, onAdd }: { catalog: Catalog; onAdd: (t: NodeType) => void }) {
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-3 lg:max-h-[calc(62vh+2px)] lg:overflow-y-auto">
      {(['trigger', 'logic', 'action'] as const).map((c) => (
        <div key={c}>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{CAT[c].label}</div>
          <ul className="grid grid-cols-2 gap-1 lg:grid-cols-1">
            {catalog.nodes
              .filter((t) => t.category === c)
              .map((t) => (
                <li key={t.type}>
                  <button
                    type="button"
                    onClick={() => onAdd(t)}
                    title={t.description}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-fg-2 hover:bg-surface-2 hover:text-fg"
                  >
                    <span className={cx('grid size-6 shrink-0 place-items-center rounded-md', CAT[c].chip)}>
                      <NodeIcon name={t.icon} className="size-3.5" />
                    </span>
                    <span className="min-w-0 truncate">{t.label}</span>
                    <Plus className="ml-auto size-3 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Help({ onDelete }: { onDelete: () => void }) {
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-4 text-xs text-muted">
      <p className="text-[13px] font-medium text-fg-2">Come si usa</p>
      <ul className="list-disc space-y-1.5 pl-4">
        <li>Aggiungi i blocchi dalla colonna a sinistra e trascinali.</li>
        <li>Collega un’uscita (pallino a destra) all’ingresso di un altro blocco (pallino a sinistra).</li>
        <li>Clicca un blocco per configurarlo; Canc o Backspace lo elimina.</li>
        <li>
          Nei campi puoi usare i dati dei passi precedenti: <code className="font-mono text-fg-2">{'{{ json.title }}'}</code> (dati attuali),{' '}
          <code className="font-mono text-fg-2">{'{{ trigger.body.date }}'}</code> (cosa è arrivato), <code className="font-mono text-fg-2">{'{{ node.NomeBlocco.campo }}'}</code>. Sono espressioni{' '}
          <a className="text-accent hover:underline" href="https://docs.jsonata.org/overview" target="_blank" rel="noreferrer">JSONata</a>.
        </li>
        <li>«Esegui» prova il flusso con i dati di prova o con l’ultimo evento ricevuto; in «Esecuzioni» vedi cosa ha fatto ogni blocco.</li>
      </ul>
      <Button size="sm" variant="ghost" className="text-err" onClick={onDelete}>
        <Trash2 /> Elimina il flusso
      </Button>
    </div>
  );
}

// ───────── configurazione del blocco ─────────
function NodePanel({
  wfId,
  node,
  saved,
  wf,
  channels,
  allNames,
  onChange,
  onRemove,
  onSaved,
}: {
  wfId: string;
  node: FNode;
  saved: boolean;
  wf: Workflow;
  channels: Channel[];
  allNames: string[];
  onChange: (p: Partial<Pick<NData, 'name' | 'config'>>) => void;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const t = node.data.t;
  const cfg = node.data.config;
  const set = (k: string, v: unknown) => onChange({ config: { ...cfg, [k]: v } });
  const dup = allNames.includes(node.data.name.trim().toLowerCase());
  const status = wf.status[node.id];
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(62vh+2px)] lg:overflow-y-auto">
      <div className="flex items-start gap-2">
        <span className={cx('grid size-8 shrink-0 place-items-center rounded-lg', CAT[t.category].chip)}>
          <NodeIcon name={t.icon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{t.label}</div>
          <p className="text-xs text-muted">{t.description}</p>
        </div>
        <Button size="icon" variant="ghost" onClick={onRemove} aria-label="Elimina il blocco" title="Elimina il blocco">
          <Trash2 />
        </Button>
      </div>
      <Field label="Nome del blocco" error={dup ? 'Un altro blocco ha già questo nome' : null} help="Serve nelle espressioni: {{ node.Nome.campo }}">
        {(id) => <Input id={id} value={node.data.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} />}
      </Field>
      {t.fields.map((f) => (
        <FieldInput key={f.key} f={f} value={cfg[f.key]} onChange={(v) => set(f.key, v)} channels={channels} />
      ))}
      {status?.error && <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Ultimo controllo non riuscito: {status.error}</p>}
      {status?.next && t.trigger !== 'webhook' && <p className="text-xs text-muted">Prossimo controllo {dateTime(status.next)}</p>}
      {t.secret === 'webhook' && <WebhookBox wfId={wfId} nodeId={node.id} saved={saved} hasToken={!!wf.secrets[node.id]?.token} onSaved={onSaved} />}
      {t.secret === 'user' && <SecretBox wfId={wfId} nodeId={node.id} saved={saved} has={!!wf.secrets[node.id]?.secret} onSaved={onSaved} kind={t.type} />}
      {t.category === 'trigger' && t.trigger !== 'manual' && <SampleBox wfId={wfId} nodeId={node.id} saved={saved} webhook={t.trigger === 'webhook'} />}
    </div>
  );
}

function FieldInput({ f, value, onChange, channels }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void; channels: Channel[] }) {
  const v = value ?? '';
  const mono = f.kind === 'expr' || f.kind === 'textarea' || f.kind === 'json';
  const label = `${f.label}${f.required ? ' *' : ''}`;
  if (f.kind === 'bool')
    return (
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" className="size-4 [--check:var(--accent)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {f.label}
      </label>
    );
  if (f.kind === 'multi' || f.kind === 'channels') {
    const opts = f.kind === 'channels' ? channels.map((c) => ({ value: c.id, label: `${c.name}${c.enabled ? '' : ' (spento)'}` })) : f.options ?? [];
    const cur = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-fg-2">{label}</legend>
        {opts.length === 0 && <p className="text-xs text-muted">Nessun canale: aggiungilo in Automazioni → Canali.</p>}
        <div className="flex flex-wrap gap-1.5">
          {opts.map((o) => {
            const on = cur.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? cur.filter((x) => x !== o.value) : [...cur, o.value])}
                className={cx('rounded-lg border px-2 py-1 text-xs', on ? 'border-accent/60 bg-accent-soft text-fg' : 'border-line text-muted hover:text-fg')}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {f.help && <p className="mt-1 text-xs text-muted">{f.help}</p>}
      </fieldset>
    );
  }
  if (f.kind === 'rows') return <RowsInput f={f} value={value} onChange={onChange} />;
  return (
    <Field label={label} help={f.help}>
      {(id) =>
        f.kind === 'select' ? (
          <Select id={id} value={String(v)} onChange={(e) => onChange(e.target.value)}>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : f.kind === 'textarea' || f.kind === 'json' ? (
          <textarea
            id={id}
            value={String(v)}
            onChange={(e) => onChange(e.target.value)}
            rows={f.kind === 'json' ? 6 : 3}
            placeholder={f.placeholder}
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
          />
        ) : (
          <Input
            id={id}
            type={f.kind === 'number' ? 'number' : 'text'}
            value={String(v)}
            min={f.min}
            max={f.max}
            step="any"
            placeholder={f.placeholder}
            spellCheck={false}
            className={cx(mono && 'font-mono text-xs')}
            onChange={(e) => onChange(f.kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
          />
        )
      }
    </Field>
  );
}

function RowsInput({ f, value, onChange }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const rows = Array.isArray(value) ? (value as Config[]) : [];
  const cols = f.columns ?? [];
  const put = (i: number, k: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-fg-2">{f.label}</legend>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-line bg-surface-2 p-2">
            {cols.map((c) =>
              c.kind === 'select' ? (
                <Select key={c.key} aria-label={c.label} value={String(r[c.key] ?? c.options?.[0]?.value ?? '')} onChange={(e) => put(i, c.key, e.target.value)} className="h-8 text-xs">
                  {c.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input key={c.key} aria-label={c.label} placeholder={c.label} value={String(r[c.key] ?? '')} onChange={(e) => put(i, c.key, e.target.value)} className={cx('h-8 text-xs', c.kind === 'expr' && 'font-mono')} spellCheck={false} />
              ),
            )}
            <button type="button" className="text-[11px] text-muted hover:text-err" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              Rimuovi
            </button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => onChange([...rows, Object.fromEntries(cols.map((c) => [c.key, c.kind === 'select' ? c.options?.[0]?.value ?? '' : '']))])} disabled={rows.length >= 30}>
          <Plus /> Aggiungi
        </Button>
      </div>
      {f.help && <p className="mt-1 text-xs text-muted">{f.help}</p>}
    </fieldset>
  );
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 font-mono text-[11px]" title={text}>
        {text}
      </code>
      <Button size="icon" variant="ghost" aria-label={label} onClick={() => void navigator.clipboard?.writeText(text).then(() => setOk(true))}>
        {ok ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function WebhookBox({ wfId, nodeId, saved, hasToken, onSaved }: { wfId: string; nodeId: string; saved: boolean; hasToken: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const url = `${location.origin}/api/v1/hooks/${wfId}/${nodeId}`;
  const gen = useMutation({
    mutationFn: () => api<{ token: string }>(`/workflows/${wfId}/nodes/${nodeId}/token`, { method: 'POST' }),
    onSuccess: (r) => {
      setToken(r.token);
      onSaved();
    },
    onError: (e: Error) => toast('err', e.message),
  });
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium text-fg-2">
        <KeyRound className="size-3.5" /> Indirizzo e token
      </div>
      {!saved ? (
        <p className="text-muted">Salva il flusso per ottenere l’indirizzo e il token.</p>
      ) : (
        <>
          <CopyLine text={url} label="Copia l’indirizzo" />
          <p className="text-muted">
            Metodo POST o PUT, corpo JSON, intestazione <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>. Raggiungibile dalla rete locale o dalla VPN; il certificato è quello di GIGI OS (autofirmato).
          </p>
          {token ? (
            <div className="space-y-1.5 rounded-lg border border-warn/40 bg-warn-soft p-2">
              <p className="font-medium text-warn">Copialo adesso: non verrà più mostrato.</p>
              <CopyLine text={token} label="Copia il token" />
              <CopyLine
                text={`curl -k -X POST '${url}' -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '{"status":"confermato","title":"Dune","year":2021,"date":"2026-11-20"}'`}
                label="Copia il comando di prova"
              />
            </div>
          ) : (
            <p className={hasToken ? 'text-ok' : 'text-warn'}>{hasToken ? 'Token impostato.' : 'Nessun token: generalo prima di attivare il flusso.'}</p>
          )}
          <Button size="sm" onClick={() => (!hasToken || window.confirm('Il token attuale smetterà di funzionare. Continuare?')) && gen.mutate()} loading={gen.isPending}>
            <RefreshCw /> {hasToken ? 'Rigenera il token' : 'Genera il token'}
          </Button>
        </>
      )}
    </div>
  );
}

function SecretBox({ wfId, nodeId, saved, has, onSaved, kind }: { wfId: string; nodeId: string; saved: boolean; has: boolean; onSaved: () => void; kind: string }) {
  const toast = useToast();
  const [v, setV] = useState('');
  const put = useMutation({
    mutationFn: (value: string | null) => api(`/workflows/${wfId}/nodes/${nodeId}/secret`, { method: 'PUT', body: { value } }),
    onSuccess: (_r, value) => {
      setV('');
      toast('ok', value ? 'Token salvato, cifrato' : 'Token rimosso');
      onSaved();
    },
    onError: (e: Error) => toast('err', e.message),
  });
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium text-fg-2">
        <KeyRound className="size-3.5" /> Token (facoltativo)
      </div>
      <p className="text-muted">
        {kind === 'trigger.github' ? 'Per le repo private: token «fine-grained» di GitHub con accesso in sola lettura ai contenuti di quella repo.' : 'Inviato come Authorization: Bearer.'} Salvato cifrato, mai mostrato.
      </p>
      {!saved ? (
        <p className="text-muted">Salva il flusso per impostarlo.</p>
      ) : (
        <div className="flex gap-2">
          <Input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder={has ? '•••••••• (impostato)' : 'Incolla il token'} autoComplete="off" className="h-8 text-xs" />
          <Button size="sm" onClick={() => put.mutate(v)} disabled={!v} loading={put.isPending}>
            Salva
          </Button>
          {has && (
            <Button size="sm" variant="ghost" onClick={() => put.mutate(null)}>
              Rimuovi
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Percorsi di un oggetto, per scrivere le espressioni sui dati veri */
function paths(v: unknown, prefix: string, out: string[] = [], depth = 0): string[] {
  if (out.length > 60 || depth > 4) return out;
  if (Array.isArray(v)) {
    if (v.length) paths(v[0], `${prefix}[0]`, out, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = /^[A-Za-z_]\w*$/.test(k) ? `${prefix}.${k}` : `${prefix}.\`${k}\``;
      if (x && typeof x === 'object') paths(x, p, out, depth + 1);
      else out.push(p);
    }
  }
  return out;
}

function SampleBox({ wfId, nodeId, saved, webhook }: { wfId: string; nodeId: string; saved: boolean; webhook: boolean }) {
  const q = useQuery({ queryKey: ['workflow-sample', wfId, nodeId], queryFn: () => api<{ sample: unknown }>(`/workflows/${wfId}/nodes/${nodeId}/sample`), enabled: saved, refetchInterval: 10_000 });
  const [copied, setCopied] = useState<string | null>(null);
  const s = q.data?.sample;
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium text-fg-2">Ultimo evento ricevuto</div>
      {!saved ? (
        <p className="text-muted">Salva il flusso per vederlo.</p>
      ) : s === null || s === undefined ? (
        <p className="text-muted">{webhook ? 'Ancora nessuno. Fai mandare un evento di prova (anche a flusso spento): lo trovi qui con i suoi campi.' : 'Ancora nessuno: compare dopo il primo controllo con elementi nuovi.'}</p>
      ) : (
        <>
          <p className="text-muted">Clicca un campo per copiare l’espressione:</p>
          <div className="flex flex-wrap gap-1">
            {paths(s, 'trigger').map((p) => (
              <button
                key={p}
                type="button"
                className={cx('rounded border px-1.5 py-0.5 font-mono text-[11px]', copied === p ? 'border-ok text-ok' : 'border-line text-fg-2 hover:border-accent')}
                onClick={() => void navigator.clipboard?.writeText(`{{ ${p} }}`).then(() => setCopied(p))}
              >
                {p}
              </button>
            ))}
          </div>
          <pre className="max-h-48 overflow-auto rounded bg-surface p-2 font-mono text-[11px] text-fg-2">{JSON.stringify(s, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

// ───────── esecuzioni ─────────
function RunsPanel({ wfId, runId, onPick, detail, onClose }: { wfId: string; runId: string | null; onPick: (id: string) => void; detail: RunDetail | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const runs = useQuery({ queryKey: ['workflow-runs', wfId], queryFn: () => api<RunRow[]>(`/workflows/${wfId}/runs`), refetchInterval: 5000 });
  const [open, setOpen] = useState<number | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/workflow-runs/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workflow-runs', wfId] });
      void qc.invalidateQueries({ queryKey: ['workflow-run'] });
    },
    onError: (e: Error) => toast('err', e.message),
  });
  return (
    <div className="grid gap-3 rounded-2xl border border-line bg-surface p-3 md:grid-cols-[240px_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-fg-2">
          Esecuzioni
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Chiudi le esecuzioni">
            <X />
          </Button>
        </div>
        {runs.isError && <ErrorBox error={runs.error} compact />}
        {runs.data?.length === 0 && <p className="text-xs text-muted">Nessuna esecuzione.</p>}
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {runs.data?.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onPick(r.id)}
                className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs', runId === r.id ? 'bg-accent-soft' : 'hover:bg-surface-2')}
              >
                <Badge tone={RUN_STATUS[r.status][1]}>{RUN_STATUS[r.status][0]}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted" title={r.trigger}>
                  {r.trigger}
                </span>
                <span className="shrink-0 text-muted">{ago(r.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">
        {!detail ? (
          <p className="text-xs text-muted">Scegli un’esecuzione per vedere cosa ha fatto ogni blocco.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={RUN_STATUS[detail.status][1]}>{RUN_STATUS[detail.status][0]}</Badge>
              <span className="text-muted">{dateTime(detail.startedAt)}</span>
              {['running', 'waiting'].includes(detail.status) && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => cancel.mutate(detail.id)} loading={cancel.isPending}>
                  Annulla
                </Button>
              )}
            </div>
            {detail.error && <p className="rounded-lg bg-err-soft px-3 py-2 text-xs text-err">{detail.error}</p>}
            <ol className="space-y-1">
              {detail.steps.map((s, i) => (
                <li key={i} className="rounded-lg border border-line">
                  <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                    <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'error' ? 'err' : s.status === 'waiting' ? 'warn' : 'idle'}>{s.status === 'ok' ? 'ok' : s.status === 'error' ? 'errore' : s.status === 'waiting' ? 'in attesa' : s.status}</Badge>
                    <span className="min-w-0 flex-1 truncate font-medium text-fg-2">{s.name}</span>
                    {s.port && s.port !== 'out' && <span className="text-muted">→ {s.port}</span>}
                    {s.finishedAt && <span className="text-muted">{Math.max(0, s.finishedAt - s.startedAt)} ms</span>}
                  </button>
                  {open === i && (
                    <div className="space-y-1.5 border-t border-line p-2.5 text-[11px]">
                      {s.error && <p className="text-err">{s.error}</p>}
                      {s.input && <Json label="Ingresso" raw={s.input} />}
                      {s.output && <Json label="Uscita" raw={s.output} />}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

function Json({ label, raw }: { label: string; raw: string }) {
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {}
  return (
    <div>
      <div className="mb-0.5 text-muted">{label}</div>
      <pre className="max-h-56 overflow-auto rounded bg-surface-2 p-2 font-mono text-fg-2">{pretty}</pre>
    </div>
  );
}

