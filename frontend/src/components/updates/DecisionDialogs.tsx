// Admin decisions on an update candidate: Accept (starts the apply job; a breaking change needs a note and a
// reminder to tell the impacted consumers first), Delay until a date, Reject with a reason, and Acknowledge for
// advisories. Each dialog waits for the server's answer: nothing changes on screen until it confirms.
import { CalendarClock, Check, CheckCheck, CircleX, ShieldAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { UpdateCandidate } from "../../lib/types";
import { Button, Input, Modal, TextArea } from "../ui";
import { useWrite } from "../workspace/feedback";
import { fmtDate, plural } from "../workspace/format";
import { acceptBody, acceptProblem, acknowledgeBody, defaultDelayDate, delayBody, delayProblem, localDay, rejectBody, type DecisionBody } from "./model";

export type DecisionKind = "accept" | "delay" | "reject" | "acknowledge";

interface DialogProps {
  candidate: UpdateCandidate;
  open: boolean;
  onClose: () => void;
  /** The server's updated candidate (accept carries ``apply_run``). */
  onDone: (next: UpdateCandidate) => void;
  /** The write failed (the toast already explained why): refetch so the card shows the real state. */
  onFailed: () => void;
}

export const decisionPath = (id: number) => `/api/platform-watch/candidates/${id}/decision`;

function useDecision({ candidate, onClose, onDone, onFailed }: DialogProps) {
  const { run, pending } = useWrite();
  const submit = async (key: DecisionKind, failTitle: string, build: () => DecisionBody, success: (c: UpdateCandidate) => string | null) => {
    const result = await run(key, failTitle, () => api.post<UpdateCandidate>(decisionPath(candidate.candidate_id), build()), success);
    if (result) {
      onDone(result);
      onClose();
    } else {
      onFailed();
    }
  };
  return { submit, pending };
}

function Subject({ candidate }: { candidate: UpdateCandidate }) {
  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <div className="text-ui-base font-semibold">{candidate.title}</div>
      {(candidate.from_version || candidate.to_version) && (
        <div className="mt-0.5 font-mono text-ui-xs text-muted-foreground">
          {candidate.from_version ?? "–"} → {candidate.to_version ?? "–"}
        </div>
      )}
    </div>
  );
}

function whatAcceptDoes(c: UpdateCandidate): ReactNode {
  const migrations = c.migrations.length ? `applies ${plural(c.migrations.length, "pending migration")} to production` : "migrates production";
  if (c.kind === "app_release") return <>The apply job {migrations}, then deploys the staged app{c.to_version ? <> <span className="font-mono">{c.to_version}</span></> : null}.</>;
  if (c.kind === "capability") return <>The apply job {migrations}, then enables the <span className="font-mono">{c.capability_key ?? "matching"}</span> adapter.</>;
  return <>The advisory is marked as accepted; nothing is applied.</>;
}

