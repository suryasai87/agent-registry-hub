"""End-to-end registry flows through the HTTP API, against the Docker Postgres (TEST_DATABASE_URL).

Each test runs on a fresh scratch schema with migrations applied and the deterministic demo fleet seeded.
Identities switch with the Databricks Apps SSO header (x-forwarded-email). Provisioning runs in
record_only mode (no DATABRICKS_CLIENT_ID), so nothing touches a real workspace.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from core import config, db, migrate
from registry import authz, demo_seed

OWNER = "ana.ruiz@example.com"        # owns the supervisor and the knowledge assistant
CONSUMER = "jo.park@example.com"
OTHER = "sam.ito@example.com"
ADMIN = "admin@example.com"
SUP = "agent:endpoint:demo-care-supervisor"
KA = "agent:endpoint:demo-policy-ka"
M365 = "mcp:system:system.ai.microsoft_365"


@pytest.fixture
def client(pg_lb, use_lb, monkeypatch):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({ADMIN}))
    monkeypatch.delenv("DATABRICKS_CLIENT_ID", raising=False)
    monkeypatch.setenv("PROVISIONING_MODE", "record_only")
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
    authz.invalidate_roles()
    import app as application
    return TestClient(application.app)


def as_(email: str, **extra) -> dict:
    return {"x-forwarded-email": email, **extra}


def enc(asset_id: str) -> str:
    from urllib.parse import quote
    return quote(asset_id, safe="")


def test_catalog_home_search(client):
    r = client.get("/api/catalog?page_size=50", headers=as_(CONSUMER))
    assert r.status_code == 200 and r.json()["source"] == "lakebase"
    data = r.json()["data"]
    assert data["total"] == 11 and data["facets"]["asset_type"]["agent"] == 4
    agents = client.get("/api/catalog?type=agent", headers=as_(CONSUMER)).json()["data"]
    assert {i["asset_type"] for i in agents["items"]} == {"agent"}
    assert agents["facets"]["asset_type"]["mcp_server"] == 3  # a facet ignores its own filter
    card = next(i for i in data["items"] if i["asset_id"] == SUP)
    assert card["owners"][0]["email"] == OWNER and len(card["kpi"]["spark"]) == 14
    assert client.get("/api/search?q=claims", headers=as_(CONSUMER)).json()["data"][0]["id"] == "agent:genie:demo-claims"
    home = client.get("/api/home", headers=as_(OWNER)).json()["data"]
    assert home["kpis"]["agents"] == 4
    me = client.get("/api/me", headers=as_(OWNER)).json()["data"]
    assert "owner" in me["roles"] and me["primary_role"] == "owner"


def test_unknown_asset_is_404_not_synthetic(client):
    r = client.get(f"/api/assets/{enc('agent:endpoint:nope')}", headers=as_(CONSUMER))
    assert r.status_code == 404


def test_subscribe_requires_email_and_records_lineage(client):
    url = f"/api/assets/{enc(SUP)}/subscriptions"
    assert client.post(url, json={"subscriber_email": "not-an-email"}, headers=as_(OTHER)).status_code == 400
    assert client.post(url, json={"subscriber_email": "someone@example.com"}, headers=as_(OTHER)).status_code == 403
    ok = client.post(url, json={"subscriber_email": OTHER, "notify_emails": ["care-team@example.com"], "notify_pref": "all",
                                "downstream_asset_id": "agent:endpoint:demo-intake-agent"}, headers=as_(OTHER))
    assert ok.status_code == 200, ok.text
    s = ok.json()
    assert s["relationship"] == "via_downstream" and s["notify_emails"] == ["care-team@example.com"]
    dup = client.post(url, json={"subscriber_email": OTHER, "downstream_asset_id": "agent:endpoint:demo-intake-agent"}, headers=as_(OTHER))
    assert dup.status_code == 409
    team = client.post(url, json={"subscriber_email": "care-team@example.com", "subscriber_kind": "team"}, headers=as_(OTHER))
    assert team.status_code == 200
    edges = db.query("SELECT src_id, relation, edge_kind FROM lineage_edge WHERE dst_id = %s AND source = 'subscription'", (SUP,))
    assert {"src_id": "agent:endpoint:demo-intake-agent", "relation": "calls_agent", "edge_kind": "declared"} in edges
    assert any(e["src_id"] == f"user:{OTHER}" and e["relation"] == "subscribes" for e in edges)
    assert "consumer" in client.get("/api/me", headers=as_(OTHER)).json()["data"]["roles"]


def test_field_provenance_override_and_drift(client):
    base = f"/api/assets/{enc(SUP)}/fields"
    own = client.put(f"{base}/description", json={"value": "Routes care-ops questions."}, headers=as_(OWNER))
    assert own.status_code == 200 and own.json()["provenance"] == "owner"
    # purpose is auto-pulled (has a source value): owners can't override it, admins need a reason
    assert client.put(f"{base}/purpose", json={"value": "x"}, headers=as_(OWNER)).status_code == 403
    assert client.put(f"{base}/purpose", json={"value": "Better purpose"}, headers=as_(ADMIN)).status_code == 400
    ov = client.put(f"{base}/purpose", json={"value": "Better purpose", "reason": "clarify scope"}, headers=as_(ADMIN))
    assert ov.status_code == 200 and ov.json()["provenance"] == "admin" and ov.json()["value"] == "Better purpose"
    # a later sync changes the source value under the 'keep' override → drift (simulated as the collector does)
    db.execute("UPDATE asset_field SET source_value = '\"New upstream text\"', drift = true WHERE asset_id = %s AND field_key = 'purpose'", (SUP,))
    detail = client.get(f"/api/assets/{enc(SUP)}", headers=as_(ADMIN)).json()["data"]
    f = next(x for x in detail["fields"] if x["field_key"] == "purpose")
    assert f["drift"] and f["value"] == "Better purpose" and f["source_value"] == "New upstream text"
    kept = client.post(f"{base}/purpose/resolve-drift", json={"action": "keep"}, headers=as_(ADMIN))
    assert kept.status_code == 200 and not kept.json()["drift"]
    rev = client.post(f"{base}/purpose/revert", json={}, headers=as_(ADMIN))
    assert rev.json()["provenance"] == "source" and rev.json()["value"] == "New upstream text"
    hist = client.get(f"{base}/history", headers=as_(OWNER)).json()["data"]
    assert len(hist) >= 3


def test_access_request_approve_provision_record_only(client):
    url = f"/api/assets/{enc(SUP)}/access-requests"
    assert client.post(url, json={"justification": "too short"}, headers=as_(CONSUMER)).status_code == 400
    r = client.post(url, json={"justification": "Building the care-ops intake bot for Q4", "duration_days": 30,
                               "subscribe_email": CONSUMER}, headers=as_(CONSUMER))
    assert r.status_code == 200, r.text
    req = r.json()
    assert req["status"] == "pending" and req["approvers"] == [OWNER] and req["privilege"] == "CAN_QUERY"
    assert client.post(url, json={"justification": "Building the care-ops intake bot for Q4"}, headers=as_(CONSUMER)).status_code == 409
    rid = req["request_id"]
    assert client.post(f"/api/requests/{rid}/decision", json={"decision": "approve"}, headers=as_(CONSUMER)).status_code == 403
    assert client.post(f"/api/requests/{rid}/decision", json={"decision": "deny"}, headers=as_(OWNER)).status_code == 400
    review = client.get("/api/requests?scope=review", headers=as_(OWNER)).json()["data"]
    assert review[0]["request_id"] == rid and review[0]["can_decide"]
    d = client.post(f"/api/requests/{rid}/decision", json={"decision": "approve", "duration_days": 14}, headers=as_(OWNER))
    assert d.status_code == 200, d.text
    out = d.json()
    assert out["status"] == "provisioned" and out["provision_detail"]["mode"] == "record_only"
    assert "serving-endpoints" in (out["provision_detail"]["statement"] or "")
    g = db.query("SELECT * FROM access_grant WHERE principal = %s AND source = 'app'", (CONSUMER,))
    assert len(g) == 1 and g[0]["expires_at"] - datetime.now(timezone.utc) < timedelta(days=15)
    assert db.query("SELECT 1 FROM subscription WHERE subscriber_email = %s AND asset_id = %s", (CONSUMER, SUP))
    kinds = {n["kind"] for n in db.query("SELECT kind FROM notification WHERE recipient_email = %s", (CONSUMER,))}
    assert {"access_request_submitted", "access_decision", "subscription_confirmed"} <= kinds
    revoked = client.post(f"/api/grants/{g[0]['grant_id']}/revoke", json={"reason": "project ended"}, headers=as_(OWNER))
    assert revoked.status_code == 200 and revoked.json()["revoked_by"] == OWNER


def test_publish_change_freezes_impact_and_ack(client):
    client.post(f"/api/assets/{enc(SUP)}/subscriptions", json={"subscriber_email": CONSUMER}, headers=as_(CONSUMER))
    url = f"/api/assets/{enc(KA)}/changes"
    body = {"change_kinds": ["tools_removed"], "breaking": True, "title": "Drop the legacy policy index", "summary": "Index v1 retired"}
    assert client.post(url, json=body, headers=as_(CONSUMER)).status_code == 403
    assert client.post(url, json=body, headers=as_(OWNER)).status_code == 409  # breaking needs ≥14 d notice + release notes
    prev = client.post(f"{url}/preview", json=body, headers=as_(OWNER)).json()
    assert any(c["name"].startswith("Breaking changes") and not c["passed"] for c in prev["checks"])
    assert any(i["impacted_key"] == SUP for i in prev["downstream"])
    body.update({"effective_at": (datetime.now(timezone.utc) + timedelta(days=15)).isoformat(), "release_notes": "Use index v2.", "to_version": "v2"})
    pub = client.post(url, json=body, headers=as_(OWNER))
    assert pub.status_code == 200, pub.text
    detail = pub.json()
    types = {(i["impact_type"], i["impacted_key"]) for i in detail["impact"]}
    assert ("downstream_asset", SUP) in types                       # the supervisor calls the KA
    assert ("subscriber", CONSUMER) in types                        # subscribed to the downstream supervisor (breaking → 2 hops)
    assert ("observed_consumer", OTHER) in types                    # used the KA, never registered
    assert detail["change"]["breaking"] and detail["metrics_before"]["requests"] > 0
    cid = detail["change"]["change_id"]
    assert client.post(f"/api/changes/{cid}/ack", json={"status": "impacted_will_migrate"}, headers=as_(CONSUMER)).status_code == 400
    ack = client.post(f"/api/changes/{cid}/ack", json={"status": "impacted_will_migrate", "migrate_by": "2026-11-30"}, headers=as_(CONSUMER))
    assert ack.status_code == 200
    feed = client.get(f"/api/changes?asset_id={enc(KA)}", headers=as_(CONSUMER)).json()["data"]
    assert feed[0]["my_ack"] == "impacted_will_migrate" and feed[0]["impacted_people"] >= 2
    mine = client.get("/api/me/impacts", headers=as_(CONSUMER)).json()["data"]
    assert mine and mine[0]["change"]["change_id"] == cid
    assert db.query("SELECT 1 FROM notification WHERE recipient_email = %s AND kind = 'unregistered_consumer'", (OTHER,))


def test_lineage_privacy_and_depth(client):
    url = f"/api/lineage?focus={enc(SUP)}&depth=2"
    viewer = client.get(url, headers=as_("viewer@example.com")).json()["data"]
    ids = {n["id"] for n in viewer["nodes"]}
    assert {KA, "agent:genie:demo-claims", "tool:uc:demo.care_tools.member_risk", "table:demo.claims.claim_lines"} <= ids
    assert not any(i.startswith("user:") for i in ids) and any(n["subtype"] == "cluster" for n in viewer["nodes"])
    owner = client.get(url, headers=as_(OWNER)).json()["data"]
    assert any(n["id"] == f"user:{CONSUMER}" for n in owner["nodes"])
    kinds = {e["edge_kind"] for e in owner["edges"]}
    assert {"declared", "observed", "data"} <= kinds


def test_usage_scope_and_policies(client):
    own = client.get(f"/api/assets/{enc(SUP)}/usage", headers=as_(OWNER)).json()["data"]
    assert own["scope"] == "all" and own["kpis"]["cost_usd"] > 0 and own["kpis"]["usd_per_1k_requests"]
    assert any(not c["subscribed"] for c in own["by_consumer"])
    mine = client.get(f"/api/assets/{enc(SUP)}/usage", headers=as_(CONSUMER)).json()["data"]
    assert mine["scope"] == "self" and {c["requester"] for c in mine["by_consumer"]} <= {CONSUMER}
    pol = client.get(f"/api/assets/{enc(SUP)}/policies", headers=as_(CONSUMER)).json()["data"]
    assert any(c["kind"] == "guardrail" for c in pol["chips"]) and 0 <= pol["coverage"]["pct"] <= 100
    m365 = client.get(f"/api/assets/{enc(M365)}/policies", headers=as_(CONSUMER)).json()["data"]
    assert any(c["inherited_from"] == "platform default" for c in m365["chips"])
    fleet = client.get("/api/policies", headers=as_(CONSUMER)).json()["data"]
    assert fleet["gaps"] and fleet["coverage_pct"] > 0
    budget = client.put(f"/api/assets/{enc(SUP)}/budget", json={"monthly_usd": 50, "alert_pct": 80}, headers=as_(OWNER))
    assert budget.status_code == 200 and budget.json()["state"] in ("on_track", "at_risk", "exceeded")


def test_usage_registration_api_requires_email(client):
    assert client.post("/api/v1/usage", json={"asset_id": M365, "operation": "invoke"}, headers=as_(OTHER)).status_code == 400
    ok = client.post("/api/v1/usage", json={"asset_id": M365, "consumer_email": "Bot.Owner@Example.com", "operation": "tool_call",
                                            "via_asset_id": SUP}, headers=as_(OTHER))
    assert ok.status_code == 200
    ev = db.query("SELECT consumer_email, via_asset_id FROM usage_event WHERE event_id = %s", (ok.json()["event_id"],))
    assert ev == [{"consumer_email": "bot.owner@example.com", "via_asset_id": SUP}]
    assert db.query("SELECT 1 FROM lineage_edge WHERE src_id = 'user:bot.owner@example.com' AND dst_id = %s", (M365,))


def test_runtime_roles_audit_chain(client):
    p = client.post(f"/api/assets/{enc(SUP)}/runtime", json={"action": "pause", "reason": "incident 4411"}, headers=as_(OWNER))
    assert p.status_code == 200 and p.json()["change"]["change_kinds"] == ["runtime"]
    assert client.post("/api/governance/roles", json={"email": CONSUMER, "role": "steward", "reason": "x"}, headers=as_(OWNER)).status_code == 403
    assert client.post("/api/governance/roles", json={"email": "steward@example.com", "role": "steward", "reason": "care-ops steward"},
                       headers=as_(ADMIN)).status_code == 200
    authz.invalidate_roles()
    assert "steward" in client.get("/api/me", headers=as_("steward@example.com")).json()["data"]["roles"]
    preview = client.get("/api/me", headers=as_(ADMIN, **{"x-registry-view-as": "viewer"})).json()["data"]
    assert preview["roles"] == ["viewer"] and preview["view_as"] == "viewer" and preview["is_admin"]
    v = client.get("/api/audit/verify", headers=as_(ADMIN)).json()["data"]
    assert v["intact"] and v["checked"] >= 3
    assert client.get("/api/audit/verify", headers=as_(CONSUMER)).status_code == 403
    csv = client.get("/api/audit/export?format=csv", headers=as_(ADMIN))
    assert csv.status_code == 200 and "change.publish" in csv.text


def test_register_skill_md(client):
    md = "---\nname: cohort-builder\ndescription: Build RWE cohorts from OMOP tables.\nallowed-tools: [Read, Bash]\nlicense: Apache-2.0\n---\n# Steps\n1. Pick index event."
    r = client.post("/api/skills", json={"skill_md": md}, headers=as_(OWNER))
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["asset_type"] == "skill" and card["lifecycle_status"] == "pending_approval" and card["my"]["owner"]
    bad = client.post("/api/skills", json={"skill_md": "---\nname: Bad Name\ndescription: x\n---\n"}, headers=as_(OWNER))
    assert bad.status_code == 400
    cur = client.post(f"/api/governance/curation/{enc(card['asset_id'])}", json={"action": "approve", "reason": "reviewed"}, headers=as_(ADMIN))
    assert cur.status_code == 200 and cur.json()["lifecycle_status"] == "approved"


def test_synthetic_fallback_when_lakebase_down(client, unreachable_lb, use_lb):
    use_lb(unreachable_lb)
    r = client.get("/api/catalog", headers=as_(CONSUMER))
    assert r.status_code == 200 and r.json()["source"] == "synthetic" and r.json()["data"]["total"] > 0
    assert client.get(f"/api/assets/{enc(SUP)}", headers=as_(CONSUMER)).json()["source"] == "synthetic"
    w = client.post(f"/api/assets/{enc(SUP)}/subscriptions", json={"subscriber_email": CONSUMER}, headers=as_(CONSUMER))
    assert w.status_code == 503


def test_mcp_subregistry_lists_servers_in_server_json_form(client):
    r = client.get("/v0.1/servers?limit=2")
    assert r.status_code == 200
    body = r.json()
    assert body["metadata"]["count"] == 2 and "nextCursor" in body["metadata"]
    import re
    for entry in body["servers"]:
        s = entry["server"]
        assert re.fullmatch(r"[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+", s["name"]) and len(s["description"]) <= 100
        assert entry["_meta"]["io.modelcontextprotocol.registry/official"]["status"] == "active"
        assert entry["_meta"]["com.databricks.agent-registry-hub"]["asset_id"].startswith("mcp:")
    nxt = client.get(f"/v0.1/servers?limit=2&cursor={body['metadata']['nextCursor']}").json()
    assert nxt["metadata"]["count"] == 1
    m365 = next(e for e in body["servers"] + nxt["servers"] if e["_meta"]["com.databricks.agent-registry-hub"]["asset_id"] == M365)
    assert m365["server"]["remotes"][0]["url"].endswith("/ai-gateway/mcp-services/system.ai.microsoft_365")
    one = client.get(f"/v0.1/servers/{m365['server']['name']}/versions/latest")
    assert one.status_code == 200 and one.json()["server"]["title"] == "Microsoft 365"
