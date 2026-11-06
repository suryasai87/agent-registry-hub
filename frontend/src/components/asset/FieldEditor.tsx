// One description field with provenance (benchmark §5.3 / §5.4).
//  * Owner-authored fields (no source value): owners/stewards edit inline; the save is optimistic with Undo.
//  * Synced fields (a source value exists): only stewards/admins may Override, with a required reason and a
//    lock mode. Overrides are NOT optimistic. "Revert to source" clears the override.
//  * Drift (the source moved under a kept override): side-by-side diff + Keep override / Accept source.
import { AnimatePresence, motion } from "framer-motion";
import { Eye, Lock, Pencil, Plus, RotateCcw, ShieldAlert, Trash, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { AssetPermissions, FieldValue } from "../../lib/types";
import { Badge, Button, IconButton, Input, TextArea, Tooltip, useToast } from "../ui";
import { writeErrorMessage } from "./errors";
import { isEmptyValue } from "./format";
import Markdown from "./Markdown";
import { CopyButton, Segmented } from "./primitives";
import ProvenanceChip, { previewValue } from "./ProvenanceChip";

const MAX_TEXT: Record<string, number> = { purpose: 140 };

type LinkRow = { label: string; url: string };
type KvRow = { key: string; value: string };
type Draft = string | LinkRow[] | KvRow[];

function toDraft(field: FieldValue, value: unknown = field.value): Draft {
  switch (field.kind) {
    case "list":
      return Array.isArray(value) ? value.map(String).join("\n") : typeof value === "string" ? value : "";
    case "links":
      return Array.isArray(value) ? value.map((l) => ({ label: String((l as LinkRow)?.label ?? ""), url: String((l as LinkRow)?.url ?? "") })) : [];
    case "kv":
      return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>).map(([key, v]) => ({ key, value: String(v ?? "") })) : [];
    default:
      return typeof value === "string" ? value : value == null ? "" : String(value);
  }
}

function fromDraft(field: FieldValue, draft: Draft): unknown {
  switch (field.kind) {
    case "list":
      return String(draft)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    case "links":
      return (draft as LinkRow[]).filter((l) => l.url.trim()).map((l) => ({ label: l.label.trim() || l.url.trim(), url: l.url.trim() }));
    case "kv":
      return Object.fromEntries((draft as KvRow[]).filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value.trim()]));
    default:
      return String(draft).trim();
  }
}

function validateDraft(field: FieldValue, draft: Draft): string | null {
  if (field.kind === "text" || field.kind === "enum") {
    const max = MAX_TEXT[field.field_key];
    if (max && String(draft).trim().length > max) return `${field.label} is limited to ${max} characters.`;
  }
  if (field.kind === "links") {
    const bad = (draft as LinkRow[]).find((l) => l.url.trim() && !/^https?:\/\//i.test(l.url.trim()));
    if (bad) return `Links must start with http:// or https:// (${bad.url}).`;
  }
  return null;
}

/** Read-only rendering of a field value by kind. */
export function FieldValueView({ field, value: given, onCopied }: { field: Pick<FieldValue, "kind" | "field_key" | "label" | "value">; value?: unknown; onCopied?: (text: string) => void }) {
  const value = given === undefined ? field.value : given;
  if (isEmptyValue(value)) return <p className="text-ui-sm italic text-muted-foreground">Not provided</p>;
  if (field.kind === "longtext" && typeof value === "string") return <Markdown source={value} />;
  if (field.kind === "list" && Array.isArray(value))
    return (
      <ul className="ml-4 list-disc space-y-0.5 text-ui-base">
        {value.map((v, i) => (
          <li key={i}>{String(v)}</li>
        ))}
      </ul>
    );
  if (field.kind === "links" && Array.isArray(value))
    return (
      <ul className="space-y-1 text-ui-base">
        {value.map((l, i) => {
          const link = l as LinkRow;
          const safe = /^https?:\/\//i.test(link.url ?? "");
          return (
            <li key={i}>
              {safe ? (
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
                  {link.label || link.url}
                </a>
              ) : (
                <span>{link.label || link.url}</span>
              )}
            </li>
          );
        })}
      </ul>
    );
  if (field.kind === "kv" && typeof value === "object" && value !== null)
    return (
      <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1 text-ui-sm">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium">{String(v)}</dd>
          </div>
        ))}
      </dl>
    );
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (field.field_key === "endpoint_url")
    return (
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1 font-mono text-ui-sm">{text}</code>
        <CopyButton value={text} label={`Copy ${field.label}`} onCopied={() => onCopied?.(text)} />
      </div>
    );
  return <p className="whitespace-pre-wrap text-ui-base">{text}</p>;
}

