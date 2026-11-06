// Policies & Guardrails (/policies): fleet coverage and governed traffic, violations in the last 7 days, the policy
// library (where each policy applies), the gaps by risk tier with sample assets, and how platform controls map in.
import { motion } from "framer-motion";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { BarList, RingMeter } from "../components/charts/bars";
import ChartCard from "../components/charts/ChartCard";
import TimeSeriesChart, { CHART, shortDay } from "../components/charts/TimeSeriesChart";
import PolicyExplainer from "../components/governance/PolicyExplainer";
import SourcePill from "../components/SourcePill";
import { Badge, Card, PageHeader, SectionTitle, type BadgeVariant } from "../components/ui";
import { AssetTypeBadge } from "../components/workspace/chips";
import { AsyncBlock, KpiSkeleton } from "../components/workspace/feedback";
import { humanize, plural } from "../components/workspace/format";
import { useApi } from "../lib/api";
import { assetHref } from "../lib/assets";
import { stagger, staggerItem } from "../lib/motion";
import type { PoliciesFleet, RiskTier } from "../lib/types";

const RISK: Record<RiskTier, BadgeVariant> = { low: "neutral", medium: "info", high: "warning", critical: "destructive" };
const RISK_RANK: Record<RiskTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const PROVIDER_LABEL: Record<string, string> = {
  unity_gateway: "Unity AI Gateway",
  serving_ai_gateway: "Serving AI Gateway",
  unity_catalog: "Unity Catalog",
  app: "Registry",
};

