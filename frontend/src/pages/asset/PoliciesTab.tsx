// Policies & guardrails (benchmark §7.2): chips grouped Access / Guardrails / Rate limits / Budgets / Tool allowlist /
// Data with an origin marker; the coverage meter + required checklist for the risk tier; violations over 7 days;
// stewards bind library policies (owners propose), activate proposals and remove bindings.
import { motion } from "framer-motion";
import { Plus, ShieldCheck, Trash } from "lucide-react";
import { useMemo, useState } from "react";
import { useAsset } from "../../components/asset/AssetContext";
import { RiskBadge } from "../../components/asset/badges";
import CoverageMeter from "../../components/asset/CoverageMeter";
import { writeErrorMessage } from "../../components/asset/errors";
import { humanize } from "../../components/asset/meta";
import PolicyChip, { POLICY_GROUPS, policyGroup, policyOrigin } from "../../components/asset/PolicyChip";
import { ErrorCard, SectionSkeleton } from "../../components/asset/primitives";
import Sparkline from "../../components/asset/Sparkline";
import SourcePill from "../../components/SourcePill";
import { Badge, Button, Card, EmptyState, IconButton, Modal, SectionTitle, Skeleton, useToast } from "../../components/ui";
import { api, useApi } from "../../lib/api";
import { stagger, staggerItem } from "../../lib/motion";
import type { AssetPolicies, PoliciesFleet, PolicyChip as Chip, PolicyLibraryItem } from "../../lib/types";

