import { cn } from '@/lib/utils';

/**
 * Small dependency-free SVG charts for dashboards. They scale to their container's width, use the
 * theme's colour tokens (so dark mode works) and carry a text summary for screen readers.
 */
export interface Point {
  date: string;
  [key: string]: number | string | null;
}
interface Series {
  key: string;
  label: string;
  /** A CSS colour, e.g. var(--released). */
  color: string;
}

const W = 640;
const H = 180;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

function ticks(data: Point[]) {
  if (data.length <= 1) return data.map((_, i) => i);
  const n = Math.min(6, data.length);
  return Array.from({ length: n }, (_, i) => Math.round((i * (data.length - 1)) / (n - 1)));
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} /> {s.label}
        </span>
      ))}
    </div>
  );
}

/** Stacked bars: one bar per bucket, one segment per series. */
export function BarChart({ data, series, format = String, label, className }: { data: Point[]; series: Series[]; format?: (v: number) => string; label: string; className?: string }) {
  const totals = data.map((d) => series.reduce((s, x) => s + Number(d[x.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const slot = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(28, slot * 0.7));
  const total = totals.reduce((a, b) => a + b, 0);
  return (
    <figure className={cn('m-0', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${label}: ${format(total)} in total over ${data.length} periods`}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih * (1 - f)} y2={PAD.top + ih * (1 - f)} stroke="var(--rule)" strokeDasharray="2 4" />
        ))}
        {data.map((d, i) => {
          let y = PAD.top + ih;
          const x = PAD.left + slot * i + (slot - bw) / 2;
          return (
            <g key={d.date}>
              <title>{`${short(d.date)}: ${series.map((s) => `${s.label} ${format(Number(d[s.key] ?? 0))}`).join(', ')}`}</title>
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={ih} fill="transparent" />
              {series.map((s) => {
                const v = Number(d[s.key] ?? 0);
                const h = (v / max) * ih;
                y -= h;
                return v > 0 ? <rect key={s.key} x={x} y={y} width={bw} height={h} rx={Math.min(3, bw / 3)} fill={s.color} /> : null;
              })}
            </g>
          );
        })}
        {ticks(data).map((i) => (
          <text key={i} x={PAD.left + slot * i + slot / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">{short(data[i]!.date)}</text>
        ))}
      </svg>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

/** Lines on a shared scale (e.g. percentages). Null values break the line. */
export function LineChart({ data, series, format = String, label, className, xLabel = short }: {
  data: Point[];
  series: Series[];
  format?: (v: number) => string;
  label: string;
  className?: string;
  /** How a point's date reads on the axis and in tooltips (default "Mar 4"). */
  xLabel?: (iso: string) => string;
}) {
  const vals = data.flatMap((d) => series.map((s) => d[s.key])).filter((v): v is number => typeof v === 'number');
  const max = Math.max(1e-9, ...vals) * 1.1;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (data.length <= 1 ? iw / 2 : (iw * i) / (data.length - 1));
  const y = (v: number) => PAD.top + ih * (1 - v / max);
  return (
    <figure className={cn('m-0', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={label}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih * (1 - f)} y2={PAD.top + ih * (1 - f)} stroke="var(--rule)" strokeDasharray="2 4" />
            <text x={W - PAD.right} y={PAD.top + ih * (1 - f) - 3} textAnchor="end" fontSize="10" fill="var(--muted-foreground)">{format((max / 1.1) * f)}</text>
          </g>
        ))}
        {series.map((s) => {
          const segs: string[] = [];
          let cur = '';
          data.forEach((d, i) => {
            const v = d[s.key];
            if (typeof v !== 'number') {
              if (cur) segs.push(cur);
              cur = '';
              return;
            }
            cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          });
          if (cur) segs.push(cur);
          return segs.map((p, k) => <path key={`${s.key}${k}`} d={p} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />);
        })}
        {data.map((d, i) => (
          <g key={d.date}>
            <title>{`${xLabel(d.date)}: ${series.map((s) => `${s.label} ${typeof d[s.key] === 'number' ? format(d[s.key] as number) : '—'}`).join(', ')}`}</title>
            <rect x={x(i) - iw / Math.max(2, data.length) / 2} y={PAD.top} width={iw / Math.max(2, data.length)} height={ih} fill="transparent" />
          </g>
        ))}
        {ticks(data).map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fontSize="11" fill="var(--muted-foreground)">{xLabel(data[i]!.date)}</text>
        ))}
      </svg>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

/** A headline number with its change against the previous period. */
export function Kpi({ label, value, now, before, unit = 'abs', invert = false }: { label: string; value: string; now: number | null; before: number | null; unit?: 'abs' | 'pts'; invert?: boolean }) {
  let delta: React.ReactNode = null;
  if (now != null && before != null) {
    const diff = unit === 'pts' ? now - before : before === 0 ? null : ((now - before) / before) * 100;
    if (diff != null && Number.isFinite(diff)) {
      const good = invert ? diff < 0 : diff > 0;
      const flat = unit === 'pts' ? Math.abs(diff) < 0.05 : Math.abs(diff) < 0.5;
      const txt = flat ? (unit === 'pts' ? '±0 pts' : '±0%') : unit === 'pts' ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)} pts` : `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`;
      delta = <span className={cn('font-mono text-xs', flat ? 'text-muted-foreground' : good ? 'text-released' : 'text-disputed')}>{txt}</span>;
    }
  }
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-semibold">{value}</span>
        {delta}
      </div>
    </div>
  );
}
