-- Collectors (app/collectors): additive objects only.
--
-- trace_recent: the most recent MLflow traces per agent, for the Traces tab. Metadata only: request and
-- response payloads (and trace inputs/outputs previews) are NEVER stored. Assessments are compacted to
-- {name, value, source_type}, where value is a scalar (bool, number or a short label).
CREATE TABLE IF NOT EXISTS {{schema}}.trace_recent (
    trace_id       text PRIMARY KEY,
    asset_id       text NOT NULL,
    experiment_id  text NOT NULL,
    request_time   timestamptz NOT NULL,
    duration_ms    int,
    state          text,
    input_tokens   int,
    output_tokens  int,
    user_ref       text,           -- tags["mlflow.user"]: an email, a user id or an SP application id
    trace_name     text,
    assessments    jsonb NOT NULL DEFAULT '[]'::jsonb,
    synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trace_recent_asset_idx ON {{schema}}.trace_recent (asset_id, request_time DESC);

-- Sync bookkeeping lookups used by the collectors (missing-from-source sweeps and per-source rollups).
CREATE INDEX IF NOT EXISTS asset_sync_source_idx ON {{schema}}.asset (sync_source);
CREATE INDEX IF NOT EXISTS usage_daily_source_idx ON {{schema}}.usage_daily (source, day);
CREATE INDEX IF NOT EXISTS cost_daily_source_idx ON {{schema}}.cost_daily (source, day);
CREATE INDEX IF NOT EXISTS lineage_edge_source_idx ON {{schema}}.lineage_edge (source, last_seen);
