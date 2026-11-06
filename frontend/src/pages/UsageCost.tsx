// Fleet Usage & Cost (/usage-cost?days=30): requests, users and estimated list-price cost across every agent and
// MCP server, by type and platform, anomalies with cause hints, budgets, and where each number comes from.
import { motion } from "framer-motion";
import { Activity, Bot, ChevronDown, Coins, Info, Server, ShieldCheck, TrendingUp, Users, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BarList, BudgetBar } from "../components/charts/bars";
import ChartCard from "../components/charts/ChartCard";
import TimeSeriesChart, { CHART, shortDay } from "../components/charts/TimeSeriesChart";
import SourcePill from "../components/SourcePill";
import { Badge, Button, Card, EmptyState, KpiTile, PageHeader, SectionTitle, Select, Tooltip } from "../components/ui";
import { AssetLink, AssetTypeBadge } from "../components/workspace/chips";
import { ErrorCard, KpiSkeleton } from "../components/workspace/feedback";
import { fmtDate, fmtUsdExact } from "../components/workspace/format";
import { useApi } from "../lib/api";
import { assetHref, fmtNum, fmtUsd, TYPE_LABEL } from "../lib/assets";
import { stagger, staggerItem } from "../lib/motion";
import type { DailyPoint, FleetUsage } from "../lib/types";

const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

/** Second half of the window vs the first, as a % change (null when there's no baseline). */
export function trendPct(daily: DailyPoint[], key: "requests" | "cost_usd"): number | null {
  if (daily.length < 4) return null;
  const mid = Math.floor(daily.length / 2);
  const a = daily.slice(0, mid).reduce((s, d) => s + d[key], 0);
  const b = daily.slice(mid).reduce((s, d) => s + d[key], 0);
  return a > 0 ? ((b - a) / a) * 100 : null;
}

function trendSentence(label: string, pct: number | null): string {
  if (pct === null) return `${label}: not enough history for a trend.`;
  if (Math.abs(pct) < 1) return `${label} were flat across the window.`;
  return `${label} ${pct > 0 ? "rose" : "fell"} ${Math.abs(pct).toFixed(0)}% from the first half of the window to the second.`;
}

const per1k = (cost: number, requests: number) => (requests > 0 ? (cost / requests) * 1000 : null);

