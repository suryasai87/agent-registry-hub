// Catalog (benchmark §3.4): one typed catalog with URL-synced filters. Type tabs, a facet rail with server
// counts, quick chips, a debounced search, sort, grid/list + compact density (persisted), pagination, skeletons,
// an empty state with "Clear filters", and quick actions (subscribe / request access) on every card.
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, LayoutGrid, List, Rows3, Search, SearchX, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AssetCard from "../components/asset/AssetCard";
import AssetTable from "../components/asset/AssetRow";
import { FACET_LABELS, TYPE_PLURAL } from "../components/asset/meta";
import { ErrorCard, Segmented } from "../components/asset/primitives";
import useCardActions from "../components/asset/useCardActions";
import SourcePill from "../components/SourcePill";
import { Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Tabs } from "../components/ui";
import { useApi } from "../lib/api";
import { cx } from "../lib/cx";
import { stagger } from "../lib/motion";
import { readStored, writeStored } from "../lib/storage";
import type { AssetCard as Card_, AssetType, CatalogPage } from "../lib/types";

export const VIEW_KEY = "arh.catalog.view";
export const DENSITY_KEY = "arh.catalog.density";
export const PAGE_SIZE = 24;

type FacetKey = Exclude<keyof CatalogPage["facets"], "asset_type">;

/** Facet → URL/API parameter (the contract's query names). */
export const FACET_PARAM: Record<FacetKey, string> = {
  source: "source",
  platform: "platform",
  lifecycle_status: "status",
  certification: "certification",
  sensitivity: "sensitivity",
  risk_tier: "risk",
};
const FACET_TITLE: Record<FacetKey, string> = { source: "Source", platform: "Platform", lifecycle_status: "Status", certification: "Certification", sensitivity: "Sensitivity", risk_tier: "Risk" };
const FACET_ORDER: FacetKey[] = ["source", "platform", "lifecycle_status", "certification", "sensitivity", "risk_tier"];

export const QUICK_CHIPS: { id: string; label: string; param: string; value: string }[] = [
  { id: "mine", label: "Mine", param: "owner", value: "me" },
  { id: "subscribed", label: "Subscribed", param: "rel", value: "subscribed" },
  { id: "access", label: "Has access", param: "rel", value: "access" },
  { id: "requested", label: "Requested", param: "rel", value: "requested" },
  { id: "certified", label: "Certified", param: "certification", value: "certified" },
  { id: "changed", label: "Recently changed", param: "changed_days", value: "7" },
  { id: "ownerless", label: "Ownerless", param: "ownerless", value: "true" },
];

const TYPE_TABS: { id: "" | AssetType; label: string }[] = [
  { id: "", label: "All" },
  { id: "agent", label: TYPE_PLURAL.agent },
  { id: "mcp_server", label: TYPE_PLURAL.mcp_server },
  { id: "tool", label: TYPE_PLURAL.tool },
  { id: "skill", label: TYPE_PLURAL.skill },
];

const SORTS = [
  { value: "relevance", label: "Relevance" },
  { value: "requests", label: "Most requests (30 d)" },
  { value: "cost", label: "Highest cost (30 d)" },
  { value: "changed", label: "Recently changed" },
  { value: "name", label: "Name (A–Z)" },
];

/** URL params forwarded to GET /api/catalog. */
const API_KEYS = ["type", "q", "source", "platform", "status", "certification", "sensitivity", "risk", "owner", "tag", "rel", "changed_days", "ownerless", "sort", "page"];
const FILTER_KEYS = API_KEYS.filter((k) => k !== "sort" && k !== "page");

export function catalogApiPath(search: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of API_KEYS) {
    const v = search.get(k);
    if (v) out.set(k, v);
  }
  out.set("page_size", String(PAGE_SIZE));
  return `/api/catalog?${out.toString()}`;
}

function multi(search: URLSearchParams, param: string): string[] {
  return (search.get(param) ?? "").split(",").filter(Boolean);
}

function FacetGroup({ facet, counts, selected, onToggle }: { facet: FacetKey; counts: Record<string, number>; selected: string[]; onToggle: (value: string, on: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const values = useMemo(() => {
    const keys = new Set([...Object.keys(counts), ...selected]);
    return [...keys].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  }, [counts, selected]);
  if (values.length === 0) return null;
  const shown = expanded ? values : values.slice(0, 6);
  const label = FACET_LABELS[facet] ?? ((v: string) => v);
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">{FACET_TITLE[facet]}</legend>
      {shown.map((v) => {
        const checked = selected.includes(v);
        const n = counts[v] ?? 0;
        return (
          <label key={v} className={cx("flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm hover:bg-accent", checked && "bg-primary/10 text-foreground")}>
            <input type="checkbox" className="accent-primary" checked={checked} onChange={(e) => onToggle(v, e.target.checked)} />
            <span className="min-w-0 flex-1 truncate">{label(v)}</span>
            <span className="tabular-nums text-ui-xs text-muted-foreground" aria-label={`${n} assets`}>
              {n}
            </span>
          </label>
        );
      })}
      {values.length > 6 && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="px-1.5 text-ui-xs font-semibold text-primary hover:underline">
          {expanded ? "Show less" : `Show ${values.length - 6} more`}
        </button>
      )}
    </fieldset>
  );
}

