// Governance › Unity Catalog lineage › Readiness: can a publish succeed right now, and if not, which grant is missing and
// who runs it. GET /api/lineage/uc-publish/readiness checks each publishing identity read-only: the app service principal,
// you (when the Apps proxy forwards your token) and the sync job's identity. Each check is CREATE EXTERNAL METADATA on
// the metastore, MODIFY on the plan's tables, or the external lineage API answering. Re-check bypasses the server's short
// cache. A failed check request shows an inline error and never blocks the rest of the page or the Publish button.
import { motion } from "framer-motion";
import { CircleCheck, CircleHelp, CircleMinus, CircleX, RefreshCw, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { UseApi } from "../../lib/api";
import { stagger, staggerItem } from "../../lib/motion";
import type { UcCheckStatus, UcReadiness, UcReadinessCheck, UcReadinessPath, UcReadinessStatus } from "../../lib/types";
import { CopyButton } from "../asset/primitives";
import SourcePill from "../SourcePill";
import { Badge, Button, Card, type BadgeVariant } from "../ui";
import { AsyncBlock, RowsSkeleton } from "../workspace/feedback";
import { fmtDateTime, fmtRelative } from "../workspace/format";

export const READINESS_PATH = "/api/lineage/uc-publish/readiness";

export const READINESS: Record<UcReadinessStatus, { variant: BadgeVariant; label: string }> = {
  ready: { variant: "success", label: "Ready" },
  partial: { variant: "warning", label: "Ready, with table gaps" },
  blocked: { variant: "destructive", label: "Blocked" },
  unknown: { variant: "neutral", label: "Unknown" },
  not_required: { variant: "info", label: "Not needed (record only)" },
};

const CHECK: Record<UcCheckStatus, { icon: LucideIcon; tone: string; label: string }> = {
  ok: { icon: CircleCheck, tone: "text-success", label: "Passed" },
  missing: { icon: CircleX, tone: "text-destructive", label: "Missing" },
  warning: { icon: TriangleAlert, tone: "text-warning", label: "Warning" },
  unknown: { icon: CircleHelp, tone: "text-muted-foreground", label: "Couldn't check" },
  skipped: { icon: CircleMinus, tone: "text-muted-foreground", label: "Not checked here" },
};

const TABLE_STATUS: Record<string, { variant: BadgeVariant; label: string }> = {
  ok: { variant: "success", label: "MODIFY" },
  missing: { variant: "destructive", label: "No MODIFY" },
  not_found: { variant: "warning", label: "Not found" },
  unknown: { variant: "neutral", label: "Unknown" },
};

/** Why Publish is disabled, or null when it may run. Only a blocked answer in platform mode disables it: an unknown answer
 *  (the check itself failed) or a failed readiness request never locks an admin out. */
export function publishBlockedReason(r: UcReadiness | null): string | null {
  if (!r || !r.enforced || r.status !== "blocked") return null;
  return r.reason || "A required privilege is missing for the publishing identity.";
}

function SqlBlock({ sql, label }: { sql: string[]; label: string }) {
  const text = sql.join("\n");
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pl-3 pr-1.5">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre py-1 font-mono text-ui-xs" data-sql>{text}</pre>
      <CopyButton value={text} label={label} />
    </div>
  );
}

