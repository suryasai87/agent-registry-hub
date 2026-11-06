// Lightweight CSS/SVG charts that don't need recharts: ranked bars, a stacked share bar, a budget bar with
// threshold ticks, a ring meter, a sparkline and a before/after delta. All animate in with the motion grammar.
import { motion, useReducedMotion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../lib/cx";
import type { Budget } from "../../lib/types";
import { Badge, type BadgeVariant } from "../ui";

const grow = { duration: 0.6, ease: "easeOut" } as const;

// ------------------------------------------------------------------------------------------------ BarList
export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  display?: ReactNode;
  sub?: ReactNode;
  href?: string;
}

/** Horizontal ranked bars (by type / by platform / top lists). */
export function BarList({ rows, tone = "bg-primary", empty = "No data in this window" }: { rows: BarRow[]; tone?: string; empty?: ReactNode }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="py-6 text-center text-ui-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const label = r.href ? (
          <Link to={r.href} className="truncate font-semibold hover:text-primary hover:underline">
            {r.label}
          </Link>
        ) : (
          <span className="truncate font-semibold">{r.label}</span>
        );
        return (
          <li key={r.key} className="text-ui-sm">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                {label}
                {r.sub && <span className="truncate text-ui-xs text-muted-foreground">{r.sub}</span>}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{r.display ?? r.value.toLocaleString()}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <motion.div
                className={cx("h-full rounded-full", tone)}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${(r.value / max) * 100}%` }}
                transition={grow}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ StackedBar
export interface Segment {
  key: string;
  label: string;
  value: number;
  /** Tailwind background class (static string so Tailwind sees it). */
  tone: string;
  icon?: ReactNode;
}

/** One bar split into shares with a legend that carries the counts (the legend is the accessible reading). */
export function StackedBar({ segments, label, height = 12 }: { segments: Segment[]; label: string; height?: number }) {
  const reduce = useReducedMotion();
  const total = segments.reduce((s, x) => s + x.value, 0);
  const summary = total === 0 ? `${label}: none` : `${label}: ${segments.filter((s) => s.value > 0).map((s) => `${s.value} ${s.label.toLowerCase()}`).join(", ")}`;
  return (
    <div>
      <div role="img" aria-label={summary} className="flex w-full overflow-hidden rounded-full bg-muted" style={{ height }}>
        {total > 0 &&
          segments.map((s) =>
            s.value > 0 ? (
              <motion.div
                key={s.key}
                title={`${s.label}: ${s.value}`}
                className={cx("h-full first:rounded-l-full last:rounded-r-full", s.tone)}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${(s.value / total) * 100}%` }}
                transition={grow}
              />
            ) : null,
          )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ui-xs">
        {segments.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cx("h-2.5 w-2.5 rounded-sm", s.tone)} />
            {s.icon}
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-semibold tabular-nums">{s.value}</span>
            {total > 0 && <span className="text-muted-foreground">({Math.round((s.value / total) * 100)}%)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Thin progress bar (acknowledgement progress on change rows). */
export function ProgressBar({ value, max, label, tone = "bg-success" }: { value: number; max: number; label: string; tone?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} of ${max}`} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cx("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ BudgetBar
const BUDGET_STATE: Record<Budget["state"], { variant: BadgeVariant; label: string }> = {
  on_track: { variant: "success", label: "On track" },
  at_risk: { variant: "warning", label: "At risk" },
  exceeded: { variant: "destructive", label: "Exceeded" },
};

const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : `$${v.toFixed(v < 10 ? 2 : 0)}`);

/**
 * Month-to-date spend (solid) with the linear month-end forecast (lighter extension) against the alert and
 * limit ticks. The scale stretches past the limit when the forecast overshoots it.
 */
export function BudgetBar({ budget, title }: { budget: Budget; title?: ReactNode }) {
  const reduce = useReducedMotion();
  const alertAt = (budget.monthly_usd * budget.alert_pct) / 100;
  const scale = Math.max(budget.monthly_usd, budget.forecast_usd, budget.mtd_usd) * 1.08 || 1;
  const pos = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const state = BUDGET_STATE[budget.state] ?? BUDGET_STATE.on_track;
  const fill = budget.state === "exceeded" ? "bg-destructive" : budget.state === "at_risk" ? "bg-warning" : "bg-success";
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-ui-sm font-semibold">{title}</div>
        <div className="flex items-center gap-2">
          <Badge variant="neutral">{budget.source === "unity_gateway" ? "Unity Gateway budget" : "Registry budget"}</Badge>
          <Badge variant={state.variant}>{state.label}</Badge>
        </div>
      </div>
      <div
        role="img"
        aria-label={`Spent ${usd(budget.mtd_usd)} month to date, forecast ${usd(budget.forecast_usd)}, alert at ${usd(alertAt)}, ${budget.action === "block" ? "blocks" : "limit"} at ${usd(budget.monthly_usd)}: ${state.label}`}
        className="relative h-3.5 rounded-full bg-muted"
      >
        <motion.div className={cx("absolute inset-y-0 left-0 rounded-full opacity-30", fill)} initial={reduce ? false : { width: 0 }} animate={{ width: pos(budget.forecast_usd) }} transition={grow} />
        <motion.div className={cx("absolute inset-y-0 left-0 rounded-full", fill)} initial={reduce ? false : { width: 0 }} animate={{ width: pos(budget.mtd_usd) }} transition={grow} />
        <span aria-hidden className="absolute -top-1 -bottom-1 w-0.5 rounded bg-warning" style={{ left: pos(alertAt) }} />
        <span aria-hidden className="absolute -top-1.5 -bottom-1.5 w-0.5 rounded bg-foreground" style={{ left: pos(budget.monthly_usd) }} />
      </div>
      <div className="relative mt-1 h-4 text-ui-xs text-muted-foreground">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pos(alertAt) }}>Alert {usd(alertAt)}</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap font-semibold text-foreground" style={{ left: pos(budget.monthly_usd) }}>
          {budget.action === "block" ? "Block" : "Limit"} {usd(budget.monthly_usd)}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 text-ui-xs text-muted-foreground">
        <span>
          MTD <b className="text-foreground tabular-nums">{usd(budget.mtd_usd)}</b>
        </span>
        <span>
          Forecast <b className="text-foreground tabular-nums">{usd(budget.forecast_usd)}</b>
        </span>
        <span>Estimated (list price)</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Meter
/** Ring meter (0–100). Colour follows thresholds; the number and label are always shown. */
export function RingMeter({ pct, label, size = 92, sub }: { pct: number | null | undefined; label: string; size?: number; sub?: ReactNode }) {
  const reduce = useReducedMotion();
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const color = pct == null ? "hsl(var(--muted-foreground))" : v >= 80 ? "hsl(var(--success))" : v >= 50 ? "hsl(var(--warning))" : "hsl(var(--destructive))";
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label={`${label}: ${pct == null ? "unknown" : `${Math.round(v)}%`}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={9} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={reduce ? false : { strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v / 100) }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="fill-foreground" style={{ fontSize: size * 0.22, fontWeight: 800 }}>
          {pct == null ? "–" : `${Math.round(v)}%`}
        </text>
      </svg>
      <div className="min-w-0">
        <div className="text-ui-md font-bold">{label}</div>
        {sub && <div className="text-ui-sm text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Sparkline
export function Sparkline({ values, width = 96, height = 32, color = "hsl(var(--primary))", label }: { values: number[]; width?: number; height?: number; color?: string; label?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / span) * (height - 4)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ Delta
export type Better = "higher" | "lower" | "neutral";

/** Classify a before/after move: good / bad / flat (within 0.5%) / unknown. */
export function deltaTone(before: number | null | undefined, after: number | null | undefined, better: Better): "good" | "bad" | "flat" | "unknown" {
  if (before == null || after == null) return "unknown";
  const diff = after - before;
  const rel = before !== 0 ? Math.abs(diff / before) : Math.abs(diff);
  if (rel < 0.005) return "flat";
  if (better === "neutral") return "flat";
  const up = diff > 0;
  return (better === "higher") === up ? "good" : "bad";
}

export function Delta({ before, after, better, format }: { before: number | null | undefined; after: number | null | undefined; better: Better; format?: (v: number) => string }) {
  const tone = deltaTone(before, after, better);
  if (tone === "unknown" || before == null || after == null) return <span className="text-ui-sm text-muted-foreground">–</span>;
  const diff = after - before;
  const rel = before !== 0 ? (diff / Math.abs(before)) * 100 : null;
  const Icon = diff > 0 ? ArrowUpRight : diff < 0 ? ArrowDownRight : Minus;
  const text = rel === null ? (format ? format(diff) : diff.toFixed(2)) : `${diff > 0 ? "+" : ""}${rel.toFixed(Math.abs(rel) < 10 ? 1 : 0)}%`;
  const word = tone === "good" ? "better" : tone === "bad" ? "worse" : "no material change";
  return (
    <span data-tone={tone} className={cx("inline-flex items-center gap-1 text-ui-sm font-semibold tabular-nums", tone === "good" && "text-success", tone === "bad" && "text-destructive", tone === "flat" && "text-muted-foreground")}>
      <Icon size={14} aria-hidden />
      {text}
      <span className="font-normal">{word}</span>
    </span>
  );
}
