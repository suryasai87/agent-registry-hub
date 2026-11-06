// Generated from docs/API_CONTRACT.md: the single source of truth for API shapes.
// Regenerate (don't hand-edit) when the contract changes: `python3 scripts/gen_types.py`.
/* eslint-disable */
export type Source = "lakebase" | "warehouse" | "synthetic" | "live";
export interface Envelope<T> { data: T; source: Source; degraded_reason: string | null; as_of: string; }

export type AssetType = "agent" | "mcp_server" | "tool" | "skill";
export type Lifecycle = "discovered" | "draft" | "pending_approval" | "approved" | "rejected" | "deprecated" | "retired";
export type Runtime = "running" | "stopped" | "paused" | "blocked" | "degraded" | "unknown";
export type Certification = "certified" | "verified_publisher" | "unreviewed" | "deprecated";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type RiskTier = "low" | "medium" | "high" | "critical";
export type Role = "viewer" | "consumer" | "owner" | "steward" | "admin" | "auditor";
export type Provenance = "source" | "owner" | "admin";

export interface Me {
  email: string; display_name: string;
  roles: Role[]; primary_role: Role; view_as: Role | null;
  is_admin: boolean; is_steward: boolean; is_auditor: boolean;
  counts: { owned: number; subscriptions: number; pending_approvals: number; my_open_requests: number;
            unread_notifications: number; unacked_impacts: number };
}

export interface Owner { email: string; kind: "owner" | "co_owner" | "sponsor" | "steward"; source: "synced" | "assigned"; display_name: string; }

export interface Kpi30d {
  requests_30d: number; users_30d: number; cost_30d_usd: number; error_rate: number | null;
  spark: number[];            // 14 daily request counts, oldest → newest
}

export interface MyRelationship { has_access: boolean; requested: boolean; subscribed: boolean; owner: boolean; }

export interface AssetCard {
  asset_id: string; asset_type: AssetType; subtype: string; display_name: string; name: string;
  source: "databricks" | "external" | "custom"; platform: string; publisher: string | null;
  lifecycle_status: Lifecycle; runtime_status: Runtime; certification: Certification;
  sensitivity: Sensitivity; risk_tier: RiskTier; domain: string | null; tags: string[];
  purpose: string | null;     // the effective one-line purpose (≤140 chars)
  owners: Owner[];
  kpi: Kpi30d;
  policy_shield: "full" | "partial" | "none"; coverage_pct: number;
  subscribers: number; tools_count: number;
  my: MyRelationship;
  parent_asset_id: string | null; parent_display_name: string | null;
  last_changed_at: string | null; deep_link: string | null; origin: "sync" | "app" | "demo";
  published_version: string | null; latest_version: string | null;
  eval_score: number | null;    // mean of scorer results over the last 30 days (Databricks-built agents)
}
/** Rows of GET /api/assets/{id}/tools also carry descriptive attributes (schemas, MCP annotations, side effects). */
export type ToolRow = AssetCard & { attributes?: Record<string, unknown> };

export interface CatalogPage {
  items: AssetCard[]; total: number; page: number; page_size: number;
  facets: Record<"asset_type" | "source" | "platform" | "lifecycle_status" | "certification" | "sensitivity" | "risk_tier", Record<string, number>>;
}
// GET /api/catalog?type=&q=&source=&platform=&status=&certification=&sensitivity=&risk=&owner=(email|me)&tag=
//                 &rel=(access|requested|subscribed|owned)&changed_days=&ownerless=true&sort=(relevance|name|requests|cost|changed)&page=1&page_size=24

export interface FieldValue {
  field_key: string; label: string; kind: "text" | "longtext" | "list" | "enum" | "links" | "kv" | "registrations";
  value: unknown;                       // effective value
  source_value: unknown; source_label: string | null; source_synced_at: string | null;
  override_value: unknown; provenance: Provenance; lock_mode: "keep" | "follow";
  overridden_by: string | null; overridden_at: string | null; override_reason: string | null;
  drift: boolean; required: boolean;
}

export interface VersionRow { version: string; status: string; source: string; created_by: string | null; created_at: string; }

export interface AssetPermissions {
  can_edit: boolean; can_override: boolean; can_manage_access: boolean; can_publish: boolean;
  can_view_all_usage: boolean; can_view_traces: boolean; can_curate: boolean; can_pause: boolean;
  can_edit_tool_selection?: boolean;    // UC MCP services (mcp:service:*): owners and stewards
}

export interface AccessSettings {
  approval_required: boolean; approver_mode: "any" | "all"; approvers: string[];
  default_duration_days: number; max_duration_days: number; sla_hours: number;
  terms_text: string | null; managed_externally_url: string | null;
  privileges: string[];                 // privileges a requester may ask for on this asset type
  default_privilege: string;            // preselected privilege for the request dialog
  target_note: string | null;           // e.g. "also needs USE CATALOG …" or why the grant is record-only
  provisioning_mode: "platform" | "record_only";
}

