import time

import psycopg
import pytest

from core import lakebase as lbmod
from core.lakebase import MAX_LIFETIME, Lakebase, LakebaseNotConfigured, LakebaseUnavailable


def test_dsn_mode_connects_and_returns_dict_rows(pg_lb, scratch_schema):
    assert pg_lb.mode == "dsn"
    assert isinstance(pg_lb.ping(), float)
    rows = pg_lb.query("SELECT %s::int AS n, %s AS label", (7, "seven"))
    assert rows == [{"n": 7, "label": "seven"}]
    assert pg_lb.query("SHOW search_path")[0]["search_path"].startswith(scratch_schema)
    assert pg_lb.execute(f'CREATE TABLE "{scratch_schema}".t (id int)') == -1
    assert pg_lb.execute(f'INSERT INTO "{scratch_schema}".t VALUES (1), (2)') == 2
    assert pg_lb.query("SELECT count(*) AS n FROM t") == [{"n": 2}]  # search_path resolves the schema
    assert pg_lb.query(f'DELETE FROM "{scratch_schema}".t WHERE id = 99') == []  # no result set


def test_pool_uses_max_lifetime_below_the_token_ttl(pg_lb):
    assert MAX_LIFETIME == 3000
    pg_lb.ping()
    assert pg_lb._pool.max_lifetime == 3000
    assert pg_lb._pool.max_size == pg_lb.pool_max


def test_describe_never_exposes_the_password(pg_url):
    lb = Lakebase(url=pg_url)
    info = lb.describe()
    assert info["mode"] == "dsn" and info["host"] and "password" not in str(info).lower()
    assert "postgres:postgres" not in str(info)


def test_unreachable_database_fails_fast_then_backs_off(unreachable_lb):
    started = time.perf_counter()
    with pytest.raises(LakebaseUnavailable, match="OperationalError"):
        unreachable_lb.ping()
    assert time.perf_counter() - started < 5
    assert unreachable_lb.last_error.startswith("OperationalError")
    started = time.perf_counter()
    with pytest.raises(LakebaseUnavailable):
        unreachable_lb.ping()  # inside the back-off window: no new connection attempt
    assert time.perf_counter() - started < 0.2


def test_unconfigured():
    lb = Lakebase(url="", endpoint="")
    assert lb.mode == "unconfigured" and not lb.configured
    with pytest.raises(LakebaseNotConfigured):
        lb.query("SELECT 1")


def test_pg_user_precedence(monkeypatch):
    monkeypatch.setenv("PGUSER", "pinned_role")
    monkeypatch.setenv("DATABRICKS_CLIENT_ID", "sp-uuid")
    assert lbmod.pg_user() == "pinned_role"
    monkeypatch.delenv("PGUSER")
    assert lbmod.pg_user() == "sp-uuid"
    monkeypatch.delenv("DATABRICKS_CLIENT_ID")

    class Me:
        user_name = "jane.doe@example.com"

    class FakeW:
        class current_user:  # noqa: N801 - mirrors the SDK attribute
            @staticmethod
            def me():
                return Me()

    monkeypatch.setattr(lbmod, "workspace_client", lambda: FakeW())
    assert lbmod.pg_user() == "jane.doe@example.com"


def test_oauth_mode_mints_a_credential_and_keeps_it_out_of_the_conninfo(monkeypatch):
    calls = []

    class FakeApi:
        def do(self, method, path, body=None, headers=None):
            calls.append((method, path, body))
            if path == "/api/2.0/postgres/credentials":
                return {"token": "SECRET-TOKEN-VALUE", "expiration_time": "2030-01-01T00:00:00Z"}
            return {"status": {"hosts": {"host": "instance-abc.database.cloud.databricks.com"}}}

    class FakeW:
        api_client = FakeApi()

    monkeypatch.setattr(lbmod, "workspace_client", lambda: FakeW())
    monkeypatch.setenv("DATABRICKS_CLIENT_ID", "app-sp-uuid")
    monkeypatch.delenv("PGUSER", raising=False)
    monkeypatch.delenv("LAKEBASE_HOST", raising=False)
    monkeypatch.delenv("PGHOST", raising=False)
    lb = Lakebase(url="", endpoint="projects/registry/branches/production/endpoints/primary", database="databricks_postgres", schema="registry")
    assert lb.mode == "oauth"
    conninfo, kwargs, expires_at = lb._connect_params()
    assert calls[0] == ("POST", "/api/2.0/postgres/credentials", {"endpoint": "projects/registry/branches/production/endpoints/primary"})
    assert calls[1][:2] == ("GET", "/api/2.0/postgres/projects/registry/branches/production/endpoints/primary")
    assert "SECRET-TOKEN-VALUE" not in conninfo
    assert kwargs["password"] == "SECRET-TOKEN-VALUE"
    parts = psycopg.conninfo.conninfo_to_dict(conninfo)
    assert parts["host"] == "instance-abc.database.cloud.databricks.com"
    assert parts["user"] == "app-sp-uuid" and parts["sslmode"] == "require" and parts["dbname"] == "databricks_postgres"
    assert kwargs["options"] == "-c search_path=registry,public"
    assert expires_at == pytest.approx(1893456000.0)
    assert "SECRET-TOKEN-VALUE" not in str(lb.describe())


def test_pool_is_rebuilt_before_the_credential_expires(pg_url, scratch_schema, monkeypatch):
    lb = Lakebase(url=pg_url, schema="public", connect_timeout=3)
    try:
        lb.ping()
        first = lb._pool
        lb._expires_at = time.time() + lbmod.REFRESH_CUSHION - 1  # pretend the token expires within the cushion
        lb.ping()
        assert lb._pool is not first
    finally:
        lb.close()
