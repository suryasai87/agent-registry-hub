// Lineage: a compact one-hop graph centred on this asset, an accessible table alternative (Direction, Type, Name,
// Edge kind, Last seen), a details card for the selected node, and "Open full graph".
import { ArrowDownRight, ArrowUpLeft, GitBranch, Lock, Network, Table2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAsset } from "../../components/asset/AssetContext";
import { PolicyShield, TrustBadge } from "../../components/asset/badges";
import { fmtDateTime } from "../../components/asset/format";
import { humanize } from "../../components/asset/meta";
import { DataTable, DefinitionList, ErrorCard, SectionSkeleton, Segmented, Td, Th } from "../../components/asset/primitives";
import LineageGraph from "../../components/lineage/LineageGraph";
import SourcePill from "../../components/SourcePill";
import { Badge, Card, EmptyState, SectionTitle } from "../../components/ui";
import { useApi } from "../../lib/api";
import { assetHref } from "../../lib/assets";
import type { LineageEdge, LineageGraph as Graph, LineageNode } from "../../lib/types";

const ASSET_TYPES = new Set(["agent", "mcp_server", "tool", "skill"]);
const EDGE_KIND: Record<LineageEdge["edge_kind"], { label: string; style: string }> = {
  declared: { label: "Declared", style: "border-dashed" },
  observed: { label: "Observed", style: "border-solid" },
  data: { label: "Data", style: "border-dotted" },
};

export interface LineageRow {
  key: string;
  direction: "Upstream" | "Downstream";
  node: LineageNode;
  edge: LineageEdge;
}

/** One row per edge touching the focus: Upstream = the neighbour feeds/calls into the focus. */
export function lineageRows(graph: Graph, focus: string): LineageRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.src === focus || e.dst === focus)
    .map((e) => {
      const downstream = e.src === focus;
      const other = byId.get(downstream ? e.dst : e.src) ?? { id: downstream ? e.dst : e.src, type: "external" as const, label: downstream ? e.dst : e.src };
      return { key: `${e.src}->${e.dst}:${e.relation}`, direction: downstream ? ("Downstream" as const) : ("Upstream" as const), node: other, edge: e };
    })
    .sort((a, b) => a.direction.localeCompare(b.direction) || a.node.label.localeCompare(b.node.label));
}

export default function LineageTab() {
  const { assetId, refreshKey } = useAsset();
  const lineage = useApi<Graph>(`/api/lineage?focus=${encodeURIComponent(assetId)}&depth=1&dir=both`, [refreshKey]);
  const [view, setView] = useState<"graph" | "table">("graph");
  const [selected, setSelected] = useState<LineageNode | null>(null);

  if (lineage.error && !lineage.data) return <ErrorCard error={lineage.error} onRetry={lineage.reload} />;
  if (!lineage.data) return <SectionSkeleton blocks={2} />;
  const graph = lineage.data;
  const rows = lineageRows(graph, assetId);
  const up = rows.filter((r) => r.direction === "Upstream").length;
  const undeclared = rows.filter((r) => r.edge.undeclared).length;
  const fullHref = `/lineage?focus=${encodeURIComponent(assetId)}`;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Lineage"
        subtitle={`${rows.length} direct connection${rows.length === 1 ? "" : "s"}: ${up} upstream, ${rows.length - up} downstream${undeclared ? ` · ${undeclared} undeclared (observed but not declared)` : ""}.`}
        actions={
          <>
            <SourcePill source={lineage.source} degradedReason={lineage.degradedReason} asOf={lineage.asOf} />
            <Segmented
              label="Lineage view"
              value={view}
              onChange={setView}
              options={[
                { value: "graph", label: "Graph", icon: <Network size={12} aria-hidden /> },
                { value: "table", label: "Table", icon: <Table2 size={12} aria-hidden /> },
              ]}
            />
            <Link to={fullHref} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
              <GitBranch size={13} aria-hidden /> Open full graph
            </Link>
          </>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={<GitBranch size={20} aria-hidden />} title="No lineage recorded" description="Declared dependencies, observed calls (Unity Gateway usage) and UC data lineage appear here after the next sync." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            {view === "graph" ? (
              <Card className="overflow-hidden !p-0">
                <LineageGraph compact graph={graph} height={420} selectedId={selected?.id ?? null} onSelect={setSelected} />
              </Card>
            ) : (
              <DataTable label="Lineage connections">
                <thead>
                  <tr>
                    <Th>Direction</Th>
                    <Th>Type</Th>
                    <Th>Name</Th>
                    <Th>Edge kind</Th>
                    <Th>Relation</Th>
                    <Th align="right">Calls · 30 d</Th>
                    <Th>Last seen</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="hover:bg-accent/40">
                      <Td className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {r.direction === "Upstream" ? <ArrowUpLeft size={13} aria-hidden /> : <ArrowDownRight size={13} aria-hidden />}
                          {r.direction}
                        </span>
                      </Td>
                      <Td>{humanize(r.node.type)}</Td>
                      <Td>
                        {r.node.restricted ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Lock size={12} aria-hidden /> Restricted
                          </span>
                        ) : ASSET_TYPES.has(r.node.type) ? (
                          <Link to={assetHref(r.node.id)} className="font-medium hover:text-primary">
                            {r.node.label}
                          </Link>
                        ) : (
                          <button type="button" onClick={() => setSelected(r.node)} className="font-medium hover:text-primary">
                            {r.node.label}
                          </button>
                        )}
                      </Td>
                      <Td>
                        <span className={`inline-flex rounded-full border-2 px-2 py-px text-ui-xs font-semibold ${EDGE_KIND[r.edge.edge_kind]?.style ?? ""}`}>{EDGE_KIND[r.edge.edge_kind]?.label ?? r.edge.edge_kind}</span>
                        {r.edge.undeclared && (
                          <Badge variant="warning" className="ml-1">
                            Undeclared
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-muted-foreground">{humanize(r.edge.relation)}</Td>
                      <Td align="right">{r.edge.weight_30d.toLocaleString()}</Td>
                      <Td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.edge.last_seen)}</Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            {graph.truncated && <p className="mt-2 text-ui-xs text-muted-foreground">The graph was truncated. Open the full graph to explore further.</p>}
          </div>
          <Card className="space-y-3" aria-live="polite">
            <h3 className="text-ui-md font-bold">{selected ? selected.label : "Details"}</h3>
            {!selected ? (
              <p className="text-ui-sm text-muted-foreground">Select a node in the graph to see its details. Dashed edges are declared, solid edges observed, dotted edges data lineage.</p>
            ) : selected.restricted ? (
              <p className="text-ui-sm text-muted-foreground">You don't have permission to see this node. Request access on its asset page.</p>
            ) : (
              <>
                <DefinitionList
                  items={[
                    { label: "Type", value: humanize(selected.type) },
                    { label: "ID", value: <span className="break-all font-mono text-ui-xs">{selected.id}</span> },
                    ...(selected.owner ? [{ label: "Owner", value: selected.owner }] : []),
                    ...(selected.certification ? [{ label: "Trust", value: <TrustBadge certification={selected.certification} /> }] : []),
                    ...(selected.policy_shield ? [{ label: "Policy", value: <PolicyShield shield={selected.policy_shield} showLabel /> }] : []),
                  ]}
                />
                {ASSET_TYPES.has(selected.type) && selected.id !== assetId && (
                  <Link to={assetHref(selected.id)} className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-ui-sm font-semibold text-primary-foreground hover:brightness-110">
                    Open entity
                  </Link>
                )}
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
