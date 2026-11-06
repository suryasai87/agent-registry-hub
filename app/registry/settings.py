"""App-level switches in ``registry_setting`` (migration 007). Admins change them in the UI; every change is audited.

Readers tolerate a schema that does not have the table yet (the sync job runs from the staged bundle with
``--skip-migrations``): ``get`` then answers the default, so a new switch is OFF until its migration is applied.
"""
from __future__ import annotations

from typing import Any, Callable

from psycopg.types.json import Jsonb

from core import audit
from registry import authz

def _boolean(value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValueError("expected true or false")
    return value


def _uc_name(value: Any) -> str:
    """A Unity Catalog catalog or schema name ('' clears it). The knowledge graph export backtick-quotes it."""
    import re

    text = "" if value is None else str(value).strip()
    if text and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,254}", text):
        raise ValueError("use letters, digits, underscores and hyphens only (no dots or backticks)")
    return text


def _store_version(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 9999:
        raise ValueError("expected a whole number from 1 to 9999")
    return value


# key -> (default, validator). Validators return the clean value or raise ValueError.
KNOWN: dict[str, tuple[Any, Callable[[Any], Any]]] = {
    "uc_lineage_publish_in_sync": (False, _boolean),
    "kg_export_in_sync": (False, _boolean),          # the sync job's optional knowledge graph export step (migration 008)
    "kg_target_catalog": ("", _uc_name),             # '' = use the bundle variable kg_target (KG_TARGET)
    "kg_target_schema": ("", _uc_name),
    "kg_store_version": (1, _store_version),         # the <n> in triplestore_agent_registry_hub_V<n> (an OntoBricks domain version)
}


def table_exists(cur) -> bool:
    cur.execute("SELECT to_regclass('registry_setting') IS NOT NULL AS ok")
    return bool(cur.fetchone()["ok"])


def get(cur, key: str, default: Any = None) -> Any:
    if key in KNOWN and default is None:
        default = KNOWN[key][0]
    if not table_exists(cur):
        return default
    cur.execute("SELECT value FROM registry_setting WHERE key = %s", (key,))
    row = cur.fetchone()
    return default if row is None else row["value"]


def put(cur, key: str, value: Any, *, p: authz.Principal, reason: str | None = None) -> dict:
    authz.require(p.is_admin, "Only an admin can change registry settings")
    if key not in KNOWN:
        raise ValueError(f"unknown setting {key!r}")
    clean = KNOWN[key][1](value)
    before = get(cur, key)
    cur.execute("""INSERT INTO registry_setting (key, value, updated_by, updated_at) VALUES (%s, %s, %s, now())
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()""",
                (key, Jsonb(clean), p.email))
    audit.audit_event(p.email, "registry.setting", "registry_setting", key, before={"value": before},
                      after={"value": clean, "reason": (reason or "").strip() or None}, request_id=p.request_id, cur=cur)
    return {"key": key, "value": clean}


def remember(cur, key: str, value: Any, *, actor: str) -> None:
    """Internal bookkeeping values (not admin switches, so no audit row of their own), e.g. the hub URL the last
    publish used, so the sync job publishes exactly what the app previewed."""
    if not table_exists(cur):
        return
    cur.execute("""INSERT INTO registry_setting (key, value, updated_by, updated_at) VALUES (%s, %s, %s, now())
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
                   WHERE registry_setting.value IS DISTINCT FROM EXCLUDED.value""", (key, Jsonb(value), actor))


def instance_id(cur) -> str:
    """A stable id for this registry install (seeded by migration 007). UC object names are salted with it, so two hubs
    sharing a metastore never claim each other's objects."""
    value = get(cur, "hub_instance_id", "")
    return str(value or "")
