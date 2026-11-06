// Where a page's data came from (the tier envelope's ``source``). Degraded answers explain why in a tooltip.
import { CircleOff, Database, FlaskConical, Radio, Warehouse, type LucideIcon } from "lucide-react";
import type { DataSource } from "../lib/api";
import { cx } from "../lib/cx";
import { Tooltip } from "./ui";

const VARIANTS: Record<DataSource, { label: string; icon: LucideIcon; tone: string; describe: string }> = {
  lakebase: { label: "Lakebase", icon: Database, tone: "border-success/40 bg-success/12 text-success", describe: "Served from the Lakebase registry" },
  warehouse: { label: "Warehouse", icon: Warehouse, tone: "border-info/40 bg-info/12 text-info", describe: "Served by the SQL warehouse" },
  synthetic: { label: "Synthetic", icon: FlaskConical, tone: "border-warning/45 bg-warning/15 text-warning", describe: "Labeled synthetic data: live sources are unavailable" },
  live: { label: "Live API", icon: Radio, tone: "border-db-teal/45 bg-db-teal/12 text-db-teal", describe: "Fetched live from the Databricks API" },
  none: { label: "Unavailable", icon: CircleOff, tone: "border-destructive/40 bg-destructive/12 text-destructive", describe: "No data source answered" },
};

export function formatAsOf(asOf: string | null | undefined): string | null {
  if (!asOf) return null;
  const d = new Date(asOf);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function SourcePill({ source, degradedReason, asOf, className }: { source: DataSource | null | undefined; degradedReason?: string | null; asOf?: string | null; className?: string }) {
  if (!source) return null;
  const v = VARIANTS[source] ?? VARIANTS.none;
  const Icon = v.icon;
  const when = formatAsOf(asOf);
  const tip = (
    <span className="flex flex-col gap-1">
      <span>{v.describe}</span>
      {degradedReason && <span className="font-mono text-[0.95em] text-muted-foreground">{degradedReason}</span>}
      {when && <span className="text-muted-foreground">As of {when}</span>}
    </span>
  );
  return (
    <Tooltip content={tip} side="bottom">
      <span
        tabIndex={0}
        data-source={source}
        aria-label={`Data source: ${v.label}${degradedReason ? ` (degraded: ${degradedReason})` : ""}`}
        className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-ui-xs font-semibold", v.tone, className)}
      >
        <Icon size={12} aria-hidden />
        {v.label}
        {degradedReason && source !== "synthetic" && source !== "none" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />}
      </span>
    </Tooltip>
  );
}
