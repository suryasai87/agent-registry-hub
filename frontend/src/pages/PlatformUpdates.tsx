// Platform updates (/platform-updates): what changed on the platform (release feeds, newly available APIs, a
// staged app release), each candidate regression-tested on a throwaway Lakebase branch, and the admin decision
// (accept / delay / reject / acknowledge). Admins act; stewards and auditors read. Tabs live in the URL hash
// (#updates, #feed, #capabilities, #settings); ?candidate=ID focuses one candidate.
import { motion } from "framer-motion";
import { CalendarClock, CircleCheck, Eye, FlaskConical, Play, RefreshCcwDot, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SourcePill from "../components/SourcePill";
import { Badge, Button, EmptyState, KpiTile, PageHeader, Tabs, Tooltip } from "../components/ui";
import CapabilitiesPanel from "../components/updates/CapabilitiesPanel";
import FeedPanel from "../components/updates/FeedPanel";
import JobRunNotice from "../components/updates/JobRunNotice";
import { POLICY_COPY, readSettings, watchKpis, type SettingKey } from "../components/updates/model";
import SettingsPanel from "../components/updates/SettingsPanel";
import UpdatesPanel from "../components/updates/UpdatesPanel";
import { usePoll } from "../components/updates/usePoll";
import { ErrorCard, KpiSkeleton, useWrite } from "../components/workspace/feedback";
import { api, useApi } from "../lib/api";
import { stagger, staggerItem } from "../lib/motion";
import { useSession } from "../lib/session";
import type { JobRun, UpdateCandidate, WatchOverview } from "../lib/types";

const TAB_IDS = ["updates", "feed", "capabilities", "settings"] as const;
type TabId = (typeof TAB_IDS)[number];

function Kpis({ overview, candidates }: { overview: WatchOverview; candidates: UpdateCandidate[] | null }) {
  const k = watchKpis(overview, candidates);
  const tiles = [
    { label: "Ready to review", value: k.ready, icon: <CircleCheck size={16} aria-hidden />, hint: "Regression passed" },
    { label: "Needs attention", value: k.attention, icon: <TriangleAlert size={16} aria-hidden />, hint: "Failed regression or apply" },
    { label: "Testing", value: k.testing, icon: <FlaskConical size={16} aria-hidden />, hint: k.detected ? `+${k.detected} detected, not yet tested` : "On a Lakebase branch" },
    { label: "Delayed", value: k.delayed, icon: <CalendarClock size={16} aria-hidden />, hint: "Resurface automatically" },
    { label: "Applied (30 d)", value: k.applied30d ?? "–", icon: <ShieldCheck size={16} aria-hidden />, hint: "Incl. acknowledged advisories", loading: k.applied30d === null },
    { label: "Auto-upgrade", value: <span className="text-ui-xl">{POLICY_COPY[k.policy].label}</span>, icon: <Zap size={16} aria-hidden />, hint: POLICY_COPY[k.policy].short },
  ];
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Platform update counts">
      {tiles.map((t) => (
        <motion.div key={t.label} variants={staggerItem}>
          <KpiTile label={t.label} value={t.value} icon={t.icon} hint={t.hint} loading={t.loading} className="h-full" />
        </motion.div>
      ))}
    </motion.div>
  );
}

