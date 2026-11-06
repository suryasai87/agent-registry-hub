"""Regression-test an update candidate on a throwaway Lakebase branch, then (on acceptance) apply it.

``check(candidate_id)`` (job, as the deployer):
  1. Branch the production database (copy-on-write; TTL ``keep_failed_branch_hours``) and start a compute
     endpoint on it.
  2. Snapshot per-table row counts on the branch.
  3. Apply the candidate's pending migrations to the branch.
  4. Data preservation: no table may lose rows unless a migration declares ``-- allow-data-loss``.
  5. Read-path smoke checks: catalog, home, lineage, usage, policies, quality, changes and the MCP
     subregistry, run against the branch copy of the LIVE data.
  6. Optional collector compatibility (capability/advisory): run the matched adapter collectors into the branch.
  7. The pytest regression suite, with its scratch schemas created on the branch.
  8. Record the results on the production candidate (passed/failed). Delete the branch on success, keep it
     on failure for debugging until its TTL.
  9. The auto-upgrade policy may apply a passing, non-breaking candidate right away.

``apply(candidate_id)``: migrate production, enable the adapters, and for app releases deploy the staged app
source (``POST /api/2.0/apps/{name}/deployments``). Every step is recorded on the candidate and in the audit trail.

The branch provider is pluggable: ``LakebaseBranches`` (REST, on Databricks) or ``LocalBranches`` (a schema copy
in local Postgres, for local runs and tests).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from psycopg.types.json import Jsonb

from core import audit, migrate
from core.lakebase import Lakebase

SMOKE_READS = ("catalog", "home", "lineage", "usage_fleet", "policies", "quality", "changes", "subregistry")


@dataclass
class Branch:
    name: str
    lb: Lakebase
    dsn: str | None  # libpq DSN usable by pytest (password = short-lived OAuth token on Lakebase)


class LakebaseBranches:
    """Lakebase autoscale branches through the REST API (version-independent of the SDK)."""

    def __init__(self, w, project: str, source_branch: str = "production", database: str = "databricks_postgres"):
        self.w, self.project, self.source, self.database = w, project, source_branch, database

    def _wait(self, path: str, field: str, ok: tuple[str, ...], timeout: int = 600) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                obj = self.w.api_client.do("GET", path) or {}
                if (obj.get("status") or {}).get(field) in ok:
                    return obj
            except Exception:  # noqa: BLE001 - not visible yet (long-running operation)
                pass
            time.sleep(5)
        raise TimeoutError(f"{path} did not reach {ok} within {timeout}s")

    def create(self, branch_id: str, ttl_hours: int, schema: str) -> Branch:
        base = f"/api/2.0/postgres/projects/{self.project}"
        self.w.api_client.do("POST", f"{base}/branches", query={"branch_id": branch_id}, body={"spec": {
            "source_branch": f"projects/{self.project}/branches/{self.source}", "ttl": f"{max(1, ttl_hours) * 3600}s"}})
        self._wait(f"{base}/branches/{branch_id}", "current_state", ("READY",))
        eps = (self.w.api_client.do("GET", f"{base}/branches/{branch_id}/endpoints") or {}).get("endpoints", [])
        if eps:
            ep_name = eps[0]["name"]
        else:
            self.w.api_client.do("POST", f"{base}/branches/{branch_id}/endpoints", query={"endpoint_id": "primary"}, body={"spec": {
                "endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "autoscaling_limit_min_cu": 0.5, "autoscaling_limit_max_cu": 2}})
            ep_name = f"projects/{self.project}/branches/{branch_id}/endpoints/primary"
        ep = self._wait(f"/api/2.0/postgres/{ep_name}", "current_state", ("ACTIVE", "IDLE"))
        lb = Lakebase(endpoint=ep_name, schema=schema, database=self.database, application_name=f"regression-{branch_id}")
        token = self.w.api_client.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": ep_name})["token"]
        from core.lakebase import pg_user
        host = ep["status"]["hosts"]["host"]
        dsn = f"postgresql://{quote(pg_user(), safe='')}:{quote(token, safe='')}@{host}:5432/{self.database}?sslmode=require"
        return Branch(name=f"projects/{self.project}/branches/{branch_id}", lb=lb, dsn=dsn)

    def delete(self, branch: Branch) -> None:
        branch.lb.close()
        self.w.api_client.do("DELETE", f"/api/2.0/postgres/{branch.name}")


class LocalBranches:
    """Local Postgres stand-in for a Lakebase branch: a schema copy of production in the same database.

    It replays the migrations production has already applied, then bulk-copies every table with
    ``session_replication_role = replica`` (triggers and FKs suspended, so the hash-chained audit_log is copied
    byte for byte). The regression then applies the PENDING migrations on top, exactly like on a Lakebase branch.
    Needs a superuser DSN (local Docker Postgres).
    """

    def __init__(self, dsn: str, prod_schema: str):
        self.dsn, self.prod_schema = dsn, prod_schema

    def create(self, branch_id: str, ttl_hours: int, schema: str) -> Branch:
        import psycopg
        from psycopg import sql as q

        b = re.sub(r"[^a-z0-9_]", "_", f"br_{branch_id}".lower())[:60]
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(q.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(q.Identifier(b)))
            applied = {r[0] for r in conn.execute(q.SQL("SELECT version FROM {}.schema_migrations").format(q.Identifier(self.prod_schema)))}
            from core import migrate as mg
            conn.execute(q.SQL("CREATE SCHEMA {}").format(q.Identifier(b)))
            for m in mg.discover(os.environ.get("MIGRATIONS_DIR") or mg.DEFAULT_DIR):
                if m.version in applied:
                    with conn.transaction():
                        conn.execute(m.render(b))
                        conn.execute(q.SQL("INSERT INTO {}.schema_migrations (version, checksum) VALUES (%s, %s)").format(q.Identifier(b)),
                                     (m.version, m.checksum))
            tables = [r[0] for r in conn.execute("""SELECT table_name FROM information_schema.tables WHERE table_schema = %s
                                                    AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'""", (self.prod_schema,))]
            with conn.transaction():
                conn.execute("SET LOCAL session_replication_role = replica")
                for t in tables:
                    cols = [r[0] for r in conn.execute("""SELECT column_name FROM information_schema.columns WHERE table_schema = %s AND table_name = %s
                                                          AND is_generated = 'NEVER' ORDER BY ordinal_position""", (self.prod_schema, t))]
                    collist = q.SQL(", ").join(q.Identifier(c) for c in cols)
                    # migrations seed reference rows; the copy must be exact, so production's rows replace them
                    conn.execute(q.SQL("DELETE FROM {}.{}").format(q.Identifier(b), q.Identifier(t)))
                    conn.execute(q.SQL("INSERT INTO {}.{} ({}) SELECT {} FROM {}.{}").format(
                        q.Identifier(b), q.Identifier(t), collist, collist, q.Identifier(self.prod_schema), q.Identifier(t)))
            for seq_table, seq_col in conn.execute("""SELECT table_name, column_name FROM information_schema.columns
                                                       WHERE table_schema = %s AND column_default LIKE 'nextval%%'""", (b,)).fetchall():
                conn.execute(q.SQL("SELECT setval(pg_get_serial_sequence(%s, %s), coalesce((SELECT max({}) FROM {}.{}), 0) + 1, false)").format(
                    q.Identifier(seq_col), q.Identifier(b), q.Identifier(seq_table)), (f"{b}.{seq_table}", seq_col))
        return Branch(name=f"local:{b}", lb=Lakebase(url=self.dsn, schema=b, application_name=f"regression-{b}"), dsn=self.dsn)

    def delete(self, branch: Branch) -> None:
        import psycopg
        from psycopg import sql as q

        branch.lb.close()
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(q.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(q.Identifier(branch.name.split(":", 1)[1])))