function DraftEditor({ field, draft, setDraft, idBase }: { field: FieldValue; draft: Draft; setDraft: (d: Draft) => void; idBase: string }) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  if (field.kind === "longtext") {
    return (
      <div className="space-y-2">
        <Segmented
          label={`${field.label} editor mode`}
          value={tab}
          onChange={setTab}
          options={[
            { value: "write", label: "Write", icon: <Pencil size={12} aria-hidden /> },
            { value: "preview", label: "Preview", icon: <Eye size={12} aria-hidden /> },
          ]}
        />
        {tab === "write" ? (
          <TextArea id={`${idBase}-value`} aria-label={`${field.label} (Markdown)`} rows={7} value={String(draft)} onChange={(e) => setDraft(e.target.value)} hint="Markdown: **bold**, *italic*, `code`, lists, [links](https://…)" />
        ) : (
          <div className="min-h-24 rounded-lg border border-border bg-background/40 px-3 py-2">{String(draft).trim() ? <Markdown source={String(draft)} /> : <p className="text-ui-sm text-muted-foreground">Nothing to preview</p>}</div>
        )}
      </div>
    );
  }
  if (field.kind === "list") {
    return <TextArea id={`${idBase}-value`} aria-label={field.label} rows={4} value={String(draft)} onChange={(e) => setDraft(e.target.value)} hint="One item per line" />;
  }
  if (field.kind === "links" || field.kind === "kv") {
    const isLinks = field.kind === "links";
    const rows = draft as (LinkRow | KvRow)[];
    const update = (i: number, patch: Partial<LinkRow & KvRow>) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) as Draft);
    return (
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-start gap-2">
            <Input
              aria-label={isLinks ? `Link ${i + 1} label` : `Row ${i + 1} key`}
              placeholder={isLinks ? "Label (e.g. Runbook)" : "Key (e.g. availability)"}
              value={isLinks ? (r as LinkRow).label : (r as KvRow).key}
              onChange={(e) => update(i, isLinks ? { label: e.target.value } : { key: e.target.value })}
              wrapperClassName="w-2/5"
            />
            <Input
              aria-label={isLinks ? `Link ${i + 1} URL` : `Row ${i + 1} value`}
              placeholder={isLinks ? "https://…" : "Value (e.g. 99.9%)"}
              value={isLinks ? (r as LinkRow).url : (r as KvRow).value}
              onChange={(e) => update(i, isLinks ? { url: e.target.value } : { value: e.target.value })}
              wrapperClassName="flex-1"
            />
            <IconButton label={`Remove row ${i + 1}`} icon={<Trash size={14} aria-hidden />} onClick={() => setDraft(rows.filter((_, j) => j !== i) as Draft)} />
          </div>
        ))}
        <Button size="sm" variant="secondary" icon={<Plus size={13} aria-hidden />} onClick={() => setDraft([...rows, isLinks ? { label: "", url: "" } : { key: "", value: "" }] as Draft)}>
          {isLinks ? "Add link" : "Add row"}
        </Button>
      </div>
    );
  }
  const max = MAX_TEXT[field.field_key];
  const len = String(draft).length;
  return <Input id={`${idBase}-value`} aria-label={field.label} value={String(draft)} onChange={(e) => setDraft(e.target.value)} hint={max ? `${len}/${max} characters` : undefined} error={max && len > max ? `Limited to ${max} characters` : null} />;
}

export interface FieldEditorProps {
  assetId: string;
  field: FieldValue;
  permissions: Pick<AssetPermissions, "can_edit" | "can_override">;
  /** Called with the new field state (optimistic, confirmed, or rolled back). */
  onChange: (field: FieldValue) => void;
  /** Called once the server has confirmed a write (e.g. to refresh completeness). */
  onSaved?: (field: FieldValue) => void;
  onHistory?: (fieldKey: string) => void;
  /** endpoint_url copy → register the use. */
  onCopyValue?: (text: string) => void;
  me?: string;
  /** Empty fields render as a single header row (label + chip + Add) in view mode. */
  compactEmpty?: boolean;
}

type Mode = "view" | "edit" | "override" | "revert";

