import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  FileText,
  FileVideo,
  Folder,
  FolderInput,
  FolderPlus,
  Home,
  Image as ImageIcon,
  Link2,
  Music,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, cx, Dialog, Empty, ErrorBox, Field, Input, Meter, PageHeader, Select, Skeleton, Tabs, useToast } from '../components/ui';
import { api, getCsrf } from '../lib/api';
import { ago, bytes, dateTime } from '../lib/format';

type Root = { id: string; label: string; path: string };
type Entry = { name: string; type: 'dir' | 'file' | 'symlink' | 'other'; size: number | null; mtime: number; mode: string; owner: string; group: string; links: number | null };
type Listing = { root: string; path: string; entries: Entry[]; truncated: boolean };
type TrashBatch = { batch: string; ts: number; items: { from: string; name: string; size: number | null }[] };

const VIDEO = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;
const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const AUDIO = /\.(mp3|flac|ogg|m4a|opus|wav)$/i;
const TEXT = /\.(txt|log|nfo|srt|ass|ssa|vtt|json|ya?ml|conf|ini|md|csv|xml|sh|env\.example)$/i;

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const fileUrl = (root: string, p: string, download = false) => `/api/v1/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;

function iconFor(e: Entry) {
  if (e.type === 'dir') return <Folder className="text-accent" />;
  if (VIDEO.test(e.name)) return <FileVideo className="text-info" />;
  if (IMAGE.test(e.name)) return <ImageIcon className="text-ok" />;
  if (AUDIO.test(e.name)) return <Music className="text-warn" />;
  if (TEXT.test(e.name)) return <FileText />;
  return <FileIcon />;
}

export function FilesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const roots = useQuery({ queryKey: ['files-roots'], queryFn: () => api<Root[]>('/files/roots'), staleTime: Infinity });
  const root = params.get('root') ?? roots.data?.[0]?.id ?? '';
  const cwd = params.get('path') ?? '';
  const view = params.get('view') === 'trash' ? 'trash' : 'files';
  const go = (p: string, r = root) => setParams({ root: r, path: p });

  const list = useQuery({
    queryKey: ['files', root, cwd],
    queryFn: () => api<Listing>(`/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(cwd)}`),
    enabled: !!root && view === 'files',
  });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Entry | null>(null);
  const [dialog, setDialog] = useState<null | 'mkdir' | 'rename' | 'transfer' | 'trash' | 'search'>(null);
  const [uploads, setUploads] = useState<{ name: string; loaded: number; total: number; error?: string }[]>([]);
  useEffect(() => {
    setSel(new Set());
    setOpen(null);
    setFilter('');
  }, [root, cwd]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['files'] });
  const post = useMutation({
    mutationFn: ({ route, body }: { route: string; body: unknown }) => api<{ ok: boolean }>(`/files/${route}`, { method: 'POST', body }),
    onSuccess: refresh,
  });

  const entries = useMemo(() => (list.data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase())), [list.data, filter]);
  const selected = entries.filter((e) => sel.has(e.name));
  const selSize = selected.reduce((a, e) => a + (e.size ?? 0), 0);
  const crumbs = cwd ? cwd.split('/') : [];
  const rootLabel = roots.data?.find((r) => r.id === root)?.label ?? root;

  const upload = (filesList: FileList | null) => {
    if (!filesList?.length) return;
    for (const f of Array.from(filesList)) {
      setUploads((u) => [...u, { name: f.name, loaded: 0, total: f.size }]);
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/v1/files/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(cwd)}&name=${encodeURIComponent(f.name)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-CSRF-Token', getCsrf() ?? '');
      xhr.upload.onprogress = (ev) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, loaded: ev.loaded } : x)));
      xhr.onload = () => {
        let err: string | undefined;
        if (xhr.status >= 400) {
          try {
            err = JSON.parse(xhr.responseText).error;
          } catch {
            err = `Errore ${xhr.status}`;
          }
        }
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, loaded: x.total, error: err } : x)));
        if (err) toast('err', `${f.name}: ${err}`);
        else {
          toast('ok', `Caricato: ${f.name}`);
          setTimeout(() => setUploads((u) => u.filter((x) => x.name !== f.name)), 2500);
        }
        refresh();
      };
      xhr.onerror = () => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, error: 'Rete' } : x)));
      xhr.send(f);
    }
  };

  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div>
      <PageHeader
        title="File"
        description="File manager limitato alle cartelle consentite. Le eliminazioni passano dal cestino; nessuna operazione sovrascrive file esistenti."
        actions={
          view === 'files' ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog('search')}>
                <Search /> Cerca
              </Button>
              <Button size="sm" onClick={() => setDialog('mkdir')}>
                <FolderPlus /> Nuova cartella
              </Button>
              <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()}>
                <Upload /> Carica
              </Button>
              <input ref={fileInput} type="file" multiple className="sr-only" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
            </>
          ) : undefined
        }
      />
      {roots.isError && <ErrorBox error={roots.error} />}
      <Tabs
        value={view === 'trash' ? `trash:${root}` : root}
        onChange={(v: string) => (v.startsWith('trash:') ? setParams({ root, view: 'trash' }) : go('', v))}
        items={[...(roots.data ?? []).map((r) => ({ id: r.id, label: r.label })), { id: `trash:${root}`, label: <span className="flex items-center gap-1"><Trash2 className="size-3.5" /> Cestino</span> }]}
      />

      {view === 'trash' ? (
        <TrashView root={root} rootLabel={rootLabel} />
      ) : (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <nav aria-label="Percorso" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[13px]">
              <button className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-2" onClick={() => go('')}>
                <Home className="size-3.5" /> {rootLabel}
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center">
                  <ChevronRight className="size-3.5 text-muted" />
                  <button className="max-w-[220px] truncate rounded-md px-1.5 py-1 hover:bg-surface-2" onClick={() => go(crumbs.slice(0, i + 1).join('/'))}>
                    {c}
                  </button>
                </span>
              ))}
            </nav>
            <Input className="h-8 w-48 text-xs" placeholder="Filtra questa cartella…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtra" />
          </div>

          {selected.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft px-2 py-1.5">
              <span className="px-1 text-xs font-medium">
                {selected.length} selezionati{selSize ? ` · ${bytes(selSize)}` : ''}
              </span>
              {selected.length === 1 && (
                <Button size="sm" variant="ghost" onClick={() => setDialog('rename')}>
                  <Pencil /> Rinomina
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setDialog('transfer')}>
                <FolderInput /> Sposta / copia
              </Button>
              <Button size="sm" variant="ghost" className="text-err" onClick={() => setDialog('trash')}>
                <Trash2 /> Elimina
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(new Set())}>
                <X /> Deseleziona
              </Button>
            </div>
          )}

          {uploads.length > 0 && (
            <Card className="mb-3">
              <ul className="space-y-2">
                {uploads.map((u) => (
                  <li key={u.name} className="text-xs">
                    <div className="mb-1 flex justify-between gap-2">
                      <span className="truncate">{u.name}</span>
                      <span className={cx('tabular', u.error ? 'text-err' : 'text-muted')}>{u.error ?? `${bytes(u.loaded)} / ${bytes(u.total)}`}</span>
                    </div>
                    <Meter value={u.total ? (u.loaded / u.total) * 100 : 100} tone={u.error ? 'err' : u.loaded >= u.total ? 'ok' : 'info'} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex gap-4">
            <Card bodyClassName="!p-0" className="min-w-0 flex-1">
              {list.isError && (
                <div className="p-4">
                  <ErrorBox error={list.error} />
                </div>
              )}
              {!list.data && !list.isError && (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              )}
              {list.data && entries.length === 0 && <Empty icon={<Folder />} title={filter ? 'Nessun elemento corrisponde' : 'Cartella vuota'} />}
              {list.data && entries.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-[13px]">
                    <thead className="border-b border-line text-xs text-muted">
                      <tr>
                        <th className="w-10 py-2 pl-4">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            checked={selected.length === entries.length && entries.length > 0}
                            onChange={() => setSel(selected.length === entries.length ? new Set() : new Set(entries.map((e) => e.name)))}
                            aria-label="Seleziona tutto"
                          />
                        </th>
                        <th className="py-2 font-medium">Nome</th>
                        <th className="px-3 py-2 text-right font-medium">Dimensione</th>
                        <th className="px-3 py-2 font-medium">Modificato</th>
                        <th className="px-4 py-2 font-medium">Permessi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.name} className={cx('border-b border-line/60 last:border-0 hover:bg-surface-2', (sel.has(e.name) || open?.name === e.name) && 'bg-accent-soft/40')}>
                          <td className="py-2 pl-4">
                            <input
                              type="checkbox"
                              className="size-4 accent-[var(--accent)]"
                              checked={sel.has(e.name)}
                              onChange={() => setSel((s) => { const n = new Set(s); if (n.has(e.name)) n.delete(e.name); else n.add(e.name); return n; })}
                              aria-label={`Seleziona ${e.name}`}
                            />
                          </td>
                          <td className="max-w-[460px] py-2">
                            <button
                              className="flex w-full min-w-0 items-center gap-2 text-left [&>svg]:size-4 [&>svg]:shrink-0"
                              onClick={() => (e.type === 'dir' ? go(join(cwd, e.name)) : setOpen(e))}
                              title={e.name}
                            >
                              {iconFor(e)}
                              <span className="truncate">{e.name}</span>
                              {e.type === 'symlink' && <Badge>link</Badge>}
                              {(e.links ?? 1) > 1 && <Badge tone="ok" className="shrink-0"><Link2 className="size-3" /> {e.links}</Badge>}
                            </button>
                          </td>
                          <td className="px-3 text-right text-xs text-muted tabular">{e.size !== null ? bytes(e.size) : '—'}</td>
                          <td className="px-3 text-xs text-muted">{ago(e.mtime)}</td>
                          <td className="px-4 font-mono text-[11px] text-muted">
                            {e.mode} {e.owner}:{e.group}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            {open && <Detail root={root} cwd={cwd} entry={open} onClose={() => setOpen(null)} onAction={(a) => { setSel(new Set([open.name])); setDialog(a); }} />}
          </div>
        </div>
      )}

      {dialog === 'mkdir' && (
        <NameDialog
          title="Nuova cartella"
          initial=""
          pending={post.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(name) => post.mutate({ route: 'mkdir', body: { root, path: cwd, name } }, { onSuccess: () => { toast('ok', 'Cartella creata'); setDialog(null); }, onError: (e) => toast('err', (e as Error).message) })}
        />
      )}
      {dialog === 'rename' && selected[0] && (
        <NameDialog
          title={`Rinomina «${selected[0].name}»`}
          initial={selected[0].name}
          pending={post.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(name) =>
            post.mutate(
              { route: 'rename', body: { root, path: join(cwd, selected[0].name), name } },
              { onSuccess: () => { toast('ok', 'Rinominato'); setDialog(null); setSel(new Set()); setOpen(null); }, onError: (e) => toast('err', (e as Error).message) },
            )
          }
        />
      )}
      {dialog === 'trash' && (
        <TrashDialog
          items={selected}
          rootLabel={rootLabel}
          pending={post.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            post.mutate(
              { route: 'trash', body: { root, items: selected.map((e) => join(cwd, e.name)) } },
              { onSuccess: () => { toast('ok', selected.length === 1 ? '1 elemento spostato nel cestino' : `${selected.length} elementi spostati nel cestino`); setDialog(null); setSel(new Set()); setOpen(null); }, onError: (e) => toast('err', (e as Error).message) },
            )
          }
        />
      )}
      {dialog === 'transfer' && roots.data && (
        <TransferDialog
          roots={roots.data}
          root={root}
          cwd={cwd}
          items={selected}
          onClose={() => setDialog(null)}
          onDone={(msg) => { toast('ok', msg); setDialog(null); setSel(new Set()); setOpen(null); refresh(); }}
        />
      )}
      {dialog === 'search' && <SearchDialog root={root} cwd={cwd} rootLabel={rootLabel} onClose={() => setDialog(null)} onGo={(p) => { setDialog(null); go(p); }} />}
    </div>
  );
}

function Detail({ root, cwd, entry, onClose, onAction }: { root: string; cwd: string; entry: Entry; onClose: () => void; onAction: (a: 'rename' | 'transfer' | 'trash') => void }) {
  const p = join(cwd, entry.name);
  const info = useQuery({ queryKey: ['files-info', root, p], queryFn: () => api<Entry & { hardlinks: string[] }>(`/files/info?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`) });
  const text = useQuery({
    queryKey: ['files-preview', root, p],
    queryFn: () => api<{ text: string; truncated: boolean }>(`/files/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`),
    enabled: TEXT.test(entry.name),
  });
  const url = fileUrl(root, p);
  return (
    <Card
      className="hidden w-[380px] shrink-0 self-start lg:flex"
      title={entry.name}
      actions={
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Chiudi dettaglio">
          <X />
        </Button>
      }
    >
      <div className="space-y-3">
        {IMAGE.test(entry.name) && <img src={url} alt={entry.name} className="max-h-60 w-full rounded-lg object-contain bg-surface-2" />}
        {/\.(mp4|m4v|webm)$/i.test(entry.name) && <video src={url} controls preload="metadata" className="w-full rounded-lg bg-black" />}
        {AUDIO.test(entry.name) && <audio src={url} controls preload="none" className="w-full" />}
        {text.data && (
          <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] whitespace-pre-wrap text-fg-2">
            {text.data.text}
            {text.data.truncated && '\n…'}
          </pre>
        )}
        <dl className="space-y-1 text-xs">
          <div className="flex justify-between gap-3"><dt className="text-muted">Dimensione</dt><dd className="tabular">{entry.size !== null ? bytes(entry.size) : '—'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted">Modificato</dt><dd>{dateTime(entry.mtime)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted">Permessi</dt><dd className="font-mono">{entry.mode} {entry.owner}:{entry.group}</dd></div>
        </dl>
        {info.data && info.data.hardlinks.length > 0 && (
          <div className="rounded-lg bg-ok-soft p-2.5 text-xs text-ok">
            <div className="mb-1 flex items-center gap-1 font-medium"><Link2 className="size-3.5" /> Stesso file anche in:</div>
            <ul className="space-y-0.5 font-mono text-[11px] break-all">
              {info.data.hardlinks.map((h) => <li key={h}>{h}</li>)}
            </ul>
            <p className="mt-1.5 text-fg-2">Eliminarlo qui non toglie la copia in libreria.</p>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
          <a href={fileUrl(root, p, true)}>
            <Button size="sm"><Download /> Scarica</Button>
          </a>
          <Button size="sm" variant="ghost" onClick={() => onAction('rename')}><Pencil /> Rinomina</Button>
          <Button size="sm" variant="ghost" onClick={() => onAction('transfer')}><FolderInput /> Sposta</Button>
          <Button size="sm" variant="ghost" className="text-err" onClick={() => onAction('trash')}><Trash2 /> Elimina</Button>
        </div>
      </div>
    </Card>
  );
}

function NameDialog({ title, initial, pending, onClose, onSubmit }: { title: string; initial: string; pending: boolean; onClose: () => void; onSubmit: (n: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="primary" loading={pending} disabled={!name.trim() || name === initial} onClick={() => onSubmit(name.trim())}>Conferma</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim() && name !== initial) onSubmit(name.trim()); }}>
        <Field label="Nome" help="Non sono ammessi «/», «.» o «..».">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />}</Field>
      </form>
    </Dialog>
  );
}

function TrashDialog({ items, rootLabel, pending, onClose, onConfirm }: { items: Entry[]; rootLabel: string; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const many = items.length > 10;
  const [typed, setTyped] = useState('');
  const size = items.reduce((a, e) => a + (e.size ?? 0), 0);
  const dirs = items.filter((e) => e.type === 'dir').length;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Spostare ${items.length} ${items.length === 1 ? 'elemento' : 'elementi'} nel cestino?`}
      description={`Restano recuperabili dal Cestino di «${rootLabel}» finché non lo svuoti. Lo spazio su disco si libera solo allo svuotamento.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="danger" loading={pending} disabled={many && typed !== String(items.length)} onClick={onConfirm}><Trash2 /> Sposta nel cestino</Button>
        </>
      }
    >
      <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
        {items.map((e) => (
          <li key={e.name} className="truncate text-fg-2">
            • {e.name}{e.type === 'dir' ? '/' : ''} {(e.links ?? 1) > 1 && <span className="text-ok">(anche in libreria)</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        {bytes(size)} nei file{dirs ? ` · ${dirs} cartelle (con tutto il loro contenuto)` : ''}
      </p>
      {many && (
        <div className="mt-3">
          <Field label={`Operazione massiva: per confermare scrivi ${items.length}`}>{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" autoFocus />}</Field>
        </div>
      )}
    </Dialog>
  );
}

function TransferDialog({ roots, root, cwd, items, onClose, onDone }: { roots: Root[]; root: string; cwd: string; items: Entry[]; onClose: () => void; onDone: (m: string) => void }) {
  const [destRoot, setDestRoot] = useState(root);
  const [dest, setDest] = useState(cwd);
  const [op, setOp] = useState<'move' | 'copy' | 'link'>('move');
  const dirs = useQuery({
    queryKey: ['files', destRoot, dest],
    queryFn: () => api<Listing>(`/files/list?root=${encodeURIComponent(destRoot)}&path=${encodeURIComponent(dest)}`),
  });
  const m = useMutation({
    mutationFn: () => api('/files/transfer', { method: 'POST', body: { op, root, items: items.map((e) => join(cwd, e.name)), destRoot, destPath: dest } }),
    onSuccess: () => onDone(op === 'move' ? 'Spostato' : op === 'copy' ? 'Copiato' : 'Hardlink creato'),
  });
  const same = destRoot === root && dest === cwd;
  const onlyFiles = items.every((e) => e.type === 'file');
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`${items.length === 1 ? `«${items[0].name}»` : `${items.length} elementi`}: dove?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="primary" loading={m.isPending} disabled={same || (op !== 'move' && !onlyFiles)} onClick={() => m.mutate()}>
            {op === 'move' ? <FolderInput /> : op === 'copy' ? <Copy /> : <Link2 />} {op === 'move' ? 'Sposta qui' : op === 'copy' ? 'Copia qui' : 'Crea hardlink qui'}
          </Button>
        </>
      }
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Field label="Operazione">
          {(id) => (
            <Select id={id} value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
              <option value="move">Sposta</option>
              <option value="copy" disabled={!onlyFiles}>Copia (solo file, occupa spazio)</option>
              <option value="link" disabled={!onlyFiles}>Hardlink (solo file, nessuno spazio extra)</option>
            </Select>
          )}
        </Field>
        <Field label="Radice">
          {(id) => (
            <Select id={id} value={destRoot} onChange={(e) => { setDestRoot(e.target.value); setDest(''); }}>
              {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
          )}
        </Field>
      </div>
      <div className="rounded-xl border border-line">
        <div className="flex items-center gap-1 border-b border-line px-3 py-2 text-xs">
          <button className="rounded px-1 hover:bg-surface-2" onClick={() => setDest('')}>{roots.find((r) => r.id === destRoot)?.label}</button>
          {dest.split('/').filter(Boolean).map((c, i, a) => (
            <span key={i} className="flex items-center">
              <ChevronRight className="size-3 text-muted" />
              <button className="rounded px-1 hover:bg-surface-2" onClick={() => setDest(a.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
        </div>
        <ul className="max-h-60 overflow-y-auto p-1">
          {dirs.data?.entries.filter((e) => e.type === 'dir' && !(destRoot === root && items.some((it) => join(cwd, it.name) === join(dest, e.name)))).map((e) => (
            <li key={e.name}>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2" onClick={() => setDest(join(dest, e.name))}>
                <Folder className="size-4 text-accent" /> {e.name}
              </button>
            </li>
          ))}
          {dirs.data && !dirs.data.entries.some((e) => e.type === 'dir') && <li className="px-2 py-3 text-center text-xs text-muted">Nessuna sottocartella</li>}
        </ul>
      </div>
      {same && <p className="mt-2 text-xs text-warn">Scegli una cartella diversa da quella attuale.</p>}
      {m.isError && <div className="mt-3"><ErrorBox error={m.error} compact /></div>}
    </Dialog>
  );
}

function SearchDialog({ root, cwd, rootLabel, onClose, onGo }: { root: string; cwd: string; rootLabel: string; onClose: () => void; onGo: (p: string) => void }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const r = useQuery({
    queryKey: ['files-search', root, cwd, term],
    queryFn: () => api<{ results: { path: string; name: string; type: string; size: number | null }[]; truncated: boolean }>(`/files/search?root=${encodeURIComponent(root)}&path=${encodeURIComponent(cwd)}&q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });
  return (
    <Dialog open wide onClose={onClose} title={`Cerca in ${rootLabel}${cwd ? `/${cwd}` : ''}`}>
      <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Parte del nome…" autoFocus aria-label="Testo da cercare" />
        <Button type="submit" variant="primary" loading={r.isFetching}><Search /> Cerca</Button>
      </form>
      <div className="mt-3">
        {r.isError && <ErrorBox error={r.error} compact />}
        {r.data && r.data.results.length === 0 && <p className="py-4 text-center text-xs text-muted">Nessun risultato</p>}
        <ul className="max-h-80 space-y-0.5 overflow-y-auto">
          {r.data?.results.map((x) => (
            <li key={x.path}>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2" onClick={() => onGo(x.type === 'dir' ? x.path : x.path.split('/').slice(0, -1).join('/'))}>
                {x.type === 'dir' ? <Folder className="size-4 shrink-0 text-accent" /> : <FileIcon className="size-4 shrink-0 text-muted" />}
                <span className="min-w-0 flex-1 truncate font-mono">{x.path}</span>
                {x.size !== null && <span className="text-muted tabular">{bytes(x.size)}</span>}
              </button>
            </li>
          ))}
        </ul>
        {r.data?.truncated && <p className="mt-2 text-xs text-muted">Mostrati i primi 300 risultati.</p>}
      </div>
    </Dialog>
  );
}

function TrashView({ root, rootLabel }: { root: string; rootLabel: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useQuery({ queryKey: ['files-trash', root], queryFn: () => api<TrashBatch[]>(`/files/trash?root=${encodeURIComponent(root)}`) });
  const [empty, setEmpty] = useState(false);
  const [typed, setTyped] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['files-trash'] }); void qc.invalidateQueries({ queryKey: ['files'] }); };
  const restore = useMutation({
    mutationFn: (b: { batch: string; name: string }) => api('/files/restore', { method: 'POST', body: { root, ...b } }),
    onSuccess: () => { toast('ok', 'Ripristinato nella posizione originale'); refresh(); },
    onError: (e: Error) => toast('err', e.message),
  });
  const purge = useMutation({
    mutationFn: () => api('/files/empty-trash', { method: 'POST', body: { root, confirm: typed } }),
    onSuccess: () => { toast('ok', 'Cestino svuotato'); setEmpty(false); setTyped(''); refresh(); },
    onError: (e: Error) => toast('err', e.message),
  });
  const total = (t.data ?? []).flatMap((b) => b.items).reduce((a, i) => a + (i.size ?? 0), 0);
  return (
    <div className="mt-4">
      {t.isError && <ErrorBox error={t.error} />}
      {!t.data && !t.isError && <Skeleton className="h-40" />}
      {t.data && t.data.length === 0 && <Card><Empty icon={<Trash2 />} title={`Il cestino di «${rootLabel}» è vuoto`} /></Card>}
      {t.data && t.data.length > 0 && (
        <Card
          bodyClassName="!p-0"
          title={`Cestino di «${rootLabel}»`}
          subtitle={(() => { const n = t.data.reduce((a, b) => a + b.items.length, 0); return `${n} ${n === 1 ? 'elemento' : 'elementi'}${total ? ` · almeno ${bytes(total)}` : ''}`; })()}
          actions={<Button size="sm" variant="danger" onClick={() => setEmpty(true)}><Trash2 /> Svuota</Button>}
        >
          <ul className="divide-y divide-line">
            {t.data.flatMap((b) =>
              b.items.map((i) => (
                <li key={`${b.batch}/${i.name}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{i.name}</div>
                    <div className="truncate text-[11px] text-muted">da {i.from} · eliminato {ago(b.ts)}</div>
                  </div>
                  {i.size !== null && <span className="text-xs text-muted tabular">{bytes(i.size)}</span>}
                  <Button size="sm" variant="ghost" onClick={() => restore.mutate({ batch: b.batch, name: i.name })}><RotateCcw /> Ripristina</Button>
                </li>
              )),
            )}
          </ul>
        </Card>
      )}
      <Dialog
        open={empty}
        onClose={() => setEmpty(false)}
        title="Svuotare definitivamente il cestino?"
        description="Questa è l’unica eliminazione irreversibile del file manager. I file con un hardlink in libreria restano comunque in libreria."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEmpty(false)}>Annulla</Button>
            <Button variant="danger" disabled={typed !== 'SVUOTA'} loading={purge.isPending} onClick={() => purge.mutate()}>Svuota definitivamente</Button>
          </>
        }
      >
        <Field label="Per confermare scrivi SVUOTA">{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />}</Field>
      </Dialog>
    </div>
  );
}
