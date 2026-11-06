"""Microsoft Agent 365 registrations → "Also registered in", from an admin-center export (tests/fixtures/agent365).

The fixture is shaped like Agents > All agents > Export (CSV, documented columns plus an ID and a source URL) and holds
one record per matching path: a Genie URL (exact id), an exact name, a name that is ambiguous for a Genie platform, a
misspelt name, an unknown Genie agent and a non-Databricks agent. Identities and hosts are fictitious.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from core import config, db, migrate
from registry import agent365, authz, demo_seed

FIX = Path(__file__).resolve().parent / "fixtures" / "agent365"
OWNER = "ana.ruiz@example.com"
ADMIN = "admin@example.com"
STEWARD = "lee.chen@example.com"
GENIE = "agent:genie:demo-claims"
SUP = "agent:endpoint:demo-care-supervisor"
KA = "agent:endpoint:demo-policy-ka"
CLAIMS_ID = "T_6f1c2a90-0d4e-4c55-9a8e-1b2c3d4e5f60"


@pytest.fixture
def client(pg_lb, use_lb, monkeypatch):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({ADMIN}))
    monkeypatch.delenv("AGENT365_CONNECTION", raising=False)
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
        cur.execute("INSERT INTO role_assignment (email, role, granted_by, reason) VALUES (%s, 'steward', %s, 'test')", (STEWARD, ADMIN))
    authz.invalidate_roles()
    import app as application
    return TestClient(application.app)


def as_(email: str) -> dict:
    return {"x-forwarded-email": email}


def export() -> str:
    return (FIX / "m365_all_agents_export.csv").read_text()


def detail(client, asset_id: str, who: str = OWNER) -> dict:
    from urllib.parse import quote
    r = client.get(f"/api/assets/{quote(asset_id, safe='')}", headers=as_(who))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_parse_and_match_rules():
    recs = [agent365.normalize(r) for r in agent365.parse_records(export(), "AgentRegistry.csv")]
    assert [r["databricks"] for r in recs] == [True, True, True, True, True, False]
    claims = recs[0]
    assert claims["external_id"] == CLAIMS_ID and claims["hints"]["genie_space_ids"] == ["demo-claims"]
    assert claims["hints"]["workspace_hosts"] == ["dbc-a1b2c3d4-e5f6.cloud.databricks.com"]
    agents = [{"asset_id": GENIE, "display_name": "Claims Analytics (Genie)", "name": "demo-claims", "subtype": "genie_space",
               "deep_link": "https://other-workspace.cloud.databricks.com/genie/rooms/demo-claims"}]
    m = agent365.match(claims, agents)
    assert m["asset_id"] == GENIE and m["method"] == "genie_space_id" and m["confidence"] == 0.5 and "another workspace" in m["note"]
    graph_page = agent365.parse_records((FIX / "m365_packages_page1.json").read_text())
    assert agent365.normalize(graph_page[0])["hints"]["genie_space_ids"] == ["demo-claims"]  # manifestId
    with pytest.raises(ValueError, match="header row"):
        agent365.parse_records("just,some\nvalues,here", "x.csv")


def test_import_matches_with_provenance_and_queues_unmatched_for_stewards(client):
    body = {"filename": "AgentRegistry.csv", "content": export()}
    assert client.post("/api/agent365/import", json=body, headers=as_(OWNER)).status_code == 403
    assert client.post("/api/agent365/import", json=body, headers=as_(STEWARD)).status_code == 403  # import is admin-only
    r = client.post("/api/agent365/import", json=body, headers=as_(ADMIN))
    assert r.status_code == 200, r.text
    counts = r.json()
    assert {k: counts[k] for k in ("records", "ignored_not_databricks", "matched", "suggested", "unmatched")} == \
        {"records": 6, "ignored_not_databricks": 1, "matched": 2, "suggested": 2, "unmatched": 1}
    assert counts["fields_changed"] == 2 and counts["assets_linked"] == 2

    g = detail(client, GENIE)["asset"]
    assert g["also_registered_in"] == [{"registry": "Microsoft Agent 365", "id": CLAIMS_ID,
                                        "url": "https://dbc-a1b2c3d4-e5f6.cloud.databricks.com/genie/rooms/demo-claims",
                                        "display_name": "Claims Analytics", "platform": "Databricks Genie", "match": "genie_space_id",
                                        "confidence": 1.0}]
    f = g["also_registered_in_field"]
    assert f["provenance"] == "source" and f["source_label"] == "Microsoft Agent 365" and f["source_synced_at"]
    s = detail(client, SUP)["asset"]["also_registered_in"]
    assert [(x["id"], x["match"], x["confidence"], x["url"]) for x in s] == \
        [("T_0a6b8c2d-4e1f-4a7b-8c9d-0e1f2a3b4c5d", "name", 0.9, agent365.ADMIN_CENTER_URL)]
    assert detail(client, KA)["asset"]["also_registered_in"] == []  # a suggestion is not a link
    assert not db.query("SELECT 1 FROM asset WHERE display_name ILIKE 'Supply Forecast%'")  # never creates assets

    assert client.get("/api/agent365", headers=as_(OWNER)).status_code == 403
    ov = client.get("/api/agent365", headers=as_(STEWARD)).json()["data"]
    assert ov["counts"] == {"matched": 2, "suggested": 2, "unmatched": 1} and ov["graph"]["configured"] is False
    queue = {r["display_name"]: r for r in ov["review"]}
    assert queue["Policy Docs Assistant"]["status"] == "suggested" and queue["Policy Docs Assistant"]["matched_asset_id"] == KA
    assert queue["Policy Docs Assistant"]["confidence"] == 0.8
    assert queue["Member Intake Agnt"]["matched_asset_id"] == "agent:endpoint:demo-intake-agent" and queue["Member Intake Agnt"]["confidence"] < 0.85
    assert queue["Supply Forecast Genie"]["status"] == "unmatched" and queue["Supply Forecast Genie"]["hints"]["genie_space_ids"] == \
        ["01f0aa11bb22cc33dd44ee55ff667788"]
    assert ov["runs"][0]["collector"] == "agent365" and ov["runs"][0]["triggered_by"] == ADMIN

    # idempotent: the same export changes nothing
    again = client.post("/api/agent365/import", json=body, headers=as_(ADMIN)).json()
    assert again["fields_changed"] == 0 and again["matched"] == 2

    # steward review: confirm the suggestion, dismiss the unknown agent; both decisions survive a re-import
    review = "/api/agent365/review"
    kid = queue["Policy Docs Assistant"]["external_id"]
    assert client.post(review, json={"external_id": kid, "action": "link", "reason": "ok"}, headers=as_(OWNER)).status_code == 403
    assert client.post(review, json={"external_id": kid, "action": "link"}, headers=as_(STEWARD)).status_code == 400
    ok = client.post(review, json={"external_id": kid, "action": "link", "reason": "Same knowledge assistant, confirmed with the owner"},
                     headers=as_(STEWARD))
    assert ok.status_code == 200 and ok.json()["status"] == "linked" and ok.json()["match_method"] == "steward"
    assert detail(client, KA)["asset"]["also_registered_in"][0]["id"] == kid
    sid = queue["Supply Forecast Genie"]["external_id"]
    assert client.post(review, json={"external_id": sid, "action": "dismiss", "reason": "Lives in another workspace"},
                       headers=as_(STEWARD)).json()["status"] == "dismissed"
    third = client.post("/api/agent365/import", json=body, headers=as_(ADMIN)).json()
    assert third["kept_steward_decision"] == 2 and third["fields_changed"] == 0
    assert db.query("SELECT status FROM external_registration WHERE external_id = %s", (sid,))[0]["status"] == "dismissed"

    # field-level provenance: a steward override needs a reason, wins over the source, and a source change raises drift
    from urllib.parse import quote
    url = f"/api/assets/{quote(GENIE, safe='')}/fields/also_registered_in"
    assert client.put(url, json={"value": []}, headers=as_(OWNER)).status_code == 403
    assert client.put(url, json={"value": []}, headers=as_(STEWARD)).status_code == 400
    over = client.put(url, json={"value": [], "reason": "Unlisted in M365 pending review"}, headers=as_(STEWARD))
    assert over.status_code == 200 and over.json()["provenance"] == "admin"
    assert detail(client, GENIE)["asset"]["also_registered_in"] == []
    moved = export().replace("genie/rooms/demo-claims", "genie/rooms/demo-claims?o=1")
    client.post("/api/agent365/import", json={"filename": "AgentRegistry.csv", "content": moved}, headers=as_(ADMIN))
    f = detail(client, GENIE, ADMIN)["asset"]["also_registered_in_field"]
    assert f["drift"] is True and f["value"] == [] and f["source_value"][0]["url"].endswith("?o=1")
    actions = {r["action"] for r in db.query("SELECT action FROM audit_log WHERE action LIKE 'agent365.%' OR action = 'field.override'")}
    assert {"agent365.import", "agent365.link", "agent365.dismiss", "field.override"} <= actions


def test_import_rejects_bad_files_and_tolerates_json_exports(client):
    bad = client.post("/api/agent365/import", json={"filename": "x.json", "content": "{not json"}, headers=as_(ADMIN))
    assert bad.status_code == 400 and "Not valid JSON" in bad.json()["detail"]
    page = (FIX / "m365_packages_page1.json").read_text()
    ok = client.post("/api/agent365/import", json={"filename": "packages.json", "content": page}, headers=as_(ADMIN)).json()
    assert ok["matched"] == 1 and ok["ignored_not_databricks"] == 1
    assert detail(client, GENIE)["asset"]["also_registered_in"][0]["match"] == "genie_space_id"