def _step(steps: list, name: str, fn):
    t0 = time.time()
    try:
        detail = fn()
        steps.append({"name": name, "status": "passed", "detail": detail, "duration_ms": int((time.time() - t0) * 1000)})
        return True
    except Exception as e:  # noqa: BLE001 - every failure is recorded on the candidate
        steps.append({"name": name, "status": "failed", "detail": f"{type(e).__name__}: {str(e)[:800]}",
                      "duration_ms": int((time.time() - t0) * 1000)})
        return False


def _row_counts(lb: Lakebase) -> dict[str, int]:
    tables = lb.query("SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE'", (lb.schema,))
    out = {}
    for t in tables:
        out[t["table_name"]] = int(lb.query(f'SELECT count(*) AS n FROM "{lb.schema}"."{t["table_name"]}"')[0]["n"])
    return out


def _smoke(lb: Lakebase) -> dict:
    """Run the app's read services against the branch: every one must answer without an exception."""
    from core import db
    from registry import authz, cards, changes, home, lineage, policies, quality, usage

    p = authz.Principal(email="regression@registry.local", display_name="Regression", roles=frozenset({"viewer", "auditor"}),
                        actual_roles=frozenset({"viewer", "auditor"}))
    saved = db.lb
    db.lb = lb
    results = {}
    try:
        with db.transaction() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            t = time.time(); page = cards.catalog(cur, {}, p.email, 1, 24); results["catalog"] = {"total": page["total"], "ms": int((time.time() - t) * 1000)}
            t = time.time(); home.home(cur, p); results["home"] = {"ms": int((time.time() - t) * 1000)}
            focus = page["items"][0]["asset_id"] if page["items"] else None
            t = time.time(); g = lineage.build(cur, focus, 2, "both", ["declared", "observed", "data"], p=p)
            results["lineage"] = {"focus": focus, "nodes": len(g["nodes"]), "ms": int((time.time() - t) * 1000)}
            t = time.time(); usage.fleet(cur, 30); results["usage_fleet"] = {"ms": int((time.time() - t) * 1000)}
            t = time.time(); policies.fleet(cur); results["policies"] = {"ms": int((time.time() - t) * 1000)}
            t = time.time(); quality.fleet(cur); results["quality"] = {"ms": int((time.time() - t) * 1000)}
            t = time.time(); changes.feed(cur, viewer=p.email, days=90); results["changes"] = {"ms": int((time.time() - t) * 1000)}
        from modules.subregistry_api.router import _rows
        t = time.time(); results["subregistry"] = {"servers": len(_rows(None, None, 50)), "ms": int((time.time() - t) * 1000)}
    finally:
        db.lb = saved
    slow = {k: v for k, v in results.items() if v.get("ms", 0) > 5000}
    if slow:
        raise RuntimeError(f"read paths slower than 5 s on the branch: {slow}")
    return results


