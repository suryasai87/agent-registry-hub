// Release feed tab: every item Platform Watch read from the subscribed feeds, scored against the capability
// catalog. Filter by minimum relevance and source; stewards and admins dismiss noise. Feed health (last fetch,
// status, item count) sits on the side.
import { motion } from "framer-motion";
import { CircleAlert, CircleCheck, EyeOff, ExternalLink, Newspaper, Rss, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, enc, useApi } from "../../lib/api";
import { entrance } from "../../lib/motion";
import type { Capability, FeedItem, FeedSource } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, EmptyState, Select } from "../ui";
import { useDebounced } from "../workspace/AssetSearch";
import { AsyncBlock, RowsSkeleton, useWrite } from "../workspace/feedback";
import { fmtDate, fmtDateTime, fmtRelative, humanize } from "../workspace/format";
import { FeedStatusPill, LifecycleChip, RelevanceBar } from "./chips";

/** Long lists: only the first rows stagger in (0.06 s apart); the rest arrive with the last of them. */
const STAGGER_CAP = 10;

export function feedPath(minRelevance: number, source: string): string {
  return `/api/platform-watch/feed?min_relevance=${minRelevance}${source ? `&source=${enc(source)}` : ""}`;
}

function SourceHealth({ sources }: { sources: FeedSource[] }) {
  return (
    <Card className="space-y-3 !p-4">
      <h3 className="flex items-center gap-2 text-ui-md font-bold">
        <Rss size={15} aria-hidden className="text-primary" /> Feed sources
      </h3>
      {sources.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">No feed sources are registered yet.</p>
      ) : (
        <ul className="space-y-3" aria-label="Feed source health">
          {sources.map((s) => {
            const failed = !!s.last_status && s.last_status.toLowerCase().startsWith("error");
            const never = !s.last_fetched_at;
            return (
              <li key={s.source_id} className="rounded-lg border border-border/80 bg-muted/30 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-ui-sm font-semibold hover:text-primary hover:underline">
                    <span className="truncate">{s.label}</span>
                    <ExternalLink size={11} aria-hidden className="shrink-0" />
                  </a>
                  {!s.enabled ? (
                    <Badge>Disabled</Badge>
                  ) : failed ? (
                    <Badge variant="destructive" icon={<CircleAlert size={11} aria-hidden />}>Fetch failed</Badge>
                  ) : never ? (
                    <Badge>Not fetched yet</Badge>
                  ) : (
                    <Badge variant="success" icon={<CircleCheck size={11} aria-hidden />}>Healthy</Badge>
                  )}
                </div>
                <div className="mt-1 text-ui-xs text-muted-foreground">
                  {s.publisher} · {s.kind.toUpperCase()} · {s.items_total.toLocaleString()} items
                </div>
                <div className="text-ui-xs text-muted-foreground" title={fmtDateTime(s.last_fetched_at)}>
                  Last fetched {never ? "never" : fmtRelative(s.last_fetched_at)}
                </div>
                {s.last_status && <p className={failed ? "mt-1 break-words font-mono text-ui-xs text-destructive" : "mt-1 break-words font-mono text-ui-xs text-muted-foreground"}>{s.last_status}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function FeedRow({ item, index, sourceLabel, capLabel, threshold, canDismiss, onDismissed }: {
  item: FeedItem;
  index: number;
  sourceLabel: (id: string) => string;
  capLabel: (key: string) => string;
  threshold: number;
  canDismiss: boolean;
  onDismissed: (id: number) => void;
}) {
  const { run, pending } = useWrite();
  const dismiss = async () => {
    const ok = await run("dismiss", "Couldn't dismiss the item", () => api.post<{ ok: boolean }>(`/api/platform-watch/feed/${item.item_id}/dismiss`), "Dismissed from the feed");
    if (ok) onDismissed(item.item_id);
  };
  const dismissed = item.status === "dismissed";
  return (
    <motion.li {...entrance} transition={{ ...entrance.transition, delay: Math.min(index, STAGGER_CAP) * 0.06 }} layout="position">
      <Card role="article" aria-label={item.title} className={dismissed ? "!p-4 opacity-60" : "!p-4"}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
              <span className="font-semibold text-foreground/90">{sourceLabel(item.source_id)}</span>
              {item.published_at && <span title={fmtDateTime(item.published_at)}>· {fmtDate(item.published_at)}</span>}
            </div>
            {item.link ? (
              <a href={item.link} target="_blank" rel="noreferrer" className="relative inline-flex items-start gap-1 text-ui-md font-bold leading-snug underline-offset-2 hover:text-primary hover:underline">
                {item.title}
                <ExternalLink size={13} aria-hidden className="mt-1 shrink-0" />
                <span className="sr-only">(opens the release note)</span>
              </a>
            ) : (
              <div className="text-ui-md font-bold leading-snug">{item.title}</div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <RelevanceBar value={item.relevance} threshold={threshold} />
            <FeedStatusPill status={item.status} />
          </div>
        </div>
        {item.summary && <p className="mt-2 line-clamp-2 text-ui-sm text-muted-foreground">{item.summary}</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <LifecycleChip hint={item.lifecycle_hint} />
          {item.breaking_hint && item.lifecycle_hint !== "breaking" && (
            <Badge variant="destructive" icon={<ShieldAlert size={11} aria-hidden />}>May break</Badge>
          )}
          {item.matched_capabilities.map((k) => (
            <Badge key={k} variant="mcp" title={k}>{capLabel(k)}</Badge>
          ))}
          {item.matched_terms.slice(0, 8).map((t) => (
            <span key={t} className="rounded-md bg-muted px-1.5 py-px font-mono text-ui-xs text-muted-foreground">{t}</span>
          ))}
          {item.matched_terms.length > 8 && <span className="text-ui-xs text-muted-foreground">+{item.matched_terms.length - 8} more</span>}
        </div>
        {(item.candidate_id != null || (canDismiss && !dismissed)) && (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2.5">
            {item.candidate_id != null && (
              <Link to={`/platform-updates?candidate=${item.candidate_id}#updates`} className="mr-auto text-ui-sm font-semibold text-primary hover:underline">
                View candidate #{item.candidate_id}
              </Link>
            )}
            {canDismiss && !dismissed && (
              <Button variant="ghost" size="sm" icon={<EyeOff size={13} aria-hidden />} loading={pending === "dismiss"} onClick={() => void dismiss()}>
                Dismiss
              </Button>
            )}
          </div>
        )}
      </Card>
    </motion.li>
  );
}

export default function FeedPanel({ defaultThreshold, sources, canDismiss }: { defaultThreshold: number; sources: FeedSource[]; canDismiss: boolean }) {
  const [threshold, setThreshold] = useState(defaultThreshold);
  const [source, setSource] = useState("");
  const debounced = useDebounced(threshold, 250);
  const q = useApi<FeedItem[]>(feedPath(debounced, source));
  const caps = useApi<Capability[]>("/api/platform-watch/capabilities");
  const sliderId = useId();
  const labels = useMemo(() => new Map(sources.map((s) => [s.source_id, s.label])), [sources]);
  const capLabels = useMemo(() => new Map((caps.data ?? []).map((c) => [c.capability_key, c.label])), [caps.data]);
  const sourceLabel = (id: string) => labels.get(id) ?? humanize(id);
  const capLabel = (key: string) => capLabels.get(key) ?? key;
  const markDismissed = (id: number) => q.mutate((prev) => (prev ?? []).map((i) => (i.item_id === id ? { ...i, status: "dismissed" } : i)));
  const options = [{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s.source_id, label: s.label }))];

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-label="Release feed" className="min-w-0 space-y-4">
        <Card className="flex flex-wrap items-end gap-x-6 gap-y-3 !p-4">
          <div className="min-w-[240px] flex-1">
            <div className="flex items-center gap-2">
              <label htmlFor={sliderId} className="flex items-center gap-2 text-ui-sm font-semibold">
                <SlidersHorizontal size={14} aria-hidden className="text-muted-foreground" />
                Minimum relevance
              </label>
              <output htmlFor={sliderId} aria-hidden className="ml-auto rounded-md bg-muted px-1.5 font-mono text-ui-sm tabular-nums">{threshold}</output>
            </div>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              aria-valuetext={`${threshold} of 100`}
              className="mt-2 w-full accent-[hsl(var(--primary))]"
            />
            <p className="mt-1 text-ui-xs text-muted-foreground">
              Advisories are created at {defaultThreshold} and above (the relevance threshold setting).
              {threshold !== defaultThreshold && (
                <button type="button" className="ml-1.5 font-semibold text-primary hover:underline" onClick={() => setThreshold(defaultThreshold)}>
                  Reset
                </button>
              )}
            </p>
          </div>
          <Select label="Source" options={options} value={source} onValueChange={setSource} wrapperClassName="w-64" />
          <div className="flex items-center gap-2 pb-1.5">
            <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
            {q.data && <span className="text-ui-sm text-muted-foreground" aria-live="polite">{q.data.length.toLocaleString()} items</span>}
          </div>
        </Card>
        <AsyncBlock
          state={q}
          errorTitle="Couldn't load the release feed"
          skeleton={<RowsSkeleton rows={6} />}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              icon={<Newspaper size={22} aria-hidden />}
              title="No feed items at this relevance"
              description={threshold > 0 ? "Lower the minimum relevance or pick another source." : "Platform Watch hasn't fetched any release notes yet. Run it from the page header."}
            />
          }
        >
          {(items) => (
            <ul key={`${debounced}|${source}`} className="space-y-3" aria-label="Feed items">
              {items.map((it, i) => (
                <FeedRow key={it.item_id} item={it} index={i} sourceLabel={sourceLabel} capLabel={capLabel} threshold={defaultThreshold} canDismiss={canDismiss} onDismissed={markDismissed} />
              ))}
            </ul>
          )}
        </AsyncBlock>
      </section>
      <aside className="min-w-0">
        <SourceHealth sources={sources} />
      </aside>
    </div>
  );
}
