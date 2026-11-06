"""Unity Catalog lineage readiness: read-only privilege checks per publishing identity, grant SQL, TTL cache, and the
sync step that skips (without failing) while publishing is blocked.

``FakeWorkspace`` answers the read-only UC calls with the shapes the live metastore returned on 2026-10-28
(``effective-permissions/{metastore,table}``, ``current-metastore-assignment``, ``metastore_summary``, SCIM ``Me``,
``jobs/get``, ``external-metadata?page_size=1``). It fails the test on any call that is not a GET.
"""
from __future__ import annotations

import time

import pytest
from databricks.sdk.errors import InternalError, NotFound, PermissionDenied
from fastapi.testclient import TestClient

from core import config, db, migrate
from registry import authz, demo_seed, settings, uc_grants, uc_lineage, uc_readiness

ADMIN = "admin@example.com"
SP = "cd960439-5173-4ef4-8f1d-1cefe69d5435"
JOB_OWNER = "deployer@example.com"
MS = "c0da88f1-c020-4992-b8c9-c828e556889d"
EFF = uc_readiness.EFFECTIVE_PATH


def assignment(principal: str, *privs: str, inherited: tuple[str, str] | None = None) -> dict:
    return {"principal": principal, "privileges": [
        {"privilege": p, **({"inherited_from_type": inherited[0], "inherited_from_name": inherited[1]} if inherited else {})} for p in privs]}


class FakeWorkspace:
    """``w.api_client.do`` for the readiness calls. ``effective[(securable, name, principal)]`` is a list of assignments
    or an exception; anything not listed answers the "account users: READ_METADATA" default the live metastore gave."""

    def __init__(self, me: str = SP, groups: tuple[str, ...] = (), owner: str = "metastore_admins"):
        self.api_client = self
        self.calls: list[tuple[str, str, dict | None]] = []
        self.me_name, self.groups, self.ms_owner = me, list(groups), owner
        self.effective: dict[tuple[str, str, str], object] = {}
        self.table_owner: dict[str, str] = {}
        self.missing_tables: set[str] = set()
        self.lineage_error: Exception | None = None
        self.job = {"job_id": 7, "run_as_user_name": JOB_OWNER, "settings": {"name": "agent-registry-hub-sync-agent-registry-hub"}}
        self.fail: Exception | None = None   # every call raises this (an outage)

    def grant(self, securable: str, name: str, principal: str, *assignments: dict) -> None:
        self.effective[(securable, name, principal)] = list(assignments)

    def do(self, method, path, query=None, body=None, headers=None):
        self.calls.append((method, path, query))
        assert method == "GET", f"readiness must be read-only, got {method} {path}"
        if self.fail is not None:
            raise self.fail
        if path == uc_readiness.ASSIGNMENT_PATH:
            return {"workspace_id": 1, "metastore_id": MS, "default_catalog_name": "main"}
        if path == uc_readiness.SUMMARY_PATH:
            return {"metastore_id": MS, "name": "metastore_aws_us_east_1", "owner": self.ms_owner}
        if path == uc_readiness.ME_PATH:
            return {"userName": self.me_name, "groups": [{"display": g, "value": str(i)} for i, g in enumerate(self.groups)]}
        if path == uc_readiness.JOBS_GET_PATH:
            assert query == {"job_id": "7"}
            return self.job
        if path == uc_lineage.EM_PATH:
            assert query == {"page_size": 1}
            if self.lineage_error is not None:
                raise self.lineage_error
            return {"external_metadata": []}
        if path.startswith(EFF + "/"):
            securable, name = path[len(EFF) + 1:].split("/", 1)
            if securable == "table" and name in self.missing_tables:
                raise NotFound(f"Table '{name}' does not exist.")
            value = self.effective.get((securable, name, query["principal"]),
                                       [assignment("account users", "READ_METADATA", inherited=("METASTORE", "metastore_aws_us_east_1"))])
            if isinstance(value, Exception):
                raise value
            return {"privilege_assignments": value}
        if path.startswith(uc_readiness.TABLES_PATH + "/"):
            name = path[len(uc_readiness.TABLES_PATH) + 1:]
            return {"full_name": name, "owner": self.table_owner.get(name, "data-team")}
        raise AssertionError(f"unexpected call {method} {path}")

    def count(self, prefix: str) -> int:
        return sum(1 for _, p, _ in self.calls if p.startswith(prefix))


