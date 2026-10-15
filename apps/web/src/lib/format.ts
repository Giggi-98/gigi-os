const nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: i === 0 ? 0 : digits }).format(v)} ${u[i]}`;
}

export const rate = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${bytes(n)}/s`);
export const pct = (n: number | null | undefined, d = 0) =>
  n === null || n === undefined ? '—' : `${(d ? nf1 : nf0).format(n)}%`;
export const num = (n: number) => nf0.format(n);

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} g ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

const rtf = new Intl.RelativeTimeFormat('it-IT', { numeric: 'auto' });
export function ago(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!t || t < 86400_000) return '—';
  const s = Math.round((t - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'adesso';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString('it-IT');
}

export const dateTime = (ts: number | string) =>
  new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function eta(seconds: number): string {
  if (seconds <= 0 || seconds >= 8640000) return '∞';
  return duration(seconds);
}
