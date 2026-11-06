"""The Agent 365 collector: off unless an admin configures a UC HTTP connection; then it pages Microsoft Graph through
``POST /api/2.0/external-function`` (the connection holds the Entra credential) and feeds ``registry/agent365.ingest``."""
from __future__ import annotations

import json
from pathlib import Path

from collectors import base
from core import db
from registry import demo_seed

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "agent365"
PAGE1 = (FIX / "m365_packages_page1.json").read_bytes()
PAGE2 = (FIX / "m365_packages_page2.json").read_bytes()


def test_agent365_is_optional_and_skipped_without_a_connection(registry, ctx_factory, q, monkeypatch):
    monkeypatch.delenv("AGENT365_CONNECTION", raising=False)
    assert "agent365" not in base.resolve(None)  # a default sync does not run it
    res = base.run_all(["agent365"], "test", ctx=ctx_factory(), backfill=False)
    assert res["ok"] is True and res["runs"][0]["status"] == "skipped"
    row = q("SELECT status, error FROM sync_run WHERE collector = 'agent365'")[0]
    assert row["status"] == "skipped" and "AGENT365_CONNECTION" in row["error"]
    monkeypatch.setenv("AGENT365_CONNECTION", "none")
    assert "agent365" not in base.resolve(None)


def test_agent365_pages_graph_through_the_uc_connection(registry, ctx_factory, ws, q, monkeypatch):
    monkeypatch.setenv("AGENT365_CONNECTION", "m365_graph")
    assert base.resolve(None)[-1] == "agent365"
    with db.transaction() as cur:
        demo_seed.seed(cur)

    def external_function(_query, body):
        return {"contents": PAGE2 if body.get("params") else PAGE1}
    ws.post("/api/2.0/external-function", external_function)
    ctx = ctx_factory()
    res = base.run_all(["agent365"], "test", ctx=ctx, backfill=False)
    assert res["runs"][0]["status"] == "succeeded", res
    calls = [r for r in ctx.requests if r[1] == "/api/2.0/external-function"]
    assert [c[3]["path"] for c in calls] == ["/v1.0/copilot/admin/catalog/packages"] * 2
    assert calls[0][3]["connection_name"] == "m365_graph" and calls[0][3]["method"] == "GET" and "params" not in calls[0][3]
    assert json.loads(calls[1][3]["params"]) == {"$skiptoken": "page2"}
    assert not any("secret" in json.dumps(c[3]).lower() or "authorization" in json.dumps(c[3]).lower() for c in calls)
    rows = {r["display_name"]: r for r in q("SELECT * FROM external_registration")}
    assert set(rows) == {"Claims Analytics", "Supply Forecast Genie"}  # HR Helper (Copilot Studio) is ignored
    assert rows["Claims Analytics"]["status"] == "matched" and rows["Claims Analytics"]["source"] == "graph"
    f = q("SELECT source_value, source_label FROM asset_field WHERE asset_id = 'agent:genie:demo-claims' AND field_key = 'also_registered_in'")[0]
    assert f["source_label"] == "Microsoft Agent 365" and f["source_value"][0]["id"] == "T_6f1c2a90-0d4e-4c55-9a8e-1b2c3d4e5f60"
    run = q("SELECT detail FROM sync_run WHERE collector = 'agent365'")[0]
    assert run["detail"]["matched"] == 1 and run["detail"]["unmatched"] == 1 and run["detail"]["ignored_not_databricks"] == 1
