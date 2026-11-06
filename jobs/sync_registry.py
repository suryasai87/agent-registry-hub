"""Registry sync job: apply migrations, run the collectors in dependency order, backfill change metrics.

Works locally and as a Databricks serverless ``spark_python_task``::

    python jobs/sync_registry.py --root <repo> [--collectors a,b] [--days 30] [--skip-migrations]
    # job task parameters: ["--root", "${workspace.file_path}", "--days", "30"]

Deployment settings come from the environment (LAKEBASE_ENDPOINT or LAKEBASE_URL, LAKEBASE_SCHEMA, WAREHOUSE_ID,
SKILL_SCHEMAS); job tasks can pass them as flags instead. Prints one JSON summary line. Exits non-zero only when
every selected collector failed (or migrations failed).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ENV_FLAGS = {
    "warehouse_id": "WAREHOUSE_ID", "lakebase_endpoint": "LAKEBASE_ENDPOINT", "lakebase_database": "LAKEBASE_DATABASE",
    "lakebase_url": "LAKEBASE_URL", "schema": "LAKEBASE_SCHEMA", "skill_schemas": "SKILL_SCHEMAS",
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="sync_registry", description=__doc__.split("\n\n")[0])
    p.add_argument("--root", default=str(Path(__file__).resolve().parents[1]), help="repository root (contains app/)")
    p.add_argument("--collectors", default="", help="comma-separated subset (default: all, in dependency order)")
    p.add_argument("--days", type=int, default=int(os.environ.get("SYNC_DAYS", "30")), help="usage/cost/trace window")
    p.add_argument("--skip-migrations", action="store_true", help="do not apply pipeline/migrations first")
    p.add_argument("--triggered-by", default=os.environ.get("SYNC_TRIGGERED_BY", "schedule"))
    for flag in ENV_FLAGS:
        p.add_argument(f"--{flag.replace('_', '-')}", default=None, help=f"sets {ENV_FLAGS[flag]}")
    # Databricks job runners may append their own arguments; ignore what we do not know.
    args, _unknown = p.parse_known_args(argv)
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    for flag, env in ENV_FLAGS.items():
        value = getattr(args, flag)
        if value:
            os.environ[env] = value
    root = Path(args.root).resolve()
    sys.path.insert(0, str(root / "app"))
    os.environ.setdefault("MIGRATIONS_DIR", str(root / "pipeline" / "migrations"))
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("registry.sync_job")

    from collectors import run_all  # noqa: E402 - needs sys.path
    from collectors.base import resolve  # noqa: E402
    from core import db, migrate  # noqa: E402

    try:
        selected = resolve([c for c in args.collectors.split(",") if c.strip()] or None)
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    try:
        if not args.skip_migrations:
            res = migrate.run(directory=root / "pipeline" / "migrations")
            log.info("migrations: applied %s, already applied %d", res["applied"] or "none", len(res["skipped"]))
        result = run_all(selected, args.triggered_by, days=args.days)
    except Exception as e:  # noqa: BLE001 - one clear line for the job log
        log.exception("sync failed")
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    finally:
        db.lb.close()
    print(json.dumps(result, default=str))
    if result.get("skipped"):
        return 0
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
