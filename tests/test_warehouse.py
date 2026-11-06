from datetime import date, datetime
from decimal import Decimal

import pytest

from core import config, warehouse


class FakeApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def do(self, method, path, body=None, **_):
        self.calls.append((method, path, body))
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, *responses):
        self.api_client = FakeApi(responses)


MANIFEST = {"schema": {"columns": [
    {"name": "name", "type_name": "STRING"}, {"name": "calls", "type_name": "LONG"}, {"name": "cost", "type_name": "DECIMAL"},
    {"name": "p95", "type_name": "DOUBLE"}, {"name": "active", "type_name": "BOOLEAN"}, {"name": "tags", "type_name": "ARRAY"},
]}}


def test_positional_markers_become_named_and_literals_are_untouched():
    sql = "SELECT '?' AS q, `a?b`, \"x?\" FROM t -- why?\nWHERE a = ? /* and ? */ AND b = ? AND c = 'it''s ?'"
    out = warehouse.positional_to_named(sql, 2)
    assert out == "SELECT '?' AS q, `a?b`, \"x?\" FROM t -- why?\nWHERE a = :p0 /* and ? */ AND b = :p1 AND c = 'it''s ?'"
    with pytest.raises(ValueError, match="2 '\\?' markers but 1"):
        warehouse.positional_to_named("a = ? AND b = ?", 1)


def test_parameter_types():
    assert warehouse.parameter("p", None) == {"name": "p", "type": "STRING"}  # no value = NULL
    assert warehouse.parameter("p", True) == {"name": "p", "value": "true", "type": "BOOLEAN"}
    assert warehouse.parameter("p", 7) == {"name": "p", "value": "7", "type": "BIGINT"}
    assert warehouse.parameter("p", 1.5) == {"name": "p", "value": "1.5", "type": "DOUBLE"}
    assert warehouse.parameter("p", Decimal("12.345")) == {"name": "p", "value": "12.345", "type": "DECIMAL(5,3)"}
    assert warehouse.parameter("p", date(2026, 1, 2))["type"] == "DATE"
    assert warehouse.parameter("p", datetime(2026, 1, 2, 3, 4))["value"] == "2026-01-02T03:04:00"
    with pytest.raises(ValueError, match="unsupported"):
        warehouse.parameter("p", [1, 2])


def test_wait_timeout_must_be_5_to_50_seconds():
    assert warehouse.validate_wait_timeout("50s") == "50s"
    assert warehouse.validate_wait_timeout("5s") == "5s"
    for bad in ("60s", "4s", "0s", "50", "30 s", ""):
        with pytest.raises(ValueError):
            warehouse.validate_wait_timeout(bad)


def test_execute_builds_the_request_and_converts_rows(monkeypatch):
    monkeypatch.setattr(config, "WAREHOUSE_ID", "wh-123")
    client = FakeClient({
        "statement_id": "st-1", "status": {"state": "SUCCEEDED"}, "manifest": MANIFEST,
        "result": {"data_array": [["triage", "42", "1.50", "0.25", "true", "[\"a\",\"b\"]"]], "next_chunk_index": 1},
    }, {"data_array": [["router", None, None, None, "false", None]]})
    rows = warehouse.execute("SELECT * FROM system.serving.endpoints WHERE name = ? AND calls > ?", ["triage", 3], client=client)
    method, path, body = client.api_client.calls[0]
    assert (method, path) == ("POST", "/api/2.0/sql/statements/")
    assert body["warehouse_id"] == "wh-123"
    assert body["wait_timeout"] == "50s"
    assert body["on_wait_timeout"] == "CANCEL"
    assert body["statement"].endswith("WHERE name = :p0 AND calls > :p1")
    assert body["parameters"] == [{"name": "p0", "value": "triage", "type": "STRING"}, {"name": "p1", "value": "3", "type": "BIGINT"}]
    assert client.api_client.calls[1][:2] == ("GET", "/api/2.0/sql/statements/st-1/result/chunks/1")
    assert rows == [
        {"name": "triage", "calls": 42, "cost": Decimal("1.50"), "p95": 0.25, "active": True, "tags": ["a", "b"]},
        {"name": "router", "calls": None, "cost": None, "p95": None, "active": False, "tags": None},
    ]


def test_named_params_pass_through(monkeypatch):
    monkeypatch.setattr(config, "WAREHOUSE_ID", "wh-123")
    client = FakeClient({"statement_id": "s", "status": {"state": "SUCCEEDED"}, "manifest": {"schema": {"columns": []}}, "result": {}})
    assert warehouse.execute("SELECT :name", {"name": "x"}, client=client) == []
    assert client.api_client.calls[0][2]["parameters"] == [{"name": "name", "value": "x", "type": "STRING"}]


def test_failures_raise(monkeypatch):
    monkeypatch.setattr(config, "WAREHOUSE_ID", "")
    with pytest.raises(warehouse.WarehouseNotConfigured):
        warehouse.execute("SELECT 1")
    monkeypatch.setattr(config, "WAREHOUSE_ID", "wh-123")
    failed = FakeClient({"status": {"state": "FAILED", "error": {"message": "[TABLE_OR_VIEW_NOT_FOUND] nope"}}})
    with pytest.raises(warehouse.WarehouseError, match="FAILED: \\[TABLE_OR_VIEW_NOT_FOUND\\] nope"):
        warehouse.execute("SELECT * FROM nope", client=failed)
    slow = FakeClient({"status": {"state": "CANCELED"}})
    with pytest.raises(warehouse.WarehouseError, match="did not finish within 50s"):
        warehouse.execute("SELECT 1", client=slow)
    with pytest.raises(ValueError):
        warehouse.execute("SELECT 1", wait_timeout="60s", client=slow)


def test_status_never_raises(monkeypatch):
    monkeypatch.setattr(config, "WAREHOUSE_ID", "")
    assert warehouse.status() == {"configured": False}
    monkeypatch.setattr(config, "WAREHOUSE_ID", "wh-123")
    assert warehouse.status(client=FakeClient({"state": "RUNNING", "name": "Shared"})) == {"configured": True, "ok": True, "state": "RUNNING", "name": "Shared"}

    class Broken:
        @property
        def api_client(self):
            raise PermissionError("no CAN_USE on warehouse")

    out = warehouse.status(client=Broken())
    assert out["ok"] is False and "PermissionError" in out["error"]
