"""Platform Watch: feeds → classification → probes → candidates → branch regression → decisions → apply.

Feed parsing runs against REAL feed snapshots (tests/fixtures/feeds, fetched 2026-10-26). The regression uses
LocalBranches (a schema copy in the Docker Postgres). No workspace is touched.
"""
from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from core import config, db, migrate
from registry import authz, demo_seed, platform_watch as pw, regression

FEEDS = Path(__file__).parent / "fixtures" / "feeds"
ROOT = Path(__file__).resolve().parents[1]
ADMIN = "admin@example.com"


def test_parse_real_databricks_rss_and_mlflow_atom():
    rss = pw.parse_feed((FEEDS / "databricks_aws_feed.xml").read_bytes(), "rss")
    assert len(rss) == 60 and all(i["guid"] and i["title"] and i["published_at"] for i in rss)
    assert all("<" not in i["summary"] for i in rss)  # HTML stripped
    atom = pw.parse_feed((FEEDS / "mlflow_releases.atom").read_bytes(), "atom")
    assert len(atom) == 4 and any(i["title"].startswith("MLflow 3.17") for i in atom)
    assert atom[0]["link"].startswith("https://github.com/mlflow/mlflow/releases")


def test_classify_scores_registry_relevant_items():
    rss = pw.parse_feed((FEEDS / "databricks_aws_feed.xml").read_bytes(), "rss")
    jail = next(i for i in rss if "jailbreak" in i["title"].lower())
    c = pw.classify(jail, "databricks_release_notes")
    assert "service_policies" in c["matched_capabilities"] and c["relevance"] >= 35 and c["lifecycle_hint"] == "beta"
    cache = next(i for i in rss if "DataFrame caching" in i["title"])
    assert pw.classify(cache, "databricks_release_notes")["relevance"] < 35  # not about the registry's domain
    dep = pw.classify({"title": "Supervisor Agent APIs are deprecated", "summary": "The legacy endpoints will be removed."}, "databricks_release_notes")
    assert dep["breaking_hint"] and dep["lifecycle_hint"] == "deprecation" and "supervisor_agents_v21" in dep["matched_capabilities"]


@pytest.mark.parametrize("status,body,expected", [
    (200, "{}", "available"),
    (404, '{"error_code":"ENDPOINT_NOT_FOUND","message":"No API found for GET /knowledge-assistants"}', "unavailable"),
    (404, '{"error_code":"NOT_FOUND","message":"The Genie Agent API is not available in this workspace."}', "unavailable"),
    (403, '{"error_code":"PERMISSION_DENIED"}', "no_access"),
    (400, '{"error_code":"INVALID_PARAMETER_VALUE","message":"parent is required"}', "available"),
    (503, "upstream", "error"),
])
def test_probe_classification(status, body, expected):
    assert pw.classify_probe(status, body) == expected


def test_analyze_migration_breaking_rules():
    additive = pw.analyze_migration("CREATE TABLE IF NOT EXISTS {{schema}}.x (id int);\nALTER TABLE {{schema}}.x ADD COLUMN y text;")
    assert not additive["breaking"]
    destructive = pw.analyze_migration("-- breaking: renames asset.subtype\nALTER TABLE a RENAME COLUMN subtype TO kind;\nALTER TABLE a DROP COLUMN z;")
    assert destructive["breaking"] and {"renames asset.subtype", "drops a column", "renames a table or column"} <= set(destructive["reasons"])
    assert pw.analyze_migration("-- the word drop table in a comment is ignored\nSELECT 1;")["breaking"] is False


@pytest.fixture
def prod(pg_lb, use_lb, monkeypatch, pg_url):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({ADMIN}))
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
        pw.sync_catalog(cur)
        pw.record_running_version(cur, "0.2.0")
    authz.invalidate_roles()
    return pg_lb


def _require_superuser(url: str) -> None:
    """LocalBranches bulk-copies with session_replication_role=replica (superuser only). On a Lakebase branch
    the real LakebaseBranches provider is used instead, so these local-provider tests skip there."""
    import psycopg
    with psycopg.connect(url) as conn:
        if not conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone()[0]:
            pytest.skip("LocalBranches needs a Postgres superuser (local Docker only)")


def _staged(tmp_path: Path, version: str, extra_sql: str | None) -> Path:
    root = tmp_path / "staged"
    shutil.copytree(ROOT / "pipeline" / "migrations", root / "pipeline" / "migrations")
    (root / "VERSION").write_text(version)
    if extra_sql:
        (root / "pipeline" / "migrations" / "900_next.sql").write_text(extra_sql)
    return root


