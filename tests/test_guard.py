import psycopg
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from psycopg import errors as pg_errors
from psycopg_pool import PoolTimeout

from core import config, guard
from core.lakebase import LakebaseNotConfigured, LakebaseUnavailable


class FakeLakebase:
    def __init__(self, up=True):
        self.up = up
        self.schema = "registry"

    def query(self, sql, params=None):
        if not self.up:
            raise LakebaseUnavailable("connection refused")
        return [{"ok": 1}]


def status_of(exc):
    with pytest.raises(HTTPException) as info:
        guard.guard(lambda: (_ for _ in ()).throw(exc))
    return info.value.status_code, info.value.detail


@pytest.mark.parametrize(
    ("exc", "status"),
    [
        (guard.WriteUnavailable("kiosk"), 503),
        (LakebaseUnavailable("down"), 503),
        (LakebaseNotConfigured("unset"), 503),
        (PoolTimeout("no connection"), 503),
        (psycopg.OperationalError("server closed the connection"), 503),
        (guard.Forbidden("not an owner"), 403),
        (pg_errors.InsufficientPrivilege("permission denied for table agents"), 403),
        (guard.NotFound("agent a1"), 404),
        (guard.Conflict("version changed"), 409),
        (pg_errors.UniqueViolation("duplicate key value"), 409),
        (pg_errors.ForeignKeyViolation("missing parent"), 409),
        (pg_errors.SerializationFailure("could not serialize access"), 409),
        (ValueError("name is required"), 400),
        (KeyError("owner"), 400),
        (pg_errors.CheckViolation("violates check constraint"), 400),
        (pg_errors.InvalidTextRepresentation("invalid input syntax for type uuid"), 400),
    ],
)
def test_guard_maps_known_failures(exc, status):
    assert status_of(exc)[0] == status


def test_guard_messages_are_useful():
    assert status_of(KeyError("owner")) == (400, "owner")
    assert status_of(guard.Conflict("version changed")) == (409, "version changed")
    code, detail = status_of(pg_errors.InsufficientPrivilege("permission denied"))
    assert code == 403 and "row-level security" in detail


def test_guard_passes_results_and_http_errors_through():
    assert guard.guard(lambda a, b=0: a + b, 1, b=2) == 3
    with pytest.raises(HTTPException) as info:
        guard.guard(lambda: (_ for _ in ()).throw(HTTPException(422, "bad")))
    assert info.value.status_code == 422


def test_unexpected_errors_propagate():
    with pytest.raises(RuntimeError, match="bug"):
        guard.guard(lambda: (_ for _ in ()).throw(RuntimeError("bug")))


def test_require_writes(monkeypatch, use_lb):
    use_lb(FakeLakebase(up=True))
    monkeypatch.setattr(config, "ALLOW_MUTATIONS", True)
    guard.require_writes()  # no exception

    monkeypatch.setattr(config, "ALLOW_MUTATIONS", False)
    with pytest.raises(HTTPException) as info:
        guard.require_writes()
    assert info.value.status_code == 503 and "ALLOW_MUTATIONS=false" in info.value.detail

    monkeypatch.setattr(config, "ALLOW_MUTATIONS", True)
    use_lb(FakeLakebase(up=False))
    with pytest.raises(HTTPException) as info:
        guard.require_writes()
    assert info.value.status_code == 503 and "Lakebase unavailable" in info.value.detail


def test_http_status_end_to_end(monkeypatch, use_lb):
    """The mapping as a client sees it, through a real FastAPI route."""
    use_lb(FakeLakebase(up=True))
    monkeypatch.setattr(config, "ALLOW_MUTATIONS", True)
    api = FastAPI()
    failures = {"forbidden": guard.Forbidden("no"), "conflict": guard.Conflict("busy"), "invalid": ValueError("bad name")}

    @api.post("/things/{kind}")
    def create(kind: str):
        guard.require_writes()
        return guard.guard(lambda: (_ for _ in ()).throw(failures[kind]) if kind in failures else {"created": kind})

    client = TestClient(api)
    assert client.post("/things/ok").json() == {"created": "ok"}
    assert client.post("/things/forbidden").status_code == 403
    assert client.post("/things/conflict").status_code == 409
    assert client.post("/things/invalid").json() == {"detail": "bad name"}
    monkeypatch.setattr(config, "ALLOW_MUTATIONS", False)
    assert client.post("/things/ok").status_code == 503