export default function FieldEditor({ assetId, field, permissions, onChange, onSaved, onHistory, onCopyValue, me, compactEmpty = false }: FieldEditorProps) {
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<Draft>(() => toDraft(field));
  const [reason, setReason] = useState("");
  const [lockMode, setLockMode] = useState<"keep" | "follow">("keep");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<false | "save" | "keep" | "accept_source" | "revert">(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const base = `${assetApi(assetId)}/fields/${encodeURIComponent(field.field_key)}`;
  const idBase = `field-${field.field_key}`;

  const hasSource = !isEmptyValue(field.source_value);
  const ownerEditable = !hasSource && (permissions.can_edit || permissions.can_override);
  const overridable = hasSource && permissions.can_override;
  const canRevert = hasSource && field.override_value != null && permissions.can_override;

  const open = (next: Mode) => {
    setDraft(toDraft(field));
    setReason("");
    setLockMode(field.lock_mode ?? "keep");
    setTried(false);
    setError(null);
    setMode(next);
  };

  const undoOwnerEdit = async (prev: FieldValue) => {
    onChange(prev);
    try {
      const restored = prev.override_value == null ? await api.post<FieldValue>(`${base}/revert`, { reason: "undo" }) : await api.put<FieldValue>(base, { value: prev.override_value });
      onChange(restored);
      onSaved?.(restored);
      toast.info(`Restored ${field.label}`);
    } catch (err) {
      toast.error(`Couldn't undo ${field.label}`, writeErrorMessage(err));
    }
  };

  const saveOwner = async () => {
    const problem = validateDraft(field, draft);
    if (problem) {
      setError(problem);
      return;
    }
    const value = fromDraft(field, draft);
    const prev = field;
    // Optimistic: show the new value right away; roll back and reopen the draft if the server refuses.
    onChange({ ...field, value, override_value: value, provenance: "owner", overridden_by: me ?? field.overridden_by, overridden_at: new Date().toISOString(), drift: false });
    setMode("view");
    try {
      const saved = await api.put<FieldValue>(base, { value });
      onChange(saved);
      onSaved?.(saved);
      toast.toast({ kind: "success", title: `Saved ${field.label}`, duration: 6000, action: { label: "Undo", onClick: () => void undoOwnerEdit(prev) } });
    } catch (err) {
      onChange(prev);
      const msg = writeErrorMessage(err);
      setError(msg);
      setMode("edit");
      toast.error(`Couldn't save ${field.label}`, msg);
    }
  };

  const saveOverride = async () => {
    setTried(true);
    const problem = validateDraft(field, draft);
    if (problem) {
      setError(problem);
      return;
    }
    if (!reason.trim()) return;
    setBusy("save");
    setError(null);
    try {
      const saved = await api.put<FieldValue>(base, { value: fromDraft(field, draft), reason: reason.trim(), lock_mode: lockMode });
      onChange(saved);
      onSaved?.(saved);
      setMode("view");
      toast.success(`Overrode ${field.label}`, lockMode === "keep" ? "Future syncs keep your value." : "The next sync replaces it with the source value.");
    } catch (err) {
      const msg = writeErrorMessage(err);
      setError(msg);
      toast.error(`Override not saved`, msg);
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy("revert");
    setError(null);
    try {
      const saved = await api.post<FieldValue>(`${base}/revert`, reason.trim() ? { reason: reason.trim() } : {});
      onChange(saved);
      onSaved?.(saved);
      setMode("view");
      toast.success(`${field.label} follows the source again`);
    } catch (err) {
      setError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resolveDrift = async (action: "keep" | "accept_source") => {
    setBusy(action);
    setError(null);
    try {
      const saved = await api.post<FieldValue>(`${base}/resolve-drift`, { action });
      onChange(saved);
      onSaved?.(saved);
      toast.success(action === "keep" ? "Kept your override" : "Accepted the source value", field.label);
    } catch (err) {
      const msg = writeErrorMessage(err);
      setError(msg);
      toast.error("Drift not resolved", msg);
    } finally {
      setBusy(false);
    }
  };

  const reasonError = tried && !reason.trim() ? "A reason is required to override a synced value." : null;
  let actions: ReactNode = null;
  if (mode === "view") {
    actions = (
      <div className="flex items-center gap-1">
        {ownerEditable && (
          <Button size="sm" variant="ghost" aria-label={`Edit ${field.label}`} icon={<Pencil size={13} aria-hidden />} onClick={() => open("edit")}>
            {isEmptyValue(field.value) ? "Add" : "Edit"}
          </Button>
        )}
        {overridable && (
          <Button size="sm" variant="ghost" aria-label={`Override ${field.label}`} icon={<ShieldAlert size={13} aria-hidden />} onClick={() => open("override")}>
            Override
          </Button>
        )}
        {canRevert && (
          <Button size="sm" variant="ghost" aria-label={`Revert ${field.label} to source`} icon={<RotateCcw size={13} aria-hidden />} onClick={() => open("revert")}>
            Revert to source
          </Button>
        )}
        {hasSource && !permissions.can_override && permissions.can_edit && (
          <Tooltip content={`Synced from ${field.source_label || "the source system"}. Only a steward or admin can override it; change it at the source.`}>
            <span tabIndex={0} role="img" aria-label="Synced field: locked for owners" className="grid h-7 w-7 place-items-center text-muted-foreground">
              <Lock size={13} aria-hidden />
            </span>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby={`${idBase}-label`} data-field={field.field_key} className={cx("rounded-xl border bg-card px-4 py-3", field.drift ? "border-warning/50" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${idBase}-label`} className="text-ui-base font-bold">
          {field.label}
        </h3>
        {field.required && <Badge variant={isEmptyValue(field.value) ? "warning" : "neutral"}>{isEmptyValue(field.value) ? "Required · missing" : "Required"}</Badge>}
        <ProvenanceChip field={field} onClick={onHistory ? () => onHistory(field.field_key) : undefined} />
        <div className="ml-auto">{actions}</div>
      </div>

      {field.drift && (
        <div role="alert" className="mt-3 rounded-lg border border-warning/45 bg-warning/10 p-3">
          <div className="flex items-center gap-2 text-ui-sm font-semibold text-foreground">
            <TriangleAlert size={14} className="text-warning" aria-hidden />
            The source changed since this value was overridden
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-card p-2">
              <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">Source now{field.source_label ? ` · ${field.source_label}` : ""}</div>
              <FieldValueView field={field} value={field.source_value} />
            </div>
            <div className="rounded-md border border-primary/30 bg-card p-2">
              <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">Your override</div>
              <FieldValueView field={field} value={field.override_value} />
            </div>
          </div>
          {permissions.can_override ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy === "keep"} disabled={!!busy} onClick={() => void resolveDrift("keep")}>
                Keep override
              </Button>
              <Button size="sm" loading={busy === "accept_source"} disabled={!!busy} onClick={() => void resolveDrift("accept_source")}>
                Accept source
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => open("override")}>
                Edit
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-ui-xs text-muted-foreground">A steward or admin needs to review this drift.</p>
          )}
        </div>
      )}

      <AnimatePresence initial={false} mode="wait">
        {mode === "view" ? (
          compactEmpty && isEmptyValue(field.value) ? null : (
            <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="mt-2">
              <FieldValueView field={field} onCopied={onCopyValue} />
            </motion.div>
          )
        ) : mode === "revert" ? (
          <motion.div key="revert" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="mt-3 space-y-3">
            <p className="text-ui-sm">
              Revert to the synced value: <span className="font-medium">{previewValue(field.source_value)}</span>
            </p>
            <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
            {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" loading={busy === "revert"} onClick={() => void revert()}>
                Revert to source
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
                Cancel
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="edit"
            noValidate
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void (mode === "override" ? saveOverride() : saveOwner());
            }}
          >
            {mode === "override" && (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-ui-sm">
                <span className="text-muted-foreground">Synced value{field.source_label ? ` (${field.source_label})` : ""}: </span>
                {previewValue(field.source_value, 240)}
              </div>
            )}
            <DraftEditor field={field} draft={draft} setDraft={setDraft} idBase={idBase} />
            {mode === "override" && (
              <>
                <TextArea label="Reason for the override (required)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={reasonError} hint="Audited, and shown to anyone who hovers the provenance chip." />
                <fieldset className="space-y-1.5">
                  <legend className="text-ui-sm font-semibold">On future syncs</legend>
                  {(
                    [
                      { v: "keep", label: "Keep my value on future syncs", hint: "If the source changes, you'll see a drift banner to review" },
                      { v: "follow", label: "Follow source on next sync", hint: "The next sync replaces this override" },
                    ] as const
                  ).map((o) => (
                    <label key={o.v} className="flex cursor-pointer items-start gap-2 text-ui-sm">
                      <input type="radio" name={`${idBase}-lock`} className="mt-1 accent-primary" checked={lockMode === o.v} onChange={() => setLockMode(o.v)} />
                      <span>
                        <span className="block font-medium">{o.label}</span>
                        <span className="block text-ui-xs text-muted-foreground">{o.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-ui-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" type="submit" loading={busy === "save"}>
                {mode === "override" ? "Save override" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
                Cancel
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </section>
  );
}