def test_fetch_and_detect_candidates(prod, tmp_path):
    files = {"https://docs.databricks.com/aws/en/feed.xml": "databricks_aws_feed.xml",
             "https://github.com/mlflow/mlflow/releases.atom": "mlflow_releases.atom",
             "https://github.com/databricks/databricks-sdk-py/releases.atom": "databricks_sdk_py_releases.atom",
             "https://github.com/databricks/cli/releases.atom": "databricks_cli_releases.atom"}
    staged = _staged(tmp_path, "0.3.0", "-- breaking: drops a demo column\nALTER TABLE {{schema}}.asset ADD COLUMN tmp_col text;\nALTER TABLE {{schema}}.asset DROP COLUMN tmp_col;\n")
    with db.transaction() as cur:
        res = pw.fetch_feeds(cur, fetch=lambda url: (FEEDS / files[url]).read_bytes())
        rss = pw.parse_feed((FEEDS / "databricks_aws_feed.xml").read_bytes(), "rss")
        distinct = len({(i["title"], i["published_at"]) for i in rss})  # one announcement can carry several guids
        assert distinct < 60 and res["databricks_release_notes"]["new"] == distinct and res["mlflow_releases"]["new"] == 4
        again = pw.fetch_feeds(cur, fetch=lambda url: (FEEDS / files[url]).read_bytes())
        assert again["databricks_release_notes"]["new"] == 0  # idempotent by guid
        changes = pw.probe_capabilities(cur, lambda m, path, body: (404, '{"error_code":"ENDPOINT_NOT_FOUND"}') if "agent-services" in path else (200, "{}"))
        assert changes["uc_agent_services"]["to"] == "unavailable" and changes["supervisor_agents_v21"]["to"] == "available"
        created = pw.detect_candidates(cur, staged_root=staged, staged_version="0.3.0")
        cur.execute("SELECT kind, title, breaking, breaking_reasons, migrations FROM update_candidate ORDER BY candidate_id")
        rows = cur.fetchall()
    assert created
    app = next(r for r in rows if r["kind"] == "app_release")
    assert app["breaking"] and any("drops" in r for r in app["breaking_reasons"]) and app["migrations"][-1]["version"] == "900_next"
    assert any(r["kind"] == "advisory" for r in rows)  # relevant release-note items
    assert db.query("SELECT count(*) AS n FROM notification WHERE recipient_email = %s AND kind = 'platform_update'", (ADMIN,))[0]["n"] >= 1


def test_redetecting_a_candidate_without_feed_items_keeps_an_empty_array(prod):
    """Every scheduled watch re-upserts open candidates. A capability advisory has no feed items, and merging two
    empty arrays with array_agg yields NULL, which the NOT NULL column rejected (all watch runs failed live)."""
    with db.transaction() as cur:
        first = pw._upsert_candidate(cur, kind="advisory", title="New API available here: RFA", capability_key="rfa_requests")
        assert first is not None
        assert pw._upsert_candidate(cur, kind="advisory", title="New API available here: RFA", capability_key="rfa_requests") is None
        assert pw._upsert_candidate(cur, kind="advisory", title="New API available here: RFA", capability_key="rfa_requests",
                                    feed_item_ids=[7, 3]) is None
        assert pw._upsert_candidate(cur, kind="advisory", title="New API available here: RFA", capability_key="rfa_requests",
                                    feed_item_ids=[3]) is None
        cur.execute("SELECT feed_item_ids FROM update_candidate WHERE candidate_id = %s", (first,))
        assert cur.fetchone()["feed_item_ids"] == [3, 7]


