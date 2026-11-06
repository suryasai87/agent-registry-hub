"""Bundle setup job: migrations + the app service principal's Lakebase access (idempotent).

1. Runs pipeline/migrations as the job identity (the deployer), which owns the registry schema.
2. Registers the app's SP as a Lakebase OAuth identity role (a plain SQL CREATE ROLE can't log in with an
   OAuth token).
3. Least-privilege grants for the SP: DML on registry tables; audit_log SELECT + INSERT only (append-only,
   enforced again by triggers); sequences; the two helper functions; plus default privileges, so later
   migrations stay covered.

Local:  cd app && python ../pipeline/setup_registry.py --app-name agent-registry-hub --endpoint projects/<p>/branches/production/endpoints/primary
Bundle: spark_python_task with --root ${workspace.file_path}
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

GRANTS = """
GRANT USAGE ON SCHEMA "{schema}" TO "{sp}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "{schema}" TO "{sp}";
REVOKE UPDATE, DELETE, TRUNCATE ON "{schema}".audit_log FROM "{sp}";
REVOKE INSERT, UPDATE, DELETE ON "{schema}".schema_migrations FROM "{sp}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{schema}" TO "{sp}";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "{schema}" TO "{sp}";
ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{sp}";
ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" GRANT USAGE, SELECT ON SEQUENCES TO "{sp}";
ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" GRANT EXECUTE ON FUNCTIONS TO "{sp}";
"""


def repo_root(arg: str | None) -> Path:
    return Path(arg) if arg else Path(__file__).resolve().parents[1]


def role_id_for(app_name: str) -> str:
    """Lakebase role ids must match ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ (a raw UUID is rejected)."""
    rid = re.sub(r"[^a-z0-9-]+", "-", f"sp-{app_name}".lower()).strip("-")[:63].rstrip("-")
    return rid if len(rid) >= 4 else (rid + "-app")[:63]


def ensure_oauth_role(w, branch: str, client_id: str, role_id: str) -> str:
    roles = (w.api_client.do("GET", f"/api/2.0/postgres/{branch}/roles") or {}).get("roles", [])
    for r in roles:
        if client_id in ((r.get("status") or {}).get("postgres_role"), (r.get("spec") or {}).get("postgres_role")):
            return f"exists ({r['name']})"
    w.api_client.do("POST", f"/api/2.0/postgres/{branch}/roles", query={"role_id": role_id}, body={"spec": {
        "identity_type": "SERVICE_PRINCIPAL", "postgres_role": client_id, "auth_method": "LAKEBASE_OAUTH_V1"}})
    for _ in range(60):  # role creation is a long-running operation
        try:
            w.api_client.do("GET", f"/api/2.0/postgres/{branch}/roles/{role_id}")
            return f"created ({branch}/roles/{role_id})"
        except Exception:  # noqa: BLE001 - not visible yet
            time.sleep(3)
    raise TimeoutError(f"role {role_id} not visible after 180 s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root")
    ap.add_argument("--app-name", default="agent-registry-hub")
    ap.add_argument("--endpoint", required=True, help="projects/<p>/branches/<b>/endpoints/<e>")
    ap.add_argument("--pg-schema", default="registry")
    ap.add_argument("--client-id", help="the app SP client id (default: looked up from --app-name)")
    ap.add_argument("--skip-grants", action="store_true", help="migrations only (e.g. before the app exists)")
    args = ap.parse_args()
    os.environ["LAKEBASE_ENDPOINT"] = args.endpoint
    os.environ["LAKEBASE_SCHEMA"] = args.pg_schema
    root = repo_root(args.root)
    os.environ.setdefault("MIGRATIONS_DIR", str(root / "pipeline" / "migrations"))
    sys.path.insert(0, str(root / "app"))

    from core import migrate
    from core.lakebase import Lakebase, workspace_client

    lb = Lakebase(application_name="agent-registry-hub-setup", schema=args.pg_schema)
    result = migrate.run(lb, schema=args.pg_schema, directory=root / "pipeline" / "migrations")
    print("migrations:", result)
    if args.skip_grants:
        lb.close()
        return
    w = workspace_client()
    sp = args.client_id or w.apps.get(args.app_name).service_principal_client_id
    branch = "/".join(args.endpoint.split("/")[:4])
    print(f"app {args.app_name}: service principal {sp}")
    print("lakebase oauth role:", ensure_oauth_role(w, branch, sp, role_id_for(args.app_name)))
    with lb.connection() as conn, conn.cursor() as cur:
        cur.execute(GRANTS.format(sp=sp, schema=args.pg_schema))
        conn.commit()
    rows = lb.query("""SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
                         FROM information_schema.role_table_grants WHERE grantee = %s AND table_schema = %s
                        GROUP BY 1 ORDER BY 1""", (sp, args.pg_schema))
    print(f"grants on {len(rows)} tables; audit_log:", next((r["privs"] for r in rows if r["table_name"] == "audit_log"), None))
    lb.close()


if __name__ == "__main__":
    main()