@pytest.fixture(autouse=True)
def _fresh_readiness_cache():
    uc_readiness.invalidate()
    yield
    uc_readiness.invalidate()


def meta(w) -> dict:
    return uc_readiness.metastore_info(w)


def check(w, principal=SP, tables=("c.s.t1",), **kw) -> dict:
    kw.setdefault("own", w)
    if "meta" not in kw:
        kw["meta"] = meta(w)
    return uc_readiness.check_identity(path="app", label="App service principal", applies_to="UI", principal=principal, lookup=w,
                                       tables=list(tables) if tables is not None else None, **kw)


def by_id(result: dict) -> dict:
    return {c["id"]: c for c in result["checks"]}


# ====================================================================== unit: the checks
def test_ready_when_every_privilege_is_held_and_nothing_is_written():
    w = FakeWorkspace()
    w.grant("metastore", MS, SP, assignment(SP, "CREATE_EXTERNAL_METADATA"))
    w.grant("table", "c.s.t1", SP, assignment("account users", "ALL_PRIVILEGES", inherited=("CATALOG", "c")))
    w.grant("table", "c.s.t2", SP, assignment(SP, "MODIFY", inherited=("SCHEMA", "c.s")))
    r = check(w, tables=["c.s.t1", "c.s.t2"])
    assert r["status"] == "ready" and r["reason"] is None and r["remediation_sql"] == []
    c = by_id(r)
    assert c["metastore_privilege"]["status"] == "ok" and "granted directly" in c["metastore_privilege"]["detail"]
    assert c["table_modify"]["status"] == "ok" and c["table_modify"]["checked"] == 2 and c["table_modify"]["unchecked"] == 0
    assert "inherited from catalog c" in c["table_modify"]["tables"][0]["detail"]
    assert c["api_reachable"]["status"] == "ok"
    assert {m for m, _, _ in w.calls} == {"GET"}
    assert r["principal_kind"] == "service_principal"


def test_blocked_without_create_external_metadata_names_the_grant_and_who_runs_it():
    w = FakeWorkspace()
    w.grant("table", "c.s.t1", SP, assignment(SP, "MODIFY"))
    r = check(w)
    assert r["status"] == "blocked"
    assert "does not hold CREATE EXTERNAL METADATA on metastore metastore_aws_us_east_1" in r["reason"]
    ms = by_id(r)["metastore_privilege"]
    assert ms["status"] == "missing" and ms["blocking"]
    assert ms["remediation"] == {"sql": [f"GRANT CREATE EXTERNAL METADATA ON METASTORE TO `{SP}`;"],
                                 "run_by": "A metastore admin (a member of the metastore owner metastore_admins)"}
    assert r["remediation_sql"] == [f"GRANT CREATE EXTERNAL METADATA ON METASTORE TO `{SP}`;"]
    # a metastore admin holds it implicitly: owner group membership (SCIM Me) counts
    admin = FakeWorkspace(groups=("users", "metastore_admins"))
    admin.grant("table", "c.s.t1", SP, assignment(SP, "MODIFY"))
    assert check(admin, groups=["users", "metastore_admins"])["status"] == "ready"


