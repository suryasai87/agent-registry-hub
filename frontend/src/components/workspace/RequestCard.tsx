// One access request (benchmark flow 5.1) for the review queue and My workspace: requester, asset, privilege,
// tool subset (write/destructive flagged), justification, duration, SLA, approvers and the provisioning result.
// Approve opens a "Provision" choice; Deny requires a reason; a failed provisioning can be retried. Status always
// comes from the server: nothing is marked provisioned optimistically.
import { motion } from "framer-motion";
import { CalendarClock, Check, CircleX, Code2, PenLine, RotateCcw, ShieldAlert, TriangleAlert, Undo2, Users } from "lucide-react";
import { useId, useState } from "react";
import { api } from "../../lib/api";
import { cx } from "../../lib/cx";
import { staggerItem } from "../../lib/motion";
import type { AccessRequest } from "../../lib/types";
import { Badge, Button, Card, Input, Modal, TextArea, useToast } from "../ui";
import { AssetLink, AssetTypeBadge, Person, RequestStatusBadge, SlaChip } from "./chips";
import { useWrite } from "./feedback";
import { fmtDateTime, fmtRelative, plural } from "./format";

// ------------------------------------------------------------------------------------------------ tool risk
export type SideEffect = "read" | "write" | "destructive";
const DESTRUCTIVE = /(^|[_\-.\s])(delete|drop|remove|purge|destroy|truncate|wipe|revoke|terminate|kill)([_\-.\s]|$)/i;
const WRITE = /(^|[_\-.\s])(create|update|write|send|post|put|patch|insert|upsert|set|add|edit|modify|move|rename|upload|publish|approve|execute|run|trigger|grant|merge|commit|reply|forward|schedule|book|cancel)([_\-.\s]|$)/i;

/** Side-effect class of a tool from its name (verbs like delete_/drop_ are destructive; send_/update_ write). */
export function sideEffect(tool: string): SideEffect {
  const name = tool.split("/").pop() ?? tool;
  if (DESTRUCTIVE.test(name)) return "destructive";
  if (WRITE.test(name)) return "write";
  return "read";
}

export function ToolChip({ tool }: { tool: string }) {
  const s = sideEffect(tool);
  const name = tool.split("/").pop() ?? tool;
  if (s === "destructive") return <Badge variant="destructive" icon={<ShieldAlert size={11} aria-hidden />} title="Destructive tool">{name} · destructive</Badge>;
  if (s === "write") return <Badge variant="warning" icon={<PenLine size={11} aria-hidden />} title="Writes data">{name} · write</Badge>;
  return <Badge>{name}</Badge>;
}

// ------------------------------------------------------------------------------------------------ decisions
export type ProvisionMode = "grant_direct" | "add_to_group" | "record_only";

export interface DecisionBody {
  decision: "approve" | "deny";
  reason?: string;
  provision_mode?: ProvisionMode;
  group?: string;
  duration_days?: number;
}

/** The approve payload: only what the approver chose (duration only when shortened, group only for groups). */
export function approveBody(r: Pick<AccessRequest, "duration_days">, choice: { mode: ProvisionMode; group?: string; durationDays?: number; reason?: string }): DecisionBody {
  const body: DecisionBody = { decision: "approve", provision_mode: choice.mode };
  if (choice.mode === "add_to_group" && choice.group?.trim()) body.group = choice.group.trim();
  if (choice.durationDays && choice.durationDays < r.duration_days) body.duration_days = choice.durationDays;
  if (choice.reason?.trim()) body.reason = choice.reason.trim();
  return body;
}

const MODES: { id: ProvisionMode; label: string; detail: string }[] = [
  { id: "grant_direct", label: "Grant directly", detail: "Apply the platform permission to the requester (UC GRANT or endpoint ACL)." },
  { id: "add_to_group", label: "Add to a group", detail: "Add the requester to a workspace group that already holds the permission." },
  { id: "record_only", label: "Record only", detail: "Record the approval; you'll apply the grant yourself (the exact statement is shown)." },
];

