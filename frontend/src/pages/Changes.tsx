// Changes & Impact feed: every published version, deprecation, policy and runtime change, with acknowledgement
// progress. Filters live in the URL (?breaking=true&mine=true&asset_id=…&days=90).
import { motion } from "framer-motion";
import { CircleAlert, FileClock, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { ProgressBar } from "../components/charts/bars";
import SourcePill from "../components/SourcePill";
import { Badge, Card, EmptyState, PageHeader, Select, Toggle } from "../components/ui";
import AssetSearch from "../components/workspace/AssetSearch";
import { AckBadge, AssetLink, AssetTypeBadge } from "../components/workspace/chips";
import { AsyncBlock, RowsSkeleton } from "../components/workspace/feedback";
import { fmtDate, fmtDateTime, fmtRelative, humanize } from "../components/workspace/format";
import { enc, useApi } from "../lib/api";
import { cx } from "../lib/cx";
import { stagger, staggerItem } from "../lib/motion";
import type { ChangeSummary } from "../lib/types";

const DAYS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
];

export function changesPath(p: { assetId?: string | null; breaking?: boolean; mine?: boolean; days?: string }): string {
  const q = new URLSearchParams();
  if (p.assetId) q.set("asset_id", p.assetId);
  if (p.breaking) q.set("breaking", "true");
  if (p.mine) q.set("mine", "true");
  q.set("days", p.days ?? "90");
  return `/api/changes?${q.toString()}`;
}

export function ChangeRow({ c }: { c: ChangeSummary }) {
  const ackable = c.impacted_people > 0;
  return (
    <Card className={cx("flex flex-col gap-3 !p-4 md:flex-row md:items-center", c.breaking && "border-l-4 border-l-destructive/70")}>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {c.breaking && <Badge variant="destructive" icon={<CircleAlert size={11} aria-hidden />}>Breaking</Badge>}
          <Link to={`/changes/${c.change_id}`} className="text-ui-md font-bold hover:text-primary hover:underline">{c.title}</Link>
          <Badge>{humanize(c.status)}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-muted-foreground">
          <AssetLink assetId={c.asset_id} name={c.asset_display_name} type={c.asset_type} />
          <AssetTypeBadge type={c.asset_type} />
          {(c.from_version || c.to_version) && <span className="font-mono text-ui-xs">{c.from_version ?? "–"} → {c.to_version ?? "–"}</span>}
          {c.change_kinds.map((k) => <Badge key={k}>{humanize(k)}</Badge>)}
        </div>
        <div className="flex flex-wrap gap-x-3 text-ui-xs text-muted-foreground">
          <span title={fmtDateTime(c.published_at ?? c.created_at)}>
            {c.published_at ? `Published ${fmtRelative(c.published_at)}` : `Detected ${fmtRelative(c.created_at)}`}
            {c.published_by ? ` by ${c.published_by}` : c.detected_by === "sync" ? " by sync" : ""}
          </span>
          {c.effective_at && <span>Effective {fmtDate(c.effective_at)}</span>}
        </div>
      </div>
      <div className="w-full shrink-0 space-y-1.5 md:w-64">
        {ackable ? (
          <>
            <div className="flex items-center justify-between text-ui-xs">
              <span className="text-muted-foreground">Acknowledged</span>
              <span className="font-semibold tabular-nums">{c.acked} of {c.impacted_people}</span>
            </div>
            <ProgressBar value={c.acked} max={c.impacted_people} label={`Acknowledged by ${c.acked} of ${c.impacted_people} impacted people`} tone={c.acked >= c.impacted_people ? "bg-success" : c.breaking ? "bg-warning" : "bg-info"} />
          </>
        ) : (
          <div className="text-ui-xs text-muted-foreground">No people impacted</div>
        )}
        {c.my_ack && <AckBadge status={c.my_ack} />}
      </div>
    </Card>
  );
}

export default function ChangesPage() {
  const [params, setParams] = useSearchParams();
  const assetId = params.get("asset_id");
  const breaking = params.get("breaking") === "true";
  const mine = params.get("mine") === "true";
  const days = params.get("days") ?? "90";
  const set = (k: string, v: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v === null) next.delete(k);
      else next.set(k, v);
      return next;
    });
  const q = useApi<ChangeSummary[]>(changesPath({ assetId, breaking, mine, days }));
  const rows = [...(q.data ?? [])].sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
  const assetName = rows.find((r) => r.asset_id === assetId)?.asset_display_name ?? assetId;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FileClock size={20} aria-hidden />}
        title="Changes & Impact"
        subtitle="Published versions, deprecations, policy and runtime changes across the registry. Open one for its impact report: who's affected, who acknowledged, and what moved before and after."
        source={<SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />}
      />
      <Card className="flex flex-wrap items-center gap-4 !p-3">
        <Toggle checked={breaking} onChange={(v) => set("breaking", v ? "true" : null)} label="Breaking only" />
        <Toggle checked={mine} onChange={(v) => set("mine", v ? "true" : null)} label="Affecting me" />
        <Select aria-label="Time window" value={days} onValueChange={(v) => set("days", v)} options={DAYS} wrapperClassName="w-40" />
        {assetId ? (
          <Badge variant="primary" className="!py-1">
            Asset: {assetName}
            <button type="button" aria-label="Clear asset filter" onClick={() => set("asset_id", null)} className="ml-1 rounded-full hover:text-foreground">
              <X size={12} aria-hidden />
            </button>
          </Badge>
        ) : (
          <AssetSearch className="min-w-[240px] flex-1" label="Filter by asset" placeholder="Filter by asset…" onPick={(h) => set("asset_id", h.id)} />
        )}
      </Card>
      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={5} className="[&>div]:h-24" />}
        isEmpty={() => rows.length === 0}
        empty={
          <EmptyState
            icon={<FileClock size={22} aria-hidden />}
            title="No changes in this window"
            description={breaking || mine || assetId ? "Clear a filter or widen the time window." : "When an owner publishes a version, or sync detects a change, it lands here with its impact."}
          />
        }
      >
        {() => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="space-y-3" aria-label="Changes">
            {rows.map((c) => (
              <motion.li key={c.change_id} variants={staggerItem}>
                <ChangeRow c={c} />
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AsyncBlock>
      {assetId && (
        <p className="text-ui-sm">
          <Link to={`/lineage?focus=${enc(assetId)}`} className="font-semibold text-primary hover:underline">Open {assetName} in Lineage</Link>
        </p>
      )}
    </div>
  );
}
