"""Sync job entrypoint (serverless spark_python_task): maps job parameters to the app's env, then runs the
collectors (jobs/sync_registry.py) against Lakebase.

    --root ${workspace.file_path} --endpoint projects/<p>/branches/production/endpoints/primary
    --pg-schema registry --warehouse <id> --skill-schemas none|cat.schema,... --agent365-connection none|<uc connection>
    --kg-target none|<catalog.schema> --collectors all|a,b --days 30
"""
from __future__ import annotations

import argparse
import os
import runpy
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root")
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--pg-schema", default="registry")
    ap.add_argument("--warehouse", required=True)
    ap.add_argument("--skill-schemas", default="none")
    ap.add_argument("--agent365-connection", default="none")
    ap.add_argument("--kg-target", default="none")
    ap.add_argument("--collectors", default="all")
    ap.add_argument("--days", default="30")
    args = ap.parse_args()
    root = Path(args.root) if args.root else Path(__file__).resolve().parents[1]
    os.environ["LAKEBASE_ENDPOINT"] = args.endpoint
    os.environ["LAKEBASE_SCHEMA"] = args.pg_schema
    os.environ["WAREHOUSE_ID"] = args.warehouse
    os.environ["MIGRATIONS_DIR"] = str(root / "pipeline" / "migrations")
    if args.skill_schemas and args.skill_schemas.lower() != "none":
        os.environ["SKILL_SCHEMAS"] = args.skill_schemas
    os.environ["AGENT365_CONNECTION"] = args.agent365_connection or "none"
    # Only the optional knowledge graph export step reads this, and only when an admin turned kg_export_in_sync on.
    os.environ["KG_TARGET"] = args.kg_target or "none"
    # Only the optional Unity Catalog lineage publish step reads this, and only when an admin turned
    # uc_lineage_publish_in_sync on in the app (default off): the job then publishes as its own identity.
    os.environ.setdefault("PROVISIONING_MODE", "platform")
    # --skip-migrations: the sync runs from the STAGED bundle. Schema changes reach production only through the setup
    # job (an explicit deploy) or a Platform Watch apply after its branch regression passed and an admin accepted.
    argv = ["sync_registry.py", "--root", str(root), "--days", str(args.days), "--skip-migrations"]
    if args.collectors and args.collectors.lower() != "all":
        argv += ["--collectors", args.collectors]
    sys.argv = argv
    try:
        runpy.run_path(str(root / "jobs" / "sync_registry.py"), run_name="__main__")
    except SystemExit as e:  # serverless tasks report ANY SystemExit (even 0) as a failure
        if e.code not in (0, None):
            raise RuntimeError(f"sync_registry exited with status {e.code}") from None


if __name__ == "__main__":
    main()