export interface AssetDetail {
  asset: AssetCard & {
    attributes: Record<string, unknown>; external_ref: Record<string, unknown>;
    also_registered_in: Registration[];
    also_registered_in_field?: FieldValue | null;   // provenance of the synced registrations (Microsoft Agent 365)
    published_version: string | null; latest_version: string | null;
    first_seen_at: string; last_synced_at: string | null; source_created_at: string | null; created_by: string | null;
    completeness_pct: number;
  };
  fields: FieldValue[];
  versions: VersionRow[];
  parent: AssetCard | null;
  tabs: string[];                       // overview, tools, access, usage, traces, evals, policies, lineage, changes, subscribers, audit
  permissions: AssetPermissions;
  access_settings: AccessSettings;
}
// GET  /api/assets/{asset_id}
// PUT  /api/assets/{asset_id}/fields/{field_key}            {value, reason?, lock_mode?}  → FieldValue
// POST /api/assets/{asset_id}/fields/{field_key}/revert      {reason?}                     → FieldValue
// POST /api/assets/{asset_id}/fields/{field_key}/resolve-drift {action: "keep"|"accept_source"} → FieldValue
// GET  /api/assets/{asset_id}/fields/history                 → Envelope<FieldHistory[]>
// PUT  /api/assets/{asset_id}/governance  {lifecycle_status?, certification?, sensitivity?, risk_tier?, domain?, tags?, reason} → AssetCard
// POST /api/assets/{asset_id}/owners {email, kind} ; DELETE /api/assets/{asset_id}/owners/{email}/{kind}
// POST /api/assets/{asset_id}/runtime {action: "pause"|"resume"|"deprecate"|"retire", reason} → ChangeDetail  (registry status; notifies subscribers)
// GET  /api/assets/{asset_id}/tools → Envelope<ToolRow[]>   (children; for agents: tools/agents/skills it uses, via lineage)

/** One listing of this asset in another registry ("Also registered in"). match/confidence: how the sync matched it. */
export interface Registration { registry: string; id: string; url?: string; display_name?: string; platform?: string; match?: string; confidence?: number; }

export interface FieldHistory { id: number; field_key: string; old_value: unknown; new_value: unknown; provenance: Provenance; actor: string; reason: string | null; at: string; }

// ── access ──
export interface Grant {
  grant_id: number; principal: string; principal_type: "user" | "group" | "service_principal";
  privilege: string; source: "platform" | "app"; inherited: boolean; request_id: number | null;
  granted_by: string | null; granted_at: string; expires_at: string | null;
}
export type RequestStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "provisioning" | "provisioned" | "provision_failed" | "revoked";
export interface AccessRequest {
  request_id: number; asset_id: string; asset_display_name: string; asset_type: AssetType;
  requester_email: string; principal: string; principal_type: string; privilege: string; tool_subset: string[];
  justification: string; duration_days: number; terms_accepted: boolean; subscribe_email: string | null;
  status: RequestStatus; approvers: string[]; decided_by: string | null; decided_at: string | null; decision_reason: string | null;
  provision_mode: string | null; provision_detail: Record<string, unknown> | null; grant_expires_at: string | null;
  sla_due_at: string; request_expires_at: string; created_at: string; sla_state: "on_track" | "due_soon" | "overdue" | "closed";
  can_decide: boolean;
}
export interface AssetAccess {
  grants: Grant[]; my_access: Grant[]; pending_requests: AccessRequest[]; my_requests: AccessRequest[];
  settings: AccessSettings; platform_request_destinations: { destination_type: string; destination_id: string }[] | null;
}
// GET  /api/assets/{asset_id}/access → Envelope<AssetAccess>
// PUT  /api/assets/{asset_id}/access-settings  Partial<AccessSettings> → AccessSettings
// POST /api/assets/{asset_id}/access-requests  {principal?, principal_type?, privilege, tool_subset?, justification, duration_days, terms_accepted, subscribe_email?} → AccessRequest
// GET  /api/requests?scope=mine|review|all&status=  → Envelope<AccessRequest[]>
// POST /api/requests/{id}/decision {decision: "approve"|"deny", reason?, provision_mode?: "grant_direct"|"add_to_group"|"record_only", group?, duration_days?} → AccessRequest
// POST /api/requests/{id}/cancel → AccessRequest ; POST /api/requests/{id}/retry → AccessRequest
// POST /api/grants/{grant_id}/revoke {reason} → Grant

