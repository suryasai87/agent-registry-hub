// Trust, status, policy and relationship badges. Every one pairs colour with an icon and text (or an
// accessible label), so colour is never the only signal.
import { Bell, CircleUserRound, Info, KeyRound, ShieldCheck, ShieldHalf, ShieldOff, Hourglass, UserX } from "lucide-react";
import type { AssetCard, AssetType, Certification, Lifecycle, MyRelationship, Owner, RiskTier, Runtime, Sensitivity } from "../../lib/types";
import { cx } from "../../lib/cx";
import { Avatar, Badge, Tooltip, TypeBadge } from "../ui";
import { CERTIFICATION, ENTITY_OF, LIFECYCLE, RISK, RUNTIME, SENSITIVITY, SIDE_EFFECT, displayStatus, sourceChipLabel, type EnumMeta } from "./meta";

const I = { size: 12, "aria-hidden": true } as const;

export function AssetTypeBadge({ type, className }: { type: AssetType; className?: string }) {
  return <TypeBadge type={ENTITY_OF[type] ?? "tool"} className={className} />;
}

function MetaBadge({ meta, prefix, className }: { meta: EnumMeta; prefix?: string; className?: string }) {
  const Icon = meta.icon;
  const text = prefix ? `${prefix}: ${meta.label}` : meta.label;
  const badge = (
    <span className="inline-flex" tabIndex={meta.description ? 0 : undefined} aria-label={meta.description ? `${text}. ${meta.description}` : undefined}>
      <Badge variant={meta.variant} icon={<Icon {...I} />} className={className}>
        {prefix && <span className="font-medium opacity-80">{prefix}:</span>}
        {meta.label}
      </Badge>
    </span>
  );
  return meta.description ? <Tooltip content={meta.description}>{badge}</Tooltip> : badge;
}

export function TrustBadge({ certification, className }: { certification: Certification; className?: string }) {
  return <MetaBadge meta={CERTIFICATION[certification] ?? CERTIFICATION.unreviewed} className={cx(certification === "unreviewed" && "!bg-transparent", className)} />;
}

export function LifecycleBadge({ status, className }: { status: Lifecycle; className?: string }) {
  return <MetaBadge meta={LIFECYCLE[status] ?? LIFECYCLE.discovered} className={className} />;
}

export function RuntimeBadge({ status, className }: { status: Runtime; className?: string }) {
  return <MetaBadge meta={RUNTIME[status] ?? RUNTIME.unknown} prefix="Runtime" className={className} />;
}

export function SensitivityBadge({ sensitivity, className }: { sensitivity: Sensitivity; className?: string }) {
  return <MetaBadge meta={SENSITIVITY[sensitivity] ?? SENSITIVITY.internal} prefix="Sensitivity" className={className} />;
}

export function RiskBadge({ risk, className }: { risk: RiskTier; className?: string }) {
  const meta = RISK[risk] ?? RISK.medium;
  return <MetaBadge meta={{ ...meta, label: meta.label.replace(" risk", "") }} prefix="Risk" className={className} />;
}

/** A status dot + label ("● Live"). The label carries the meaning; the dot is decoration. */
export function StatusDot({ meta, className }: { meta: EnumMeta; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-ui-sm font-medium", className)}>
      <span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-full ring-2 ring-background", meta.dot)} />
      <span>{meta.label}</span>
    </span>
  );
}

export function CardStatus({ card, className }: { card: Pick<AssetCard, "lifecycle_status" | "runtime_status">; className?: string }) {
  return <StatusDot meta={displayStatus(card)} className={className} />;
}

const SHIELD = {
  full: { icon: ShieldCheck, label: "Fully governed", tone: "text-success", description: "Every required policy for its risk tier is in place" },
  partial: { icon: ShieldHalf, label: "Partially governed", tone: "text-warning", description: "Some required policies are missing" },
  none: { icon: ShieldOff, label: "No policies", tone: "text-muted-foreground", description: "No guardrail, rate limit or budget applies" },
} as const;

/** MuleSoft-style policy shield: full / partial / none, with coverage % in the tooltip. */
export function PolicyShield({ shield, coveragePct, showLabel = false, className }: { shield: AssetCard["policy_shield"]; coveragePct?: number | null; showLabel?: boolean; className?: string }) {
  const s = SHIELD[shield] ?? SHIELD.none;
  const Icon = s.icon;
  const text = `${s.label}${coveragePct != null ? ` · ${Math.round(coveragePct)}% coverage` : ""}`;
  return (
    <Tooltip content={`${text}. ${s.description}`}>
      <span tabIndex={0} role="img" aria-label={`Policy coverage: ${text}`} className={cx("inline-flex items-center gap-1 text-ui-xs font-semibold", s.tone, className)}>
        <Icon size={14} aria-hidden />
        {showLabel ? <span>{text}</span> : coveragePct != null && <span className="tabular-nums">{Math.round(coveragePct)}%</span>}
      </span>
    </Tooltip>
  );
}

