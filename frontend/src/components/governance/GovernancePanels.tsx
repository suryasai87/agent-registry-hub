// Governance tab panels (stewards and admins act; auditors read): collector status and "Sync now", the curation
// queue, every overridden field with provenance and drift, and role assignments.
import { motion } from "framer-motion";
import {
  CircleAlert, CircleCheck, CircleX, ExternalLink, History, LoaderCircle, Lock, RefreshCw, ShieldPlus, Trash2, TriangleAlert, UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, enc, useApi } from "../../lib/api";
import { assetHref } from "../../lib/assets";
import { cx } from "../../lib/cx";
import { stagger, staggerItem } from "../../lib/motion";
import type { AssetCard, CurationQueue, FieldValue, GovernanceSources, RoleAssignment, SyncRun } from "../../lib/types";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, EmptyState, Input, Modal, SectionTitle, Select, TextArea, type BadgeVariant } from "../ui";
import { AssetLink, AssetTypeBadge, CertBadge, Person, ROLE_LABEL } from "../workspace/chips";
import { AsyncBlock, RowsSkeleton, useWrite } from "../workspace/feedback";
import { fmtDateTime, fmtRelative, fmtSpan, humanize, shortValue } from "../workspace/format";

type Envelope = { source: Parameters<typeof SourcePill>[0]["source"]; degradedReason: string | null; asOf: string | null };
const Pill = ({ s }: { s: Envelope }) => <SourcePill source={s.source} degradedReason={s.degradedReason} asOf={s.asOf} />;

// ------------------------------------------------------------------------------------------------ sources
const RUN: Record<string, { variant: BadgeVariant; icon: LucideIcon; label: string; dot: string }> = {
  succeeded: { variant: "success", icon: CircleCheck, label: "Succeeded", dot: "bg-success" },
  partial: { variant: "warning", icon: TriangleAlert, label: "Partial", dot: "bg-warning" },
  failed: { variant: "destructive", icon: CircleX, label: "Failed", dot: "bg-destructive" },
  running: { variant: "info", icon: LoaderCircle, label: "Running", dot: "bg-info" },
};

export function RunBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>Never run</Badge>;
  const r = RUN[status] ?? { variant: "neutral" as const, icon: CircleAlert, label: humanize(status), dot: "bg-muted-foreground" };
  const Icon = r.icon;
  return <Badge variant={r.variant} icon={<Icon size={11} aria-hidden className={status === "running" ? "animate-spin" : undefined} />}>{r.label}</Badge>;
}

function duration(run: SyncRun): string {
  if (!run.finished_at) return run.status === "running" ? `running ${fmtRelative(run.started_at).replace(" ago", "")}` : "–";
  return fmtSpan(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime());
}

/** The POST /api/governance/sync answer: a job run (with its link) or an in-process run (with a note). */
export interface SyncResult {
  ok: boolean;
  run: { mode?: "job" | "in_process" | string; job_id?: string | null; run_id?: number | string | null; url?: string | null; note?: string; collectors?: string[] | string };
}

