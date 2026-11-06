// My workspace tab panels: subscriptions (notify pref + team emails inline), access grants with expiry
// countdowns, my requests with the SLA clock, owned assets with readiness and open actions, and the changes
// that impact me with inline acknowledgement.
import { motion } from "framer-motion";
import {
  BellRing, CircleAlert, ClipboardList, FileClock, KeyRound, ListChecks, Mail, PackageOpen, Pencil, Timer, Trash2, Zap,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, enc, useApi } from "../../lib/api";
import { assetHref, fmtNum, fmtUsd } from "../../lib/assets";
import { cx } from "../../lib/cx";
import { stagger, staggerItem } from "../../lib/motion";
import type { AccessRequest, AckStatus, AssetCard, AssetType, ChangeSummary, Grant, ImpactItem, Subscription } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, EmptyState, Input, Select, Toggle, Tooltip, useToast } from "../ui";
import AckControl from "./AckControl";
import { AckBadge, AssetLink, AssetTypeBadge, CertBadge, MiniStat, ShieldBadge } from "./chips";
import { AsyncBlock, CardsSkeleton, RowsSkeleton, writeErrorText } from "./feedback";
import { daysUntil, fmtDate, fmtDateTime, fmtRelative, humanize, plural } from "./format";
import RequestCard from "./RequestCard";

function PanelHead({ title, subtitle, state, actions }: { title: string; subtitle: string; state: { source: Parameters<typeof SourcePill>[0]["source"]; degradedReason: string | null; asOf: string | null }; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-ui-lg font-bold">{title}</h2>
        <p className="text-ui-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <SourcePill source={state.source} degradedReason={state.degradedReason} asOf={state.asOf} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ subscriptions
const NOTIFY_OPTIONS = [
  { value: "breaking_only", label: "Breaking changes only" },
  { value: "all", label: "All published changes" },
  { value: "weekly_digest", label: "Weekly digest" },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmails(raw: string): { emails: string[]; invalid: string[] } {
  const parts = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(parts.map((p) => p.toLowerCase()))];
  return { emails: unique.filter((e) => EMAIL_RE.test(e)), invalid: unique.filter((e) => !EMAIL_RE.test(e)) };
}

function TeamEmails({ sub, onSave }: { sub: Subscription; onSave: (emails: string[]) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sub.notify_emails.join(", "));
  const [saving, setSaving] = useState(false);
  const { invalid, emails } = parseEmails(draft);
  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Mail size={13} aria-hidden className="text-muted-foreground" />
        <span className="text-ui-sm font-semibold">{sub.subscriber_email}</span>
        {sub.notify_emails.map((e) => <Badge key={e}>{e}</Badge>)}
        <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded px-1 text-ui-xs font-semibold text-primary hover:underline" aria-label={`Edit team emails for ${sub.asset_display_name}`}>
          <Pencil size={11} aria-hidden /> {sub.notify_emails.length ? "Edit" : "Add team emails"}
        </button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid.length) return;
        setSaving(true);
        const ok = await onSave(emails);
        setSaving(false);
        if (ok) setEditing(false);
      }}
    >
      <Input
        aria-label="Team emails (comma separated)"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="team-dl@example.com, oncall@example.com"
        wrapperClassName="min-w-[260px] flex-1"
        error={invalid.length ? `Not an email: ${invalid.join(", ")}` : undefined}
        hint="Also notified, in addition to your SSO email."
      />
      <Button type="submit" size="md" loading={saving} disabled={invalid.length > 0}>Save</Button>
      <Button variant="ghost" size="md" onClick={() => { setDraft(sub.notify_emails.join(", ")); setEditing(false); }}>Cancel</Button>
    </form>
  );
}

