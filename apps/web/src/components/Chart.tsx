// Grafici SVG leggeri (nessuna libreria): area/linea con griglia, asse temporale e tooltip.
import { useId, useMemo, useRef, useState } from 'react';

export type Series = { key: string; label: string; color: string; values: (number | null)[]; format?: (v: number) => string };

export function AreaChart({
  times,
  series,
  height = 140,
  max,
  yFormat = (v) => String(Math.round(v)),
  ariaLabel,
}: {
  times: number[];
  series: Series[];
  height?: number;
  max?: number;
  yFormat?: (v: number) => string;
  ariaLabel: string;
}) {
  const uid = useId().replace(/:/g, '');
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const padL = 34;
  const padB = 18;
  const padT = 6;
  const n = times.length;

  const top = useMemo(() => {
    if (max !== undefined) return max;
    const m = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
    const mag = 10 ** Math.floor(Math.log10(m));
    return Math.ceil((m * 1.15) / mag) * mag;
  }, [series, max]);

  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - 4));
  const y = (v: number) => padT + (1 - v / top) * (H - padT - padB);

  const paths = series.map((s) => {
    let d = '';
    let started = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        started = false;
        return;
      }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    });
    const first = s.values.findIndex((v) => v !== null);
    const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
    const area = first >= 0 ? `${d}L${x(lastIdx)},${H - padB}L${x(first)},${H - padB}Z` : '';
    return { ...s, d, area };
  });

  const ticks = [0, 0.5, 1].map((f) => top * f);
  const timeTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [];
  const long = n > 1 && times[n - 1] - times[0] > 20 * 3600_000;
  const fmtT = (t: number) =>
    long
      ? new Date(t).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || n < 2) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - padL) / (W - padL - 4)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  if (n < 2) return <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>Raccolta dati in corso…</div>;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          {paths.map((p) => (
            <linearGradient key={p.key} id={`g-${uid}-${p.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={p.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={p.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : '3 4'} vectorEffect="non-scaling-stroke" />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted)" className="tabular">
              {yFormat(t)}
            </text>
          </g>
        ))}
        {timeTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize="10" fill="var(--muted)">
            {fmtT(times[i])}
          </text>
        ))}
        {paths.map((p) => (
          <g key={p.key}>
            {series.length === 1 && <path d={p.area} fill={`url(#g-${uid}-${p.key})`} />}
            <path d={p.d} fill="none" stroke={p.color} strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--border-strong)" vectorEffect="non-scaling-stroke" />
            {paths.map((p) =>
              p.values[hover] !== null ? <circle key={p.key} cx={x(hover)} cy={y(p.values[hover]!)} r="3.5" fill={p.color} stroke="var(--surface)" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null,
            )}
          </>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > n / 2 ? 'calc(-100% - 8px)' : '8px'})` }}
        >
          <div className="mb-0.5 text-muted">{fmtT(times[hover])}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="size-2 rounded-full" style={{ background: s.color }} />
              <span className="text-fg-2">{s.label}</span>
              <span className="ml-auto pl-3 font-medium tabular">{s.values[hover] === null ? '—' : (s.format ?? yFormat)(s.values[hover]!)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, color = 'var(--accent)', height = 32, max }: { values: number[]; color?: string; height?: number; max?: number }) {
  const uid = useId().replace(/:/g, '');
  if (values.length < 2) return <div style={{ height }} />;
  const W = 120;
  const top = max ?? Math.max(1, ...values) * 1.1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, height - (v / top) * (height - 2) - 1]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={`s-${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d}L${W},${height}L0,${height}Z`} fill={`url(#s-${uid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