// ── subscriptions (email-registered consumers) ──
export interface Subscription {
  subscription_id: number; asset_id: string; asset_display_name: string; asset_type: AssetType;
  subscriber_email: string; notify_emails: string[]; subscriber_kind: "user" | "team" | "service_principal" | "agent" | "app";
  relationship: "direct_use" | "via_downstream"; downstream_asset_id: string | null; downstream_name: string | null;
  use_case: string | null; environment: "prod" | "staging" | "dev"; notify_pref: "breaking_only" | "all" | "weekly_digest";
  status: "active" | "unsubscribed"; created_by: string; created_at: string; last_ack_at: string | null; has_access: boolean;
}
export interface UnregisteredConsumer { requester: string; requester_kind: string; requests_30d: number; last_seen: string; }
// GET    /api/assets/{asset_id}/subscribers → Envelope<{subscribers: Subscription[]; unregistered: UnregisteredConsumer[]}>
// POST   /api/assets/{asset_id}/subscriptions {subscriber_email, notify_emails?, subscriber_kind?, relationship?, downstream_asset_id?, downstream_name?, use_case?, environment?, notify_pref?} → Subscription
// PATCH  /api/subscriptions/{id}  partial → Subscription ;  DELETE /api/subscriptions/{id} → {ok}
// POST   /api/assets/{asset_id}/nudge {requesters: string[]} → {ok, notified}   (owner: ask unregistered consumers to register)

// ── usage registration (every use carries an email) ──
// POST /api/v1/usage {asset_id, consumer_email, operation, via_asset_id?, client?, request_id?, status?, latency_ms?, input_tokens?, output_tokens?, note?} → {ok, event_id}
// POST /api/assets/{asset_id}/use {consumer_email, operation: "registered_use"|"copied_endpoint", via_asset_id?} → {ok, event_id}

// ── usage & cost ──
export interface DailyPoint { day: string; requests: number; errors: number; input_tokens: number; output_tokens: number; cost_usd: number; }
export interface UsageSourceNote { name: string; detail: string; as_of: string | null; }
export interface Budget { monthly_usd: number; alert_pct: number; action: "alert" | "block"; source: "app" | "unity_gateway"; mtd_usd: number; forecast_usd: number; state: "on_track" | "at_risk" | "exceeded"; }
export interface AssetUsage {
  kpis: { requests: number; users: number; errors: number; error_rate: number | null; input_tokens: number; output_tokens: number;
          cost_usd: number; usd_per_1k_requests: number | null; usd_per_user: number | null; p95_latency_ms: number | null };
  daily: DailyPoint[];
  by_consumer: { requester: string; requester_kind: string; requests: number; cost_usd: number | null; last_seen: string; subscribed: boolean }[];
  by_tool: { tool_name: string; requests: number; errors: number }[];
  cost_by_sku: { sku: string; source: string; usd: number; dbus: number }[];
  budget: Budget | null; anomalies: Anomaly[]; sources: UsageSourceNote[]; scope: "all" | "self";
}
export interface Anomaly { asset_id: string; asset_display_name: string; day: string; metric: "cost" | "requests" | "errors"; value: number; baseline: number; ratio: number; hint: string; }
// GET /api/assets/{asset_id}/usage?days=30 → Envelope<AssetUsage>
// PUT /api/assets/{asset_id}/budget {monthly_usd, alert_pct, action} → Budget
export interface FleetUsage {
  kpis: { requests: number; users: number; cost_usd: number; agents_active: number; mcp_active: number; governed_pct: number };
  daily: DailyPoint[];
  top_assets: { asset_id: string; display_name: string; asset_type: AssetType; requests: number; cost_usd: number; users: number }[];
  by_type: { asset_type: AssetType; requests: number; cost_usd: number }[];
  by_platform: { platform: string; requests: number; cost_usd: number }[];
  anomalies: Anomaly[]; budgets: (Budget & { asset_id: string; display_name: string })[]; sources: UsageSourceNote[];
}
// GET /api/usage-cost?days=30 → Envelope<FleetUsage>

// ── traces & evals (Databricks-built agents) ──
export interface TraceRow {
  trace_id: string; request_time: string; duration_ms: number | null; state: "OK" | "ERROR" | "IN_PROGRESS" | string;
  input_tokens: number | null; output_tokens: number | null; user: string | null; trace_name: string | null;
  assessments: { name: string; value: string | number | boolean | null; source_type: string }[];
}
export interface AssetTraces { experiment_id: string | null; deep_link: string | null; traces: TraceRow[]; daily: { day: string; traces: number; errors: number; p95_ms: number | null }[]; note: string | null; }
export interface ScorerSummary { name: string; kind: "offline" | "monitoring"; mean: number | null; pass_rate: number | null; n: number; trend: { day: string; value: number }[]; }
export interface AssetEvals { experiment_id: string | null; scorers: ScorerSummary[]; runs: { run_id: string; version: string | null; run_at: string; scorers: Record<string, number> }[]; deep_link: string | null; note: string | null; }
// GET /api/assets/{asset_id}/traces?limit=50 → Envelope<AssetTraces>   (consumers: only their own traces)
// GET /api/assets/{asset_id}/evals → Envelope<AssetEvals>
export interface QualityFleet { agents: { asset_id: string; display_name: string; traces_30d: number; error_rate: number | null; p95_ms: number | null; scorer_means: Record<string, number>; regression: boolean; experiment_id: string | null }[]; }
// GET /api/quality → Envelope<QualityFleet>