export default function UsageCost() {
  const [params, setParams] = useSearchParams();
  const days = WINDOWS.some((w) => w.value === params.get("days")) ? params.get("days")! : "30";
  const q = useApi<FleetUsage>(`/api/usage-cost?days=${days}`);
  const [allAnomalies, setAllAnomalies] = useState(false);
  const d = q.data;

  const anomalies = useMemo(() => [...(d?.anomalies ?? [])].sort((a, b) => b.ratio - a.ratio || b.day.localeCompare(a.day)), [d]);
  const sources = useMemo(() => {
    const seen = new Set<string>();
    return (d?.sources ?? []).filter((s) => {
      const k = `${s.name}|${s.detail}|${s.as_of}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [d]);

  const header = (
    <PageHeader
      icon={<Activity size={20} aria-hidden />}
      title="Usage & Cost"
      subtitle="Requests, active users and estimated cost across every agent and MCP server, from Unity Gateway and serving usage priced at list price."
      source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
      actions={<Select aria-label="Time window" value={days} onValueChange={(v) => setParams({ days: v })} options={WINDOWS} wrapperClassName="w-40" />}
    />
  );

  if (!d) {
    return (
      <div className="space-y-5">
        {header}
        {q.error ? <ErrorCard error={q.error} onRetry={q.reload} title="Couldn't load usage and cost" /> : <KpiSkeleton />}
      </div>
    );
  }

  const reqTrend = trendPct(d.daily, "requests");
  const costTrend = trendPct(d.daily, "cost_usd");
  const dailyRows = d.daily.map((p) => ({ ...p }));
  const totalTypeReq = d.by_type.reduce((s, x) => s + x.requests, 0);

  return (
    <div className="space-y-5">
      {header}

      <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {[
          { label: "Requests", value: fmtNum(d.kpis.requests), icon: <TrendingUp size={15} aria-hidden />, delta: reqTrend, hint: `${days}-day total` },
          { label: "Active users", value: fmtNum(d.kpis.users), icon: <Users size={15} aria-hidden />, hint: "Distinct requesters" },
          { label: "Cost", value: fmtUsdExact(d.kpis.cost_usd), icon: <Coins size={15} aria-hidden />, delta: costTrend, invert: true, hint: "Estimated (list price)" },
          { label: "Active agents", value: fmtNum(d.kpis.agents_active), icon: <Bot size={15} aria-hidden />, hint: "With traffic in the window" },
          { label: "Active MCP servers", value: fmtNum(d.kpis.mcp_active), icon: <Server size={15} aria-hidden />, hint: "With traffic in the window" },
          { label: "Governed traffic", value: `${Math.round(d.kpis.governed_pct)}%`, icon: <ShieldCheck size={15} aria-hidden />, hint: "Reach a guarded or UC-gated asset" },
        ].map((k) => (
          <motion.div key={k.label} variants={staggerItem}>
            <KpiTile label={k.label} value={k.value} icon={k.icon} delta={k.delta ?? null} invertDelta={k.invert} deltaLabel={k.delta != null ? "2nd half vs 1st" : undefined} hint={k.hint} />
          </motion.div>
        ))}
      </motion.div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Requests over time"
          subtitle="Daily requests and errors"
          summary={trendSentence("Requests", reqTrend)}
          table={{
            columns: [
              { key: "day", label: "Day", format: (v) => shortDay(String(v)) },
              { key: "requests", label: "Requests", align: "right", format: (v) => Number(v).toLocaleString() },
              { key: "errors", label: "Errors", align: "right", format: (v) => Number(v).toLocaleString() },
            ],
            rows: dailyRows,
          }}
        >
          <TimeSeriesChart
            data={dailyRows}
            series={[
              { key: "requests", label: "Requests", color: CHART.primary },
              { key: "errors", label: "Errors", color: CHART.destructive },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Cost over time"
          subtitle={<span className="inline-flex items-center gap-1">Daily cost <Badge variant="warning">Estimated (list price)</Badge></span>}
          summary={trendSentence("Costs", costTrend)}
          table={{
            columns: [
              { key: "day", label: "Day", format: (v) => shortDay(String(v)) },
              { key: "cost_usd", label: "Cost (USD, est.)", align: "right", format: (v) => fmtUsdExact(Number(v)) },
              { key: "input_tokens", label: "Input tokens", align: "right", format: (v) => fmtNum(Number(v)) },
              { key: "output_tokens", label: "Output tokens", align: "right", format: (v) => fmtNum(Number(v)) },
            ],
            rows: dailyRows,
          }}
        >
          <TimeSeriesChart data={dailyRows} series={[{ key: "cost_usd", label: "Cost (USD)", color: CHART.teal, format: (v) => fmtUsdExact(v) }]} yFormat={(v) => fmtUsd(v)} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <SectionTitle title="Top assets" subtitle={`By requests in the last ${days} days`} actions={<Badge variant="warning">Cost: estimated (list price)</Badge>} />
          {d.top_assets.length === 0 ? (
            <p className="py-6 text-center text-ui-sm text-muted-foreground">No traffic in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-ui-sm">
                <caption className="sr-only">Top assets by requests</caption>
                <thead className="text-left text-ui-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Asset</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Requests</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Users</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Cost</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">$ / 1k req</th>
                  </tr>
                </thead>
                <tbody>
                  {d.top_assets.map((a) => {
                    const unit = per1k(a.cost_usd, a.requests);
                    return (
                      <tr key={a.asset_id} className="border-t border-border/70">
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            <AssetLink assetId={a.asset_id} name={a.display_name} type={a.asset_type} tab="usage" />
                            <AssetTypeBadge type={a.asset_type} className="hidden md:inline-flex" />
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{a.requests.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmtNum(a.users)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmtUsdExact(a.cost_usd)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {unit == null ? "–" : (
                            <Tooltip content={`${fmtUsdExact(a.cost_usd)} ÷ ${a.requests.toLocaleString()} requests × 1,000`}>
                              <span tabIndex={0} className="underline decoration-dotted underline-offset-2">{fmtUsdExact(unit)}</span>
                            </Tooltip>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="space-y-4">
          <Card>
            <SectionTitle title="By type" subtitle="Requests (cost, estimated)" />
            <BarList
              rows={d.by_type.map((t) => ({
                key: t.asset_type, label: TYPE_LABEL[t.asset_type] ?? t.asset_type, value: t.requests,
                display: `${fmtNum(t.requests)}${totalTypeReq ? ` · ${Math.round((t.requests / totalTypeReq) * 100)}%` : ""}`, sub: fmtUsd(t.cost_usd),
              }))}
            />
          </Card>
          <Card>
            <SectionTitle title="By platform" subtitle="Requests (cost, estimated)" />
            <BarList tone="bg-db-teal" rows={d.by_platform.map((p) => ({ key: p.platform, label: p.platform.replace(/_/g, " "), value: p.requests, display: fmtNum(p.requests), sub: fmtUsd(p.cost_usd) }))} />
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionTitle
            title={<span className="inline-flex items-center gap-2">Anomalies <Badge variant={anomalies.length ? "warning" : "success"}>{anomalies.length}</Badge></span>}
            subtitle="Days above twice the trailing median, with the likely cause"
          />
          {anomalies.length === 0 ? (
            <p className="py-6 text-center text-ui-sm text-muted-foreground">No anomalies in this window.</p>
          ) : (
            <>
              <ul className="divide-y divide-border/70">
                {(allAnomalies ? anomalies : anomalies.slice(0, 8)).map((a) => (
                  <li key={`${a.asset_id}|${a.day}|${a.metric}`} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-ui-sm">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={assetHref(a.asset_id, "usage")} className="font-semibold hover:text-primary hover:underline">{a.asset_display_name}</Link>
                        <Badge variant={a.metric === "cost" ? "warning" : a.metric === "errors" ? "destructive" : "info"}>{a.metric}</Badge>
                        <span className="text-ui-xs text-muted-foreground">{fmtDate(a.day)}</span>
                      </div>
                      <p className="mt-0.5 flex items-center gap-1 text-ui-xs text-muted-foreground"><Info size={12} aria-hidden /> {a.hint}</p>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="font-bold text-warning">×{a.ratio.toFixed(1)}</div>
                      <div className="text-ui-xs text-muted-foreground">
                        {a.metric === "cost" ? `${fmtUsdExact(a.value)} vs ${fmtUsdExact(a.baseline)}` : `${fmtNum(a.value)} vs ${fmtNum(a.baseline)}`}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {anomalies.length > 8 && (
                <Button variant="ghost" size="sm" className="mt-2" aria-expanded={allAnomalies} icon={<ChevronDown size={13} aria-hidden className={allAnomalies ? "rotate-180" : undefined} />} onClick={() => setAllAnomalies((v) => !v)}>
                  {allAnomalies ? "Show fewer" : `Show all ${anomalies.length}`}
                </Button>
              )}
            </>
          )}
        </Card>
        <Card>
          <SectionTitle title={<span className="inline-flex items-center gap-2"><Wallet size={16} aria-hidden /> Budgets</span>} subtitle="Month to date with the month-end forecast" />
          {d.budgets.length === 0 ? (
            <EmptyState
              className="!py-8"
              title="No budgets set"
              description="Owners and stewards set a monthly budget on an asset's Usage tab (alert or block). Unity Gateway budgets show here too once synced."
            />
          ) : (
            <ul className="space-y-5">
              {d.budgets.map((b) => (
                <li key={b.asset_id}>
                  <BudgetBar budget={b} title={<Link to={assetHref(b.asset_id, "usage")} className="hover:text-primary hover:underline">{b.display_name}</Link>} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="!p-4">
        <div className="mb-2 flex items-center gap-2 text-ui-sm font-semibold"><Info size={14} aria-hidden /> Where these numbers come from</div>
        <ul className="grid gap-x-6 gap-y-1 text-ui-xs text-muted-foreground md:grid-cols-2">
          {sources.map((s, i) => (
            <li key={`${s.name}-${i}`}>
              <span className="font-mono text-foreground">{s.name}</span> · {s.detail}
              {s.as_of && <span> · as of {fmtDate(s.as_of)}</span>}
            </li>
          ))}
          <li>Money is USD at list price (DBUs × list prices), always an estimate. Billing tables update every few hours, gateway usage near real time, so figures can differ slightly.</li>
        </ul>
      </Card>
    </div>
  );
}
