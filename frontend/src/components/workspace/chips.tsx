// Status chips and small identity pieces shared by the workspace, changes, requests and governance pages.
// Every chip pairs its colour with an icon and text (colour is never the only signal).
import {
  BadgeCheck, CircleCheck, CircleDashed, CircleHelp, CircleX, Clock, Hourglass, LifeBuoy, LoaderCircle, ShieldCheck,
  ShieldHalf, ShieldOff, Timer, TimerOff, TriangleAlert, Undo2, type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { assetHref } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AckStatus, AssetType, Certification, RequestStatus, Role } from "../../lib/types";
import { Avatar, Badge, ENTITY_TYPES, TypeBadge, type BadgeVariant, type EntityType } from "../ui";
import { fmtDate, fmtRelative, humanize } from "./format";

export const ENTITY_OF: Record<AssetType, EntityType> = { agent: "agent", mcp_server: "mcp", tool: "tool", skill: "skill" };

export function AssetTypeBadge({ type, className }: { type: AssetType | null | undefined; className?: string }) {
  if (!type || !ENTITY_OF[type]) return null;
  return <TypeBadge type={ENTITY_OF[type]} className={className} />;
}

/** The asset's display name as a link to its entity page, with its type icon. */
export function AssetLink({ assetId, name, type, tab, className }: { assetId: string; name?: string | null; type?: AssetType | null; tab?: string; className?: string }) {
  const Icon = type && ENTITY_OF[type] ? ENTITY_TYPES[ENTITY_OF[type]].icon : null;
  return (
    <Link to={assetHref(assetId, tab)} className={cx("inline-flex min-w-0 items-center gap-1.5 font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline", className)} title={assetId}>
      {Icon && <Icon size={14} aria-hidden className="shrink-0 text-muted-foreground" />}
      <span className="truncate">{name || assetId}</span>
    </Link>
  );
}

export function Person({ email, name, size = 22, className, sub }: { email: string; name?: string | null; size?: number; className?: string; sub?: string | null }) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-2", className)}>
      <Avatar email={email} name={name} size={size} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-ui-sm font-semibold" title={email}>{name || email}</span>
        {sub && <span className="truncate text-ui-xs text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}

const REQUEST_STATUS: Record<RequestStatus, { variant: BadgeVariant; icon: LucideIcon; label: string; spin?: boolean }> = {
  pending: { variant: "info", icon: Hourglass, label: "Pending" },
  approved: { variant: "success", icon: CircleCheck, label: "Approved" },
  denied: { variant: "destructive", icon: CircleX, label: "Denied" },
  expired: { variant: "neutral", icon: TimerOff, label: "Expired" },
  cancelled: { variant: "neutral", icon: Undo2, label: "Cancelled" },
  provisioning: { variant: "info", icon: LoaderCircle, label: "Provisioning…", spin: true },
  provisioned: { variant: "success", icon: BadgeCheck, label: "Provisioned" },
  provision_failed: { variant: "destructive", icon: TriangleAlert, label: "Provisioning failed" },
  revoked: { variant: "neutral", icon: ShieldOff, label: "Revoked" },
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const s = REQUEST_STATUS[status] ?? { variant: "neutral" as const, icon: CircleHelp, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant} icon={<Icon size={12} aria-hidden className={s.spin ? "animate-spin" : undefined} />}>
      {s.label}
    </Badge>
  );
}

const SLA: Record<"on_track" | "due_soon" | "overdue" | "closed", { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  on_track: { variant: "success", icon: Clock, label: "On track" },
  due_soon: { variant: "warning", icon: Timer, label: "Due soon" },
  overdue: { variant: "destructive", icon: TriangleAlert, label: "Overdue" },
  closed: { variant: "neutral", icon: CircleCheck, label: "Closed" },
};

/** SLA chip with the clock: "Due soon · in 5 h" / "Overdue · 3 h ago". */
export function SlaChip({ state, dueAt }: { state: keyof typeof SLA; dueAt?: string | null }) {
  const s = SLA[state] ?? SLA.on_track;
  const Icon = s.icon;
  const clock = state !== "closed" && dueAt ? fmtRelative(dueAt) : null;
  return (
    <Badge variant={s.variant} icon={<Icon size={12} aria-hidden />} title={dueAt ? `SLA due ${new Date(dueAt).toLocaleString()}` : undefined}>
      {s.label}
      {clock && <span className="font-normal opacity-90">· {state === "overdue" ? `due ${clock}` : clock}</span>}
    </Badge>
  );
}

export const ACK_LABEL: Record<AckStatus, string> = {
  pending: "Awaiting acknowledgement",
  not_impacted: "Not impacted",
  impacted_will_migrate: "Impacted, will migrate",
  need_help: "Needs help",
  not_required: "No ack needed",
};

const ACK: Record<AckStatus, { variant: BadgeVariant; icon: LucideIcon }> = {
  pending: { variant: "warning", icon: Hourglass },
  not_impacted: { variant: "success", icon: CircleCheck },
  impacted_will_migrate: { variant: "info", icon: Clock },
  need_help: { variant: "destructive", icon: LifeBuoy },
  not_required: { variant: "neutral", icon: CircleDashed },
};

export function AckBadge({ status, migrateBy }: { status: AckStatus; migrateBy?: string | null }) {
  const a = ACK[status] ?? ACK.pending;
  const Icon = a.icon;
  return (
    <Badge variant={a.variant} icon={<Icon size={12} aria-hidden />}>
      {ACK_LABEL[status] ?? humanize(status)}
      {status === "impacted_will_migrate" && migrateBy && <span className="font-normal">by {fmtDate(migrateBy.slice(0, 10))}</span>}
    </Badge>
  );
}

const CERT: Record<Certification, { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  certified: { variant: "success", icon: BadgeCheck, label: "Certified" },
  verified_publisher: { variant: "info", icon: ShieldCheck, label: "Verified publisher" },
  unreviewed: { variant: "neutral", icon: CircleDashed, label: "Unreviewed" },
  deprecated: { variant: "warning", icon: TriangleAlert, label: "Deprecated" },
};

export function CertBadge({ certification }: { certification: Certification | null | undefined }) {
  if (!certification) return null;
  const c = CERT[certification] ?? CERT.unreviewed;
  const Icon = c.icon;
  return (
    <Badge variant={c.variant} icon={<Icon size={12} aria-hidden />}>
      {c.label}
    </Badge>
  );
}

const SHIELD: Record<"full" | "partial" | "none", { variant: BadgeVariant; icon: LucideIcon; label: string }> = {
  full: { variant: "success", icon: ShieldCheck, label: "Policies: full" },
  partial: { variant: "warning", icon: ShieldHalf, label: "Policies: partial" },
  none: { variant: "destructive", icon: ShieldOff, label: "Policies: none" },
};

export function ShieldBadge({ shield }: { shield: "full" | "partial" | "none" | null | undefined }) {
  if (!shield) return null;
  const s = SHIELD[shield];
  const Icon = s.icon;
  return (
    <Badge variant={s.variant} icon={<Icon size={12} aria-hidden />}>
      {s.label}
    </Badge>
  );
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  steward: "Steward",
  auditor: "Auditor",
  owner: "Owner",
  consumer: "Consumer",
  viewer: "Viewer",
};

export function roleLabel(role: string | null | undefined): string {
  return role ? ROLE_LABEL[role as Role] ?? humanize(role) : "";
}

/** A tiny labelled metric for dense rows. */
export function MiniStat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="text-ui-xs text-muted-foreground">{label}</div>
      <div className="truncate text-ui-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
