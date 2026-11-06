// Lineage legend, accessible table alternative and node details panel (benchmark §7.3 / §8).
import { ArrowRight, BadgeCheck, Copy, ExternalLink, KeyRound, Lock, ShieldCheck, ShieldHalf, ShieldOff, Zap } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { assetHref, fmtNum } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { LineageGraph, LineageNode } from "../../lib/types";
import { Badge, Button, useToast } from "../ui";
import { CertBadge, ShieldBadge } from "../workspace/chips";
import { fmtRelative, humanize } from "../workspace/format";
import { NODE_META, nodeMeta, tileStyle } from "./meta";
import { EDGE_COLORS, edgeVisual, isServerCluster, reachFromFocus } from "./model";

// ------------------------------------------------------------------------------------------------ legend
function EdgeSample({ kind, undeclared = false, weight = 0 }: { kind: "declared" | "observed" | "data"; undeclared?: boolean; weight?: number }) {
  const v = edgeVisual({ edge_kind: kind, weight_30d: weight, undeclared });
  return (
    <svg width={44} height={12} aria-hidden className="shrink-0">
      <line x1={2} y1={6} x2={42} y2={6} stroke={v.stroke} strokeWidth={v.width} strokeDasharray={v.dash} strokeLinecap={v.cap} />
    </svg>
  );
}

