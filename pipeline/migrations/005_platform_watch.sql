-- Platform Watch: release-feed subscriptions, capability probes and governed self-upgrade.
--
-- Flow:
--  1. The sync job fetches the RSS/Atom feeds (Databricks release notes, MLflow, Databricks SDK/CLI releases),
--     scores each item against the capability catalog, and probes every capability's API in the workspace.
--  2. A new or newly-available capability, or a newer staged app version, becomes an update_candidate.
--  3. The updates job tests the candidate on a throwaway Lakebase BRANCH: pending migrations, the pytest
--     regression suite, read-path smoke checks on a copy of the live data, and row-count preservation.
--  4. Admins see the result in the app (breaking changes listed) and Accept, Delay or Reject. The policy
--     can auto-apply non-breaking candidates that passed. Every decision is audited.

CREATE TABLE IF NOT EXISTS {{schema}}.feed_source (
    source_id        text PRIMARY KEY,
    label            text NOT NULL,
    url              text NOT NULL,
    kind             text NOT NULL CHECK (kind IN ('rss','atom')),
    publisher        text NOT NULL,
    enabled          boolean NOT NULL DEFAULT true,
    last_fetched_at  timestamptz,
    last_status      text,
    items_total      int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS {{schema}}.feed_item (
    item_id              bigserial PRIMARY KEY,
    source_id            text NOT NULL REFERENCES {{schema}}.feed_source(source_id) ON DELETE CASCADE,
    guid                 text NOT NULL,
    title                text NOT NULL,
    link                 text,
    published_at         timestamptz,
    summary              text,
    relevance            int NOT NULL DEFAULT 0,          -- 0..100
    matched_capabilities text[] NOT NULL DEFAULT '{}',
    matched_terms        text[] NOT NULL DEFAULT '{}',
    lifecycle_hint       text,                            -- ga, public_preview, beta, deprecation, breaking
    breaking_hint        boolean NOT NULL DEFAULT false,
    status               text NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','dismissed','linked')),
    candidate_id         bigint,
    fetched_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, guid)
);
CREATE INDEX IF NOT EXISTS feed_item_rank_idx ON {{schema}}.feed_item (relevance DESC, published_at DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.capability (
    capability_key      text PRIMARY KEY,
    label               text NOT NULL,
    area                text NOT NULL,                    -- agents, mcp, skills, usage, traces, access, guardrails, lineage
    description         text,
    docs_url            text,
    keywords            text[] NOT NULL DEFAULT '{}',
    probe_kind          text NOT NULL CHECK (probe_kind IN ('rest','sql','none')),
    probe_method        text NOT NULL DEFAULT 'GET',
    probe_path          text,
    probe_body          jsonb,
    adapter             text,                             -- the collector that uses it
    adapter_enabled     boolean NOT NULL DEFAULT false,
    requires_migrations text[] NOT NULL DEFAULT '{}',
    status              text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','available','unavailable','no_access','error')),
    http_status         int,
    probe_detail        text,
    last_probed_at      timestamptz,
    first_available_at  timestamptz
);

CREATE TABLE IF NOT EXISTS {{schema}}.update_candidate (
    candidate_id      bigserial PRIMARY KEY,
    kind              text NOT NULL CHECK (kind IN ('app_release','capability','advisory')),
    title             text NOT NULL,
    summary           text,
    from_version      text,
    to_version        text,
    capability_key    text,
    feed_item_ids     bigint[] NOT NULL DEFAULT '{}',
    migrations        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{version, breaking, reasons[], statements}]
    breaking          boolean NOT NULL DEFAULT false,
    breaking_reasons  text[] NOT NULL DEFAULT '{}',
    status            text NOT NULL DEFAULT 'detected'
                      CHECK (status IN ('detected','testing','passed','failed','accepted','delayed','rejected','applying','applied','apply_failed')),
    branch_name       text,
    regression        jsonb,                                 -- {started_at, finished_at, branch, steps:[{name,status,detail,duration_ms}], summary}
    auto_apply        boolean NOT NULL DEFAULT false,         -- eligible under the auto-upgrade policy
    delay_until       timestamptz,
    decided_by        text,
    decided_at        timestamptz,
    decision_note     text,
    applied_at        timestamptz,
    apply_detail      jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS update_candidate_open_uniq
    ON {{schema}}.update_candidate (kind, coalesce(capability_key, ''), coalesce(to_version, ''))
    WHERE status NOT IN ('applied','rejected');

CREATE TABLE IF NOT EXISTS {{schema}}.watch_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO {{schema}}.watch_settings (key, value) VALUES
    ('auto_upgrade', '"non_breaking"'),          -- never | non_breaking | all
    ('relevance_threshold', '35'),
    ('default_delay_days', '7'),
    ('keep_failed_branch_hours', '72')
ON CONFLICT DO NOTHING;

INSERT INTO {{schema}}.feed_source (source_id, label, url, kind, publisher) VALUES
    ('databricks_release_notes', 'Databricks release notes (AWS)', 'https://docs.databricks.com/aws/en/feed.xml', 'rss', 'Databricks'),
    ('mlflow_releases', 'MLflow releases (OSS)', 'https://github.com/mlflow/mlflow/releases.atom', 'atom', 'MLflow'),
    ('databricks_sdk_py', 'Databricks SDK for Python releases', 'https://github.com/databricks/databricks-sdk-py/releases.atom', 'atom', 'Databricks'),
    ('databricks_cli', 'Databricks CLI releases', 'https://github.com/databricks/cli/releases.atom', 'atom', 'Databricks')
ON CONFLICT DO NOTHING;