function LibraryPicker({ open, onClose, existing, canActivate, onBind }: { open: boolean; onClose: () => void; existing: Set<string>; canActivate: boolean; onBind: (item: PolicyLibraryItem, status: "active" | "proposed") => Promise<void> }) {
  const fleet = useApi<PoliciesFleet>(open ? "/api/policies" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = (fleet.data?.library ?? []).filter((l) => !existing.has(l.policy_id));
  return (
    <Modal open={open} onClose={onClose} size="lg" title={canActivate ? "Attach a policy" : "Propose a policy"} description={canActivate ? "Bind a library policy to this asset. It takes effect immediately." : "Your proposal goes to a steward, who activates it."}>
      {fleet.error ? (
        <ErrorCard error={fleet.error} onRetry={fleet.reload} />
      ) : !fleet.data ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="Nothing left to attach" description="Every library policy already applies to this asset." className="!py-8" />
      ) : (
        <ul className="space-y-2">
          {items.map((l) => (
            <li key={l.policy_id} className="flex items-start gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0 flex-1">
                <div className="text-ui-base font-semibold">{l.name}</div>
                <div className="text-ui-xs text-muted-foreground">
                  {humanize(l.kind)} · {humanize(l.phase)} · {humanize(l.action)} · {policyOrigin({ provider: l.provider, inherited_from: null })} · applied to {l.applied_count}
                </div>
                {l.description && <p className="mt-1 text-ui-sm text-muted-foreground">{l.description}</p>}
              </div>
              <Button
                size="sm"
                loading={busy === l.policy_id}
                onClick={async () => {
                  setBusy(l.policy_id);
                  try {
                    await onBind(l, canActivate ? "active" : "proposed");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {canActivate ? "Attach" : "Propose"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function PoliciesTab() {
  const { detail, base, refreshKey, reload } = useAsset();
  const policies = useApi<AssetPolicies>(`${base}/policies`, [refreshKey]);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const p = detail.permissions;
  const canActivate = p.can_curate;
  const canPropose = p.can_publish || p.can_edit;
  const grouped = useMemo(() => {
    const chips = policies.data?.chips ?? [];
    return POLICY_GROUPS.map((g) => ({ ...g, chips: chips.filter((c) => policyGroup(c.kind) === g.id) }));
  }, [policies.data]);

  if (policies.error && !policies.data) return <ErrorCard error={policies.error} onRetry={policies.reload} />;
  if (!policies.data) return <SectionSkeleton />;
  const d = policies.data;
  const existing = new Set(d.chips.map((c) => c.policy_id));

  const bind = async (policyId: string, status: "active" | "proposed", name: string) => {
    try {
      const chip = await api.post<Chip>(`${base}/policies/${encodeURIComponent(policyId)}`, { status });
      policies.mutate((prev) => {
        const cur = prev as AssetPolicies;
        const others = cur.chips.filter((c) => c.policy_id !== chip.policy_id);
        return { ...cur, chips: [...others, chip] };
      });
      toast.success(status === "active" ? `Attached ${name}` : `Proposed ${name}`, status === "proposed" ? "A steward will review it." : undefined);
      policies.reload();
      reload();
    } catch (err) {
      toast.error("Policy not updated", writeErrorMessage(err));
      throw err;
    }
  };

  const remove = async (c: Chip) => {
    setBusy(c.policy_id);
    try {
      await api.del(`${base}/policies/${encodeURIComponent(c.policy_id)}`);
      policies.mutate((prev) => ({ ...(prev as AssetPolicies), chips: (prev as AssetPolicies).chips.filter((x) => x.policy_id !== c.policy_id) }));
      toast.success(`Removed ${c.name}`);
      policies.reload();
      reload();
    } catch (err) {
      toast.error("Not removed", writeErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const v = d.violations;
  const actions = Object.entries(v.by_action).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <SectionTitle
          title="Policies & guardrails"
          subtitle="Every control that applies to this asset, and where it comes from."
          actions={
            <>
              <SourcePill source={policies.source} degradedReason={policies.degradedReason} asOf={policies.asOf} />
              {(canActivate || canPropose) && (
                <Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => setPicker(true)}>
                  {canActivate ? "Attach policy" : "Propose policy"}
                </Button>
              )}
            </>
          }
        />
        {d.chips.length === 0 && <EmptyState icon={<ShieldCheck size={20} aria-hidden />} title="No policies apply" description="No guardrail, rate limit, budget or access policy is bound to this asset yet." className="!py-8" />}
        <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
          {grouped
            .filter((g) => g.chips.length > 0 || d.chips.length > 0)
            .map((g) => (
              <motion.section key={g.id} variants={staggerItem} aria-label={g.label} className="space-y-2">
                <h3 className="flex items-center gap-2 text-ui-base font-bold">
                  <g.icon size={15} aria-hidden className="text-primary" />
                  {g.label}
                  <Badge variant={g.chips.length ? "primary" : "neutral"}>{g.chips.length}</Badge>
                </h3>
                {g.chips.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-2 text-ui-sm text-muted-foreground">None configured.</p>}
                <div className="grid gap-2 md:grid-cols-2">
                  {g.chips.map((c) => (
                    <PolicyChip
                      key={c.policy_id}
                      chip={c}
                      actions={
                        canActivate && !c.inherited_from ? (
                          <>
                            {c.status === "proposed" && (
                              <Button size="sm" variant="secondary" loading={busy === `act:${c.policy_id}`} onClick={() => { setBusy(`act:${c.policy_id}`); void bind(c.policy_id, "active", c.name).catch(() => undefined).finally(() => setBusy(null)); }}>
                                Activate
                              </Button>
                            )}
                            <IconButton size="sm" label={`Remove ${c.name}`} icon={<Trash size={13} aria-hidden />} disabled={busy === c.policy_id} onClick={() => void remove(c)} />
                          </>
                        ) : undefined
                      }
                    />
                  ))}
                </div>
              </motion.section>
            ))}
        </motion.div>
      </div>

      <aside className="space-y-4" aria-label="Coverage and violations">
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ui-md font-bold">Coverage</h3>
            <RiskBadge risk={d.risk_tier} />
          </div>
          <CoverageMeter pct={d.coverage.pct} title="Required policies" items={d.coverage.required.map((r) => ({ key: r.requirement, label: r.label, met: r.met }))} />
        </Card>
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ui-md font-bold">Violations · 7 d</h3>
            <Sparkline values={v.daily.map((x) => x.count)} label="Daily violations" stroke="hsl(var(--destructive))" width={96} />
          </div>
          <div className="text-ui-2xl font-extrabold tabular-nums">{v.total_7d.toLocaleString()}</div>
          {v.total_7d === 0 ? (
            <p className="text-ui-sm text-muted-foreground">No policy violations in the last 7 days.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" aria-label="By action">
                {actions.map(([action, n]) => (
                  <Badge key={action} variant={action.toLowerCase().includes("block") ? "destructive" : "warning"}>
                    {humanize(action)} · {n}
                  </Badge>
                ))}
              </div>
              <ul className="space-y-1 text-ui-sm" aria-label="By policy">
                {v.by_policy.map((bp) => (
                  <li key={bp.policy_id} className="flex justify-between gap-2">
                    <span className="truncate">{bp.name}</span>
                    <span className="font-semibold tabular-nums">{bp.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </aside>

      <LibraryPicker
        open={picker}
        onClose={() => setPicker(false)}
        existing={existing}
        canActivate={canActivate}
        onBind={async (item, status) => {
          await bind(item.policy_id, status, item.name);
          setPicker(false);
        }}
      />
    </div>
  );
}