function CheckItem({ check }: { check: UcReadinessCheck }) {
  const s = CHECK[check.status] ?? CHECK.unknown;
  const Icon = s.icon;
  const r = check.remediation;
  const gaps = (check.tables ?? []).filter((t) => t.status !== "ok");
  return (
    <li className="flex items-start gap-2.5" data-check={check.id} data-status={check.status}>
      <Icon size={16} aria-hidden className={`mt-0.5 shrink-0 ${s.tone}`} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-sm font-semibold">{check.title}</span>
          <span className={`text-ui-xs font-semibold ${s.tone}`}>{s.label}</span>
          {!check.blocking && check.status !== "ok" && <Badge>Not blocking</Badge>}
        </div>
        <p className="break-words text-ui-sm text-muted-foreground">{check.detail}</p>
        {r && (r.sql.length > 0 || r.note) && (
          <div className="space-y-1">
            <div className="text-ui-xs font-semibold text-muted-foreground">Run by: {r.run_by}</div>
            {r.sql.length > 0 && <SqlBlock sql={r.sql} label={`Copy grant SQL: ${check.title}`} />}
            {r.note && <p className="text-ui-xs text-muted-foreground">{r.note}</p>}
          </div>
        )}
        {gaps.length > 0 && (
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-ui-xs font-semibold">Checked tables ({check.checked} of {check.total})</summary>
            <ul className="mt-1.5 space-y-1 text-ui-xs">
              {(check.tables ?? []).map((t) => (
                <li key={t.table} className="flex flex-wrap items-center gap-2">
                  <Badge variant={(TABLE_STATUS[t.status] ?? TABLE_STATUS.unknown).variant}>{(TABLE_STATUS[t.status] ?? TABLE_STATUS.unknown).label}</Badge>
                  <span className="break-all font-mono">{t.table}</span>
                  <span className="text-muted-foreground">{t.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

function PathCard({ path, active }: { path: UcReadinessPath; active: boolean }) {
  const st = READINESS[path.status] ?? READINESS.unknown;
  return (
    <section aria-label={`${path.label} readiness`} className={`space-y-3 rounded-xl border px-4 py-3 ${active ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-sm font-bold">{path.label}</span>
        <Badge variant={st.variant}>{st.label}</Badge>
        {active && <Badge variant="primary">Used by Publish</Badge>}
        <span className="text-ui-xs text-muted-foreground">{path.applies_to}</span>
        {path.remediation_sql.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-ui-xs text-muted-foreground">
            All grants
            <CopyButton value={path.remediation_sql.join("\n")} label={`Copy all grant SQL for ${path.label}`} />
          </span>
        )}
      </div>
      {path.principal && (
        <div className="flex flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
          <span>{path.principal_kind === "service_principal" ? "Application id" : path.principal_kind === "user" ? "User" : "Principal"}</span>
          <span className="break-all font-mono text-foreground">{path.principal}</span>
          <CopyButton value={path.principal} label={`Copy the principal of ${path.label}`} />
        </div>
      )}
      <ul className="space-y-3">{path.checks.map((c) => <CheckItem key={c.id} check={c} />)}</ul>
      {path.last_check && (
        <p className="text-ui-xs text-muted-foreground">
          Last hourly check ({path.last_check.principal ?? "job identity"}):{" "}
          <span className="font-semibold">{path.last_check.skipped ? `skipped, ${path.last_check.status}` : `published (${path.last_check.status})`}</span>{" "}
          <span title={fmtDateTime(path.last_check.checked_at)}>{fmtRelative(path.last_check.checked_at)}</span>
        </p>
      )}
    </section>
  );
}

export function UcReadinessChecklist({ q, onRecheck }: { q: UseApi<UcReadiness>; onRecheck: () => void }) {
  const r = q.data;
  const st = r ? READINESS[r.status] ?? READINESS.unknown : null;
  return (
    <Card className="space-y-3 !p-4">
      <section aria-label="Publishing readiness" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck size={15} aria-hidden className="text-muted-foreground" />
          <h3 className="text-ui-md font-bold">Readiness</h3>
          {st && <Badge variant={st.variant}>{st.label}</Badge>}
          <SourcePill source={q.source} degradedReason={q.degradedReason} asOf={q.asOf} />
          {r && (
            <span className="text-ui-xs text-muted-foreground" title={fmtDateTime(r.checked_at)}>
              Checked {fmtRelative(r.checked_at)}{r.cached ? ` (cached up to ${Math.round(r.ttl_seconds / 60)} min)` : ""}
            </span>
          )}
          <Button size="sm" variant="secondary" className="ml-auto" icon={<RefreshCw size={14} aria-hidden />} loading={q.loading} onClick={onRecheck}>
            Re-check
          </Button>
        </div>
        <AsyncBlock state={q} skeleton={<RowsSkeleton rows={3} />} errorTitle="Couldn't check publishing readiness">
          {(d) =>
            d.status === "not_required" ? (
              <p className="text-ui-sm text-muted-foreground">{d.reason}</p>
            ) : (
              <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-3">
                {d.reason && d.status !== "ready" && (
                  <motion.p variants={staggerItem} className="break-words text-ui-sm" data-reason>
                    <span className="font-semibold">{d.status === "blocked" ? "Blocked: " : d.status === "unknown" ? "Couldn't confirm: " : "Note: "}</span>
                    {d.reason}
                  </motion.p>
                )}
                {d.paths.map((p, i) => (
                  <motion.div key={p.path} variants={staggerItem}>
                    <PathCard path={p} active={i === 0 && p.path === d.active_path} />
                  </motion.div>
                ))}
                <motion.p variants={staggerItem} className="text-ui-xs text-muted-foreground">
                  The table check samples {d.tables.max_checked} of the plan's {d.tables.total} table(s). For a GRANT per table, run{" "}
                  <span className="font-mono">{d.grants_script}</span> (it only prints).
                </motion.p>
              </motion.div>
            )
          }
        </AsyncBlock>
      </section>
    </Card>
  );
}
