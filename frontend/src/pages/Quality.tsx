// Quality rollup (/quality): per Databricks-built agent, 30-day traces, error rate, p95 latency, scorer means and
// a regression flag, with links into each agent's Traces and Evals tabs (MLflow stays the deep explorer).
import { motion } from "framer-motion";
import { ArrowDownUp, BadgeCheck, FlaskConical, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SourcePill from "../components/SourcePill";
import { Badge, Card, EmptyState, KpiTile, PageHeader, SectionTitle, Toggle } from "../components/ui";
import { AsyncBlock, KpiSkeleton } from "../components/workspace/feedback";
import { fmtMs, humanize } from "../components/workspace/format";
import { useApi } from "../lib/api";
import { assetHref, fmtNum, fmtPct } from "../lib/assets";
import { cx } from "../lib/cx";
import { stagger, staggerItem } from "../lib/motion";
import type { QualityFleet } from "../lib/types";

type Agent = QualityFleet["agents"][number];
type SortKey = "display_name" | "traces_30d" | "error_rate" | "p95_ms" | `scorer:${string}`;

const scoreTone = (v: number) => (v >= 0.85 ? "text-success" : v >= 0.7 ? "text-warning" : "text-destructive");

export function sortAgents(rows: Agent[], key: SortKey, desc: boolean): Agent[] {
  const val = (a: Agent): number | string | null =>
    key === "display_name" ? a.display_name.toLowerCase() : key.startsWith("scorer:") ? a.scorer_means[key.slice(7)] ?? null : (a[key as "traces_30d" | "error_rate" | "p95_ms"] ?? null);
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return desc ? -c : c;
  });
}

export default function Quality() {
  const q = useApi<QualityFleet>("/api/quality");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "traces_30d", desc: true });
  const [onlyRegressions, setOnlyRegressions] = useState(false);
  const agents = useMemo(() => q.data?.agents ?? [], [q.data]);
  const scorers = useMemo(() => [...new Set(agents.flatMap((a) => Object.keys(a.scorer_means)))].sort(), [agents]);
  const rows = useMemo(() => sortAgents(onlyRegressions ? agents.filter((a) => a.regression) : agents, sort.key, sort.desc), [agents, sort, onlyRegressions]);
  const regressions = agents.filter((a) => a.regression).length;
  const traces = agents.reduce((s, a) => s + a.traces_30d, 0);
  const withErr = agents.filter((a) => a.error_rate != null);
  const avgErr = withErr.length ? withErr.reduce((s, a) => s + (a.error_rate ?? 0) * a.traces_30d, 0) / Math.max(1, withErr.reduce((s, a) => s + a.traces_30d, 0)) : null;

  const th = (key: SortKey, label: string, right = true) => {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={cx("px-3 py-2 font-semibold", right ? "text-right" : "text-left")}>
        <button type="button" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "display_name" }))} className={cx("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
          {label}
          <ArrowDownUp size={11} aria-hidden className={active ? "opacity-100" : "opacity-40"} />
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BadgeCheck size={20} aria-hidden />}
        title="Quality"
        subtitle="Traces and evaluation scorers for Databricks-built agents. Open an agent's Traces or Evals tab for detail, or MLflow for the full explorer."
        source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
      />
      <AsyncBlock
        state={q}
        skeleton={<KpiSkeleton count={4} />}
        isEmpty={(d) => d.agents.length === 0}
        empty={
          <EmptyState
            icon={<FlaskConical size={22} aria-hidden />}
            title="No traced agents yet"
            description="Agents appear here once they log MLflow traces to an experiment (Agent Bricks and Model Serving agents with tracing on). Evaluation scorers show up after an evaluation or monitoring run."
          />
        }
      >
        {() => (
          <>
            <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <motion.div variants={staggerItem}><KpiTile label="Traced agents" value={fmtNum(agents.length)} /></motion.div>
              <motion.div variants={staggerItem}><KpiTile label="Traces (30 d)" value={fmtNum(traces)} /></motion.div>
              <motion.div variants={staggerItem}><KpiTile label="Error rate (trace-weighted)" value={fmtPct(avgErr)} /></motion.div>
              <motion.div variants={staggerItem}>
                <KpiTile label="Regressions" value={regressions} icon={regressions ? <TriangleAlert size={15} aria-hidden className="text-warning" /> : undefined} hint={regressions ? "Scorer means dropped vs the previous runs" : "No scorer regressions"} />
              </motion.div>
            </motion.div>
            <Card>
              <SectionTitle title="Agents" subtitle="Click a column to sort" actions={<Toggle checked={onlyRegressions} onChange={setOnlyRegressions} label="Regressions only" />} />
              <div className="overflow-x-auto">
                <table className="w-full text-ui-sm">
                  <caption className="sr-only">Agent quality: traces, error rate, latency and evaluation scorers</caption>
                  <thead className="text-ui-xs text-muted-foreground">
                    <tr>
                      {th("display_name", "Agent", false)}
                      {th("traces_30d", "Traces 30 d")}
                      {th("error_rate", "Error rate")}
                      {th("p95_ms", "p95")}
                      {scorers.map((s) => th(`scorer:${s}`, humanize(s)))}
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Flags</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold"><span className="sr-only">Links</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.asset_id} className={cx("border-t border-border/70", a.regression && "bg-warning/6")}>
                        <td className="px-3 py-2"><Link to={assetHref(a.asset_id)} className="font-semibold hover:text-primary hover:underline">{a.display_name}</Link></td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(a.traces_30d)}</td>
                        <td className={cx("px-3 py-2 text-right tabular-nums", (a.error_rate ?? 0) > 0.05 && "font-semibold text-destructive")}>{fmtPct(a.error_rate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMs(a.p95_ms)}</td>
                        {scorers.map((s) => {
                          const v = a.scorer_means[s];
                          return <td key={s} className={cx("px-3 py-2 text-right font-semibold tabular-nums", v != null && scoreTone(v))}>{v == null ? "–" : v.toFixed(2)}</td>;
                        })}
                        <td className="px-3 py-2">{a.regression ? <Badge variant="warning" icon={<TriangleAlert size={11} aria-hidden />}>Regression</Badge> : <span className="text-ui-xs text-muted-foreground">–</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-ui-xs">
                          <Link to={assetHref(a.asset_id, "traces")} className="font-semibold text-primary hover:underline">Traces</Link>
                          <span aria-hidden className="mx-1.5 text-muted-foreground">·</span>
                          <Link to={assetHref(a.asset_id, "evals")} className="font-semibold text-primary hover:underline">Evals</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 && <p className="py-6 text-center text-ui-sm text-muted-foreground">No regressions. Turn the filter off to see every agent.</p>}
              <p className="mt-3 text-ui-xs text-muted-foreground">Scorer colour bands: ≥ 0.85 good, 0.70–0.85 watch, below 0.70 poor. Values are means over the last 30 days of monitoring and offline runs.</p>
            </Card>
          </>
        )}
      </AsyncBlock>
    </div>
  );
}
