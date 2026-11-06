// Entity header (benchmark §4.1): breadcrumb, icon + name + source pill, URN with copy, type/subtype/trust/
// sensitivity/risk badges, the two status axes (lifecycle + runtime), version (published vs latest), owners +
// sponsor (amber banner when ownerless), the KPI ribbon, a primary CTA by role and state, and an overflow menu.
import {
  Activity,
  BadgeCheck,
  BellPlus,
  BellRing,
  ChevronRight,
  CirclePause,
  CirclePlay,
  ClipboardCheck,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  GitBranch,
  Archive,
  Hourglass,
  KeyRound,
  Pencil,
  Rocket,
  TriangleAlert,
  UserX,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { DataSource } from "../../lib/api";
import { useApi } from "../../lib/api";
import { fmtNum, fmtPct, subtypeLabel } from "../../lib/assets";
import type { AssetAccess, AssetDetail } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Avatar, Badge, Button, PageHeader, Tooltip } from "../ui";
import { AssetIcon } from "./AssetCard";
import { useAsset, endpointOf } from "./AssetContext";
import { AssetTypeBadge, LifecycleBadge, RiskBadge, RuntimeBadge, SensitivityBadge, SourceChip, TrustBadge, accountableOwners } from "./badges";
import { daysSince, fmtUsdUnit, per1k } from "./format";
import KpiRibbon from "./KpiRibbon";
import { TYPE_PLURAL } from "./meta";
import { Banner, CopyButton, MenuButton, copyText, type MenuItemDef } from "./primitives";

const I = { size: 15, "aria-hidden": true } as const;

interface Cta {
  key: string;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  hint?: string;
}

export function evidenceHref(assetId: string): string {
  return `/api/audit/export?format=csv&entity_type=asset&entity_id=${encodeURIComponent(assetId)}`;
}

/** Primary CTA by role and state (benchmark §4.1 table). */
export function primaryCta(detail: AssetDetail, opts: { isAuditor: boolean; pendingDays: number | null; endpoint: string | null }, act: {
  publish: () => void;
  review: () => void;
  certify: () => void;
  request: () => void;
  subscribe: () => void;
  use: () => void;
  copyEndpoint: () => void;
  showRequest: () => void;
}): Cta {
  const a = detail.asset;
  const p = detail.permissions;
  if (a.my.owner && p.can_publish) return { key: "publish", label: "Publish new version", icon: <Rocket {...I} />, onClick: act.publish };
  if (p.can_curate) {
    if (a.lifecycle_status === "discovered" || a.lifecycle_status === "pending_approval") return { key: "review", label: "Review", icon: <ClipboardCheck {...I} />, onClick: act.review };
    if (a.certification !== "certified") return { key: "certify", label: "Certify", icon: <BadgeCheck {...I} />, onClick: act.certify };
  }
  if (opts.isAuditor && !p.can_edit) return { key: "evidence", label: "Export evidence", icon: <Download {...I} />, href: evidenceHref(a.asset_id), external: true };
  if (!a.my.has_access && a.my.requested)
    return { key: "pending", label: opts.pendingDays != null ? `Request pending · day ${opts.pendingDays}` : "Request pending", icon: <Hourglass {...I} />, onClick: act.showRequest };
  if (!a.my.has_access && !a.my.owner) return { key: "request", label: "Request access", icon: <KeyRound {...I} />, onClick: act.request };
  if (!a.my.subscribed) return { key: "subscribe", label: "Subscribe", icon: <BellPlus {...I} />, onClick: act.subscribe };
  if (opts.endpoint) return { key: "copy", label: a.asset_type === "mcp_server" ? "Copy MCP URL" : "Copy endpoint", icon: <Copy {...I} />, onClick: act.copyEndpoint };
  return { key: "use", label: "I'm using this", icon: <Activity {...I} />, onClick: act.use };
}