export function LineageLegend({ types, className }: { types?: string[]; className?: string }) {
  const shown = (types?.length ? types : Object.keys(NODE_META)).filter((t, i, a) => a.indexOf(t) === i);
  return (
    <div className={cx("space-y-3 text-ui-xs", className)}>
      <div>
        <div className="mb-1.5 font-semibold uppercase tracking-wider text-muted-foreground">Edges</div>
        <ul className="space-y-1.5">
          <li className="flex items-center gap-2"><EdgeSample kind="declared" /> Declared (config, tool list, subscription)</li>
          <li className="flex items-center gap-2"><EdgeSample kind="observed" weight={2000} /> Observed (thicker = more calls in 30 d)</li>
          <li className="flex items-center gap-2"><EdgeSample kind="observed" undeclared weight={300} /> Observed but undeclared</li>
          <li className="flex items-center gap-2"><EdgeSample kind="data" /> Data (Unity Catalog lineage)</li>
          <li className="flex items-center gap-2">
            <svg width={44} height={12} aria-hidden className="shrink-0"><line x1={2} y1={6} x2={42} y2={6} stroke={EDGE_COLORS.impacted} strokeWidth={2.5} /></svg>
            Impacted path (impact highlight)
          </li>
        </ul>
        <p className="mt-2 flex items-center gap-1 text-muted-foreground">
          Dependencies on the left <ArrowRight size={12} aria-hidden /> the assets that use them on the right.
        </p>
      </div>
      <div>
        <div className="mb-1.5 font-semibold uppercase tracking-wider text-muted-foreground">Nodes</div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {shown.map((t) => {
            const m = nodeMeta(t);
            const Icon = m.icon;
            return (
              <li key={t} className="flex items-center gap-2">
                <span aria-hidden style={tileStyle(m.shape)} className={cx("grid h-5 w-5 shrink-0 place-items-center", m.tile)}>
                  <Icon size={11} />
                </span>
                {m.label}
              </li>
            );
          })}
          <li className="flex items-center gap-2">
            <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted text-muted-foreground"><Lock size={11} /></span>
            Restricted
          </li>
        </ul>
      </div>
      <div>
        <div className="mb-1.5 font-semibold uppercase tracking-wider text-muted-foreground">Shields</div>
        <ul className="space-y-1">
          <li className="flex items-center gap-2"><BadgeCheck size={13} className="text-success" aria-hidden /> Certified</li>
          <li className="flex items-center gap-2"><ShieldCheck size={13} className="text-success" aria-hidden /> Policies: full coverage</li>
          <li className="flex items-center gap-2"><ShieldHalf size={13} className="text-warning" aria-hidden /> Policies: partial</li>
          <li className="flex items-center gap-2"><ShieldOff size={13} className="text-destructive" aria-hidden /> Policies: none</li>
        </ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ table
export interface LineageRow {
  key: string;
  direction: string;
  sort: number;
  type: string;
  nodeId: string;
  name: string;
  via: string | null;
  edgeKind: string;
  relation: string;
  weight: number;
  lastSeen: string | null;
  undeclared: boolean;
  impacted: boolean;
}

/** One row per edge, named by its far end relative to the focus (Direction · Type · Name · Edge kind · Weight · Last seen). */
export function lineageRows(graph: Pick<LineageGraph, "nodes" | "edges" | "focus">): LineageRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const reach = reachFromFocus(graph.nodes, graph.edges, graph.focus);
  const hopsOf = (id: string) => reach.get(id)?.hops ?? Number.MAX_SAFE_INTEGER;
  return graph.edges
    .map((e) => {
      const far = hopsOf(e.src) >= hopsOf(e.dst) ? e.src : e.dst;
      const near = far === e.src ? e.dst : e.src;
      const r = reach.get(far);
      const node = byId.get(far);
      const direction = !r
        ? "Related"
        : r.side === "upstream"
          ? `Upstream · ${r.hops} hop${r.hops === 1 ? "" : "s"}`
          : r.side === "downstream"
            ? `Downstream · ${r.hops} hop${r.hops === 1 ? "" : "s"}`
            : r.side === "focus"
              ? "Focus"
              : `Related · ${r.hops} hops`;
      return {
        key: `${e.src}|${e.dst}|${e.relation}|${e.edge_kind}`,
        direction,
        sort: (r?.side === "upstream" ? 0 : r?.side === "downstream" ? 1 : 2) * 100 + (r?.hops ?? 99),
        type: nodeMeta(node?.type ?? "external").label,
        nodeId: far,
        name: node?.label ?? far,
        via: near !== graph.focus ? byId.get(near)?.label ?? near : null,
        edgeKind: e.edge_kind,
        relation: e.relation,
        weight: e.weight_30d,
        lastSeen: e.last_seen,
        undeclared: !!e.undeclared,
        impacted: !!e.impacted,
      };
    })
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export function LineageTable({ graph, impactMode = false, onSelect }: { graph: LineageGraph; impactMode?: boolean; onSelect?: (node: LineageNode) => void }) {
  const rows = useMemo(() => lineageRows(graph), [graph]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  if (rows.length === 0) return <p className="py-8 text-center text-ui-sm text-muted-foreground">No edges in this view.</p>;
  return (
    <div className="max-h-[620px] overflow-auto rounded-xl border border-border">
      <table className="w-full text-ui-sm">
        <caption className="sr-only">Lineage edges relative to the focus</caption>
        <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
          <tr className="text-left text-muted-foreground">
            {["Direction", "Type", "Name", "Edge kind", "Weight (30 d)", "Last seen"].map((h) => (
              <th key={h} scope="col" className={cx("px-3 py-2 font-semibold", h.startsWith("Weight") && "text-right")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const node = byId.get(r.nodeId);
            const meta = nodeMeta(node?.type ?? "external");
            return (
              <tr key={r.key} className={cx("border-t border-border/70", impactMode && !r.impacted && "opacity-50")}>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.direction}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.type}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {node && onSelect ? (
                      <button type="button" onClick={() => onSelect(node)} className="font-semibold hover:text-primary hover:underline">
                        {r.name}
                      </button>
                    ) : meta.asset && node && !node.restricted ? (
                      <Link to={assetHref(r.nodeId)} className="font-semibold hover:text-primary hover:underline">{r.name}</Link>
                    ) : (
                      <span className="font-semibold">{r.name}</span>
                    )}
                    {node?.restricted && <Badge icon={<Lock size={11} aria-hidden />}>Restricted</Badge>}
                    {impactMode && r.impacted && <Badge variant="primary" icon={<Zap size={11} aria-hidden />}>Impacted</Badge>}
                  </div>
                  {r.via && <div className="text-ui-xs text-muted-foreground">via {r.via}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <EdgeSample kind={r.edgeKind as "declared" | "observed" | "data"} undeclared={r.undeclared} weight={r.weight} />
                    {humanize(r.edgeKind)}
                    {r.undeclared && <Badge variant="warning">Undeclared</Badge>}
                  </span>
                  <div className="text-ui-xs text-muted-foreground">{humanize(r.relation)}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.edgeKind === "observed" ? fmtNum(r.weight) : "–"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtRelative(r.lastSeen)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ details
export function LineageDetails({
  node,
  graph,
  onFocus,
  onClose,
}: {
  node: LineageNode;
  graph: LineageGraph;
  onFocus?: (node: LineageNode) => void;
  onClose?: () => void;
}) {
  const toast = useToast();
  const meta = nodeMeta(node.type);
  const Icon = node.restricted ? Lock : meta.icon;
  const uses = graph.edges.filter((e) => e.src === node.id);
  const usedBy = graph.edges.filter((e) => e.dst === node.id);
  const observed = [...uses, ...usedBy].filter((e) => e.edge_kind === "observed").reduce((s, e) => s + e.weight_30d, 0);
  const serverCluster = isServerCluster(node);
  const isAsset = meta.asset && !serverCluster;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.id);
      toast.success("Copied the node id");
    } catch {
      toast.error("Couldn't copy", "The clipboard isn't available in this browser context.");
    }
  };
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-start gap-3">
        <span aria-hidden style={tileStyle(meta.shape)} className={cx("grid h-10 w-10 shrink-0 place-items-center", node.restricted ? "bg-muted text-muted-foreground" : meta.tile)}>
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">{meta.label}{node.subtype && !serverCluster ? ` · ${humanize(node.subtype)}` : ""}</div>
          <h3 className="break-words text-ui-lg font-bold leading-tight">{node.label}</h3>
          <button type="button" onClick={copy} className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-ui-xs text-muted-foreground hover:text-foreground" title="Copy id">
            <span className="truncate">{node.id}</span>
            <Copy size={11} aria-hidden className="shrink-0" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {node.focus && <Badge variant="primary">Focus</Badge>}
        {node.impacted && <Badge variant="primary" icon={<Zap size={11} aria-hidden />}>Impacted</Badge>}
        {node.restricted && <Badge icon={<Lock size={11} aria-hidden />}>Restricted</Badge>}
        <CertBadge certification={node.certification ?? null} />
        <ShieldBadge shield={node.policy_shield ?? null} />
      </div>

      {node.restricted ? (
        <div className="rounded-lg border border-border bg-muted/50 p-3 text-ui-sm">
          <div className="flex items-center gap-2 font-semibold"><KeyRound size={14} aria-hidden /> You can't see this node's details</div>
          <p className="mt-1 text-muted-foreground">
            {serverCluster
              ? "Individual consumers are visible to the asset's owners, stewards, admins and auditors."
              : "It isn't registered, or your role can't view it. Restricted nodes can't be expanded."}
          </p>
          {isAsset && (
            <Link to={assetHref(node.id, "access")} className="mt-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              Request access <ArrowRight size={13} aria-hidden />
            </Link>
          )}
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-3 text-ui-sm">
          <div>
            <dt className="text-ui-xs text-muted-foreground">Owner</dt>
            <dd className="truncate font-semibold" title={node.owner ?? undefined}>{node.owner ?? (isAsset ? "Ownerless" : "–")}</dd>
          </div>
          <div>
            <dt className="text-ui-xs text-muted-foreground">Observed calls (30 d)</dt>
            <dd className="font-semibold tabular-nums">{fmtNum(observed)}</dd>
          </div>
          <div>
            <dt className="text-ui-xs text-muted-foreground">Uses</dt>
            <dd className="font-semibold">{uses.length}</dd>
          </div>
          <div>
            <dt className="text-ui-xs text-muted-foreground">Used by</dt>
            <dd className="font-semibold">{usedBy.length}</dd>
          </div>
        </dl>
      )}

      {(uses.length > 0 || usedBy.length > 0) && (
        <div className="space-y-3 text-ui-sm">
          {uses.length > 0 && (
            <div>
              <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">Depends on</div>
              <ul className="space-y-1">
                {uses.slice(0, 8).map((e) => (
                  <li key={`${e.dst}-${e.relation}-${e.edge_kind}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">{label(e.dst)}</span>
                    <span className="shrink-0 text-ui-xs text-muted-foreground">{humanize(e.edge_kind)}{e.undeclared ? " · undeclared" : ""}</span>
                  </li>
                ))}
                {uses.length > 8 && <li className="text-ui-xs text-muted-foreground">+{uses.length - 8} more</li>}
              </ul>
            </div>
          )}
          {usedBy.length > 0 && (
            <div>
              <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">Used by</div>
              <ul className="space-y-1">
                {usedBy.slice(0, 8).map((e) => (
                  <li key={`${e.src}-${e.relation}-${e.edge_kind}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">{label(e.src)}</span>
                    <span className="shrink-0 text-ui-xs text-muted-foreground">{humanize(e.edge_kind)}{e.edge_kind === "observed" ? ` · ${fmtNum(e.weight_30d)}` : ""}</span>
                  </li>
                ))}
                {usedBy.length > 8 && <li className="text-ui-xs text-muted-foreground">+{usedBy.length - 8} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
        {isAsset && !node.restricted && (
          <Link to={assetHref(node.id)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground hover:brightness-110">
            <ExternalLink size={14} aria-hidden /> Open entity page
          </Link>
        )}
        {onFocus && !node.restricted && !node.focus && !serverCluster && (
          <Button variant="secondary" onClick={() => onFocus(node)}>Focus here</Button>
        )}
        {onClose && <Button variant="ghost" onClick={onClose}>Close</Button>}
      </div>
    </div>
  );
}
