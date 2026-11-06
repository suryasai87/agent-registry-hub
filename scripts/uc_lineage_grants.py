#!/usr/bin/env python3
"""Print the exact grants Unity Catalog lineage publishing needs. It ONLY prints: it never runs a grant.

    python3 scripts/uc_lineage_grants.py [target] [profile] [--app-name NAME] [--app-only] [--principal ID]... [--tables-file F]
    python3 scripts/uc_lineage_grants.py demo DEFAULT > /tmp/uc_lineage_grants.sql

Resolves, read-only, with the Databricks CLI profile:
* the app service principal's application id: ``databricks apps get <app>`` → ``service_principal_client_id``;
* the sync job's run-as identity (the hourly publish step): ``databricks jobs list --name agent-registry-hub-sync-<app>``
  then ``jobs get`` → ``run_as_user_name``. Skip it with ``--app-only``;
* the metastore: ``current-metastore-assignment`` and ``metastore_summary``, for the header;
* the tables of the latest plan: ``GET <app url>/api/lineage/uc-publish`` with the profile's token (you need the
  steward, admin or auditor role in the hub). If the app is unreachable, pass ``--tables-file`` (one catalog.schema.table
  per line, or a saved JSON answer of that endpoint).

Who runs what: a metastore admin runs the ``CREATE EXTERNAL METADATA`` grants; each table's owner (or anyone with
MANAGE on the table, its schema or its catalog) runs the ``MODIFY`` grants. Then verify in Governance › Unity Catalog
lineage › Readiness (Re-check). Needs only python3 (3.9+) and the Databricks CLI.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from registry.uc_grants import by_schema, grant_metastore_sql, grant_schema_sql, grant_table_sql, principal_kind  # noqa: E402


def cli(args: list[str], profile: str) -> dict | list:
    """A read-only Databricks CLI call with JSON output."""
    res = subprocess.run(["databricks", *args, "-p", profile, "-o", "json"], capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        lines = (res.stderr or res.stdout or "").strip().splitlines()
        raise RuntimeError(lines[-1] if lines else f"exit {res.returncode}")
    return json.loads(res.stdout or "null")


def app_name_default() -> str:
    text = (ROOT / "databricks.yml").read_text()
    m = re.search(r"app_name:\n(?:.*\n)*?\s+default:\s*(\S+)", text)
    return m.group(1) if m else "agent-registry-hub"


def plan_tables(app_url: str, profile: str) -> list[str]:
    tok = cli(["auth", "token"], profile)
    token = tok.get("access_token") if isinstance(tok, dict) else None
    if not token:
        raise RuntimeError("the profile returned no access token")
    req = urllib.request.Request(f"{app_url.rstrip('/')}/api/lineage/uc-publish", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 - the app's own https URL
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} from the app") from None
    data = body.get("data") or {}
    if body.get("source") != "lakebase" or not data.get("plan"):
        raise RuntimeError(f"the app answered without a live plan (source {body.get('source')}: {data.get('note') or body.get('degraded_reason')})")
    return list(data["plan"].get("tables") or [])


def tables_from_file(path: str) -> list[str]:
    text = Path(path).read_text()
    try:
        body = json.loads(text)
    except ValueError:
        return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
    plan = (body.get("data") or body).get("plan") or body
    return list(plan.get("tables") or [])


def render(*, target: str, profile: str, app: str, principals: list[tuple[str, str]], meta: dict | None, tables: list[str] | None,
           tables_note: str | None) -> str:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = [f"-- Unity Catalog lineage publishing: grants for app {app} (bundle target {target}, profile {profile})",
           f"-- Generated {now} by scripts/uc_lineage_grants.py. Nothing was executed: review, then run each block as noted."]
    if meta:
        out.append(f"-- Metastore: {meta.get('name') or '?'} ({meta.get('metastore_id')}), owner {meta.get('owner') or '?'}")
    out.append("--")
    for who, label in principals:
        out.append(f"-- {label}: {who} ({principal_kind(who).replace('_', ' ')})")
    owner = (meta or {}).get("owner")
    out += ["", f"-- 1) Run as a metastore admin{f' (a member of {owner})' if owner else ''}:"]
    out += [f"{grant_metastore_sql(who)}  -- {label}" for who, label in principals]
    out.append("")
    if tables is None:
        out += [f"-- 2) MODIFY on the plan's tables: not printed ({tables_note}).",
                "--    Re-run with --tables-file, or copy the per-table grants from Governance › Unity Catalog lineage › Readiness."]
    elif not tables:
        out.append("-- 2) The latest plan touches no Unity Catalog tables: no MODIFY grants needed.")
    else:
        groups = by_schema(tables)
        out += [f"-- 2) Run as each table's owner (or anyone with MANAGE on the table, its schema or its catalog):",
                f"--    {len(tables)} table(s) in {len(groups)} schema(s) from the latest plan. Without MODIFY on a table, only the",
                "--    relationships to that table fail (the run is partial) and the next plan retries them."]
        for schema, names in groups.items():
            out += ["", f"-- {schema} ({len(names)} table(s))"]
            out += [f"--   broader alternative, every current and future table: {grant_schema_sql(schema, who)}" for who, _ in principals]
            for t in names:
                out += [grant_table_sql(t, who) for who, _ in principals]
    out += ["", "-- Then: Governance › Unity Catalog lineage › Readiness › Re-check (or GET /api/lineage/uc-publish/readiness?refresh=true)."]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("target", nargs="?", default="demo")
    ap.add_argument("profile", nargs="?", default="DEFAULT")
    ap.add_argument("--app-name", default=None, help="default: the app_name variable in databricks.yml")
    ap.add_argument("--app-only", action="store_true", help="only the app service principal (not the sync job identity)")
    ap.add_argument("--principal", action="append", default=[], help="another publishing identity, e.g. an admin who publishes on-behalf-of")
    ap.add_argument("--tables-file", default=None, help="tables to grant MODIFY on, if the app is unreachable")
    args = ap.parse_args(argv)
    app = args.app_name or app_name_default()
    warn = lambda msg: print(f"uc_lineage_grants: {msg}", file=sys.stderr)  # noqa: E731

    try:
        info = cli(["apps", "get", app], args.profile)
    except Exception as e:  # noqa: BLE001
        warn(f"databricks apps get {app} failed: {e}")
        return 2
    sp = info.get("service_principal_client_id")
    if not sp:
        warn(f"app {app} has no service principal yet (is it deployed?)")
        return 2
    principals = [(sp, f"App service principal {info.get('service_principal_name') or ''}".strip())]
    if not args.app_only:
        try:
            jobs = cli(["jobs", "list", "--name", f"agent-registry-hub-sync-{app}"], args.profile) or []
            if jobs:
                job = cli(["jobs", "get", str(jobs[0]["job_id"])], args.profile)
                who = job.get("run_as_user_name") or job.get("creator_user_name")
                if who and who != sp:
                    principals.append((who, f"Sync job run-as identity (job {jobs[0]['job_id']}, for the hourly step)"))
            else:
                warn("sync job not found: only the app service principal is listed")
        except Exception as e:  # noqa: BLE001
            warn(f"couldn't resolve the sync job identity: {e}")
    for extra in args.principal:
        if extra not in {p for p, _ in principals}:
            principals.append((extra, "Additional publishing identity"))

    meta = None
    try:
        a = cli(["api", "get", "/api/2.1/unity-catalog/current-metastore-assignment"], args.profile)
        s = cli(["api", "get", "/api/2.1/unity-catalog/metastore_summary"], args.profile)
        meta = {"metastore_id": a.get("metastore_id"), "name": s.get("name"), "owner": s.get("owner")}
    except Exception as e:  # noqa: BLE001
        warn(f"couldn't read the metastore: {e}")

    tables, note = None, None
    try:
        tables = tables_from_file(args.tables_file) if args.tables_file else plan_tables(info.get("url") or "", args.profile)
    except Exception as e:  # noqa: BLE001
        note = f"the latest plan was not reachable: {e}"
        warn(note)
    sys.stdout.write(render(target=args.target, profile=args.profile, app=app, principals=principals, meta=meta, tables=tables, tables_note=note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
