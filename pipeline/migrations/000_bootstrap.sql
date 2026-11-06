-- Bootstrap: the registry schema and the migration ledger used by app/core/migrate.py.
-- {{schema}} is replaced with LAKEBASE_SCHEMA (default "registry") by the runner.

CREATE SCHEMA IF NOT EXISTS {{schema}};

CREATE TABLE IF NOT EXISTS {{schema}}.schema_migrations (
    version    text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum   text        NOT NULL
);
