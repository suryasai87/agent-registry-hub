import psycopg
import pytest

from core import audit, config, db

AUDIT_DDL = """
CREATE TABLE {schema}.audit_log (
    audit_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor       text NOT NULL,
    action      text NOT NULL,
    entity_type text NOT NULL,
    entity_id   text,
    before      jsonb,
    after       jsonb,
    request_id  text,
    source      text NOT NULL DEFAULT 'ui'
)"""


@pytest.fixture
def audit_db(pg_lb, use_lb, monkeypatch, scratch_schema):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "LAKEBASE_SCHEMA", scratch_schema)
    monkeypatch.setattr(config, "AUDIT_TABLE", "audit_log")
    db.execute(AUDIT_DDL.format(schema=f'"{scratch_schema}"'))
    db.execute(f'CREATE TABLE "{scratch_schema}".agents (id text PRIMARY KEY, owner text)')
    return pg_lb


def test_db_helpers_return_dict_rows(audit_db):
    assert db.execute("INSERT INTO agents VALUES (%s, %s), (%s, %s)", ("a1", "jane", "a2", "sam")) == 2
    assert db.query("SELECT id, owner FROM agents ORDER BY id") == [{"id": "a1", "owner": "jane"}, {"id": "a2", "owner": "sam"}]
    assert db.query_one("SELECT owner FROM agents WHERE id = %s", ("a2",)) == {"owner": "sam"}
    assert db.query_one("SELECT owner FROM agents WHERE id = %s", ("zz",)) is None


def test_transaction_commits_or_rolls_back(audit_db):
    with db.transaction() as cur:
        cur.execute("INSERT INTO agents VALUES ('a1', 'jane') RETURNING id")
        assert cur.fetchone() == {"id": "a1"}
    with pytest.raises(psycopg.errors.UniqueViolation):
        with db.transaction() as cur:
            cur.execute("INSERT INTO agents VALUES ('a2', 'sam')")
            cur.execute("INSERT INTO agents VALUES ('a1', 'dup')")
    assert [r["id"] for r in db.query("SELECT id FROM agents")] == ["a1"]  # a2 rolled back with the failure


def test_audit_event_appends_a_row(audit_db):
    audit.audit_event({"email": "jane.doe@example.com", "name": "Jane"}, "agent.update", "agent", "a1",
                      before={"owner": "sam"}, after={"owner": "jane", "at": __import__("datetime").date(2026, 1, 2)},
                      request_id="req-1")
    rows = db.query("SELECT actor, action, entity_type, entity_id, before, after, request_id, at FROM audit_log")
    assert len(rows) == 1
    row = rows[0]
    assert row["actor"] == "jane.doe@example.com" and row["action"] == "agent.update"
    assert row["entity_type"] == "agent" and row["entity_id"] == "a1" and row["request_id"] == "req-1"
    assert row["before"] == {"owner": "sam"} and row["after"] == {"owner": "jane", "at": "2026-01-02"}
    assert row["at"] is not None


def test_audit_row_is_atomic_with_the_change(audit_db):
    with pytest.raises(RuntimeError, match="abort"):
        with db.transaction() as cur:
            cur.execute("INSERT INTO agents VALUES ('a9', 'kim')")
            audit.audit_event("kim@example.com", "agent.create", "agent", "a9", after={"owner": "kim"}, cur=cur)
            raise RuntimeError("abort")
    assert db.query("SELECT count(*) AS n FROM audit_log") == [{"n": 0}]
    assert db.query("SELECT count(*) AS n FROM agents") == [{"n": 0}]

    with db.transaction() as cur:
        cur.execute("INSERT INTO agents VALUES ('a9', 'kim')")
        audit.audit_event("kim@example.com", "agent.create", "agent", "a9", after={"owner": "kim"}, cur=cur)
    assert db.query("SELECT entity_id, before FROM audit_log") == [{"entity_id": "a9", "before": None}]


def test_audit_event_validates_input(audit_db, monkeypatch):
    with pytest.raises(ValueError, match="actor"):
        audit.audit_event("", "x", "agent", "a1")
    with pytest.raises(ValueError, match="action"):
        audit.audit_event("a@b.com", "", "agent", "a1")
    monkeypatch.setattr(config, "AUDIT_TABLE", "audit_log; DROP TABLE agents")
    with pytest.raises(ValueError, match="invalid"):
        audit.audit_event("a@b.com", "x", "agent", "a1")
