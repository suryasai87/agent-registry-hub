// Field revision history (GET …/fields/history): who changed what, from → to, with provenance and reason.
import { ArrowRight } from "lucide-react";
import { useApi } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import type { FieldHistory, FieldValue } from "../../lib/types";
import { Avatar, Badge, Drawer, EmptyState, Select } from "../ui";
import { fmtDateTime } from "./format";
import { previewValue } from "./ProvenanceChip";
import { ErrorCard, TableSkeleton } from "./primitives";

const PROV: Record<FieldHistory["provenance"], { label: string; variant: "neutral" | "info" | "primary" }> = {
  source: { label: "Source", variant: "neutral" },
  owner: { label: "Owner", variant: "info" },
  admin: { label: "Admin", variant: "primary" },
};

export default function FieldHistoryDrawer({ open, onClose, assetId, fields, fieldKey, onFieldKey }: { open: boolean; onClose: () => void; assetId: string; fields: FieldValue[]; fieldKey: string | null; onFieldKey: (key: string | null) => void }) {
  const history = useApi<FieldHistory[]>(open ? `${assetApi(assetId)}/fields/history` : null);
  const labels = Object.fromEntries(fields.map((f) => [f.field_key, f.label]));
  const rows = (history.data ?? []).filter((h) => !fieldKey || h.field_key === fieldKey);
  return (
    <Drawer open={open} onClose={onClose} title="Field history" description="Every edit, override and revert, newest first." width={560}>
      <div className="space-y-4">
        <Select
          label="Field"
          value={fieldKey ?? ""}
          onValueChange={(v) => onFieldKey(v || null)}
          options={[{ value: "", label: "All fields" }, ...fields.map((f) => ({ value: f.field_key, label: f.label }))]}
        />
        {history.error ? (
          <ErrorCard error={history.error} onRetry={history.reload} />
        ) : history.loading && !history.data ? (
          <TableSkeleton rows={4} cols={2} />
        ) : rows.length === 0 ? (
          <EmptyState title="No edits yet" description="This field still shows the value pulled from its source." />
        ) : (
          <ol className="space-y-3">
            {rows.map((h) => (
              <li key={h.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2 text-ui-sm">
                  <Avatar email={h.actor} size={22} />
                  <span className="font-semibold">{h.actor}</span>
                  <Badge variant={PROV[h.provenance]?.variant ?? "neutral"}>{PROV[h.provenance]?.label ?? h.provenance}</Badge>
                  <span className="text-muted-foreground">{labels[h.field_key] ?? h.field_key}</span>
                  <time dateTime={h.at} className="ml-auto text-ui-xs text-muted-foreground">
                    {fmtDateTime(h.at)}
                  </time>
                </div>
                <div className="mt-2 grid items-center gap-2 text-ui-sm sm:grid-cols-[1fr_auto_1fr]">
                  <div className="rounded-md bg-destructive/8 px-2 py-1 text-muted-foreground line-through decoration-destructive/50">{previewValue(h.old_value, 200)}</div>
                  <ArrowRight size={14} aria-label="changed to" className="mx-auto text-muted-foreground" />
                  <div className="rounded-md bg-success/10 px-2 py-1">{previewValue(h.new_value, 200)}</div>
                </div>
                {h.reason && <p className="mt-2 text-ui-xs text-muted-foreground">Reason: {h.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Drawer>
  );
}
