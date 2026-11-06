// "How It Works": the registry's architecture as a four-lane animated story (Discover → Measure → Govern →
// Consume & impact), what it tracks, how reads stay up when a dependency is down, and the live platform status.
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity, BellRing, Boxes, Cable, CheckCheck, Coins, Database, FileClock, FlaskConical, GitBranch, KeyRound, Mail, PenLine,
  Gauge, ScrollText, ShieldCheck, UserCheck, Workflow,
} from "lucide-react";
import FlowDiagram, { type FlowEdge, type FlowNode } from "../components/FlowDiagram";
import SourcePill from "../components/SourcePill";
import { Badge, Card, ENTITY_TYPES, PageHeader, SectionTitle, Skeleton, TYPE_TONE, TypeBadge, type EntityType } from "../components/ui";
import { useApi } from "../lib/api";
import { stagger, staggerItem } from "../lib/motion";
import type { Health } from "../lib/session";

const PRIMARY = "hsl(var(--primary))";
const TEAL = "hsl(var(--db-teal))";
const ORANGE = "hsl(var(--db-orange))";
const LAVA = "hsl(var(--db-lava))";
const IC = { size: 15, "aria-hidden": true } as const;

export const LANES: { n: number; title: string; color: string; range: string; body: string }[] = [
  { n: 1, title: "Discover", color: PRIMARY, range: "1–3", body: "A sync job's collectors call the Databricks APIs (serving endpoints, Agent Bricks, Genie, UC connections and MCP services, UC functions, UC skills, apps) and upsert every agent, MCP server, tool and skill into one Lakebase registry." },
  { n: 2, title: "Measure", color: TEAL, range: "4–7", body: "The same collectors read gateway and serving usage, billing priced at list price, the access audit log and MLflow traces and evals, so every asset carries requests, users, cost and quality." },
  { n: 3, title: "Govern", color: ORANGE, range: "8–12", body: "Owners edit descriptions; admins override synced fields with a reason and provenance; access requests go to the owner and become a real UC or endpoint grant; policies roll up into coverage." },
  { n: 4, title: "Consume & impact", color: LAVA, range: "13–18", body: "People register their email when they subscribe or use an asset, which draws lineage. When a change is published its impact is frozen, everyone affected is notified, and each one acknowledges." },
];

const W = 1180;
const H = 712;
const Y = [36, 218, 400, 598];

const NODES: FlowNode[] = [
  // Lane 1 · Discover
  { id: "apis", x: 20, y: Y[0], w: 340, h: 96, step: 1, title: "Databricks APIs", subtitle: "serving endpoints · Agent Bricks · Genie · UC connections & MCP services · UC functions · UC skills · apps", icon: <Cable {...IC} />, accent: PRIMARY },
  { id: "collect", x: 450, y: Y[0], w: 220, step: 2, title: "Collectors (sync job)", subtitle: "scheduled job · Sync now · run history", icon: <Workflow {...IC} />, accent: PRIMARY },
  { id: "registry", x: 920, y: Y[0], w: 240, step: 3, title: "Lakebase registry", subtitle: "assets · fields · grants · lineage · audit", icon: <Boxes {...IC} />, accent: PRIMARY },
  // Lane 2 · Measure
  { id: "usage", x: 20, y: Y[1], w: 205, step: 4, title: "Gateway & serving usage", subtitle: "system.ai_gateway.usage · system.serving.endpoint_usage", icon: <Activity {...IC} />, accent: TEAL },
  { id: "billing", x: 245, y: Y[1], w: 205, step: 5, title: "Billing × list prices", subtitle: "system.billing.usage × list_prices", icon: <Coins {...IC} />, accent: TEAL },
  { id: "audit", x: 470, y: Y[1], w: 205, step: 6, title: "Access audit", subtitle: "system.access.audit", icon: <ScrollText {...IC} />, accent: TEAL },
  { id: "mlflow", x: 695, y: Y[1], w: 205, step: 7, title: "MLflow traces & evals", subtitle: "traces · assessments · scorers", icon: <FlaskConical {...IC} />, accent: TEAL },
  // Lane 3 · Govern
  { id: "owners", x: 20, y: Y[2], w: 205, step: 8, title: "Owners edit descriptions", subtitle: "purpose · SLA · support · provenance", icon: <PenLine {...IC} />, accent: ORANGE },
  { id: "override", x: 245, y: Y[2], w: 205, step: 9, title: "Admins override fields", subtitle: "synced value kept · reason · drift", icon: <UserCheck {...IC} />, accent: ORANGE },
  { id: "request", x: 470, y: Y[2], w: 205, step: 10, title: "Access request", subtitle: "justification · tool subset · SLA", icon: <KeyRound {...IC} />, accent: ORANGE },
  { id: "grant", x: 695, y: Y[2], w: 205, step: 11, title: "Owner approves → grant", subtitle: "UC GRANT · endpoint ACL · expiry", icon: <ShieldCheck {...IC} />, accent: ORANGE },
  { id: "policies", x: 920, y: Y[2], w: 240, step: 12, title: "Policies & coverage", subtitle: "guardrails · budgets · coverage %", icon: <Gauge {...IC} />, accent: ORANGE },
  // Lane 4 · Consume & impact
  { id: "subscribe", x: 20, y: Y[3], w: 172, step: 13, title: "Subscribe or use", subtitle: "email registered", icon: <Mail {...IC} />, accent: LAVA },
  { id: "lineage", x: 218, y: Y[3], w: 172, step: 14, title: "Lineage edges", subtitle: "declared · observed · data", icon: <GitBranch {...IC} />, accent: LAVA },
  { id: "change", x: 416, y: Y[3], w: 172, step: 15, title: "Change published", subtitle: "version · breaking · date", icon: <FileClock {...IC} />, accent: LAVA },
  { id: "impact", x: 614, y: Y[3], w: 172, step: 16, title: "Impact frozen", subtitle: "subscribers · downstream", icon: <Database {...IC} />, accent: LAVA },
  { id: "notify", x: 812, y: Y[3], w: 172, step: 17, title: "Notify", subtitle: "in-app · email", icon: <BellRing {...IC} />, accent: LAVA },
  { id: "ack", x: 1010, y: Y[3], w: 150, step: 18, title: "Acknowledge", subtitle: "fine · migrate · help", icon: <CheckCheck {...IC} />, accent: LAVA },
];

