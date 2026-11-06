// A tiny inline-SVG sparkline (no chart library): a line + soft area, with an accessible summary.
import { useId } from "react";
import { cx } from "../../lib/cx";

export default function Sparkline({
  values,
  width = 72,
  height = 22,
  label,
  className,
  stroke = "hsl(var(--db-teal))",
}: {
  values: number[];
  width?: number;
  height?: number;
  /** Accessible summary, e.g. "14-day requests". Totals are appended automatically. */
  label: string;
  className?: string;
  stroke?: string;
}) {
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const clean = values.map((v) => (Number.isFinite(v) ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  const last = clean.length ? clean[clean.length - 1] : 0;
  const summary = `${label}: ${total.toLocaleString()} total, ${last.toLocaleString()} on the last day`;
  if (clean.length < 2 || total === 0) {
    return (
      <svg role="img" aria-label={`${label}: no activity`} width={width} height={height} className={cx("shrink-0", className)}>
        <line x1={1} x2={width - 1} y1={height - 2} y2={height - 2} stroke="hsl(var(--border))" strokeWidth={1.5} strokeDasharray="3 3" />
      </svg>
    );
  }
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const span = max - min || 1;
  const step = (width - 2) / (clean.length - 1);
  const pts = clean.map((v, i) => [1 + i * step, 2 + (height - 4) * (1 - (v - min) / span)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg role="img" aria-label={summary} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx("shrink-0 overflow-visible", className)}>
      <title>{summary}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2} fill={stroke} />
    </svg>
  );
}
