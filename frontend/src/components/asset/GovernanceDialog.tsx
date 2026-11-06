// Steward curation: certification, risk tier and sensitivity, with a required reason (PUT …/governance).
import { BadgeCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { assetApi } from "../../lib/assets";
import type { AssetCard, Certification, RiskTier, Sensitivity } from "../../lib/types";
import { Button, Modal, Select, TextArea, useToast } from "../ui";
import { writeErrorMessage } from "./errors";
import { CERTIFICATION, RISK, SENSITIVITY } from "./meta";

export default function GovernanceDialog({ open, onClose, asset, onSaved }: { open: boolean; onClose: () => void; asset: AssetCard; onSaved?: (card: AssetCard) => void }) {
  const [certification, setCertification] = useState<Certification>(asset.certification);
  const [risk, setRisk] = useState<RiskTier>(asset.risk_tier);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(asset.sensitivity);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setCertification(asset.certification === "unreviewed" ? "certified" : asset.certification);
    setRisk(asset.risk_tier);
    setSensitivity(asset.sensitivity);
    setReason("");
    setTried(false);
    setServerError(null);
  }, [open, asset.certification, asset.risk_tier, asset.sensitivity]);

  const changed = certification !== asset.certification || risk !== asset.risk_tier || sensitivity !== asset.sensitivity;
  const error = !reason.trim() ? "A reason is required; it is written to the audit log." : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (error || !changed) return;
    setBusy(true);
    setServerError(null);
    try {
      const body: Record<string, string> = { reason: reason.trim() };
      if (certification !== asset.certification) body.certification = certification;
      if (risk !== asset.risk_tier) body.risk_tier = risk;
      if (sensitivity !== asset.sensitivity) body.sensitivity = sensitivity;
      const card = await api.put<AssetCard>(`${assetApi(asset.asset_id)}/governance`, body);
      toast.success("Governance updated", `${asset.display_name}: ${CERTIFICATION[card.certification]?.label ?? card.certification}`);
      onSaved?.(card);
      onClose();
    } catch (err) {
      setServerError(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const opts = <T extends string>(m: Record<T, { label: string }>) => (Object.keys(m) as T[]).map((k) => ({ value: k, label: m[k].label }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Review ${asset.display_name}`}
      description="Certification, risk tier and data sensitivity drive the required policies and what consumers see."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="governance-form" loading={busy} disabled={!changed} icon={<BadgeCheck size={15} aria-hidden />}>
            Save review
          </Button>
        </>
      }
    >
      <form id="governance-form" noValidate onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Certification" value={certification} onValueChange={(v) => setCertification(v as Certification)} options={opts(CERTIFICATION)} />
          <Select label="Risk tier" value={risk} onValueChange={(v) => setRisk(v as RiskTier)} options={opts(RISK)} />
          <Select label="Sensitivity" value={sensitivity} onValueChange={(v) => setSensitivity(v as Sensitivity)} options={opts(SENSITIVITY)} />
        </div>
        <TextArea label="Reason (required)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={tried ? error : null} />
        {!changed && <p className="text-ui-xs text-muted-foreground">Change at least one value to save.</p>}
        {serverError && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
