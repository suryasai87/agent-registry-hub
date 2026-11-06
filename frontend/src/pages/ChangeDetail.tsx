// Impact report for one change (/changes/:changeId): what changed, who is affected (subscribers, owners of
// downstream assets, observed unregistered consumers), who acknowledged, downstream assets, and metrics before
// vs after. If I'm listed, I can acknowledge right here.
import { motion } from "framer-motion";
import { ArrowLeft, CircleAlert, FileClock, GitBranch, Megaphone, Network, UserRound, Users } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Delta, StackedBar, type Better, type Segment } from "../components/charts/bars";
import SourcePill from "../components/SourcePill";
import { Badge, Card, EmptyState, PageHeader, SectionTitle, Skeleton } from "../components/ui";
import AckControl from "../components/workspace/AckControl";
import { ACK_LABEL, AckBadge, AssetLink, AssetTypeBadge, Person } from "../components/workspace/chips";
import { ErrorCard } from "../components/workspace/feedback";
import { fmtDate, fmtDateTime, fmtMs, fmtRelative, humanize, plural, shortValue, toJson } from "../components/workspace/format";
import { enc, useApi } from "../lib/api";
import { assetHref, fmtNum, fmtPct, fmtUsd, typeOf } from "../lib/assets";
import { cx } from "../lib/cx";
import { stagger, staggerItem } from "../lib/motion";
import { useSession } from "../lib/session";
import type { AckStatus, ChangeDetail as Detail, ImpactItem, MetricsSnapshot } from "../lib/types";

const ACK_TONE: Record<AckStatus, string> = {
  not_impacted: "bg-success",
  impacted_will_migrate: "bg-info",
  need_help: "bg-destructive",
  pending: "bg-warning",
  not_required: "bg-muted-foreground/40",
};
const ACK_ORDER: AckStatus[] = ["not_impacted", "impacted_will_migrate", "need_help", "pending", "not_required"];

export function ackSegments(summary: Partial<Record<AckStatus, number>>): Segment[] {
  return ACK_ORDER.map((k) => ({ key: k, label: ACK_LABEL[k], value: summary[k] ?? 0, tone: ACK_TONE[k] })).filter((s) => s.value > 0 || s.key !== "not_required");
}

export interface MetricRow {
  key: string;
  label: string;
  before: number | null;
  after: number | null;
  better: Better;
  format: (v: number) => string;
}

/** Before/after rows: requests (neutral), error rate / cost / p95 (lower is better), each eval scorer (higher). */
export function metricRows(before: MetricsSnapshot | null, after: MetricsSnapshot | null): MetricRow[] {
  const rows: MetricRow[] = [
    { key: "requests", label: "Requests", before: before?.requests ?? null, after: after?.requests ?? null, better: "neutral", format: (v) => fmtNum(v) },
    { key: "error_rate", label: "Error rate", before: before?.error_rate ?? null, after: after?.error_rate ?? null, better: "lower", format: (v) => fmtPct(v, 2) },
    { key: "cost_usd", label: "Cost (estimated, list price)", before: before?.cost_usd ?? null, after: after?.cost_usd ?? null, better: "lower", format: (v) => fmtUsd(v) },
    { key: "p95_ms", label: "p95 latency", before: before?.p95_ms ?? null, after: after?.p95_ms ?? null, better: "lower", format: (v) => fmtMs(v) },
  ];
  const scorers = [...new Set([...Object.keys(before?.eval ?? {}), ...Object.keys(after?.eval ?? {})])].sort();
  for (const s of scorers) {
    rows.push({ key: `eval:${s}`, label: `Eval · ${humanize(s)}`, before: before?.eval?.[s] ?? null, after: after?.eval?.[s] ?? null, better: "higher", format: (v) => (v <= 1 ? v.toFixed(2) : v.toFixed(1)) });
  }
  return rows;
}

