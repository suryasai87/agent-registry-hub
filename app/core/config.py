"""Deployment settings. Every per-workspace value arrives as app env (app.yaml / bundle), never hard-coded.

Modules read ``config.X`` at call time (not ``from core.config import X``) so tests can monkeypatch them.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def ident(name: str, what: str = "identifier") -> str:
    """A safe, unquoted Postgres identifier (schema/table names are interpolated into DDL and SQL)."""
    if not _IDENT.match(name or ""):
        raise ValueError(f"invalid {what} {name!r}: use letters, digits and underscores (max 63, no leading digit)")
    return name


def qualified(name: str, default_schema: str) -> tuple[str, str]:
    """'table' or 'schema.table' -> (schema, table), both validated."""
    parts = name.split(".")
    if len(parts) == 1:
        return ident(default_schema, "schema"), ident(parts[0], "table")
    if len(parts) == 2:
        return ident(parts[0], "schema"), ident(parts[1], "table")
    raise ValueError(f"invalid table name {name!r}: expected 'table' or 'schema.table'")


APP_NAME = os.environ.get("APP_NAME", "agent-registry-hub")
def _version_file() -> str:
    try:
        return (Path(__file__).resolve().parents[1] / "VERSION").read_text().strip()
    except OSError:
        return "0.0.0"


APP_VERSION = os.environ.get("APP_VERSION") or _version_file()  # app/VERSION, copied from the repo VERSION on release

# Lakebase (autoscale Postgres). On Databricks Apps: LAKEBASE_ENDPOINT = projects/<p>/branches/<b>/endpoints/<e>
# and the app service principal mints OAuth credentials. Locally, LAKEBASE_URL (a static libpq DSN) wins.
LAKEBASE_ENDPOINT = os.environ.get("LAKEBASE_ENDPOINT", "").strip()
LAKEBASE_DATABASE = os.environ.get("LAKEBASE_DATABASE") or os.environ.get("PGDATABASE") or "databricks_postgres"
LAKEBASE_SCHEMA = ident(os.environ.get("LAKEBASE_SCHEMA", "registry").strip(), "LAKEBASE_SCHEMA")
LAKEBASE_PORT = int(os.environ.get("LAKEBASE_PORT", "5432"))
LAKEBASE_URL = os.environ.get("LAKEBASE_URL", "").strip()
LAKEBASE_POOL_MAX = int(os.environ.get("LAKEBASE_POOL_MAX", "6"))
LAKEBASE_POOL_TIMEOUT = float(os.environ.get("LAKEBASE_POOL_TIMEOUT", "10"))
LAKEBASE_CONNECT_TIMEOUT = int(os.environ.get("LAKEBASE_CONNECT_TIMEOUT", "5"))

# Append-only audit trail ('table' resolves inside LAKEBASE_SCHEMA; 'schema.table' is used as given).
AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "audit_log").strip()

# SQL warehouse for the lakehouse tier (Statement Execution API).
WAREHOUSE_ID = os.environ.get("WAREHOUSE_ID", "").strip()

# false = read-only kiosk mode: every governed write answers 503.
ALLOW_MUTATIONS = env_bool("ALLOW_MUTATIONS", True)

# Bootstrap registry admins (comma-separated emails, case-insensitive).
REGISTRY_ADMINS = frozenset(e.strip().lower() for e in os.environ.get("REGISTRY_ADMINS", "").split(",") if e.strip())

# The signed-in user when no Databricks Apps identity headers are present (local development).
LOCAL_USER = os.environ.get("LOCAL_USER", "local.developer@localhost").strip().lower()
