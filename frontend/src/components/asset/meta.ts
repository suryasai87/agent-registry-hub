// Labels, tones and icons for the registry's enums (lifecycle, runtime, trust, sensitivity, risk, source).
// One place, so the catalog facets, cards, header and tables always say the same thing.
import {
  Ban,
  BadgeCheck,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleStop,
  Hourglass,
  Lock,
  Pencil,
  Radar,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { AssetCard, AssetType, Certification, Lifecycle, RiskTier, Runtime, Sensitivity } from "../../lib/types";
import type { BadgeVariant, EntityType } from "../ui";

export const ENTITY_OF: Record<AssetType, EntityType> = { agent: "agent", mcp_server: "mcp", tool: "tool", skill: "skill" };

export const TYPE_PLURAL: Record<AssetType, string> = { agent: "Agents", mcp_server: "MCP servers", tool: "Tools", skill: "Skills" };

export interface EnumMeta {
  label: string;
  variant: BadgeVariant;
  icon: LucideIcon;
  /** Tailwind background class for a status dot. */
  dot: string;
  description?: string;
}

export const LIFECYCLE: Record<Lifecycle, EnumMeta> = {
  discovered: { label: "Discovered", variant: "neutral", icon: Radar, dot: "bg-muted-foreground", description: "Found by a sync; not yet curated by a steward" },
  draft: { label: "Draft", variant: "info", icon: Pencil, dot: "bg-info", description: "Registered but not yet submitted for approval" },
  pending_approval: { label: "Pending approval", variant: "warning", icon: Hourglass, dot: "bg-warning", description: "Waiting for a steward to approve it" },
  approved: { label: "Live", variant: "success", icon: CircleCheck, dot: "bg-success", description: "Approved and available to consumers" },
  rejected: { label: "Rejected", variant: "destructive", icon: Ban, dot: "bg-destructive", description: "A steward rejected this registration" },
  deprecated: { label: "Deprecated", variant: "warning", icon: TriangleAlert, dot: "bg-warning", description: "Still available, but scheduled for retirement" },
  retired: { label: "Retired", variant: "neutral", icon: CircleStop, dot: "bg-muted-foreground", description: "No longer available" },
};

export const RUNTIME: Record<Runtime, EnumMeta> = {
  running: { label: "Running", variant: "success", icon: CircleDot, dot: "bg-success" },
  stopped: { label: "Stopped", variant: "neutral", icon: CircleStop, dot: "bg-muted-foreground" },
  paused: { label: "Paused", variant: "warning", icon: CirclePause, dot: "bg-warning" },
  blocked: { label: "Blocked", variant: "destructive", icon: Ban, dot: "bg-destructive" },
  degraded: { label: "Degraded", variant: "warning", icon: TriangleAlert, dot: "bg-warning" },
  unknown: { label: "Unknown", variant: "neutral", icon: CircleDashed, dot: "bg-muted-foreground" },
};

export const CERTIFICATION: Record<Certification, EnumMeta> = {
  certified: { label: "Certified", variant: "success", icon: BadgeCheck, dot: "bg-success", description: "Reviewed and certified by a data steward" },
  verified_publisher: { label: "Verified publisher", variant: "info", icon: ShieldCheck, dot: "bg-info", description: "The publisher's identity is verified by the source registry or vendor listing" },
  unreviewed: { label: "Unreviewed", variant: "neutral", icon: CircleDashed, dot: "bg-muted-foreground", description: "Not yet reviewed by a steward" },
  deprecated: { label: "Deprecated", variant: "warning", icon: TriangleAlert, dot: "bg-warning", description: "A steward marked this asset deprecated; plan a migration" },
};

export const SENSITIVITY: Record<Sensitivity, EnumMeta> = {
  public: { label: "Public", variant: "neutral", icon: CircleDot, dot: "bg-muted-foreground" },
  internal: { label: "Internal", variant: "info", icon: CircleDot, dot: "bg-info" },
  confidential: { label: "Confidential", variant: "warning", icon: Lock, dot: "bg-warning" },
  restricted: { label: "Restricted", variant: "destructive", icon: Lock, dot: "bg-destructive" },
};

export const RISK: Record<RiskTier, EnumMeta> = {
  low: { label: "Low risk", variant: "success", icon: CircleDot, dot: "bg-success" },
  medium: { label: "Medium risk", variant: "info", icon: CircleDot, dot: "bg-info" },
  high: { label: "High risk", variant: "warning", icon: TriangleAlert, dot: "bg-warning" },
  critical: { label: "Critical risk", variant: "destructive", icon: TriangleAlert, dot: "bg-destructive" },
};

export const SOURCE_LABEL: Record<AssetCard["source"], string> = { databricks: "Databricks", external: "External", custom: "Custom" };

const PLATFORM_LABEL: Record<string, string> = {
  model_serving: "Model Serving",
  serving: "Model Serving",
  agent_bricks: "Agent Bricks",
  databricks_apps: "Databricks Apps",
  apps: "Databricks Apps",
  genie: "Genie",
  unity_catalog: "Unity Catalog",
  uc: "Unity Catalog",
  unity_gateway: "Unity Gateway",
  ai_gateway: "AI Gateway",
  mlflow: "MLflow",
  microsoft_365: "Microsoft 365",
  m365: "Microsoft 365",
  marketplace: "Marketplace",
  registry: "Registry",
  app: "Registry app",
  github: "GitHub",
  slack: "Slack",
  external: "External",
  databricks_system_mcp: "Databricks-provided MCP",
  system_mcp: "Databricks-provided MCP",
  managed_mcp: "Managed MCP",
  custom_mcp: "Custom MCP",
};

/** Human label for a platform / facet value: known names, else snake_case → Title Case. */
export function humanize(value: string | null | undefined): string {
  if (!value) return "–";
  const known = PLATFORM_LABEL[value.toLowerCase()];
  if (known) return known;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** "Databricks · Model Serving", "External · Microsoft 365", "Custom · Databricks Apps". */
export function sourceChipLabel(card: Pick<AssetCard, "source" | "platform" | "publisher">): string {
  const where = card.source === "external" ? card.publisher || humanize(card.platform) : humanize(card.platform);
  return `${SOURCE_LABEL[card.source] ?? humanize(card.source)} · ${where}`;
}

/** The single status a card shows: runtime problems win over the lifecycle label. */
export function displayStatus(card: Pick<AssetCard, "lifecycle_status" | "runtime_status">): EnumMeta {
  const runtime = RUNTIME[card.runtime_status];
  if (card.lifecycle_status === "approved" && runtime && ["paused", "blocked", "stopped", "degraded"].includes(card.runtime_status)) return runtime;
  return LIFECYCLE[card.lifecycle_status] ?? LIFECYCLE.discovered;
}

export const FACET_LABELS: Record<string, (value: string) => string> = {
  asset_type: (v) => TYPE_PLURAL[v as AssetType] ?? humanize(v),
  source: (v) => (v === "databricks" ? "Databricks-provided" : SOURCE_LABEL[v as AssetCard["source"]] ?? humanize(v)),
  platform: humanize,
  lifecycle_status: (v) => LIFECYCLE[v as Lifecycle]?.label ?? humanize(v),
  certification: (v) => CERTIFICATION[v as Certification]?.label ?? humanize(v),
  sensitivity: (v) => SENSITIVITY[v as Sensitivity]?.label ?? humanize(v),
  risk_tier: (v) => RISK[v as RiskTier]?.label.replace(" risk", "") ?? humanize(v),
};

export const SIDE_EFFECT: Record<string, { label: string; variant: BadgeVariant; description: string }> = {
  read: { label: "Read-only", variant: "success", description: "Declares no side effects (readOnlyHint)" },
  write: { label: "Writes", variant: "warning", description: "Changes data or state; review before granting" },
  destructive: { label: "Destructive", variant: "destructive", description: "May delete or overwrite data (destructiveHint)" },
  unknown: { label: "Side effects unknown", variant: "neutral", description: "The tool does not declare read/write hints" },
};

/** read | write | destructive | unknown from a tool's attributes (side_effect, or MCP annotations hints). */
export function sideEffectOf(attributes: Record<string, unknown> | null | undefined): keyof typeof SIDE_EFFECT {
  const a = attributes ?? {};
  const declared = typeof a.side_effect === "string" ? a.side_effect : null;
  if (declared && declared in SIDE_EFFECT) return declared;
  const ann = (typeof a.annotations === "object" && a.annotations !== null ? a.annotations : a) as Record<string, unknown>;
  if (ann.readOnlyHint === true) return "read";
  if (ann.destructiveHint === true) return "destructive";
  if (ann.readOnlyHint === false) return "write";
  return "unknown";
}
