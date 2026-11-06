// Tools: MCP servers list the tools they expose; agents list the tools, agents and skills they use; a tool shows
// its schema; a skill its capabilities. Rows: side-effect class, 30 d calls, error rate, policy shield and the
// input schema in an expandable JSON viewer. Ranked by throughput, top 10 with "Show more". Unity Catalog MCP
// services (mcp:service:*) also get the tool-selection editor (include_tool_selectors) above the list.
import { motion } from "framer-motion";
import { ChevronDown, Search, Wrench } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAsset } from "../../components/asset/AssetContext";
import { AssetTypeBadge, CardStatus, PolicyShield, SideEffectBadge, TrustBadge } from "../../components/asset/badges";
import { sideEffectOf, TYPE_PLURAL } from "../../components/asset/meta";
import Markdown from "../../components/asset/Markdown";
import { DataTable, DefinitionList, ErrorCard, JsonViewer, TableSkeleton, Td, Th } from "../../components/asset/primitives";
import SourcePill from "../../components/SourcePill";
import ToolSelectionEditor from "../../components/asset/ToolSelectionEditor";
import { Button, Card, EmptyState, IconButton, Input, SectionTitle } from "../../components/ui";
import { useApi } from "../../lib/api";
import { assetHref, fmtAgo, fmtNum, fmtPct } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AssetCard, AssetType } from "../../lib/types";

type ToolRow = AssetCard & { attributes?: Record<string, unknown> };

const TOP = 10;

export function schemaOf(attributes: Record<string, unknown> | null | undefined): unknown {
  const a = attributes ?? {};
  return a.input_schema ?? a.inputSchema ?? a.schema ?? a.parameters ?? null;
}