// ── policies & guardrails ──
export interface PolicyChip {
  policy_id: string; name: string; kind: string; provider: string; phase: string; action: string;
  status: "active" | "proposed"; inherited_from: string | null; summary: string; config: Record<string, unknown>;
}
export interface Coverage { pct: number; required: { requirement: string; label: string; met: boolean }[]; }
export interface Violations { total_7d: number; by_action: Record<string, number>; by_policy: { policy_id: string; name: string; count: number }[]; daily: { day: string; count: number }[]; }
export interface AssetPolicies { chips: PolicyChip[]; coverage: Coverage; violations: Violations; risk_tier: RiskTier; }
// GET  /api/assets/{asset_id}/policies → Envelope<AssetPolicies>
// POST /api/assets/{asset_id}/policies/{policy_id} {status: "active"|"proposed"} → PolicyChip   (owner proposes, steward activates)
// DELETE /api/assets/{asset_id}/policies/{policy_id} → {ok}
export interface PolicyLibraryItem { policy_id: string; name: string; kind: string; provider: string; phase: string; action: string; description: string | null; applied_count: number; origin: string; }
export interface PolicyGap { requirement: string; label: string; asset_type: AssetType; risk_tier: RiskTier; missing_count: number; sample_assets: { asset_id: string; display_name: string }[]; }
export interface PoliciesFleet { library: PolicyLibraryItem[]; gaps: PolicyGap[]; coverage_pct: number; governed_traffic_pct: number; violations: Violations; }
// GET /api/policies → Envelope<PoliciesFleet>

// ── lineage ──
export type NodeType = "agent" | "mcp_server" | "tool" | "skill" | "user" | "service_principal" | "table" | "index" | "volume" | "model" | "app" | "external";
export interface LineageNode { id: string; type: NodeType; label: string; subtype?: string | null; restricted?: boolean; impacted?: boolean; focus?: boolean; owner?: string | null; certification?: Certification | null; policy_shield?: "full" | "partial" | "none" | null; }
export interface LineageEdge { src: string; dst: string; relation: string; edge_kind: "declared" | "observed" | "data"; weight_30d: number; last_seen: string; source: string; impacted?: boolean; undeclared?: boolean; }
export interface LineageGraph { focus: string | null; depth: number; direction: "up" | "down" | "both"; nodes: LineageNode[]; edges: LineageEdge[]; truncated: boolean; }
// GET /api/lineage?focus=&depth=1..4&dir=up|down|both&kinds=declared,observed,data&change_id= → Envelope<LineageGraph>

// ── changes & impact ──
export type AckStatus = "pending" | "not_impacted" | "impacted_will_migrate" | "need_help" | "not_required";
export interface ChangeSummary {
  change_id: number; asset_id: string; asset_display_name: string; asset_type: AssetType;
  from_version: string | null; to_version: string | null; change_kinds: string[]; breaking: boolean;
  title: string; summary: string | null; status: string; detected_by: "sync" | "owner" | "admin";
  published_by: string | null; published_at: string | null; effective_at: string | null; created_at: string;
  impacted_people: number; acked: number; my_ack: AckStatus | null;
}
export interface ImpactItem { impacted_key: string; impact_type: "subscriber" | "downstream_asset" | "downstream_owner" | "observed_consumer"; via_asset_id: string | null; hops: number; email: string | null; ack_status: AckStatus; ack_note: string | null; migrate_by: string | null; acked_at: string | null; notified_at: string | null; label: string; }
export interface MetricsSnapshot { window_days: number; requests: number; error_rate: number | null; cost_usd: number; p95_ms: number | null; eval: Record<string, number>; }
export interface ChangeDetail { change: ChangeSummary & { diff: { field: string; before: unknown; after: unknown }[]; release_notes: string | null; sunset_at: string | null }; impact: ImpactItem[]; ack_summary: Record<AckStatus, number>; metrics_before: MetricsSnapshot | null; metrics_after: MetricsSnapshot | null; }
export interface ImpactPreview { subscribers: ImpactItem[]; downstream: ImpactItem[]; observed: ImpactItem[]; total_people: number; email_preview: { subject: string; body: string }; checks: { name: string; passed: boolean; detail: string }[]; }
// GET  /api/changes?asset_id=&breaking=true&mine=true&days=90 → Envelope<ChangeSummary[]>
// GET  /api/changes/{change_id} → Envelope<ChangeDetail>
// POST /api/changes/{change_id}/ack {status: AckStatus, note?, migrate_by?} → ImpactItem[]   (acks every impact row for the caller's email)
// POST /api/assets/{asset_id}/changes/preview {to_version, change_kinds, breaking, title, summary?, release_notes?, effective_at?} → ImpactPreview
// POST /api/assets/{asset_id}/changes        (same body) → ChangeDetail   (publish: freezes impact, queues notifications)

// ── notifications ──
export interface Notification { notification_id: number; kind: string; title: string; body: string | null; asset_id: string | null; ref_id: string | null; channel: string; delivery_status: string; read_at: string | null; created_at: string; }
// GET /api/notifications?unread=true → Envelope<Notification[]> ; POST /api/notifications/{id}/read ; POST /api/notifications/read-all