def test_unknown_when_an_api_errors_never_raises():
    w = FakeWorkspace()
    w.effective[("metastore", MS, SP)] = InternalError("upstream timeout")
    r = check(w)
    assert r["status"] == "unknown" and "upstream timeout" in r["reason"]
    assert by_id(r)["metastore_privilege"]["status"] == "unknown"
    # the metastore itself unreadable; the plan unavailable; the API answering 500: all inconclusive, none raise
    r2 = check(w, meta=None, meta_error="InternalError: boom", tables=None, tables_error="Lakebase: down")
    assert r2["status"] == "unknown"
    assert by_id(r2)["table_modify"]["status"] == "unknown" and "Lakebase: down" in by_id(r2)["table_modify"]["detail"]
    w3 = FakeWorkspace()
    w3.grant("metastore", MS, SP, assignment(SP, "CREATE_EXTERNAL_METADATA"))
    w3.grant("table", "c.s.t1", SP, assignment(SP, "MODIFY"))
    w3.lineage_error = InternalError("503 Service Unavailable")
    assert check(w3)["status"] == "unknown"
    # a total outage of the workspace API
    down = FakeWorkspace()
    down.fail = InternalError("connection reset")
    r4 = check(down, meta=None, meta_error="connection reset")
    assert r4["status"] == "unknown" and all(c["status"] == "unknown" for c in r4["checks"])


def test_missing_modify_is_partial_with_per_table_grants_and_owners_count():
    w = FakeWorkspace()
    w.grant("metastore", MS, SP, assignment(SP, "CREATE_EXTERNAL_METADATA"))
    w.grant("table", "c.s.ok", SP, assignment(SP, "MODIFY"))
    w.table_owner["c.s.mine"] = SP           # ownership is implicit: effective-permissions does not list it
    w.missing_tables.add("c.s.gone")
    r = check(w, tables=["c.s.gone", "c.s.mine", "c.s.no", "c.s.ok"])
    assert r["status"] == "partial"
    t = by_id(r)["table_modify"]
    rows = {row["table"]: row for row in t["tables"]}
    assert rows["c.s.ok"]["status"] == "ok" and rows["c.s.mine"]["status"] == "ok" and rows["c.s.gone"]["status"] == "not_found"
    assert rows["c.s.no"] == {"table": "c.s.no", "status": "missing", "owner": "data-team",
                              "sql": f"GRANT MODIFY ON TABLE `c`.`s`.`no` TO `{SP}`;", "detail": "No MODIFY; the owner is data-team"}
    assert t["status"] == "missing" and not t["blocking"] and t["remediation"]["sql"] == [rows["c.s.no"]["sql"]]
    assert "owner" in t["remediation"]["run_by"]
    # only tables that are not found: a warning, still partial (those relationships fail), no grant to suggest
    w.grant("table", "c.s.no", SP, assignment(SP, "MODIFY"))
    r2 = check(w, tables=["c.s.gone", "c.s.no"])
    assert r2["status"] == "partial" and by_id(r2)["table_modify"]["status"] == "warning" and r2["remediation_sql"] == []


def test_a_forwarded_token_without_the_unity_catalog_scope_blocks_with_the_fix():
    w = FakeWorkspace(me=ADMIN)
    w.grant("metastore", MS, ADMIN, assignment(ADMIN, "CREATE_EXTERNAL_METADATA"))
    w.grant("table", "c.s.t1", ADMIN, assignment(ADMIN, "MODIFY"))
    w.lineage_error = PermissionDenied("Provided OAuth token does not have required scopes: unity-catalog")
    r = check(w, principal=ADMIN)
    api = by_id(r)["api_reachable"]
    assert r["status"] == "blocked" and api["status"] == "missing"
    assert "unity-catalog user authorization scope" in api["remediation"]["note"] and "owner" in api["remediation"]["run_by"]
    w.lineage_error = NotFound("ENDPOINT_NOT_FOUND: No API found for 'GET /lineage-tracking/external-metadata'")
    assert "not available in this workspace" in by_id(check(w, principal=ADMIN))["api_reachable"]["detail"]