def test_branch_regression_passes_then_apply(prod, tmp_path, pg_url):
    _require_superuser(pg_url)
    staged = _staged(tmp_path, "0.3.0", "CREATE TABLE IF NOT EXISTS {{schema}}.release_marker (id int PRIMARY KEY);\n")
    with db.transaction() as cur:
        pw.detect_candidates(cur, staged_root=staged, staged_version="0.3.0")
        cid = cur.execute("SELECT candidate_id FROM update_candidate WHERE kind = 'app_release'").fetchone()["candidate_id"]
    rows_before = db.query("SELECT count(*) AS n FROM asset")[0]["n"]
    result = regression.check(prod, regression.LocalBranches(pg_url, prod.schema), cid, root=staged, schema=prod.schema, run_pytest=False)
    assert result["passed"], result["steps"]
    names = [s["name"] for s in result["steps"]]
    assert names[:4] == ["Create Lakebase branch", "Snapshot row counts", "Apply pending migrations on the branch", "Data preservation"]
    assert "Read-path smoke checks (live data copy)" in names and names[-1] == "Delete branch"
    # production is untouched by the regression
    assert db.query("SELECT to_regclass('release_marker') IS NULL AS absent")[0]["absent"]
    assert db.query("SELECT count(*) AS n FROM asset")[0]["n"] == rows_before
    cand = db.query("SELECT status, auto_apply, regression FROM update_candidate WHERE candidate_id = %s", (cid,))[0]
    assert cand["status"] == "passed" and cand["auto_apply"] and cand["regression"]["passed"]  # non-breaking + default policy
    applied = regression.apply(prod, cid, root=staged, schema=prod.schema)
    assert applied["ok"] is False  # app_release needs a workspace client to deploy, which is reported, never faked
    assert db.query("SELECT to_regclass('release_marker') IS NOT NULL AS present")[0]["present"]  # migrations did apply
    assert db.query("SELECT status FROM update_candidate WHERE candidate_id = %s", (cid,))[0]["status"] == "apply_failed"


def test_apply_deploy_config_matches_the_bundle():
    """The apply job deploys with the same command/env as databricks.yml's registry_app.config (the Apps API redacts
    env values, so the job can't copy them from the running deployment)."""
    yaml = pytest.importorskip("yaml")
    if not (ROOT / "databricks.yml").is_file():
        pytest.skip("databricks.yml is not part of this copy")
    bundle = yaml.safe_load((ROOT / "databricks.yml").read_text())
    app = next(t["resources"]["apps"]["registry_app"] for t in bundle["targets"].values() if "resources" in t)
    cfg = regression.app_deployment_config(endpoint="projects/p/branches/production/endpoints/primary", schema="registry",
                                           app_name="agent-registry-hub", registry_admins="a@x.com")
    assert cfg["command"] == app["config"]["command"]
    declared = app["config"]["env"]
    assert [e["name"] for e in cfg["env_vars"]] == [e["name"] for e in declared]
    for mine, theirs in zip(cfg["env_vars"], declared):
        assert ("value_from" in mine) == ("value_from" in theirs), mine["name"]
        if "value_from" in theirs:
            assert mine["value_from"] == theirs["value_from"]
        elif "${" not in str(theirs["value"]):
            assert mine["value"] == theirs["value"], mine["name"]
    assert {e["name"]: e["value"] for e in cfg["env_vars"] if "value" in e}["LAKEBASE_ENDPOINT"].endswith("/endpoints/primary")


def test_apply_app_release_deploys_with_config_and_verifies_health(prod, tmp_path, monkeypatch):
    staged = _staged(tmp_path, "0.3.0", None)

    class FakeApi:
        def __init__(self):
            self.calls = []

        def do(self, method, path, body=None):
            self.calls.append((method, path, body))
            if method == "POST":
                return {"deployment_id": "d1"}
            return {"status": {"state": "SUCCEEDED"}}

    w = type("W", (), {"api_client": FakeApi()})()
    checked = []
    monkeypatch.setattr(regression, "verify_app_health", lambda w_, name, dep_id=None: checked.append((name, dep_id)) or "healthy")

    def accepted_release():
        with db.transaction() as cur:
            cid = pw._upsert_candidate(cur, kind="app_release", title="0.3.0 staged", from_version="0.2.0", to_version="0.3.0")
            cur.execute("UPDATE update_candidate SET status = 'accepted' WHERE candidate_id = %s", (cid,))
        return cid

    # without the bundle's command/env the job refuses to deploy (no bare deployment that loses the Lakebase settings)
    cid = accepted_release()
    out = regression.apply(prod, cid, root=staged, schema=prod.schema, w=w, app_name="agent-registry-hub")
    assert out["ok"] is False and not [c for c in w.api_client.calls if c[0] == "POST"]
    assert "bundle run registry_app" in out["steps"][-1]["detail"]
    db.query("UPDATE update_candidate SET status = 'rejected' WHERE candidate_id = %s RETURNING 1", (cid,))

    cfg = regression.app_deployment_config(endpoint="projects/p/branches/production/endpoints/primary", schema=prod.schema,
                                           app_name="agent-registry-hub")
    cid = accepted_release()
    out = regression.apply(prod, cid, root=staged, schema=prod.schema, w=w, app_name="agent-registry-hub", app_config=cfg)
    assert out["ok"], out["steps"]
    post = next(c for c in w.api_client.calls if c[0] == "POST")
    assert post[2]["command"] == ["python", "app.py"] and post[2]["mode"] == "SNAPSHOT"
    assert {e["name"] for e in post[2]["env_vars"]} >= {"LAKEBASE_ENDPOINT", "LAKEBASE_SCHEMA", "WAREHOUSE_ID"}
    assert checked == [("agent-registry-hub", "d1")] and out["steps"][-1]["name"] == "Verify the deployed app reaches Lakebase"


