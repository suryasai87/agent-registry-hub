"""Collector tests run against the Docker Postgres (TEST_DATABASE_URL) in ONE scratch schema per session with every
migration applied. Each test starts from empty registry tables (the append-only audit log is left alone)."""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import config, db, migrate  # noqa: E402
from core.lakebase import Lakebase  # noqa: E402

import fake_workspace  # noqa: E402

KEEP = ("schema_migrations", "policy_requirement", "audit_log")
CAPTURE_TIME = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)  # when live_shapes.json was captured


@pytest.fixture(scope="session")
def registry_lb(pg_url):
    schema = f"arh_collectors_{uuid.uuid4().hex[:8]}"
    lb = Lakebase(url=pg_url, schema=schema, connect_timeout=3)
    migrate.run(lb, schema=schema)
    yield lb
    lb.close()
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


@pytest.fixture
def registry(registry_lb, monkeypatch):
    """The registry schema, emptied, with core.db pointed at it."""
    monkeypatch.setattr(db, "lb", registry_lb)
    monkeypatch.setattr(config, "LAKEBASE_SCHEMA", registry_lb.schema)
    with registry_lb.connection() as conn:
        tables = [r[0] for r in conn.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE'",
            (registry_lb.schema,)).fetchall() if r[0] not in KEEP]
        conn.execute("TRUNCATE " + ", ".join(f'"{registry_lb.schema}"."{t}"' for t in tables) + " RESTART IDENTITY CASCADE")
    return registry_lb


@pytest.fixture
def ws():
    return fake_workspace.build()


@pytest.fixture
def ctx_factory(ws):
    def make(days: int = 30, workspace=None):
        ctx = fake_workspace.FakeContext(workspace or ws, days=days)
        ctx.now = lambda: CAPTURE_TIME
        return ctx
    return make


@pytest.fixture
def q(registry):
    def query(sql, params=None):
        return db.query(sql, params)
    return query
