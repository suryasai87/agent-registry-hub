// Pure lineage view model (no React, no React Flow), so layout and styling rules are unit-testable.
//
// Edge semantics (API contract): ``src`` USES ``dst``. Dependencies are drawn to the LEFT of the assets that use
// them and consumers to the RIGHT, so every non-cycle edge runs left (dependency) -> right (consumer).
// Layout: a layered left->right layout without extra dependencies: DFS cycle breaking, longest-path layering
// from the sinks, pure dependencies pulled next to their nearest consumer, then barycenter crossing reduction.
import type { LineageEdge, LineageGraph, LineageNode, NodeType } from "../../lib/types";
import { nodeMeta } from "./meta";

export interface Dims {
  w: number;
  h: number;
  gapX: number;
  gapY: number;
}

export const DIMS: Record<"full" | "compact", Dims> = {
  full: { w: 216, h: 60, gapX: 104, gapY: 22 },
  compact: { w: 176, h: 46, gapX: 66, gapY: 14 },
};

/** Siblings of one type sharing the same neighbours collapse into a "+N tools" cluster beyond this many. */
export const CLUSTER_CAP = { full: 12, compact: 6 } as const;

export interface ClusterInfo {
  key: string;
  count: number;
  members: string[];
}

export interface ViewNode extends LineageNode {
  /** Set on client-side cluster nodes ("+38 tools"); they expand on click. */
  cluster?: ClusterInfo;
}

export interface ViewEdge extends LineageEdge {
  key: string;
  /** How many raw edges were merged into this one (cluster edges). */
  merged?: number;
}

export const edgeKey = (e: Pick<LineageEdge, "src" | "dst" | "relation" | "edge_kind">): string => `${e.src}→${e.dst}·${e.relation}·${e.edge_kind}`;

const pair = (src: string, dst: string) => `${src}\u0000${dst}`;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Backend-collapsed nodes (e.g. "Consumers (12)" for hidden identities) are restricted, never expandable. */
export const isServerCluster = (n: LineageNode) => n.subtype === "cluster" && !(n as ViewNode).cluster;

// ------------------------------------------------------------------------------------------------ clustering
export function clusterGraph(graph: Pick<LineageGraph, "nodes" | "edges">, cap: number, expanded: ReadonlySet<string> = new Set()): { nodes: ViewNode[]; edges: ViewEdge[] } {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const signature = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]));
  const weight = new Map<string, number>();
  for (const e of graph.edges) {
    if (!ids.has(e.src) || !ids.has(e.dst) || e.src === e.dst) continue;
    signature.get(e.src)!.add(`uses:${e.dst}`);
    signature.get(e.dst)!.add(`usedby:${e.src}`);
    weight.set(e.src, (weight.get(e.src) ?? 0) + (e.weight_30d || 0));
    weight.set(e.dst, (weight.get(e.dst) ?? 0) + (e.weight_30d || 0));
  }
  const groups = new Map<string, LineageNode[]>();
  for (const n of graph.nodes) {
    if (n.focus || n.impacted || n.subtype === "cluster") continue;
    const sig = [...signature.get(n.id)!].sort().join(",");
    if (!sig) continue;
    const key = `${n.type}|${sig}`;
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  const into = new Map<string, string>();
  const clusters: ViewNode[] = [];
  for (const [key, members] of groups) {
    if (members.length <= cap || expanded.has(key)) continue;
    members.sort((a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) || a.label.localeCompare(b.label));
    const hidden = members.slice(Math.max(1, cap - 1));
    const id = `cluster:${hash(key)}`;
    hidden.forEach((m) => into.set(m.id, id));
    clusters.push({
      id, type: members[0].type, label: `+${hidden.length} ${nodeMeta(members[0].type).plural}`, subtype: "cluster",
      restricted: false, impacted: false, focus: false, owner: null, certification: null, policy_shield: null,
      cluster: { key, count: hidden.length, members: hidden.map((m) => m.id) },
    });
  }
  const nodes: ViewNode[] = [...graph.nodes.filter((n) => !into.has(n.id)), ...clusters];
  const merged = new Map<string, ViewEdge>();
  for (const e of graph.edges) {
    if (!ids.has(e.src) || !ids.has(e.dst)) continue;
    const src = into.get(e.src) ?? e.src;
    const dst = into.get(e.dst) ?? e.dst;
    const key = edgeKey({ src, dst, relation: e.relation, edge_kind: e.edge_kind });
    const prev = merged.get(key);
    if (prev) {
      prev.weight_30d += e.weight_30d || 0;
      prev.merged = (prev.merged ?? 1) + 1;
      if ((e.last_seen ?? "") > (prev.last_seen ?? "")) prev.last_seen = e.last_seen;
      prev.undeclared = !!prev.undeclared || !!e.undeclared;
      prev.impacted = !!prev.impacted && !!e.impacted;
    } else {
      merged.set(key, { ...e, src, dst, key, weight_30d: e.weight_30d || 0 });
    }
  }
  return { nodes, edges: [...merged.values()] };
}