// ── my workspace ──
// GET /api/me → Envelope<Me>
// GET /api/me/subscriptions → Envelope<Subscription[]> ; /api/me/access → Envelope<(Grant & {asset_id, asset_display_name, asset_type})[]>
// GET /api/me/requests → Envelope<AccessRequest[]> ; /api/me/owned → Envelope<AssetCard[]> ; /api/me/impacts → Envelope<(ImpactItem & {change: ChangeSummary})[]>

// ── home ──
export interface TopAction { kind: string; label: string; count: number; href: string; severity: "info" | "warning" | "critical"; }
export interface HomeData {
  kpis: { agents: number; mcp_servers: number; tools: number; skills: number; subscribers: number; requests_30d: number; cost_30d_usd: number; governed_pct: number; ownerless: number };
  top_actions: TopAction[]; my_subscriptions: AssetCard[]; recent_changes: ChangeSummary[]; trending: AssetCard[];
  sync: { last_run_at: string | null; status: string | null };
}
// GET /api/home → Envelope<HomeData>

// ── search (command palette) ──
export interface SearchHit { kind: "asset" | "person" | "page" | "action"; id: string; label: string; sublabel: string | null; href: string; asset_type?: AssetType; }
// GET /api/search?q= → Envelope<SearchHit[]>

// ── governance (steward/admin; auditor read) ──
export interface SyncRun { run_id: number; collector: string; started_at: string; finished_at: string | null; status: string; items_seen: number; items_changed: number; error: string | null; triggered_by: string; }
export interface GovernanceSources { collectors: { collector: string; label: string; last: SyncRun | null; history: SyncRun[] }[]; job: { configured: boolean; job_id: string | null; url: string | null }; }
// GET  /api/governance/sources → Envelope<GovernanceSources> ; POST /api/governance/sync {collectors?: string[]} → {ok, run: {...}}
export interface CurationQueue { discovered: AssetCard[]; pending_approval: AssetCard[]; ownerless: AssetCard[]; drifted: { asset_id: string; display_name: string; field_key: string; source_value: unknown; override_value: unknown }[]; }
// GET  /api/governance/curation → Envelope<CurationQueue>
// POST /api/governance/curation/{asset_id} {action: "approve"|"reject", reason} → AssetCard
// GET  /api/governance/overrides → Envelope<(FieldValue & {asset_id, display_name})[]>
export interface RoleAssignment { email: string; role: "steward" | "admin" | "auditor"; domain: string; granted_by: string; granted_at: string | null; expires_at: string | null; reason: string | null; bootstrap?: boolean; }
// GET /api/governance/roles → Envelope<RoleAssignment[]> ; POST /api/governance/roles {email, role, reason} ; DELETE /api/governance/roles/{email}/{role}

// ── registration (custom assets) ──
// POST /api/assets {asset_type, display_name, name, platform, publisher?, endpoint_url?, purpose, description?, tags?, sensitivity?} → AssetCard   (lifecycle pending_approval; creator = owner)
// POST /api/skills  {skill_md: string, tags?} → AssetCard   (parses SKILL.md frontmatter name/description/allowed-tools/license)

// ── audit ──
export interface AuditRow { audit_id: number; at: string; actor: string; action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown; reason: string | null; source: string; row_hash: string; }
// GET /api/audit?entity_type=&entity_id=&actor=&action=&days=30&page=1&page_size=50 → Envelope<{rows: AuditRow[]; total: number; page: number; page_size: number}>
// GET /api/audit/verify → Envelope<{intact: boolean; checked: number; problems: {audit_id: number; problem: string}[]}>
// GET /api/audit/export?format=csv|json&... → file download

// ── platform watch: release feeds, new APIs, branch-tested upgrades (admins decide; stewards/auditors read) ──
export interface FeedSource { source_id: string; label: string; url: string; kind: "rss" | "atom"; publisher: string; enabled: boolean;
  last_fetched_at: string | null; last_status: string | null; items_total: number; }
export interface FeedItem { item_id: number; source_id: string; title: string; link: string | null; published_at: string | null; summary: string | null;
  relevance: number; matched_capabilities: string[]; matched_terms: string[]; lifecycle_hint: string | null; breaking_hint: boolean;
  status: "new" | "triaged" | "dismissed" | "linked"; candidate_id: number | null; }
export type CapabilityStatus = "unknown" | "available" | "unavailable" | "no_access" | "error";
export interface Capability { capability_key: string; label: string; area: string; description: string | null; docs_url: string | null;
  keywords: string[]; probe_kind: "rest" | "sql" | "none"; probe_method: string; probe_path: string | null; adapter: string | null;
  adapter_enabled: boolean; status: CapabilityStatus; http_status: number | null; probe_detail: string | null;
  last_probed_at: string | null; first_available_at: string | null; }
