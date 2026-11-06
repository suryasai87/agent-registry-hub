// One update candidate: kind, status, title, versions, BREAKING with its reasons, the release-feed items it came
// from, pending migrations, the branch regression report, the apply report, the decision record, and the
// state-aware admin actions (accept / delay / reject / re-run regression / acknowledge).
import { motion } from "framer-motion";
import { ArrowRight, CalendarClock, Check, CheckCheck, ChevronDown, CircleX, ExternalLink, FlaskConical, RotateCcw, ShieldAlert, UserRound } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { cx } from "../../lib/cx";
import { staggerItem } from "../../lib/motion";
import type { JobRun, UpdateCandidate } from "../../lib/types";
import { Button, Card } from "../ui";
import { useWrite } from "../workspace/feedback";
import { fmtDate, fmtDateTime, fmtRelative, plural } from "../workspace/format";
import { BreakingBadge, CandidateStatusBadge, KIND, KindBadge, LifecycleChip } from "./chips";
import { AcceptDialog, AcknowledgeDialog, DelayDialog, RejectDialog, type DecisionKind } from "./DecisionDialogs";
import JobRunNotice from "./JobRunNotice";
import { actionsFor, type AutoUpgrade } from "./model";
import { ApplyReport, MigrationsTable, RegressionReport } from "./Report";

export interface CandidateRuns {
  apply?: JobRun;
  check?: JobRun;
}

export interface CandidateCardProps {
  candidate: UpdateCandidate;
  canDecide: boolean;
  policy: AutoUpgrade;
  defaultDelayDays: number;
  sourceLabel: (sourceId: string) => string;
  /** Job runs started from this card in this session (kept across list reloads). */
  runs?: CandidateRuns;
  onReplace: (next: UpdateCandidate) => void;
  onRun: (candidateId: number, kind: keyof CandidateRuns, run: JobRun | null) => void;
  onStale: () => void;
  /** History cards start folded (reports behind "Show details"). */
  compact?: boolean;
  highlighted?: boolean;
}

function Versions({ from, to }: { from: string | null; to: string | null }) {
  if (!from && !to) return null;
  return (
    <div className="inline-flex flex-wrap items-center gap-1.5 font-mono text-ui-sm" aria-label={`Version ${from ?? "unknown"} to ${to ?? "unknown"}`}>
      <span className="rounded-md border border-border bg-muted/60 px-1.5 py-px">{from ?? "–"}</span>
      <ArrowRight size={13} aria-hidden className="text-muted-foreground" />
      <span className="rounded-md border border-info/40 bg-info/10 px-1.5 py-px font-semibold text-info">{to ?? "–"}</span>
    </div>
  );
}

const SOURCE_PREVIEW = 3;

function SourceItems({ items, sourceLabel }: { items: UpdateCandidate["feed_items"]; sourceLabel: (id: string) => string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SOURCE_PREVIEW);
  return (
    <>
    <ul className="space-y-1.5" aria-label="Source release notes">
      {shown.map((it) => (
        <li key={it.item_id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
          {it.link ? (
            <a href={it.link} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline">
              <span className="truncate">{it.title}</span>
              <ExternalLink size={12} aria-hidden className="shrink-0" />
            </a>
          ) : (
            <span className="font-semibold">{it.title}</span>
          )}
          <LifecycleChip hint={it.lifecycle_hint} />
          <span className="text-ui-xs text-muted-foreground">
            {sourceLabel(it.source_id)}
            {it.published_at && ` · ${fmtDate(it.published_at)}`}
          </span>
        </li>
      ))}
    </ul>
    {items.length > SOURCE_PREVIEW && (
      <button type="button" aria-expanded={all} onClick={() => setAll((a) => !a)} className="mt-1.5 text-ui-xs font-semibold text-primary hover:underline">
        {all ? "Show fewer" : `Show ${items.length - SOURCE_PREVIEW} more release notes`}
      </button>
    )}
    </>
  );
}

function Decision({ c }: { c: UpdateCandidate }) {
  if (!c.decided_by && !c.delay_until && !c.applied_at) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-ui-xs text-muted-foreground">
      {c.decided_by && (
        <span className="inline-flex items-center gap-1.5">
          <UserRound size={12} aria-hidden />
          Decided by <span className="font-semibold text-foreground">{c.decided_by}</span>
          {c.decided_at && <span title={fmtDateTime(c.decided_at)}>{fmtRelative(c.decided_at)}</span>}
        </span>
      )}
      {c.status === "delayed" && c.delay_until && (
        <span className="inline-flex items-center gap-1.5 font-semibold text-warning">
          <CalendarClock size={12} aria-hidden />
          Resurfaces {fmtRelative(c.delay_until)} ({fmtDate(c.delay_until)})
        </span>
      )}
      {c.applied_at && <span title={fmtDateTime(c.applied_at)}>{c.kind === "advisory" ? "Acknowledged" : "Applied"} {fmtRelative(c.applied_at)}</span>}
      {c.decision_note && <span className="basis-full text-ui-sm text-foreground">“{c.decision_note}”</span>}
    </div>
  );
}

