// Pause / resume / deprecate / retire (registry status; notifies subscribers). A reason is required, the
// downstream blast radius is shown first, and nothing changes until the server confirms (never optimistic).
import { Archive, CirclePause, CirclePlay, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, useApi } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import type { LineageGraph } from "../../lib/types";
import { Button, Modal, Skeleton, TextArea, useToast } from "../ui";
import { writeErrorMessage } from "./errors";
import { plural } from "./format";
import { Banner } from "./primitives";

export type RuntimeAction = "pause" | "resume" | "deprecate" | "retire";

const COPY: Record<RuntimeAction, { title: string; verb: string; body: string; danger: boolean; icon: typeof Archive }> = {
  pause: { title: "Pause", verb: "Pause asset", body: "Consumers are told to stop calling it. The configuration is preserved, so you can resume it in one click.", danger: true, icon: CirclePause },
  resume: { title: "Resume", verb: "Resume asset", body: "Marks the asset available again and tells subscribers it is back.", danger: false, icon: CirclePlay },
  deprecate: { title: "Deprecate", verb: "Deprecate asset", body: "It stays available, but consumers are asked to migrate. Subscribers get a deprecation notice.", danger: true, icon: TriangleAlert },
  retire: { title: "Retire", verb: "Retire asset", body: "Removes it from the catalog. Subscribers and downstream owners are notified. Use after a deprecation period.", danger: true, icon: Archive },
};

export const MIN_REASON = 5;

export default function RuntimeActionDialog({
  open,
  onClose,
  asset,
  action,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  asset: { asset_id: string; display_name: string; subscribers: number };
  action: RuntimeAction;
  onDone?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const toast = useToast();
  const downstream = useApi<LineageGraph>(open && action !== "resume" ? `/api/lineage?focus=${encodeURIComponent(asset.asset_id)}&depth=1&dir=down` : null);
  const copy = COPY[action];

  useEffect(() => {
    if (!open) return;
    setReason("");
    setTried(false);
    setServerError(null);
  }, [open, action]);

  const downstreamAssets = (downstream.data?.nodes ?? []).filter((n) => n.id !== asset.asset_id && ["agent", "mcp_server", "tool", "skill", "app"].includes(n.type));
  const error = reason.trim().length < MIN_REASON ? `A reason is required (at least ${MIN_REASON} characters); it is audited and sent to subscribers.` : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (error) return;
    setBusy(true);
    setServerError(null);
    try {
      await api.post(`${assetApi(asset.asset_id)}/runtime`, { action, reason: reason.trim() });
      toast.success(`${copy.title}d ${asset.display_name}`, asset.subscribers ? `${plural(asset.subscribers, "subscriber")} will be notified.` : undefined);
      onDone?.();
      onClose();
    } catch (err) {
      setServerError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const Icon = copy.icon;
  const formId = `runtime-${action}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${copy.title} ${asset.display_name}?`}
      description={copy.body}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={copy.danger ? "danger" : "primary"} loading={busy} icon={<Icon size={15} aria-hidden />}>
            {copy.verb}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="space-y-4">
        {action !== "resume" && (
          <Banner tone="warning" icon={<TriangleAlert size={16} aria-hidden />} title="Who this affects">
            {downstream.loading ? (
              <Skeleton className="mt-1 h-4 w-56" />
            ) : (
              <>
                {plural(asset.subscribers, "subscriber")} will be notified
                {downstreamAssets.length > 0 && (
                  <>
                    , and {plural(downstreamAssets.length, "downstream asset")} depend on it: {downstreamAssets.slice(0, 5).map((n) => n.label).join(", ")}
                    {downstreamAssets.length > 5 ? "…" : ""}
                  </>
                )}
                .
              </>
            )}
          </Banner>
        )}
        <TextArea data-autofocus label="Reason (required)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={tried ? error : null} hint="Shown in the audit log and the subscriber notification." />
        {serverError && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
