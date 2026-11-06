// The answer of a POST that starts the updates job (run Platform Watch, re-run a regression, apply an accepted
// update): a link to the job run, or the "not configured" note with the command to run instead.
import { motion } from "framer-motion";
import { CircleCheck, ExternalLink, Info, X } from "lucide-react";
import { cx } from "../../lib/cx";
import type { JobRun } from "../../lib/types";
import { jobRunSummary, splitCode } from "./model";

export default function JobRunNotice({ run, what, onDismiss, className }: { run: JobRun; what: string; onDismiss?: () => void; className?: string }) {
  const started = run.mode === "job";
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      role="status"
      className={cx("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-ui-sm", started ? "border-success/40 bg-success/10" : "border-warning/45 bg-warning/10", className)}
    >
      {started ? <CircleCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" /> : <Info size={15} aria-hidden className="mt-0.5 shrink-0 text-warning" />}
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{what}: </span>
        <span>{jobRunSummary(run)}.</span>
        {started && run.url && (
          <a href={run.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
            Open the job run <ExternalLink size={12} aria-hidden />
          </a>
        )}
        {started && <span className="text-muted-foreground"> Results appear here when the run finishes.</span>}
        {run.note && (
          <p className="mt-0.5 break-words text-muted-foreground">
            {splitCode(run.note).map((part, i) =>
              part.code ? (
                <code key={i} className="rounded bg-background/70 px-1 py-px font-mono text-ui-xs text-foreground">{part.text}</code>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </p>
        )}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label={`Dismiss: ${what}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X size={14} aria-hidden />
        </button>
      )}
    </motion.div>
  );
}