export function SourceChip({ card, className }: { card: Pick<AssetCard, "source" | "platform" | "publisher">; className?: string }) {
  const label = sourceChipLabel(card);
  return (
    <span title={label} className={cx("inline-flex max-w-full items-center truncate rounded-full border border-border bg-background/40 px-2 py-0.5 text-ui-xs font-medium text-muted-foreground", className)}>
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The viewer's relationship to an asset: Owner, Has access / Requested, Subscribed. */
export function RelationshipPills({ my, className }: { my: MyRelationship; className?: string }) {
  const pills: { key: string; label: string; variant: "primary" | "success" | "warning" | "info"; icon: typeof Bell }[] = [];
  if (my.owner) pills.push({ key: "owner", label: "Owner", variant: "primary", icon: CircleUserRound });
  if (my.has_access) pills.push({ key: "access", label: "Has access", variant: "success", icon: KeyRound });
  else if (my.requested) pills.push({ key: "requested", label: "Requested", variant: "warning", icon: Hourglass });
  if (my.subscribed) pills.push({ key: "subscribed", label: "Subscribed", variant: "info", icon: Bell });
  if (pills.length === 0) return null;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)} aria-label={`Your relationship: ${pills.map((p) => p.label).join(", ")}`}>
      {pills.map((p) => (
        <Badge key={p.key} variant={p.variant} icon={<p.icon {...I} />}>
          {p.label}
        </Badge>
      ))}
    </span>
  );
}

export function OwnerlessChip({ className }: { className?: string }) {
  return (
    <Tooltip content="No active owner or co-owner. A steward should assign one.">
      <span tabIndex={0} className="inline-flex">
        <Badge variant="warning" icon={<UserX {...I} />} className={className}>
          Ownerless
        </Badge>
      </span>
    </Tooltip>
  );
}

export function accountableOwners(owners: Owner[]): Owner[] {
  return owners.filter((o) => o.kind === "owner" || o.kind === "co_owner");
}

const KIND_LABEL: Record<Owner["kind"], string> = { owner: "Owner", co_owner: "Co-owner", sponsor: "Sponsor", steward: "Steward" };

/** Overlapping avatars (owners first, then sponsor), max ``max`` + "+N"; an amber Ownerless chip when none. */
export function OwnerStack({ owners, max = 3, size = 24, className }: { owners: Owner[]; max?: number; size?: number; className?: string }) {
  if (accountableOwners(owners).length === 0) {
    const sponsor = owners.find((o) => o.kind === "sponsor");
    return (
      <span className={cx("inline-flex items-center gap-1.5", className)}>
        <OwnerlessChip />
        {sponsor && <Avatar email={sponsor.email} name={sponsor.display_name} size={size} />}
      </span>
    );
  }
  const order: Owner["kind"][] = ["owner", "co_owner", "sponsor", "steward"];
  const sorted = [...owners].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const shown = sorted.slice(0, max);
  const label = sorted.map((o) => `${o.display_name || o.email} (${KIND_LABEL[o.kind]})`).join(", ");
  return (
    <Tooltip content={label}>
      <span tabIndex={0} role="img" aria-label={`Owners: ${label}`} className={cx("inline-flex items-center", className)}>
        {shown.map((o, i) => (
          <span key={`${o.email}-${o.kind}`} className={cx("rounded-full ring-2 ring-card", i > 0 && "-ml-2")}>
            <Avatar email={o.email} name={o.display_name} size={size} />
          </span>
        ))}
        {sorted.length > max && (
          <span className="-ml-2 grid place-items-center rounded-full bg-muted font-semibold text-muted-foreground ring-2 ring-card text-ui-xs" style={{ width: size, height: size }}>
            +{sorted.length - max}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

export function SideEffectBadge({ effect, className }: { effect: string; className?: string }) {
  const meta = SIDE_EFFECT[effect] ?? SIDE_EFFECT.unknown;
  return (
    <Tooltip content={meta.description}>
      <span tabIndex={0} className="inline-flex" aria-label={`${meta.label}. ${meta.description}`}>
        <Badge variant={meta.variant} className={className}>
          {meta.label}
        </Badge>
      </span>
    </Tooltip>
  );
}

/** "Estimated (list price)" marker for every money figure. */
export function EstimatedTag({ className }: { className?: string }) {
  return (
    <Tooltip content="USD at Databricks list price, from system billing tables. Billing data lags by a few hours, so figures can differ from invoices and near-real-time budgets.">
      <span tabIndex={0} className={cx("inline-flex items-center gap-1 text-ui-xs font-medium text-muted-foreground", className)}>
        <Info size={11} aria-hidden />
        Estimated (list price)
      </span>
    </Tooltip>
  );
}