def test_remediation_sql_quotes_principals_and_table_names():
    assert uc_grants.grant_metastore_sql(SP) == f"GRANT CREATE EXTERNAL METADATA ON METASTORE TO `{SP}`;"
    assert uc_grants.grant_metastore_sql("jo.park@example.com") == "GRANT CREATE EXTERNAL METADATA ON METASTORE TO `jo.park@example.com`;"
    assert uc_grants.grant_table_sql("main.abbvie_430B_fraud.master_fraud_alerts", SP) == \
        f"GRANT MODIFY ON TABLE `main`.`abbvie_430B_fraud`.`master_fraud_alerts` TO `{SP}`;"
    assert uc_grants.quote_table("my-cat.default.select") == "`my-cat`.`default`.`select`"
    assert uc_grants.quote_ident("we`ird") == "`we``ird`"
    assert uc_grants.grant_table_sql("c.s.t`x", "grp`1") == "GRANT MODIFY ON TABLE `c`.`s`.`t``x` TO `grp``1`;"
    assert uc_grants.grant_schema_sql("c.s", SP) == f"GRANT MODIFY ON SCHEMA `c`.`s` TO `{SP}`;"
    assert [uc_grants.principal_kind(x) for x in (SP, ADMIN, "data-team", None)] == ["service_principal", "user", "group", "unknown"]
    assert uc_readiness.grant_table_sql is uc_grants.grant_table_sql


def test_table_check_is_capped_sampled_evenly_and_reports_the_rest():
    w = FakeWorkspace()
    w.grant("metastore", MS, SP, assignment(SP, "CREATE_EXTERNAL_METADATA"))
    tables = [f"cat{i:02d}.s.t" for i in range(50)]
    for t in tables:
        w.grant("table", t, SP, assignment(SP, "MODIFY"))
    r = check(w, tables=tables, max_tables=5)
    t = by_id(r)["table_modify"]
    assert t["checked"] == 5 and t["unchecked"] == 45 and t["total"] == 50
    assert [row["table"] for row in t["tables"]] == ["cat00.s.t", "cat12.s.t", "cat24.s.t", "cat37.s.t", "cat49.s.t"]
    assert w.count(f"{EFF}/table/") == 5
    assert "45 not checked" in t["detail"] and "uc_lineage_grants.py" in t["remediation"]["note"]
    assert r["status"] == "ready"  # unchecked tables are reported, not guessed
    assert uc_grants.even_sample([1, 2, 3], 5) == [1, 2, 3] and uc_grants.even_sample([1, 2, 3], 0) == []


# ====================================================================== the endpoint
@pytest.fixture
def client(pg_lb, use_lb, monkeypatch):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({ADMIN}))
    monkeypatch.delenv("DATABRICKS_CLIENT_ID", raising=False)
    monkeypatch.setenv("PROVISIONING_MODE", "record_only")
    monkeypatch.delenv("SYNC_JOB_ID", raising=False)
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
        demo_seed.seed_extended(cur)
    authz.invalidate_roles()
    import app as application
    return TestClient(application.app)


@pytest.fixture
def platform(monkeypatch):
    """Platform mode with the app SP's fake client and a fake for a forwarded user token."""
    sp, obo = FakeWorkspace(me=SP), FakeWorkspace(me=ADMIN)
    monkeypatch.setenv("PROVISIONING_MODE", "platform")
    monkeypatch.setenv("DATABRICKS_CLIENT_ID", SP)
    monkeypatch.setenv("SYNC_JOB_ID", "7")
    monkeypatch.setattr(uc_readiness, "_lookup_client", lambda: sp)
    tokens: list[str] = []
    monkeypatch.setattr(uc_readiness, "_obo_client", lambda token: (tokens.append(token), obo)[1])
    return sp, obo, tokens


def get(client, who=ADMIN, token: str | None = None, refresh: bool = False):
    headers = {"x-forwarded-email": who, **({"x-forwarded-access-token": token} if token else {})}
    return client.get("/api/lineage/uc-publish/readiness" + ("?refresh=true" if refresh else ""), headers=headers)


