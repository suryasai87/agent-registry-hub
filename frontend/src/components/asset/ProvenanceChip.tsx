// Field-level provenance (benchmark §5.4): "Auto-pulled · <source> · <ago>" (neutral), "Edited by owner",
// or "Edited by admin · <who> · <when>" (brand colour). The tooltip compares source vs current + the reason.
import { CloudDownload, PenLine, ShieldAlert, CircleDashed } from "lucide-react";
import { fmtAgo } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { FieldValue } from "../../lib/types";
import { Tooltip } from "../ui";
import { fmtDate, isEmptyValue } from "./format";

export function previewValue(v: unknown, max = 160): string {
  if (isEmptyValue(v)) return "(empty)";
  let text: string;
  if (typeof v === "string") text = v;
  else if (Array.isArray(v)) text = v.map((x) => (typeof x === "object" && x !== null ? String((x as { label?: unknown; url?: unknown }).label ?? (x as { url?: unknown }).url ?? JSON.stringify(x)) : String(x))).join(", ");
  else if (typeof v === "object") text = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join(" · ");
  else text = String(v);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function provenanceLabel(field: FieldValue): string {
  if (field.provenance === "admin") {
    const who = field.overridden_by ? ` · ${field.overridden_by}` : "";
    const when = field.overridden_at ? ` · ${fmtDate(field.overridden_at)}` : "";
    return `Edited by admin${who}${when}`;
  }
  if (field.provenance === "owner") return "Edited by owner";
  if (isEmptyValue(field.source_value) && isEmptyValue(field.value)) return "Not set";
  const when = field.source_synced_at ? ` · ${fmtAgo(field.source_synced_at)}` : "";
  return `Auto-pulled · ${field.source_label || "source system"}${when}`;
}

export default function ProvenanceChip({ field, onClick, className }: { field: FieldValue; onClick?: () => void; className?: string }) {
  const label = provenanceLabel(field);
  const kind = field.provenance === "admin" ? "admin" : field.provenance === "owner" ? "owner" : label === "Not set" ? "empty" : "source";
  const Icon = { admin: ShieldAlert, owner: PenLine, source: CloudDownload, empty: CircleDashed }[kind];
  const tone = {
    admin: "border-primary/40 bg-primary/12 text-primary",
    owner: "border-info/35 bg-info/12 text-info",
    source: "border-border bg-secondary text-secondary-foreground",
    empty: "border-dashed border-border bg-transparent text-muted-foreground",
  }[kind];
  const hasSource = !isEmptyValue(field.source_value);
  const tip = (
    <span className="flex flex-col gap-1">
      {hasSource && (
        <span>
          <span className="text-muted-foreground">Source{field.source_label ? ` (${field.source_label})` : ""}: </span>
          {previewValue(field.source_value)}
        </span>
      )}
      <span>
        <span className="text-muted-foreground">Current: </span>
        {previewValue(field.value)}
      </span>
      {field.override_reason && (
        <span>
          <span className="text-muted-foreground">Reason: </span>
          {field.override_reason}
        </span>
      )}
      {field.provenance !== "source" && field.overridden_by && (
        <span className="text-muted-foreground">
          By {field.overridden_by}
          {field.overridden_at ? ` on ${fmtDate(field.overridden_at)}` : ""}
        </span>
      )}
      {field.provenance === "admin" && hasSource && <span className="text-muted-foreground">{field.lock_mode === "keep" ? "Locked: future syncs keep this value" : "Follows the source again on the next sync"}</span>}
      {onClick && <span className="text-muted-foreground">Click for the field's history</span>}
    </span>
  );
  const body = (
    <>
      <Icon size={11} aria-hidden />
      <span className="truncate">{label}</span>
    </>
  );
  const cls = cx("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-ui-xs font-semibold", tone, className);
  return (
    <Tooltip content={tip}>
      {onClick ? (
        <button type="button" data-provenance={kind} onClick={onClick} aria-label={`Provenance: ${label}. Show history`} className={cx(cls, "hover:brightness-110")}>
          {body}
        </button>
      ) : (
        <span tabIndex={0} data-provenance={kind} aria-label={`Provenance: ${label}`} className={cls}>
          {body}
        </span>
      )}
    </Tooltip>
  );
}