const ACTION_LABEL: Record<DecisionKind | "check", string> = { accept: "Accept…", delay: "Delay…", reject: "Reject…", acknowledge: "Acknowledge…", check: "Re-run regression" };

export default function CandidateCard({ candidate: c, canDecide, policy, defaultDelayDays, sourceLabel, runs, onReplace, onRun, onStale, compact = false, highlighted = false }: CandidateCardProps) {
  const [dialog, setDialog] = useState<DecisionKind | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const { run, pending } = useWrite();
  const actions = canDecide ? actionsFor(c) : [];
  const kind = KIND[c.kind];
  const KindIcon = kind?.icon ?? FlaskConical;

  const recheck = async () => {
    const res = await run("check", "Couldn't start the regression", () => api.post<JobRun>(`/api/platform-watch/candidates/${c.candidate_id}/check`), (r) => (r.mode === "job" ? "Regression started on a fresh Lakebase branch" : null));
    if (res) onRun(c.candidate_id, "check", res);
    onStale();
  };

  const done = (next: UpdateCandidate) => {
    if (next.apply_run) onRun(next.candidate_id, "apply", next.apply_run);
    onReplace(next);
  };

  const heavy = c.migrations.length > 0 || !!c.regression || !!c.apply_detail;

  return (
    <motion.li variants={staggerItem} layout="position" id={`candidate-${c.candidate_id}`} className="scroll-mt-24">
      <Card
        role="article"
        aria-label={`${kind?.label ?? c.kind}: ${c.title}`}
        className={cx("flex flex-col gap-4", c.breaking && ["passed", "failed", "detected", "delayed"].includes(c.status) && "border-destructive/35", highlighted && "ring-2 ring-info/70 ring-offset-2 ring-offset-background")}
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl", kind?.tile ?? "bg-muted text-muted-foreground")}>
            <KindIcon size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <KindBadge kind={c.kind} />
              <CandidateStatusBadge status={c.status} kind={c.kind} />
              {c.breaking && <BreakingBadge reasons={c.breaking_reasons} />}
              <span className="ml-auto text-ui-xs text-muted-foreground" title={fmtDateTime(c.created_at)}>
                #{c.candidate_id} · detected {fmtRelative(c.created_at)}
              </span>
            </div>
            <h3 className="text-ui-lg font-bold leading-snug tracking-tight">{c.title}</h3>
            {c.summary && <p className="max-w-4xl text-ui-sm text-muted-foreground">{c.summary}</p>}
            <Versions from={c.from_version} to={c.to_version} />
          </div>
        </div>

        {c.breaking && c.breaking_reasons.length > 0 && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-ui-sm font-bold text-destructive">
              <ShieldAlert size={14} aria-hidden /> Breaking changes
            </div>
            <ul aria-label="Breaking reasons" className="list-disc space-y-0.5 pl-5 font-mono text-ui-xs">
              {c.breaking_reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}

        {c.feed_items.length > 0 && (
          <div>
            <div className="mb-1.5 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">From the release feed ({c.feed_items.length})</div>
            <SourceItems items={c.feed_items} sourceLabel={sourceLabel} />
          </div>
        )}

        {compact && heavy && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex w-fit items-center gap-1 rounded-md text-ui-sm font-semibold text-primary hover:underline"
          >
            {expanded ? "Hide details" : "Show migrations and reports"}
            <ChevronDown size={14} aria-hidden className={cx("transition-transform", expanded && "rotate-180")} />
          </button>
        )}

        {expanded && (
          <div className={cx("grid gap-4", (c.migrations.length > 0 || c.apply_detail) && "xl:grid-cols-2")}>
            {(c.migrations.length > 0 || c.apply_detail) && (
              <div className="min-w-0 space-y-4">
                {c.migrations.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-ui-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Pending migrations ({c.migrations.length}) · {plural(c.migrations.reduce((n, m) => n + m.statements, 0), "statement")}
                    </div>
                    <MigrationsTable migrations={c.migrations} />
                  </div>
                )}
                {c.apply_detail && <ApplyReport detail={c.apply_detail} />}
              </div>
            )}
            <div className="min-w-0">
              <RegressionReport candidate={c} policy={policy} />
            </div>
          </div>
        )}

        <Decision c={c} />

        {runs?.apply && <JobRunNotice run={runs.apply} what="Apply job" onDismiss={() => onRun(c.candidate_id, "apply", null)} />}
        {runs?.check && <JobRunNotice run={runs.check} what="Regression run" onDismiss={() => onRun(c.candidate_id, "check", null)} />}

        {c.status === "delayed" && c.kind !== "advisory" && canDecide && (
          <p className="text-ui-xs text-muted-foreground">To accept a delayed update, re-run its regression first: it is tested again on a fresh branch of today's data.</p>
        )}

        {actions.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {actions.includes("check") && (
              <Button variant="ghost" size="sm" icon={<RotateCcw size={13} aria-hidden />} loading={pending === "check"} onClick={() => void recheck()} className="mr-auto">
                {ACTION_LABEL.check}
              </Button>
            )}
            {actions.includes("reject") && (
              <Button variant="secondary" size="sm" icon={<CircleX size={13} aria-hidden />} onClick={() => setDialog("reject")}>{ACTION_LABEL.reject}</Button>
            )}
            {actions.includes("delay") && (
              <Button variant="secondary" size="sm" icon={<CalendarClock size={13} aria-hidden />} onClick={() => setDialog("delay")}>
                {c.status === "delayed" ? "Change delay…" : ACTION_LABEL.delay}
              </Button>
            )}
            {actions.includes("acknowledge") && (
              <Button size="sm" icon={<CheckCheck size={13} aria-hidden />} onClick={() => setDialog("acknowledge")}>{ACTION_LABEL.acknowledge}</Button>
            )}
            {actions.includes("accept") && (
              <Button size="sm" variant={c.breaking ? "danger" : "primary"} icon={<Check size={13} aria-hidden />} onClick={() => setDialog("accept")}>{ACTION_LABEL.accept}</Button>
            )}
          </div>
        )}
      </Card>
      {dialog === "accept" && <AcceptDialog candidate={c} open onClose={() => setDialog(null)} onDone={done} onFailed={onStale} />}
      {dialog === "delay" && <DelayDialog candidate={c} open defaultDelayDays={defaultDelayDays} onClose={() => setDialog(null)} onDone={done} onFailed={onStale} />}
      {dialog === "reject" && <RejectDialog candidate={c} open onClose={() => setDialog(null)} onDone={done} onFailed={onStale} />}
      {dialog === "acknowledge" && <AcknowledgeDialog candidate={c} open onClose={() => setDialog(null)} onDone={done} onFailed={onStale} />}
    </motion.li>
  );
}