export default function Policies() {
  const q = useApi<PoliciesFleet>("/api/policies");
  const gaps = useMemo(() => [...(q.data?.gaps ?? [])].sort((a, b) => RISK_RANK[a.risk_tier] - RISK_RANK[b.risk_tier] || b.missing_count - a.missing_count), [q.data]);
  const library = useMemo(() => [...(q.data?.library ?? [])].sort((a, b) => b.applied_count - a.applied_count || a.name.localeCompare(b.name)), [q.data]);
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ShieldCheck size={20} aria-hidden />}
        title="Policies & Guardrails"
        subtitle="Which guardrails, rate limits, budgets and access policies protect the fleet, where coverage is missing for each risk tier, and what was blocked or flagged this week."
        source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
      />
      <AsyncBlock state={q} skeleton={<KpiSkeleton count={3} />}>
        {(d) => {
          const v = d.violations;
          return (
            <>
              <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-4 lg:grid-cols-3">
                <motion.div variants={staggerItem}>
                  <Card className="h-full"><RingMeter pct={d.coverage_pct} label="Policy coverage" sub="Required policies present for each asset's risk tier, across the fleet" /></Card>
                </motion.div>
                <motion.div variants={staggerItem}>
                  <Card className="h-full"><RingMeter pct={d.governed_traffic_pct} label="Governed traffic" sub="Share of requests that reach an asset with a guardrail, approval or rate-limit policy, or a platform-default UC gate" /></Card>
                </motion.div>
                <motion.div variants={staggerItem}>
                  <Card className="h-full">
                    <div className="text-ui-sm font-medium text-muted-foreground">Violations (7 days)</div>
                    <div className="mt-1 text-ui-2xl font-extrabold tabular-nums">{v.total_7d.toLocaleString()}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Object.entries(v.by_action).length === 0 ? (
                        <Badge variant="success">Nothing blocked or flagged</Badge>
                      ) : (
                        Object.entries(v.by_action).map(([action, n]) => <Badge key={action} variant={action === "block" ? "destructive" : "warning"}>{humanize(action)} · {n}</Badge>)
                      )}
                    </div>
                  </Card>
                </motion.div>
              </motion.div>

              <div className="grid gap-4 xl:grid-cols-2">
                <ChartCard
                  title="Violations per day"
                  subtitle="Guardrail decisions that blocked, masked or flagged a request"
                  summary={`${v.total_7d} violations in the last 7 days.`}
                  table={{ columns: [{ key: "day", label: "Day", format: (x) => shortDay(String(x)) }, { key: "count", label: "Violations", align: "right" }], rows: v.daily }}
                >
                  <TimeSeriesChart kind="bar" height={200} data={v.daily} series={[{ key: "count", label: "Violations", color: CHART.warning }]} />
                </ChartCard>
                <Card>
                  <SectionTitle title="By policy" subtitle="Which policies fired most this week" />
                  <BarList tone="bg-warning" rows={v.by_policy.map((p) => ({ key: p.policy_id, label: p.name, value: p.count }))} empty="No policy fired in the last 7 days." />
                </Card>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Card>
                  <SectionTitle title="Policy library" subtitle={`${plural(library.length, "policy", "policies")} and where they apply`} />
                  {library.length === 0 ? (
                    <p className="py-6 text-center text-ui-sm text-muted-foreground">No policies synced yet. They come from Unity AI Gateway, serving endpoints and Unity Catalog on the next sync.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-ui-sm">
                        <caption className="sr-only">Policy library</caption>
                        <thead className="text-left text-ui-xs text-muted-foreground">
                          <tr>
                            <th scope="col" className="px-2 py-1.5 font-semibold">Policy</th>
                            <th scope="col" className="px-2 py-1.5 font-semibold">Provider</th>
                            <th scope="col" className="px-2 py-1.5 font-semibold">Phase · action</th>
                            <th scope="col" className="px-2 py-1.5 text-right font-semibold">Applied to</th>
                          </tr>
                        </thead>
                        <tbody>
                          {library.map((p) => (
                            <tr key={p.policy_id} className="border-t border-border/70 align-top">
                              <td className="px-2 py-2">
                                <div className="font-semibold">{p.name}</div>
                                {p.description && <div className="text-ui-xs text-muted-foreground">{p.description}</div>}
                                <div className="mt-1 flex flex-wrap gap-1"><Badge>{humanize(p.kind)}</Badge><Badge variant={p.origin === "demo" ? "warning" : "neutral"}>origin: {p.origin}</Badge></div>
                              </td>
                              <td className="px-2 py-2"><Badge variant="info">{PROVIDER_LABEL[p.provider] ?? humanize(p.provider)}</Badge></td>
                              <td className="px-2 py-2 text-muted-foreground">{humanize(p.phase)} · <span className="font-semibold text-foreground">{humanize(p.action)}</span></td>
                              <td className="px-2 py-2 text-right font-semibold tabular-nums">{plural(p.applied_count, "asset")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
                <Card>
                  <SectionTitle title={<span className="inline-flex items-center gap-2"><ShieldAlert size={16} aria-hidden /> Coverage gaps</span>} subtitle="Required for the risk tier but missing" />
                  {gaps.length === 0 ? (
                    <p className="py-6 text-center text-ui-sm text-success">Every asset has the policies its risk tier requires.</p>
                  ) : (
                    <ul className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
                      {gaps.map((g) => (
                        <li key={`${g.requirement}|${g.asset_type}|${g.risk_tier}`} className="rounded-lg border border-border p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="font-semibold">{g.label}</div>
                            <Badge variant="destructive">{plural(g.missing_count, "asset")}</Badge>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <AssetTypeBadge type={g.asset_type} />
                            <Badge variant={RISK[g.risk_tier]}>{humanize(g.risk_tier)} risk</Badge>
                          </div>
                          {g.sample_assets.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-ui-sm">
                              {g.sample_assets.map((a) => (
                                <Link key={a.asset_id} to={assetHref(a.asset_id, "policies")} className="text-primary hover:underline">{a.display_name}</Link>
                              ))}
                              {g.missing_count > g.sample_assets.length && <span className="text-muted-foreground">+{g.missing_count - g.sample_assets.length} more</span>}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <PolicyExplainer />
            </>
          );
        }}
      </AsyncBlock>
    </div>
  );
}
