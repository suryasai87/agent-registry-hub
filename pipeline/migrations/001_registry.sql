-- Agent Registry Hub — core registry model.
-- {{schema}} is replaced with LAKEBASE_SCHEMA by app/core/migrate.py. Additive only: later
-- changes go in new numbered files.
--
-- Design notes
-- * One `asset` table for every registered thing (agent, mcp_server, tool, skill), keyed by a
--   stable URN (`agent:serving:<endpoint>`, `mcp:external:<connection>`, …) so records match
--   across registries (Agent 365, AWS Agent Registry, MCP Registry).
-- * Descriptive metadata lives in `asset_field` with FIELD-LEVEL PROVENANCE: the value pulled
--   from the source system and an optional owner/admin override are kept side by side, so a
--   sync never clobbers a human edit and drift is detectable.
-- * Consumers are identified by EMAIL everywhere (subscriptions, usage, requests, impact),
--   which is what makes downstream impact computable.
-- * `audit_log` is append-only and hash-chained (see 002_audit.sql).

-- ─────────────────────────────── identities & app roles ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.app_user (
    email          text PRIMARY KEY CHECK (email = lower(email) AND position('@' in email) > 1),
    display_name   text,
    databricks_id  text,
    groups         text[]      NOT NULL DEFAULT '{}',
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- Global roles. Viewer is implicit for every signed-in user; Consumer/Owner are DERIVED from
-- subscriptions/grants/ownership. Only steward, admin and auditor are assigned.
CREATE TABLE IF NOT EXISTS {{schema}}.role_assignment (
    email       text        NOT NULL,
    role        text        NOT NULL CHECK (role IN ('steward','admin','auditor')),
    domain      text        NOT NULL DEFAULT '*',
    granted_by  text        NOT NULL,
    granted_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz,
    reason      text,
    PRIMARY KEY (email, role, domain)
);

-- ─────────────────────────────── assets ───────────────────────────────
-- array_to_string is only STABLE, so a generated column can't call it directly. This wrapper is safe to
-- declare IMMUTABLE because a text[] → text join depends on nothing but its input.
CREATE OR REPLACE FUNCTION {{schema}}.tags_text(text[]) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(array_to_string($1, ' '), '') $$;

CREATE TABLE IF NOT EXISTS {{schema}}.asset (
    asset_id          text PRIMARY KEY,
    asset_type        text NOT NULL CHECK (asset_type IN ('agent','mcp_server','tool','skill')),
    subtype           text NOT NULL,          -- e.g. agent_bricks_supervisor, managed_genie, external_connection, uc_function, mcp_tool, agent_skill
    name              text NOT NULL,          -- source-system name (endpoint, connection, FQN, skill name)
    display_name      text NOT NULL,
    source            text NOT NULL CHECK (source IN ('databricks','external','custom')),
    platform          text NOT NULL,          -- agent_bricks, model_serving, databricks_apps, unity_catalog, genie, microsoft_365, marketplace, mcp_registry, git, manual
    publisher         text,
    parent_asset_id   text REFERENCES {{schema}}.asset(asset_id) ON DELETE SET NULL,  -- tool → its MCP server
    lifecycle_status  text NOT NULL DEFAULT 'approved'
                      CHECK (lifecycle_status IN ('discovered','draft','pending_approval','approved','rejected','deprecated','retired')),
    runtime_status    text NOT NULL DEFAULT 'unknown'
                      CHECK (runtime_status IN ('running','stopped','paused','blocked','degraded','unknown')),
    certification     text NOT NULL DEFAULT 'unreviewed'
                      CHECK (certification IN ('certified','verified_publisher','unreviewed','deprecated')),
    sensitivity       text NOT NULL DEFAULT 'internal'
                      CHECK (sensitivity IN ('public','internal','confidential','restricted')),
    risk_tier         text NOT NULL DEFAULT 'medium' CHECK (risk_tier IN ('low','medium','high','critical')),
    domain            text,
    tags              text[]      NOT NULL DEFAULT '{}',
    published_version text,
    latest_version    text,
    external_ref      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- endpoint name/id, tile id, connection, function FQN, URLs
    attributes        jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- type-specific: task, models, tool schema, side_effect, annotations…
    deep_link         text,
    also_registered_in jsonb      NOT NULL DEFAULT '[]'::jsonb,
    origin            text        NOT NULL DEFAULT 'sync' CHECK (origin IN ('sync','app','demo')),
    sync_source       text,
    created_by        text,
    source_created_at timestamptz,
    source_updated_at timestamptz,
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    last_synced_at    timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    search            tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('simple', coalesce(display_name,'') || ' ' || coalesce(name,'')), 'A') ||
                        setweight(to_tsvector('simple', coalesce(publisher,'') || ' ' || coalesce(domain,'') || ' ' || {{schema}}.tags_text(tags)), 'B')
                      ) STORED
);
CREATE INDEX IF NOT EXISTS asset_type_idx   ON {{schema}}.asset (asset_type, lifecycle_status);
CREATE INDEX IF NOT EXISTS asset_parent_idx ON {{schema}}.asset (parent_asset_id);
CREATE INDEX IF NOT EXISTS asset_search_idx ON {{schema}}.asset USING gin (search);
CREATE INDEX IF NOT EXISTS asset_tags_idx   ON {{schema}}.asset USING gin (tags);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_owner (
    asset_id   text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    email      text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('owner','co_owner','sponsor','steward')),
    source     text NOT NULL DEFAULT 'assigned' CHECK (source IN ('synced','assigned')),
    added_by   text,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, email, kind)
);
CREATE INDEX IF NOT EXISTS asset_owner_email_idx ON {{schema}}.asset_owner (email);

