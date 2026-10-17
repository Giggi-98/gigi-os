// Tipi dei flussi (D-041), come li restituisce l'API.
export type FieldKind = 'text' | 'expr' | 'textarea' | 'number' | 'select' | 'multi' | 'bool' | 'channels' | 'rows' | 'secret' | 'json';
export type Option = { value: string; label: string };
export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  options?: Option[];
  columns?: { key: string; label: string; kind: 'text' | 'expr' | 'select'; options?: Option[] }[];
  min?: number;
  max?: number;
};
export type Category = 'trigger' | 'logic' | 'action';
export type NodeType = {
  type: string;
  category: Category;
  label: string;
  description: string;
  icon: string;
  fields: Field[];
  outputs: { id: string; label: string }[];
  dynamic: 'routes' | null;
  secret: 'webhook' | 'user' | null;
  trigger: string | null;
};
export type Catalog = { nodes: NodeType[]; templates: { id: string; name: string; description: string }[] };
export type Config = Record<string, unknown>;
export type WfNode = { id: string; type: string; name: string; config: Config; position: { x: number; y: number } };
export type WfEdge = { id: string; source: string; port: string; target: string };
export type Graph = { nodes: WfNode[]; edges: WfEdge[] };
export type Workflow = {
  id: string;
  name: string;
  enabled: boolean;
  graph: Graph;
  updatedAt: number;
  secrets: Record<string, { token: boolean; secret: boolean }>;
  status: Record<string, { next: number | null; error: string | null; hasSample: boolean }>;
};
export type WorkflowRow = {
  id: string;
  name: string;
  enabled: boolean;
  updatedAt: number;
  triggers: { type: string; name: string }[];
  nodes: number;
  lastRun: { status: string; at: number; error: string | null } | null;
  week: { runs: number; errors: number; waiting: number };
};
export type RunRow = { id: string; trigger: string; status: RunStatus; error: string | null; startedAt: number; finishedAt: number | null };
export type RunStatus = 'running' | 'waiting' | 'success' | 'error' | 'cancelled';
export type Step = { nodeId: string; name: string; status: 'ok' | 'error' | 'waiting' | 'skipped'; port: string | null; input: string | null; output: string | null; error: string | null; startedAt: number; finishedAt: number | null };
export type RunDetail = RunRow & { workflowId: string; steps: Step[] };
export type Approval = { id: string; runId: string; workflowId: string; workflow: string; message: string; options: string[]; createdAt: number; expiresAt: number | null };

export const RUN_STATUS: Record<RunStatus, [string, 'ok' | 'info' | 'warn' | 'err' | 'idle']> = {
  running: ['in corso', 'info'],
  waiting: ['in attesa', 'warn'],
  success: ['riuscita', 'ok'],
  error: ['errore', 'err'],
  cancelled: ['annullata', 'idle'],
};

/** Uscite di un blocco, anche quelle che dipendono dalla configurazione («Scegli strada») */
export function outputsOf(t: NodeType, config: Config) {
  if (t.dynamic === 'routes') {
    const routes = Array.isArray(config.routes) ? (config.routes as Config[]) : [];
    return [...routes.map((r, i) => ({ id: `r${i}`, label: String(r.label || `Strada ${i + 1}`) })), { id: 'else', label: 'Altrimenti' }];
  }
  return t.outputs;
}

export function defaults(t: NodeType): Config {
  return Object.fromEntries(t.fields.filter((f) => f.default !== undefined).map((f) => [f.key, structuredClone(f.default)]));
}