export function SubscriptionsPanel() {
  const q = useApi<Subscription[]>("/api/me/subscriptions");
  const toast = useToast();
  const rows = (q.data ?? []).filter((s) => s.status === "active");

  const patch = async (sub: Subscription, body: Partial<Pick<Subscription, "notify_pref" | "notify_emails">>, label: string): Promise<boolean> => {
    try {
      const next = await q.optimistic(
        (prev) => (prev ?? []).map((s) => (s.subscription_id === sub.subscription_id ? { ...s, ...body } : s)),
        () => api.patch<Subscription>(`/api/subscriptions/${sub.subscription_id}`, body),
      );
      q.mutate((prev) => (prev ?? []).map((s) => (s.subscription_id === next.subscription_id ? next : s)));
      toast.success(label);
      return true;
    } catch (err) {
      toast.error("Couldn't update the subscription", writeErrorText(err));
      return false;
    }
  };

  const unsubscribe = async (sub: Subscription) => {
    try {
      await q.optimistic((prev) => (prev ?? []).filter((s) => s.subscription_id !== sub.subscription_id), () => api.del(`/api/subscriptions/${sub.subscription_id}`));
      toast.toast({
        kind: "success",
        title: `Unsubscribed from ${sub.asset_display_name}`,
        description: "You won't get change notices for it any more.",
        duration: 6000,
        action: {
          label: "Undo",
          onClick: () => {
            api
              .post(`/api/assets/${enc(sub.asset_id)}/subscriptions`, {
                subscriber_email: sub.subscriber_email, notify_emails: sub.notify_emails, subscriber_kind: sub.subscriber_kind, relationship: sub.relationship,
                downstream_asset_id: sub.downstream_asset_id, downstream_name: sub.downstream_name, use_case: sub.use_case, environment: sub.environment, notify_pref: sub.notify_pref,
              })
              .then(() => q.reload(), (err: unknown) => toast.error("Couldn't re-subscribe", writeErrorText(err)));
          },
        },
      });
    } catch (err) {
      toast.error("Couldn't unsubscribe", writeErrorText(err));
    }
  };

  return (
    <section aria-label="Subscriptions">
      <PanelHead title="Subscriptions" subtitle="Assets you've registered your email for. You're told about changes that match your preference, and asked to acknowledge breaking ones." state={q} />
      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={4} />}
        isEmpty={() => rows.length === 0}
        empty={
          <EmptyState
            icon={<BellRing size={22} aria-hidden />}
            title="No subscriptions yet"
            description="Subscribe from any asset's page (or when you request access) so you hear about breaking changes before they hit you."
            action={<Link to="/catalog" className="text-ui-sm font-semibold text-primary hover:underline">Browse the catalog</Link>}
          />
        }
      >
        {() => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="space-y-3">
            {rows.map((s) => (
              <motion.li key={s.subscription_id} variants={staggerItem} layout="position">
                <Card className="flex flex-col gap-3 !p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AssetLink assetId={s.asset_id} name={s.asset_display_name} type={s.asset_type} className="text-ui-md" />
                        <AssetTypeBadge type={s.asset_type} />
                        {!s.has_access && (
                          <Tooltip content="Your access was revoked or expired. The subscription stays so you still hear about deprecations.">
                            <span tabIndex={0}>
                              <Badge variant="warning" icon={<CircleAlert size={11} aria-hidden />}>No current access</Badge>
                            </span>
                          </Tooltip>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-ui-xs text-muted-foreground">
                        <span>{s.relationship === "via_downstream" ? `Via ${s.downstream_name ?? s.downstream_asset_id ?? "a downstream asset"}` : "Direct use"}</span>
                        <span>{humanize(s.environment)}</span>
                        {s.use_case && <span>{s.use_case}</span>}
                        <span>Since {fmtDate(s.created_at)}</span>
                        {s.last_ack_at && <span>Last acknowledged {fmtRelative(s.last_ack_at)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        aria-label={`Notify me about (${s.asset_display_name})`}
                        value={s.notify_pref}
                        options={NOTIFY_OPTIONS}
                        onValueChange={(v) => void patch(s, { notify_pref: v as Subscription["notify_pref"] }, "Notification preference saved")}
                        wrapperClassName="w-56"
                      />
                      <Button variant="ghost" size="md" icon={<Trash2 size={14} aria-hidden />} onClick={() => void unsubscribe(s)} aria-label={`Unsubscribe from ${s.asset_display_name}`}>
                        Unsubscribe
                      </Button>
                    </div>
                  </div>
                  <TeamEmails sub={s} onSave={(emails) => patch(s, { notify_emails: emails }, "Team emails saved")} />
                </Card>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AsyncBlock>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ access
export type MyGrant = Grant & { asset_id: string; asset_display_name: string; asset_type: AssetType };

export function expiryState(expiresAt: string | null, now: number = Date.now()): { tone: "none" | "ok" | "soon" | "urgent" | "expired"; label: string } {
  const d = daysUntil(expiresAt, now);
  if (d === null) return { tone: "none", label: "No expiry" };
  if (d <= 0) return { tone: "expired", label: "Expired" };
  const label = d < 1 ? `Expires in ${Math.max(1, Math.round(d * 24))} h` : `Expires in ${Math.round(d)} d`;
  if (d <= 3) return { tone: "urgent", label };
  if (d <= 14) return { tone: "soon", label };
  return { tone: "ok", label };
}

export function AccessPanel() {
  const q = useApi<MyGrant[]>("/api/me/access");
  const rows = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => (a.expires_at ?? "9999").localeCompare(b.expires_at ?? "9999") || a.asset_display_name.localeCompare(b.asset_display_name)),
    [q.data],
  );
  const soon = rows.filter((g) => ["soon", "urgent"].includes(expiryState(g.expires_at).tone)).length;
  return (
    <section aria-label="Access">
      <PanelHead
        title="Access"
        subtitle="What you can use today, how it was granted, and when it expires. Extend from the asset's Access tab before it lapses."
        state={q}
        actions={soon > 0 ? <Badge variant="warning" icon={<Timer size={11} aria-hidden />}>{plural(soon, "grant")} expiring soon</Badge> : undefined}
      />
      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={4} />}
        isEmpty={() => rows.length === 0}
        empty={<EmptyState icon={<KeyRound size={22} aria-hidden />} title="No grants recorded for you" description="Request access from an asset's page; approved grants appear here with their expiry." />}
      >
        {() => (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-ui-sm">
              <caption className="sr-only">Your access grants</caption>
              <thead className="bg-muted/60 text-left text-muted-foreground">
                <tr>
                  {["Asset", "Privilege", "How", "Granted", "Expiry", ""].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const ex = expiryState(g.expires_at);
                  return (
                    <tr key={g.grant_id} className={cx("border-t border-border/70", ex.tone === "urgent" && "bg-destructive/6", ex.tone === "soon" && "bg-warning/6")}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <AssetLink assetId={g.asset_id} name={g.asset_display_name} type={g.asset_type} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold">{g.privilege}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={g.source === "app" ? "primary" : "neutral"}>{g.source === "app" ? `Request #${g.request_id ?? "–"}` : "Platform grant"}</Badge>
                          {g.inherited && <Badge>Inherited</Badge>}
                          {g.principal_type !== "user" && <Badge>via {g.principal}</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground" title={fmtDateTime(g.granted_at)}>
                        {fmtDate(g.granted_at)}{g.granted_by ? ` · ${g.granted_by}` : ""}
                      </td>
                      <td className="px-3 py-2.5">
                        {ex.tone === "none" ? (
                          <span className="text-muted-foreground">No expiry</span>
                        ) : (
                          <Badge variant={ex.tone === "ok" ? "neutral" : ex.tone === "soon" ? "warning" : "destructive"} icon={<Timer size={11} aria-hidden />} title={fmtDateTime(g.expires_at)}>
                            {ex.label}
                            {(ex.tone === "soon" || ex.tone === "urgent") && <span className="font-normal">· expiring soon</span>}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {g.expires_at && (
                          <Link to={assetHref(g.asset_id, "access")} className="text-ui-xs font-semibold text-primary hover:underline">Extend</Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBlock>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ requests
export function MyRequestsPanel() {
  const q = useApi<AccessRequest[]>("/api/me/requests");
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)), [q.data]);
  return (
    <section aria-label="My requests">
      <PanelHead title="My requests" subtitle="Requests you've made, their approvers and the SLA clock. Pending requests expire automatically after the request window." state={q} />
      <AsyncBlock
        state={q}
        skeleton={<CardsSkeleton count={2} className="!grid-cols-1 xl:!grid-cols-2" />}
        isEmpty={() => rows.length === 0}
        empty={<EmptyState icon={<ClipboardList size={22} aria-hidden />} title="You haven't requested anything" description="When an asset says “Request access”, your request and its progress show up here." />}
      >
        {() => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="grid gap-4 xl:grid-cols-2">
            {rows.map((r) => (
              <RequestCard key={r.request_id} request={r} mine onChange={(next) => q.mutate((prev) => (prev ?? []).map((x) => (x.request_id === next.request_id ? next : x)))} />
            ))}
          </motion.ul>
        )}
      </AsyncBlock>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ owned
export interface OpenAction {
  key: string;
  label: string;
  href: string;
  severity: "info" | "warning" | "critical";
}

/** Readiness checklist an owner can act on, derived from the asset card (and pending requests for it). */
export function ownedChecklist(a: AssetCard & { completeness_pct?: number }, pendingRequests = 0): { done: number; total: number; actions: OpenAction[] } {
  const checks: { ok: boolean; action: OpenAction }[] = [
    { ok: !!a.purpose?.trim(), action: { key: "purpose", label: "Add a one-line purpose", href: assetHref(a.asset_id, "overview"), severity: "warning" } },
    { ok: a.owners.filter((o) => o.kind === "owner" || o.kind === "co_owner").length >= 2, action: { key: "co_owner", label: "Add a co-owner (no single point of contact)", href: assetHref(a.asset_id, "overview"), severity: "info" } },
    { ok: a.policy_shield === "full", action: { key: "policies", label: `Close policy gaps (coverage ${Math.round(a.coverage_pct)}%)`, href: assetHref(a.asset_id, "policies"), severity: a.policy_shield === "none" ? "critical" : "warning" } },
    { ok: a.certification === "certified" || a.certification === "verified_publisher", action: { key: "certify", label: "Ask a steward to certify it", href: assetHref(a.asset_id, "overview"), severity: "info" } },
    { ok: a.lifecycle_status === "approved", action: { key: "lifecycle", label: a.lifecycle_status === "pending_approval" ? "Awaiting steward approval" : `Lifecycle is ${humanize(a.lifecycle_status).toLowerCase()}`, href: assetHref(a.asset_id, "overview"), severity: a.lifecycle_status === "deprecated" ? "warning" : "info" } },
  ];
  const actions = checks.filter((c) => !c.ok).map((c) => c.action);
  if (pendingRequests > 0) actions.unshift({ key: "requests", label: `${plural(pendingRequests, "access request")} waiting for you`, href: "/requests", severity: "critical" });
  return { done: checks.filter((c) => c.ok).length, total: checks.length, actions };
}

export function OwnedPanel({ canReview }: { canReview: boolean }) {
  const q = useApi<(AssetCard & { completeness_pct?: number })[]>("/api/me/owned");
  const review = useApi<AccessRequest[]>(canReview ? "/api/requests?scope=review" : null);
  const pendingBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of review.data ?? []) if (r.status === "pending") m.set(r.asset_id, (m.get(r.asset_id) ?? 0) + 1);
    return m;
  }, [review.data]);
  return (
    <section aria-label="Owned assets">
      <PanelHead title="Owned" subtitle="Assets you own or co-own: their readiness and what needs your attention." state={q} />
      <AsyncBlock
        state={q}
        skeleton={<CardsSkeleton count={3} />}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon={<PackageOpen size={22} aria-hidden />} title="You don't own any assets" description="Owners come from the platform (who created the endpoint, app or connection) or are assigned by a steward. Register a custom asset to own it." action={<Link to="/register" className="text-ui-sm font-semibold text-primary hover:underline">Register an asset</Link>} />}
      >
        {(data) => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.map((a) => {
              const c = ownedChecklist(a, pendingBy.get(a.asset_id) ?? 0);
              const pct = a.completeness_pct ?? Math.round((c.done / c.total) * 100);
              return (
                <motion.li key={a.asset_id} variants={staggerItem}>
                  <Card interactive className="flex h-full flex-col gap-3 !p-4">
                    <div className="flex items-start justify-between gap-2">
                      <AssetLink assetId={a.asset_id} name={a.display_name} type={a.asset_type} className="text-ui-md" />
                      <AssetTypeBadge type={a.asset_type} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge>{humanize(a.lifecycle_status)}</Badge>
                      <CertBadge certification={a.certification} />
                      <ShieldBadge shield={a.policy_shield} />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between text-ui-xs">
                        <span className="font-semibold text-muted-foreground">{a.completeness_pct != null ? "Completeness" : "Readiness checklist"}</span>
                        <span className="font-semibold tabular-nums">{a.completeness_pct != null ? `${Math.round(a.completeness_pct)}%` : `${c.done} of ${c.total}`}</span>
                      </div>
                      <div role="progressbar" aria-label="Readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className={cx("h-full rounded-full", pct >= 80 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-destructive")} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <MiniStat label="Requests 30 d" value={fmtNum(a.kpi.requests_30d)} />
                      <MiniStat label="Users" value={fmtNum(a.kpi.users_30d)} />
                      <MiniStat label="Cost (est.)" value={fmtUsd(a.kpi.cost_30d_usd)} />
                    </div>
                    {c.actions.length > 0 ? (
                      <ul className="mt-auto space-y-1 border-t border-border pt-2" aria-label="Open actions">
                        {c.actions.map((x) => (
                          <li key={x.key}>
                            <Link to={x.href} className="flex items-center gap-2 rounded px-1 py-0.5 text-ui-sm hover:bg-accent">
                              <ListChecks size={13} aria-hidden className={x.severity === "critical" ? "text-destructive" : x.severity === "warning" ? "text-warning" : "text-muted-foreground"} />
                              <span className="flex-1">{x.label}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-auto border-t border-border pt-2 text-ui-sm text-success">Nothing open. Nicely kept.</p>
                    )}
                  </Card>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </AsyncBlock>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ impacts
export type MyImpact = ImpactItem & { change: ChangeSummary };

/** The readable tail of an asset URN ("agent:endpoint:demo-care-supervisor" → "demo-care-supervisor"). */
export function urnName(id: string): string {
  const tail = id.split(":").pop() ?? id;
  return tail.includes("/") ? tail.split("/").pop()! : tail;
}

const IMPACT_LABEL: Record<ImpactItem["impact_type"], string> = {
  subscriber: "Subscriber",
  downstream_asset: "Downstream asset",
  downstream_owner: "Owner of a downstream asset",
  observed_consumer: "Observed consumer (unregistered)",
};

/** One entry per change (several impact rows for the same person collapse); pending first, then by effective date. */
export function groupImpacts(rows: MyImpact[]): { change: ChangeSummary; items: MyImpact[]; status: AckStatus; migrateBy: string | null }[] {
  const by = new Map<number, MyImpact[]>();
  for (const r of rows) {
    const list = by.get(r.change.change_id);
    if (list) list.push(r);
    else by.set(r.change.change_id, [r]);
  }
  return [...by.values()]
    .map((items) => {
      const pending = items.find((i) => i.ack_status === "pending");
      const acked = items.find((i) => i.ack_status !== "pending" && i.ack_status !== "not_required");
      const status: AckStatus = pending ? "pending" : acked ? acked.ack_status : items[0].ack_status;
      return { change: items[0].change, items, status, migrateBy: acked?.migrate_by ?? null };
    })
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || (a.change.effective_at ?? "9999").localeCompare(b.change.effective_at ?? "9999"));
}

export function ImpactsPanel() {
  const q = useApi<MyImpact[]>("/api/me/impacts");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const groups = useMemo(() => groupImpacts(q.data ?? []).filter((g) => !onlyOpen || g.status === "pending"), [q.data, onlyOpen]);
  const apply = (changeId: number, rows: ImpactItem[]) => {
    const fresh = new Map(rows.map((r) => [`${r.impacted_key}|${r.impact_type}`, r]));
    q.mutate((prev) =>
      (prev ?? []).map((x) => {
        if (x.change.change_id !== changeId) return x;
        const r = fresh.get(`${x.impacted_key}|${x.impact_type}`);
        return r ? { ...x, ack_status: r.ack_status, ack_note: r.ack_note, migrate_by: r.migrate_by, acked_at: r.acked_at } : x;
      }),
    );
  };
  return (
    <section aria-label="Impacts">
      <PanelHead
        title="Impacts"
        subtitle="Every published change that affects you, as a subscriber, an owner of something downstream, or an observed consumer. Acknowledge each one so its owner knows where you stand."
        state={q}
        actions={<Toggle checked={onlyOpen} onChange={setOnlyOpen} label="Needs my acknowledgement" />}
      />
      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={3} className="[&>div]:h-28" />}
        isEmpty={() => groups.length === 0}
        empty={<EmptyState icon={<Zap size={22} aria-hidden />} title={onlyOpen ? "Nothing waiting for your acknowledgement" : "No changes affect you"} description="When an owner publishes a change to something you use or subscribe to, it shows up here with what changed and when." />}
      >
        {() => (
          <motion.ul variants={stagger} initial="hidden" animate="show" className="space-y-3">
            {groups.map((g) => {
              const c = g.change;
              const days = daysUntil(c.effective_at);
              return (
                <motion.li key={c.change_id} variants={staggerItem} layout="position">
                  <Card className={cx("flex flex-col gap-3 !p-4", g.status === "pending" && c.breaking && "border-warning/50")}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {c.breaking && <Badge variant="destructive" icon={<CircleAlert size={11} aria-hidden />}>Breaking</Badge>}
                          <Link to={`/changes/${c.change_id}`} className="text-ui-md font-bold hover:text-primary hover:underline">{c.title}</Link>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-muted-foreground">
                          <AssetLink assetId={c.asset_id} name={c.asset_display_name} type={c.asset_type} />
                          {(c.from_version || c.to_version) && <span className="font-mono">{c.from_version ?? "–"} → {c.to_version ?? "–"}</span>}
                          {c.change_kinds.map((k) => <Badge key={k}>{humanize(k)}</Badge>)}
                        </div>
                      </div>
                      <div className="text-right text-ui-sm">
                        {c.effective_at && (
                          <div className={cx("inline-flex items-center gap-1 font-semibold", days !== null && days <= 7 && days > 0 ? "text-warning" : undefined)}>
                            <FileClock size={13} aria-hidden /> Effective {fmtDate(c.effective_at)}
                            <span className="font-normal text-muted-foreground">({fmtRelative(c.effective_at)})</span>
                          </div>
                        )}
                        <div className="mt-1"><AckBadge status={g.status} migrateBy={g.migrateBy} /></div>
                      </div>
                    </div>
                    {c.summary && <p className="text-ui-sm text-muted-foreground">{c.summary}</p>}
                    <div className="flex flex-wrap gap-1.5 text-ui-xs">
                      {g.items.map((i) => (
                        <span key={`${i.impacted_key}|${i.impact_type}`} className="inline-flex flex-wrap items-center gap-1">
                          <Badge variant="info">{IMPACT_LABEL[i.impact_type]}</Badge>
                          {i.via_asset_id && i.via_asset_id !== c.asset_id && (
                            <span className="text-muted-foreground">
                              via <Link to={assetHref(i.via_asset_id)} className="font-semibold text-foreground hover:text-primary hover:underline">{urnName(i.via_asset_id)}</Link>
                              {i.hops > 1 ? ` · ${i.hops} hops` : ""}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                    {g.status !== "not_required" ? (
                      <AckControl changeId={c.change_id} current={g.status} migrateBy={g.migrateBy} effectiveAt={c.effective_at} showStatus={false} onAcked={(rows) => apply(c.change_id, rows)} />
                    ) : (
                      <p className="text-ui-xs text-muted-foreground">Not a breaking change: no acknowledgement needed.</p>
                    )}
                    <div className="flex justify-end gap-3 text-ui-xs">
                      <Link to={`/lineage?focus=${enc(c.asset_id)}&change_id=${c.change_id}`} className="font-semibold text-primary hover:underline">See impact on lineage</Link>
                      <Link to={`/changes/${c.change_id}`} className="font-semibold text-primary hover:underline">Open impact report</Link>
                    </div>
                  </Card>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </AsyncBlock>
    </section>
  );
}
