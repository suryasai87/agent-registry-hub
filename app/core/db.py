"""The app's shared Lakebase pool plus dict-row helpers.

Every helper looks up the module-level ``lb`` at call time, so tests (or a future multi-branch setup) can swap
``db.lb`` for another ``Lakebase`` instance and every module follows.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from core.lakebase import Lakebase

lb = Lakebase()


def query(sql: str, params: Any = None) -> list[dict]:
    """Rows as dicts (empty list for statements that return no rows)."""
    return lb.query(sql, params)


def query_one(sql: str, params: Any = None) -> dict | None:
    rows = lb.query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Any = None) -> int:
    """Run one statement in its own transaction; returns the affected row count."""
    return lb.execute(sql, params)


@contextmanager
def transaction() -> Iterator[psycopg.Cursor[dict]]:
    """A dict-row cursor inside one transaction: commits when the block succeeds, rolls back when it raises.

    Pass the cursor to ``audit.audit_event(..., cur=cur)`` so a change and its audit row commit atomically.
    """
    with lb.connection() as conn, conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
        yield cur
