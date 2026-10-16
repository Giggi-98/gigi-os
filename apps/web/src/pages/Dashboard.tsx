import { t } from '../lib/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LayoutTemplate, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import { Button, cx, Dialog, PageHeader, useToast } from '../components/ui';
import { api } from '../lib/api';
import { DEFAULT_LAYOUT, WIDGETS, WidgetFrame } from '../widgets/widgets';

const Grid = WidthProvider(Responsive);

type Item = { i: string; type: string; x: number; y: number; w: number; h: number };
type Saved = { version: number; widgets: Item[] };

export function Dashboard() {
  const qc = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: ['layout'], queryFn: () => api<Saved | null>('/layout'), staleTime: Infinity });
  const [items, setItems] = useState<Item[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [animate, setAnimate] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (saved.isSuccess && items === null) {
      const valid = saved.data?.widgets.filter((w) => WIDGETS[w.type]);
      setItems(valid && valid.length ? valid : DEFAULT_LAYOUT);
    }
    if (saved.isError && items === null) setItems(DEFAULT_LAYOUT);
  }, [saved.isSuccess, saved.isError, saved.data, items]);

  const save = useMutation({
    mutationFn: (w: Item[]) => api('/layout', { method: 'PUT', body: { version: 1, widgets: w } }),
    onError: (e: Error) => toast('err', t('Layout non salvato: {err}', { err: e.message })),
    onSuccess: () => qc.setQueryData(['layout'], (_: unknown) => ({ version: 1, widgets: items })),
  });

  const persist = (next: Item[]) => {
    setItems(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(next), 600);
  };

  const layouts = useMemo(() => {
    const lg: Layout[] = (items ?? []).map((it) => {
      const s = WIDGETS[it.type].size;
      return { i: it.i, x: it.x, y: it.y, w: it.w, h: it.h, minW: s.minW, minH: s.minH };
    });
    // Telefono/tablet: una colonna nell'ordine del desktop, con l'altezza minima di ciascun widget.
    const ordered = [...lg].sort((a, b) => a.y - b.y || a.x - b.x);
    let y = 0;
    const stack = (cols: number) =>
      ordered.map((l) => {
        const h = Math.max(l.minH ?? 3, Math.ceil(l.h * 0.8));
        const item = { ...l, x: 0, y, w: cols, h };
        y += h;
        return item;
      });
    const sm = stack(1);
    y = 0;
    const md = stack(6);
    return { lg, md, sm };
  }, [items]);

  const onLayoutChange = (current: Layout[], all: Partial<Record<string, Layout[]>>) => {
    if (!editing || !items || !all.lg) return;
    const next = items.map((it) => {
      const l = all.lg!.find((x) => x.i === it.i);
      return l ? { ...it, x: l.x, y: l.y, w: l.w, h: l.h } : it;
    });
    if (JSON.stringify(next) !== JSON.stringify(items)) persist(next);
    void current;
  };

  const present = new Set(items?.map((i) => i.type));
  const missing = Object.entries(WIDGETS).filter(([k]) => !present.has(k));

  return (
    <div>
      <PageHeader
        title={t('Dashboard')}
        description={editing ? t('Trascina dal titolo, ridimensiona dall’angolo. Le modifiche si salvano da sole.') : t('Stato del server, dei container e delle app in tempo reale.')}
        actions={
          editing ? (
            <>
              <Button size="sm" onClick={() => setAdding(true)} disabled={missing.length === 0}>
                <Plus />{' '}{t('Aggiungi widget')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api('/layout', { method: 'DELETE' });
                  setAnimate(true);
                  setItems(DEFAULT_LAYOUT);
                  qc.setQueryData(['layout'], null);
                  toast('ok', t('Layout predefinito ripristinato'));
                }}
              >
                <RotateCcw />{' '}{t('Ripristina')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => setEditing(false)}>
                <Check />{' '}{t('Fine')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => { setAnimate(true); setEditing(true); }}>
              <LayoutTemplate />{' '}{t('Personalizza')}
            </Button>
          )
        }
      />
      {items && (
        <Grid
          className={cx('-mx-[7px]', animate && 'rgl-animate')}
          layouts={layouts}
          breakpoints={{ lg: 1100, md: 760, sm: 0 }}
          cols={{ lg: 12, md: 6, sm: 1 }}
          rowHeight={34}
          margin={[14, 14]}
          containerPadding={[7, 0]}
          isDraggable={editing}
          isResizable={editing}
          draggableHandle=".drag-handle"
          onLayoutChange={onLayoutChange}
          compactType="vertical"
          useCSSTransforms
        >
          {items.map((it) => (
            <div key={it.i}>
              <WidgetFrame type={it.type} editing={editing} onRemove={() => persist(items.filter((x) => x.i !== it.i))} />
            </div>
          ))}
        </Grid>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title={t('Aggiungi widget')} description={t('I widget già presenti non sono elencati.')}>
        <ul className="space-y-1.5">
          {missing.map(([type, def]) => (
            <li key={type}>
              <button
                className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left hover:border-line-strong"
                onClick={() => {
                  const y = Math.max(0, ...(items ?? []).map((i) => i.y + i.h));
                  persist([...(items ?? []), { i: type, type, x: 0, y, w: def.size.w, h: def.size.h }]);
                  setAdding(false);
                }}
              >
                <span className="text-accent [&>svg]:size-4">{def.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{def.title}</span>
                  <span className="block text-xs text-muted">{def.description}</span>
                </span>
                <Plus className="size-4 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
