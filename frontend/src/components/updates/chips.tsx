// Platform-updates chips: candidate kind and status, breaking, auto-apply, capability probe status, feed lifecycle
// hints and item status, and the relevance meter. Every chip pairs its colour with an icon and words.
import {
  Ban, BadgeCheck, CalendarClock, Check, CircleCheck, CircleDot, CircleHelp, CircleOff, CircleX, Eye, EyeOff, FlaskConical,
  Link2, LoaderCircle, Lock, Megaphone, Package, Plug, Radar, ShieldAlert, Sparkles, TriangleAlert, Zap, type LucideIcon,
} from "lucide-react";
import { cx } from "../../lib/cx";
import type { CandidateStatus, CapabilityStatus, FeedItem, UpdateCandidate } from "../../lib/types";
import { Badge, Tooltip, type BadgeVariant } from "../ui";
import { humanize } from "../workspace/format";
import { POLICY_COPY, type AutoUpgrade } from "./model";

interface ChipSpec {
  variant: BadgeVariant;
  icon: LucideIcon;
  label: string;
  spin?: boolean;
}

function Chip({ spec, title, className }: { spec: ChipSpec; title?: string; className?: string }) {
  const Icon = spec.icon;
  return (
    <Badge variant={spec.variant} title={title} className={className} icon={<Icon size={12} aria-hidden className={spec.spin ? "animate-spin" : undefined} />}>
      {spec.label}
    </Badge>
  );
}

// ------------------------------------------------------------------------------------------------ candidates
export const KIND: Record<UpdateCandidate["kind"], ChipSpec & { tile: string; describe: string }> = {
  app_release: { variant: "primary", icon: Package, label: "App release", tile: "bg-primary/15 text-primary", describe: "A newer staged version of this app, with its pending database migrations." },
  capability: { variant: "mcp", icon: Plug, label: "New capability", tile: "bg-type-mcp/15 text-type-mcp", describe: "A newly available API whose adapter ships disabled; accepting enables it." },
  advisory: { variant: "info", icon: Megaphone, label: "Advisory", tile: "bg-info/15 text-info", describe: "A relevant announcement, or a new API without an adapter yet. Acknowledge it once read." },
};

export function KindBadge({ kind }: { kind: UpdateCandidate["kind"] }) {
  const k = KIND[kind] ?? { variant: "neutral" as const, icon: CircleHelp, label: humanize(kind), describe: "" };
  return <Chip spec={k} title={k.describe} />;
}

const STATUS: Record<CandidateStatus, ChipSpec> = {
  detected: { variant: "neutral", icon: Radar, label: "Detected" },
  testing: { variant: "info", icon: LoaderCircle, label: "Testing on a branch", spin: true },
  passed: { variant: "success", icon: CircleCheck, label: "Regression passed" },
  failed: { variant: "destructive", icon: CircleX, label: "Regression failed" },
  accepted: { variant: "info", icon: Check, label: "Accepted · apply queued" },
  delayed: { variant: "warning", icon: CalendarClock, label: "Delayed" },
  rejected: { variant: "neutral", icon: Ban, label: "Rejected" },
  applying: { variant: "info", icon: LoaderCircle, label: "Applying", spin: true },
  applied: { variant: "success", icon: BadgeCheck, label: "Applied" },
  apply_failed: { variant: "destructive", icon: TriangleAlert, label: "Apply failed" },
};

export function CandidateStatusBadge({ status, kind }: { status: CandidateStatus; kind?: UpdateCandidate["kind"] }) {
  const s = STATUS[status] ?? { variant: "neutral" as const, icon: CircleHelp, label: humanize(status) };
  // An acknowledged advisory is stored as "applied": say what actually happened.
  const spec = status === "applied" && kind === "advisory" ? { ...s, label: "Acknowledged" } : s;
  return <Chip spec={spec} />;
}

export function BreakingBadge({ reasons }: { reasons?: string[] }) {
  return (
    <Badge variant="destructive" icon={<ShieldAlert size={12} aria-hidden />} title={reasons?.length ? reasons.join("\n") : "Breaking change"} className="uppercase tracking-wide">
      Breaking
    </Badge>
  );
}

