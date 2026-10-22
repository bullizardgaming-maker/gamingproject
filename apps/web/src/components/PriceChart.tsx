import { useEffect, useRef, useState } from 'react';
import { money } from '../api';
import { t } from '../i18n';

/** One line on the chart. `step` holds each value until the next point (a listing's price changes). */
export interface PriceSeries {
  key: string;
  label: string;
  /** A CSS colour: var(--viz-1) or var(--viz-2), which have their own dark-mode steps. */
  color: string;
  points: Array<{ t: number; v: number }>;
  step?: boolean;
}

const H = 200;
const PAD = { top: 12, right: 64, bottom: 24, left: 52 };
const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** The value a series shows at time `at`: the last change before it (step) or the nearest point. */
function valueAt(s: PriceSeries, at: number) {
  if (!s.points.length) return null;
  if (s.step) {
    let v = s.points[0]!.v;
    for (const p of s.points) if (p.t <= at) v = p.v;
    return v;
  }
  return s.points.reduce((best, p) => (Math.abs(p.t - at) < Math.abs(best.t - at) ? p : best)).v;
}

/** Rounded steps for the y axis (1, 2 or 5 times a power of ten). */
function niceStep(range: number) {
  const raw = range / 3;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
}

/**
 * Price over time on a time axis. Hovering shows a crosshair with every series' value at that
 * date; a table view lists the same data for keyboard and screen-reader users.
 */
export function PriceChart({ series, currency, from, to, label }: { series: PriceSeries[]; currency: string; from: number; to: number; label: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so text stays 11–12px instead of scaling with the page.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vals = series.flatMap((s) => s.points.map((p) => p.v));
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const step = niceStep(Math.max(max - min, max * 0.1, 1));
  const lo = Math.max(0, Math.floor((min - step / 2) / step) * step);
  const hi = Math.ceil((max + step / 4) / step) * step;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (ms: number) => PAD.left + (iw * (Math.min(Math.max(ms, from), to) - from)) / Math.max(1, to - from);
  const y = (v: number) => PAD.top + ih * (1 - (v - lo) / Math.max(1, hi - lo));
  const fmt = (v: number) => money(v, currency);
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) yTicks.push(v);
  const xTicks = [0, 1, 2, 3].map((i) => from + ((to - from) * i) / 3);

  const path = (s: PriceSeries) => {
    const pts = s.points.filter((p) => p.t <= to);
    if (!pts.length) return '';
    let d = `M${x(pts[0]!.t).toFixed(1)},${y(pts[0]!.v).toFixed(1)}`;
    for (const p of pts.slice(1)) d += s.step ? `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}` : `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    if (s.step) d += `H${x(to).toFixed(1)}`;
    return d;
  };
  const ends = series.map((s) => ({ s, v: valueAt(s, to) })).filter((e): e is { s: PriceSeries; v: number } => e.v != null);
  // End labels only while they don't collide; otherwise the legend and the tooltip carry them.
  const labelEnds = ends.length < 2 || Math.abs(y(ends[0]!.v) - y(ends[1]!.v)) >= 14;

  const move = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const sx = ((e.clientX - r.left) * W) / r.width;
    if (sx < PAD.left || sx > W - PAD.right) return setHover(null);
    setHover(from + ((sx - PAD.left) / iw) * (to - from));
  };

  return (
    <figure className="m-0 stack" style={{ gap: 8 }}>
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: s.color }} /> {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="relative" ref={box}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full touch-none" role="img" aria-label={label} onPointerMove={move} onPointerLeave={() => setHover(null)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeWidth="1" />
              <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">{fmt(v)}</text>
            </g>
          ))}
          {xTicks.map((ms, i) => (
            <text key={i} x={x(ms)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'} fontSize="11" fill="var(--muted-foreground)">{day(ms)}</text>
          ))}
          {series.map((s) => <path key={s.key} d={path(s)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
          {ends.map(({ s, v }) => (
            <g key={s.key}>
              <circle cx={x(to)} cy={y(v)} r="4" fill={s.color} stroke="var(--card)" strokeWidth="2" />
              {labelEnds && <text x={x(to) + 8} y={y(v) + 4} fontSize="12" fontWeight="600" fill="var(--foreground)">{fmt(v)}</text>}
            </g>
          ))}
          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--muted-foreground)" strokeWidth="1" />
              {series.map((s) => {
                const v = valueAt(s, hover);
                return v == null ? null : <circle key={s.key} cx={x(hover)} cy={y(v)} r="4" fill={s.color} stroke="var(--card)" strokeWidth="2" />;
              })}
            </g>
          )}
        </svg>
        {hover != null && (
          <div
            className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${x(hover) > W / 2 ? 'calc(-100% - 10px)' : '10px'})` }}
          >
            <div className="text-muted-foreground">{day(hover)}</div>
            {series.map((s) => {
              const v = valueAt(s, hover);
              return v == null ? null : (
                <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                  {series.length > 1 && <span className="text-muted-foreground">{s.label}</span>}
                  <b className="font-mono">{fmt(v)}</b>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <details className="small">
        <summary className="cursor-pointer text-muted-foreground">{t('history.table')}</summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr><th className="text-start font-medium">{t('history.date')}</th>{series.map((s) => <th key={s.key} className="text-end font-medium">{s.label}</th>)}</tr>
          </thead>
          <tbody>
            {[...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => b - a).map((ms) => (
              <tr key={ms} className="border-t border-border">
                <td>{new Date(ms).toLocaleDateString()}</td>
                {series.map((s) => <td key={s.key} className="text-end font-mono">{fmt(valueAt(s, ms)!)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