function ApproveDialog({ request, open, onClose, onDone }: { request: AccessRequest; open: boolean; onClose: () => void; onDone: (r: AccessRequest) => void }) {
  const [mode, setMode] = useState<ProvisionMode>("grant_direct");
  const [group, setGroup] = useState("");
  const [days, setDays] = useState(request.duration_days);
  const [reason, setReason] = useState("");
  const { run, pending } = useWrite();
  const toast = useToast();
  const name = useId();
  const invalid = (mode === "add_to_group" && !group.trim()) || days < 1 || days > request.duration_days;
  const submit = async () => {
    const body = approveBody(request, { mode, group, durationDays: days, reason });
    const result = await run("approve", "Couldn't approve the request", () => api.post<AccessRequest>(`/api/requests/${request.request_id}/decision`, body), (r) =>
      r.status === "provision_failed" ? null : r.status === "provisioned" ? (r.provision_detail?.applied === false ? null : "Approved and provisioned") : `Approved · ${r.status.replace(/_/g, " ")}`,
    );
    if (result?.status === "provisioned" && result.provision_detail?.applied === false) {
      toast.info("Approved and recorded, not applied", "No platform grant was made. The exact statement to apply is on the request.");
    }
    if (result) {
      if (result.status === "provision_failed") toast.warning("Approved, but provisioning failed", "The error and the exact statement are on the request; fix the cause and retry.");
      onDone(result);
      onClose();
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Approve and provision"
      description={`${request.requester_email} · ${request.privilege} on ${request.asset_display_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon={<Check size={14} aria-hidden />} loading={pending === "approve"} disabled={invalid} onClick={() => void submit()}>
            Approve & provision
          </Button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-ui-sm font-semibold">Provision</legend>
        {MODES.map((m) => (
          <label key={m.id} className={cx("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors", mode === m.id ? "border-primary/60 bg-primary/8" : "border-border hover:border-primary/30")}>
            <input type="radio" name={name} value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} className="mt-1 accent-[hsl(var(--primary))]" />
            <span>
              <span className="block text-ui-base font-semibold">{m.label}</span>
              <span className="block text-ui-sm text-muted-foreground">{m.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode === "add_to_group" && (
        <Input label="Group name" required value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. care-ops-agent-users" wrapperClassName="mt-3" icon={<Users size={14} aria-hidden />} />
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Input
          type="number"
          label="Grant duration (days)"
          min={1}
          max={request.duration_days}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          hint={`Requested ${request.duration_days} d; you can shorten it, not extend it.`}
          error={days > request.duration_days ? "Can't exceed the requested duration" : days < 1 ? "At least 1 day" : undefined}
        />
        <Input label="Note to the requester (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}

function DenyDialog({ request, open, onClose, onDone }: { request: AccessRequest; open: boolean; onClose: () => void; onDone: (r: AccessRequest) => void }) {
  const [reason, setReason] = useState("");
  const { run, pending } = useWrite();
  const submit = async () => {
    const result = await run("deny", "Couldn't deny the request", () => api.post<AccessRequest>(`/api/requests/${request.request_id}/decision`, { decision: "deny", reason: reason.trim() }), "Request denied");
    if (result) {
      onDone(result);
      onClose();
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Deny the request"
      description={`${request.requester_email} will see your reason.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<CircleX size={14} aria-hidden />} loading={pending === "deny"} disabled={!reason.trim()} onClick={() => void submit()}>
            Deny
          </Button>
        </>
      }
    >
      <TextArea data-autofocus label="Reason (required)" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Use the read-only tool set instead; write access needs a steward review." />
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ card
function ProvisionDetail({ request }: { request: AccessRequest }) {
  const d = request.provision_detail;
  if (!d) return null;
  const statement = typeof d.statement === "string" ? d.statement : null;
  const error = typeof d.error === "string" ? d.error : null;
  const note = typeof d.note === "string" ? d.note : null;
  const acting = typeof d.as === "string" ? d.as : null;
  const failed = request.status === "provision_failed";
  return (
    <div className={cx("rounded-lg border p-3 text-ui-sm", failed ? "border-destructive/40 bg-destructive/8" : "border-border bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        {failed ? <TriangleAlert size={14} aria-hidden className="text-destructive" /> : <Code2 size={14} aria-hidden className="text-muted-foreground" />}
        {failed ? "Provisioning failed" : d.applied ? `Applied${acting ? ` as ${acting}` : ""}` : "Recorded, not applied"}
        {typeof d.mode === "string" && <Badge>{d.mode.replace(/_/g, " ")}</Badge>}
      </div>
      {error && <p className="mt-1 break-words text-destructive">{error}</p>}
      {note && <p className="mt-1 text-muted-foreground">{note}</p>}
      {statement && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/70 px-2.5 py-1.5 font-mono text-ui-xs">{statement}</pre>
      )}
    </div>
  );
}

export default function RequestCard({
  request,
  onChange,
  mine = false,
}: {
  request: AccessRequest;
  /** The server's updated request after a decision / retry / cancel. */
  onChange: (r: AccessRequest) => void;
  /** Requester's own view: shows Cancel instead of the approver actions. */
  mine?: boolean;
}) {
  const [dialog, setDialog] = useState<null | "approve" | "deny">(null);
  const { run, pending } = useWrite();
  const r = request;
  const open = r.status === "pending";
  const retry = async () => {
    const res = await run("retry", "Couldn't retry provisioning", () => api.post<AccessRequest>(`/api/requests/${r.request_id}/retry`), (x) => (x.status === "provisioned" ? "Provisioned" : null));
    if (res) onChange(res);
  };
  const cancel = async () => {
    const res = await run("cancel", "Couldn't cancel the request", () => api.post<AccessRequest>(`/api/requests/${r.request_id}/cancel`), "Request cancelled");
    if (res) onChange(res);
  };
  return (
    <motion.li variants={staggerItem} layout="position">
      <Card role="article" className={cx("flex flex-col gap-3", r.sla_state === "overdue" && open && "border-destructive/40")} aria-label={`Request ${r.request_id}: ${r.privilege} on ${r.asset_display_name} for ${r.requester_email}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <AssetLink assetId={r.asset_id} name={r.asset_display_name} type={r.asset_type} tab="access" className="text-ui-md" />
              <AssetTypeBadge type={r.asset_type} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-muted-foreground">
              <span>
                <span className="font-mono font-semibold text-foreground">{r.privilege}</span>
                {r.principal !== r.requester_email && (
                  <>
                    {" "}for <span className="font-semibold text-foreground">{r.principal}</span> ({r.principal_type.replace(/_/g, " ")})
                  </>
                )}
              </span>
              <span className="inline-flex items-center gap-1"><CalendarClock size={13} aria-hidden /> {plural(r.duration_days, "day")}</span>
              <span title={fmtDateTime(r.created_at)}>Requested {fmtRelative(r.created_at)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {r.status === "provisioned" && r.provision_detail?.applied === false ? (
              <Badge variant="info" icon={<Code2 size={11} aria-hidden />} title="Approved; the grant was recorded but not applied on the platform">Approved · recorded only</Badge>
            ) : (
              <RequestStatusBadge status={r.status} />
            )}
            {(open || r.status === "provisioning") && <SlaChip state={r.sla_state} dueAt={r.sla_due_at} />}
          </div>
        </div>

        {!mine && <Person email={r.requester_email} sub={r.subscribe_email ? `Will be subscribed as ${r.subscribe_email}` : null} />}

        <blockquote className="rounded-lg border-l-2 border-primary/60 bg-muted/40 px-3 py-2 text-ui-sm">{r.justification}</blockquote>

        {r.tool_subset.length > 0 && (
          <div>
            <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">Tool subset ({r.tool_subset.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {[...r.tool_subset].sort((a, b) => ["destructive", "write", "read"].indexOf(sideEffect(a)) - ["destructive", "write", "read"].indexOf(sideEffect(b))).map((t) => (
                <ToolChip key={t} tool={t} />
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-xs text-muted-foreground">
          <span>Approvers: {r.approvers.length ? r.approvers.join(", ") : "owners and stewards"}</span>
          {r.decided_by && <span>Decided by {r.decided_by} {fmtRelative(r.decided_at)}</span>}
          {r.grant_expires_at && <span>Access until {fmtDateTime(r.grant_expires_at)}</span>}
          {r.terms_accepted && <span>Terms accepted</span>}
        </div>
        {r.decision_reason && <p className="text-ui-sm"><span className="text-muted-foreground">Reason: </span>{r.decision_reason}</p>}

        <ProvisionDetail request={r} />

        {(r.can_decide || (mine && open)) && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            {mine && open && (
              <Button variant="secondary" size="sm" icon={<Undo2 size={13} aria-hidden />} loading={pending === "cancel"} onClick={() => void cancel()}>
                Cancel request
              </Button>
            )}
            {!mine && r.can_decide && r.status === "pending" && (
              <>
                <Button variant="secondary" size="sm" icon={<CircleX size={13} aria-hidden />} onClick={() => setDialog("deny")}>Deny…</Button>
                <Button size="sm" icon={<Check size={13} aria-hidden />} onClick={() => setDialog("approve")}>Approve…</Button>
              </>
            )}
            {!mine && r.can_decide && r.status === "provision_failed" && (
              <Button size="sm" icon={<RotateCcw size={13} aria-hidden />} loading={pending === "retry"} onClick={() => void retry()}>Retry provisioning</Button>
            )}
          </div>
        )}
      </Card>
      {dialog === "approve" && <ApproveDialog request={r} open onClose={() => setDialog(null)} onDone={onChange} />}
      {dialog === "deny" && <DenyDialog request={r} open onClose={() => setDialog(null)} onDone={onChange} />}
    </motion.li>
  );
}
