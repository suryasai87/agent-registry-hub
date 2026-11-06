// Changes: the version timeline (breaking flag, kinds, published by, effective date → /changes/<id>), the version
// list, and for owners the full-panel PublishChangeFlow (also opened by ?publish=1).
import { motion } from "framer-motion";
import { FileClock, Rocket } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAsset } from "../../components/asset/AssetContext";
import { ChangeEntry } from "../../components/asset/ChangeEntry";
import { fmtDate } from "../../components/asset/format";
import { humanize } from "../../components/asset/meta";
import { ErrorCard, SectionSkeleton } from "../../components/asset/primitives";
import PublishChangeFlow from "../../components/asset/PublishChangeFlow";
import SourcePill from "../../components/SourcePill";
import { Badge, Button, Card, EmptyState, SectionTitle } from "../../components/ui";
import { useApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import { stagger, staggerItem } from "../../lib/motion";
import type { ChangeSummary } from "../../lib/types";

export default function ChangesTab() {
  const { detail, assetId, refreshKey, reload } = useAsset();
  const [search, setSearch] = useSearchParams();
  const changes = useApi<ChangeSummary[]>(`/api/changes?asset_id=${encodeURIComponent(assetId)}`, [refreshKey]);
  const p = detail.permissions;
  const publishing = p.can_publish && search.get("publish") === "1";
  const setPublishing = (on: boolean) => {
    const next = new URLSearchParams(search);
    if (on) next.set("publish", "1");
    else next.delete("publish");
    setSearch(next, { replace: true });
  };

  if (publishing) return <PublishChangeFlow asset={detail.asset} onCancel={() => setPublishing(false)} onPublished={() => reload()} />;

  const list = [...(changes.data ?? [])].sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="min-w-0 space-y-3" aria-label="Version timeline">
        <SectionTitle
          title="Changes & impact"
          subtitle="Every published version, deprecation and policy change, and who it reached."
          actions={
            <>
              <SourcePill source={changes.source} degradedReason={changes.degradedReason} asOf={changes.asOf} />
              {p.can_publish && (
                <Button size="sm" icon={<Rocket size={13} aria-hidden />} onClick={() => setPublishing(true)}>
                  Publish a change
                </Button>
              )}
            </>
          }
        />
        {changes.error && !changes.data ? (
          <ErrorCard error={changes.error} onRetry={changes.reload} />
        ) : !changes.data ? (
          <SectionSkeleton blocks={2} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<FileClock size={20} aria-hidden />}
            title="No changes published yet"
            description={p.can_publish ? "Publish a change to tell subscribers and downstream owners what is coming, with an impact preview first." : "When the owner publishes a change, it appears here with its impact report."}
            action={
              p.can_publish ? (
                <Button icon={<Rocket size={15} aria-hidden />} onClick={() => setPublishing(true)}>
                  Publish a change
                </Button>
              ) : undefined
            }
          />
        ) : (
          <motion.ol variants={stagger} initial="hidden" animate="show" className="relative space-y-3 border-l border-border pl-5">
            {list.map((c) => (
              <motion.li key={c.change_id} variants={staggerItem} className="relative">
                <span aria-hidden className={cx("absolute -left-[27px] top-5 h-3 w-3 rounded-full ring-4 ring-background", c.breaking ? "bg-destructive" : "bg-primary")} />
                <ChangeEntry c={c} />
              </motion.li>
            ))}
          </motion.ol>
        )}
      </section>
      <Card className="h-fit space-y-3">
        <h3 className="text-ui-md font-bold">Versions</h3>
        {detail.versions.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">No versions recorded.</p>
        ) : (
          <ul className="space-y-2">
            {detail.versions.map((v) => (
              <li key={`${v.version}-${v.created_at}`} className="flex flex-wrap items-center gap-2 text-ui-sm">
                <span className="font-mono font-semibold">{v.version}</span>
                <Badge variant={v.status === "published" ? "success" : v.status === "draft" ? "info" : "neutral"}>{humanize(v.status)}</Badge>
                <span className="ml-auto text-ui-xs text-muted-foreground">
                  {fmtDate(v.created_at)} · {v.created_by ?? humanize(v.source)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