function edges(dots: (n: number) => number): FlowEdge[] {
  return [
    { from: "apis", to: "collect", color: PRIMARY, dots: dots(2), label: "metadata" },
    { from: "collect", to: "registry", color: PRIMARY, dots: dots(3), label: "upsert" },
    { from: "usage", to: "collect", fromSide: "top", toSide: "bottom", color: TEAL, dots: dots(2) },
    { from: "billing", to: "collect", fromSide: "top", toSide: "bottom", color: TEAL, dots: dots(2), label: "usage · cost" },
    { from: "audit", to: "collect", fromSide: "top", toSide: "bottom", color: TEAL, dots: dots(2) },
    { from: "mlflow", to: "collect", fromSide: "top", toSide: "bottom", color: TEAL, dots: dots(2), label: "quality" },
    { from: "registry", to: "policies", fromSide: "bottom", toSide: "top", color: ORANGE, dots: dots(3), label: "governed in the app" },
    { from: "owners", to: "override", color: ORANGE, dots: dots(1), dashed: true },
    { from: "override", to: "request", color: ORANGE, dots: dots(1), dashed: true },
    { from: "request", to: "grant", color: ORANGE, dots: dots(3) },
    { from: "grant", to: "policies", color: ORANGE, dots: dots(2) },
    { from: "grant", to: "subscribe", fromSide: "bottom", toSide: "top", color: LAVA, dots: dots(3), label: "access → use" },
    { from: "subscribe", to: "lineage", color: LAVA, dots: dots(2) },
    { from: "lineage", to: "change", color: LAVA, dots: dots(2) },
    { from: "change", to: "impact", color: LAVA, dots: dots(2) },
    { from: "impact", to: "notify", color: LAVA, dots: dots(2) },
    { from: "notify", to: "ack", color: LAVA, dots: dots(2) },
  ];
}

const ENTITY_COPY: Record<EntityType, string> = {
  agent: "A deployed LLM application, such as a model serving endpoint or a Databricks App, that plans and calls tools.",
  mcp: "A Model Context Protocol server, managed on Databricks or hosted externally, that exposes tools and resources.",
  tool: "One callable capability an agent can invoke: a Unity Catalog function, an MCP tool or an HTTP API.",
  skill: "A packaged, versioned set of instructions and resources an assistant loads to perform a task.",
};

const TIERS: { source: "lakebase" | "warehouse" | "synthetic" | "live"; title: string; body: string }[] = [
  { source: "lakebase", title: "Lakebase first", body: "The registry of record. Reads and governed writes go here." },
  { source: "warehouse", title: "Warehouse fallback", body: "If Lakebase is unreachable, reads fall back to the SQL warehouse and system tables." },
  { source: "synthetic", title: "Labeled synthetic", body: "As a last resort a page shows clearly labeled synthetic data instead of an error." },
  { source: "live", title: "Live API", body: "Some views call Databricks APIs directly and say so." },
];

