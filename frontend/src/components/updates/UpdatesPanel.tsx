// Updates tab: one card per candidate, grouped Ready to review / Needs attention / Testing & detected / Delayed /
// History. While a regression or an apply job runs, the list refreshes itself (bounded) so the server's result
// replaces the pending state.
import { motion } from "framer-motion";
import { CalendarClock, CircleCheck, History, LoaderCircle, RefreshCcwDot, TriangleAlert, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { UseApi } from "../../lib/api";
import { cx } from "../../lib/cx";
import { stagger } from "../../lib/motion";
import type { FeedSource, JobRun, UpdateCandidate } from "../../lib/types";
import { Badge, Button, EmptyState } from "../ui";
import { AsyncBlock, CardsSkeleton } from "../workspace/feedback";
import CandidateCard, { type CandidateRuns } from "./CandidateCard";
import { groupCandidates, MOVING, type GroupId, type WatchSettings } from "./model";
import { usePoll } from "./usePoll";

const GROUP_ICON: Record<GroupId, { icon: LucideIcon; tone: string; spin?: boolean }> = {
  ready: { icon: CircleCheck, tone: "bg-success/15 text-success" },
  attention: { icon: TriangleAlert, tone: "bg-destructive/15 text-destructive" },
  inflight: { icon: LoaderCircle, tone: "bg-info/15 text-info" },
  delayed: { icon: CalendarClock, tone: "bg-warning/15 text-warning" },
  history: { icon: History, tone: "bg-muted text-muted-foreground" },
};

export interface UpdatesPanelProps {
  state: UseApi<UpdateCandidate[]>;
  settings: WatchSettings;
  sources: FeedSource[];
  canDecide: boolean;
  /** A decision or a run changed server state: refresh the KPIs. */
  onChanged: () => void;
  /** ?candidate=ID: scroll to it and highlight it. */
  focusId: number | null;
}

export default function UpdatesPanel({ state, settings, sources, canDecide, onChanged, focusId }: UpdatesPanelProps) {
  const [runs, setRuns] = useState<Record<number, CandidateRuns>>({});
  const [runSeq, setRunSeq] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const rows = state.data;
  const groups = useMemo(() => groupCandidates(rows ?? []), [rows]);
  const labels = useMemo(() => new Map(sources.map((s) => [s.source_id, s.label])), [sources]);
  const sourceLabel = useCallback((id: string) => labels.get(id) ?? id, [labels]);

  const moving = rows?.some((c) => MOVING.has(c.status)) ?? false;
  const started = runSeq > 0;
  const reload = state.reload;
  const tick = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);
  // 5 s while something is moving (up to 4 min), and for 2 min after a job run was started from here.
  usePoll(moving || started, tick, 5000, moving ? 48 : 24, runSeq);

  const focusInHistory = !!focusId && groups.find((g) => g.group.id === "history")?.items.some((c) => c.candidate_id === focusId);
  useEffect(() => {
    if (focusInHistory) setHistoryOpen(true);
  }, [focusInHistory]);
  useEffect(() => {
    if (!focusId || !rows) return;
    const el = document.getElementById(`candidate-${focusId}`);
    // Scroll only the shell's <main> (scrollIntoView would also shift the document and hide the navbar).
    const main = el?.closest("main");
    if (el && main && typeof main.scrollTo === "function") {
      main.scrollTo({ top: main.scrollTop + el.getBoundingClientRect().top - main.getBoundingClientRect().top - 16, behavior: "smooth" });
    }
  }, [focusId, rows, historyOpen]);

  const replace = (next: UpdateCandidate) => {
    state.mutate((prev) => (prev ?? []).map((c) => (c.candidate_id === next.candidate_id ? next : c)));
    onChanged();
  };

  const onRun = (id: number, kind: keyof CandidateRuns, run: JobRun | null) => {
    setRuns((all) => ({ ...all, [id]: { ...all[id], [kind]: run ?? undefined } }));
    if (run?.mode === "job") setRunSeq((n) => n + 1);
  };

  const stale = () => {
    reload();
    onChanged();
  };

  return (
    <AsyncBlock
      state={state}
      errorTitle="Couldn't load the update candidates"
      skeleton={<CardsSkeleton count={3} className="!grid-cols-1" />}
      isEmpty={(d) => d.length === 0}
      empty={
        <EmptyState
          icon={<RefreshCcwDot size={22} aria-hidden />}
          title="No platform updates yet"
          description="Platform Watch reads the release feeds and probes the APIs this registry uses. When a newer app version is staged, an API becomes available, or a relevant announcement appears, it shows up here after its branch regression."
        />
      }
    >
      {() => {
        const open = groups.filter((g) => g.group.id !== "history" && g.items.length > 0);
        const history = groups.find((g) => g.group.id === "history");
        return (
          <div className="space-y-8">
            {open.length === 0 && (
              <EmptyState icon={<CircleCheck size={22} aria-hidden />} title="Nothing waiting for a decision" description="Every detected update has been decided. New candidates appear here once their branch regression has run." />
            )}
            {open.map(({ group, items }) => {
              const gi = GROUP_ICON[group.id];
              const Icon = gi.icon;
              return (
                <section key={group.id} aria-labelledby={`group-${group.id}`}>
                  <div className="mb-3 flex items-start gap-3">
                    <span className={cx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", gi.tone)}>
                      <Icon size={16} aria-hidden className={group.id === "inflight" && moving ? "animate-spin" : undefined} />
                    </span>
                    <div className="min-w-0">
                      <h2 id={`group-${group.id}`} className="flex items-center gap-2 text-ui-lg font-bold tracking-tight">
                        {group.title} <Badge>{items.length}</Badge>
                      </h2>
                      <p className="text-ui-sm text-muted-foreground">{group.subtitle}</p>
                    </div>
                  </div>
                  <motion.ul variants={stagger} initial="hidden" animate="show" className="space-y-4" aria-label={group.title}>
                    {items.map((c) => (
                      <CandidateCard
                        key={c.candidate_id}
                        candidate={c}
                        canDecide={canDecide}
                        policy={settings.auto_upgrade}
                        defaultDelayDays={settings.default_delay_days}
                        sourceLabel={sourceLabel}
                        runs={runs[c.candidate_id]}
                        onReplace={replace}
                        onRun={onRun}
                        onStale={stale}
                        highlighted={focusId === c.candidate_id}
                      />
                    ))}
                  </motion.ul>
                </section>
              );
            })}
            {history && history.items.length > 0 && (
              <section aria-labelledby="group-history">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-lg", GROUP_ICON.history.tone)}>
                    <History size={16} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 id="group-history" className="flex items-center gap-2 text-ui-lg font-bold tracking-tight">
                      History <Badge>{history.items.length}</Badge>
                    </h2>
                    <p className="text-ui-sm text-muted-foreground">{history.group.subtitle}</p>
                  </div>
                  <Button variant="secondary" size="sm" aria-expanded={historyOpen} aria-controls="history-list" onClick={() => setHistoryOpen((o) => !o)}>
                    {historyOpen ? "Hide history" : `Show history (${history.items.length})`}
                  </Button>
                </div>
                {historyOpen && (
                  <motion.ul id="history-list" variants={stagger} initial="hidden" animate="show" className="space-y-4" aria-label="History">
                    {history.items.map((c) => (
                      <CandidateCard
                        key={c.candidate_id}
                        candidate={c}
                        canDecide={canDecide}
                        policy={settings.auto_upgrade}
                        defaultDelayDays={settings.default_delay_days}
                        sourceLabel={sourceLabel}
                        runs={runs[c.candidate_id]}
                        onReplace={replace}
                        onRun={onRun}
                        onStale={stale}
                        compact
                        highlighted={focusId === c.candidate_id}
                      />
                    ))}
                  </motion.ul>
                )}
              </section>
            )}
          </div>
        );
      }}
    </AsyncBlock>
  );
}