const GROUPS: { type: ImpactItem["impact_type"]; title: string; subtitle: string; icon: ReactNode }[] = [
  { type: "subscriber", title: "Subscribers", subtitle: "Registered their email for this asset", icon: <Users size={16} aria-hidden /> },
  { type: "downstream_owner", title: "Downstream owners", subtitle: "Own an asset that depends on this one", icon: <UserRound size={16} aria-hidden /> },
  { type: "observed_consumer", title: "Observed unregistered consumers", subtitle: "Seen calling it in the last 30 days without a subscription", icon: <Megaphone size={16} aria-hidden /> },
];

function PeopleTable({ items, labelOf }: { items: ImpactItem[]; labelOf: (id: string | null) => string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-ui-sm">
        <thead className="text-left text-ui-xs text-muted-foreground">
          <tr>
            {["Person", "Via", "Acknowledgement", "Notified"].map((h) => <th key={h} scope="col" className="px-2 py-1.5 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={`${i.impacted_key}|${i.impact_type}`} className="border-t border-border/70 align-top">
              <td className="px-2 py-2"><Person email={i.email ?? i.impacted_key} name={i.label && i.label !== i.email ? i.label : null} /></td>
              <td className="px-2 py-2 text-muted-foreground">
                {i.via_asset_id ? (
                  <>
                    <Link to={assetHref(i.via_asset_id)} className="hover:text-foreground hover:underline">{labelOf(i.via_asset_id) ?? i.via_asset_id}</Link>
                    {i.hops > 0 && <span className="ml-1 text-ui-xs">({plural(i.hops, "hop")})</span>}
                  </>
                ) : (
                  "Direct"
                )}
              </td>
              <td className="px-2 py-2">
                <AckBadge status={i.ack_status} migrateBy={i.migrate_by} />
                {i.ack_note && <div className="mt-1 max-w-xs text-ui-xs text-muted-foreground">“{i.ack_note}”</div>}
                {i.acked_at && <div className="mt-0.5 text-ui-xs text-muted-foreground">{fmtRelative(i.acked_at)}</div>}
              </td>
              <td className="px-2 py-2 text-muted-foreground" title={fmtDateTime(i.notified_at)}>{i.notified_at ? fmtRelative(i.notified_at) : "Not notified"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Value({ v }: { v: unknown }) {
  if (v !== null && typeof v === "object") return <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 px-2 py-1 font-mono text-ui-xs">{toJson(v)}</pre>;
  return <span className="break-words">{shortValue(v, 400)}</span>;
}

export default function ChangeDetailPage() {
  const { changeId = "" } = useParams();
  const { me } = useSession();
  const q = useApi<Detail>(`/api/changes/${enc(changeId)}`);
  const d = q.data;
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of d?.impact ?? []) if (i.impact_type === "downstream_asset") m.set(i.impacted_key, i.label);
    if (d) m.set(d.change.asset_id, d.change.asset_display_name);
    return m;
  }, [d]);
  const labelOf = (id: string | null) => (id ? labels.get(id) ?? null : null);

  if (!d) {
    return q.error ? (
      <div className="space-y-4">
        <Link to="/changes" className="inline-flex items-center gap-1 text-ui-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft size={14} aria-hidden /> All changes</Link>
        <ErrorCard error={q.error} onRetry={q.reload} title="Couldn't load this impact report" />
      </div>
    ) : (
      <div className="space-y-4" aria-busy="true" aria-label="Loading impact report">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-48 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></div>
      </div>
    );
  }

  const c = d.change;
  const email = me?.email.toLowerCase();
  const mine = d.impact.filter((i) => i.email?.toLowerCase() === email && i.ack_status !== "not_required");
  const myStatus: AckStatus | null = mine.length ? (mine.find((i) => i.ack_status === "pending")?.ack_status ?? mine[0].ack_status) : null;
  const myMigrate = mine.find((i) => i.migrate_by)?.migrate_by ?? null;
  const downstream = d.impact.filter((i) => i.impact_type === "downstream_asset").sort((a, b) => a.hops - b.hops);
  const segments = ackSegments(d.ack_summary);
  const needAck = segments.filter((s) => s.key !== "not_required").reduce((n, s) => n + s.value, 0);
  const acked = (d.ack_summary.not_impacted ?? 0) + (d.ack_summary.impacted_will_migrate ?? 0) + (d.ack_summary.need_help ?? 0);
  const metrics = metricRows(d.metrics_before, d.metrics_after);

  const applyAck = (rows: ImpactItem[]) => {
    const fresh = new Map(rows.map((r) => [`${r.impacted_key}|${r.impact_type}`, r]));
    q.mutate((current) => {
      const prev = current ?? d;
      const impact = prev.impact.map((i) => {
        const r = fresh.get(`${i.impacted_key}|${i.impact_type}`);
        return r ? { ...i, ack_status: r.ack_status, ack_note: r.ack_note, migrate_by: r.migrate_by, acked_at: r.acked_at } : i;
      });
      const summary = { pending: 0, not_impacted: 0, impacted_will_migrate: 0, need_help: 0, not_required: 0 } as Record<AckStatus, number>;
      for (const i of impact) if (i.impact_type !== "downstream_asset") summary[i.ack_status] = (summary[i.ack_status] ?? 0) + 1;
      return { ...prev, impact, ack_summary: summary };
    });
  };

  return (
    <div className="space-y-5">
      <Link to="/changes" className="inline-flex items-center gap-1 text-ui-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft size={14} aria-hidden /> All changes</Link>
      <PageHeader
        icon={<FileClock size={20} aria-hidden />}
        title={c.title}
        source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
        subtitle={c.summary ?? undefined}
        actions={
          <Link to={`/lineage?focus=${enc(c.asset_id)}&change_id=${c.change_id}&depth=3&dir=down`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground hover:brightness-110">
            <GitBranch size={15} aria-hidden /> View impact on lineage
          </Link>
        }
      />

      <Card className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {c.breaking ? <Badge variant="destructive" icon={<CircleAlert size={11} aria-hidden />}>Breaking</Badge> : <Badge variant="success">Non-breaking</Badge>}
            <AssetLink assetId={c.asset_id} name={c.asset_display_name} type={c.asset_type} className="text-ui-md" />
            <AssetTypeBadge type={c.asset_type} />
            <Badge>{humanize(c.status)}</Badge>
            {c.change_kinds.map((k) => <Badge key={k} variant="info">{humanize(k)}</Badge>)}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-ui-sm sm:grid-cols-4">
            <div><dt className="text-ui-xs text-muted-foreground">Version</dt><dd className="font-mono font-semibold">{c.from_version ?? "–"} → {c.to_version ?? "–"}</dd></div>
            <div><dt className="text-ui-xs text-muted-foreground">Published</dt><dd className="font-semibold" title={fmtDateTime(c.published_at)}>{c.published_at ? fmtDate(c.published_at) : "Not yet"}{c.published_by ? ` · ${c.published_by}` : ""}</dd></div>
            <div><dt className="text-ui-xs text-muted-foreground">Effective</dt><dd className="font-semibold">{c.effective_at ? `${fmtDate(c.effective_at)} (${fmtRelative(c.effective_at)})` : "Immediately"}</dd></div>
            <div><dt className="text-ui-xs text-muted-foreground">Sunset of previous</dt><dd className="font-semibold">{c.sunset_at ? fmtDate(c.sunset_at) : "–"}</dd></div>
          </dl>
          {c.release_notes && (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-ui-sm">
              <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">Release notes</div>
              <p className="whitespace-pre-wrap">{c.release_notes}</p>
            </div>
          )}
        </div>
        <div className="min-w-[220px] space-y-1 border-border md:border-l md:pl-4">
          <div className="text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">Impact</div>
          <div className="text-ui-2xl font-extrabold tabular-nums">{plural(c.impacted_people, "person", "people")}</div>
          <div className="text-ui-sm text-muted-foreground">{plural(downstream.length, "downstream asset")}</div>
          {needAck > 0 && <div className="text-ui-sm"><b className="tabular-nums">{acked}</b> of {needAck} acknowledged</div>}
        </div>
      </Card>

      {myStatus && (
        <Card className="border-primary/40">
          <SectionTitle title="Your acknowledgement" subtitle={`You're listed as ${[...new Set(mine.map((i) => humanize(i.impact_type).toLowerCase()))].join(" and ")}. Tell the owner where you stand.`} />
          <AckControl changeId={c.change_id} current={myStatus} migrateBy={myMigrate} effectiveAt={c.effective_at} onAcked={applyAck} />
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionTitle title="Acknowledgements" subtitle={c.breaking ? "Breaking changes ask every impacted person to acknowledge" : "Non-breaking: acknowledgement is optional"} />
          <StackedBar segments={segments} label="Acknowledgement status" height={14} />
        </Card>
        <Card>
          <SectionTitle title="What changed" subtitle={`${plural(c.diff.length, "field")} differ`} />
          {c.diff.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">No field-level diff was recorded for this change{c.release_notes ? "; see the release notes" : ""}.</p>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-ui-sm">
                <thead className="text-left text-ui-xs text-muted-foreground">
                  <tr><th scope="col" className="px-2 py-1.5 font-semibold">Field</th><th scope="col" className="px-2 py-1.5 font-semibold">Before</th><th scope="col" className="px-2 py-1.5 font-semibold">After</th></tr>
                </thead>
                <tbody>
                  {c.diff.map((row) => (
                    <tr key={row.field} className="border-t border-border/70 align-top">
                      <td className="px-2 py-2 font-mono text-ui-xs font-semibold">{row.field}</td>
                      <td className="px-2 py-2 text-muted-foreground line-through decoration-destructive/50"><Value v={row.before} /></td>
                      <td className="px-2 py-2"><Value v={row.after} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <section aria-labelledby="impacted-people" className="space-y-3">
        <h2 id="impacted-people" className="text-ui-lg font-bold">Impacted people</h2>
        <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
          {GROUPS.map((g) => {
            const items = d.impact.filter((i) => i.impact_type === g.type);
            return (
              <motion.div key={g.type} variants={staggerItem}>
                <Card className="h-full" aria-label={g.title}>
                  <SectionTitle title={<span className="inline-flex items-center gap-2">{g.icon}{g.title} <Badge>{items.length}</Badge></span>} subtitle={g.subtitle} />
                  {items.length ? <PeopleTable items={items} labelOf={labelOf} /> : <p className="text-ui-sm text-muted-foreground">None.</p>}
                </Card>
              </motion.div>
            );
          })}
        </motion.div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionTitle title={<span className="inline-flex items-center gap-2"><Network size={16} aria-hidden /> Downstream assets</span>} subtitle="Depend on this asset, found through lineage" />
          {downstream.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">No registered asset depends on it.</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {downstream.map((i) => (
                <li key={i.impacted_key} className="flex items-center justify-between gap-3 py-2 text-ui-sm">
                  <AssetLink assetId={i.impacted_key} name={i.label} type={typeOf(i.impacted_key)} />
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    {plural(i.hops, "hop")}{i.via_asset_id && i.via_asset_id !== c.asset_id ? ` · via ${labelOf(i.via_asset_id) ?? i.via_asset_id}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <SectionTitle
            title="Before vs after"
            subtitle={d.metrics_before ? `${d.metrics_before.window_days}-day windows around the effective date` : "Metrics snapshot"}
          />
          {!d.metrics_before && !d.metrics_after ? (
            <EmptyState className="!py-6" title="No metrics captured" description="Usage, cost and eval snapshots are captured when a change is published and again after its effective date." />
          ) : (
            <>
              <table className="w-full text-ui-sm">
                <caption className="sr-only">Metrics before and after the change</caption>
                <thead className="text-left text-ui-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Metric</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Before</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">After</th>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.key} className="border-t border-border/70">
                      <th scope="row" className="px-2 py-2 text-left font-medium">{m.label}</th>
                      <td className="px-2 py-2 text-right tabular-nums">{m.before == null ? "–" : m.format(m.before)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{m.after == null ? "–" : m.format(m.after)}</td>
                      <td className={cx("px-2 py-2")}><Delta before={m.before} after={m.after} better={m.better} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.metrics_after && <p className="mt-2 text-ui-xs text-muted-foreground">The after-window fills in once the change has been effective for {d.metrics_before?.window_days ?? 7} days.</p>}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