// ------------------------------------------------------------------------------------------------ accept
export function AcceptDialog(props: DialogProps) {
  const { candidate: c, open, onClose } = props;
  const [note, setNote] = useState("");
  const { submit, pending } = useDecision(props);
  const problem = acceptProblem(c, note);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={c.breaking ? "Accept a breaking update" : "Accept this update"}
      description="Accepting starts the apply job on production."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={c.breaking ? "danger" : "primary"}
            icon={<Check size={14} aria-hidden />}
            loading={pending === "accept"}
            disabled={!!problem}
            onClick={() =>
              void submit("accept", "Couldn't accept the update", () => acceptBody(c, note), (r) => (r.apply_run?.mode === "not_configured" ? null : "Accepted: the apply job is starting"))
            }
          >
            {c.breaking ? "Accept breaking update" : "Accept & apply"}
          </Button>
        </>
      }
    >
      <Subject candidate={c} />
      <p className="mb-3 text-ui-sm">{whatAcceptDoes(c)}</p>
      {c.regression && (
        <p className="mb-3 text-ui-sm text-muted-foreground">
          The regression {c.regression.passed ? "passed" : "failed"} on branch <span className="font-mono text-foreground">{c.regression.branch || c.branch_name}</span>.
        </p>
      )}
      {c.breaking && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/45 bg-destructive/8 p-3 text-ui-sm">
          <div className="flex items-center gap-2 font-bold text-destructive">
            <ShieldAlert size={15} aria-hidden /> This update has breaking changes
          </div>
          {c.breaking_reasons.length > 0 && (
            <ul aria-label="Breaking reasons" className="mt-1.5 list-disc space-y-0.5 pl-5 font-mono text-ui-xs">
              {c.breaking_reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <p className="mt-2">
            Tell the impacted consumers first: publish a change notice for the affected assets in{" "}
            <Link to="/changes" className="font-semibold text-primary hover:underline">Changes &amp; Impact</Link> so they are notified and can acknowledge it before you apply.
          </p>
        </div>
      )}
      <TextArea
        data-autofocus
        label={c.breaking ? "Note (required)" : "Note (optional)"}
        required={c.breaking}
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={c.breaking ? "What you checked, and who you told (e.g. notified the 3 subscribers of the MCP subregistry on 26 Oct)." : "Anything the audit trail should know."}
        error={c.breaking && note.length > 0 && problem ? problem : undefined}
        hint={c.breaking ? "Recorded in the audit trail with your decision." : undefined}
      />
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ delay
export function DelayDialog({ defaultDelayDays, ...props }: DialogProps & { defaultDelayDays: number }) {
  const { candidate: c, open, onClose } = props;
  const [day, setDay] = useState(() => defaultDelayDate(defaultDelayDays));
  const [note, setNote] = useState("");
  const { submit, pending } = useDecision(props);
  const problem = delayProblem(day);
  const tested = c.kind !== "advisory";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delay this update"
      description={`Snooze it until a date (default: ${plural(defaultDelayDays, "day")} from today).`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            icon={<CalendarClock size={14} aria-hidden />}
            loading={pending === "delay"}
            disabled={!!problem}
            onClick={() => void submit("delay", "Couldn't delay the update", () => delayBody(day, note), (r) => `Delayed until ${fmtDate(r.delay_until)}`)}
          >
            Delay
          </Button>
        </>
      }
    >
      <Subject candidate={c} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
        <Input data-autofocus type="date" label="Delay until" required min={localDay(1)} value={day} onChange={(e) => setDay(e.target.value)} error={problem ?? undefined} />
        <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. after the quarter-end freeze" />
      </div>
      <p className="mt-3 text-ui-sm text-muted-foreground">
        It resurfaces automatically on {fmtDate(day)} and admins are reminded.
        {tested && " A delayed update is re-tested on a fresh branch before it can be accepted, so the result reflects the data at that time."}
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ reject
export function RejectDialog(props: DialogProps) {
  const { candidate: c, open, onClose } = props;
  const [reason, setReason] = useState("");
  const { submit, pending } = useDecision(props);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reject this update"
      description="It won't be applied or offered again. The reason goes to the audit trail."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<CircleX size={14} aria-hidden />} loading={pending === "reject"} disabled={!reason.trim()} onClick={() => void submit("reject", "Couldn't reject the update", () => rejectBody(reason), () => "Update rejected")}>
            Reject
          </Button>
        </>
      }
    >
      <Subject candidate={c} />
      <TextArea data-autofocus label="Reason (required)" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. We stay on the current version until the vendor fixes the migration." />
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ acknowledge
export function AcknowledgeDialog(props: DialogProps) {
  const { candidate: c, open, onClose } = props;
  const [note, setNote] = useState("");
  const { submit, pending } = useDecision(props);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Acknowledge this advisory"
      description="Marks it as read and moves it to History. Nothing changes in the app or the database."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon={<CheckCheck size={14} aria-hidden />} loading={pending === "acknowledge"} onClick={() => void submit("acknowledge", "Couldn't acknowledge the advisory", () => acknowledgeBody(note), () => "Advisory acknowledged")}>
            Acknowledge
          </Button>
        </>
      }
    >
      <Subject candidate={c} />
      <TextArea data-autofocus label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Tracked in the Q1 roadmap; no action needed now." />
    </Modal>
  );
}