function CardSkeletons({ count = 8, list = false }: { count?: number; list?: boolean }) {
  if (list)
    return (
      <div aria-busy="true" aria-label="Loading assets" className="space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  return (
    <div aria-busy="true" aria-label="Loading assets" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="space-y-3 !p-4">
          <div className="flex gap-3">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-6 w-full" />
        </Card>
      ))}
    </div>
  );
}

export default function Catalog() {
  const [search, setSearch] = useSearchParams();
  const [view, setView] = useState<"grid" | "list">(() => (readStored(VIEW_KEY) === "list" ? "list" : "grid"));
  const [compact, setCompact] = useState(() => readStored(DENSITY_KEY) === "compact");
  const [q, setQ] = useState(() => search.get("q") ?? "");
  const [railOpen, setRailOpen] = useState(false);
  const path = catalogApiPath(search);
  const catalog = useApi<CatalogPage>(path);

  useEffect(() => {
    writeStored(VIEW_KEY, view);
  }, [view]);
  useEffect(() => {
    writeStored(DENSITY_KEY, compact ? "compact" : "normal");
  }, [compact]);

  /** Update URL params (null/"" deletes), resetting to page 1 unless the page itself changes. */
  const update = useCallback(
    (changes: Record<string, string | null>, opts: { replace?: boolean } = {}) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          if (!("page" in changes)) next.delete("page");
          return next;
        },
        { replace: opts.replace },
      );
    },
    [setSearch],
  );

  // Debounced search → ?q=
  const urlQ = search.get("q") ?? "";
  useEffect(() => {
    if (q.trim() === urlQ) return;
    const t = setTimeout(() => update({ q: q.trim() || null }, { replace: true }), 300);
    return () => {
      clearTimeout(t);
    };
  }, [q, urlQ, update]);
  // External URL changes (clear filters, back button) → the input.
  useEffect(() => {
    setQ((cur) => (cur.trim() === urlQ ? cur : urlQ));
  }, [urlQ]);

  const { dialogs, subscribe, requestAccess } = useCardActions((assetId, fn) =>
    catalog.mutate((prev) => (prev ? { ...prev, items: prev.items.map((c) => (c.asset_id === assetId ? fn(c) : c)) } : (prev as unknown as CatalogPage))),
  );

  const data = catalog.data;
  const type = (search.get("type") ?? "") as "" | AssetType;
  const page = Math.max(1, Number(search.get("page") ?? 1) || 1);
  const pages = data ? Math.max(1, Math.ceil(data.total / (data.page_size || PAGE_SIZE))) : 1;
  const active = FILTER_KEYS.filter((k) => k !== "type" && search.get(k));
  const typeCounts = data?.facets.asset_type ?? {};
  const allCount = Object.values(typeCounts).reduce((a, b) => a + b, 0);

  const toggleFacet = (facet: FacetKey, value: string, on: boolean) => {
    const param = FACET_PARAM[facet];
    const cur = multi(search, param);
    const next = on ? [...new Set([...cur, value])] : cur.filter((v) => v !== value);
    update({ [param]: next.join(",") || null });
  };
  const chipActive = (c: (typeof QUICK_CHIPS)[number]) => search.get(c.param) === c.value;
  const toggleChip = (c: (typeof QUICK_CHIPS)[number]) => update({ [c.param]: chipActive(c) ? null : c.value });
  const clearAll = () => {
    setQ("");
    setSearch(type ? new URLSearchParams({ type }) : new URLSearchParams());
  };

  const tabs = TYPE_TABS.map((t) => ({
    id: t.id || "all",
    label: t.label,
    badge: data ? <span className="rounded-full bg-muted px-1.5 text-ui-xs tabular-nums text-muted-foreground">{t.id ? typeCounts[t.id] ?? 0 : allCount}</span> : undefined,
  }));

  const rail = (
    <div className="space-y-5">
      {data ? (
        FACET_ORDER.map((f) => <FacetGroup key={f} facet={f} counts={data.facets[f] ?? {}} selected={multi(search, FACET_PARAM[f])} onToggle={(v, on) => toggleFacet(f, v, on)} />)
      ) : (
        <div aria-busy="true" className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Catalog"
        subtitle="Every agent, MCP server, tool and skill in the workspace: who owns it, who uses it, what it costs and how it is governed."
        source={<SourcePill source={catalog.source} degradedReason={catalog.degradedReason} asOf={catalog.asOf} />}
      />

      <Tabs tabs={tabs} value={type || "all"} syncHash={false} onChange={(id) => update({ type: id === "all" ? null : id })} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search the catalog"
          type="search"
          icon={<Search size={15} aria-hidden />}
          placeholder="Search by name, purpose or URN"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="min-w-[240px] flex-1 max-w-xl"
        />
        <Button variant="secondary" className="lg:hidden" icon={<SlidersHorizontal size={15} aria-hidden />} aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)}>
          Filters{active.length ? ` (${active.length})` : ""}
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select aria-label="Sort" value={search.get("sort") ?? "relevance"} onValueChange={(v) => update({ sort: v === "relevance" ? null : v })} options={SORTS} wrapperClassName="w-52" />
          <Segmented
            label="Layout"
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: <span className="sr-only">Grid</span>, icon: <LayoutGrid size={14} aria-hidden />, title: "Grid view" },
              { value: "list", label: <span className="sr-only">List</span>, icon: <List size={14} aria-hidden />, title: "List view" },
            ]}
          />
          <Button variant={compact ? "primary" : "secondary"} size="sm" aria-pressed={compact} icon={<Rows3 size={14} aria-hidden />} onClick={() => setCompact((c) => !c)}>
            Compact
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick filters">
        {QUICK_CHIPS.map((c) => {
          const on = chipActive(c);
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggleChip(c)}
              className={cx("inline-flex h-7 items-center gap-1 rounded-full border px-3 text-ui-sm font-medium transition-colors", on ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground")}
            >
              {c.label}
              {on && <X size={12} aria-hidden />}
            </button>
          );
        })}
        {active.length > 0 && (
          <Button size="sm" variant="ghost" onClick={clearAll} icon={<X size={13} aria-hidden />}>
            Clear filters
          </Button>
        )}
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Filters" className={cx("lg:block", railOpen ? "block" : "hidden")}>
          <div className="lg:sticky lg:top-0">{rail}</div>
        </aside>

        <section aria-label="Results" aria-busy={catalog.loading || undefined} className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2 text-ui-sm text-muted-foreground">
            <span role="status" aria-live="polite">
              {data ? `${data.total.toLocaleString()} asset${data.total === 1 ? "" : "s"}${search.get("q") ? ` matching “${search.get("q")}”` : ""}` : "Loading…"}
            </span>
            {catalog.loading && data && <span className="text-ui-xs">Updating…</span>}
          </div>

          {catalog.error && !data ? (
            <ErrorCard error={catalog.error} onRetry={catalog.reload} title="Couldn't load the catalog" />
          ) : !data ? (
            <CardSkeletons list={view === "list"} />
          ) : data.items.length === 0 ? (
            <EmptyState
              icon={<SearchX size={22} aria-hidden />}
              title="No assets match these filters"
              description="Try a broader search, or clear the filters to see the whole catalog."
              action={
                active.length > 0 || type ? (
                  <Button
                    onClick={() => {
                      setQ("");
                      setSearch(new URLSearchParams());
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : view === "list" ? (
            <AssetTable items={data.items} compact={compact} onSubscribe={subscribe} onRequestAccess={requestAccess} />
          ) : (
            <motion.div key={path} variants={stagger} initial="hidden" animate="show" className={cx("grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4", compact ? "gap-3" : "gap-4", catalog.loading && "opacity-70 transition-opacity")}>
              {data.items.map((card: Card_) => (
                <AssetCard key={card.asset_id} card={card} compact={compact} onSubscribe={subscribe} onRequestAccess={requestAccess} />
              ))}
            </motion.div>
          )}

          {data && data.total > (data.page_size || PAGE_SIZE) && (
            <nav aria-label="Pagination" className="mt-6 flex items-center justify-between gap-3 text-ui-sm text-muted-foreground">
              <span>
                {((page - 1) * (data.page_size || PAGE_SIZE) + 1).toLocaleString()}–{Math.min(page * (data.page_size || PAGE_SIZE), data.total).toLocaleString()} of {data.total.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} icon={<ChevronLeft size={14} aria-hidden />} onClick={() => update({ page: page - 1 > 1 ? String(page - 1) : null })}>
                  Previous
                </Button>
                <span aria-current="page">
                  Page {page} of {pages}
                </span>
                <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>
                  Next <ChevronRight size={14} aria-hidden />
                </Button>
              </div>
            </nav>
          )}
        </section>
      </div>
      {dialogs}
    </div>
  );
}