function PlatformStatus() {
  const { data, source, asOf, loading, error } = useApi<Health>("/api/health");
  const rows: { label: string; value: string; ok: boolean | null }[] = data
    ? [
        { label: "Lakebase", value: data.lakebase.ok ? `connected${data.lakebase.latency_ms != null ? ` · ${data.lakebase.latency_ms} ms` : ""}` : data.lakebase.error ?? "unavailable", ok: data.lakebase.ok },
        { label: "SQL warehouse", value: !data.warehouse.configured ? "not configured" : data.warehouse.ok ? (data.warehouse.state ?? "reachable").toLowerCase() : data.warehouse.error ?? "unreachable", ok: data.warehouse.configured ? !!data.warehouse.ok : null },
        { label: "Changes", value: data.allow_mutations ? "enabled" : "read-only mode", ok: data.allow_mutations },
        { label: "Version", value: data.version, ok: null },
      ]
    : [];
  return (
    <Card>
      <SectionTitle title="Platform status" subtitle="Live from /api/health" actions={<SourcePill source={source} asOf={asOf} />} />
      {loading && !data ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : error ? (
        <p className="text-ui-sm text-destructive">The backend did not answer: {error.message}</p>
      ) : (
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5">
              <dt className="text-ui-sm text-muted-foreground">{r.label}</dt>
              <dd className="flex min-w-0 items-center gap-2 text-ui-sm font-semibold">
                {r.ok !== null && <span aria-hidden className={r.ok ? "h-2 w-2 shrink-0 rounded-full bg-success" : "h-2 w-2 shrink-0 rounded-full bg-warning"} />}
                <span className="truncate" title={r.value}>{r.value}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

export default function HowItWorks() {
  const reduce = useReducedMotion();
  const flowEdges = edges((n) => (reduce ? 0 : n));
  return (
    <div className="space-y-8">
      <PageHeader
        icon={<Workflow size={20} aria-hidden />}
        title="How It Works"
        subtitle="Agent Registry Hub discovers every AI agent, MCP server, tool and skill in your Databricks workspace, measures how each one is used, what it costs and how well it performs, governs who may use it, and tells the people who depend on it when it changes."
      />

      <Card className="!p-4">
        <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Lanes">
          {LANES.map((l) => (
            <li key={l.n} className="inline-flex items-center gap-2 text-ui-sm font-semibold">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
              Lane {l.n} · {l.title}
              <span className="font-mono text-ui-xs font-normal text-muted-foreground">steps {l.range}</span>
            </li>
          ))}
        </ul>
        <div role="img" aria-label="Architecture flow: Databricks APIs and system tables feed the collectors, which upsert a Lakebase registry; the registry is governed through edits, overrides, access requests and policies; subscriptions and usage draw lineage, and published changes are frozen into an impact list, notified and acknowledged.">
          <FlowDiagram nodes={NODES} edges={flowEdges} width={W} height={H} />
        </div>
      </Card>

      <section aria-labelledby="hiw-steps">
        <h2 id="hiw-steps" className="sr-only">Steps</h2>
        <motion.ol variants={stagger} initial="hidden" animate="show" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map((l) => (
            <motion.li key={l.n} variants={staggerItem}>
              <Card className="h-full !p-4" style={{ borderTop: `3px solid ${l.color}` }}>
                <div className="flex items-center gap-2">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
                  <span className="font-mono text-ui-xs" style={{ color: l.color }}>STEPS {l.range}</span>
                </div>
                <div className="mt-1 text-ui-md font-bold">Lane {l.n} · {l.title}</div>
                <p className="mt-1 text-ui-sm text-muted-foreground">{l.body}</p>
              </Card>
            </motion.li>
          ))}
        </motion.ol>
      </section>

      <section aria-labelledby="hiw-entities">
        <SectionTitle id="hiw-entities" title="What the registry tracks" subtitle="Four asset types, one catalog" />
        <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {(Object.keys(ENTITY_TYPES) as EntityType[]).map((type) => {
            const Icon = ENTITY_TYPES[type].icon;
            return (
              <motion.div key={type} variants={staggerItem}>
                <Card interactive className="h-full !p-4">
                  <div className="flex items-center justify-between">
                    <span className={`grid h-9 w-9 place-items-center rounded-lg ${TYPE_TONE[type]}`}>
                      <Icon size={18} aria-hidden />
                    </span>
                    <TypeBadge type={type} />
                  </div>
                  <div className="mt-3 text-ui-md font-bold">{ENTITY_TYPES[type].plural}</div>
                  <p className="mt-1 text-ui-sm text-muted-foreground">{ENTITY_COPY[type]}</p>
                </Card>
              </motion.div>
            );
          })}
        </motion.div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle title="Never a blank screen" subtitle="Every page shows where its data came from" actions={<Badge variant="success">reads never fail</Badge>} />
          <ul className="space-y-3">
            {TIERS.map((t) => (
              <li key={t.source} className="flex items-start gap-3">
                <SourcePill source={t.source} className="mt-0.5 shrink-0" />
                <div>
                  <div className="text-ui-base font-semibold">{t.title}</div>
                  <div className="text-ui-sm text-muted-foreground">{t.body}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <PlatformStatus />
      </div>
    </div>
  );
}
