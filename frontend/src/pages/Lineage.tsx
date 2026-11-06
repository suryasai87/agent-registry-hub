// Lineage explorer: focus an asset, step the depth (1–4), pick a direction and edge kinds, highlight a change's
// impact. All of it lives in the URL (/lineage?focus=…&depth=2&dir=both&kinds=declared,observed&change_id=7&view=table).
// Stewards, admins and auditors get a shortcut to Governance › Unity Catalog lineage (publish these edges to UC).
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, CloudUpload, GitBranch, Minus, Network, Plus, Table2, TriangleAlert, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import LineageGraph from "../components/lineage/LineageGraph";
import { LineageDetails, LineageLegend, LineageTable } from "../components/lineage/LineageParts";
import { nodeMeta } from "../components/lineage/meta";
import { summarize } from "../components/lineage/model";
import SourcePill from "../components/SourcePill";
import { Badge, Button, Card, EmptyState, ENTITY_TYPES, PageHeader, SectionTitle, Skeleton } from "../components/ui";
import AssetSearch from "../components/workspace/AssetSearch";
import { ENTITY_OF } from "../components/workspace/chips";
import { ErrorCard, LiveRegion } from "../components/workspace/feedback";
import { enc, useApi } from "../lib/api";
import { fmtNum } from "../lib/assets";
import { cx } from "../lib/cx";
import { settle, stagger, staggerItem } from "../lib/motion";
import { useSession } from "../lib/session";
import type { ChangeDetail, FleetUsage, LineageGraph as Graph, LineageNode } from "../lib/types";

type Dir = "up" | "down" | "both";
type Kind = "declared" | "observed" | "data";
const ALL_KINDS: Kind[] = ["declared", "observed", "data"];
const DIRS: { id: Dir; label: string; hint: string }[] = [
  { id: "up", label: "Upstream", hint: "What the focus depends on" },
  { id: "both", label: "Both", hint: "Dependencies and consumers" },
  { id: "down", label: "Downstream", hint: "What depends on the focus" },
];
const KIND_LABEL: Record<Kind, string> = { declared: "Declared", observed: "Observed", data: "Data" };

function readKinds(raw: string | null): Kind[] {
  if (!raw) return ALL_KINDS;
  const ks = raw.split(",").filter((k): k is Kind => (ALL_KINDS as string[]).includes(k));
  return ks.length ? ks : ALL_KINDS;
}

