// What a candidate was tested and applied with: the step timeline (regression on the Lakebase branch, and the
// apply run on production), a small JSON viewer for step details, and the pending-migrations table.
import { motion } from "framer-motion";
import { Check, ChevronDown, CircleCheck, CircleX, FlaskConical, GitBranch, Rocket, ShieldAlert, Timer } from "lucide-react";
import { useId, useState } from "react";
import { cx } from "../../lib/cx";
import { stagger, staggerItem } from "../../lib/motion";
import type { MigrationAnalysis, RegressionStep, UpdateCandidate } from "../../lib/types";
import { Badge } from "../ui";
import { fmtDateTime, fmtMs, plural } from "../workspace/format";
import { AutoApplyChip } from "./chips";
import type { AutoUpgrade } from "./model";

// ------------------------------------------------------------------------------------------------ JSON viewer
function Primitive({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">null</span>;
  if (typeof value === "string") return <span className="break-all text-success">“{value}”</span>;
  if (typeof value === "number") return <span className="text-warning">{value}</span>;
  if (typeof value === "boolean") return <span className="text-info">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

const isTree = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === "object" && v !== null;

function JsonNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const key = name !== null && <span className="text-foreground/80">{name}: </span>;
  if (!isTree(value)) {
    return (
      <li className="leading-relaxed">
        {key}
        <Primitive value={value} />
      </li>
    );
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const open = Array.isArray(value) ? "[" : "{";
  const close = Array.isArray(value) ? "]" : "}";
  if (entries.length === 0) {
    return (
      <li>
        {key}
        <span className="text-muted-foreground">{open}{close}</span>
      </li>
    );
  }
  return (
    <li>
      <details open={depth < 2} className="group/json">
        <summary className="cursor-pointer list-none rounded hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
          <ChevronDown size={11} aria-hidden className="mr-0.5 inline -rotate-90 align-middle transition-transform group-open/json:rotate-0" />
          {key}
          <span className="text-muted-foreground">
            {open} {Array.isArray(value) ? plural(entries.length, "item") : plural(entries.length, "key")} {close}
          </span>
        </summary>
        <ul className="ml-1.5 border-l border-border/80 pl-3">
          {entries.map(([k, v]) => (
            <JsonNode key={k} name={Array.isArray(value) ? null : k} value={v} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Collapsible JSON tree (objects and arrays fold; the first two levels start open). */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <ul aria-label="Step detail (JSON)" className={cx("overflow-x-auto rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-ui-xs", className)}>
      <JsonNode name={null} value={value} depth={0} />
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ steps
const INLINE_MAX = 140;
const inlineText = (d: unknown): d is string => typeof d === "string" && d.length <= INLINE_MAX && !d.includes("\n");
const hasDetail = (d: unknown) => d !== null && d !== undefined && d !== "";

function StepRow({ step, last }: { step: RegressionStep; last: boolean }) {
  const failed = step.status === "failed";
  const expandable = hasDetail(step.detail) && !inlineText(step.detail);
  const [open, setOpen] = useState(failed);
  const panelId = useId();
  return (
    <motion.li variants={staggerItem} className="relative flex gap-3 pb-3 last:pb-0" data-status={step.status}>
      {!last && <span aria-hidden className="absolute bottom-0 left-[11px] top-6 w-px bg-border" />}
      <span className={cx("relative z-10 mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full ring-4 ring-card", failed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success")}>
        {failed ? <CircleX size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-ui-sm font-semibold">{step.name}</span>
          <span className={cx("text-ui-xs font-bold uppercase tracking-wide", failed ? "text-destructive" : "text-success")}>{failed ? "Failed" : "Passed"}</span>
          <span className="inline-flex items-center gap-1 font-mono text-ui-xs text-muted-foreground" title="Duration">
            <Timer size={11} aria-hidden />
            {fmtMs(step.duration_ms)}
          </span>
          {expandable && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${open ? "Hide" : "Show"} detail for ${step.name}`}
              onClick={() => setOpen((o) => !o)}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {open ? "Hide detail" : "Detail"}
              <ChevronDown size={12} aria-hidden className={cx("transition-transform", open && "rotate-180")} />
            </button>
          )}
        </div>
        {inlineText(step.detail) && step.detail && <p className={cx("mt-0.5 break-words font-mono text-ui-xs", failed ? "text-destructive" : "text-muted-foreground")}>{step.detail}</p>}
        {expandable && open && (
          <div id={panelId} className="mt-1.5">
            {typeof step.detail === "string" ? (
              <pre className={cx("max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 font-mono text-ui-xs", failed ? "border-destructive/40 bg-destructive/8 text-destructive" : "border-border bg-background/60")}>
                {step.detail}
              </pre>
            ) : (
              <JsonView value={step.detail} className="max-h-72" />
            )}
          </div>
        )}
      </div>
    </motion.li>
  );
}

/** A vertical step timeline: pass/fail icon and word, duration, and the step's detail (expandable). */
export function StepTimeline({ steps, label }: { steps: RegressionStep[]; label: string }) {
  if (steps.length === 0) return <p className="text-ui-sm text-muted-foreground">No steps were recorded.</p>;
  return (
    <motion.ol variants={stagger} initial="hidden" animate="show" aria-label={label}>
      {steps.map((s, i) => (
        <StepRow key={`${i}-${s.name}`} step={s} last={i === steps.length - 1} />
      ))}
    </motion.ol>
  );
}

function span(start: string, end: string): number | null {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The regression report: verdict, branch, timing, auto-apply eligibility and the step timeline. */
export function RegressionReport({ candidate, policy }: { candidate: UpdateCandidate; policy: AutoUpgrade }) {
  const r = candidate.regression;
  if (!r) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-ui-sm text-muted-foreground">
        <FlaskConical size={14} aria-hidden className="mr-1.5 inline align-[-2px]" />
        {candidate.status === "testing" ? "A regression is running on a fresh Lakebase branch. The report appears here when it finishes." : "Not regression-tested yet. Re-run the regression to test it on a throwaway Lakebase branch."}
      </div>
    );
  }
  const passedSteps = r.steps.filter((s) => s.status === "passed").length;
  const total = span(r.started_at, r.finished_at);
  return (
    <section aria-label="Regression report" className={cx("rounded-xl border p-3.5", r.passed ? "border-success/30 bg-success/5" : "border-destructive/35 bg-destructive/5")}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FlaskConical size={15} aria-hidden className={r.passed ? "text-success" : "text-destructive"} />
        <h4 className="text-ui-base font-bold">Regression report</h4>
        {r.passed ? (
          <Badge variant="success" icon={<CircleCheck size={12} aria-hidden />}>Passed</Badge>
        ) : (
          <Badge variant="destructive" icon={<CircleX size={12} aria-hidden />}>Failed</Badge>
        )}
        <span className="text-ui-xs text-muted-foreground">{passedSteps} of {plural(r.steps.length, "step")} passed</span>
        {candidate.auto_apply && <AutoApplyChip policy={policy} />}
      </div>
      <dl className="mb-3 grid gap-x-4 gap-y-1 text-ui-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="flex min-w-0 items-center gap-1.5 font-mono">
          <GitBranch size={12} aria-hidden className="shrink-0 text-db-teal" />
          <span className="truncate" title={r.branch || candidate.branch_name || undefined}>{r.branch || candidate.branch_name || "–"}</span>
        </dd>
        <dt className="text-muted-foreground">Ran</dt>
        <dd>
          {fmtDateTime(r.started_at)}
          {total !== null && <span className="text-muted-foreground"> · took {fmtMs(total)}</span>}
        </dd>
      </dl>
      <StepTimeline steps={r.steps} label="Regression steps" />
    </section>
  );
}

/** The apply run on production (migrate, enable the adapter, deploy the staged app). */
export function ApplyReport({ detail }: { detail: NonNullable<UpdateCandidate["apply_detail"]> }) {
  return (
    <section aria-label="Apply report" className={cx("rounded-xl border p-3.5", detail.ok ? "border-border bg-muted/30" : "border-destructive/35 bg-destructive/5")}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Rocket size={15} aria-hidden className={detail.ok ? "text-primary" : "text-destructive"} />
        <h4 className="text-ui-base font-bold">Apply report</h4>
        {detail.ok ? (
          <Badge variant="success" icon={<CircleCheck size={12} aria-hidden />}>Applied</Badge>
        ) : (
          <Badge variant="destructive" icon={<CircleX size={12} aria-hidden />}>Apply failed</Badge>
        )}
        <span className="text-ui-xs text-muted-foreground">finished {fmtDateTime(detail.finished_at)}</span>
      </div>
      <StepTimeline steps={detail.steps} label="Apply steps" />
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ migrations
export function MigrationsTable({ migrations }: { migrations: MigrationAnalysis[] }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-ui-sm">
        <caption className="sr-only">Pending database migrations</caption>
        <thead className="bg-muted/60 text-left text-ui-xs text-muted-foreground">
          <tr>
            {["Version", "Breaking", "Reasons", "Statements"].map((h) => (
              <th key={h} scope="col" className={cx("px-3 py-1.5 font-semibold", h === "Statements" && "text-right")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {migrations.map((m) => (
            <tr key={m.version} className="border-t border-border/70 align-top">
              <td className="whitespace-nowrap px-3 py-2 font-mono font-semibold">{m.version}</td>
              <td className="px-3 py-2">
                {m.breaking ? (
                  <Badge variant="destructive" icon={<ShieldAlert size={11} aria-hidden />}>Breaking</Badge>
                ) : (
                  <span className="inline-flex items-center gap-1 text-ui-xs font-semibold text-success"><Check size={12} aria-hidden /> Additive</span>
                )}
              </td>
              <td className="px-3 py-2">
                {m.reasons.length ? (
                  <ul className="space-y-0.5 text-ui-xs">
                    {m.reasons.map((r) => <li key={r} className="break-words font-mono">{r}</li>)}
                  </ul>
                ) : (
                  <span className="text-ui-xs text-muted-foreground">No breaking statements found</span>
                )}
                {m.allow_data_loss && <Badge variant="warning" className="mt-1">Declares allow-data-loss</Badge>}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{m.statements}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
