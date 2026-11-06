import { fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LineageEdge, LineageGraph as Graph, LineageNode } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import LineageGraph from "./LineageGraph";
import { lineageRows } from "./LineageParts";
import { buildView, clusterGraph, EDGE_COLORS, edgeVisual, layoutGraph, observedWidth, reachFromFocus, summarize } from "./model";

// React Flow measures with DOMMatrix / offset sizes / getBBox, which jsdom lacks.
beforeAll(() => {
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return 60; } },
    offsetWidth: { configurable: true, get() { return 216; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
});

const node = (id: string, type: LineageNode["type"], label: string, extra: Partial<LineageNode> = {}): LineageNode => ({
  id, type, label, subtype: null, restricted: false, impacted: false, focus: false, owner: null, certification: null, policy_shield: null, ...extra,
});
const edge = (src: string, dst: string, edge_kind: LineageEdge["edge_kind"], extra: Partial<LineageEdge> = {}): LineageEdge => ({
  src, dst, relation: "uses_tool", edge_kind, weight_30d: 0, last_seen: "2026-10-25T10:00:00Z", source: "test", impacted: false, undeclared: false, ...extra,
});

// The live demo topology: users use the supervisor, which uses agents, an MCP server and a tool; tools read tables.
const SUP = "agent:endpoint:sup";
const GRAPH: Graph = {
  focus: SUP,
  depth: 2,
  direction: "both",
  truncated: false,
  nodes: [
    node(SUP, "agent", "Care Ops Supervisor", { focus: true, certification: "certified", policy_shield: "partial" }),
    node("agent:endpoint:ka", "agent", "Policy Docs Assistant", { impacted: true }),
    node("agent:genie:claims", "agent", "Claims Analytics"),
    node("mcp:system:m365", "mcp_server", "Microsoft 365"),
    node("tool:mcp:system:m365/search_mail", "tool", "search_mail"),
    node("tool:uc:demo.care.member_risk", "tool", "member_risk"),
    node("table:demo.care.member_features", "table", "demo.care.member_features"),
    node("table:demo.claims.claim_lines", "table", "demo.claims.claim_lines"),
    node("user:jo@example.com", "user", "Jo Park"),
    node("agent:endpoint:secret", "agent", "agent:endpoint:secret", { restricted: true }),
  ],
  edges: [
    edge(SUP, "agent:endpoint:ka", "declared", { relation: "calls_agent", impacted: true }),
    edge(SUP, "agent:genie:claims", "declared", { relation: "calls_agent" }),
    edge(SUP, "mcp:system:m365", "observed", { relation: "uses_mcp", weight_30d: 120, undeclared: true }),
    edge(SUP, "tool:uc:demo.care.member_risk", "declared"),
    edge("agent:genie:claims", "table:demo.claims.claim_lines", "data", { relation: "reads_data" }),
    edge("mcp:system:m365", "tool:mcp:system:m365/search_mail", "declared", { relation: "exposes_tool" }),
    edge("tool:uc:demo.care.member_risk", "table:demo.care.member_features", "data", { relation: "reads_data" }),
    edge("user:jo@example.com", SUP, "observed", { relation: "consumes", weight_30d: 4000 }),
    edge("agent:endpoint:secret", SUP, "declared", { relation: "calls_agent" }),
  ],
};

