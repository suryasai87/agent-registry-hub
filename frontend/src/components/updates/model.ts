// Platform updates: the pure rules behind the page (grouping, KPIs, which decisions a candidate allows, the
// decision payloads, settings with their server defaults, and the admin banner's wording). No React here, so
// the rules are unit-tested on their own.
import type { CandidateStatus, JobRun, UpdateCandidate, WatchOverview } from "../../lib/types";

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------------------------------------ grouping
export type GroupId = "ready" | "attention" | "inflight" | "delayed" | "history";

export interface CandidateGroup {
  id: GroupId;
  title: string;
  subtitle: string;
  statuses: CandidateStatus[];
}

export const GROUPS: CandidateGroup[] = [
  { id: "ready", title: "Ready to review", subtitle: "The regression passed on a throwaway Lakebase branch. Accept, delay or reject.", statuses: ["passed"] },
  { id: "attention", title: "Needs attention", subtitle: "The regression or the apply failed. Read the failing step, then re-run it or reject the update.", statuses: ["failed", "apply_failed"] },
  { id: "inflight", title: "Testing & detected", subtitle: "Waiting for a regression run, being tested on a branch, or being applied after your decision.", statuses: ["detected", "testing", "accepted", "applying"] },
  { id: "delayed", title: "Delayed", subtitle: "Snoozed until a date. They come back automatically, and are re-tested before you can accept them.", statuses: ["delayed"] },
  { id: "history", title: "History", subtitle: "Applied, acknowledged and rejected updates.", statuses: ["applied", "rejected"] },
];

const GROUP_OF = new Map<CandidateStatus, GroupId>(GROUPS.flatMap((g) => g.statuses.map((s) => [s, g.id] as const)));

export function groupOf(status: CandidateStatus): GroupId {
  return GROUP_OF.get(status) ?? "inflight";
}

const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() || 0 : 0);

/** Candidates bucketed by group in display order. Breaking ones lead "Ready"; delays sort by due date. */
export function groupCandidates(rows: UpdateCandidate[]): { group: CandidateGroup; items: UpdateCandidate[] }[] {
  return GROUPS.map((group) => {
    const items = rows.filter((c) => groupOf(c.status) === group.id);
    items.sort((a, b) => {
      if (group.id === "delayed") return time(a.delay_until) - time(b.delay_until);
      if (group.id === "history") return time(b.applied_at ?? b.decided_at ?? b.updated_at) - time(a.applied_at ?? a.decided_at ?? a.updated_at);
      if (group.id === "ready" && a.breaking !== b.breaking) return a.breaking ? -1 : 1;
      return time(b.updated_at) - time(a.updated_at);
    });
    return { group, items };
  });
}

/** Statuses whose server state is still moving (a branch regression or an apply job is running). */
export const MOVING: ReadonlySet<CandidateStatus> = new Set(["testing", "accepted", "applying"]);

// ------------------------------------------------------------------------------------------------ settings
export type AutoUpgrade = "never" | "non_breaking" | "all";

export interface WatchSettings {
  auto_upgrade: AutoUpgrade;
  relevance_threshold: number;
  default_delay_days: number;
  keep_failed_branch_hours: number;
}

export type SettingKey = keyof WatchSettings;

/** The defaults the backend falls back to when a key was never written (migration 005 seeds the same values). */
export const SETTING_DEFAULTS: WatchSettings = { auto_upgrade: "non_breaking", relevance_threshold: 35, default_delay_days: 7, keep_failed_branch_hours: 72 };

const POLICIES: readonly AutoUpgrade[] = ["never", "non_breaking", "all"];