export interface RegressionStep { name: string; status: "passed" | "failed"; detail: unknown; duration_ms: number; }
export interface MigrationAnalysis { version: string; breaking: boolean; reasons: string[]; allow_data_loss: boolean; statements: number; }
export type CandidateStatus = "detected" | "testing" | "passed" | "failed" | "accepted" | "delayed" | "rejected" | "applying" | "applied" | "apply_failed";
export interface JobRun { mode: "job" | "not_configured"; job_id?: string; run_id?: number | null; url?: string | null; note?: string; }
export interface UpdateCandidate {
  candidate_id: number; kind: "app_release" | "capability" | "advisory"; title: string; summary: string | null;
  from_version: string | null; to_version: string | null; capability_key: string | null;
  feed_item_ids: number[]; feed_items: Pick<FeedItem, "item_id" | "source_id" | "title" | "link" | "published_at" | "lifecycle_hint">[];
  migrations: MigrationAnalysis[]; breaking: boolean; breaking_reasons: string[]; status: CandidateStatus; branch_name: string | null;
  regression: { started_at: string; finished_at: string; branch: string; passed: boolean; steps: RegressionStep[] } | null;
  auto_apply: boolean; delay_until: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null;
  applied_at: string | null; apply_detail: { finished_at: string; steps: RegressionStep[]; ok: boolean } | null;
  created_at: string; updated_at: string; apply_run?: JobRun;
}
export interface WatchOverview { counts: Partial<Record<CandidateStatus, number>>; sources: FeedSource[]; settings: Record<string, unknown>;
  ready: number; attention: number; job_configured: boolean; }
// GET  /api/platform-watch → Envelope<WatchOverview>
// GET  /api/platform-watch/candidates?status=passed,failed → Envelope<UpdateCandidate[]>
// GET  /api/platform-watch/feed?min_relevance=35&source=&limit=200 → Envelope<FeedItem[]>
// GET  /api/platform-watch/capabilities → Envelope<Capability[]>
// POST /api/platform-watch/candidates/{id}/decision {action: "accept"|"delay"|"reject"|"acknowledge", delay_until?, note?} → UpdateCandidate
//      accept: only a regression-passed app_release/capability (a breaking one needs a note), then the apply job starts (apply_run).
//      delay: until a date (default + default_delay_days); it resurfaces automatically. reject: note required. acknowledge: advisories.
// POST /api/platform-watch/candidates/{id}/check → JobRun   (re-run the regression on a fresh Lakebase branch)
// POST /api/platform-watch/run → JobRun                      (fetch feeds + probe APIs + detect + regress now)
// PUT  /api/platform-watch/settings/{key} {value} → {key, value}   keys: auto_upgrade (never|non_breaking|all), relevance_threshold,
//      default_delay_days, keep_failed_branch_hours
// POST /api/platform-watch/feed/{item_id}/dismiss → {ok}
// Percent fields across the API (coverage_pct, governed_pct, governed_traffic_pct, completeness_pct) are 0–100.

// ── Unity Catalog external lineage: plan (dry run) → admin publish ──
export type UcOpKind = "external_metadata" | "external_lineage";
export interface UcRequest { method: "POST" | "PATCH" | "DELETE"; path: string; query?: Record<string, unknown>; body?: Record<string, unknown>; }
export interface UcLineageOp { op: "create" | "update" | "delete" | "forget"; kind: UcOpKind; key: string; asset_id?: string; label: string; detail: string;
  content_hash: string; request: UcRequest | null; }
export interface UcOpCounts { create: number; update: number; delete: number; forget: number; unchanged: number; }
export interface UcLineagePlan { mode: "platform" | "record_only"; digest: string; instance: string; total_ops: number; truncated: boolean;
  objects: UcOpCounts; relationships: UcOpCounts; desired: { objects: number; relationships: number }; ops: UcLineageOp[];
  skipped: { reason: string; count: number; sample: string[] }[]; tables: string[]; requirements: string[]; }
export interface UcLineageRun { run_id: number; triggered_by: string; mode: "platform" | "record_only"; acting_as: string | null;
  status: "running" | "succeeded" | "partial" | "failed" | "nothing_to_do"; plan_digest: string | null;
  counts: { outcomes?: Record<string, number>; processed?: number; remaining?: number }; errors: { op: string; kind: UcOpKind; key: string; error: string }[];
  started_at: string; finished_at: string | null; requests_recorded?: number; }
export interface UcLineageStatus { available: boolean; note?: string; plan: UcLineagePlan | null; settings: { publish_in_sync: boolean };
  runs: UcLineageRun[]; tracked: Record<string, Record<string, number>>; failed?: { key: string; name: string; last_error: string | null; updated_at: string }[];
  can_publish: boolean; }
export type UcReadinessStatus = "ready" | "partial" | "blocked" | "unknown" | "not_required";
export type UcCheckStatus = "ok" | "missing" | "warning" | "unknown" | "skipped";
export interface UcRemediation { sql: string[]; run_by: string; note?: string | null; }
export interface UcReadinessTable { table: string; status: "ok" | "missing" | "not_found" | "unknown"; detail: string; owner?: string | null; sql?: string; }
export interface UcReadinessCheck { id: "metastore_privilege" | "table_modify" | "api_reachable" | "identity"; title: string; status: UcCheckStatus;
  blocking: boolean; detail: string; remediation: UcRemediation | null; tables?: UcReadinessTable[]; total?: number; checked?: number; unchecked?: number; }