export function AutoApplyChip({ policy }: { policy: AutoUpgrade }) {
  return (
    <Tooltip content={`Auto-upgrade policy: ${POLICY_COPY[policy].label}. The regression passed and the policy allows applying it without a decision.`}>
      <span tabIndex={0} className="inline-flex rounded-full">
        <Badge variant="success" icon={<Zap size={12} aria-hidden />}>Auto-apply eligible</Badge>
      </span>
    </Tooltip>
  );
}

// ------------------------------------------------------------------------------------------------ capabilities
export const CAPABILITY_STATUS: Record<CapabilityStatus, ChipSpec & { describe: string }> = {
  available: { variant: "success", icon: CircleCheck, label: "Available", describe: "The probe answered: the API works in this workspace." },
  unavailable: { variant: "neutral", icon: CircleOff, label: "Unavailable", describe: "Announced or planned, but not served here yet (404 / not enabled)." },
  no_access: { variant: "warning", icon: Lock, label: "No access", describe: "The API exists but the app's service principal isn't allowed to call it (401/403)." },
  error: { variant: "destructive", icon: CircleX, label: "Probe error", describe: "The probe failed for another reason; see the detail." },
  unknown: { variant: "neutral", icon: CircleHelp, label: "Not probed", describe: "No probe has run yet, or this capability has no probe." },
};

export function CapabilityStatusPill({ status, detail }: { status: CapabilityStatus; detail?: string | null }) {
  const s = CAPABILITY_STATUS[status] ?? CAPABILITY_STATUS.unknown;
  return <Chip spec={s} title={detail ? `${s.describe}\n${detail}` : s.describe} />;
}

// ------------------------------------------------------------------------------------------------ feed
const LIFECYCLE: Record<string, ChipSpec> = {
  ga: { variant: "success", icon: BadgeCheck, label: "GA" },
  public_preview: { variant: "info", icon: Eye, label: "Public Preview" },
  beta: { variant: "info", icon: FlaskConical, label: "Beta" },
  deprecation: { variant: "warning", icon: TriangleAlert, label: "Deprecation" },
  breaking: { variant: "destructive", icon: ShieldAlert, label: "Breaking" },
};

export function LifecycleChip({ hint }: { hint: string | null | undefined }) {
  if (!hint) return null;
  const spec = LIFECYCLE[hint] ?? { variant: "neutral" as const, icon: Sparkles, label: humanize(hint) };
  return <Chip spec={spec} title={`Lifecycle hint: ${spec.label}`} />;
}

const FEED_STATUS: Record<FeedItem["status"], ChipSpec> = {
  new: { variant: "primary", icon: CircleDot, label: "New" },
  triaged: { variant: "neutral", icon: Eye, label: "Triaged" },
  dismissed: { variant: "neutral", icon: EyeOff, label: "Dismissed" },
  linked: { variant: "info", icon: Link2, label: "Linked to a candidate" },
};

export function FeedStatusPill({ status }: { status: FeedItem["status"] }) {
  return <Chip spec={FEED_STATUS[status] ?? { variant: "neutral", icon: CircleHelp, label: humanize(status) }} />;
}

/** Relevance 0–100 as a labelled meter (the number is always shown next to the bar). */
export function RelevanceBar({ value, threshold, className }: { value: number; threshold?: number; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const tone = v >= 70 ? "bg-primary" : threshold != null && v >= threshold ? "bg-info" : "bg-muted-foreground/50";
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div role="meter" aria-label="Relevance" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-valuetext={`${v} of 100`} className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className={cx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", tone)} style={{ width: `${v}%` }} />
        {threshold != null && threshold > 0 && threshold < 100 && <div aria-hidden className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: `${threshold}%` }} />}
      </div>
      <span className="w-7 text-right font-mono text-ui-xs font-semibold tabular-nums">{v}</span>
    </div>
  );
}