-- Descriptive fields with provenance. effective value = override_value when present, else source_value.
-- provenance: 'source' (auto-pulled), 'owner' (description widget), 'admin' (steward/admin override).
CREATE TABLE IF NOT EXISTS {{schema}}.asset_field (
    asset_id         text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    field_key        text NOT NULL,   -- purpose, description, intended_users, inputs, outputs, data_sensitivity, sla, support_channel, limitations, example_prompts, links, …
    source_value     jsonb,
    source_label     text,            -- where the auto-pulled value came from (e.g. "tools/list", "UC connection comment")
    source_synced_at timestamptz,
    override_value   jsonb,
    provenance       text NOT NULL DEFAULT 'source' CHECK (provenance IN ('source','owner','admin')),
    lock_mode        text NOT NULL DEFAULT 'keep' CHECK (lock_mode IN ('keep','follow')),
    override_reason  text,
    overridden_by    text,
    overridden_at    timestamptz,
    drift            boolean NOT NULL DEFAULT false,   -- the source changed after a 'keep' override
    PRIMARY KEY (asset_id, field_key)
);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_field_history (
    id          bigserial PRIMARY KEY,
    asset_id    text NOT NULL,
    field_key   text NOT NULL,
    old_value   jsonb,
    new_value   jsonb,
    provenance  text NOT NULL,
    actor       text NOT NULL,
    reason      text,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_field_history_idx ON {{schema}}.asset_field_history (asset_id, at DESC);

-- ─────────────────────────────── versions & changes ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.asset_version (
    asset_id        text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    version         text NOT NULL,
    status          text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','superseded','rolled_back')),
    config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,   -- normalized config used to diff versions
    source          text NOT NULL DEFAULT 'sync' CHECK (source IN ('sync','manual')),
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, version)
);