// ------------------------------------------------------------------------------------------------ layout
export interface Placement {
  layer: number;
  index: number;
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, Placement>;
  layers: string[][];
  /** Edges (src\0dst) ignored for layering because they close a cycle. */
  backEdges: Set<string>;
}

const TYPE_ORDER: NodeType[] = ["user", "service_principal", "app", "agent", "skill", "mcp_server", "tool", "model", "index", "table", "volume", "external"];

export function layoutGraph(nodes: LineageNode[], edges: Pick<LineageEdge, "src" | "dst">[], dims: Dims = DIMS.full): LayoutResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = nodes.map((n) => n.id);
  const deps = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const users = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const e of edges) {
    if (e.src === e.dst || !byId.has(e.src) || !byId.has(e.dst)) continue;
    deps.get(e.src)!.add(e.dst);
    users.get(e.dst)!.add(e.src);
  }

  // 1. Cycle breaking: DFS along "uses" from the focus first; an edge into a node on the stack is a back edge.
  const focus = nodes.find((n) => n.focus)?.id;
  const start = focus ? [focus, ...ids.filter((id) => id !== focus)] : ids;
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (n: string) => {
    state.set(n, 1);
    for (const d of deps.get(n)!) {
      const s = state.get(d);
      if (s === 1) back.add(pair(n, d));
      else if (!s) visit(d);
    }
    state.set(n, 2);
  };
  for (const id of start) if (!state.has(id)) visit(id);
  const depsOf = (n: string) => [...deps.get(n)!].filter((d) => !back.has(pair(n, d)));
  const usersOf = (n: string) => [...users.get(n)!].filter((u) => !back.has(pair(u, n)));

  // 2. Longest path from the sinks: a node sits one layer right of its right-most dependency.
  const rank = new Map<string, number>();
  const rankOf = (n: string): number => {
    const known = rank.get(n);
    if (known !== undefined) return known;
    let r = 0;
    for (const d of depsOf(n)) r = Math.max(r, rankOf(d) + 1);
    rank.set(n, r);
    return r;
  };
  ids.forEach(rankOf);

  // 3. Pure dependencies (tables, models, leaf tools) move right, next to their nearest consumer.
  for (const n of ids) {
    if (depsOf(n).length) continue;
    const u = usersOf(n);
    if (u.length) rank.set(n, Math.min(...u.map((x) => rank.get(x)!)) - 1);
  }

  // 4. Layers, a deterministic initial order, then barycenter sweeps to reduce crossings.
  const depth = Math.max(0, ...rank.values());
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of ids) layers[rank.get(id)!].push(id);
  const typeIdx = (id: string) => TYPE_ORDER.indexOf(byId.get(id)!.type);
  for (const layer of layers) {
    layer.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      return Number(!!nb.focus) - Number(!!na.focus) || typeIdx(a) - typeIdx(b) || na.label.localeCompare(nb.label) || a.localeCompare(b);
    });
  }
  const centred = new Map<string, number>();
  const place = () => layers.forEach((layer) => layer.forEach((id, i) => centred.set(id, i - (layer.length - 1) / 2)));
  place();
  const neighbours = (id: string) => [...deps.get(id)!, ...users.get(id)!];
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    for (let k = 0; k < layers.length; k++) {
      const li = forward ? k : layers.length - 1 - k;
      const adj = forward ? li - 1 : li + 1;
      if (adj < 0 || adj >= layers.length) continue;
      const bary = new Map<string, number>();
      for (const id of layers[li]) {
        const ns = neighbours(id).filter((n) => rank.get(n) === adj);
        bary.set(id, ns.length ? ns.reduce((s, n) => s + centred.get(n)!, 0) / ns.length : centred.get(id)!);
      }
      const before = new Map(layers[li].map((id, i) => [id, i]));
      layers[li].sort((a, b) => bary.get(a)! - bary.get(b)! || before.get(a)! - before.get(b)!);
      layers[li].forEach((id, i) => centred.set(id, i - (layers[li].length - 1) / 2));
    }
  }

  const positions = new Map<string, Placement>();
  layers.forEach((layer, li) =>
    layer.forEach((id, i) => {
      positions.set(id, { layer: li, index: i, x: li * (dims.w + dims.gapX), y: (i - (layer.length - 1) / 2) * (dims.h + dims.gapY) });
    }),
  );
  return { positions, layers, backEdges: back };
}

// ------------------------------------------------------------------------------------------------ edge style
export const EDGE_COLORS = {
  declared: "hsl(var(--muted-foreground))",
  observed: "hsl(var(--info))",
  data: "hsl(var(--db-teal))",
  undeclared: "hsl(var(--warning))",
  impacted: "hsl(var(--primary))",
} as const;

