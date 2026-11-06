"""Shared fixtures. Postgres-backed tests use TEST_DATABASE_URL (a local Docker Postgres, see README) and skip
cleanly when it is unset or unreachable; everything else runs without any external service."""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

import psycopg  # noqa: E402

from core import db, tiers  # noqa: E402
from core.lakebase import Lakebase  # noqa: E402

UNREACHABLE_URL = "postgresql://postgres@127.0.0.1:1/postgres"


@pytest.fixture(autouse=True)
def _fresh_cache():
    tiers.invalidate()
    yield
    tiers.invalidate()


@pytest.fixture(scope="session")
def pg_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL is not set (start the Docker Postgres from the README)")
    try:
        with psycopg.connect(url, connect_timeout=3) as conn:
            conn.execute("SELECT 1")
    except psycopg.Error as e:
        pytest.skip(f"TEST_DATABASE_URL is unreachable: {type(e).__name__}")
    return url


@pytest.fixture
def scratch_schema(pg_url):
    """A unique, empty schema name, dropped (with everything in it) after the test."""
    name = f"arh_test_{uuid.uuid4().hex[:10]}"
    yield name
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA IF EXISTS "{name}" CASCADE')


@pytest.fixture
def pg_lb(pg_url, scratch_schema):
    """A Lakebase manager in LAKEBASE_URL mode against the Docker Postgres, with the scratch schema created."""
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{scratch_schema}"')
    lb = Lakebase(url=pg_url, schema=scratch_schema, connect_timeout=3)
    yield lb
    lb.close()


@pytest.fixture
def use_lb(monkeypatch):
    """Point the app's shared pool (core.db.lb) at another Lakebase instance for one test."""
    def _use(lb):
        monkeypatch.setattr(db, "lb", lb)
        return lb
    return _use


@pytest.fixture
def unreachable_lb():
    lb = Lakebase(url=UNREACHABLE_URL, connect_timeout=1)
    yield lb
    lb.close()
