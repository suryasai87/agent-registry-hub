-- Interop with the platform: Unity Catalog external lineage, Microsoft Agent 365 registrations and MCP tool selection.
-- Additive only (new tables and seed settings), so Platform Watch treats the release as non-breaking.
--
-- * registry_setting: app-level switches that admins flip in the UI (audited). Every switch defaults OFF.
-- * uc_lineage_*: what the hub published to Unity Catalog (external metadata objects and external lineage
--   relationships) and every publish run. Publishing is a plan/diff against these rows, so it is idempotent, and
--   the hub only ever updates or deletes objects listed here (never UC objects it did not create).
-- * external_registration: records from other registries (Microsoft Agent 365 Connected platforms), matched to
--   registry assets or queued for steward review. Matched IDs feed the asset_field 'also_registered_in'.
-- * mcp_tool_selection: every include_tool_selectors change requested from the app, with the exact request.

CREATE TABLE IF NOT EXISTS {{schema}}.registry_setting (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO {{schema}}.registry_setting (key, value) VALUES
    ('uc_lineage_publish_in_sync', 'false'),                          -- the sync job's optional publish step
    ('hub_instance_id', to_jsonb(gen_random_uuid()::text))            -- salts UC object names per registry install
ON CONFLICT DO NOTHING;

-- ─────────────────────────────── Unity Catalog external lineage ───────────────────────────────
-- One external metadata object per published asset. Rows are never removed: status 'removed' remembers that the
-- hub deleted (or forgot) the object, mode says whether it really exists in UC or was only recorded.
CREATE TABLE IF NOT EXISTS {{schema}}.uc_lineage_object (
    asset_id       text PRIMARY KEY,                -- no FK: a deleted asset still needs its UC object cleaned up
    metadata_name  text NOT NULL UNIQUE,            -- deterministic: derived from hub_instance_id + asset URN
    metadata_id    text,                            -- the id Unity Catalog returned
    system_type    text NOT NULL,
    entity_type    text NOT NULL,
    content_hash   text NOT NULL,                   -- sha256 of the published body (detects updates)
    mode           text NOT NULL CHECK (mode IN ('platform','record_only')),
    status         text NOT NULL DEFAULT 'published' CHECK (status IN ('published','failed','removed')),
    last_error     text,
    last_run_id    bigint,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One external lineage relationship per (source, target) pair. Several hub edges between the same pair (declared +
-- observed, uses_tool + uses_mcp) collapse into one relationship whose properties list them.
CREATE TABLE IF NOT EXISTS {{schema}}.uc_lineage_relationship (
    edge_key        text PRIMARY KEY,               -- "<source ref>><target ref>", e.g. "table:c.s.t>em:<name>"
    source_ref      jsonb NOT NULL,                 -- {"table": {"name": "c.s.t"}} | {"external_metadata": {"name": "…"}}
    target_ref      jsonb NOT NULL,
    hub_edges       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{src_id, dst_id, relation, edge_kind}]
    relationship_id text,                           -- the id Unity Catalog returned
    content_hash    text NOT NULL,
    mode            text NOT NULL CHECK (mode IN ('platform','record_only')),
    status          text NOT NULL DEFAULT 'published' CHECK (status IN ('published','failed','removed')),
    last_error      text,
    last_run_id     bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{schema}}.uc_lineage_run (
    run_id        bigserial PRIMARY KEY,
    triggered_by  text NOT NULL,                    -- the admin's email, or system:sync for the job step
    mode          text NOT NULL CHECK (mode IN ('platform','record_only')),
    acting_as     text,                             -- approver (on-behalf-of) | app service principal | sync job identity
    status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','partial','failed','nothing_to_do')),
    plan_digest   text,
    counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
    errors        jsonb NOT NULL DEFAULT '[]'::jsonb,
    requests      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the exact requests (always kept for record_only runs)
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS uc_lineage_run_idx ON {{schema}}.uc_lineage_run (started_at DESC);

-- ─────────────────────────────── registrations in other registries ───────────────────────────────
-- status: matched (an id/URL in the record identifies the asset, or a name match above the auto threshold),
-- suggested (a weaker name match, waiting for a steward), unmatched, linked (a steward confirmed a match),
-- dismissed (a steward said it is not ours). Steward decisions survive re-imports.
CREATE TABLE IF NOT EXISTS {{schema}}.external_registration (
    registry        text NOT NULL,                  -- microsoft_agent_365
    external_id     text NOT NULL,
    display_name    text,
    platform        text,
    publisher       text,
    url             text,
    record          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- a sanitized subset of the source record
    hints           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- genie_space_ids, endpoint_names, workspace_hosts found in it
    matched_asset_id text,
    match_method    text,                           -- genie_space_id | endpoint_name | app_name | name | steward
    confidence      double precision,
    status          text NOT NULL DEFAULT 'unmatched'
                    CHECK (status IN ('matched','suggested','unmatched','linked','dismissed')),
    source          text NOT NULL CHECK (source IN ('graph','file')),
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_run_id     bigint,
    reviewed_by     text,
    reviewed_at     timestamptz,
    review_note     text,
    PRIMARY KEY (registry, external_id)
);
CREATE INDEX IF NOT EXISTS external_registration_asset_idx ON {{schema}}.external_registration (matched_asset_id);
CREATE INDEX IF NOT EXISTS external_registration_status_idx ON {{schema}}.external_registration (registry, status);

-- ─────────────────────────────── MCP tool selection ───────────────────────────────
CREATE TABLE IF NOT EXISTS {{schema}}.mcp_tool_selection (
    selection_id  bigserial PRIMARY KEY,
    asset_id      text NOT NULL REFERENCES {{schema}}.asset(asset_id) ON DELETE CASCADE,
    before_value  jsonb NOT NULL DEFAULT '[]'::jsonb,
    after_value   jsonb NOT NULL DEFAULT '[]'::jsonb,
    removed_tools text[] NOT NULL DEFAULT '{}',
    added_tools   text[] NOT NULL DEFAULT '{}',
    breaking      boolean NOT NULL DEFAULT false,
    etag          text,
    request       jsonb NOT NULL,                   -- {method, path, query, body}: exactly what is (or would be) sent
    mode          text NOT NULL CHECK (mode IN ('platform','record_only')),
    acting_as     text,
    status        text NOT NULL CHECK (status IN ('applied','recorded','failed')),
    error         text,
    change_id     bigint,
    reason        text,
    requested_by  text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_tool_selection_asset_idx ON {{schema}}.mcp_tool_selection (asset_id, created_at DESC);