describe("lineage layout", () => {
  it("puts every dependency (dst) left of the asset that uses it (src)", () => {
    const { positions } = layoutGraph(GRAPH.nodes, GRAPH.edges);
    for (const e of GRAPH.edges) {
      expect(positions.get(e.dst)!.x, `${e.dst} should be left of ${e.src}`).toBeLessThan(positions.get(e.src)!.x);
    }
    // consumers are right of the focus, tables are the left-most layer
    expect(positions.get("user:jo@example.com")!.layer).toBeGreaterThan(positions.get(SUP)!.layer);
    expect(positions.get("table:demo.claims.claim_lines")!.layer).toBe(0);
    // a pure dependency sits next to its only consumer, not stretched to the far left
    expect(positions.get(SUP)!.layer - positions.get("agent:endpoint:ka")!.layer).toBe(1);
  });

  it("breaks cycles instead of looping, and still lays out every node", () => {
    const nodes = [node("agent:a", "agent", "A", { focus: true }), node("agent:b", "agent", "B"), node("tool:c", "tool", "C")];
    const edges = [edge("agent:a", "agent:b", "declared"), edge("agent:b", "agent:a", "observed"), edge("agent:b", "tool:c", "declared")];
    const { positions, backEdges } = layoutGraph(nodes, edges);
    expect(positions.size).toBe(3);
    expect(backEdges.size).toBe(1);
    expect(positions.get("tool:c")!.x).toBeLessThan(positions.get("agent:b")!.x);
    expect(positions.get("agent:b")!.x).toBeLessThan(positions.get("agent:a")!.x);
  });

  it("classifies upstream / downstream relative to the focus", () => {
    const reach = reachFromFocus(GRAPH.nodes, GRAPH.edges, SUP);
    expect(reach.get("tool:mcp:system:m365/search_mail")).toEqual({ side: "upstream", hops: 2 });
    expect(reach.get("user:jo@example.com")).toEqual({ side: "downstream", hops: 1 });
    const rows = lineageRows(GRAPH);
    expect(rows.find((r) => r.nodeId === "user:jo@example.com")!.direction).toBe("Downstream · 1 hop");
    expect(rows.find((r) => r.nodeId === "tool:mcp:system:m365/search_mail")).toMatchObject({ direction: "Upstream · 2 hops", via: "Microsoft 365", edgeKind: "declared" });
  });

  it("collapses many same-neighbour siblings into an expandable cluster", () => {
    const tools = Array.from({ length: 20 }, (_, i) => node(`tool:t${i}`, "tool", `tool ${String(i).padStart(2, "0")}`));
    const g = { nodes: [node("mcp:s", "mcp_server", "Server", { focus: true }), ...tools], edges: tools.map((t) => edge("mcp:s", t.id, "declared", { relation: "exposes_tool" })) };
    const collapsed = clusterGraph(g, 12);
    const cluster = collapsed.nodes.find((n) => n.cluster);
    expect(cluster?.label).toBe("+9 tools");
    expect(collapsed.nodes).toHaveLength(1 + 11 + 1);
    expect(collapsed.edges.find((e) => e.dst === cluster!.id)?.merged).toBe(9);
    expect(clusterGraph(g, 12, new Set([cluster!.cluster!.key])).nodes).toHaveLength(21);
  });
});

describe("lineage edge styles", () => {
  it("draws declared dashed, observed solid (width by log volume), data dotted, undeclared amber", () => {
    const declared = edgeVisual({ edge_kind: "declared", weight_30d: 0 });
    const observedLow = edgeVisual({ edge_kind: "observed", weight_30d: 10 });
    const observedHigh = edgeVisual({ edge_kind: "observed", weight_30d: 10_000 });
    const data = edgeVisual({ edge_kind: "data", weight_30d: 0 });
    const undeclared = edgeVisual({ edge_kind: "observed", weight_30d: 50, undeclared: true });
    expect(declared.dash).toBe("6 5");
    expect(observedLow.dash).toBeUndefined();
    expect(observedHigh.width).toBeGreaterThan(observedLow.width);
    expect(observedWidth(0)).toBe(1.5);
    expect(observedWidth(1e9)).toBe(7);
    expect(data).toMatchObject({ dash: "0.5 5", cap: "round", stroke: EDGE_COLORS.data });
    expect(undeclared.stroke).toBe(EDGE_COLORS.undeclared);
    expect(undeclared.label).toMatch(/undeclared/);
    expect(edgeVisual({ edge_kind: "declared", weight_30d: 0, impacted: true }, true).stroke).toBe(EDGE_COLORS.impacted);
  });

  it("renders edges with their kind's stroke", () => {
    const { container } = renderWithProviders(<LineageGraph graph={GRAPH} />);
    const path = (kind: string) => container.querySelector<SVGPathElement>(`g[data-edge-kind="${kind}"] path.react-flow__edge-path`);
    expect(path("declared")?.style.strokeDasharray).toBe("6 5");
    expect(path("data")?.style.strokeDasharray).toBe("0.5 5");
    expect(container.querySelector('g[data-undeclared="true"] path.react-flow__edge-path')?.getAttribute("style")).toContain("var(--warning)");
    expect(screen.getByText("Undeclared")).toBeInTheDocument();
  });
});

