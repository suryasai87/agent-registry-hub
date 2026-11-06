// Typed fixtures for the platform-updates tests (contract shapes from docs/API_CONTRACT.md "platform watch").
import type { Capability, FeedItem, FeedSource, Me, RegressionStep, UpdateCandidate, WatchOverview } from "../../lib/types";

export const ADMIN: Me = {
  email: "jane.doe@example.com", display_name: "Jane Doe", roles: ["viewer", "admin"], primary_role: "admin", view_as: null,
  is_admin: true, is_steward: true, is_auditor: false,
  counts: { owned: 0, subscriptions: 0, pending_approvals: 0, my_open_requests: 0, unread_notifications: 0, unacked_impacts: 0 },
};

export const AUDITOR: Me = { ...ADMIN, email: "ari.audit@example.com", display_name: "Ari Audit", roles: ["viewer", "auditor"], primary_role: "auditor", is_admin: false, is_steward: false, is_auditor: true };

export const STEPS_PASSED: RegressionStep[] = [
  { name: "Create Lakebase branch", status: "passed", detail: "upd-1-10261046 (TTL 72 h)", duration_ms: 148 },
  { name: "Snapshot row counts", status: "passed", detail: "1161 rows in 35 tables", duration_ms: 59 },
  { name: "Apply pending migrations on the branch", status: "passed", detail: { schema: "br_upd_1", applied: ["006_agent_services"], pending: [] }, duration_ms: 11 },
  { name: "Data preservation", status: "passed", detail: "36 tables; no rows lost", duration_ms: 36 },
  { name: "Read-path smoke checks (live data copy)", status: "passed", detail: { home: { ms: 10 }, catalog: { ms: 8, total: 11 } }, duration_ms: 54 },
  { name: "Delete branch", status: "passed", detail: "deleted", duration_ms: 17 },
];

export const STEPS_FAILED: RegressionStep[] = [
  { name: "Create Lakebase branch", status: "passed", detail: "upd-2-10261050 (TTL 72 h)", duration_ms: 160 },
  { name: "Snapshot row counts", status: "passed", detail: "1161 rows in 35 tables", duration_ms: 61 },
  { name: "Apply pending migrations on the branch", status: "passed", detail: { applied: ["007_drop_legacy"] }, duration_ms: 20 },
  {
    name: "Data preservation", status: "failed", duration_ms: 31,
    detail: "RuntimeError: rows lost: {'legacy_tool': (14, 0)} — migration 007_drop_legacy drops a table that still holds rows and does not declare allow-data-loss",
  },
  { name: "Keep branch for debugging", status: "passed", detail: "local:br_upd_2 (expires after 72 h)", duration_ms: 0 },
];

let seq = 100;

export function candidate(extra: Partial<UpdateCandidate> = {}): UpdateCandidate {
  seq += 1;
  return {
    candidate_id: seq, kind: "app_release", title: `Agent Registry Hub 0.${seq}.0 is staged`, summary: "Running 0.2.0 → staged; 1 pending migration(s).",
    from_version: "0.2.0", to_version: `0.${seq}.0`, capability_key: null, feed_item_ids: [], feed_items: [],
    migrations: [{ version: "006_agent_services", breaking: false, reasons: [], allow_data_loss: false, statements: 2 }],
    breaking: false, breaking_reasons: [], status: "passed", branch_name: `local:br_upd_${seq}`,
    regression: { started_at: "2026-10-26T10:46:04Z", finished_at: "2026-10-26T10:46:16Z", branch: `local:br_upd_${seq}`, passed: true, steps: STEPS_PASSED },
    auto_apply: false, delay_until: null, decided_by: null, decided_at: null, decision_note: null, applied_at: null, apply_detail: null,
    created_at: "2026-10-26T10:46:00Z", updated_at: "2026-10-26T10:46:16Z",
    ...extra,
  };
}

export const SOURCES: FeedSource[] = [
  { source_id: "databricks_release_notes", label: "Databricks release notes (AWS)", url: "https://docs.databricks.com/aws/en/feed.xml", kind: "rss", publisher: "Databricks", enabled: true, last_fetched_at: "2026-10-26T10:42:39Z", last_status: "ok: 1410 items, 200 new", items_total: 200 },
  { source_id: "mlflow_releases", label: "MLflow releases (OSS)", url: "https://github.com/mlflow/mlflow/releases.atom", kind: "atom", publisher: "MLflow", enabled: true, last_fetched_at: "2026-10-26T10:42:39Z", last_status: "error: URLError: timed out", items_total: 10 },
];

export function overview(extra: Partial<WatchOverview> = {}): WatchOverview {
  return {
    counts: { passed: 2, failed: 1, detected: 1 }, sources: SOURCES,
    settings: { relevance_threshold: 35, default_delay_days: 7, keep_failed_branch_hours: 72, auto_upgrade: "non_breaking", running_version: "0.2.0" },
    ready: 2, attention: 1, job_configured: false,
    ...extra,
  };
}

export function capability(extra: Partial<Capability> = {}): Capability {
  return {
    capability_key: "uc_skills", label: "UC skills API", area: "skills", description: "Skills as UC securables (SKILL.md bundles).",
    docs_url: "https://docs.databricks.com/aws/en/ai-gateway/skills", keywords: ["skill"], probe_kind: "rest", probe_method: "GET",
    probe_path: "/api/2.1/unity-catalog/skills?parent=schemas/system.ai&page_size=1", adapter: "skills", adapter_enabled: true,
    status: "available", http_status: 200, probe_detail: null, last_probed_at: "2026-10-26T10:42:40Z", first_available_at: "2026-10-20T08:00:00Z",
    ...extra,
  };
}

export function feedItem(extra: Partial<FeedItem> = {}): FeedItem {
  return {
    item_id: 82, source_id: "databricks_release_notes", title: "Knowledge Assistant and Supervisor Agent are now legacy",
    link: "https://docs.databricks.com/aws/en/release-notes/product/2026/october#legacy", published_at: "2026-10-12T00:00:00Z",
    summary: "The v2.0 endpoints are deprecated in favour of v2.1.", relevance: 78, matched_capabilities: ["supervisor_agents_v21"],
    matched_terms: ["supervisor agent", "agent bricks"], lifecycle_hint: "deprecation", breaking_hint: true, status: "new", candidate_id: 27,
    ...extra,
  };
}
