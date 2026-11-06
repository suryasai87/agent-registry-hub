"""Append-only audit trail writer.

Writes one row per governed change into ``config.AUDIT_TABLE`` (default ``<LAKEBASE_SCHEMA>.audit_log``; the
DDL lives in pipeline/migrations and is owned by the data model). Expected columns:

    actor text, action text, entity_type text, entity_id text, before jsonb, after jsonb, request_id text
    (plus an identity key and a ``now()``-defaulted timestamp, filled by the table)

Pass the caller's transaction cursor (``with db.transaction() as cur: ...; audit_event(..., cur=cur)``) so the
change and its audit row commit or roll back together. Without ``cur`` the row is written in its own
transaction. Failures raise: a governed change that cannot be audited must not report success.
"""
from __future__ import annotations

import json
import logging
from functools import partial
from typing import Any

from psycopg import sql
from psycopg.types.json import Jsonb

from core import config, db

log = logging.getLogger("registry.audit")
MAX_ID = 512

_dumps = partial(json.dumps, default=str, sort_keys=True)


def table_ref(name: str | None = None) -> sql.Composed:
    # default to the ACTIVE pool's schema (tests and branch pools point db.lb at another schema)
    schema, table = config.qualified(name or config.AUDIT_TABLE, getattr(db.lb, "schema", None) or config.LAKEBASE_SCHEMA)
    return sql.SQL("{}.{}").format(sql.Identifier(schema), sql.Identifier(table))


def _actor(actor: Any) -> str:
    if isinstance(actor, dict):
        actor = actor.get("email") or actor.get("user_id")
    value = str(actor or "").strip()
    if not value:
        raise ValueError("audit_event needs an actor")
    return value[:MAX_ID]


def _json(value: Any) -> Jsonb | None:
    return None if value is None else Jsonb(value, dumps=_dumps)


def audit_event(actor: Any, action: str, entity_type: str, entity_id: Any, before: Any = None, after: Any = None,
                request_id: str | None = None, *, cur: Any = None, table: str | None = None, source: str | None = None) -> None:
    """Append one audit row. ``actor`` is an email or the dict from ``identity.current_user``."""
    if not action or not entity_type:
        raise ValueError("audit_event needs an action and an entity_type")
    # source: ui (default, a signed-in user) | api | sync | job. System actors ("system:…") default to job.
    src = source or ("job" if str(_actor(actor)).startswith("system:") else "ui")
    stmt = sql.SQL(
        "INSERT INTO {} (actor, action, entity_type, entity_id, before, after, request_id, source)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
    ).format(table_ref(table))
    params = (_actor(actor), action[:MAX_ID], entity_type[:MAX_ID], None if entity_id is None else str(entity_id)[:MAX_ID],
              _json(before), _json(after), (request_id or None) and str(request_id)[:MAX_ID], src[:20])
    if cur is not None:
        cur.execute(stmt, params)
        return
    with db.transaction() as own:
        own.execute(stmt, params)
    log.debug("audit %s %s/%s by %s", action, entity_type, entity_id, params[0])