# What the regression copy holds. Tests may only read these top-level paths (a test guards it); docs/ and frontend/
# are excluded from the bundle sync, so a test that reads them must skip that check when they are absent.
REGRESSION_DIRS = ("app", "tests", "pipeline", "jobs", "scripts")
REGRESSION_FILES = ("pytest.ini", "databricks.yml", "VERSION")  # databricks.yml: the deploy-config drift test reads it


def _pytest(root: Path, dsn: str | None) -> str:
    """Run the regression suite against the branch. Copies REGRESSION_DIRS / REGRESSION_FILES to local disk first: the
    Databricks Workspace file system can't create __pycache__ (Errno 95), which breaks pytest's conftest load."""
    import shutil
    import tempfile

    if not dsn or not (root / "tests").is_dir():
        return "skipped (no tests directory or no branch DSN)"
    work = Path(tempfile.mkdtemp(prefix="arh-regression-"))
    try:
        for part in REGRESSION_DIRS:
            if (root / part).is_dir():
                shutil.copytree(root / part, work / part, ignore=shutil.ignore_patterns("__pycache__", "static", "node_modules"))
        for f in REGRESSION_FILES:
            if (root / f).is_file():
                shutil.copy2(root / f, work / f)
        env = {**os.environ, "TEST_DATABASE_URL": dsn, "PYTHONPATH": str(work / "app"), "PYTHONDONTWRITEBYTECODE": "1",
               "MIGRATIONS_DIR": str(work / "pipeline" / "migrations")}
        proc = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(work / "tests")],
                              cwd=str(work), env=env, capture_output=True, text=True, timeout=1500)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    tail = "\n".join((proc.stdout or "").strip().splitlines()[-8:])
    shutil.rmtree(work, ignore_errors=True)
    if proc.returncode != 0:
        err = "\n".join((proc.stderr or "").strip().splitlines()[-12:])
        raise RuntimeError(f"pytest exit {proc.returncode}: {tail[-500:]} | stderr: {err[-900:]}")
    return tail.splitlines()[-1] if tail else "passed"


