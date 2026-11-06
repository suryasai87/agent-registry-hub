"""Tiny, idempotent migration runner for the Lakebase schema.

Applies ``pipeline/migrations/*.sql`` in lexical order. Each file runs in its own transaction together with
its ``<schema>.schema_migrations(version, applied_at, checksum)`` row, so a failed migration leaves nothing
behind. ``{{schema}}`` in the SQL is replaced with the target schema. Already-applied files are skipped;
an applied file whose content changed is an error (add a new migration instead of editing an old one).

A file whose first line is ``-- migrate:no-transaction`` runs in autocommit mode (for statements such as
``CREATE INDEX CONCURRENTLY`` that cannot run inside a transaction); it is recorded after it succeeds.

A session advisory lock serialises concurrent runners (several app instances starting at once).

CLI (cwd ``app/``)::

    python -m core.migrate             # apply pending migrations
    python -m core.migrate --status    # list applied / pending without changing anything
    python -m core.migrate --dir ../pipeline/migrations --schema registry
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from psycopg import sql

from core import config

log = logging.getLogger("registry.migrate")

DEFAULT_DIR = Path(os.environ.get("MIGRATIONS_DIR") or Path(__file__).resolve().parents[2] / "pipeline" / "migrations")
NO_TRANSACTION = "-- migrate:no-transaction"


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    version: str
    path: Path
    text: str

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()

    @property
    def transactional(self) -> bool:
        first = self.text.lstrip().splitlines()[0].strip().lower() if self.text.strip() else ""
        return first != NO_TRANSACTION

    def render(self, schema: str) -> str:
        return self.text.replace("{{schema}}", schema)


def discover(directory: Path | str = DEFAULT_DIR) -> list[Migration]:
    root = Path(directory)
    if not root.is_dir():
        raise MigrationError(f"migrations directory not found: {root}")
    return [Migration(p.stem, p, p.read_text(encoding="utf-8")) for p in sorted(root.glob("*.sql"))]


def _table(schema: str) -> sql.Composed:
    return sql.SQL("{}.schema_migrations").format(sql.Identifier(schema))


def applied(conn, schema: str) -> dict[str, str]:
    """{version: checksum} already recorded (empty before the bootstrap migration ran)."""
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f'"{schema}".schema_migrations',))
        row = cur.fetchone()
        if not row or not row[0]:
            return {}
        cur.execute(sql.SQL("SELECT version, checksum FROM {} ORDER BY version").format(_table(schema)))
        return {v: c for v, c in cur.fetchall()}


def _record(cur, schema: str, m: Migration) -> None:
    cur.execute(sql.SQL("INSERT INTO {} (version, checksum) VALUES (%s, %s)").format(_table(schema)), (m.version, m.checksum))


def _apply(conn, schema: str, m: Migration) -> None:
    body = m.render(schema)
    if m.transactional:
        with conn.transaction(), conn.cursor() as cur:
            cur.execute(body)
            try:
                _record(cur, schema, m)
            except Exception as e:
                raise MigrationError(f"{m.path.name} ran but could not be recorded; 000_bootstrap.sql must create "
                                     f"{schema}.schema_migrations ({type(e).__name__}: {e})") from e
        return
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(body)
            _record(cur, schema, m)
    finally:
        conn.autocommit = False


def run(lb=None, *, schema: str | None = None, directory: Path | str | None = None, dry_run: bool = False) -> dict:
    """Apply pending migrations. Returns {"schema", "applied": [...], "skipped": [...], "pending": [...]}."""
    from core import db

    lb = lb or db.lb
    schema = config.ident(schema or lb.schema, "schema")
    migrations = discover(directory or DEFAULT_DIR)
    lock_key = f"{config.APP_NAME}:migrations:{schema}"
    result: dict = {"schema": schema, "applied": [], "skipped": [], "pending": []}
    with lb.direct_connection(autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (lock_key,))
        try:
            conn.autocommit = False
            done = applied(conn, schema)
            conn.commit()
            for m in migrations:
                if m.version in done:
                    if done[m.version] != m.checksum:
                        raise MigrationError(f"{m.path.name} changed after it was applied (checksum mismatch); "
                                             "add a new migration instead of editing an applied one")
                    result["skipped"].append(m.version)
                    continue
                if dry_run:
                    result["pending"].append(m.version)
                    continue
                log.info("applying %s to schema %s", m.path.name, schema)
                _apply(conn, schema, m)
                result["applied"].append(m.version)
        finally:
            try:
                if not conn.closed:
                    conn.rollback()
                    conn.autocommit = True
                    conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (lock_key,))
            except Exception as e:  # noqa: BLE001 - never mask the migration's own error
                log.warning("migration lock not released explicitly (it is released when the session ends): %s",
                            type(e).__name__)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m core.migrate", description="Apply pipeline/migrations/*.sql to Lakebase.")
    parser.add_argument("--dir", default=str(DEFAULT_DIR), help="migrations directory (default: %(default)s)")
    parser.add_argument("--schema", default=None, help="target schema (default: LAKEBASE_SCHEMA)")
    parser.add_argument("--status", action="store_true", help="list applied and pending migrations without applying")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(levelname)s %(name)s: %(message)s")
    from core.lakebase import Lakebase

    lb = Lakebase(schema=args.schema) if args.schema else None
    try:
        res = run(lb, schema=args.schema, directory=args.dir, dry_run=args.status)
    except Exception as e:  # noqa: BLE001 - CLI: one clear line, non-zero exit
        print(f"migration failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    finally:
        if lb is not None:
            lb.close()
    print(f"schema {res['schema']}: applied {res['applied'] or 'none'}; already applied {res['skipped'] or 'none'}"
          + (f"; pending {res['pending']}" if args.status else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