export interface UcSyncCheck { status: Exclude<UcReadinessStatus, "not_required">; reason: string | null; principal: string | null; skipped: boolean;
  triggered_by: string; checked_at: string; checks: { id: string; status: UcCheckStatus; detail: string }[]; }
export interface UcReadinessPath { path: "app" | "obo" | "sync"; label: string; applies_to: string; principal: string | null;
  principal_kind: "service_principal" | "user" | "group" | "unknown"; status: Exclude<UcReadinessStatus, "not_required">; reason: string | null;
  checks: UcReadinessCheck[]; remediation_sql: string[]; last_check?: UcSyncCheck | null; }
export interface UcReadiness { status: UcReadinessStatus; reason: string | null; active_path: "app" | "obo" | null; mode: "platform" | "record_only";
  enforced: boolean; obo_token_forwarded: boolean; metastore: { metastore_id: string; name: string | null; owner: string | null; default_catalog_name?: string | null } | null;
  paths: UcReadinessPath[]; tables: { total: number; max_checked: number; error: string | null }; remediation_sql: string[]; grants_script: string;
  checked_at: string; cached: boolean; ttl_seconds: number; }
export interface UcPublishResult { run_id: number; status: UcLineageRun["status"]; mode: "platform" | "record_only"; acting_as: string | null; plan_digest: string;
  counts: UcLineageRun["counts"]; errors: UcLineageRun["errors"]; requests: (UcRequest & { op: string; kind: UcOpKind; key: string })[];
  results: { op: string; kind: UcOpKind; key: string; label: string; outcome: string }[]; }
// GET  /api/lineage/uc-publish → Envelope<UcLineageStatus>          (stewards, admins, auditors; the plan is read-only)
// POST /api/lineage/uc-publish {digest} → UcPublishResult            (admin; 409 when the plan changed since the preview)
// PUT  /api/lineage/uc-publish/settings {publish_in_sync, reason?} → {key, value}   (admin; the sync-job step, default off)
// GET  /api/lineage/uc-publish/readiness[?refresh=true] → Envelope<UcReadiness>   (stewards, admins, auditors; read-only; source "live")
//      Per publishing identity (app SP, the signed-in admin when an OBO token is forwarded, the sync job's run-as identity):
//      CREATE EXTERNAL METADATA on the metastore (blocking), MODIFY on up to max_checked of the plan's tables (not blocking: a gap makes
//      the status "partial"), and the external lineage API answering (blocking). status = the active path's (obo when a token is
//      forwarded, else app): blocked → the UI disables Publish; unknown = an API error (never a 500); not_required in record_only.
//      Cached ttl_seconds (unknown: 30 s) per signed-in identity; refresh=true re-checks.

// ── Microsoft Agent 365 registrations ──
export type RegistrationStatus = "matched" | "suggested" | "unmatched" | "linked" | "dismissed";
export interface ExternalRegistration { external_id: string; display_name: string | null; platform: string | null; publisher: string | null; url: string | null;
  hints: { genie_space_ids?: string[]; endpoint_names?: string[]; workspace_hosts?: string[]; note?: string };
  matched_asset_id: string | null; asset_display_name: string | null; match_method: string | null; confidence: number | null;
  status: RegistrationStatus; source: "graph" | "file"; first_seen_at: string; last_seen_at: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; }
export interface Agent365Overview { registry: string; available: boolean; graph: { configured: boolean; connection: string | null; endpoint?: string };
  auto_match?: number; can_import: boolean; can_review: boolean; counts: Partial<Record<RegistrationStatus, number>>;
  review: ExternalRegistration[]; linked: ExternalRegistration[]; runs: (SyncRun & { detail?: Record<string, unknown> })[]; }
export interface Agent365ImportResult { run_id: number; records: number; ignored_not_databricks: number; matched: number; suggested: number;
  unmatched: number; kept_steward_decision: number; fields_changed: number; assets_linked: number; }
// GET  /api/agent365 → Envelope<Agent365Overview>                       (stewards, admins, auditors)
// POST /api/agent365/import {filename, content, format?: "csv"|"json"} → Agent365ImportResult   (admin)
// POST /api/agent365/review {external_id, action: "link"|"dismiss"|"reopen", asset_id?, reason} → ExternalRegistration   (steward)

// ── Knowledge graph: RDF triples → Unity Catalog Delta (OntoBricks layout), preview → admin export ──
export type KgRunStatus = "running" | "succeeded" | "unchanged" | "conflict" | "failed";
export interface KgTarget { catalog: string; schema: string; version: number; base: string; source: "setting" | "bundle" | "setting+bundle";
  schema_name?: string; data_table: string; }