def check(prod: Lakebase, provider, candidate_id: int, *, root: Path, schema: str, run_collectors=None,
          run_pytest: bool = True) -> dict:
    """Run the regression for one candidate. Writes the result to the PRODUCTION candidate row."""
    from registry import platform_watch as pw

    with prod.connection() as conn, conn.cursor(row_factory=__import__("psycopg").rows.dict_row) as cur:
        cur.execute("UPDATE update_candidate SET status = 'testing', updated_at = now() WHERE candidate_id = %s RETURNING *", (candidate_id,))
        cand = cur.fetchone()
        ttl = int(pw.get_setting(cur, "keep_failed_branch_hours", 72) or 72)
        conn.commit()
    if not cand:
        raise KeyError(f"candidate {candidate_id} not found")
    branch_id = f"upd-{candidate_id}-{datetime.now(timezone.utc):%m%d%H%M}"
    steps: list[dict] = []
    started = datetime.now(timezone.utc).isoformat()
    branch = None
    holder: dict = {}
    ok = _step(steps, "Create Lakebase branch", lambda: holder.update(b=provider.create(branch_id, ttl, schema)) or f"{branch_id} (TTL {ttl} h)")
    if ok:
        branch = holder["b"]
        before: dict = {}
        ok = _step(steps, "Snapshot row counts", lambda: before.update(_row_counts(branch.lb)) or f"{sum(before.values())} rows in {len(before)} tables")
        if ok:
            migs = cand["migrations"] or []
            allow_loss = any(m.get("allow_data_loss") for m in migs)
            ok = _step(steps, "Apply pending migrations on the branch",
                       lambda: migrate.run(branch.lb, schema=branch.lb.schema, directory=root / "pipeline" / "migrations"))
            if ok:
                def preserved():
                    after = _row_counts(branch.lb)
                    lost = {t: (n, after.get(t, 0)) for t, n in before.items() if after.get(t, 0) < n}
                    if lost and not allow_loss:
                        raise RuntimeError(f"rows lost: {lost}")
                    return f"{len(after)} tables; no rows lost" if not lost else f"rows changed (allowed): {lost}"
                ok &= _step(steps, "Data preservation", preserved)
                if run_collectors:
                    ok &= _step(steps, "Collector compatibility (into the branch)", lambda: run_collectors(branch.lb, cand))
                ok &= _step(steps, "Read-path smoke checks (live data copy)", lambda: _smoke(branch.lb))
                if run_pytest:
                    ok &= _step(steps, "Regression test suite (pytest)", lambda: _pytest(root, branch.dsn))
    summary = {"started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(), "branch": branch.name if branch else branch_id,
               "passed": bool(ok), "steps": steps}
    if branch:
        if ok:
            _step(steps, "Delete branch", lambda: provider.delete(branch) or "deleted")
        else:
            branch.lb.close()
            steps.append({"name": "Keep branch for debugging", "status": "passed", "detail": f"{branch.name} (expires after {ttl} h)", "duration_ms": 0})
    with prod.connection() as conn, conn.cursor(row_factory=__import__("psycopg").rows.dict_row) as cur:
        policy = pw.get_setting(cur, "auto_upgrade", "non_breaking")
        auto = bool(ok) and cand["kind"] != "advisory" and (policy == "all" or (policy == "non_breaking" and not cand["breaking"]))
        cur.execute("""UPDATE update_candidate SET status = %s, regression = %s, branch_name = %s, auto_apply = %s, updated_at = now()
                        WHERE candidate_id = %s""", ("passed" if ok else "failed", Jsonb(summary), summary["branch"], auto, candidate_id))
        audit.audit_event("system:regression", "platform_update.regression", "update_candidate", candidate_id,
                          after={"passed": bool(ok), "branch": summary["branch"], "steps": [(s["name"], s["status"]) for s in steps]}, cur=cur)
        from registry import notify
        from core import config
        cur.execute("SELECT DISTINCT email FROM role_assignment WHERE role = 'admin'")
        for email in {r["email"] for r in cur.fetchall()} | set(config.REGISTRY_ADMINS):
            notify.queue(cur, email, "platform_update",
                         f"Regression {'passed' if ok else 'FAILED'}: {cand['title']}" + (" (auto-apply eligible)" if auto else ""),
                         None, None, candidate_id)
        conn.commit()
    return {**summary, "auto_apply": auto}