def test_endpoint_is_for_governors_and_not_required_in_record_only(client, monkeypatch):
    monkeypatch.setattr(uc_readiness, "_lookup_client", lambda: (_ for _ in ()).throw(AssertionError("record_only must not call UC")))
    assert get(client, "jo.park@example.com").status_code == 403
    r = get(client, ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live" and body["data"]["status"] == "not_required" and body["data"]["enforced"] is False


def test_endpoint_checks_the_app_sp_and_the_sync_identity(client, platform):
    sp, obo, tokens = platform
    r = get(client, ADMIN)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["status"] == "blocked" and d["active_path"] == "app" and d["enforced"] and not d["obo_token_forwarded"]
    paths = {p["path"]: p for p in d["paths"]}
    assert set(paths) == {"app", "sync"} and paths["app"]["principal"] == SP and paths["sync"]["principal"] == JOB_OWNER
    assert d["remediation_sql"][0] == f"GRANT CREATE EXTERNAL METADATA ON METASTORE TO `{SP}`;"
    assert d["tables"]["total"] == len(plan_tables()) > 0
    assert by_id(paths["sync"])["api_reachable"]["status"] == "skipped"
    assert d["metastore"]["metastore_id"] == MS and not tokens


def plan_tables() -> list[str]:
    with db.transaction() as cur:
        return uc_lineage.plan(cur, mode="platform")["tables"]


def test_endpoint_uses_the_forwarded_token_for_the_obo_path(client, platform):
    sp, obo, tokens = platform
    sp.grant("metastore", MS, ADMIN, assignment(ADMIN, "CREATE_EXTERNAL_METADATA"))
    obo.lineage_error = PermissionDenied("Provided OAuth token does not have required scopes: unity-catalog")
    d = get(client, ADMIN, token="user-token-123").json()["data"]
    assert d["obo_token_forwarded"] and d["active_path"] == "obo" and tokens == ["user-token-123"]
    paths = {p["path"]: p for p in d["paths"]}
    assert [p["path"] for p in d["paths"]] == ["obo", "app", "sync"]
    o = paths["obo"]
    assert o["principal"] == ADMIN and o["principal_kind"] == "user" and o["label"] == "You (on-behalf-of)"
    assert by_id(o)["metastore_privilege"]["status"] == "ok"          # looked up with the app's client, for the admin
    assert sp.count(f"{EFF}/metastore/") >= 2                          # admin + app SP lookups ran on the app's client
    assert obo.count(uc_lineage.EM_PATH) == 1 and sp.count(uc_lineage.EM_PATH) == 1   # each path probes with its own token
    assert obo.count(EFF) == 0                                         # the forwarded token is not used for lookups
    assert d["status"] == "blocked" and "does not have required scopes" in d["reason"]
    assert "user-token-123" not in str(d)


def test_readiness_is_cached_for_the_ttl_and_recheck_bypasses_it(client, platform, monkeypatch):
    sp, _, _ = platform
    first = get(client).json()["data"]
    n = len(sp.calls)
    second = get(client).json()["data"]
    assert first["cached"] is False and second["cached"] is True and len(sp.calls) == n
    sp.grant("metastore", MS, SP, assignment(SP, "CREATE_EXTERNAL_METADATA"))
    assert get(client).json()["data"]["paths"][0]["status"] == "blocked"     # still the cached answer
    fresh = get(client, refresh=True).json()["data"]
    assert fresh["cached"] is False and len(sp.calls) > n and by_id(fresh["paths"][0])["metastore_privilege"]["status"] == "ok"
    # expiry: a short TTL
    monkeypatch.setattr(uc_readiness, "TTL", 0.05)
    get(client, refresh=True)
    time.sleep(0.1)
    assert get(client).json()["data"]["cached"] is False
    # an inconclusive answer is kept for UNKNOWN_TTL, not TTL
    monkeypatch.setattr(uc_readiness, "TTL", 100.0)
    monkeypatch.setattr(uc_readiness, "UNKNOWN_TTL", 0.05)
    sp.fail = InternalError("workspace unavailable")
    down = get(client, refresh=True)
    assert down.status_code == 200 and down.json()["data"]["status"] == "unknown"
    assert get(client).json()["data"]["cached"] is True
    time.sleep(0.1)
    assert get(client).json()["data"]["cached"] is False


# ====================================================================== the sync step
def _turn_on_sync(client):
    r = client.put("/api/lineage/uc-publish/settings", json={"publish_in_sync": True}, headers={"x-forwarded-email": ADMIN})
    assert r.status_code == 200, r.text


def test_sync_step_skips_and_records_when_blocked_without_raising(client, monkeypatch):
    _turn_on_sync(client)
    monkeypatch.setenv("PROVISIONING_MODE", "platform")
    job = FakeWorkspace(me=JOB_OWNER)
    res = uc_lineage.sync_step(lambda: job, triggered_by="schedule")
    assert res["skipped"].startswith("readiness blocked:") and "CREATE EXTERNAL METADATA" in res["skipped"]
    assert res["readiness"]["status"] == "blocked" and res["readiness"]["principal"] == JOB_OWNER
    assert not db.query("SELECT 1 FROM uc_lineage_run") and not db.query("SELECT 1 FROM uc_lineage_object")
    with db.transaction() as cur:
        row = settings.get(cur, uc_readiness.SYNC_KEY)
    assert row["skipped"] is True and row["status"] == "blocked" and row["principal"] == JOB_OWNER
    audit = db.query("SELECT actor, source, after FROM audit_log WHERE action = 'lineage.uc_publish_skipped'")
    assert len(audit) == 1 and audit[0]["actor"] == "system:sync" and audit[0]["source"] == "job"
    assert audit[0]["after"]["status"] == "blocked"
    # the next hourly run with the same block: status row refreshed, no second audit row
    again = uc_lineage.sync_step(lambda: job, triggered_by="schedule")
    assert again["skipped"] == res["skipped"]
    assert db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'lineage.uc_publish_skipped'")[0]["n"] == 1
    # an outage makes it unknown: still skipped, still no exception, and it is a new reason
    job.fail = InternalError("workspace unavailable")
    down = uc_lineage.sync_step(lambda: job)
    assert down["skipped"].startswith("readiness unknown:")
    assert db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'lineage.uc_publish_skipped'")[0]["n"] == 2
    # a client that cannot even be built: an error result, never a raise
    boom = uc_lineage.sync_step(lambda: (_ for _ in ()).throw(RuntimeError("no credentials")))
    assert boom == {"error": "RuntimeError: no credentials"}
    assert not db.query("SELECT 1 FROM uc_lineage_run")


def test_sync_step_publishes_when_ready(client, monkeypatch):
    from test_uc_lineage import FakeUnityCatalog

    _turn_on_sync(client)
    monkeypatch.setenv("PROVISIONING_MODE", "platform")
    uc = FakeUnityCatalog()

    class ReadyJob(FakeWorkspace):
        def do(self, method, path, query=None, body=None, headers=None):
            if path.startswith((uc_lineage.EM_PATH, uc_lineage.EL_PATH)) and not (method == "GET" and query == {"page_size": 1}):
                return uc.do(method, path, query=query, body=body)
            return super().do(method, path, query=query, body=body)

    job = ReadyJob(me=JOB_OWNER, groups=("metastore_admins",))   # a metastore admin: every privilege is implicit
    for t in plan_tables():
        job.grant("table", t, JOB_OWNER, assignment(JOB_OWNER, "MODIFY"))
    res = uc_lineage.sync_step(lambda: job, triggered_by="schedule")
    assert res["readiness"] == "ready" and res["status"] == "succeeded" and res["mode"] == "platform", res
    run = db.query("SELECT triggered_by, acting_as FROM uc_lineage_run")[0]
    assert run["triggered_by"] == "system:sync" and run["acting_as"] == f"sync identity {JOB_OWNER} (schedule)"
    assert uc.objects and uc.rels
    with db.transaction() as cur:
        assert settings.get(cur, uc_readiness.SYNC_KEY)["skipped"] is False
    assert not db.query("SELECT 1 FROM audit_log WHERE action = 'lineage.uc_publish_skipped'")
