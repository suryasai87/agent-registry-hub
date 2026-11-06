// Daily time series (recharts) themed from the HSL tokens, so it reads in dark and light without per-theme code.
import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface Series {
  key: string;
  label: string;
  color: string;
  format?: (v: number) => string;
}

export const CHART = {
  grid: "hsl(var(--border))",
  axis: "hsl(var(--muted-foreground))",
  primary: "hsl(var(--primary))",
  teal: "hsl(var(--db-teal))",
  orange: "hsl(var(--db-orange))",
  info: "hsl(var(--info))",
  warning: "hsl(var(--warning))",
  destructive: "hsl(var(--destructive))",
  success: "hsl(var(--success))",
  agent: "hsl(var(--type-agent))",
};

export function shortDay(day: string): string {
  const d = new Date(day.length <= 10 ? `${day}T00:00:00Z` : day);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

const tooltipStyle = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  color: "hsl(var(--popover-foreground))",
  fontSize: "var(--text-ui-sm)",
};

export default function TimeSeriesChart({
  data,
  series,
  height = 220,
  kind = "area",
  yFormat,
  stacked = false,
}: {
  data: Record<string, unknown>[];
  series: Series[];
  height?: number;
  kind?: "area" | "bar";
  yFormat?: (v: number) => string;
  stacked?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const fmt = (key: string, v: number) => series.find((s) => s.key === key)?.format?.(v) ?? v.toLocaleString();
  const common = (
    <>
      <CartesianGrid stroke={CHART.grid} strokeDasharray="3 4" vertical={false} />
      <XAxis dataKey="day" tickFormatter={shortDay} stroke={CHART.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
      <YAxis stroke={CHART.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => (yFormat ? yFormat(v) : v.toLocaleString())} />
      <Tooltip
        contentStyle={tooltipStyle}
        labelFormatter={(label) => shortDay(String(label))}
        formatter={(value, name) => {
          const s = series.find((x) => x.label === name || x.key === name);
          return [fmt(s?.key ?? String(name), Number(value)), s?.label ?? String(name)];
        }}
        cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
      />
    </>
  );
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
        {kind === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {common}
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} stackId={stacked ? "a" : undefined} isAnimationActive={false} />
            ))}
          </BarChart>
        ) : (
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`ts-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            {common}
            {series.map((s) => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} fill={`url(#ts-${uid}-${s.key})`} stackId={stacked ? "a" : undefined} isAnimationActive={false} />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