def app_deployment_config(*, endpoint: str, schema: str, app_name: str, registry_admins: str = "",
                          notify_webhook_url: str = "", agent365_connection: str = "none", kg_target: str = "none") -> dict:
    """The app's ``command`` and ``env_vars`` exactly as databricks.yml (registry_app.config) declares them.
    tests/test_platform_watch.py keeps the two in sync."""
    env = [("LAKEBASE_ENDPOINT", endpoint), ("LAKEBASE_DATABASE", "databricks_postgres"), ("LAKEBASE_SCHEMA", schema),
           ("WAREHOUSE_ID", None, "sql-warehouse"), ("SYNC_JOB_ID", None, "sync-job"), ("WATCH_JOB_ID", None, "updates-job"),
           ("REGISTRY_ADMINS", registry_admins), ("NOTIFY_WEBHOOK_URL", notify_webhook_url),
           ("AGENT365_CONNECTION", agent365_connection), ("KG_TARGET", kg_target), ("ALLOW_MUTATIONS", "true"), ("WEB_CONCURRENCY", "2"),
           ("APP_NAME", app_name)]
    return {"command": ["python", "app.py"],
            "env_vars": [{"name": e[0], "value_from": e[2]} if len(e) == 3 else {"name": e[0], "value": e[1] or ""} for e in env]}


REQUIRED_APP_ENV = ("LAKEBASE_ENDPOINT", "LAKEBASE_DATABASE", "LAKEBASE_SCHEMA")


def verify_app_health(w, app_name: str, deployment_id: str | None = None, attempts: int = 18) -> str:
    """After a deployment: the app must be RUNNING on that deployment, with its command and Lakebase settings.
    /api/health is checked too when the job's identity can reach it (the Apps sign-in answers a job's runtime token
    with 401, which is not a verdict on the app); a reachable app that reports Lakebase not ok fails the update."""
    import requests

    last = "no answer"
    for _ in range(attempts):
        app = w.api_client.do("GET", f"/api/2.0/apps/{app_name}")
        dep = app.get("active_deployment") or {}
        names = {e.get("name") for e in dep.get("env_vars") or []}
        missing = [n for n in REQUIRED_APP_ENV if n not in names]
        state = (app.get("app_status") or {}).get("state")
        if deployment_id and dep.get("deployment_id") != deployment_id:
            last = f"active deployment is {dep.get('deployment_id')}, not {deployment_id}"
        elif missing or not dep.get("command"):
            raise RuntimeError(f"the deployment has no command/{', '.join(missing) or 'env'}; redeploy with `databricks bundle run registry_app`")
        elif state != "RUNNING":
            last = f"app is {state}"
        else:
            url = (app.get("url") or "").rstrip("/")
            try:
                r = requests.get(f"{url}/api/health", headers=w.config.authenticate(), timeout=20, allow_redirects=False)
            except Exception as e:
                return f"RUNNING on {dep.get('deployment_id')} with {len(names)} settings (health not reachable: {type(e).__name__})"
            if r.status_code in (401, 403) or 300 <= r.status_code < 400:
                return f"RUNNING on {dep.get('deployment_id')} with {len(names)} settings (health needs a user sign-in: HTTP {r.status_code})"
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.status_code == 200 and (body.get("lakebase") or {}).get("ok"):
                return f"{url} healthy: version {body.get('version')}, Lakebase {body['lakebase'].get('mode')}"
            last = f"HTTP {r.status_code}: {str(body.get('lakebase') or body)[:200]}"
        time.sleep(10)
    raise RuntimeError(f"deployed app is not healthy ({last}); redeploy with `databricks bundle run registry_app`")