export interface EdgeVisual {
  stroke: string;
  width: number;
  /** stroke-dasharray; undefined = solid. */
  dash?: string;
  cap: "round" | "butt";
  label: string;
}

/** Observed edges thicken with log(30-day volume): 0 calls = 1.5 px, 10k calls ≈ 6 px, capped at 7 px. */
export function observedWidth(weight: number): number {
  return Math.min(7, 1.5 + Math.log10(1 + Math.max(0, weight || 0)) * 1.15);
}

/** Declared = dashed, observed = solid (width by volume; undeclared = amber), data = dotted. */
export function edgeVisual(e: Pick<LineageEdge, "edge_kind" | "weight_30d" | "undeclared" | "impacted">, impactMode = false): EdgeVisual {
  const hot = impactMode && !!e.impacted;
  if (e.edge_kind === "declared") return { stroke: hot ? EDGE_COLORS.impacted : EDGE_COLORS.declared, width: 1.6, dash: "6 5", cap: "butt", label: "Declared" };
  if (e.edge_kind === "data") return { stroke: hot ? EDGE_COLORS.impacted : EDGE_COLORS.data, width: 2.2, dash: "0.5 5", cap: "round", label: "Data" };
  const undeclared = !!e.undeclared;
  return {
    stroke: hot ? EDGE_COLORS.impacted : undeclared ? EDGE_COLORS.undeclared : EDGE_COLORS.observed,
    width: observedWidth(e.weight_30d),
    cap: "round",
    label: undeclared ? "Observed · undeclared" : "Observed",
  };
}

// ------------------------------------------------------------------------------------------------ reach
export interface Reach {
  side: "focus" | "upstream" | "downstream" | "related";
  /** Hops along the direction of ``side`` (undirected hops for "related"). */
  hops: number;
}