function ToolTable({ rows, label }: { rows: ToolRow[]; label: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <DataTable label={label}>
      <thead>
        <tr>
          <Th>
            <span className="sr-only">Expand</span>
          </Th>
          <Th>Name</Th>
          <Th>Type</Th>
          <Th>Side effects</Th>
          <Th>Status</Th>
          <Th align="right">30 d calls</Th>
          <Th align="right">Error rate</Th>
          <Th>Policy</Th>
          <Th>Last changed</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const expanded = open === t.asset_id;
          const schema = schemaOf(t.attributes);
          const effect = sideEffectOf(t.attributes);
          return (
            <Fragment key={t.asset_id}>
              <tr className={cx("hover:bg-accent/40", (effect === "write" || effect === "destructive") && "bg-warning/5")}>
                <Td className="w-10">
                  <IconButton
                    size="sm"
                    label={expanded ? `Hide details for ${t.display_name}` : `Show details for ${t.display_name}`}
                    aria-expanded={expanded}
                    icon={<ChevronDown size={14} aria-hidden className={cx("transition-transform", !expanded && "-rotate-90")} />}
                    onClick={() => setOpen(expanded ? null : t.asset_id)}
                  />
                </Td>
                <Td className="min-w-[200px]">
                  <Link to={assetHref(t.asset_id)} className="font-semibold hover:text-primary">
                    {t.display_name}
                  </Link>
                  {t.purpose && <span className="block max-w-md truncate text-ui-xs text-muted-foreground">{t.purpose}</span>}
                </Td>
                <Td>
                  <AssetTypeBadge type={t.asset_type} />
                </Td>
                <Td>
                  <SideEffectBadge effect={effect} />
                </Td>
                <Td>
                  <CardStatus card={t} />
                </Td>
                <Td align="right">{fmtNum(t.kpi.requests_30d)}</Td>
                <Td align="right">{fmtPct(t.kpi.error_rate)}</Td>
                <Td>
                  <PolicyShield shield={t.policy_shield} coveragePct={t.coverage_pct} />
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">{fmtAgo(t.last_changed_at)}</Td>
              </tr>
              {expanded && (
                <tr>
                  <Td colSpan={9} className="bg-muted/20">
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="grid gap-3 py-1 lg:grid-cols-2">
                      <DefinitionList
                        items={[
                          { label: "URN", value: <span className="break-all font-mono text-ui-xs">{t.asset_id}</span> },
                          { label: "Trust", value: <TrustBadge certification={t.certification} /> },
                          { label: "Users · 30 d", value: fmtNum(t.kpi.users_30d) },
                          { label: "Subscribers", value: fmtNum(t.subscribers) },
                        ]}
                      />
                      {schema ? <JsonViewer value={schema} label="Input schema" defaultOpen /> : <p className="text-ui-sm text-muted-foreground">No input schema was published for this tool.</p>}
                    </motion.div>
                  </Td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </DataTable>
  );
}

function OwnSchema() {
  const { detail } = useAsset();
  const a = detail.asset;
  const schema = schemaOf(a.attributes);
  const effect = sideEffectOf(a.attributes);
  const output = (a.attributes ?? {}).output_schema ?? (a.attributes ?? {}).outputSchema ?? null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        {schema ? <JsonViewer value={schema} label="Input schema" defaultOpen /> : <EmptyState icon={<Wrench size={20} aria-hidden />} title="No input schema published" description="The source did not report an input schema for this tool. Ask the owner to document Inputs on the Overview tab." />}
        {output != null && <JsonViewer value={output} label="Output schema" />}
      </div>
      <Card className="space-y-3">
        <h3 className="text-ui-md font-bold">Behaviour</h3>
        <DefinitionList
          items={[
            { label: "Side effects", value: <SideEffectBadge effect={effect} /> },
            { label: "Idempotent", value: (a.attributes ?? {}).idempotentHint === true ? "Yes (idempotentHint)" : (a.attributes ?? {}).idempotentHint === false ? "No" : "Not declared" },
            { label: "Parent", value: detail.parent ? <Link className="text-primary hover:underline" to={assetHref(detail.parent.asset_id)}>{detail.parent.display_name}</Link> : "–" },
            { label: "Access", value: detail.parent ? "Inherited from the parent server" : "Granted on this tool" },
          ]}
        />
      </Card>
    </div>
  );
}

function SkillDoc() {
  const { detail } = useAsset();
  const attrs = detail.asset.attributes ?? {};
  const body = typeof attrs.skill_md === "string" ? attrs.skill_md : typeof attrs.body === "string" ? attrs.body : null;
  const allowed = Array.isArray(attrs.allowed_tools) ? (attrs.allowed_tools as unknown[]).map(String) : Array.isArray(attrs["allowed-tools"]) ? (attrs["allowed-tools"] as unknown[]).map(String) : [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>{body ? <Markdown source={body} /> : <p className="text-ui-sm text-muted-foreground">The SKILL.md body is not stored in the registry. See the description on the Overview tab.</p>}</Card>
      <Card className="space-y-3">
        <h3 className="text-ui-md font-bold">Package</h3>
        <DefinitionList
          items={[
            { label: "License", value: typeof attrs.license === "string" ? attrs.license : "–" },
            { label: "Version", value: detail.asset.published_version ?? detail.asset.latest_version ?? "–" },
            { label: "Allowed tools", value: allowed.length ? allowed.join(", ") : "Not restricted" },
          ]}
        />
      </Card>
    </div>
  );
}

export default function ToolsTab() {
  const { detail, base, refreshKey } = useAsset();
  const type: AssetType = detail.asset.asset_type;
  const tools = useApi<ToolRow[]>(`${base}/tools`, [refreshKey]);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => [...(tools.data ?? [])].sort((x, y) => y.kpi.requests_30d - x.kpi.requests_30d), [tools.data]);
  const filtered = q.trim() ? sorted.filter((t) => `${t.display_name} ${t.name} ${t.asset_id} ${t.purpose ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) : sorted;
  const groups = type === "agent" ? (["mcp_server", "tool", "agent", "skill"] as AssetType[]).map((g) => [g, filtered.filter((t) => t.asset_type === g)] as const).filter(([, xs]) => xs.length) : null;
  const visible = showAll || q.trim() ? filtered : filtered.slice(0, TOP);
  const risky = sorted.filter((t) => ["write", "destructive"].includes(sideEffectOf(t.attributes))).length;

  const title = { agent: "Tools, agents & skills it uses", mcp_server: "Tools exposed", tool: "Schema", skill: "Capabilities" }[type];
  const subtitle = {
    agent: "From declared configuration and observed calls (lineage). Write and destructive tools are flagged for review.",
    mcp_server: "Every tool this server exposes, ranked by 30-day calls.",
    tool: "Input contract and behaviour hints for this tool.",
    skill: "The skill's instructions, package and the agents that use it.",
  }[type];

  return (
    <div className="space-y-5">
      {type === "mcp_server" && detail.asset.asset_id.startsWith("mcp:service:") && <ToolSelectionEditor />}
      {(type === "tool" || type === "skill") && (
        <section className="space-y-3">
          <SectionTitle title={title} subtitle={subtitle} />
          {type === "tool" ? <OwnSchema /> : <SkillDoc />}
        </section>
      )}
      {type !== "tool" && (
        <section className="space-y-3">
          <SectionTitle
            title={type === "skill" ? "Used by / bundles" : title}
            subtitle={type === "skill" ? "Registered assets linked to this skill." : subtitle}
            actions={
              <>
                <SourcePill source={tools.source} degradedReason={tools.degradedReason} asOf={tools.asOf} />
                {sorted.length > 5 && <Input aria-label="Filter tools" icon={<Search size={14} aria-hidden />} placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-48" />}
              </>
            }
          />
          {risky > 0 && <p className="text-ui-sm text-warning">{risky} write or destructive tool{risky === 1 ? "" : "s"}: review before granting broad access.</p>}
          {tools.error && !tools.data ? (
            <ErrorCard error={tools.error} onRetry={tools.reload} />
          ) : tools.loading && !tools.data ? (
            <TableSkeleton rows={5} cols={6} />
          ) : sorted.length === 0 ? (
            <EmptyState
              icon={<Wrench size={20} aria-hidden />}
              title={type === "mcp_server" ? "No tools registered yet" : "No dependencies recorded"}
              description={type === "mcp_server" ? "Tools appear after the next sync reads this server's tools/list." : "Declared tools and observed calls appear here once lineage records them."}
            />
          ) : groups ? (
            groups.map(([g, xs]) => (
              <div key={g} className="space-y-2">
                <h3 className="text-ui-base font-semibold">{TYPE_PLURAL[g]} <span className="text-muted-foreground">({xs.length})</span></h3>
                <ToolTable rows={xs} label={TYPE_PLURAL[g]} />
              </div>
            ))
          ) : (
            <>
              <ToolTable rows={visible} label={title} />
              {!q.trim() && filtered.length > TOP && (
                <Button size="sm" variant="secondary" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? `Show top ${TOP}` : `Show all ${filtered.length}`}
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