describe("LineageGraph", () => {
  it("dims everything that isn't impacted to 20% in impact mode", () => {
    const view = buildView(GRAPH, { impactMode: true });
    expect(view.nodes.find((p) => p.node.id === "agent:endpoint:ka")!.dimmed).toBe(false);
    expect(view.nodes.find((p) => p.node.id === "mcp:system:m365")!.dimmed).toBe(true);
    expect(view.edges.find((e) => e.edge.dst === "agent:endpoint:ka")).toMatchObject({ dimmed: false, animate: true });

    const { container } = renderWithProviders(<LineageGraph graph={GRAPH} impactMode />);
    const box = (label: RegExp) => screen.getByRole("button", { name: label }).closest<HTMLElement>("[data-node-type]")!;
    expect(box(/Policy Docs Assistant/)).not.toHaveAttribute("data-dimmed");
    expect(box(/Policy Docs Assistant/).style.opacity).toBe("1");
    expect(box(/Microsoft 365/)).toHaveAttribute("data-dimmed", "true");
    expect(box(/Microsoft 365/).style.opacity).toBe("0.2");
    expect(container.querySelectorAll('g[data-dimmed="true"]').length).toBe(GRAPH.edges.length - 1);
    expect(screen.getByRole("group", { name: /Impact highlight: 1 asset and 0 people affected/ })).toBeInTheDocument();
  });

  it("shows restricted nodes grey and never lets them be expanded", () => {
    const onFocus = vi.fn();
    const onSelect = vi.fn();
    renderWithProviders(<LineageGraph graph={GRAPH} onFocus={onFocus} onSelect={onSelect} />);
    const restricted = screen.getByRole("button", { name: /agent:endpoint:secret, restricted/ });
    const box = restricted.closest<HTMLElement>("[data-node-type]")!;
    expect(box).toHaveAttribute("data-restricted", "true");
    expect(within(box).getByText("Restricted")).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: /Re-centre/ })).not.toBeInTheDocument();
    fireEvent.doubleClick(restricted);
    fireEvent.keyDown(restricted, { key: "f" });
    expect(onFocus).not.toHaveBeenCalled();
    fireEvent.click(restricted);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "agent:endpoint:secret" }));

    const open = screen.getByRole("button", { name: /^MCP server: Microsoft 365/ });
    fireEvent.doubleClick(open);
    expect(onFocus).toHaveBeenCalledWith(expect.objectContaining({ id: "mcp:system:m365" }));
  });

  it("orders nodes for keyboard users from the focus outwards, with shields in the accessible name", () => {
    renderWithProviders(<LineageGraph graph={GRAPH} />);
    const buttons = screen.getAllByRole("button", { name: /^(Agent|MCP server|Tool|Table|User): / });
    expect(buttons[0]).toHaveAccessibleName("Agent: Care Ops Supervisor, focus, certified, policy coverage: partial");
    expect(buttons.at(-1)).toHaveAccessibleName(/search_mail|demo\.c/);
  });

  it("summarizes the graph for the aria-live region", () => {
    expect(summarize(GRAPH, { focusLabel: "Care Ops Supervisor" })).toMatch(/^Lineage of Care Ops Supervisor: 10 nodes \(4 agents.*and 9 edges \(5 declared, 2 observed, 2 data\)\. 1 undeclared dependency\.$/);
    expect(summarize({ nodes: [], edges: [], truncated: false }, { focusLabel: "X" })).toBe("No lineage recorded for X.");
  });

  it("compact mode has no minimap or zoom controls", () => {
    const { container, unmount } = renderWithProviders(<LineageGraph graph={GRAPH} compact />);
    expect(container.querySelector(".react-flow__minimap")).toBeNull();
    expect(container.querySelector(".react-flow__controls")).toBeNull();
    expect(screen.queryByRole("button", { name: /Re-centre/ })).not.toBeInTheDocument();
    unmount();
    const full = renderWithProviders(<LineageGraph graph={GRAPH} onFocus={() => undefined} />);
    expect(full.container.querySelector(".react-flow__minimap")).not.toBeNull();
    expect(full.container.querySelector(".react-flow__controls")).not.toBeNull();
  });
});
