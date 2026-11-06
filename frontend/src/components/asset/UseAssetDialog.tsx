// "I'm using this" / copy-endpoint registration: records WHO uses the asset (by email) and optionally through
// which agent, so change impact reaches every real consumer (POST /api/assets/{id}/use).
import { Activity, Copy } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import { Button, Input, Modal, Select, useToast } from "../ui";
import AssetPicker, { type PickedAsset } from "./AssetPicker";
import { writeErrorMessage } from "./errors";
import { isEmail } from "./format";
import { copyText } from "./primitives";

export type UseOperation = "registered_use" | "copied_endpoint";

export default function UseAssetDialog({
  open,
  onClose,
  asset,
  operation: initialOperation = "registered_use",
  endpoint,
  defaultEmail = "",
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  asset: { asset_id: string; display_name: string };
  operation?: UseOperation;
  /** The endpoint / MCP URL being copied (copied_endpoint). */
  endpoint?: string | null;
  defaultEmail?: string;
  onRecorded?: () => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [operation, setOperation] = useState<UseOperation>(initialOperation);
  const [viaAgent, setViaAgent] = useState<PickedAsset | null>(null);
  const [withVia, setWithVia] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setEmail(defaultEmail);
    setOperation(initialOperation);
    setViaAgent(null);
    setWithVia(false);
    setTried(false);
    setServerError(null);
  }, [open, defaultEmail, initialOperation]);

  const emailError = !email.trim() ? "An email is required: every use is recorded against a person." : !isEmail(email) ? "Enter a valid email address." : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (emailError) return;
    setBusy(true);
    setServerError(null);
    try {
      await api.post(`${assetApi(asset.asset_id)}/use`, {
        consumer_email: email.trim(),
        operation,
        ...(withVia && viaAgent ? { via_asset_id: viaAgent.asset_id } : {}),
      });
      if (operation === "copied_endpoint" && endpoint) await copyText(endpoint);
      toast.success(operation === "copied_endpoint" && endpoint ? "Endpoint copied and use recorded" : "Use recorded", `${asset.display_name} now lists ${email.trim()} as a consumer.`);
      onRecorded?.();
      onClose();
    } catch (err) {
      setServerError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const formId = `use-${asset.asset_id}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={operation === "copied_endpoint" ? "Copy endpoint" : `I'm using ${asset.display_name}`}
      description="Every use is recorded in the registry, so when this asset changes the owners know exactly who and what is downstream, and you are notified first."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} icon={operation === "copied_endpoint" ? <Copy size={15} aria-hidden /> : <Activity size={15} aria-hidden />}>
            {operation === "copied_endpoint" ? "Record and copy" : "Record my use"}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="space-y-4">
        <Input data-autofocus type="email" label="Consumer email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={tried ? emailError : null} />
        <Select
          label="What are you doing?"
          value={operation}
          onValueChange={(v) => setOperation(v as UseOperation)}
          options={[
            { value: "registered_use", label: "I use this asset" },
            { value: "copied_endpoint", label: "I'm copying its endpoint / MCP URL" },
          ]}
        />
        {endpoint && operation === "copied_endpoint" && <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-ui-xs">{endpoint}</p>}
        <label className="flex items-center gap-2 text-ui-sm">
          <input type="checkbox" className="accent-primary" checked={withVia} onChange={(e) => setWithVia(e.target.checked)} />
          Used through one of my agents
        </label>
        {withVia && <AssetPicker value={viaAgent} onChange={setViaAgent} types={["agent"]} excludeId={asset.asset_id} label="Which agent?" />}
        {serverError && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
