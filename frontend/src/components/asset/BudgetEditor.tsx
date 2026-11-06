// Budget bar (benchmark §7.1): month-to-date fill, a lighter forecast extension, alert + limit ticks and a state
// chip; plus the owner's editor (PUT …/budget). Money is always marked Estimated (list price).
import { motion } from "framer-motion";
import { Coins, Pencil } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { assetApi, fmtUsd } from "../../lib/assets";
import { cx } from "../../lib/cx";
import type { Budget } from "../../lib/types";
import { Badge, Button, Input, Select, useToast } from "../ui";
import { EstimatedTag } from "./badges";
import { writeErrorMessage } from "./errors";

const STATE: Record<Budget["state"], { label: string; variant: "success" | "warning" | "destructive" }> = {
  on_track: { label: "On track", variant: "success" },
  at_risk: { label: "At risk: forecast above alert", variant: "warning" },
  exceeded: { label: "Exceeded", variant: "destructive" },
};

export function BudgetBar({ budget }: { budget: Budget }) {
  const cap = Math.max(budget.monthly_usd, budget.forecast_usd, budget.mtd_usd, 1) * 1.08;
  const pct = (v: number) => `${Math.min(100, (v / cap) * 100)}%`;
  const alertAt = (budget.monthly_usd * budget.alert_pct) / 100;
  const fill = budget.state === "exceeded" ? "bg-destructive" : budget.state === "at_risk" ? "bg-warning" : "bg-success";
  const state = STATE[budget.state] ?? STATE.on_track;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-md font-bold tabular-nums">{fmtUsd(budget.mtd_usd)}</span>
        <span className="text-ui-sm text-muted-foreground">month to date of {fmtUsd(budget.monthly_usd)}</span>
        <Badge variant={state.variant}>{state.label}</Badge>
        <span className="text-ui-xs text-muted-foreground">
          {budget.action === "block" ? "Blocks usage at the limit" : "Alerts at the threshold"} · {budget.source === "unity_gateway" ? "Unity Gateway budget" : "Registry budget"}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Budget: ${fmtUsd(budget.mtd_usd)} spent of ${fmtUsd(budget.monthly_usd)}, forecast ${fmtUsd(budget.forecast_usd)} by month end, alert at ${fmtUsd(alertAt)}. ${state.label}.`}
        className="relative h-4 overflow-visible rounded-full bg-muted"
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-foreground/15" style={{ width: pct(budget.forecast_usd) }} />
        <motion.div className={cx("absolute inset-y-0 left-0 rounded-full", fill)} initial={{ width: 0 }} animate={{ width: pct(budget.mtd_usd) }} transition={{ duration: 0.7, ease: "easeOut" }} />
        {[
          { at: alertAt, label: `Alert ${fmtUsd(alertAt)}` },
          { at: budget.monthly_usd, label: `${budget.action === "block" ? "Block" : "Limit"} ${fmtUsd(budget.monthly_usd)}` },
        ].map((t) => (
          <div key={t.label} className="absolute -top-1 bottom-[-4px] w-0.5 bg-foreground/70" style={{ left: pct(t.at) }}>
            <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-ui-xs font-semibold text-muted-foreground">{t.label}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-5 text-ui-xs text-muted-foreground">
        <span>
          <span aria-hidden className="mr-1 inline-block h-2 w-3 rounded-sm bg-foreground/15 align-middle" />
          Forecast to month end: <span className="font-semibold text-foreground">{fmtUsd(budget.forecast_usd)}</span>
        </span>
        <EstimatedTag />
      </div>
    </div>
  );
}

export default function BudgetEditor({ assetId, budget, onSaved, onCancel }: { assetId: string; budget: Budget | null; onSaved: (b: Budget) => void; onCancel?: () => void }) {
  const [monthly, setMonthly] = useState(String(budget?.monthly_usd ?? ""));
  const [alertPct, setAlertPct] = useState(String(budget?.alert_pct ?? 80));
  const [action, setAction] = useState<Budget["action"]>(budget?.action ?? "alert");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setMonthly(String(budget?.monthly_usd ?? ""));
    setAlertPct(String(budget?.alert_pct ?? 80));
    setAction(budget?.action ?? "alert");
  }, [budget]);

  const m = Number(monthly);
  const a = Number(alertPct);
  const errors = {
    monthly: !(m > 0) ? "Enter a monthly amount above $0." : null,
    alert: !(a >= 1 && a <= 100) ? "Alert threshold is a percentage between 1 and 100." : null,
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (errors.monthly || errors.alert) return;
    setBusy(true);
    try {
      const saved = await api.put<Budget>(`${assetApi(assetId)}/budget`, { monthly_usd: m, alert_pct: a, action });
      onSaved(saved);
      toast.success("Budget saved", `${fmtUsd(saved.monthly_usd)}/month · alert at ${saved.alert_pct}%`);
    } catch (err) {
      toast.error("Budget not saved", writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={submit} aria-label="Budget settings" className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-ui-base font-semibold">
        <Coins size={15} aria-hidden className="text-primary" />
        {budget ? "Edit budget" : "Set a monthly budget"}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input type="number" min={1} step="any" label="Monthly budget (USD)" value={monthly} onChange={(e) => setMonthly(e.target.value)} error={tried ? errors.monthly : null} />
        <Input type="number" min={1} max={100} label="Alert at (% of budget)" value={alertPct} onChange={(e) => setAlertPct(e.target.value)} error={tried ? errors.alert : null} />
        <Select
          label="At the limit"
          value={action}
          onValueChange={(v) => setAction(v as Budget["action"])}
          options={[
            { value: "alert", label: "Send an alert" },
            { value: "block", label: "Block usage" },
          ]}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} icon={<Pencil size={13} aria-hidden />}>
          Save budget
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