export interface KgTerm { iri: string; name: string; label: string; count: number; kind?: "rdf" | "object" | "data"; }
export interface KgObject { role: string; name: string; kind: "TABLE" | "VIEW"; comment: string; explorer_url: string | null; }
export interface KgStatement { step: string; sql: string; detail?: string; }
export interface KgConflict { role: string; name: string; kind: string | null; reason: string; }
export interface KgRunSummary { run_id: number; digest: string; status: KgRunStatus; mode: "platform" | "record_only"; started_at: string; finished_at: string | null; }
export interface KgPreview { available: boolean; note?: string; can_export: boolean; mode?: "platform" | "record_only"; namespace?: string;
  instance?: string; layout?: string; digest: string | null; triples: number; classes: KgTerm[]; predicates: KgTerm[];
  samples: [string, string, string][]; skipped: { reason: string; count: number; sample: string[] }[];
  privacy?: { allowed_owner_emails: number; redacted_literals: number; people_and_service_principal_edges_left_out: number };
  target: KgTarget | null; objects: KgObject[]; statements: KgStatement[]; explorer_url?: string | null; requirements?: string[];
  load?: { stage: string; batches: number; rows: number; max_statement_bytes: number; largest_statement_bytes: number; total_bytes: number } | null;
  last_run: KgRunSummary | null; unchanged_since_last_run?: boolean; }
export interface KgSettings { export_in_sync: boolean; catalog: string; schema: string; version: number; bundle_target: string | null; }
export interface KgRun { run_id: number; triggered_by: string; mode: "platform" | "record_only"; acting_as: string | null; target: string; digest: string;
  status: KgRunStatus; counts: { triples?: number; classes?: number; predicates?: number; batches?: number; objects?: number; statements?: number };
  conflicts: KgConflict[]; error: string | null; started_at: string; finished_at: string | null; statements_recorded?: number; }
export interface KgStatus { available: boolean; note?: string; can_export: boolean; namespace?: string; layout?: string; target: KgTarget | null;
  settings: KgSettings; runs: KgRun[]; }
export interface KgExportResult { run_id: number; status: KgRunStatus; mode: "platform" | "record_only"; acting_as: string | null; digest: string;
  target: KgTarget; counts: KgRun["counts"]; conflicts: KgConflict[]; error: string | null; statements: KgStatement[]; explorer_url: string | null; }
// GET  /api/kg/preview → Envelope<KgPreview>        (stewards, admins, auditors; builds the triples and the exact SQL, writes nothing)
// POST /api/kg/export {digest} → KgExportResult     (admin; 409 when the graph changed since the preview, no target, or another export
//      to the same target is running; 200 with status "unchanged" | "conflict" | "failed" otherwise, each with one audit row kg.export)
// GET  /api/kg/status → Envelope<KgStatus>          (stewards, admins, auditors; settings + the last 10 runs)
// PUT  /api/kg/settings {catalog?, schema?, version?, export_in_sync?, reason?} → KgSettings   (admin; each key audited as registry.setting)
// GET  /api/kg/ontology.ttl → text/turtle           (the OWL ontology with this install's namespace, for the OntoBricks import)

// ── MCP tool selection (UC MCP services) ──
export interface SelectionTool { asset_id: string; name: string; display_name: string; side_effect: string | null; requests_30d: number;
  exposed_now: boolean; exposed_after?: boolean; }
export interface ToolSelectionHistory { selection_id: number; before_value: string[]; after_value: string[]; removed_tools: string[]; added_tools: string[];
  breaking: boolean; etag: string | null; request: UcRequest; mode: "platform" | "record_only"; acting_as: string | null;
  status: "applied" | "recorded" | "failed"; error: string | null; change_id: number | null; reason: string | null; requested_by: string; created_at: string; }
export interface ToolSelectionState { asset_id: string; editable: boolean; reason_not_editable: string | null; can_edit: boolean; current: string[];
  etag: string | null; tools: SelectionTool[]; history: ToolSelectionHistory[]; mode: "platform" | "record_only";
  limits: { max_selectors: number; max_length: number }; uc_listed?: boolean; }
export interface ToolSelectionPreview { selectors: string[]; current: string[]; errors: string[]; warnings: string[]; tools: SelectionTool[];
  removed: string[]; added: string[]; unmatched_selectors: string[]; exposed_count: number; hidden_count: number; breaking: boolean;
  changed: boolean; impact: ImpactPreview | null; request: UcRequest; mode: "platform" | "record_only"; }
export interface ToolSelectionResult { status: "applied" | "recorded" | "failed"; selection_id: number; mode: "platform" | "record_only"; as: string | null;
  error: string | null; request: UcRequest; change: ChangeDetail | null; etag?: string | null; note?: string | null; }
// GET  /api/assets/{id}/tool-selection → Envelope<ToolSelectionState>
// POST /api/assets/{id}/tool-selection/preview {selectors, reason?} → ToolSelectionPreview   (owners, stewards)
// PUT  /api/assets/{id}/tool-selection {selectors, etag?, reason?} → ToolSelectionResult     (owners, stewards; breaking needs a reason)
//      200 with status "failed" when Unity Catalog refuses the PATCH (nothing changes, no change_event); 409 on an etag mismatch or
//      when nothing changes; 400 on invalid selectors or a breaking change without a reason; 403 for other roles or non-mcp:service assets.
