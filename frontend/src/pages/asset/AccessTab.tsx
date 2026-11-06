// Access (benchmark §4.2 + §5.1): my access + my requests, the approver's inline queue (Approve with a provision
// mode / shorter duration, Deny with a reason, provisioning result with Retry or the statement to apply), who has
// access (revoke with a reason), and the owner's access settings.
import { AnimatePresence, motion } from "framer-motion";
import { Ban, CircleCheck, Clock, ExternalLink, KeyRound, RotateCcw, Settings2, ShieldCheck, TriangleAlert, UserRound, UsersRound, Bot } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useAsset } from "../../components/asset/AssetContext";
import { writeErrorMessage } from "../../components/asset/errors";
import { daysSince, fmtDate, fmtDateTime, isEmail, plural, splitList } from "../../components/asset/format";
import { Banner, CopyButton, DataTable, ErrorCard, SectionSkeleton, Segmented, Td, Th } from "../../components/asset/primitives";
import type { AccessSettingsExt } from "../../components/asset/RequestAccessDialog";
import SourcePill from "../../components/SourcePill";
import { Avatar, Badge, Button, Card, EmptyState, Input, Modal, SectionTitle, Select, TextArea, Toggle, useToast } from "../../components/ui";
import { api, useApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { AccessRequest, AccessSettings, AssetAccess, Grant, RequestStatus } from "../../lib/types";

const STATUS: Record<RequestStatus, { label: string; variant: "neutral" | "warning" | "success" | "destructive" | "info" }> = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  denied: { label: "Denied", variant: "destructive" },
  expired: { label: "Expired", variant: "neutral" },
  cancelled: { label: "Cancelled", variant: "neutral" },
  provisioning: { label: "Provisioning…", variant: "info" },
  provisioned: { label: "Granted", variant: "success" },
  provision_failed: { label: "Provisioning failed", variant: "destructive" },
  revoked: { label: "Revoked", variant: "neutral" },
};

const SLA: Record<AccessRequest["sla_state"], { label: string; variant: "success" | "warning" | "destructive" | "neutral" }> = {
  on_track: { label: "On track", variant: "success" },
  due_soon: { label: "Due soon", variant: "warning" },
  overdue: { label: "Overdue", variant: "destructive" },
  closed: { label: "Closed", variant: "neutral" },
};

function PrincipalIcon({ type }: { type: string }) {
  if (type === "group") return <UsersRound size={14} aria-label="Group" />;
  if (type === "service_principal") return <Bot size={14} aria-label="Service principal" />;
  return <UserRound size={14} aria-label="User" />;
}

export function statementOf(req: Pick<AccessRequest, "provision_detail">): string | null {
  const d = req.provision_detail ?? {};
  const s = d.statement ?? d.sql ?? d.command;
  return typeof s === "string" && s.trim() ? s : null;
}