export function SourcesPanel({ canSync }: { canSync: boolean }) {
  const q = useApi<GovernanceSources>("/api/governance/sources");
  const { run, pending } = useWrite();
  const [result, setResult] = useState<SyncResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [watch, setWatch] = useState(0);
  const reload = q.reload;
  const anyRunning = q.data?.collectors.some((c) => c.last?.status === "running") ?? false;

  useEffect(() => {
    if (!(anyRunning || (watch > 0 && watch < 12))) return;
    const t = setTimeout(() => {
      setWatch((w) => (w > 0 ? w + 1 : w));
      reload();
    }, 5000);
    return () => {
      clearTimeout(t);
    };
  }, [anyRunning, watch, reload]);

  const sync = async (collectors?: string[]) => {
    const res = await run(collectors ? `sync:${collectors[0]}` : "sync", "Couldn't start the sync", () => api.post<SyncResult>("/api/governance/sync", collectors ? { collectors } : {}));
    if (res) {
      setResult(res);
      setWatch(1);
      reload();
    }
  };

  return (
    <section aria-label="Sources and sync">
      <SectionTitle
        title="Sources & sync"
        subtitle="Each collector reads one Databricks API or system table into the registry. Runs are scheduled by the sync job; stewards can run them now."
        actions={
          <>
            <Pill s={q} />
            {canSync && (
              <Button icon={<RefreshCw size={14} aria-hidden />} loading={pending === "sync"} onClick={() => void sync()}>
                Sync now
              </Button>
            )}
          </>
        }
      />
      {result && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-ui-sm">
          <CircleCheck size={15} aria-hidden className="text-success" />
          {result.run.mode === "job" ? (
            <span>
              Started run <b className="font-mono">{result.run.run_id ?? "–"}</b> of sync job <span className="font-mono">{result.run.job_id}</span>.
              {result.run.url && (
                <a href={result.run.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                  Open the job run <ExternalLink size={12} aria-hidden />
                </a>
              )}
            </span>
          ) : (
            <span>
              Sync started inside the app{result.run.collectors && result.run.collectors !== "all" ? ` for ${Array.isArray(result.run.collectors) ? result.run.collectors.join(", ") : result.run.collectors}` : ""}. {result.run.note}
            </span>
          )}
          <button type="button" onClick={() => setResult(null)} className="ml-auto text-ui-xs font-semibold text-muted-foreground hover:text-foreground">Dismiss</button>
        </motion.div>
      )}
      <AsyncBlock state={q} skeleton={<RowsSkeleton rows={6} />}>
        {(d) => (
          <>
            <p className="mb-3 text-ui-sm text-muted-foreground">
              {d.job.configured ? (
                <>
                  Scheduled by sync job <span className="font-mono">{d.job.job_id}</span>
                  {d.job.url && (
                    <a href={d.job.url} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                      open job <ExternalLink size={11} aria-hidden />
                    </a>
                  )}
                </>
              ) : (
                "No sync job is configured (SYNC_JOB_ID), so “Sync now” runs the collectors inside the app with its service principal's visibility."
              )}
            </p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-ui-sm">
                <caption className="sr-only">Collectors and their last runs</caption>
                <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
                  <tr>
                    {["Collector", "Last run", "Items", "History", ""].map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {d.collectors.map((c) => {
                    const last = c.last;
                    const expanded = open === c.collector;
                    return (
                      <Fragment key={c.collector}>
                        <tr className="border-t border-border/70 align-top">
                          <td className="px-3 py-2.5">
                            <div className="font-semibold">{c.label}</div>
                            <div className="font-mono text-ui-xs text-muted-foreground">{c.collector}</div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-2"><RunBadge status={last?.status} />{last && <span className="text-ui-xs text-muted-foreground" title={fmtDateTime(last.started_at)}>{fmtRelative(last.started_at)} · {duration(last)}</span>}</div>
                            {last?.error && <p className="mt-1 max-w-md break-words text-ui-xs text-destructive">{shortValue(last.error, 220)}</p>}
                            {last && <div className="text-ui-xs text-muted-foreground">by {last.triggered_by}</div>}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums">{last ? <>{last.items_seen.toLocaleString()} seen<div className="text-ui-xs text-muted-foreground">{last.items_changed.toLocaleString()} changed</div></> : "–"}</td>
                          <td className="px-3 py-2.5">
                            {c.history.length ? (
                              <div className="flex items-center gap-0.5" role="img" aria-label={`Last ${c.history.length} runs: ${c.history.map((h) => h.status).join(", ")}`}>
                                {c.history.slice(0, 14).reverse().map((h) => (
                                  <span key={h.run_id} title={`${humanize(h.status)} · ${fmtDateTime(h.started_at)}`} className={cx("h-4 w-1.5 rounded-sm", (RUN[h.status] ?? { dot: "bg-muted-foreground" }).dot)} />
                                ))}
                              </div>
                            ) : (
                              <span className="text-ui-xs text-muted-foreground">No runs yet</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right">
                            {c.history.length > 0 && (
                              <Button size="sm" variant="ghost" icon={<History size={13} aria-hidden />} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : c.collector)}>
                                {expanded ? "Hide" : "Runs"}
                              </Button>
                            )}
                            {canSync && (
                              <Button size="sm" variant="secondary" icon={<RefreshCw size={12} aria-hidden />} loading={pending === `sync:${c.collector}`} onClick={() => void sync([c.collector])} aria-label={`Sync ${c.label} now`}>
                                Sync
                              </Button>
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bg-muted/30">
                            <td colSpan={5} className="px-3 py-2">
                              <table className="w-full text-ui-xs">
                                <thead className="text-left text-muted-foreground">
                                  <tr>{["Run", "Started", "Duration", "Status", "Seen", "Changed", "Triggered by", "Error"].map((h) => <th key={h} scope="col" className="px-2 py-1 font-semibold">{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                  {c.history.map((h) => (
                                    <tr key={h.run_id} className="border-t border-border/60 align-top">
                                      <td className="px-2 py-1 font-mono">{h.run_id}</td>
                                      <td className="px-2 py-1">{fmtDateTime(h.started_at)}</td>
                                      <td className="px-2 py-1">{duration(h)}</td>
                                      <td className="px-2 py-1"><RunBadge status={h.status} /></td>
                                      <td className="px-2 py-1 tabular-nums">{h.items_seen}</td>
                                      <td className="px-2 py-1 tabular-nums">{h.items_changed}</td>
                                      <td className="px-2 py-1">{h.triggered_by}</td>
                                      <td className="max-w-sm break-words px-2 py-1 text-destructive">{h.error ?? ""}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AsyncBlock>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ curation
function CurateDialog({ asset, action, onClose, onDone }: { asset: AssetCard; action: "approve" | "reject"; onClose: () => void; onDone: (card: AssetCard) => void }) {
  const [reason, setReason] = useState("");
  const { run, pending } = useWrite();
  const submit = async () => {
    const card = await run("curate", action === "approve" ? "Couldn't approve it" : "Couldn't reject it", () => api.post<AssetCard>(`/api/governance/curation/${enc(asset.asset_id)}`, { action, reason: reason.trim() }), action === "approve" ? `Approved ${asset.display_name}` : `Rejected ${asset.display_name}`);
    if (card) {
      onDone(card);
      onClose();
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={action === "approve" ? `Approve ${asset.display_name}` : `Reject ${asset.display_name}`}
      description={action === "approve" ? "It becomes a registered, managed asset in the catalog. Whoever registered it is notified." : "It stays out of the catalog. The creator is notified with your reason."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={action === "approve" ? "primary" : "danger"} loading={pending === "curate"} disabled={!reason.trim()} onClick={() => void submit()}>
            {action === "approve" ? "Approve" : "Reject"}
          </Button>
        </>
      }
    >
      <TextArea data-autofocus label="Reason (required, audited)" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}

function CurationList({ title, subtitle, items, canCurate, onDecide, ownerless = false }: { title: string; subtitle: string; items: AssetCard[]; canCurate: boolean; onDecide?: (a: AssetCard, action: "approve" | "reject") => void; ownerless?: boolean }) {
  return (
    <Card>
      <SectionTitle title={<span className="inline-flex items-center gap-2">{title} <Badge variant={items.length ? "warning" : "success"}>{items.length}</Badge></span>} subtitle={subtitle} />
      {items.length === 0 ? (
        <p className="py-4 text-center text-ui-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <motion.ul variants={stagger} initial="hidden" animate="show" className="divide-y divide-border/70">
          {items.map((a) => (
            <motion.li key={a.asset_id} variants={staggerItem} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <AssetLink assetId={a.asset_id} name={a.display_name} type={a.asset_type} />
                  <AssetTypeBadge type={a.asset_type} />
                  <CertBadge certification={a.certification} />
                </div>
                <div className="mt-0.5 text-ui-xs text-muted-foreground">
                  {a.platform.replace(/_/g, " ")}{a.publisher ? ` · ${a.publisher}` : ""}{a.purpose ? ` · ${a.purpose}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {ownerless ? (
                  <Link to={assetHref(a.asset_id, "overview")} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-ui-sm font-semibold hover:border-primary/40">
                    <UserPlus size={13} aria-hidden /> {canCurate ? "Assign owner" : "View"}
                  </Link>
                ) : canCurate && onDecide ? (
                  <>
                    <Button size="sm" variant="secondary" icon={<CircleX size={13} aria-hidden />} onClick={() => onDecide(a, "reject")}>Reject…</Button>
                    <Button size="sm" icon={<CircleCheck size={13} aria-hidden />} onClick={() => onDecide(a, "approve")}>Approve…</Button>
                  </>
                ) : null}
              </div>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </Card>
  );
}

export function CurationPanel({ canCurate }: { canCurate: boolean }) {
  const q = useApi<CurationQueue>("/api/governance/curation");
  const [dialog, setDialog] = useState<{ asset: AssetCard; action: "approve" | "reject" } | null>(null);
  const done = (card: AssetCard) => {
    if (!q.data) return;
    const prev = q.data;
    q.mutate({ ...prev, discovered: prev.discovered.filter((a) => a.asset_id !== card.asset_id), pending_approval: prev.pending_approval.filter((a) => a.asset_id !== card.asset_id) });
  };
  return (
    <section aria-label="Curation">
      <SectionTitle title="Curation" subtitle="Promote discovered and registered assets into the managed catalog, find ownerless ones, and resolve drift." actions={<Pill s={q} />} />
      <AsyncBlock state={q} skeleton={<RowsSkeleton rows={6} />}>
        {(d) => (
          <div className="grid gap-4 xl:grid-cols-2">
            <CurationList title="Pending approval" subtitle="Registered in the app; waiting for a steward" items={d.pending_approval} canCurate={canCurate} onDecide={(asset, action) => setDialog({ asset, action })} />
            <CurationList title="Discovered" subtitle="Found by sync; not yet managed" items={d.discovered} canCurate={canCurate} onDecide={(asset, action) => setDialog({ asset, action })} />
            <CurationList title="Ownerless" subtitle="No owner or co-owner: nobody to approve requests or acknowledge changes" items={d.ownerless} canCurate={canCurate} ownerless />
            <Card>
              <SectionTitle title={<span className="inline-flex items-center gap-2">Drifted <Badge variant={d.drifted.length ? "warning" : "success"}>{d.drifted.length}</Badge></span>} subtitle="The source changed a field that has an override" />
              {d.drifted.length === 0 ? (
                <p className="py-4 text-center text-ui-sm text-muted-foreground">No drift.</p>
              ) : (
                <ul className="divide-y divide-border/70">
                  {d.drifted.map((x) => (
                    <li key={`${x.asset_id}|${x.field_key}`} className="py-2.5 text-ui-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span><Link to={assetHref(x.asset_id, "overview")} className="font-semibold hover:text-primary hover:underline">{x.display_name}</Link> · <span className="font-mono text-ui-xs">{x.field_key}</span></span>
                        <Link to={assetHref(x.asset_id, "overview")} className="text-ui-xs font-semibold text-primary hover:underline">Resolve</Link>
                      </div>
                      <div className="mt-1 grid gap-2 text-ui-xs sm:grid-cols-2">
                        <div><span className="text-muted-foreground">Source now: </span>{shortValue(x.source_value)}</div>
                        <div><span className="text-muted-foreground">Override: </span>{shortValue(x.override_value)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </AsyncBlock>
      {dialog && <CurateDialog asset={dialog.asset} action={dialog.action} onClose={() => setDialog(null)} onDone={done} />}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ overrides
export type OverrideRow = FieldValue & { asset_id: string; display_name: string };

export function OverridesPanel() {
  const q = useApi<OverrideRow[]>("/api/governance/overrides");
  const [onlyDrift, setOnlyDrift] = useState(false);
  const rows = useMemo(() => (q.data ?? []).filter((r) => !onlyDrift || r.drift).sort((a, b) => Number(b.drift) - Number(a.drift) || (b.overridden_at ?? "").localeCompare(a.overridden_at ?? "")), [q.data, onlyDrift]);
  return (
    <section aria-label="Overrides">
      <SectionTitle
        title="Overrides"
        subtitle="Every field where a person replaced the synced value, with who, why, and whether the source has drifted since."
        actions={
          <>
            <label className="inline-flex items-center gap-2 text-ui-sm"><input type="checkbox" checked={onlyDrift} onChange={(e) => setOnlyDrift(e.target.checked)} className="accent-[hsl(var(--primary))]" /> Drifted only</label>
            <Pill s={q} />
          </>
        }
      />
      <AsyncBlock
        state={q}
        skeleton={<RowsSkeleton rows={5} />}
        isEmpty={() => rows.length === 0}
        empty={<EmptyState title={onlyDrift ? "No drifted overrides" : "No overridden fields"} description="When an owner edits a description field, or an admin overrides a synced value, it's listed here with its provenance." />}
      >
        {() => (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-ui-sm">
              <caption className="sr-only">Overridden fields</caption>
              <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
                <tr>{["Asset · field", "Provenance", "Value now", "Source value", "Lock", ""].map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.asset_id}|${r.field_key}`} className={cx("border-t border-border/70 align-top", r.drift && "bg-warning/6")}>
                    <td className="px-3 py-2.5">
                      <Link to={assetHref(r.asset_id, "overview")} className="font-semibold hover:text-primary hover:underline">{r.display_name}</Link>
                      <div className="text-ui-xs text-muted-foreground">{r.label} <span className="font-mono">({r.field_key})</span></div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={r.provenance === "admin" ? "primary" : "info"}>{r.provenance === "admin" ? "Edited by admin" : r.provenance === "owner" ? "Edited by owner" : "Synced"}</Badge>
                      <div className="mt-1 text-ui-xs text-muted-foreground">{r.overridden_by ?? "–"} · {fmtRelative(r.overridden_at)}</div>
                      {r.override_reason && <div className="mt-0.5 max-w-xs text-ui-xs">“{r.override_reason}”</div>}
                    </td>
                    <td className="max-w-xs break-words px-3 py-2.5">{shortValue(r.override_value ?? r.value, 200)}</td>
                    <td className="max-w-xs break-words px-3 py-2.5 text-muted-foreground">
                      {shortValue(r.source_value, 200)}
                      {r.source_label && <div className="text-ui-xs">from {r.source_label}{r.source_synced_at ? ` · ${fmtRelative(r.source_synced_at)}` : ""}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Badge icon={r.lock_mode === "keep" ? <Lock size={11} aria-hidden /> : undefined}>{r.lock_mode === "keep" ? "Keeps on sync" : "Follows source"}</Badge>
                        {r.drift && <Badge variant="warning" icon={<TriangleAlert size={11} aria-hidden />}>Drift</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right"><Link to={assetHref(r.asset_id, "overview")} className="text-ui-xs font-semibold text-primary hover:underline">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBlock>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ roles
const ROLE_OPTIONS = [
  { value: "steward", label: "Steward: curate, certify, override metadata, attach policies" },
  { value: "admin", label: "Admin: everything, including roles and sources" },
  { value: "auditor", label: "Auditor: read everything, change nothing" },
];

export function RolesPanel({ canManage, myEmail }: { canManage: boolean; myEmail: string | null }) {
  const q = useApi<RoleAssignment[]>("/api/governance/roles");
  const { run, pending } = useWrite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleAssignment["role"]>("steward");
  const [reason, setReason] = useState("");
  const [removing, setRemoving] = useState<RoleAssignment | null>(null);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => ["admin", "steward", "auditor"].indexOf(a.role) - ["admin", "steward", "auditor"].indexOf(b.role) || a.email.localeCompare(b.email)), [q.data]);

  const grant = async () => {
    const res = await run("grant", "Couldn't assign the role", () => api.post("/api/governance/roles", { email: email.trim().toLowerCase(), role, reason: reason.trim() }), `${ROLE_LABEL[role]} role assigned to ${email.trim()}`);
    if (res !== undefined) {
      setEmail("");
      setReason("");
      q.reload();
    }
  };
  const revoke = async (r: RoleAssignment) => {
    const res = await run(`revoke:${r.email}:${r.role}`, "Couldn't remove the role", () => api.del(`/api/governance/roles/${enc(r.email)}/${enc(r.role)}`), `Removed ${ROLE_LABEL[r.role]} from ${r.email}`);
    if (res !== undefined) {
      setRemoving(null);
      q.reload();
    }
  };

  return (
    <section aria-label="Roles">
      <SectionTitle title="Roles" subtitle="Stewards, admins and auditors. Owners and consumers are derived from ownership, grants and subscriptions." actions={<Pill s={q} />} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <AsyncBlock state={q} skeleton={<RowsSkeleton rows={4} />}>
          {() => (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-ui-sm">
                <caption className="sr-only">Role assignments</caption>
                <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
                  <tr>{["Person", "Role", "Granted", "Reason", ""].map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.email}|${r.role}`} className="border-t border-border/70 align-top">
                      <td className="px-3 py-2.5"><Person email={r.email} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={r.role === "admin" ? "primary" : r.role === "steward" ? "info" : "neutral"}>{ROLE_LABEL[r.role]}</Badge>
                          {r.domain && r.domain !== "*" && <Badge>{r.domain}</Badge>}
                          {r.bootstrap && <Badge icon={<Lock size={11} aria-hidden />} title="Set by REGISTRY_ADMINS in the app configuration">Bootstrap</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-ui-xs text-muted-foreground">
                        {r.granted_by}
                        {r.granted_at && <div>{fmtDateTime(r.granted_at)}</div>}
                        {r.expires_at && <div>Expires {fmtRelative(r.expires_at)}</div>}
                      </td>
                      <td className="max-w-xs px-3 py-2.5 text-ui-sm">{r.reason ?? "–"}</td>
                      <td className="px-3 py-2.5 text-right">
                        {canManage && !r.bootstrap && !(r.role === "admin" && r.email === myEmail) && (
                          <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden />} onClick={() => setRemoving(r)} aria-label={`Remove ${ROLE_LABEL[r.role]} from ${r.email}`}>
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncBlock>
        {canManage ? (
          <Card>
            <SectionTitle title={<span className="inline-flex items-center gap-2"><ShieldPlus size={16} aria-hidden /> Assign a role</span>} subtitle="Audited; the person is notified" />
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (validEmail && reason.trim()) void grant();
              }}
            >
              <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" error={email && !validEmail ? "Enter a valid email" : undefined} />
              <Select label="Role" value={role} onValueChange={(v) => setRole(v as RoleAssignment["role"])} options={ROLE_OPTIONS} />
              <TextArea label="Reason (required)" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Care-ops domain steward from Q4" />
              <Button type="submit" icon={<UserPlus size={14} aria-hidden />} loading={pending === "grant"} disabled={!validEmail || !reason.trim()} className="w-full">
                Assign role
              </Button>
            </form>
          </Card>
        ) : (
          <Card className="text-ui-sm text-muted-foreground">Only admins assign or remove roles. Bootstrap admins come from the app's REGISTRY_ADMINS setting and can't be removed here.</Card>
        )}
      </div>
      {removing && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title={`Remove ${ROLE_LABEL[removing.role]} from ${removing.email}?`}
          description="They keep any roles derived from ownership, grants and subscriptions."
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="danger" loading={pending === `revoke:${removing.email}:${removing.role}`} onClick={() => void revoke(removing)}>Remove role</Button>
            </>
          }
        >
          <p className="text-ui-sm">The role is revoked immediately and the change is written to the audit trail.</p>
        </Modal>
      )}
    </section>
  );
}