CREATE TABLE IF NOT EXISTS {{schema}}.change_event (
    change_id       bigserial PRIMARY KEY,
    asset_id        text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    from_version    text,
    to_version      text,
    change_kinds    text[] NOT NULL DEFAULT '{}',   -- description, tools_added, tools_removed, schema, model, prompt, policy, owner, deprecation, sensitivity, runtime
    breaking        boolean NOT NULL DEFAULT false,
    title           text NOT NULL,
    summary         text,
    diff            jsonb NOT NULL DEFAULT '[]'::jsonb,
    release_notes   text,
    status          text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','rolled_back')),
    detected_by     text NOT NULL DEFAULT 'sync' CHECK (detected_by IN ('sync','owner','admin')),
    published_by    text,
    published_at    timestamptz,
    effective_at    timestamptz,
    sunset_at       timestamptz,
    metrics_before  jsonb,
    metrics_after   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_event_asset_idx ON {{schema}}.change_event (asset_id, created_at DESC);

-- Who a change affects, computed at publish time and frozen (so later unsubscribes don't rewrite history).
CREATE TABLE IF NOT EXISTS {{schema}}.impact_item (
    change_id       bigint NOT NULL REFERENCES {{schema}}.change_event(change_id) ON DELETE CASCADE,
    impacted_key    text   NOT NULL,       -- email for people, asset_id for downstream assets
    impact_type     text   NOT NULL CHECK (impact_type IN ('subscriber','downstream_asset','downstream_owner','observed_consumer')),
    via_asset_id    text,                  -- for downstream: the asset that depends on the changed one
    hops            int    NOT NULL DEFAULT 1,
    email           text,                  -- who gets notified / acknowledges
    ack_status      text   NOT NULL DEFAULT 'pending'
                    CHECK (ack_status IN ('pending','not_impacted','impacted_will_migrate','need_help','not_required')),
    ack_note        text,
    migrate_by      date,
    acked_at        timestamptz,
    notified_at     timestamptz,
    reminders_sent  int NOT NULL DEFAULT 0,
    PRIMARY KEY (change_id, impacted_key, impact_type)
);
CREATE INDEX IF NOT EXISTS impact_item_email_idx ON {{schema}}.impact_item (email, ack_status);

-- ─────────────────────────────── subscriptions (email-registered consumers) ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.subscription (
    subscription_id     bigserial PRIMARY KEY,
    asset_id            text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    subscriber_email    text NOT NULL CHECK (subscriber_email = lower(subscriber_email) AND subscriber_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    notify_emails       text[] NOT NULL DEFAULT '{}',          -- team DLs / extra recipients
    subscriber_kind     text NOT NULL DEFAULT 'user' CHECK (subscriber_kind IN ('user','team','service_principal','agent','app')),
    relationship        text NOT NULL DEFAULT 'direct_use' CHECK (relationship IN ('direct_use','via_downstream')),
    downstream_asset_id text REFERENCES {{schema}}.asset(asset_id) ON DELETE SET NULL,
    downstream_name     text,                                  -- free text when the downstream isn't registered yet
    use_case            text,
    environment         text NOT NULL DEFAULT 'prod' CHECK (environment IN ('prod','staging','dev')),
    notify_pref         text NOT NULL DEFAULT 'breaking_only' CHECK (notify_pref IN ('breaking_only','all','weekly_digest')),
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed')),
    created_by          text NOT NULL,                         -- signed-in user who registered it
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_ack_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_uniq
    ON {{schema}}.subscription (asset_id, subscriber_email, coalesce(downstream_asset_id, ''), coalesce(downstream_name, ''))
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS subscription_email_idx ON {{schema}}.subscription (subscriber_email, status);

-- ─────────────────────────────── usage (every use, with the consumer's email) ───────────────────────────────
-- Fine-grained events: registered by consumers/agents through the app or POST /api/v1/usage,
-- plus playground/"copy URL" actions. Platform usage arrives aggregated in usage_daily.
CREATE TABLE IF NOT EXISTS {{schema}}.usage_event (
    event_id        bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    asset_id        text NOT NULL,
    consumer_email  text NOT NULL CHECK (consumer_email = lower(consumer_email) AND position('@' in consumer_email) > 1),
    consumer_kind   text NOT NULL DEFAULT 'user',
    via_asset_id    text,                -- e.g. the agent that called this MCP/tool on the user's behalf
    operation       text NOT NULL,       -- invoke, tool_call, registered_use, copied_endpoint, playground
    client          text,                -- app, api, sdk, notebook, …
    request_id      text,
    status          text NOT NULL DEFAULT 'ok',
    latency_ms      int,
    input_tokens    int,
    output_tokens   int,
    note            text,
    origin          text NOT NULL DEFAULT 'app' CHECK (origin IN ('app','api','sync','demo'))
);
CREATE INDEX IF NOT EXISTS usage_event_asset_idx    ON {{schema}}.usage_event (asset_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_event_consumer_idx ON {{schema}}.usage_event (consumer_email, occurred_at DESC);

-- Daily rollups pulled from system tables (system.ai_gateway.usage, system.serving.endpoint_usage)
-- and from usage_event. requester = email for users, application id for service principals.
CREATE TABLE IF NOT EXISTS {{schema}}.usage_daily (
    day             date NOT NULL,
    asset_id        text NOT NULL,
    requester       text NOT NULL,
    requester_kind  text NOT NULL DEFAULT 'user',
    source          text NOT NULL,       -- ai_gateway_usage, endpoint_usage, registry_events, demo
    requests        bigint NOT NULL DEFAULT 0,
    errors          bigint NOT NULL DEFAULT 0,
    input_tokens    bigint NOT NULL DEFAULT 0,
    output_tokens   bigint NOT NULL DEFAULT 0,
    p95_latency_ms  int,
    tool_name       text NOT NULL DEFAULT '',
    PRIMARY KEY (day, asset_id, requester, source, tool_name)
);
CREATE INDEX IF NOT EXISTS usage_daily_asset_idx ON {{schema}}.usage_daily (asset_id, day DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.cost_daily (
    day          date NOT NULL,
    asset_id     text NOT NULL,
    sku          text NOT NULL,
    source       text NOT NULL,          -- billing_usage, external_model_spend, estimated_tokens, demo
    dbus         numeric(18,6) NOT NULL DEFAULT 0,
    usd          numeric(18,6) NOT NULL DEFAULT 0,
    is_estimate  boolean NOT NULL DEFAULT true,
    PRIMARY KEY (day, asset_id, sku, source)
);
CREATE INDEX IF NOT EXISTS cost_daily_asset_idx ON {{schema}}.cost_daily (asset_id, day DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.budget (
    asset_id       text PRIMARY KEY REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    monthly_usd    numeric(14,2) NOT NULL CHECK (monthly_usd > 0),
    alert_pct      int NOT NULL DEFAULT 80 CHECK (alert_pct BETWEEN 1 AND 100),
    action         text NOT NULL DEFAULT 'alert' CHECK (action IN ('alert','block')),
    source         text NOT NULL DEFAULT 'app' CHECK (source IN ('app','unity_gateway')),
    set_by         text NOT NULL,
    set_at         timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────── access ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.access_settings (
    asset_id              text PRIMARY KEY REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    approval_required     boolean NOT NULL DEFAULT true,
    approver_mode         text NOT NULL DEFAULT 'any' CHECK (approver_mode IN ('any','all')),
    approvers             text[] NOT NULL DEFAULT '{}',   -- empty → owners → domain steward → admins
    default_duration_days int NOT NULL DEFAULT 90 CHECK (default_duration_days BETWEEN 1 AND 3650),
    max_duration_days     int NOT NULL DEFAULT 180 CHECK (max_duration_days BETWEEN 1 AND 3650),
    sla_hours             int NOT NULL DEFAULT 48,
    terms_text            text,
    managed_externally_url text,
    updated_by            text,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Mirror of platform ACLs (synced) plus grants the app provisioned (with expiry the platform lacks).
CREATE TABLE IF NOT EXISTS {{schema}}.access_grant (
    grant_id        bigserial PRIMARY KEY,
    asset_id        text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    principal       text NOT NULL,
    principal_type  text NOT NULL CHECK (principal_type IN ('user','group','service_principal')),
    privilege       text NOT NULL,           -- EXECUTE, USE_CONNECTION, CAN_QUERY, CAN_MANAGE, CAN_RUN, CAN_VIEW, …
    source          text NOT NULL CHECK (source IN ('platform','app')),
    inherited       boolean NOT NULL DEFAULT false,
    request_id      bigint,
    granted_by      text,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    revoked_at      timestamptz,
    revoked_by      text,
    last_seen_on_platform timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS access_grant_uniq
    ON {{schema}}.access_grant (asset_id, principal, privilege, source) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS access_grant_principal_idx ON {{schema}}.access_grant (principal);

CREATE TABLE IF NOT EXISTS {{schema}}.access_request (
    request_id        bigserial PRIMARY KEY,
    asset_id          text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    requester_email   text NOT NULL,
    principal         text NOT NULL,           -- who gets access (requester, a group, or an SP application id)
    principal_type    text NOT NULL DEFAULT 'user' CHECK (principal_type IN ('user','group','service_principal')),
    privilege         text NOT NULL,
    tool_subset       text[] NOT NULL DEFAULT '{}',
    justification     text NOT NULL CHECK (length(justification) >= 15),
    duration_days     int NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
    terms_accepted    boolean NOT NULL DEFAULT false,
    subscribe_email   text,                    -- the email to register as subscriber on approval
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','denied','expired','cancelled','provisioning','provisioned','provision_failed','revoked')),
    approvers         text[] NOT NULL DEFAULT '{}',
    approvals         jsonb  NOT NULL DEFAULT '[]'::jsonb,   -- [{by, at, decision}] for approver_mode=all
    decided_by        text,
    decided_at        timestamptz,
    decision_reason   text,
    provision_mode    text CHECK (provision_mode IN ('grant_direct','add_to_group','record_only')),
    provision_group   text,
    provision_detail  jsonb,
    grant_expires_at  timestamptz,
    sla_due_at        timestamptz NOT NULL,
    reminded_at       timestamptz,
    request_expires_at timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_request_asset_idx ON {{schema}}.access_request (asset_id, status);
CREATE INDEX IF NOT EXISTS access_request_requester_idx ON {{schema}}.access_request (requester_email, created_at DESC);

-- ─────────────────────────────── policies & guardrails ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.policy (
    policy_id    text PRIMARY KEY,
    name         text NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('guardrail','rate_limit','budget','access','tool_allowlist','data_policy','approval','usage_tracking','inference_logging','fallback')),
    provider     text NOT NULL,            -- unity_gateway, serving_ai_gateway, unity_catalog, registry
    phase        text NOT NULL DEFAULT 'n/a' CHECK (phase IN ('input','output','both','n/a')),
    action       text NOT NULL DEFAULT 'n/a' CHECK (action IN ('block','mask','flag','ask','alert','limit','log','allow','deny','n/a')),
    config       jsonb NOT NULL DEFAULT '{}'::jsonb,
    description  text,
    origin       text NOT NULL DEFAULT 'sync' CHECK (origin IN ('sync','app','demo')),
    synced_at    timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{schema}}.policy_binding (
    policy_id      text NOT NULL REFERENCES {{schema}}.policy(policy_id) ON DELETE CASCADE,
    asset_id       text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed')),
    inherited_from text,
    bound_by       text,
    bound_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (policy_id, asset_id)
);
CREATE INDEX IF NOT EXISTS policy_binding_asset_idx ON {{schema}}.policy_binding (asset_id);

-- Required controls per risk tier → the coverage meter.
CREATE TABLE IF NOT EXISTS {{schema}}.policy_requirement (
    risk_tier   text NOT NULL CHECK (risk_tier IN ('low','medium','high','critical')),
    asset_type  text NOT NULL,
    requirement text NOT NULL,             -- e.g. guardrail:output, guardrail:input, rate_limit, usage_tracking, inference_logging, budget, owner, support_channel
    label       text NOT NULL,
    PRIMARY KEY (risk_tier, asset_type, requirement)
);

CREATE TABLE IF NOT EXISTS {{schema}}.policy_violation_daily (
    day        date NOT NULL,
    asset_id   text NOT NULL,
    policy_id  text NOT NULL,
    action     text NOT NULL,
    count      bigint NOT NULL DEFAULT 0,
    source     text NOT NULL,
    PRIMARY KEY (day, asset_id, policy_id, action)
);

-- ─────────────────────────────── lineage ───────────────────────────────
-- Nodes are assets (asset_id), people (user:<email>), service principals (sp:<app id>) and data
-- (table:<fqn>, volume:<fqn>, index:<fqn>, genie:<space>, model:<fqn>).
CREATE TABLE IF NOT EXISTS {{schema}}.lineage_edge (
    src_id       text NOT NULL,
    dst_id       text NOT NULL,
    relation     text NOT NULL,   -- uses_tool, calls_agent, exposes_tool, reads_data, writes_data, uses_model, uses_skill, consumes, subscribes, routes_to
    edge_kind    text NOT NULL CHECK (edge_kind IN ('declared','observed','data')),
    source       text NOT NULL,   -- config, subscription, gateway_usage, endpoint_usage, trace, uc_lineage, usage_event, manual
    weight_30d   bigint NOT NULL DEFAULT 0,
    first_seen   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (src_id, dst_id, relation, edge_kind)
);
CREATE INDEX IF NOT EXISTS lineage_edge_dst_idx ON {{schema}}.lineage_edge (dst_id);

-- ─────────────────────────────── quality (traces & evals) ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.asset_experiment (
    asset_id       text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    experiment_id  text NOT NULL,
    link_source    text NOT NULL,          -- endpoint_tag, tile, manual
    PRIMARY KEY (asset_id, experiment_id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.trace_daily (
    day          date NOT NULL,
    asset_id     text NOT NULL,
    traces       bigint NOT NULL DEFAULT 0,
    errors       bigint NOT NULL DEFAULT 0,
    p50_ms       int,
    p95_ms       int,
    source       text NOT NULL,
    PRIMARY KEY (day, asset_id, source)
);

CREATE TABLE IF NOT EXISTS {{schema}}.eval_result (
    asset_id      text NOT NULL,
    run_id        text NOT NULL,
    scorer        text NOT NULL,
    version       text,
    kind          text NOT NULL DEFAULT 'offline' CHECK (kind IN ('offline','monitoring')),
    dataset       text,
    mean_value    double precision,
    pass_rate     double precision,
    n             int,
    run_at        timestamptz NOT NULL,
    source        text NOT NULL,
    PRIMARY KEY (asset_id, run_id, scorer)
);
CREATE INDEX IF NOT EXISTS eval_result_asset_idx ON {{schema}}.eval_result (asset_id, run_at DESC);

-- ─────────────────────────────── notifications & sync ───────────────────────────────
-- The outbox: every notification lands here (in-app inbox). An optional dispatcher delivers
-- email/webhook when configured; delivery status is recorded, never assumed.
CREATE TABLE IF NOT EXISTS {{schema}}.notification (
    notification_id bigserial PRIMARY KEY,
    recipient_email text NOT NULL,
    kind            text NOT NULL,   -- access_request, access_decision, change_published, ack_reminder, grant_expiring, subscription_confirmed, unregistered_consumer
    title           text NOT NULL,
    body            text,
    asset_id        text,
    ref_id          text,            -- request_id / change_id
    channel         text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','webhook')),
    delivery_status text NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','sent','failed','skipped')),
    delivery_detail text,
    read_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_recipient_idx ON {{schema}}.notification (recipient_email, created_at DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.sync_run (
    run_id        bigserial PRIMARY KEY,
    collector     text NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed','skipped')),
    items_seen    int NOT NULL DEFAULT 0,
    items_changed int NOT NULL DEFAULT 0,
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
    error         text,
    triggered_by  text NOT NULL DEFAULT 'schedule'
);
CREATE INDEX IF NOT EXISTS sync_run_idx ON {{schema}}.sync_run (collector, started_at DESC);