def apply(prod: Lakebase, candidate_id: int, *, root: Path, schema: str, w=None, app_name: str | None = None,
          app_config: dict | None = None, actor: str = "system:apply") -> dict:
    """Apply an accepted (or auto-eligible, passed) candidate to production."""
    import psycopg

    with prod.connection() as conn, conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute("SELECT * FROM update_candidate WHERE candidate_id = %s FOR UPDATE", (candidate_id,))
        c = cur.fetchone()
        if not c:
            raise KeyError(f"candidate {candidate_id} not found")
        if not (c["status"] == "accepted" or (c["status"] == "passed" and c["auto_apply"])):
            raise RuntimeError(f"candidate {candidate_id} is {c['status']} (auto_apply={c['auto_apply']}); accept it first")
        cur.execute("UPDATE update_candidate SET status = 'applying', updated_at = now() WHERE candidate_id = %s", (candidate_id,))
        conn.commit()
    steps: list[dict] = []
    ok = _step(steps, "Migrate production", lambda: migrate.run(prod, schema=schema, directory=root / "pipeline" / "migrations"))
    if ok and c["kind"] == "capability" and c["capability_key"]:
        def enable():
            prod.execute("UPDATE capability SET adapter_enabled = true WHERE capability_key = %s", (c["capability_key"],))
            return f"{c['capability_key']} enabled"
        ok &= _step(steps, "Enable adapter", enable)
    if ok and c["kind"] == "app_release":
        if w is None or not app_name:
            steps.append({"name": "Deploy app", "status": "failed", "detail": "no workspace client / app name", "duration_ms": 0})
            ok = False
        elif not (app_config and app_config.get("command") and app_config.get("env_vars")):
            # A deployment without command/env_vars starts the app with no Lakebase settings (seen live: degraded until
            # `databricks bundle run registry_app`). The Apps API redacts env values, so they can't be copied from
            # the running deployment: the bundle passes them to this job instead (app_deployment_config).
            steps.append({"name": "Deploy app", "status": "failed", "duration_ms": 0,
                          "detail": "no app command/env from the bundle; redeploy with `databricks bundle run registry_app`"})
            ok = False
        else:
            deployed: dict = {}

            def deploy():
                dep = w.api_client.do("POST", f"/api/2.0/apps/{app_name}/deployments",
                                      body={"source_code_path": str(root / "app"), "mode": "SNAPSHOT", **app_config})
                dep_id = deployed["id"] = dep.get("deployment_id")
                for _ in range(120):
                    d = w.api_client.do("GET", f"/api/2.0/apps/{app_name}/deployments/{dep_id}")
                    state = (d.get("status") or {}).get("state")
                    if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
                        if state != "SUCCEEDED":
                            raise RuntimeError(f"deployment {dep_id} {state}: {(d.get('status') or {}).get('message')}")
                        return f"deployment {dep_id} SUCCEEDED from {root / 'app'}"
                    time.sleep(10)
                raise TimeoutError(f"deployment {dep_id} still running after 20 min")
            ok &= _step(steps, "Deploy app from staged source", deploy)
            if ok:
                ok &= _step(steps, "Verify the deployed app reaches Lakebase", lambda: verify_app_health(w, app_name, deployed.get("id")))
    detail = {"finished_at": datetime.now(timezone.utc).isoformat(), "steps": steps, "ok": bool(ok)}
    with prod.connection() as conn, conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute("""UPDATE update_candidate SET status = %s, apply_detail = %s, applied_at = CASE WHEN %s THEN now() END, updated_at = now()
                        WHERE candidate_id = %s""", ("applied" if ok else "apply_failed", Jsonb(detail), bool(ok), candidate_id))
        if ok and c["kind"] == "app_release" and c["to_version"]:
            from registry import platform_watch as pw
            pw.record_running_version(cur, c["to_version"])
        audit.audit_event(actor, "platform_update.apply" if ok else "platform_update.apply_failed", "update_candidate", candidate_id,
                          after={"steps": [(s["name"], s["status"]) for s in steps]}, cur=cur)
        conn.commit()
    return detail
