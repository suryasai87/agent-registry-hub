// Inline impact acknowledgement (benchmark flow 5.2): "Not impacted" / "Impacted, will migrate by <date>" /
// "I need help" + note → POST /api/changes/{id}/ack. The server's rows replace the local state (no optimism:
// the owner's tracker counts these).
import { CircleCheck, LifeBuoy, Send, Timer } from "lucide-react";
import { useId, useState } from "react";
import { api } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { AckStatus, ImpactItem } from "../../lib/types";
import { useSession } from "../../lib/session";
import { Button, Input, TextArea } from "../ui";
import { AckBadge } from "./chips";
import { useWrite } from "./feedback";
import { isoDay } from "./format";

export interface AckBody {
  status: Exclude<AckStatus, "pending" | "not_required">;
  note?: string;
  migrate_by?: string;
}

/** The exact request body for an acknowledgement (only the fields the chosen status needs). */
export function ackBody(status: AckBody["status"], { note, migrateBy }: { note?: string; migrateBy?: string } = {}): AckBody {
  const body: AckBody = { status };
  const n = note?.trim();
  if (status === "impacted_will_migrate" && migrateBy) body.migrate_by = migrateBy;
  if (n && status !== "not_impacted") body.note = n;
  return body;
}

export default function AckControl({
  changeId,
  current,
  migrateBy,
  effectiveAt,
  readOnly = false,
  showStatus = true,
  onAcked,
  className,
}: {
  changeId: number;
  current: AckStatus;
  migrateBy?: string | null;
  effectiveAt?: string | null;
  readOnly?: boolean;
  /** Show the current status badge next to the buttons (off when the host already shows it). */
  showStatus?: boolean;
  onAcked?: (rows: ImpactItem[], body: AckBody) => void;
  className?: string;
}) {
  const [mode, setMode] = useState<null | "impacted_will_migrate" | "need_help">(null);
  const [date, setDate] = useState(() => (migrateBy ?? effectiveAt ?? "").slice(0, 10) || isoDay(14));
  const [note, setNote] = useState("");
  const { run, pending } = useWrite();
  const session = useSession();
  const id = useId();

  const send = async (status: AckBody["status"]) => {
    const body = ackBody(status, { note, migrateBy: date });
    const rows = await run(status, "Couldn't record your acknowledgement", () => api.post<ImpactItem[]>(`/api/changes/${changeId}/ack`, body), "Acknowledgement recorded");
    if (rows) {
      setMode(null);
      setNote("");
      onAcked?.(rows, body);
      session.refresh();
    }
  };

  if (readOnly) return <AckBadge status={current} migrateBy={migrateBy} />;
  const done = current !== "pending" && current !== "not_required";

  return (
    <div className={cx("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {done && showStatus && <AckBadge status={current} migrateBy={migrateBy} />}
        <div role="group" aria-label={done ? "Change your acknowledgement" : "Acknowledge this change"} className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={current === "not_impacted" ? "primary" : "secondary"} icon={<CircleCheck size={13} aria-hidden />} loading={pending === "not_impacted"} onClick={() => void send("not_impacted")}>
            Not impacted
          </Button>
          <Button size="sm" variant={mode === "impacted_will_migrate" || current === "impacted_will_migrate" ? "primary" : "secondary"} icon={<Timer size={13} aria-hidden />} aria-expanded={mode === "impacted_will_migrate"} aria-controls={`${id}-migrate`} onClick={() => setMode((m) => (m === "impacted_will_migrate" ? null : "impacted_will_migrate"))}>
            Impacted, will migrate…
          </Button>
          <Button size="sm" variant={mode === "need_help" || current === "need_help" ? "primary" : "secondary"} icon={<LifeBuoy size={13} aria-hidden />} aria-expanded={mode === "need_help"} aria-controls={`${id}-help`} onClick={() => setMode((m) => (m === "need_help" ? null : "need_help"))}>
            I need help…
          </Button>
        </div>
      </div>
      {mode === "impacted_will_migrate" && (
        <form
          id={`${id}-migrate`}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted/40 p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send("impacted_will_migrate");
          }}
        >
          <Input type="date" label="I'll have migrated by" required min={isoDay(0)} value={date} onChange={(e) => setDate(e.target.value)} wrapperClassName="w-48" />
          <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. switching to the v2 tool" wrapperClassName="min-w-[200px] flex-1" />
          <Button type="submit" size="md" icon={<Send size={13} aria-hidden />} loading={pending === "impacted_will_migrate"} disabled={!date}>
            Confirm
          </Button>
        </form>
      )}
      {mode === "need_help" && (
        <form
          id={`${id}-help`}
          className="space-y-2 rounded-lg border border-border bg-muted/40 p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send("need_help");
          }}
        >
          <TextArea label="What do you need?" required rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The owner is notified with this note." />
          <div className="flex justify-end">
            <Button type="submit" icon={<Send size={13} aria-hidden />} loading={pending === "need_help"} disabled={!note.trim()}>
              Ask the owner
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