def test_verify_app_health_judges_the_deployment_not_the_sign_in(monkeypatch):
    import requests

    class Resp:
        def __init__(self, code, body=None):
            self.status_code, self._body = code, body or {}
            self.headers = {"content-type": "application/json"}

        def json(self):
            return self._body

    def client(env_names, state="RUNNING", dep_id="d1"):
        app = {"url": "https://app.example", "app_status": {"state": state},
               "active_deployment": {"deployment_id": dep_id, "command": ["python", "app.py"],
                                     "env_vars": [{"name": n} for n in env_names]}}
        api = type("Api", (), {"do": lambda self, method, path, body=None: app})()
        return type("W", (), {"api_client": api, "config": type("C", (), {"authenticate": lambda self: {}})()})()

    full = ["LAKEBASE_ENDPOINT", "LAKEBASE_DATABASE", "LAKEBASE_SCHEMA", "WAREHOUSE_ID"]
    monkeypatch.setattr(regression.time, "sleep", lambda s: None)
    monkeypatch.setattr(requests, "get", lambda *a, **k: Resp(401))  # a job's runtime token at the Apps sign-in
    assert "needs a user sign-in: HTTP 401" in regression.verify_app_health(client(full), "app", "d1")
    monkeypatch.setattr(requests, "get", lambda *a, **k: Resp(200, {"version": "0.3.3", "lakebase": {"ok": True, "mode": "oauth"}}))
    assert "healthy: version 0.3.3" in regression.verify_app_health(client(full), "app", "d1")
    with pytest.raises(RuntimeError, match="no command/LAKEBASE_ENDPOINT"):  # the 0.3.0 incident: a bare deployment
        regression.verify_app_health(client(["WAREHOUSE_ID"]), "app", "d1")
    monkeypatch.setattr(requests, "get", lambda *a, **k: Resp(200, {"lakebase": {"ok": False, "mode": "unconfigured"}}))
    with pytest.raises(RuntimeError, match="not healthy"):
        regression.verify_app_health(client(full), "app", "d1", attempts=2)


def test_branch_regression_fails_on_data_loss(prod, tmp_path, pg_url):
    _require_superuser(pg_url)
    staged = _staged(tmp_path, "0.4.0", "DELETE FROM {{schema}}.usage_daily WHERE requests > 0;\n")
    with db.transaction() as cur:
        pw.detect_candidates(cur, staged_root=staged, staged_version="0.4.0")
        cid = cur.execute("SELECT candidate_id, breaking FROM update_candidate WHERE kind = 'app_release'").fetchone()["candidate_id"]
    result = regression.check(prod, regression.LocalBranches(pg_url, prod.schema), cid, root=staged, schema=prod.schema, run_pytest=False)
    assert not result["passed"]
    dp = next(s for s in result["steps"] if s["name"] == "Data preservation")
    assert dp["status"] == "failed" and "usage_daily" in dp["detail"]
    assert result["steps"][-1]["name"] == "Keep branch for debugging"
    cand = db.query("SELECT status, breaking, auto_apply FROM update_candidate WHERE candidate_id = %s", (cid,))[0]
    assert cand["status"] == "failed" and cand["breaking"] and not cand["auto_apply"]
    assert db.query("SELECT count(*) AS n FROM usage_daily")[0]["n"] > 0  # production data intact
    for s in db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'br_upd_%%'"):
        db.execute(f'DROP SCHEMA "{s["schema_name"]}" CASCADE')


