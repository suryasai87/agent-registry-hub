"""Platform Watch job: release feeds → capability probes → update candidates → branch regression → (auto-)apply.

    python jobs/platform_updates.py --root <repo> --mode watch                # feeds, probes, detect, regress, auto-apply
    python jobs/platform_updates.py --root <repo> --mode check --candidate 12 # regression on a fresh Lakebase branch
    python jobs/platform_updates.py --root <repo> --mode apply --candidate 12 # migrate prod (+ enable adapter / deploy app)

Settings arrive as flags (serverless tasks take no env vars): --endpoint projects/<p>/branches/production/endpoints/primary
--pg-schema registry --warehouse <id> --app-name agent-registry-hub. Locally, LAKEBASE_URL + --local uses LocalBranches
(a schema copy of production) instead of Lakebase branches.
Prints one JSON summary line. Exits non-zero when a requested check/apply failed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

QUICK_ADAPTERS = ("agent_bricks", "skills", "mcp_system")
WATCH_BOOTSTRAP_MAX = "005_platform_watch"  # the newest migration Platform Watch itself needs


def bootstrap(prod, schema: str, root: Path) -> list[str]:
    """Apply migrations up to WATCH_BOOTSTRAP_MAX, and only those that are missing. Later ones wait for approval."""
    from core import migrate

    with prod.connection() as conn:
        done = migrate.applied(conn, schema)
    todo = [m for m in migrate.discover(root / "pipeline" / "migrations") if m.version <= WATCH_BOOTSTRAP_MAX and m.version not in done]
    with prod.connection() as conn:
        for m in todo:
            migrate._apply(conn, schema, m)
    return [m.version for m in todo]


def parse_args(argv=None):
    p = argparse.ArgumentParser(prog="platform_updates")
    p.add_argument("--root", default=None, help="repository root (required as a job task: __file__ is undefined there)")
    p.add_argument("--mode", choices=("watch", "check", "apply"), default="watch")
    p.add_argument("--candidate", default="")
    p.add_argument("--endpoint")
    p.add_argument("--pg-schema")
    p.add_argument("--warehouse")
    p.add_argument("--app-name", default=os.environ.get("APP_NAME", "agent-registry-hub"))
    p.add_argument("--registry-admins", default="")
    p.add_argument("--notify-webhook-url", default="")
    p.add_argument("--agent365-connection", default="none")
    p.add_argument("--kg-target", default="none")
    p.add_argument("--local", action="store_true", help="local Postgres (LAKEBASE_URL): branch = schema copy, no app deploy")
    p.add_argument("--skip-feeds", action="store_true")
    p.add_argument("--skip-probes", action="store_true", help="don't call workspace APIs (offline runs)")
    p.add_argument("--skip-pytest", action="store_true")
    args, _ = p.parse_known_args(argv)
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    root = Path(args.root).resolve() if args.root else Path(globals().get("__file__", "jobs/x.py")).resolve().parents[1]
    for flag, var in (("endpoint", "LAKEBASE_ENDPOINT"), ("pg_schema", "LAKEBASE_SCHEMA"), ("warehouse", "WAREHOUSE_ID")):
        if getattr(args, flag):
            os.environ[var] = getattr(args, flag)
    os.environ.setdefault("MIGRATIONS_DIR", str(root / "pipeline" / "migrations"))
    sys.path.insert(0, str(root / "app"))

    from psycopg.rows import dict_row

    from core import config, db, migrate, warehouse
    from registry import platform_watch as pw, regression

    schema = config.LAKEBASE_SCHEMA
    prod = db.lb
    out: dict = {"mode": args.mode}

    def workspace():
        from core.lakebase import workspace_client
        return workspace_client()

    def provider():
        if args.local:
            return regression.LocalBranches(config.LAKEBASE_URL, schema)
        project = config.LAKEBASE_ENDPOINT.split("/")[1]
        return regression.LakebaseBranches(workspace(), project, config.LAKEBASE_ENDPOINT.split("/")[3], config.LAKEBASE_DATABASE)

    def run_collectors(branch_lb, cand):
        from collectors.base import run_all
        caps = [cand["capability_key"]] if cand["capability_key"] in pw.CAP_BY_KEY else []
        names = sorted({pw.CAP_BY_KEY[c]["adapter"] for c in caps if pw.CAP_BY_KEY[c].get("adapter")}) or list(QUICK_ADAPTERS)
        saved = db.lb
        db.lb = branch_lb
        try:
            res = run_all(names, triggered_by="regression", backfill=False)
        finally:
            db.lb = saved
        bad = [r for r in res.get("runs", []) if r["status"] == "failed"]
        if bad:
            raise RuntimeError(f"collectors failed on the branch: {[(r['collector'], r.get('error')) for r in bad]}")
        return {r["collector"]: r["status"] for r in res.get("runs", [])}

    def check(cid: int) -> dict:
        return regression.check(prod, provider(), cid, root=root, schema=schema,
                                run_collectors=None if args.local else run_collectors,
                                run_pytest=not args.skip_pytest)

    def apply(cid: int) -> dict:
        w = None if args.local else workspace()
        app_config = regression.app_deployment_config(
            endpoint=args.endpoint or "", schema=schema, app_name=args.app_name, registry_admins=args.registry_admins,
            notify_webhook_url=args.notify_webhook_url, agent365_connection=args.agent365_connection,
            kg_target=args.kg_target) if args.endpoint else None
        return regression.apply(prod, cid, root=root, schema=schema, w=w, app_name=args.app_name, app_config=app_config)

    if args.mode == "watch":
        # Bootstrap ONLY the Platform Watch tables. This job runs from the STAGED bundle, so applying every migration
        # here would push an unapproved release's schema changes to production before its regression and decision.
        bootstrap(prod, schema, root)
        staged_version = (root / "VERSION").read_text().strip() if (root / "VERSION").is_file() else None

        def rest_call(method, path, body):
            import requests
            w = workspace()
            headers = {**w.config.authenticate(), "Content-Type": "application/json"}
            r = requests.request(method, w.config.host.rstrip("/") + path, headers=headers, json=body, timeout=30)
            return r.status_code, r.text[:2000]

        sql_call = (lambda stmt: warehouse.execute(stmt)) if warehouse.configured() else None
        with prod.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            if not args.skip_feeds:
                out["feeds"] = pw.fetch_feeds(cur)
            if not args.skip_probes:
                out["probe_changes"] = pw.probe_capabilities(cur, rest_call, sql_call)
            out["resurfaced"] = pw.resurface_delayed(cur)
            out["created"] = pw.detect_candidates(cur, staged_root=root, staged_version=staged_version)
            cur.execute("SELECT candidate_id FROM update_candidate WHERE status = 'detected' ORDER BY candidate_id LIMIT 5")
            todo = [r["candidate_id"] for r in cur.fetchall()]
            conn.commit()
        out["checked"] = {}
        for cid in todo:
            out["checked"][cid] = check(cid)["passed"]
        with prod.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT candidate_id FROM update_candidate WHERE status = 'passed' AND auto_apply ORDER BY candidate_id")
            auto = [r["candidate_id"] for r in cur.fetchall()]
        out["auto_applied"] = {cid: apply(cid)["ok"] for cid in auto}
        print(json.dumps(out, default=str))
        return 0
    if not args.candidate:
        print(json.dumps({"error": "--candidate is required for check/apply"}))
        return 2
    cid = int(args.candidate)
    result = check(cid) if args.mode == "check" else apply(cid)
    out["result"] = result
    print(json.dumps(out, default=str))
    ok = result.get("passed") if args.mode == "check" else result.get("ok")
    return 0 if ok else 1


if __name__ == "__main__":
    rc = main()
    if rc:  # never sys.exit(0): serverless job tasks treat any SystemExit as a failure
        raise RuntimeError(f"platform_updates finished with status {rc}")