function StartState({ onPick }: { onPick: (id: string) => void }) {
  const usage = useApi<FleetUsage>("/api/usage-cost?days=30");
  const suggestions = useMemo(() => {
    const top = usage.data?.top_assets ?? [];
    const order = { agent: 0, mcp_server: 1, skill: 2, tool: 3 } as const;
    return [...top].sort((a, b) => order[a.asset_type] - order[b.asset_type] || b.requests - a.requests).slice(0, 6);
  }, [usage.data]);
  return (
    <div className="space-y-5">
      <EmptyState
        icon={<Network size={22} aria-hidden />}
        title="Pick an asset to explore its lineage"
        description="Search above, or start from one of the most-used assets below. You'll see what it depends on (left), what uses it (right), and which edges were declared, observed in traffic, or come from Unity Catalog data lineage."
      />
      <section aria-labelledby="lineage-suggest">
        <SectionTitle id="lineage-suggest" title="Suggested focuses" subtitle="The most-requested assets in the last 30 days" />
        {usage.data === null && !usage.error ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        ) : usage.error && !usage.data ? (
          <ErrorCard error={usage.error} onRetry={usage.reload} title="Couldn't load suggestions" />
        ) : suggestions.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">No usage recorded yet. Use the search to pick a focus.</p>
        ) : (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {suggestions.map((s) => {
              const Icon = ENTITY_TYPES[ENTITY_OF[s.asset_type]].icon;
              return (
                <motion.li key={s.asset_id} variants={staggerItem}>
                  <button
                    type="button"
                    onClick={() => onPick(s.asset_id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg"
                  >
                    <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-lg", nodeMeta(s.asset_type).tile)}>
                      <Icon size={18} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-md font-bold">{s.display_name}</span>
                      <span className="block text-ui-xs text-muted-foreground">{nodeMeta(s.asset_type).label} · {fmtNum(s.requests)} requests · {fmtNum(s.users)} users</span>
                    </span>
                    <ChevronRight size={16} aria-hidden className="text-muted-foreground" />
                  </button>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </section>
    </div>
  );
}

export default function LineagePage() {
  const [params, setParams] = useSearchParams();
  const focus = params.get("focus");
  const depth = Math.max(1, Math.min(4, Number(params.get("depth")) || 1));
  const dir = (["up", "down", "both"].includes(params.get("dir") ?? "") ? params.get("dir") : "both") as Dir;
  const kinds = readKinds(params.get("kinds"));
  const changeId = params.get("change_id");
  const view = params.get("view") === "table" ? "table" : "graph";
  const [trail, setTrail] = useState<{ id: string; label: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  const path = focus
    ? `/api/lineage?focus=${enc(focus)}&depth=${depth}&dir=${dir}&kinds=${kinds.join(",")}${changeId ? `&change_id=${enc(changeId)}` : ""}`
    : null;
  const q = useApi<Graph>(path);
  const change = useApi<ChangeDetail>(changeId ? `/api/changes/${enc(changeId)}` : null);
  const graph = q.data && q.data.focus === focus ? q.data : null;
  const impactMode = !!changeId;
  const focusNode = graph?.nodes.find((n) => n.focus) ?? null;
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  useEffect(() => {
    setSelectedId(null);
  }, [focus]);

  const refocus = useCallback(
    (node: LineageNode) => {
      if (node.restricted || node.id === focus) return;
      if (focus) setTrail((t) => [...t.filter((c) => c.id !== focus), { id: focus, label: focusNode?.label ?? focus }].slice(-6));
      update({ focus: node.id });
    },
    [focus, focusNode, update],
  );

  const pickFocus = (id: string) => {
    setTrail([]);
    update({ focus: id });
  };

  const summary = graph ? summarize(graph, { impactMode, focusLabel: focusNode?.label }) : "";
  const governs = useSession().hasRole("steward", "admin", "auditor");
  const types = graph ? [...new Set(graph.nodes.map((n) => n.type))] : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<GitBranch size={20} aria-hidden />}
        title="Lineage"
        subtitle="What every agent, MCP server, tool and skill depends on and who uses it: declared in configuration, observed in gateway traffic, and from Unity Catalog data lineage."
        source={focus ? <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} /> : undefined}
        actions={governs ? (
          <Link to="/governance#uc-lineage" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
            <CloudUpload size={14} aria-hidden /> Publish to Unity Catalog
          </Link>
        ) : undefined}
      />

      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-3">
          <AssetSearch className="min-w-[240px] flex-1" label="Focus asset" placeholder={focus ? "Change focus…" : "Search for an asset to focus"} onPick={(h) => pickFocus(h.id)} />
          <div role="group" aria-label="Depth" className="flex items-center gap-1 rounded-lg border border-border bg-background/60 p-0.5">
            <Button size="sm" variant="ghost" aria-label="Decrease depth" disabled={depth <= 1} onClick={() => update({ depth: String(depth - 1) })} icon={<Minus size={13} aria-hidden />} />
            <span className="min-w-[64px] text-center text-ui-sm font-semibold" aria-live="polite">Depth {depth}</span>
            <Button size="sm" variant="ghost" aria-label="Increase depth" disabled={depth >= 4} onClick={() => update({ depth: String(depth + 1) })} icon={<Plus size={13} aria-hidden />} />
          </div>
          <div role="radiogroup" aria-label="Direction" className="flex rounded-lg border border-border bg-background/60 p-0.5">
            {DIRS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={dir === d.id}
                title={d.hint}
                onClick={() => update({ dir: d.id === "both" ? null : d.id })}
                className={cx("rounded-md px-2.5 py-1 text-ui-sm font-semibold transition-colors", dir === d.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Edge kinds" className="flex gap-1">
            {ALL_KINDS.map((k) => {
              const on = kinds.includes(k);
              const last = on && kinds.length === 1;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  disabled={last}
                  title={last ? "At least one edge kind stays on" : undefined}
                  onClick={() => {
                    const next = on ? kinds.filter((x) => x !== k) : [...kinds, k];
                    update({ kinds: next.length === ALL_KINDS.length ? null : ALL_KINDS.filter((x) => next.includes(x)).join(",") });
                  }}
                  className={cx(
                    "rounded-full border px-2.5 py-1 text-ui-sm font-semibold transition-colors disabled:cursor-not-allowed",
                    on ? "border-primary/50 bg-primary/12 text-foreground" : "border-border text-muted-foreground line-through hover:text-foreground",
                  )}
                >
                  {KIND_LABEL[k]}
                </button>
              );
            })}
          </div>
          <div role="radiogroup" aria-label="View" className="ml-auto flex rounded-lg border border-border bg-background/60 p-0.5">
            {(["graph", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => update({ view: v === "graph" ? null : v })}
                className={cx("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui-sm font-semibold", view === v ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {v === "graph" ? <Network size={13} aria-hidden /> : <Table2 size={13} aria-hidden />}
                {v === "graph" ? "Graph" : "Table view"}
              </button>
            ))}
          </div>
        </div>
        {(changeId || trail.length > 0 || focusNode) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-ui-sm">
            {(trail.length > 0 || focusNode) && (
              <nav aria-label="Focus history" className="flex min-w-0 flex-wrap items-center gap-1">
                {trail.map((c, i) => (
                  <span key={c.id} className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setTrail((t) => t.slice(0, i));
                        update({ focus: c.id });
                      }}
                      className="max-w-[200px] truncate rounded px-1 text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {c.label}
                    </button>
                    <ChevronRight size={13} aria-hidden className="text-muted-foreground" />
                  </span>
                ))}
                {focusNode && <span aria-current="location" className="max-w-[260px] truncate font-semibold">{focusNode.label}</span>}
              </nav>
            )}
            {changeId && (
              <Badge variant="primary" icon={<Zap size={12} aria-hidden />} className="ml-auto">
                Impact of{" "}
                <Link to={`/changes/${enc(changeId)}`} className="underline underline-offset-2">
                  {change.data ? change.data.change.title : `change #${changeId}`}
                </Link>
                <button type="button" aria-label="Clear impact highlight" onClick={() => update({ change_id: null })} className="ml-1 rounded-full hover:text-foreground">
                  <X size={12} aria-hidden />
                </button>
              </Badge>
            )}
          </div>
        )}
      </Card>

      <LiveRegion>{summary}</LiveRegion>

      {!focus ? (
        <StartState onPick={pickFocus} />
      ) : !graph ? (
        q.error ? <ErrorCard error={q.error} onRetry={q.reload} title="Couldn't load the lineage" /> : <Skeleton className="h-[620px] w-full rounded-xl" />
      ) : (
        <>
          {graph.truncated && (
            <div role="status" className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm">
              <TriangleAlert size={15} aria-hidden className="text-warning" />
              This view was truncated at the node cap. Lower the depth, pick one direction or fewer edge kinds to see everything.
            </div>
          )}
          {graph.nodes.length <= 1 && graph.edges.length === 0 ? (
            <EmptyState
              icon={<Network size={22} aria-hidden />}
              title={`No lineage recorded for ${focusNode?.label ?? focus}`}
              description="No declared dependencies, observed traffic or data lineage within this depth and these edge kinds. Try depth 2, both directions, or all edge kinds."
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-2">
                <p className="text-ui-sm text-muted-foreground" aria-hidden>{summary}</p>
                {view === "table" ? (
                  <LineageTable graph={graph} impactMode={impactMode} onSelect={(n) => setSelectedId(n.id)} />
                ) : (
                  <LineageGraph graph={graph} impactMode={impactMode} selectedId={selectedId} onSelect={(n) => setSelectedId(n.id)} onFocus={refocus} height={640} />
                )}
              </div>
              <aside aria-label={selected ? "Node details" : "Legend"} className="min-w-0">
                <AnimatePresence mode="wait">
                  {selected ? (
                    <motion.div key={selected.id} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={settle}>
                      <Card className="h-full">
                        <LineageDetails node={selected} graph={graph} onFocus={refocus} onClose={() => setSelectedId(null)} />
                      </Card>
                    </motion.div>
                  ) : (
                    <motion.div key="legend" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                      <Card>
                        <SectionTitle title="Legend" subtitle="Click a node for details; double-click (or F) to re-centre." />
                        <LineageLegend types={types} />
                      </Card>
                    </motion.div>
                  )}
                </AnimatePresence>
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}