def test_decisions_and_api(prod, tmp_path):
    import app as application
    client = TestClient(application.app)
    with db.transaction() as cur:
        pw.detect_candidates(cur, staged_root=_staged(tmp_path, "0.5.0", "-- breaking: test\nSELECT 1;\n"), staged_version="0.5.0")
        cid = cur.execute("SELECT candidate_id FROM update_candidate WHERE kind = 'app_release'").fetchone()["candidate_id"]
    h = {"x-forwarded-email": ADMIN}
    assert client.get("/api/platform-watch", headers={"x-forwarded-email": "viewer@example.com"}).status_code == 403
    ov = client.get("/api/platform-watch", headers=h).json()["data"]
    assert ov["counts"]["detected"] >= 1 and ov["settings"]["auto_upgrade"] == "non_breaking"
    url = f"/api/platform-watch/candidates/{cid}/decision"
    assert client.post(url, json={"action": "accept"}, headers=h).status_code == 409          # not regression-tested yet
    db.execute("UPDATE update_candidate SET status = 'passed', regression = '{\"passed\": true, \"steps\": []}' WHERE candidate_id = %s", (cid,))
    assert client.post(url, json={"action": "accept"}, headers=h).status_code == 400          # breaking needs a note
    assert client.post(url, json={"action": "reject"}, headers=h).status_code == 400          # reject needs a reason
    d = client.post(url, json={"action": "delay"}, headers=h)
    assert d.status_code == 200 and d.json()["status"] == "delayed"
    until = datetime.fromisoformat(d.json()["delay_until"].replace("Z", "+00:00"))
    assert timedelta(days=6) < until - datetime.now(timezone.utc) < timedelta(days=8)
    db.execute("UPDATE update_candidate SET delay_until = now() - interval '1 minute' WHERE candidate_id = %s", (cid,))
    with db.transaction() as cur:
        assert pw.resurface_delayed(cur) == 1
    assert db.query("SELECT status FROM update_candidate WHERE candidate_id = %s", (cid,))[0]["status"] == "passed"
    acc = client.post(url, json={"action": "accept", "note": "Checked the diff; told the 3 subscribers"}, headers=h)
    assert acc.status_code == 200 and acc.json()["status"] == "accepted" and acc.json()["apply_run"]["mode"] == "not_configured"
    assert client.put("/api/platform-watch/settings/auto_upgrade", json={"value": "sometimes"}, headers=h).status_code == 400
    assert client.put("/api/platform-watch/settings/auto_upgrade", json={"value": "never"}, headers=h).json()["value"] == "never"
    home = client.get("/api/home", headers=h).json()["data"]
    assert isinstance(home["top_actions"], list)
    audit_actions = {r["action"] for r in db.query("SELECT action FROM audit_log WHERE entity_type IN ('update_candidate','watch_settings')")}
    assert {"platform_update.delay", "platform_update.accept", "platform_watch.setting"} <= audit_actions


def test_watch_bootstrap_never_applies_staged_migrations(prod, tmp_path):
    """The watch job runs from the STAGED bundle: it may create its own tables, never apply a pending release."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("platform_updates", ROOT / "jobs" / "platform_updates.py")
    job = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(job)
    staged = _staged(tmp_path, "0.9.0", "CREATE TABLE IF NOT EXISTS {{schema}}.should_wait_for_approval (id int);\n")
    assert job.bootstrap(prod, prod.schema, staged) == []  # everything up to 005 already applied by the fixture
    assert db.query("SELECT to_regclass('should_wait_for_approval') IS NULL AS absent")[0]["absent"]
    with db.transaction() as cur:
        assert [m["version"] for m in pw.pending_migrations(cur, staged / "pipeline" / "migrations")] == ["900_next"]


def test_tests_only_read_paths_the_regression_copy_holds():
    """Platform Watch runs pytest on a copy of REGRESSION_DIRS / REGRESSION_FILES from the staged bundle (0.4.0 failed its
    branch check because two tests read scripts/ and docs/). docs/ is not in the bundle sync: tests that read it must
    skip that check when it is absent."""
    import re

    allowed = set(regression.REGRESSION_DIRS) | set(regression.REGRESSION_FILES) | {"docs"}
    pattern = re.compile(r'ROOT / "([\w.-]+)"')
    read = {m for f in (ROOT / "tests").rglob("*.py") for m in pattern.findall(f.read_text())}
    assert read <= allowed, f"tests read top-level paths the regression copy lacks: {sorted(read - allowed)}"


def test_app_version_matches_the_release_version():
    """Platform Watch stages releases by the root VERSION; the app reports app/VERSION (/api/health). 0.4.0 and 0.4.1
    shipped with app/VERSION still at 0.3.3 because only the root file was bumped."""
    root, app = ROOT / "VERSION", ROOT / "app" / "VERSION"
    if not root.is_file():
        pytest.skip("no root VERSION in this copy")
    assert app.read_text().strip() == root.read_text().strip(), "bump app/VERSION together with VERSION"