/** Where every node sits relative to the focus: its dependencies are upstream, its consumers downstream. */
export function reachFromFocus(nodes: Pick<LineageNode, "id">[], edges: Pick<LineageEdge, "src" | "dst">[], focus: string | null | undefined): Map<string, Reach> {
  const out = new Map<string, Reach>();
  if (!focus || !nodes.some((n) => n.id === focus)) return out;
  const deps = new Map<string, string[]>();
  const users = new Map<string, string[]>();
  for (const e of edges) {
    if (e.src === e.dst) continue;
    (deps.get(e.src) ?? deps.set(e.src, []).get(e.src)!).push(e.dst);
    (users.get(e.dst) ?? users.set(e.dst, []).get(e.dst)!).push(e.src);
  }
  const walk = (next: Map<string, string[]>) => {
    const dist = new Map<string, number>([[focus, 0]]);
    const queue = [focus];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of next.get(n) ?? []) {
        if (!dist.has(m)) {
          dist.set(m, dist.get(n)! + 1);
          queue.push(m);
        }
      }
    }
    return dist;
  };
  const up = walk(deps);
  const down = walk(users);
  const both = new Map<string, string[]>();
  for (const [k, v] of deps) both.set(k, [...(both.get(k) ?? []), ...v]);
  for (const [k, v] of users) both.set(k, [...(both.get(k) ?? []), ...v]);
  const any = walk(both);
  for (const n of nodes) {
    if (n.id === focus) out.set(n.id, { side: "focus", hops: 0 });
    else if (up.has(n.id) && (!down.has(n.id) || up.get(n.id)! <= down.get(n.id)!)) out.set(n.id, { side: "upstream", hops: up.get(n.id)! });
    else if (down.has(n.id)) out.set(n.id, { side: "downstream", hops: down.get(n.id)! });
    else if (any.has(n.id)) out.set(n.id, { side: "related", hops: any.get(n.id)! });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ view
export interface PlacedNode {
  node: ViewNode;
  x: number;
  y: number;
  layer: number;
  index: number;
  dimmed: boolean;
  /** Keyboard targets: arrow keys move to these node ids. */
  nav: { left?: string; right?: string; up?: string; down?: string };
}

export interface PlacedEdge {
  edge: ViewEdge;
  visual: EdgeVisual;
  dimmed: boolean;
  animate: boolean;
}

export interface GraphView {
  /** In keyboard (Tab) order: the focus first, then by hop distance, then left -> right. */
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  layers: string[][];
  dims: Dims;
  reach: Map<string, Reach>;
}

export function buildView(
  graph: Pick<LineageGraph, "nodes" | "edges" | "focus">,
  { compact = false, impactMode = false, expanded = new Set<string>() }: { compact?: boolean; impactMode?: boolean; expanded?: ReadonlySet<string> } = {},
): GraphView {
  const dims = compact ? DIMS.compact : DIMS.full;
  const { nodes, edges } = clusterGraph(graph, compact ? CLUSTER_CAP.compact : CLUSTER_CAP.full, expanded);
  const layout = layoutGraph(nodes, edges, dims);
  const focusId = graph.focus ?? nodes.find((n) => n.focus)?.id ?? null;
  const reach = reachFromFocus(nodes, edges, focusId);

  const depsOf = new Map<string, Set<string>>();
  const usersOf = new Map<string, Set<string>>();
  for (const e of edges) {
    (depsOf.get(e.src) ?? depsOf.set(e.src, new Set()).get(e.src)!).add(e.dst);
    (usersOf.get(e.dst) ?? usersOf.set(e.dst, new Set()).get(e.dst)!).add(e.src);
  }
  const nearest = (from: string, candidates: Iterable<string>, toLeft: boolean): string | undefined => {
    const p = layout.positions.get(from)!;
    let best: string | undefined;
    let score = Infinity;
    for (const c of candidates) {
      const q = layout.positions.get(c);
      if (!q || (toLeft ? q.layer >= p.layer : q.layer <= p.layer)) continue;
      const s = Math.abs(q.layer - p.layer) * 1000 + Math.abs(q.y - p.y);
      if (s < score) {
        score = s;
        best = c;
      }
    }
    return best;
  };
  const layerNeighbour = (from: string, toLeft: boolean): string | undefined => {
    const p = layout.positions.get(from)!;
    const li = toLeft ? p.layer - 1 : p.layer + 1;
    return li >= 0 && li < layout.layers.length ? nearest(from, layout.layers[li], toLeft) : undefined;
  };

  const placed: PlacedNode[] = nodes.map((node) => {
    const p = layout.positions.get(node.id)!;
    const layer = layout.layers[p.layer];
    return {
      node, x: p.x, y: p.y, layer: p.layer, index: p.index,
      dimmed: impactMode && !node.impacted,
      nav: {
        left: nearest(node.id, depsOf.get(node.id) ?? [], true) ?? layerNeighbour(node.id, true),
        right: nearest(node.id, usersOf.get(node.id) ?? [], false) ?? layerNeighbour(node.id, false),
        up: p.index > 0 ? layer[p.index - 1] : undefined,
        down: p.index < layer.length - 1 ? layer[p.index + 1] : undefined,
      },
    };
  });
  const hop = (id: string) => reach.get(id)?.hops ?? Number.MAX_SAFE_INTEGER;
  placed.sort((a, b) => Number(b.node.id === focusId) - Number(a.node.id === focusId) || hop(a.node.id) - hop(b.node.id) || a.layer - b.layer || a.index - b.index);

  const placedEdges: PlacedEdge[] = edges.map((edge) => ({
    edge,
    visual: edgeVisual(edge, impactMode),
    dimmed: impactMode && !edge.impacted,
    animate: impactMode && !!edge.impacted,
  }));
  return { nodes: placed, edges: placedEdges, layers: layout.layers, dims, reach };
}

// ------------------------------------------------------------------------------------------------ summary
/** One sentence for the aria-live region: what the graph shows right now. */
export function summarize(graph: Pick<LineageGraph, "nodes" | "edges" | "truncated">, { impactMode = false, focusLabel }: { impactMode?: boolean; focusLabel?: string | null } = {}): string {
  if (graph.nodes.length === 0) return focusLabel ? `No lineage recorded for ${focusLabel}.` : "No lineage to show.";
  const byType = new Map<string, number>();
  for (const n of graph.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
  const types = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${c} ${c === 1 ? nodeMeta(t).label.toLowerCase() : nodeMeta(t).plural}`)
    .join(", ");
  const kinds = (["declared", "observed", "data"] as const)
    .map((k) => [k, graph.edges.filter((e) => e.edge_kind === k).length] as const)
    .filter(([, c]) => c > 0)
    .map(([k, c]) => `${c} ${k}`)
    .join(", ");
  const undeclared = graph.edges.filter((e) => e.undeclared).length;
  let s = `${focusLabel ? `Lineage of ${focusLabel}: ` : ""}${graph.nodes.length} nodes (${types}) and ${graph.edges.length} edges${kinds ? ` (${kinds})` : ""}.`;
  if (undeclared) s += ` ${undeclared} undeclared ${undeclared === 1 ? "dependency" : "dependencies"}.`;
  if (impactMode) {
    const hit = graph.nodes.filter((n) => n.impacted);
    const people = hit.filter((n) => n.type === "user" || n.type === "service_principal").length;
    s += ` Impact highlight: ${hit.length - people} ${hit.length - people === 1 ? "asset" : "assets"} and ${people} ${people === 1 ? "person" : "people"} affected.`;
  }
  if (graph.truncated) s += " The graph was truncated; narrow the depth or edge kinds to see everything.";
  return s;
}
