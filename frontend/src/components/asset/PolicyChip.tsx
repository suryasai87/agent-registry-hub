// Policy chips (benchmark §7.2) grouped Access / Guardrails / Rate limits / Budgets / Tool allowlist / Data,
// each with an origin marker (platform default, Unity Gateway, Serving AI Gateway, registry) and inherited flag.
import { Ban, Coins, Database, Gauge, KeyRound, ListChecks, ShieldCheck, type LucideIcon } from "lucide-react";
import type { PolicyChip as Chip } from "../../lib/types";
import { cx } from "../../lib/cx";
import { Tooltip } from "../ui";
import { humanize } from "./meta";

export type PolicyGroup = "access" | "guardrails" | "rate_limits" | "budgets" | "tools" | "data";

export const POLICY_GROUPS: { id: PolicyGroup; label: string; icon: LucideIcon }[] = [
  { id: "access", label: "Access", icon: KeyRound },
  { id: "guardrails", label: "Guardrails", icon: ShieldCheck },
  { id: "rate_limits", label: "Rate limits", icon: Gauge },
  { id: "budgets", label: "Budgets", icon: Coins },
  { id: "tools", label: "Tool allowlist", icon: ListChecks },
  { id: "data", label: "Data", icon: Database },
];

export function policyGroup(kind: string): PolicyGroup {
  const k = kind.toLowerCase();
  if (/(access|grant|permission|approval|acl)/.test(k)) return "access";
  if (/(rate|qpm|throttle|limit)/.test(k) && !/budget/.test(k)) return "rate_limits";
  if (/(budget|spend|cost)/.test(k)) return "budgets";
  if (/(tool|allowlist|selection)/.test(k)) return "tools";
  if (/(data|row_filter|mask|column|retention|logging|inference)/.test(k)) return "data";
  return "guardrails";
}

export function policyOrigin(chip: Pick<Chip, "provider" | "inherited_from">): string {
  const p = chip.provider.toLowerCase();
  if (p.includes("unity_gateway") || p === "uc_gateway" || p === "unity") return "Unity Gateway";
  if (p.includes("serving") || p === "ai_gateway") return "Serving AI Gateway";
  if (p === "registry" || p === "app") return "registry";
  if (p === "platform" || p === "default" || p.includes("platform")) return "platform default";
  if (p === "uc" || p.includes("unity_catalog")) return "Unity Catalog";
  return humanize(chip.provider);
}

const ORIGIN_TONE: Record<string, string> = {
  "Unity Gateway": "border-db-teal/40 text-db-teal",
  "Serving AI Gateway": "border-info/40 text-info",
  registry: "border-primary/40 text-primary",
  "platform default": "border-border text-muted-foreground",
};

export default function PolicyChip({ chip, className, actions }: { chip: Chip; className?: string; actions?: React.ReactNode }) {
  const group = POLICY_GROUPS.find((g) => g.id === policyGroup(chip.kind)) ?? POLICY_GROUPS[1];
  const Icon = chip.action.toLowerCase().includes("block") ? Ban : group.icon;
  const origin = policyOrigin(chip);
  const proposed = chip.status === "proposed";
  const label = [humanize(chip.kind), chip.phase && chip.phase !== "none" ? humanize(chip.phase) : null, humanize(chip.action)].filter(Boolean).join(" · ");
  return (
    <div
      className={cx(
        "flex min-w-0 items-start gap-2.5 rounded-xl border bg-card px-3 py-2",
        proposed ? "border-dashed border-warning/50" : "border-border",
        className,
      )}
    >
      <span className={cx("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg", proposed ? "bg-warning/15 text-warning" : "bg-primary/12 text-primary")}>
        <Icon size={14} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tooltip content={<span className="whitespace-pre-wrap">{chip.summary || label}</span>}>
            <span tabIndex={0} className="truncate text-ui-base font-semibold">
              {chip.name}
            </span>
          </Tooltip>
          {proposed && <span className="rounded-full border border-warning/40 bg-warning/12 px-1.5 text-ui-xs font-semibold text-warning">Proposed</span>}
        </div>
        <div className="text-ui-xs text-muted-foreground">{label}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className={cx("rounded-full border px-1.5 py-px text-ui-xs font-medium", ORIGIN_TONE[origin] ?? "border-border text-muted-foreground")} aria-label={`Origin: ${origin}`}>
            {origin}
          </span>
          {chip.inherited_from && <span className="rounded-full border border-border px-1.5 py-px text-ui-xs text-muted-foreground">inherited from {chip.inherited_from}</span>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
