// Capabilities tab: the APIs the registry uses (or will use once available), each probed in THIS workspace, so an
// API announced in the release notes but not served here is told apart from one that actually works.
import { motion } from "framer-motion";
import { Blocks, ExternalLink, PlugZap, PowerOff } from "lucide-react";
import { useMemo } from "react";
import { useApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import { stagger, staggerItem } from "../../lib/motion";
import type { Capability, CapabilityStatus } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Badge, Card, EmptyState } from "../ui";
import { AsyncBlock, RowsSkeleton } from "../workspace/feedback";
import { fmtDate, fmtDateTime, fmtRelative, humanize } from "../workspace/format";
import { CapabilityStatusPill } from "./chips";

const AREA_LABEL: Record<string, string> = {
  mcp: "MCP servers",
  agents: "Agents",
  skills: "Skills",
  traces: "Traces & evals",
  usage: "Usage & cost",
  access: "Access",
  guardrails: "Guardrails",
};

export const areaLabel = (area: string) => AREA_LABEL[area] ?? humanize(area);

/** Shared column widths, so the matrix lines up from one area to the next. */
const COLUMN_WIDTHS = ["23%", "15%", "23%", "6%", "8.5%", "8.5%", "10%", "6%"];

const STATUS_ORDER: CapabilityStatus[] = ["available", "no_access", "unavailable", "error", "unknown"];

export function groupByArea(rows: Capability[]): [string, Capability[]][] {
  const map = new Map<string, Capability[]>();
  for (const c of rows) {
    const list = map.get(c.area);
    if (list) list.push(c);
    else map.set(c.area, [c]);
  }
  return [...map.entries()].sort(([a], [b]) => areaLabel(a).localeCompare(areaLabel(b)));
}

function Probe({ c }: { c: Capability }) {
  if (c.probe_kind === "none" || !c.probe_path) return <span className="text-ui-xs text-muted-foreground">No probe (no list API)</span>;
  return (
    <code className="block break-all font-mono text-ui-xs leading-relaxed" title={c.probe_path}>
      <span className="mr-1.5 rounded bg-muted px-1 py-px font-semibold text-foreground">{c.probe_kind === "sql" ? "SQL" : c.probe_method || "GET"}</span>
      <span className="text-muted-foreground">{c.probe_path}</span>
    </code>
  );
}

/** The probe's answer (often a raw response body): pretty-printed JSON when it parses. */
export function prettyDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

function ProbeDetail({ c }: { c: Capability }) {
  if (!c.probe_detail) return null;
  const problem = c.status !== "available";
  return (
    <div className="mt-1 text-ui-xs text-muted-foreground">
      {problem && <p className="line-clamp-2 break-words">{c.probe_detail}</p>}
      <details className="group/probe mt-0.5">
        <summary className="cursor-pointer select-none font-semibold hover:text-foreground">{problem ? "Full probe response" : "Probe response"}</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 px-2 py-1 font-mono">{prettyDetail(c.probe_detail)}</pre>
      </details>
    </div>
  );
}

function Adapter({ c }: { c: Capability }) {
  if (!c.adapter) return <span className="text-ui-xs text-muted-foreground">No adapter yet</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-ui-xs">{c.adapter}</span>
      {c.adapter_enabled ? (
        <Badge variant="success" icon={<PlugZap size={11} aria-hidden />}>Enabled</Badge>
      ) : (
        <Badge icon={<PowerOff size={11} aria-hidden />}>Disabled</Badge>
      )}
    </div>
  );
}

function AreaTable({ area, rows }: { area: string; rows: Capability[] }) {
  return (
    <motion.section variants={staggerItem} aria-labelledby={`area-${area}`}>
      <Card className="!p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 id={`area-${area}`} className="text-ui-md font-bold">{areaLabel(area)}</h3>
          <Badge>{rows.length}</Badge>
        </div>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[1040px] table-fixed text-ui-sm">
            <caption className="sr-only">{areaLabel(area)} capabilities and their probe results</caption>
            <colgroup>
              {COLUMN_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <thead className="text-left text-ui-xs text-muted-foreground">
              <tr>
                {["Capability", "Status", "Probe", "HTTP", "Last probed", "First available", "Adapter", "Docs"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.capability_key} className="border-t border-border/70 align-top" data-capability={c.capability_key}>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold">{c.label}</div>
                    {c.description && <div className="mt-0.5 text-ui-xs text-muted-foreground">{c.description}</div>}
                    <div className="mt-0.5 font-mono text-ui-xs text-muted-foreground/80">{c.capability_key}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <CapabilityStatusPill status={c.status} />
                    <ProbeDetail c={c} />
                  </td>
                  <td className="px-4 py-2.5"><Probe c={c} /></td>
                  <td className={cx("px-4 py-2.5 font-mono tabular-nums", c.http_status != null && c.http_status >= 400 ? "text-warning" : "text-foreground")}>{c.http_status ?? "–"}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-ui-xs" title={fmtDateTime(c.last_probed_at)}>{c.last_probed_at ? fmtRelative(c.last_probed_at) : "Never"}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-ui-xs">{c.first_available_at ? fmtDate(c.first_available_at) : "–"}</td>
                  <td className="px-4 py-2.5"><Adapter c={c} /></td>
                  <td className="px-4 py-2.5">
                    {c.docs_url ? (
                      <a href={c.docs_url} target="_blank" rel="noreferrer" className="relative inline-flex items-center gap-1 text-ui-xs font-semibold text-primary hover:underline">
                        Docs <ExternalLink size={11} aria-hidden />
                        <span className="sr-only"> for {c.label}</span>
                      </a>
                    ) : (
                      <span className="text-ui-xs text-muted-foreground">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </motion.section>
  );
}

export default function CapabilitiesPanel() {
  const q = useApi<Capability[]>("/api/platform-watch/capabilities");
  const counts = useMemo(() => {
    const m = new Map<CapabilityStatus, number>();
    for (const c of q.data ?? []) m.set(c.status, (m.get(c.status) ?? 0) + 1);
    return m;
  }, [q.data]);
  return (
    <section aria-label="Capabilities" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-3xl text-ui-sm text-muted-foreground">
          Each API is probed in this workspace with the app's service principal. A newly available API with a shipped adapter becomes a candidate; without an adapter it becomes an advisory.
        </p>
        {STATUS_ORDER.filter((s) => counts.get(s)).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-ui-sm">
            <CapabilityStatusPill status={s} />
            <span className="font-semibold tabular-nums">{counts.get(s)}</span>
          </span>
        ))}
        <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
      </div>
      <AsyncBlock
        state={q}
        errorTitle="Couldn't load the capability probes"
        skeleton={<RowsSkeleton rows={6} />}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon={<Blocks size={22} aria-hidden />} title="No capabilities probed yet" description="Run Platform Watch to sync the capability catalog and probe each API in this workspace." />}
      >
        {(rows) => (
          <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
            {groupByArea(rows).map(([area, list]) => (
              <AreaTable key={area} area={area} rows={list} />
            ))}
          </motion.div>
        )}
      </AsyncBlock>
    </section>
  );
}
