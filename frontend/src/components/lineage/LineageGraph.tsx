// Lineage graph (React Flow). Used full-page by pages/Lineage.tsx and compact (1 hop, no controls) on the entity
// page's Lineage tab, so the props contract below is stable.
//
// Reading the graph: dependencies sit LEFT of the assets that use them, consumers RIGHT; arrows point from a
// dependency to the consumer that uses it. Declared edges are dashed, observed edges solid (thicker = more
// 30-day calls; amber = observed but never declared), data edges dotted. Restricted nodes are grey and can't
// be expanded. In impact mode everything not impacted dims to 20% and impacted paths carry flowing dots.
//
// Keyboard: Tab walks the nodes from the focus outwards; Enter opens details; F or + re-centres; arrow keys
// move to the nearest dependency (left), consumer (right) or sibling (up/down).
import "@xyflow/react/dist/style.css";
import {
  Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Position, ReactFlow,
  ReactFlowProvider, getBezierPath, useReactFlow, useStore, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { useReducedMotion } from "framer-motion";
import {
  BadgeCheck, CircleDashed, Layers, Lock, Plus, ShieldCheck, ShieldHalf, ShieldOff, TriangleAlert, Zap, type LucideIcon,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../../lib/cx";
import { useTheme } from "../../lib/theme";
import type { Certification, LineageGraph as Graph, LineageNode } from "../../lib/types";
import { nodeMeta, tileStyle } from "./meta";
import { buildView, isServerCluster, summarize, type Dims, type EdgeVisual, type PlacedNode, type ViewEdge, type ViewNode } from "./model";

export interface LineageGraphProps {
  graph: Graph;
  /** Compact embed: fixed height, no minimap/controls, click a node → onSelect. */
  compact?: boolean;
  height?: number;
  /** Highlight impacted paths (nodes/edges with impacted=true); dim the rest. */
  impactMode?: boolean;
  selectedId?: string | null;
  onSelect?: (node: LineageNode) => void;
  /** Double-click / "+" on a node → re-center (full page only). */
  onFocus?: (node: LineageNode) => void;
}

interface NodeData extends Record<string, unknown> {
  placed: PlacedNode;
  dims: Dims;
  selected: boolean;
}
type FlowNode = Node<NodeData, "lineage">;

interface EdgeData extends Record<string, unknown> {
  edge: ViewEdge;
  visual: EdgeVisual;
  dimmed: boolean;
  animate: boolean;
  showLabel: boolean;
}
type FlowEdge = Edge<EdgeData, "lineage">;

interface GraphCtx {
  uid: string;
  compact: boolean;
  canFocus: boolean;
  select: (node: ViewNode) => void;
  focus: (node: ViewNode) => void;
  expand: (key: string) => void;
  moveTo: (id: string | undefined) => void;
}
const Ctx = createContext<GraphCtx | null>(null);

export const nodeDomId = (uid: string, id: string) => `${uid}-n-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

const CERT_ICON: Record<Certification, { icon: LucideIcon; tone: string; label: string }> = {
  certified: { icon: BadgeCheck, tone: "text-success", label: "Certified" },
  verified_publisher: { icon: ShieldCheck, tone: "text-info", label: "Verified publisher" },
  deprecated: { icon: TriangleAlert, tone: "text-warning", label: "Deprecated" },
  unreviewed: { icon: CircleDashed, tone: "text-muted-foreground", label: "Unreviewed" },
};

const SHIELD_ICON: Record<"full" | "partial" | "none", { icon: LucideIcon; tone: string; label: string }> = {
  full: { icon: ShieldCheck, tone: "text-success", label: "Policy coverage: full" },
  partial: { icon: ShieldHalf, tone: "text-warning", label: "Policy coverage: partial" },
  none: { icon: ShieldOff, tone: "text-destructive", label: "Policy coverage: none" },
};

const hiddenHandle = "!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";

/** Accessible name of a node button ("MCP server: Microsoft 365 Mail, certified, impacted"). */
export function nodeAriaLabel(node: ViewNode): string {
  const meta = nodeMeta(node.type);
  const parts = [`${meta.label}: ${node.label}`];
  if (node.focus) parts.push("focus");
  if (node.restricted) parts.push("restricted");
  if (node.cluster) parts.push(`cluster of ${node.cluster.count}, press Enter to expand`);
  if (node.certification) parts.push(CERT_ICON[node.certification]?.label.toLowerCase() ?? node.certification);
  if (node.policy_shield) parts.push(SHIELD_ICON[node.policy_shield].label.toLowerCase());
  if (node.impacted) parts.push("impacted");
  return parts.join(", ");
}

const LineageNodeView = memo(function LineageNodeView({ data }: NodeProps<FlowNode>) {
  const ctx = useContext(Ctx)!;
  const { placed, dims, selected } = data;
  const node = placed.node;
  const meta = nodeMeta(node.type);
  const Icon = node.cluster ? Layers : meta.icon;
  const restricted = !!node.restricted || isServerCluster(node);
  const cert = node.certification ? CERT_ICON[node.certification] : null;
  const shield = node.policy_shield ? SHIELD_ICON[node.policy_shield] : null;
  const expandable = ctx.canFocus && !restricted && !node.cluster && !node.focus;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const key = e.key;
    const target =
      key === "ArrowLeft" ? placed.nav.left : key === "ArrowRight" ? placed.nav.right : key === "ArrowUp" ? placed.nav.up : key === "ArrowDown" ? placed.nav.down : null;
    if (target !== null) {
      e.preventDefault();
      e.stopPropagation();
      ctx.moveTo(target);
      return;
    }
    if ((key === "f" || key === "F" || key === "+") && expandable) {
      e.preventDefault();
      ctx.focus(node);
    }
  };

  return (
    <div
      data-node-type={node.type}
      data-restricted={restricted || undefined}
      data-dimmed={placed.dimmed || undefined}
      data-impacted={node.impacted || undefined}
      style={{ width: dims.w, height: dims.h, opacity: placed.dimmed ? 0.2 : 1 }}
      className="group relative transition-opacity duration-300"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hiddenHandle} />
      <button
        type="button"
        id={nodeDomId(ctx.uid, node.id)}
        aria-label={nodeAriaLabel(node)}
        aria-pressed={selected}
        onClick={() => (node.cluster ? ctx.expand(node.cluster.key) : ctx.select(node))}
        onDoubleClick={() => {
          if (expandable) ctx.focus(node);
        }}
        onKeyDown={onKeyDown}
        className={cx(
          "nodrag nopan flex h-full w-full items-center gap-2 border text-left shadow-sm transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2",
          ctx.compact ? "px-2" : "px-2.5",
          meta.radius,
          node.cluster && "border-dashed",
          restricted ? "border-border bg-muted text-muted-foreground" : "border-border bg-card text-card-foreground",
          node.focus && !restricted && "border-primary ring-2 ring-primary/40",
          node.impacted && !node.focus && "border-primary/70",
          selected && "ring-2 ring-ring",
        )}
      >
        <span
          aria-hidden
          style={tileStyle(meta.shape)}
          className={cx("grid shrink-0 place-items-center", ctx.compact ? "h-7 w-7" : "h-9 w-9", restricted ? "bg-background/60 text-muted-foreground" : meta.tile)}
        >
          {restricted ? <Lock size={ctx.compact ? 13 : 15} /> : <Icon size={ctx.compact ? 14 : 17} />}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className={cx("block truncate font-semibold", ctx.compact ? "text-ui-xs" : "text-ui-sm")} title={node.label}>
            {node.label}
          </span>
          <span className="block truncate text-ui-xs text-muted-foreground">
            {restricted ? "Restricted" : node.cluster ? "Click to expand" : node.subtype && node.subtype !== "cluster" ? node.subtype.replace(/_/g, " ") : meta.label}
          </span>
        </span>
        {!restricted && (cert || shield) && (
          <span className="flex shrink-0 flex-col items-center gap-0.5" aria-hidden>
            {cert && <cert.icon size={13} className={cert.tone} />}
            {shield && <shield.icon size={13} className={shield.tone} />}
          </span>
        )}
      </button>
      {node.impacted && !ctx.compact && (
        <span aria-hidden className="pointer-events-none absolute -left-1.5 -top-2 inline-flex items-center gap-0.5 rounded-full bg-primary px-1.5 py-px text-[10px] font-bold text-primary-foreground shadow">
          <Zap size={10} /> Impacted
        </span>
      )}
      {expandable && !ctx.compact && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Re-centre on ${node.label}`}
          title="Re-centre here"
          onClick={() => ctx.focus(node)}
          className="nodrag nopan absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 shadow transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
        >
          <Plus size={12} aria-hidden />
        </button>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hiddenHandle} />
    </div>
  );
});

function LineageEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowEdge>) {
  const reduce = useReducedMotion();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  if (!data) return null;
  const { visual, edge, dimmed, animate, showLabel } = data;
  return (
    <g data-edge-kind={edge.edge_kind} data-undeclared={edge.undeclared || undefined} data-dimmed={dimmed || undefined} style={{ opacity: dimmed ? 0.2 : 1 }} className="transition-opacity duration-300">
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{ stroke: visual.stroke, strokeWidth: visual.width, strokeDasharray: visual.dash, strokeLinecap: visual.cap }}
      />
      <title>{`${edge.src} ${edge.relation.replace(/_/g, " ")} ${edge.dst} · ${visual.label}${edge.weight_30d ? ` · ${edge.weight_30d.toLocaleString()} calls (30 d)` : ""}`}</title>
      {animate && !reduce && (
        <circle r={3.5} fill="hsl(var(--primary))">
          <animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {showLabel && edge.undeclared && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: dimmed ? 0.2 : 1 }}
            className="nodrag nopan pointer-events-none absolute rounded-full border border-warning/50 bg-popover px-1.5 py-px text-[10px] font-bold text-warning shadow-sm"
          >
            Undeclared
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

const nodeTypes = { lineage: LineageNodeView };
const edgeTypes = { lineage: LineageEdgeView };

/**
 * Re-fits the viewport when the visible graph or the pane size changes (the ``fitView`` prop only applies on
 * mount). Waits until React Flow has measured the pane: fitting a 0×0 pane leaves the graph small and off-centre.
 */
function AutoFit({ signature, compact }: { signature: string; compact: boolean }) {
  const rf = useReactFlow();
  const reduce = useReducedMotion();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (!width || !height) return;
    const raf = requestAnimationFrame(() => {
      rf.fitView({ padding: compact ? 0.12 : 0.16, maxZoom: compact ? 1 : 1.15, duration: reduce ? 0 : 300 });
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [signature, compact, rf, reduce, width, height]);
  return null;
}

function Inner({ graph, compact = false, height, impactMode = false, selectedId = null, onSelect, onFocus }: LineageGraphProps) {
  const rf = useReactFlow();
  const [theme] = useTheme();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const graphKey = `${graph.focus ?? ""}|${graph.depth}|${graph.direction}`;
  const lastKey = useRef(graphKey);
  useEffect(() => {
    if (lastKey.current !== graphKey) {
      lastKey.current = graphKey;
      setExpanded(new Set());
    }
  }, [graphKey]);

  const view = useMemo(() => buildView(graph, { compact, impactMode, expanded }), [graph, compact, impactMode, expanded]);

  const nodes = useMemo<FlowNode[]>(
    () =>
      view.nodes.map((p) => ({
        id: p.node.id,
        type: "lineage",
        position: { x: p.x, y: p.y },
        width: view.dims.w,
        height: view.dims.h,
        // Explicit handle geometry: edges render before (and without) DOM measurement.
        handles: [
          { type: "target", position: Position.Left, x: 0, y: view.dims.h / 2, width: 1, height: 1 },
          { type: "source", position: Position.Right, x: view.dims.w - 1, y: view.dims.h / 2, width: 1, height: 1 },
        ],
        data: { placed: p, dims: view.dims, selected: p.node.id === selectedId },
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
      })),
    [view, selectedId],
  );

  const edges = useMemo<FlowEdge[]>(
    () =>
      view.edges.map((pe) => ({
        id: pe.edge.key,
        // React Flow draws source -> target: the dependency (dst) on the left feeds the consumer (src) on the right.
        source: pe.edge.dst,
        target: pe.edge.src,
        type: "lineage",
        data: { edge: pe.edge, visual: pe.visual, dimmed: pe.dimmed, animate: pe.animate, showLabel: !compact },
        markerEnd: { type: MarkerType.ArrowClosed, color: pe.visual.stroke, width: 14, height: 14 },
        selectable: false,
        focusable: false,
      })),
    [view, compact],
  );

  const positions = useMemo(() => new Map(view.nodes.map((p) => [p.node.id, p])), [view]);
  const moveTo = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      const el = document.getElementById(nodeDomId(uid, id));
      el?.focus();
      const p = positions.get(id);
      if (p) rf.setCenter(p.x + view.dims.w / 2, p.y + view.dims.h / 2, { zoom: rf.getZoom(), duration: 200 });
    },
    [uid, positions, rf, view.dims],
  );

  const ctx = useMemo<GraphCtx>(
    () => ({
      uid,
      compact,
      canFocus: !compact && !!onFocus,
      select: (n) => onSelect?.(n),
      focus: (n) => onFocus?.(n),
      expand: (key) => setExpanded((s) => new Set(s).add(key)),
      moveTo,
    }),
    [uid, compact, onSelect, onFocus, moveTo],
  );

  const signature = `${graphKey}|${view.nodes.length}|${expanded.size}`;
  const summary = summarize(graph, { impactMode, focusLabel: graph.nodes.find((n) => n.focus)?.label });

  return (
    <Ctx.Provider value={ctx}>
      <div
        role="group"
        aria-roledescription="lineage graph"
        aria-label={summary}
        aria-describedby={`${uid}-help`}
        style={{ height: height ?? (compact ? 300 : 620) }}
        className="lineage-graph relative w-full overflow-hidden rounded-xl border border-border bg-background/40"
      >
        <p id={`${uid}-help`} className="sr-only">
          Tab moves between nodes from the focus outwards. Enter opens a node's details{compact ? "" : "; F or plus re-centres the graph on it"}. Arrow keys move to the
          nearest dependency (left), consumer (right) or sibling (up and down).
        </p>
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: compact ? 0.12 : 0.18, maxZoom: compact ? 1 : 1.2 }}
          minZoom={0.15}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          zoomOnScroll={!compact}
          preventScrolling={!compact}
          panActivationKeyCode={null}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          attributionPosition="top-right"
          style={{ background: "transparent" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(var(--border))" bgColor="transparent" />
          {!compact && <Controls showInteractive={false} position="bottom-left" aria-label="Zoom controls" />}
          {!compact && (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              ariaLabel="Lineage minimap"
              nodeColor={(n) => nodeMeta((n.data as NodeData).placed.node.type).color}
              nodeStrokeWidth={0}
              maskColor="hsl(var(--background) / 0.6)"
              style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
            />
          )}
          <AutoFit signature={signature} compact={compact} />
        </ReactFlow>
      </div>
    </Ctx.Provider>
  );
}

export default function LineageGraph(props: LineageGraphProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