function CtaButton({ cta, variant = "primary" }: { cta: Cta; variant?: "primary" | "secondary" }) {
  if (cta.href)
    return (
      <a
        href={cta.href}
        {...(cta.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={
          variant === "primary"
            ? "inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-ui-base font-semibold text-primary-foreground shadow-sm hover:brightness-110"
            : "inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-secondary px-3.5 text-ui-base font-semibold hover:border-primary/40"
        }
      >
        {cta.icon}
        {cta.label}
      </a>
    );
  return (
    <Button variant={variant} icon={cta.icon} onClick={cta.onClick} title={cta.hint}>
      {cta.label}
    </Button>
  );
}

export default function AssetHeader({ source, degradedReason, asOf }: { source: DataSource | null; degradedReason: string | null; asOf: string | null }) {
  const ctx = useAsset();
  const { detail, assetId, base } = ctx;
  const a = detail.asset;
  const p = detail.permissions;
  const navigate = useNavigate();
  const myAccess = useApi<AssetAccess>(a.my.requested && !a.my.has_access ? `${base}/access` : null, [ctx.refreshKey]);
  const pending = (myAccess.data?.my_requests ?? []).filter((r) => r.status === "pending" || r.status === "provisioning");
  const oldest = pending.length ? pending.reduce((x, y) => (x.created_at < y.created_at ? x : y)) : null;
  const endpoint = endpointOf(detail);
  const owners = accountableOwners(a.owners);
  const sponsors = a.owners.filter((o) => o.kind === "sponsor");
  const support = detail.fields.find((f) => f.field_key === "support_channel")?.value;
  const cost1k = per1k(a.kpi.cost_30d_usd, a.kpi.requests_30d);

  const copyEndpoint = () => {
    if (!endpoint) return;
    void copyText(endpoint);
    ctx.openUse("copied_endpoint", endpoint);
  };

  const cta = primaryCta(
    detail,
    { isAuditor: ctx.isAuditor, pendingDays: oldest ? daysSince(oldest.created_at) : null, endpoint },
    {
      publish: () => ctx.goTab("changes", { publish: "1" }),
      review: () => navigate("/governance?tab=curation"),
      certify: ctx.openGovernance,
      request: ctx.openRequest,
      subscribe: ctx.openSubscribe,
      use: () => ctx.openUse("registered_use"),
      copyEndpoint,
      showRequest: () => ctx.goTab("access"),
    },
  );

  const secondary: Cta | null =
    cta.key === "subscribe"
      ? null
      : a.my.subscribed
        ? { key: "subscribed", label: "Subscribed", icon: <BellRing {...I} />, onClick: () => ctx.goTab("subscribers"), hint: "You get change notifications. Manage on the Subscribers tab." }
        : { key: "subscribe2", label: "Subscribe", icon: <BellPlus {...I} />, onClick: ctx.openSubscribe };

  const menu: MenuItemDef[] = [
    { id: "copy-urn", label: "Copy URN", icon: <Copy size={14} aria-hidden />, onSelect: () => void copyText(assetId) },
    ...(endpoint ? [{ id: "copy-endpoint", label: a.asset_type === "mcp_server" ? "Copy MCP URL" : "Copy endpoint URL", icon: <Copy size={14} aria-hidden />, onSelect: copyEndpoint }] : []),
    ...(a.deep_link ? [{ id: "open-db", label: "Open in Databricks", icon: <ExternalLink size={14} aria-hidden />, onSelect: () => void window.open(a.deep_link!, "_blank", "noopener,noreferrer") }] : []),
    { id: "use", label: "I'm using this", icon: <Activity size={14} aria-hidden />, onSelect: () => ctx.openUse("registered_use") },
    { id: "lineage", label: "Open full lineage", icon: <GitBranch size={14} aria-hidden />, onSelect: () => navigate(`/lineage?focus=${encodeURIComponent(assetId)}`) },
  ];
  if (a.my.owner || p.can_edit) menu.push({ id: "edit", label: "Edit description", icon: <Pencil size={14} aria-hidden />, onSelect: () => ctx.goTab("overview") });
  if (p.can_publish && !(a.my.owner && cta.key === "publish")) menu.push({ id: "publish", label: "Publish a change", icon: <Rocket size={14} aria-hidden />, onSelect: () => ctx.goTab("changes", { publish: "1" }) });
  if (p.can_curate && cta.key !== "certify") menu.push({ id: "review", label: "Review governance", icon: <BadgeCheck size={14} aria-hidden />, onSelect: ctx.openGovernance });
  if (p.can_view_all_usage || ctx.isAuditor) menu.push({ id: "evidence", label: "Export evidence (CSV)", icon: <Download size={14} aria-hidden />, onSelect: () => void window.open(evidenceHref(assetId), "_blank", "noopener") });
  if (p.can_pause) {
    menu.push(
      a.runtime_status === "paused"
        ? { id: "resume", label: "Resume", icon: <CirclePlay size={14} aria-hidden />, onSelect: () => ctx.openRuntime("resume") }
        : { id: "pause", label: "Pause", icon: <CirclePause size={14} aria-hidden />, onSelect: () => ctx.openRuntime("pause"), danger: true },
    );
  }
  if (p.can_publish && a.lifecycle_status !== "deprecated" && a.lifecycle_status !== "retired")
    menu.push({ id: "deprecate", label: "Deprecate", icon: <TriangleAlert size={14} aria-hidden />, onSelect: () => ctx.openRuntime("deprecate"), danger: true });
  if (p.can_publish && a.lifecycle_status === "deprecated") menu.push({ id: "retire", label: "Retire", icon: <Archive size={14} aria-hidden />, onSelect: () => ctx.openRuntime("retire"), danger: true });

  const version =
    a.published_version || a.latest_version ? (
      <span className="inline-flex items-center gap-1.5 text-ui-sm">
        <span className="text-muted-foreground">Version</span>
        {a.published_version && <Badge variant="success">v{a.published_version.replace(/^v/i, "")} published</Badge>}
        {a.latest_version && a.latest_version !== a.published_version && <Badge variant="info">v{a.latest_version.replace(/^v/i, "")} latest</Badge>}
      </span>
    ) : null;

  return (
    <div className="mb-5 space-y-4">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-ui-sm text-muted-foreground">
          <li>
            <Link to="/catalog" className="hover:text-foreground">
              Catalog
            </Link>
          </li>
          <ChevronRight size={13} aria-hidden />
          <li>
            <Link to={`/catalog?type=${a.asset_type}`} className="hover:text-foreground">
              {TYPE_PLURAL[a.asset_type]}
            </Link>
          </li>
          {detail.parent && (
            <>
              <ChevronRight size={13} aria-hidden />
              <li>
                <Link to={`/assets/${encodeURIComponent(detail.parent.asset_id)}`} className="hover:text-foreground">
                  {detail.parent.display_name}
                </Link>
              </li>
            </>
          )}
          <ChevronRight size={13} aria-hidden />
          <li aria-current="page" className="font-medium text-foreground">
            {a.display_name}
          </li>
        </ol>
      </nav>

      <PageHeader
        icon={<AssetIcon type={a.asset_type} size={40} className="!bg-transparent" />}
        title={a.display_name}
        source={<SourcePill source={source} degradedReason={degradedReason} asOf={asOf} />}
        subtitle={
          <span className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono text-ui-sm" title={assetId}>
              {assetId}
            </code>
            <CopyButton value={assetId} label="Copy URN" />
          </span>
        }
        actions={
          <>
            <CtaButton cta={cta} />
            {secondary && <CtaButton cta={secondary} variant="secondary" />}
            <MenuButton label="More actions" icon={<Ellipsis size={16} aria-hidden />} items={menu} />
          </>
        }
      />

      <div className="-mt-3 flex flex-wrap items-center gap-2">
        <AssetTypeBadge type={a.asset_type} />
        {a.subtype && <Badge>{subtypeLabel(a.subtype)}</Badge>}
        <TrustBadge certification={a.certification} />
        <SensitivityBadge sensitivity={a.sensitivity} />
        <RiskBadge risk={a.risk_tier} />
        <SourceChip card={a} />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-ui-sm">
          <span className="text-muted-foreground">Status</span>
          <LifecycleBadge status={a.lifecycle_status} />
          <RuntimeBadge status={a.runtime_status} />
        </span>
        {version}
        <span className="inline-flex flex-wrap items-center gap-2 text-ui-sm">
          <span className="text-muted-foreground">Owners</span>
          {owners.length ? (
            owners.map((o) => (
              <Tooltip key={`${o.email}-${o.kind}`} content={`${o.email} · ${o.kind === "co_owner" ? "co-owner" : "owner"} · ${o.source}`}>
                <span tabIndex={0} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-0.5 pl-0.5 pr-2">
                  <Avatar email={o.email} name={o.display_name} size={20} />
                  <span className="font-medium">{o.display_name || o.email}</span>
                </span>
              </Tooltip>
            ))
          ) : (
            <span className="font-medium text-warning">None</span>
          )}
        </span>
        {sponsors.length > 0 && (
          <span className="inline-flex items-center gap-2 text-ui-sm">
            <span className="text-muted-foreground">Sponsor</span>
            {sponsors.map((o) => (
              <span key={o.email} className="inline-flex items-center gap-1.5">
                <Avatar email={o.email} name={o.display_name} size={20} />
                <span className="font-medium">{o.display_name || o.email}</span>
              </span>
            ))}
          </span>
        )}
        {typeof support === "string" && support.trim() && (
          <span className="inline-flex items-center gap-1.5 text-ui-sm">
            <span className="text-muted-foreground">Support</span>
            <span className="font-medium">{support}</span>
          </span>
        )}
      </div>

      {owners.length === 0 && (
        <Banner
          tone="warning"
          role="status"
          icon={<UserX size={16} aria-hidden />}
          title="This asset has no active owner"
          actions={
            p.can_curate ? (
              <Link to="/governance?tab=curation" className="inline-flex h-8 items-center rounded-lg border border-warning/50 px-3 text-ui-sm font-semibold text-foreground hover:bg-warning/15">
                Assign owner
              </Link>
            ) : undefined
          }
        >
          Nobody is accountable for changes, access decisions or incidents. {p.can_curate ? "Assign an owner from the curation queue." : "A steward has been asked to assign one."}
        </Banner>
      )}

      <KpiRibbon
        label="Last 30 days"
        items={[
          { key: "req", label: "Requests · 30 d", value: fmtNum(a.kpi.requests_30d), icon: <Activity size={12} aria-hidden /> },
          { key: "users", label: "Active users", value: fmtNum(a.kpi.users_30d), icon: <UsersRound size={12} aria-hidden /> },
          { key: "unit", label: "$ / 1k requests", value: fmtUsdUnit(cost1k), hint: "Estimated (list price)", tooltip: `$${a.kpi.cost_30d_usd.toFixed(2)} ÷ ${a.kpi.requests_30d.toLocaleString()} requests × 1000` },
          { key: "err", label: "Error rate", value: fmtPct(a.kpi.error_rate), tone: (a.kpi.error_rate ?? 0) >= 0.05 ? "destructive" : (a.kpi.error_rate ?? 0) >= 0.01 ? "warning" : "default" },
          { key: "cov", label: "Policy coverage", value: `${Math.round(a.coverage_pct)}%`, tone: a.coverage_pct >= 80 ? "success" : a.coverage_pct >= 50 ? "warning" : "destructive", hint: a.policy_shield === "full" ? "Fully governed" : a.policy_shield === "partial" ? "Partially governed" : "No policies attached" },
        ]}
      />
    </div>
  );
}