function int(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/** WatchOverview.settings (JSON values keyed by name) with defaults filled in and types checked. */
export function readSettings(raw: Record<string, unknown> | null | undefined): WatchSettings {
  const s = raw ?? {};
  const policy = typeof s.auto_upgrade === "string" && POLICIES.includes(s.auto_upgrade as AutoUpgrade) ? (s.auto_upgrade as AutoUpgrade) : SETTING_DEFAULTS.auto_upgrade;
  return {
    auto_upgrade: policy,
    relevance_threshold: int(s.relevance_threshold, SETTING_DEFAULTS.relevance_threshold),
    default_delay_days: int(s.default_delay_days, SETTING_DEFAULTS.default_delay_days),
    keep_failed_branch_hours: int(s.keep_failed_branch_hours, SETTING_DEFAULTS.keep_failed_branch_hours),
  };
}

export const POLICY_COPY: Record<AutoUpgrade, { label: string; short: string; detail: string }> = {
  never: {
    label: "Never",
    short: "Every update waits for an admin",
    detail: "Nothing is applied automatically. Every candidate is still regression-tested on a branch, then waits for an admin to accept it.",
  },
  non_breaking: {
    label: "Non-breaking only",
    short: "Passing, non-breaking updates apply themselves",
    detail: "A candidate whose branch regression passes and that has no breaking change is applied right away. Breaking ones wait for an admin.",
  },
  all: {
    label: "All",
    short: "Every passing update applies itself",
    detail: "Any app release or capability whose branch regression passes is applied right away, breaking ones included. Use it only where a quick upgrade matters more than a human check.",
  },
};

/** Range limits used by the settings form (the backend accepts 0–1000). */
export const NUMBER_SETTINGS: { key: Exclude<SettingKey, "auto_upgrade">; label: string; unit: string; min: number; max: number; hint: string }[] = [
  { key: "relevance_threshold", label: "Relevance threshold", unit: "of 100", min: 0, max: 100, hint: "Feed items scoring at least this much become advisories, and the release feed shows them by default." },
  { key: "default_delay_days", label: "Default delay", unit: "days", min: 1, max: 365, hint: "How far ahead the Delay dialog proposes to snooze an update." },
  { key: "keep_failed_branch_hours", label: "Keep a failed branch for", unit: "hours", min: 1, max: 720, hint: "A branch whose regression failed is kept this long for debugging, then expires. Passing branches are deleted at once." },
];

// ------------------------------------------------------------------------------------------------ KPIs
export interface WatchKpis {
  ready: number;
  attention: number;
  testing: number;
  detected: number;
  delayed: number;
  /** Applied (or acknowledged) in the last 30 days; null until the candidate list has loaded. */
  applied30d: number | null;
  policy: AutoUpgrade;
}

export function watchKpis(overview: WatchOverview, candidates: UpdateCandidate[] | null, now: number = Date.now()): WatchKpis {
  const n = (s: CandidateStatus) => overview.counts[s] ?? 0;
  return {
    ready: overview.ready,
    attention: overview.attention,
    testing: n("testing"),
    detected: n("detected"),
    delayed: n("delayed"),
    applied30d: candidates ? candidates.filter((c) => c.status === "applied" && c.applied_at && now - time(c.applied_at) <= 30 * DAY_MS).length : null,
    policy: readSettings(overview.settings).auto_upgrade,
  };
}

// ------------------------------------------------------------------------------------------------ actions
export type CandidateAction = "accept" | "delay" | "reject" | "acknowledge" | "check";

/**
 * What an admin may do with a candidate in its current state, in button order. Mirrors the backend rules: only a
 * passed app release or capability can be accepted (so a delayed one is re-tested first), advisories are
 * acknowledged, and nothing is decided while a branch regression or an apply is running.
 */
export function actionsFor(c: Pick<UpdateCandidate, "kind" | "status">): CandidateAction[] {
  if (MOVING.has(c.status) || c.status === "applied" || c.status === "rejected") return [];
  if (c.kind === "advisory") return ["acknowledge", "delay", "check"];
  switch (c.status) {
    case "passed":
      return ["accept", "delay", "reject", "check"];
    case "failed":
    case "apply_failed":
    case "detected":
    case "delayed":
      return ["check", "delay", "reject"];
    default:
      return [];
  }
}

// ------------------------------------------------------------------------------------------------ payloads
export interface DecisionBody {
  action: "accept" | "delay" | "reject" | "acknowledge";
  delay_until?: string;
  note?: string;
}

/** Why Accept is blocked right now (null when it may be sent). A breaking change needs a note. */
export function acceptProblem(c: Pick<UpdateCandidate, "breaking">, note: string): string | null {
  return c.breaking && !note.trim() ? "A breaking change needs a note: what you checked and who you told." : null;
}

export function acceptBody(c: Pick<UpdateCandidate, "breaking">, note: string): DecisionBody {
  const problem = acceptProblem(c, note);
  if (problem) throw new Error(problem);
  return note.trim() ? { action: "accept", note: note.trim() } : { action: "accept" };
}

export function rejectBody(reason: string): DecisionBody {
  if (!reason.trim()) throw new Error("A reason is required to reject an update.");
  return { action: "reject", note: reason.trim() };
}

export function acknowledgeBody(note: string): DecisionBody {
  return note.trim() ? { action: "acknowledge", note: note.trim() } : { action: "acknowledge" };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local calendar day ("yyyy-mm-dd") ``days`` from ``now``: the value an <input type="date"> shows. */
export function localDay(days = 0, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The Delay dialog's default date: today + default_delay_days. */
export function defaultDelayDate(defaultDelayDays: number, now: Date = new Date()): string {
  return localDay(Math.max(1, defaultDelayDays), now);
}

/** Start of the chosen local day as an ISO-8601 UTC instant (what the backend stores as delay_until). */
export function dayStartIso(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

export function delayProblem(day: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Pick a date.";
  return day <= localDay(0, now) ? "Pick a date after today." : null;
}

export function delayBody(day: string, note: string, now: Date = new Date()): DecisionBody {
  const problem = delayProblem(day, now);
  if (problem) throw new Error(problem);
  const body: DecisionBody = { action: "delay", delay_until: dayStartIso(day) };
  if (note.trim()) body.note = note.trim();
  return body;
}

// ------------------------------------------------------------------------------------------------ job runs
/** "Run `python jobs/x.py`" → [{text:"Run "}, {code:"python jobs/x.py"}] so command fragments render as code. */
export function splitCode(note: string): { text: string; code: boolean }[] {
  return note
    .split(/(`[^`]*`?)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("`") ? { text: part.replace(/^`|`$/g, ""), code: true } : { text: part, code: false }));
}

export function jobRunSummary(run: JobRun): string {
  if (run.mode === "job") return run.run_id != null ? `Run ${run.run_id} of job ${run.job_id ?? "–"} started` : `Job ${run.job_id ?? "–"} triggered`;
  return "The updates job isn't configured";
}

// ------------------------------------------------------------------------------------------------ admin banner
export interface BannerCounts {
  ready: number;
  /** failed + apply_failed */
  attention: number;
  failed: number;
  applyFailed: number;
  /** Breaking candidates among the ready (passed) ones. */
  breaking: number;
}

export function bannerCounts(overview: WatchOverview, passed: UpdateCandidate[] | null): BannerCounts {
  return {
    ready: overview.ready,
    attention: overview.attention,
    failed: overview.counts.failed ?? 0,
    applyFailed: overview.counts.apply_failed ?? 0,
    breaking: (passed ?? []).filter((c) => c.breaking).length,
  };
}

export const bannerVisible = (c: BannerCounts | null): c is BannerCounts => !!c && (c.ready > 0 || c.attention > 0);

/** Dismissal is remembered against these numbers, so the banner returns when any of them changes. */
export function bannerSignature(c: BannerCounts): string {
  return `${c.ready}|${c.attention}|${c.breaking}`;
}

const updates = (n: number) => `${n} platform ${n === 1 ? "update" : "updates"}`;

/** "2 platform updates are ready for your decision (1 breaking) · 1 failed regression". */
export function bannerText(c: BannerCounts): string {
  const failures = [c.failed > 0 ? `${c.failed} failed regression` : null, c.applyFailed > 0 ? `${c.applyFailed} failed to apply` : null].filter((x): x is string => !!x);
  if (c.ready > 0) {
    const ready = `${updates(c.ready)} ${c.ready === 1 ? "is" : "are"} ready for your decision${c.breaking > 0 ? ` (${c.breaking} breaking)` : ""}`;
    return c.attention > 0 ? [ready, ...(failures.length ? failures : [`${c.attention} need attention`])].join(" · ") : ready;
  }
  if (c.attention === c.failed) return `${updates(c.failed)} failed regression`;
  if (c.attention === c.applyFailed) return `${updates(c.applyFailed)} failed to apply`;
  return `${updates(c.attention)} need attention${failures.length ? ` (${failures.join(" · ")})` : ""}`;
}