function StatusBadge({ status }: { status: RequestStatus }) {
  const s = STATUS[status] ?? { label: status, variant: "neutral" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** What happened after a decision: granted, failed (statement + Retry), or record-only (statement to apply). */
function ProvisionResult({ req, onRetry, retrying }: { req: AccessRequest; onRetry?: () => void; retrying?: boolean }) {
  const statement = statementOf(req);
  const detail = req.provision_detail ?? {};
  const message = typeof detail.error === "string" ? detail.error : typeof detail.message === "string" ? detail.message : null;
  if (req.status === "provision_failed")
    return (
      <Banner tone="danger" role="alert" icon={<TriangleAlert size={15} aria-hidden />} title="Approved, but the grant failed" actions={onRetry ? <Button size="sm" variant="secondary" loading={retrying} icon={<RotateCcw size={13} aria-hidden />} onClick={onRetry}>Retry</Button> : undefined}>
        {message ?? "The platform refused the grant."}
        {statement && <StatementBlock statement={statement} />}
      </Banner>
    );
  if (req.provision_mode === "record_only" && statement && (req.status === "approved" || req.status === "provisioned"))
    return (
      <Banner tone="info" icon={<Settings2 size={15} aria-hidden />} title="Recorded only: apply this grant on the platform">
        The registry recorded the approval. Run this statement (or ask a workspace admin to) to grant access.
        <StatementBlock statement={statement} />
      </Banner>
    );
  if (req.status === "provisioned")
    return (
      <Banner tone="success" role="status" icon={<CircleCheck size={15} aria-hidden />} title="Access granted">
        {req.grant_expires_at ? `Expires ${fmtDate(req.grant_expires_at)}.` : "No expiry."}
      </Banner>
    );
  return null;
}

function StatementBlock({ statement }: { statement: string }) {
  return (
    <div className="mt-2 flex items-start gap-1 rounded-lg border border-border bg-card p-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-ui-xs text-foreground">{statement}</code>
      <CopyButton value={statement} label="Copy statement" />
    </div>
  );
}

function DecisionCard({ req, defaultGroup, onDecided }: { req: AccessRequest; defaultGroup?: string; onDecided: (r: AccessRequest) => void }) {
  const [mode, setMode] = useState<"approve" | "deny" | null>(null);
  const [provision, setProvision] = useState<"grant_direct" | "add_to_group" | "record_only">("grant_direct");
  const [group, setGroup] = useState(defaultGroup ?? "");
  const [days, setDays] = useState(String(req.duration_days));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const d = Number(days);
  const errors = {
    days: !Number.isInteger(d) || d < 1 ? "Whole days, at least 1." : d > req.duration_days ? `You can shorten, not extend (requested ${req.duration_days} days).` : null,
    group: provision === "add_to_group" && !group.trim() ? "Name the group to add the principal to." : null,
    reason: mode === "deny" && !reason.trim() ? "A reason is required to deny; the requester sees it." : null,
  };

  const decide = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (mode === "approve" && (errors.days || errors.group)) return;
    if (mode === "deny" && errors.reason) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === "approve"
          ? { decision: "approve", provision_mode: provision, ...(provision === "add_to_group" ? { group: group.trim() } : {}), ...(d !== req.duration_days ? { duration_days: d } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }
          : { decision: "deny", reason: reason.trim() };
      const next = await api.post<AccessRequest>(`/api/requests/${req.request_id}/decision`, body);
      setMode(null);
      toast.success(mode === "approve" ? `Approved ${req.requester_email}` : `Denied ${req.requester_email}`, STATUS[next.status]?.label);
      onDecided(next);
    } catch (err) {
      const msg = writeErrorMessage(err);
      setError(msg);
      toast.error("Decision not saved", msg);
    } finally {
      setBusy(false);
    }
  };

  const shown = req;
  const age = daysSince(req.created_at);
  return (
    <Card className="space-y-3 !p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Avatar email={req.requester_email} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui-base font-semibold">{req.requester_email}</span>
            {req.principal && req.principal !== req.requester_email && (
              <span className="inline-flex items-center gap-1 text-ui-sm text-muted-foreground">
                for <PrincipalIcon type={req.principal_type} /> {req.principal}
              </span>
            )}
            <StatusBadge status={shown.status} />
            {shown.status === "pending" && <Badge variant={SLA[req.sla_state]?.variant ?? "neutral"} icon={<Clock size={11} aria-hidden />}>{SLA[req.sla_state]?.label ?? req.sla_state} · due {fmtDateTime(req.sla_due_at)}</Badge>}
          </div>
          <div className="mt-0.5 text-ui-sm text-muted-foreground">
            <span className="font-mono">{req.privilege}</span> · {plural(req.duration_days, "day")} · requested {age === 0 ? "today" : `${plural(age ?? 0, "day")} ago`}
            {req.tool_subset.length > 0 && <> · tools: <span className="font-mono">{req.tool_subset.join(", ")}</span></>}
          </div>
          <blockquote className="mt-2 border-l-2 border-primary/40 pl-3 text-ui-sm">{req.justification}</blockquote>
        </div>
        {shown.status === "pending" && req.can_decide && !mode && (
          <div className="flex gap-2">
            <Button size="sm" icon={<CircleCheck size={13} aria-hidden />} onClick={() => setMode("approve")}>
              Approve
            </Button>
            <Button size="sm" variant="secondary" icon={<Ban size={13} aria-hidden />} onClick={() => setMode("deny")}>
              Deny
            </Button>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {mode && (
          <motion.form
            key={mode}
            noValidate
            onSubmit={decide}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="space-y-3 overflow-hidden rounded-xl border border-border bg-muted/20 p-3"
            aria-label={mode === "approve" ? "Approve request" : "Deny request"}
          >
            {mode === "approve" ? (
              <>
                <fieldset className="space-y-1.5">
                  <legend className="text-ui-sm font-semibold">Provision</legend>
                  {(
                    [
                      { v: "grant_direct", label: "Grant directly", hint: "Apply the platform grant to the principal" },
                      { v: "add_to_group", label: "Add to group", hint: "Add the principal to a group that already holds the privilege" },
                      { v: "record_only", label: "Record only", hint: "Record the approval; someone applies the grant on the platform" },
                    ] as const
                  ).map((o) => (
                    <label key={o.v} className="flex cursor-pointer items-start gap-2 text-ui-sm">
                      <input type="radio" name={`prov-${req.request_id}`} className="mt-1 accent-primary" checked={provision === o.v} onChange={() => setProvision(o.v)} />
                      <span>
                        <span className="block font-medium">{o.label}</span>
                        <span className="block text-ui-xs text-muted-foreground">{o.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {provision === "add_to_group" && <Input label="Group" value={group} onChange={(e) => setGroup(e.target.value)} error={tried ? errors.group : null} />}
                <Input type="number" min={1} max={req.duration_days} label="Duration (days)" hint={`Requested ${req.duration_days}; you may shorten it.`} value={days} onChange={(e) => setDays(e.target.value)} error={tried ? errors.days : null} wrapperClassName="max-w-[220px]" />
                <Input label="Note to the requester (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              </>
            ) : (
              <TextArea label="Reason for denying (required)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={tried ? errors.reason : null} />
            )}
            {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant={mode === "deny" ? "danger" : "primary"} loading={busy}>
                {mode === "approve" ? "Approve request" : "Deny request"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </Card>
  );
}

/** A decision just made in this session: the provisioning outcome stays visible (Retry on failure). */
function RecentDecision({ req, onUpdate }: { req: AccessRequest; onUpdate: (r: AccessRequest) => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const retry = async () => {
    setBusy(true);
    try {
      const next = await api.post<AccessRequest>(`/api/requests/${req.request_id}/retry`);
      onUpdate(next);
      toast.success("Provisioning retried", STATUS[next.status]?.label);
    } catch (err) {
      toast.error("Retry failed", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}>
      <Card className="space-y-2 !p-4" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2 text-ui-sm">
          <Avatar email={req.requester_email} size={24} />
          <span className="font-semibold">{req.requester_email}</span>
          <span className="font-mono text-muted-foreground">{req.privilege}</span>
          <StatusBadge status={req.status} />
          {req.decided_at && <span className="ml-auto text-ui-xs text-muted-foreground">decided {fmtDateTime(req.decided_at)}</span>}
        </div>
        {req.status === "denied" ? (
          <p className="text-ui-sm text-muted-foreground">Denied{req.decision_reason ? `: ${req.decision_reason}` : ""}. The requester has been notified.</p>
        ) : (
          <ProvisionResult req={req} onRetry={req.status === "provision_failed" ? () => void retry() : undefined} retrying={busy} />
        )}
        {req.status === "approved" && !statementOf(req) && <p className="text-ui-sm text-muted-foreground">Approved. Provisioning will follow.</p>}
      </Card>
    </motion.div>
  );
}

function RevokeDialog({ grant, onClose, onRevoked }: { grant: Grant | null; onClose: () => void; onRevoked: (g: Grant) => void }) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    setReason("");
    setTried(false);
  }, [grant]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!grant || !reason.trim()) return;
    setBusy(true);
    try {
      const g = await api.post<Grant>(`/api/grants/${grant.grant_id}/revoke`, { reason: reason.trim() });
      toast.success(`Revoked ${grant.privilege} from ${grant.principal}`);
      onRevoked(g);
      onClose();
    } catch (err) {
      toast.error("Not revoked", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!grant}
      onClose={onClose}
      title="Revoke access?"
      description={grant ? `${grant.principal} loses ${grant.privilege}. The principal is notified and the revocation is audited.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="revoke-form" variant="danger" loading={busy}>
            Revoke
          </Button>
        </>
      }
    >
      <form id="revoke-form" noValidate onSubmit={submit}>
        <TextArea data-autofocus label="Reason (required)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={tried && !reason.trim() ? "A reason is required to revoke access." : null} />
      </form>
    </Modal>
  );
}

function SettingsForm({ settings, onSaved }: { settings: AccessSettingsExt; onSaved: (s: AccessSettingsExt) => void }) {
  const { base } = useAsset();
  const [form, setForm] = useState(() => ({ ...settings, approversText: settings.approvers.join(", ") }));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [served, setServed] = useState<AccessSettingsExt | null>(null);
  const toast = useToast();
  useEffect(() => {
    setForm({ ...settings, approversText: settings.approvers.join(", ") });
  }, [settings]);

  const approvers = splitList(form.approversText);
  const errors = {
    approvers: approvers.some((a) => !isEmail(a) && !/^[\w.-]+$/.test(a)) ? "Approvers are emails or group names." : null,
    max: !(form.max_duration_days >= 1) ? "At least 1 day." : null,
    def: !(form.default_duration_days >= 1) ? "At least 1 day." : form.default_duration_days > form.max_duration_days ? "Default can't exceed the maximum." : null,
    sla: !(form.sla_hours >= 1) ? "At least 1 hour." : null,
    url: form.managed_externally_url && !/^https?:\/\//i.test(form.managed_externally_url) ? "Use an http(s) URL." : null,
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    setBusy(true);
    try {
      const body: Partial<AccessSettings> = {
        approval_required: form.approval_required,
        approver_mode: form.approver_mode,
        approvers,
        default_duration_days: form.default_duration_days,
        max_duration_days: form.max_duration_days,
        sla_hours: form.sla_hours,
        terms_text: form.terms_text?.trim() || null,
        managed_externally_url: form.managed_externally_url?.trim() || null,
      };
      const saved = await api.put<AccessSettingsExt>(`${base}/access-settings`, body);
      setServed(saved);
      onSaved(saved);
      toast.success("Access settings saved");
    } catch (err) {
      toast.error("Settings not saved", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const num = (k: "default_duration_days" | "max_duration_days" | "sla_hours") => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }));
  const hints = served ?? settings;
  return (
    <form noValidate onSubmit={submit} aria-label="Access settings" className="space-y-4">
      <Toggle checked={form.approval_required} onChange={(v) => setForm((f) => ({ ...f, approval_required: v }))} label="Approval required" description="Off: requests are granted automatically and audited." />
      <div className="grid gap-3 md:grid-cols-[1fr_200px]">
        <Input label="Approvers" placeholder="Empty = the asset owners" value={form.approversText} onChange={(e) => setForm((f) => ({ ...f, approversText: e.target.value }))} error={tried ? errors.approvers : null} hint="Emails or group names, comma-separated." />
        <Select
          label="Approver mode"
          value={form.approver_mode}
          onValueChange={(v) => setForm((f) => ({ ...f, approver_mode: v as AccessSettings["approver_mode"] }))}
          options={[
            { value: "any", label: "Any approver" },
            { value: "all", label: "All approvers" },
          ]}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input type="number" min={1} label="Default duration (days)" value={String(form.default_duration_days)} onChange={num("default_duration_days")} error={tried ? errors.def : null} />
        <Input type="number" min={1} label="Maximum duration (days)" value={String(form.max_duration_days)} onChange={num("max_duration_days")} error={tried ? errors.max : null} />
        <Input type="number" min={1} label="SLA (hours)" value={String(form.sla_hours)} onChange={num("sla_hours")} error={tried ? errors.sla : null} />
      </div>
      <TextArea label="Terms of use (optional)" rows={3} value={form.terms_text ?? ""} onChange={(e) => setForm((f) => ({ ...f, terms_text: e.target.value }))} hint="Requesters must accept these before submitting." />
      <Input label="Managed externally (optional)" placeholder="https://… request page in another system" value={form.managed_externally_url ?? ""} onChange={(e) => setForm((f) => ({ ...f, managed_externally_url: e.target.value }))} error={tried ? errors.url : null} />
      {(hints.target_note || hints.provisioning_mode) && (
        <Banner tone="info" icon={<ShieldCheck size={15} aria-hidden />} title={`Provisioning: ${hints.provisioning_mode === "record_only" ? "record only (statements to apply)" : hints.provisioning_mode ?? "platform grant"}`}>
          {hints.target_note}
        </Banner>
      )}
      <Button type="submit" loading={busy}>
        Save access settings
      </Button>
    </form>
  );
}

export default function AccessTab() {
  const { detail, base, refreshKey, openRequest, patchDetail } = useAsset();
  const access = useApi<AssetAccess>(`${base}/access`, [refreshKey]);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const [view, setView] = useState<"all" | "app" | "platform">("all");
  const [recent, setRecent] = useState<AccessRequest[]>([]);
  const toast = useToast();
  const p = detail.permissions;
  const remember = (r: AccessRequest) => setRecent((xs) => [r, ...xs.filter((x) => x.request_id !== r.request_id)]);

  if (access.error && !access.data) return <ErrorCard error={access.error} onRetry={access.reload} />;
  if (!access.data) return <SectionSkeleton blocks={3} />;
  const data = access.data;
  const settings = data.settings as AccessSettingsExt;
  const grants = data.grants.filter((g) => view === "all" || g.source === view);
  const decidedIds = new Set(recent.map((r) => r.request_id));
  const pending = data.pending_requests.filter((r) => !decidedIds.has(r.request_id) && (r.status === "pending" || r.status === "provisioning"));

  const cancel = async (r: AccessRequest) => {
    try {
      const next = await api.post<AccessRequest>(`/api/requests/${r.request_id}/cancel`);
      access.mutate((d) => ({ ...(d as AssetAccess), my_requests: (d as AssetAccess).my_requests.map((x) => (x.request_id === next.request_id ? next : x)) }));
      patchDetail((d) => ({ ...d, asset: { ...d.asset, my: { ...d.asset.my, requested: false } } }));
      toast.success("Request cancelled");
    } catch (err) {
      toast.error("Not cancelled", writeErrorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      {settings.managed_externally_url && (
        <Banner
          tone="info"
          icon={<ExternalLink size={15} aria-hidden />}
          title="Access is managed externally"
          actions={
            <a href={settings.managed_externally_url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-sm font-semibold hover:bg-accent">
              Open <ExternalLink size={12} aria-hidden />
            </a>
          }
        >
          Grants for this asset live in another system; the list below may be incomplete.
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3">
          <SectionTitle
            title="My access"
            actions={
              <>
                <SourcePill source={access.source} degradedReason={access.degradedReason} asOf={access.asOf} />
                <Button size="sm" icon={<KeyRound size={13} aria-hidden />} onClick={openRequest}>
                  {data.my_access.length ? "Request more access" : "Request access"}
                </Button>
              </>
            }
          />
          {data.my_access.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">You have no access to this asset yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.my_access.map((g) => (
                <li key={g.grant_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-ui-sm">
                  <ShieldCheck size={14} className="text-success" aria-hidden />
                  <span className="font-mono font-semibold">{g.privilege}</span>
                  {g.inherited && <Badge>inherited</Badge>}
                  <span className="text-muted-foreground">via {g.principal_type === "user" ? "you" : g.principal}</span>
                  <span className="ml-auto text-muted-foreground">{g.expires_at ? `expires ${fmtDate(g.expires_at)}` : "no expiry"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="space-y-3">
          <SectionTitle title="My requests" />
          {data.my_requests.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">No requests from you for this asset.</p>
          ) : (
            <ul className="space-y-2">
              {data.my_requests.map((r) => (
                <li key={r.request_id} className="space-y-2 rounded-lg border border-border px-3 py-2 text-ui-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{r.privilege}</span>
                    <StatusBadge status={r.status} />
                    {r.status === "pending" && <Badge variant={SLA[r.sla_state]?.variant ?? "neutral"}>{SLA[r.sla_state]?.label} · day {daysSince(r.created_at) ?? 0}</Badge>}
                    <span className="text-muted-foreground">{fmtDate(r.created_at)}</span>
                    {r.status === "pending" && (
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void cancel(r)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                  {r.status === "pending" && <div className="text-ui-xs text-muted-foreground">Waiting on {r.approvers.join(", ") || "the asset owners"} · answer due {fmtDateTime(r.sla_due_at)}</div>}
                  {r.decision_reason && <div className="text-ui-xs text-muted-foreground">“{r.decision_reason}” · {r.decided_by}</div>}
                  <ProvisionResult req={r} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {(p.can_manage_access || recent.length > 0 || pending.some((r) => r.can_decide)) && (
        <section className="space-y-3" aria-label="Pending requests">
          <SectionTitle title="Pending requests" subtitle={pending.length ? `${plural(pending.length, "request")} waiting for a decision.` : undefined} />
          {recent.length > 0 && (
            <div className="space-y-2">
              {recent.map((r) => (
                <RecentDecision key={r.request_id} req={r} onUpdate={(next) => remember(next)} />
              ))}
            </div>
          )}
          {pending.length === 0 ? (
            <EmptyState icon={<CircleCheck size={20} aria-hidden />} title="Nothing waiting" description="New access requests for this asset appear here." className="!py-8" />
          ) : (
            <div className="space-y-3">
              {pending.map((r) => (
                <DecisionCard
                  key={r.request_id}
                  req={r}
                  onDecided={(next) => {
                    remember(next);
                    access.reload();
                  }}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <section className="space-y-3" aria-label="Who has access">
        <SectionTitle
          title="Who has access"
          subtitle="Platform grants (Unity Catalog / endpoint permissions) and grants approved in the registry."
          actions={
            <Segmented
              label="Grant source"
              value={view}
              onChange={setView}
              options={[
                { value: "all", label: `All (${data.grants.length})` },
                { value: "platform", label: "Platform" },
                { value: "app", label: "Registry" },
              ]}
            />
          }
        />
        {grants.length === 0 ? (
          <EmptyState icon={<UsersRound size={20} aria-hidden />} title="No grants recorded" description="Nobody holds a grant from this source yet." className="!py-8" />
        ) : (
          <DataTable label="Grants">
            <thead>
              <tr>
                <Th>Principal</Th>
                <Th>Privilege</Th>
                <Th>Source</Th>
                <Th>Inherited</Th>
                <Th>Granted by</Th>
                <Th>Granted</Th>
                <Th>Expires</Th>
                {p.can_manage_access && (
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const soon = g.expires_at && (new Date(g.expires_at).getTime() - Date.now()) / 86_400_000 < 14;
                return (
                  <tr key={g.grant_id} className="hover:bg-accent/40">
                    <Td>
                      <span className="inline-flex items-center gap-2">
                        <PrincipalIcon type={g.principal_type} />
                        <span className="font-medium">{g.principal}</span>
                      </span>
                    </Td>
                    <Td className="font-mono">{g.privilege}</Td>
                    <Td>
                      <Badge variant={g.source === "app" ? "primary" : "neutral"}>{g.source === "app" ? `Registry${g.request_id ? ` · #${g.request_id}` : ""}` : "Platform"}</Badge>
                    </Td>
                    <Td>{g.inherited ? "Yes" : "No"}</Td>
                    <Td className="text-muted-foreground">{g.granted_by ?? "–"}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{fmtDate(g.granted_at)}</Td>
                    <Td className={cx("whitespace-nowrap", soon && "font-semibold text-warning")}>{g.expires_at ? fmtDate(g.expires_at) : "Never"}</Td>
                    {p.can_manage_access && (
                      <Td>
                        {!g.inherited && (
                          <Button size="sm" variant="ghost" onClick={() => setRevoking(g)} aria-label={`Revoke ${g.privilege} from ${g.principal}`}>
                            Revoke
                          </Button>
                        )}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </section>

      {p.can_manage_access && (
        <section aria-label="Access settings">
          <Card className="space-y-3">
            <SectionTitle title="Access settings" subtitle="Who approves, for how long, the SLA and the terms requesters accept." />
            <SettingsForm
              settings={settings}
              onSaved={(s) => {
                access.mutate((d) => ({ ...(d as AssetAccess), settings: s }));
                patchDetail((d) => ({ ...d, access_settings: s }));
              }}
            />
            {data.platform_request_destinations && data.platform_request_destinations.length > 0 && (
              <p className="text-ui-xs text-muted-foreground">
                Unity Catalog request destinations: {data.platform_request_destinations.map((d) => `${d.destination_type} ${d.destination_id}`).join(" · ")}
              </p>
            )}
          </Card>
        </section>
      )}

      <RevokeDialog grant={revoking} onClose={() => setRevoking(null)} onRevoked={() => access.reload()} />
    </div>
  );
}
