import hashlib
import shutil
from pathlib import Path

import psycopg
import pytest

from core import migrate

BOOTSTRAP = Path(__file__).resolve().parents[1] / "pipeline" / "migrations" / "000_bootstrap.sql"


@pytest.fixture
def mig_dir(tmp_path):
    d = tmp_path / "migrations"
    d.mkdir()
    shutil.copy(BOOTSTRAP, d / BOOTSTRAP.name)
    return d


def ledger(pg_url, schema):
    with psycopg.connect(pg_url) as conn:
        return conn.execute(f'SELECT version, checksum, applied_at FROM "{schema}".schema_migrations ORDER BY version').fetchall()


def test_bootstrap_is_idempotent(pg_url, scratch_schema, mig_dir):
    from core.lakebase import Lakebase

    lb = Lakebase(url=pg_url, schema=scratch_schema)
    first = migrate.run(lb, directory=mig_dir)
    second = migrate.run(lb, directory=mig_dir)
    assert first["applied"] == ["000_bootstrap"] and first["skipped"] == []
    assert second["applied"] == [] and second["skipped"] == ["000_bootstrap"]
    rows = ledger(pg_url, scratch_schema)
    assert len(rows) == 1
    assert rows[0][0] == "000_bootstrap"
    assert rows[0][1] == hashlib.sha256(BOOTSTRAP.read_text(encoding="utf-8").encode()).hexdigest()


def test_applies_in_lexical_order_with_schema_substitution(pg_url, scratch_schema, mig_dir):
    (mig_dir / "010_later.sql").write_text("INSERT INTO {{schema}}.widgets (name) VALUES ('second');\n")
    (mig_dir / "001_widgets.sql").write_text("CREATE TABLE {{schema}}.widgets (id serial PRIMARY KEY, name text NOT NULL);\n"
                                             "INSERT INTO {{schema}}.widgets (name) VALUES ('first');\n")
    res = migrate.run(schema=scratch_schema, directory=mig_dir, lb=_lb(pg_url, scratch_schema))
    assert res["applied"] == ["000_bootstrap", "001_widgets", "010_later"]
    with psycopg.connect(pg_url) as conn:
        assert [r[0] for r in conn.execute(f'SELECT name FROM "{scratch_schema}".widgets ORDER BY id')] == ["first", "second"]
    assert [r[0] for r in ledger(pg_url, scratch_schema)] == ["000_bootstrap", "001_widgets", "010_later"]


def test_failed_migration_leaves_nothing_behind(pg_url, scratch_schema, mig_dir):
    (mig_dir / "001_broken.sql").write_text("CREATE TABLE {{schema}}.half (id int);\nSELECT * FROM {{schema}}.does_not_exist;\n")
    with pytest.raises(psycopg.errors.UndefinedTable):
        migrate.run(_lb(pg_url, scratch_schema), directory=mig_dir)
    assert [r[0] for r in ledger(pg_url, scratch_schema)] == ["000_bootstrap"]
    with psycopg.connect(pg_url) as conn:
        assert conn.execute("SELECT to_regclass(%s)", (f'"{scratch_schema}".half',)).fetchone()[0] is None


def test_edited_migration_is_rejected(pg_url, scratch_schema, mig_dir):
    lb = _lb(pg_url, scratch_schema)
    (mig_dir / "001_t.sql").write_text("CREATE TABLE {{schema}}.t (id int);\n")
    migrate.run(lb, directory=mig_dir)
    (mig_dir / "001_t.sql").write_text("CREATE TABLE {{schema}}.t (id bigint);\n")
    with pytest.raises(migrate.MigrationError, match="changed after it was applied"):
        migrate.run(lb, directory=mig_dir)


def test_no_transaction_marker(pg_url, scratch_schema, mig_dir):
    (mig_dir / "001_t.sql").write_text("CREATE TABLE {{schema}}.t (id int);\n")
    (mig_dir / "002_idx.sql").write_text("-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY t_id ON {{schema}}.t (id);\n")
    res = migrate.run(_lb(pg_url, scratch_schema), directory=mig_dir)
    assert res["applied"] == ["000_bootstrap", "001_t", "002_idx"]


def test_cli_status_and_apply(pg_url, scratch_schema, mig_dir, monkeypatch, capsys, use_lb):
    use_lb(_lb(pg_url, scratch_schema))
    assert migrate.main(["--dir", str(mig_dir), "--status"]) == 0
    assert "pending ['000_bootstrap']" in capsys.readouterr().out
    assert migrate.main(["--dir", str(mig_dir)]) == 0
    assert "applied ['000_bootstrap']" in capsys.readouterr().out
    assert migrate.main(["--dir", str(mig_dir / "missing")]) == 1
    assert "migrations directory not found" in capsys.readouterr().err


def _lb(pg_url, schema):
    from core.lakebase import Lakebase

    return Lakebase(url=pg_url, schema=schema)
