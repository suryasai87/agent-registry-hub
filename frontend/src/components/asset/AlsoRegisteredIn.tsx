// "Also registered in" (Overview › At a glance): this asset's listings in other registries, e.g. the Microsoft 365
// agent registry, which Agent 365 Connected platforms fills with Databricks Genie agents. Each entry shows the registry
// (linked), the ID there, how the sync matched it and the field's provenance (auto-pulled from "Microsoft Agent 365",
// or an admin override). Stewards can unlink a wrong match (an override with a reason, kept on later syncs) or revert
// to the synced value; a later source change under the override shows as drift.
import { CloudDownload, ExternalLink, RotateCcw, ShieldAlert, TriangleAlert, Unlink } from "lucide-react";
import { useState } from "react";
import { api, enc } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { FieldValue, Registration } from "../../lib/types";
import { Badge, Button, IconButton, Modal, TextArea, useToast } from "../ui";
import { writeErrorMessage } from "./errors";
import { CopyButton } from "./primitives";
import { provenanceLabel } from "./ProvenanceChip";

const MATCH: Record<string, string> = {
  genie_space_id: "Genie space id", endpoint_name: "serving endpoint", app_name: "app name", name: "name", steward: "a steward",
};

export function matchLabel(r: Registration): string | null {
  if (!r.match) return null;
  const how = MATCH[r.match] ?? r.match;
  if (r.match === "steward") return "Linked by a steward";
  return `Matched by ${how}${r.confidence != null && r.confidence < 1 ? ` · ${Math.round(r.confidence * 100)}%` : ""}`;
}

export default function AlsoRegisteredIn({ assetId, items, field, canOverride, onChanged }: {
  assetId: string; items: Registration[]; field: FieldValue | null | undefined; canOverride: boolean; onChanged: (next: FieldValue) => void;
}) {
  const [removing, setRemoving] = useState<Registration | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const synced = new Set(((field?.value as Registration[] | null) ?? []).map((r) => `${r.registry}|${r.id}`));
  const url = `/api/assets/${enc(assetId)}/fields/also_registered_in`;

  const unlink = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const keep = ((field?.value as Registration[] | null) ?? []).filter((r) => !(r.registry === removing.registry && r.id === removing.id));
      const next = await api.put<FieldValue>(url, { value: keep, reason: reason.trim(), lock_mode: "keep" });
      onChanged(next);
      toast.success(`Unlinked ${removing.registry} ${removing.id}`, "Later syncs keep this override; a source change raises drift.");
      setRemoving(null);
      setReason("");
    } catch (err) {
      toast.error("Couldn't unlink it", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    setBusy(true);
    try {
      onChanged(await api.post<FieldValue>(`${url}/revert`, { reason: "revert to the synced registrations" }));
      toast.success("Back to the synced registrations");
    } catch (err) {
      toast.error("Couldn't revert", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!items.length && !field) return <>–</>;
  return (
    <div className="space-y-1.5">
      {items.length === 0 ? (
        <span className="text-muted-foreground">None{field?.provenance === "admin" ? " (unlinked by an admin)" : ""}</span>
      ) : (
        <ul className="space-y-1.5" aria-label="Also registered in">
          {items.map((r) => (
            <li key={`${r.registry}-${r.id}`} className="space-y-0.5">
              <span className="flex flex-wrap items-center gap-1">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                    {r.registry} <ExternalLink size={11} aria-hidden />
                  </a>
                ) : (
                  <span className="font-semibold">{r.registry}</span>
                )}
                {r.platform && <Badge>{r.platform}</Badge>}
                {canOverride && synced.has(`${r.registry}|${r.id}`) && (
                  <IconButton size="sm" label={`Unlink ${r.registry} ${r.id}`} icon={<Unlink size={12} aria-hidden />} onClick={() => setRemoving(r)} />
                )}
              </span>
              <span className="flex items-center gap-1">
                <code className="min-w-0 break-all font-mono text-ui-xs text-muted-foreground">{r.id}</code>
                <CopyButton value={r.id} label={`Copy the ${r.registry} ID`} />
              </span>
              {(matchLabel(r) || (r.display_name && r.display_name !== r.id)) && (
                <span className="block text-ui-xs text-muted-foreground">
                  {[r.display_name ? `“${r.display_name}”` : null, matchLabel(r)].filter(Boolean).join(" · ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {field && (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          {/* The side card is narrow: provenance as wrapping text (the full chip truncates there). */}
          <span data-provenance={field.provenance} aria-label={`Provenance: ${provenanceLabel(field)}`}
                className={cx("inline-flex min-w-0 items-start gap-1 break-words text-ui-xs", field.provenance === "admin" ? "text-primary" : "text-muted-foreground")}>
            {field.provenance === "admin" ? <ShieldAlert size={12} aria-hidden className="mt-0.5 shrink-0" /> : <CloudDownload size={12} aria-hidden className="mt-0.5 shrink-0" />}
            <span>{provenanceLabel(field)}{field.override_reason ? ` · “${field.override_reason}”` : ""}</span>
          </span>
          {field.drift && <Badge variant="warning" icon={<TriangleAlert size={11} aria-hidden />}>Source changed</Badge>}
          {canOverride && field.provenance === "admin" && (
            <Button size="sm" variant="ghost" icon={<RotateCcw size={12} aria-hidden />} loading={busy && !removing} onClick={() => void revert()}>
              Revert to synced
            </Button>
          )}
        </div>
      )}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Unlink ${removing?.registry ?? ""} ${removing?.id ?? ""}`}
        description="The listing is hidden from this asset as an admin override. Later syncs keep the override and flag drift if the source changes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void unlink()}>Unlink</Button>
          </>
        }
      >
        <TextArea data-autofocus label="Reason (required, audited)" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  );
}