export default function PlatformUpdatesPage() {
  const { hasRole, me, loading } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const admin = hasRole("admin");
  const steward = hasRole("steward", "admin");
  const auditor = hasRole("auditor");
  const allowed = loading || !me || steward || auditor;

  const overview = useApi<WatchOverview>(allowed ? "/api/platform-watch" : null);
  const candidates = useApi<UpdateCandidate[]>(allowed ? "/api/platform-watch/candidates" : null);
  const settings = useMemo(() => readSettings(overview.data?.settings), [overview.data]);
  const sources = overview.data?.sources ?? [];

  const fromHash = location.hash.slice(1);
  const tab: TabId = (TAB_IDS as readonly string[]).includes(fromHash) ? (fromHash as TabId) : "updates";
  const focusRaw = new URLSearchParams(location.search).get("candidate");
  const focusId = focusRaw && /^\d+$/.test(focusRaw) ? Number(focusRaw) : null;

  const { run, pending } = useWrite();
  const [watchRun, setWatchRun] = useState<JobRun | null>(null);
  const [watchSeq, setWatchSeq] = useState(0);
  const reloadOverview = overview.reload;
  const reloadCandidates = candidates.reload;
  const refreshAll = useCallback(() => {
    reloadOverview();
    reloadCandidates();
  }, [reloadOverview, reloadCandidates]);
  // After "Run Platform Watch now" started a job, refresh every 10 s for 3 min so new candidates appear.
  usePoll(watchSeq > 0 && watchRun?.mode === "job", refreshAll, 10_000, 18, watchSeq);

  const runWatch = async () => {
    const res = await run("watch", "Couldn't start Platform Watch", () => api.post<JobRun>("/api/platform-watch/run"), (r) => (r.mode === "job" ? "Platform Watch started" : null));
    if (res) {
      setWatchRun(res);
      setWatchSeq((n) => n + 1);
      refreshAll();
    }
  };

  const onSaved = (key: SettingKey, value: unknown) => {
    // The settings tab only renders once the overview is loaded, so ``prev`` is there: commit the server's value.
    overview.mutate((prev) => ({ ...(prev as WatchOverview), settings: { ...(prev?.settings ?? {}), [key]: value } }));
  };

  if (!loading && me && !steward && !auditor) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<RefreshCcwDot size={20} aria-hidden />} title="Platform updates" />
        <EmptyState title="Platform updates are for admins, stewards and auditors" description="Ask a registry admin if you need to review platform release notes or upgrades." />
      </div>
    );
  }

  const decideBadge = overview.data && overview.data.ready + overview.data.attention > 0 ? <Badge variant="primary">{overview.data.ready + overview.data.attention}</Badge> : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<RefreshCcwDot size={20} aria-hidden />}
        title="Platform updates"
        source={<SourcePill source={overview.source} degradedReason={overview.degradedReason} asOf={overview.asOf} />}
        subtitle="Release notes, newly available APIs and staged app releases, each regression-tested on a throwaway Lakebase branch of production before an admin decides."
        actions={
          admin ? (
            <>
              {overview.data && !overview.data.job_configured && (
                <Tooltip content="WATCH_JOB_ID isn't set, so runs return the command to run instead of starting a job.">
                  <span tabIndex={0} className="inline-flex rounded-full">
                    <Badge variant="warning">Updates job not configured</Badge>
                  </span>
                </Tooltip>
              )}
              <Button icon={<Play size={14} aria-hidden />} loading={pending === "watch"} onClick={() => void runWatch()}>
                Run Platform Watch now
              </Button>
            </>
          ) : (
            <Badge variant="info" icon={<Eye size={12} aria-hidden />}>Read-only{auditor && !steward ? " (auditor)" : " (admins decide)"}</Badge>
          )
        }
      />

      {watchRun && <JobRunNotice run={watchRun} what="Platform Watch" onDismiss={() => setWatchRun(null)} />}

      {overview.data ? (
        <Kpis overview={overview.data} candidates={candidates.data} />
      ) : overview.error ? (
        <ErrorCard error={overview.error} onRetry={overview.reload} title="Couldn't load Platform Watch" />
      ) : (
        <KpiSkeleton />
      )}

      <Tabs
        syncHash={false}
        value={tab}
        onChange={(id) => navigate({ search: "", hash: id }, { replace: true })}
        tabs={[
          { id: "updates", label: "Updates", badge: decideBadge },
          { id: "feed", label: "Release feed" },
          { id: "capabilities", label: "Capabilities" },
          { id: "settings", label: "Settings" },
        ]}
      >
        {(active) =>
          active === "feed" ? (
            overview.data || overview.error ? (
              <FeedPanel defaultThreshold={settings.relevance_threshold} sources={sources} canDismiss={steward} />
            ) : (
              <KpiSkeleton count={3} />
            )
          ) : active === "capabilities" ? (
            <CapabilitiesPanel />
          ) : active === "settings" ? (
            overview.data ? (
              <SettingsPanel settings={settings} canEdit={admin} onSaved={onSaved} />
            ) : overview.error ? (
              <ErrorCard error={overview.error} onRetry={overview.reload} title="Couldn't load the settings" />
            ) : (
              <KpiSkeleton count={3} />
            )
          ) : (
            <UpdatesPanel state={candidates} settings={settings} sources={sources} canDecide={admin} onChanged={reloadOverview} focusId={focusId} />
          )
        }
      </Tabs>
    </div>
  );
}
