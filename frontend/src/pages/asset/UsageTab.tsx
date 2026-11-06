// Usage & Cost (benchmark §4.2 + §7.1): period selector, KPI ribbon, requests-over-time area + cost bars (each with
// a "view as table" alternative), by tool, by consumer (with "Not subscribed" flags and the owner's bulk "Nudge to
// register"), cost by SKU, the budget bar + editor, anomaly chips and the data-source footnote.
import { Activity, Coins, Megaphone, TriangleAlert, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { useAsset } from "../../components/asset/AssetContext";
import { EstimatedTag } from "../../components/asset/badges";
import BudgetEditor, { BudgetBar } from "../../components/asset/BudgetEditor";
import { writeErrorMessage } from "../../components/asset/errors";
import { fmtDay, fmtMs, fmtUsdUnit, plural } from "../../components/asset/format";
import KpiRibbon from "../../components/asset/KpiRibbon";
import { humanize } from "../../components/asset/meta";
import { ChartFrame, DataTable, ErrorCard, SectionSkeleton, Segmented, Td, Th } from "../../components/asset/primitives";
import { formatAsOf } from "../../components/SourcePill";
import SourcePill from "../../components/SourcePill";
import { Badge, Button, Card, EmptyState, SectionTitle, Tooltip, useToast } from "../../components/ui";
import { api, useApi } from "../../lib/api";
import { fmtAgo, fmtNum, fmtPct, fmtUsd } from "../../lib/assets";
import type { AssetUsage, Budget } from "../../lib/types";

const AXIS = { fill: "hsl(var(--muted-foreground))" };
const GRID = "hsl(var(--border))";
const TIP_STYLE = { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, color: "hsl(var(--popover-foreground))" };

function trendSummary(values: number[], what: string): string {
  if (values.length < 2) return `${what}: not enough data for a trend.`;
  const half = Math.floor(values.length / 2);
  const a = values.slice(0, half).reduce((x, y) => x + y, 0);
  const b = values.slice(half).reduce((x, y) => x + y, 0);
  const total = values.reduce((x, y) => x + y, 0);
  if (a === 0) return `${what}: ${total.toLocaleString()} in the period.`;
  const delta = Math.round(((b - a) / a) * 100);
  return `${what}: ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} in the period, ${delta >= 0 ? "up" : "down"} ${Math.abs(delta)}% in the second half vs the first.`;
}

export default function UsageTab() {
  const { detail, base, refreshKey } = useAsset();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const usage = useApi<AssetUsage>(`${base}/usage?days=${days}`, [refreshKey]);
  const [selected, setSelected] = useState<string[]>([]);
  const [nudging, setNudging] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const toast = useToast();
  const p = detail.permissions;
  const isOwner = detail.asset.my.owner || p.can_publish;
  const chartData = useMemo(() => (usage.data?.daily ?? []).map((d) => ({ ...d, label: fmtDay(d.day) })), [usage.data]);

  if (usage.error && !usage.data) return <ErrorCard error={usage.error} onRetry={usage.reload} />;
  if (!usage.data) return <SectionSkeleton />;
  const u = usage.data;
  const k = u.kpis;
  const unsubscribed = u.by_consumer.filter((c) => !c.subscribed);

  const nudge = async (requesters: string[]) => {
    if (!requesters.length) return;
    setNudging(true);
    try {
      const res = await api.post<{ ok: boolean; notified: number }>(`${base}/nudge`, { requesters });
      toast.success("Nudge sent", `${plural(res.notified ?? requesters.length, "consumer")} asked to register as subscribers.`);
      setSelected([]);
    } catch (err) {
      toast.error("Nudge not sent", writeErrorMessage(err));
    } finally {
      setNudging(false);
    }
  };

  const saveBudget = (b: Budget) => {
    usage.mutate((d) => ({ ...(d as AssetUsage), budget: b }));
    setEditingBudget(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: "7 d" },
            { value: 30, label: "30 d" },
            { value: 90, label: "90 d" },
          ]}
        />
        {u.scope === "self" && (
          <Badge variant="info" icon={<UsersRound size={12} aria-hidden />}>
            Your usage only
          </Badge>
        )}
        <EstimatedTag />
        <span className="ml-auto">
          <SourcePill source={usage.source} degradedReason={usage.degradedReason} asOf={usage.asOf} />
        </span>
      </div>

      {u.anomalies.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Anomalies">
          <span className="text-ui-sm font-semibold">Anomalies</span>
          {u.anomalies.slice(0, 6).map((an) => (
            <Tooltip key={`${an.day}-${an.metric}`} content={`${humanize(an.metric)} ${an.value.toLocaleString()} vs a ${an.baseline.toLocaleString()} baseline (${an.ratio.toFixed(1)}×). ${an.hint}`}>
              <span tabIndex={0} className="inline-flex">
                <Badge variant="warning" icon={<TriangleAlert size={11} aria-hidden />}>
                  {humanize(an.metric)} {an.ratio >= 10 ? ">10" : an.ratio.toFixed(1)}× · {fmtDay(an.day)}
                </Badge>
              </span>
            </Tooltip>
          ))}
          {u.anomalies.length > 6 && <span className="text-ui-xs text-muted-foreground">+{u.anomalies.length - 6} more</span>}
        </div>
      )}

      <KpiRibbon
        label={`Last ${days} days`}
        items={[
          { key: "req", label: "Requests", value: fmtNum(k.requests), icon: <Activity size={12} aria-hidden /> },
          { key: "users", label: "Active users", value: fmtNum(k.users), icon: <UsersRound size={12} aria-hidden /> },
          { key: "err", label: "Error rate", value: fmtPct(k.error_rate), hint: `${fmtNum(k.errors)} errors`, tone: (k.error_rate ?? 0) >= 0.05 ? "destructive" : (k.error_rate ?? 0) >= 0.01 ? "warning" : "default" },
          { key: "tok", label: "Tokens (in / out)", value: `${fmtNum(k.input_tokens)} / ${fmtNum(k.output_tokens)}` },
          { key: "cost", label: "Cost", value: fmtUsd(k.cost_usd), hint: "Estimated (list price)", icon: <Coins size={12} aria-hidden /> },
          { key: "unit", label: "$ / 1k requests", value: fmtUsdUnit(k.usd_per_1k_requests), tooltip: `cost ${fmtUsd(k.cost_usd)} ÷ ${k.requests.toLocaleString()} requests × 1000` },
          { key: "peruser", label: "$ / active user", value: fmtUsdUnit(k.usd_per_user), tooltip: `cost ${fmtUsd(k.cost_usd)} ÷ ${k.users} users` },
          { key: "p95", label: "p95 latency", value: fmtMs(k.p95_latency_ms) },
        ]}
      />

      {u.daily.length === 0 ? (
        <EmptyState icon={<Activity size={20} aria-hidden />} title="No traffic in this period" description="Requests appear once Unity Gateway usage tracking or inference tables record calls to this asset." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartFrame
            title="Requests over time"
            summary={trendSummary(u.daily.map((d) => d.requests), "Requests")}
            table={
              <DataTable label="Requests by day" dense>
                <thead>
                  <tr>
                    <Th>Day</Th>
                    <Th align="right">Requests</Th>
                    <Th align="right">Errors</Th>
                  </tr>
                </thead>
                <tbody>
                  {u.daily.map((d) => (
                    <tr key={d.day}>
                      <Td>{fmtDay(d.day)}</Td>
                      <Td align="right">{d.requests.toLocaleString()}</Td>
                      <Td align="right">{d.errors.toLocaleString()}</Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="req-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} />
                <RTooltip contentStyle={TIP_STYLE} />
                <Area type="monotone" dataKey="requests" name="Requests" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#req-fill)" />
                <Area type="monotone" dataKey="errors" name="Errors" stroke="hsl(var(--destructive))" strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
          <ChartFrame
            title="Cost per day"
            summary={`${trendSummary(u.daily.map((d) => d.cost_usd), "Estimated cost (USD)")} Estimated at list price.`}
            actions={<EstimatedTag />}
            table={
              <DataTable label="Cost by day" dense>
                <thead>
                  <tr>
                    <Th>Day</Th>
                    <Th align="right">Cost (est.)</Th>
                    <Th align="right">Input tokens</Th>
                    <Th align="right">Output tokens</Th>
                  </tr>
                </thead>
                <tbody>
                  {u.daily.map((d) => (
                    <tr key={d.day}>
                      <Td>{fmtDay(d.day)}</Td>
                      <Td align="right">{fmtUsdUnit(d.cost_usd)}</Td>
                      <Td align="right">{d.input_tokens.toLocaleString()}</Td>
                      <Td align="right">{d.output_tokens.toLocaleString()}</Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => `$${v}`} />
                <RTooltip contentStyle={TIP_STYLE} formatter={(v) => [`$${Number(v).toFixed(2)} (est.)`, "Cost"]} />
                <Bar dataKey="cost_usd" name="Cost" fill="hsl(var(--db-orange))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="space-y-3">
          <SectionTitle
            title="Consumers"
            subtitle={u.scope === "self" ? "Only your own usage is visible to you." : unsubscribed.length ? `${plural(unsubscribed.length, "consumer")} use this without a subscription: they won't hear about breaking changes.` : "Every consumer is subscribed."}
            actions={
              isOwner && unsubscribed.length > 0 ? (
                <Button size="sm" variant="secondary" loading={nudging} icon={<Megaphone size={13} aria-hidden />} onClick={() => void nudge(selected.length ? selected : unsubscribed.map((c) => c.requester))}>
                  {selected.length ? `Nudge ${selected.length} to register` : "Nudge all to register"}
                </Button>
              ) : undefined
            }
          />
          {u.by_consumer.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">No consumers recorded in this period.</p>
          ) : (
            <DataTable label="Consumers" dense>
              <thead>
                <tr>
                  {isOwner && (
                    <Th>
                      <span className="sr-only">Select</span>
                    </Th>
                  )}
                  <Th>Requester</Th>
                  <Th>Kind</Th>
                  <Th align="right">Requests</Th>
                  <Th align="right">Cost (est.)</Th>
                  <Th>Last seen</Th>
                  <Th>Subscribed</Th>
                </tr>
              </thead>
              <tbody>
                {u.by_consumer.map((c) => (
                  <tr key={c.requester}>
                    {isOwner && (
                      <Td>
                        {!c.subscribed && (
                          <input
                            type="checkbox"
                            className="accent-primary"
                            aria-label={`Select ${c.requester}`}
                            checked={selected.includes(c.requester)}
                            onChange={(e) => setSelected((xs) => (e.target.checked ? [...xs, c.requester] : xs.filter((x) => x !== c.requester)))}
                          />
                        )}
                      </Td>
                    )}
                    <Td className="max-w-[260px] truncate font-medium">{c.requester}</Td>
                    <Td className="text-muted-foreground">{humanize(c.requester_kind)}</Td>
                    <Td align="right">{c.requests.toLocaleString()}</Td>
                    <Td align="right">{fmtUsdUnit(c.cost_usd)}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{fmtAgo(c.last_seen)}</Td>
                    <Td>{c.subscribed ? <Badge variant="success">Subscribed</Badge> : <Badge variant="warning">Not subscribed</Badge>}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="space-y-3">
            <SectionTitle
              title="Budget"
              actions={
                isOwner && !editingBudget ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditingBudget(true)}>
                    {u.budget ? "Edit" : "Set budget"}
                  </Button>
                ) : undefined
              }
            />
            {u.budget ? <BudgetBar budget={u.budget} /> : <p className="text-ui-sm text-muted-foreground">No budget is set. {isOwner ? "Set one to get alerts before spend surprises you." : "The owner can set one."}</p>}
            {editingBudget && <BudgetEditor assetId={detail.asset.asset_id} budget={u.budget} onSaved={saveBudget} onCancel={() => setEditingBudget(false)} />}
          </Card>
          <Card className="space-y-3">
            <SectionTitle title="By tool" />
            {u.by_tool.length === 0 ? (
              <p className="text-ui-sm text-muted-foreground">No per-tool calls recorded.</p>
            ) : (
              <ul className="space-y-2">
                {[...u.by_tool]
                  .sort((x, y) => y.requests - x.requests)
                  .slice(0, 10)
                  .map((t) => {
                    const max = Math.max(...u.by_tool.map((x) => x.requests), 1);
                    return (
                      <li key={t.tool_name} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-ui-sm">
                          <span className="truncate font-mono">{t.tool_name}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {t.requests.toLocaleString()} · {t.requests ? fmtPct(t.errors / t.requests) : "–"} errors
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${(t.requests / max) * 100}%` }} />
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </Card>
          <Card className="space-y-3">
            <SectionTitle title="Cost by SKU" actions={<EstimatedTag />} />
            {u.cost_by_sku.length === 0 ? (
              <p className="text-ui-sm text-muted-foreground">No billing records in this period.</p>
            ) : (
              <DataTable label="Cost by SKU" dense>
                <thead>
                  <tr>
                    <Th>SKU</Th>
                    <Th>Source</Th>
                    <Th align="right">DBUs</Th>
                    <Th align="right">USD (est.)</Th>
                  </tr>
                </thead>
                <tbody>
                  {u.cost_by_sku.map((s) => (
                    <tr key={`${s.sku}-${s.source}`}>
                      <Td className="font-mono text-ui-xs">{s.sku}</Td>
                      <Td className="text-muted-foreground">{s.source}</Td>
                      <Td align="right">{s.dbus.toLocaleString(undefined, { maximumFractionDigits: 1 })}</Td>
                      <Td align="right">{fmtUsdUnit(s.usd)}</Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>
      </div>

      {u.sources.length > 0 && (
        <footer className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-ui-xs text-muted-foreground">
          <div className="mb-1 font-semibold text-foreground">Data sources</div>
          <ul className="space-y-0.5">
            {u.sources
              .filter((s, i, all) => all.findIndex((x) => x.name === s.name && x.detail === s.detail) === i)
              .map((s, i) => (
              <li key={`${s.name}-${i}`}>
                <span className="font-mono">{s.name}</span>: {s.detail}
                {s.as_of && <> · as of {formatAsOf(s.as_of) ?? s.as_of}</>}
              </li>
            ))}
          </ul>
          <p className="mt-1">Money is estimated at list price. Billing tables update every few hours and external model spend hourly, so figures can differ from near-real-time budgets.</p>
        </footer>
      )}
    </div>
  );
}
