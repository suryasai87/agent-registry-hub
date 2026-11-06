"""MCP tool selection on a Unity Catalog MCP service: validation, live preview, authz, breaking change_event + impact,
record_only request, and the platform PATCH (faked) with etag and snapshot handling.

The demo service (demo_seed.seed_extended) selects ``lookup_*`` + ``create_ticket``; it knows four tools (``close_ticket``
is hidden today). The intake agent calls ``create_ticket``; the supervisor declares the service; jo.park subscribes.
"""
from __future__ import annotations

from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from core import config, db, migrate
from registry import authz, demo_seed, provision, synthetic, tool_selection

OWNER = "lee.chen@example.com"        # owns the demo MCP service
OTHER_OWNER = "ana.ruiz@example.com"  # owns other assets, not this one
CONSUMER = "jo.park@example.com"
ADMIN = "admin@example.com"
SVC = synthetic.CARE_MCP
BASE = f"/api/assets/{quote(SVC, safe='')}/tool-selection"


@pytest.fixture
def client(pg_lb, use_lb, monkeypatch):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({ADMIN}))
    monkeypatch.delenv("DATABRICKS_CLIENT_ID", raising=False)
    monkeypatch.setenv("PROVISIONING_MODE", "record_only")
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
        demo_seed.seed_extended(cur)
    authz.invalidate_roles()
    import app as application
    return TestClient(application.app)


def as_(email: str, **extra) -> dict:
    return {"x-forwarded-email": email, **extra}


def test_validation_rules():
    clean, errors, warnings = tool_selection.validate(["read_*", " lookup_member ", "", "read_*"])
    assert clean == ["read_*", "lookup_member"] and not errors and warnings == ["“read_*” is listed twice"]
    for bad, why in ((["!delete_*"], "exclusions"), (["*"], "leave the selection empty"), (["a*b"], "single *"),
                     (["x" * 257], "256 characters"), (["two words"], "spaces")):
        assert why in tool_selection.validate(bad)[1][0]
    too_many = tool_selection.validate([f"t{i}" for i in range(1025)])[1]
    assert too_many == ["At most 1,024 selectors are allowed (1,025 given)"]
    assert tool_selection.validate("a\nb")[0] == ["a", "b"]
    assert tool_selection.selects("lookup_claim", ["lookup_*"]) and not tool_selection.selects("close_ticket", ["lookup_*"])
    assert tool_selection.selects("anything", [])  # an empty selection exposes every tool
    assert tool_selection.editable({"asset_type": "mcp_server", "asset_id": SVC})
    for bad in ("mcp:service:a.b.c/../../permissions/x", "mcp:service:a.b", "mcp:system:system.ai.slack", "mcp:service:a.b.c?x=1"):
        assert not tool_selection.editable({"asset_type": "mcp_server", "asset_id": bad})  # the FQN goes into the PATCH path


def test_state_and_authz(client):
    s = client.get(BASE, headers=as_(CONSUMER)).json()["data"]
    assert s["editable"] and not s["can_edit"] and s["current"] == ["lookup_*", "create_ticket"] and s["etag"] == "demo-etag-1"
    assert {t["name"]: t["exposed_now"] for t in s["tools"]} == {"close_ticket": False, "create_ticket": True, "lookup_claim": True,
                                                                 "lookup_member": True}
    assert client.get(BASE, headers=as_(OWNER)).json()["data"]["can_edit"] is True
    detail = client.get(f"/api/assets/{quote(SVC, safe='')}", headers=as_(OWNER)).json()["data"]
    assert detail["permissions"]["can_edit_tool_selection"] is True
    body = {"selectors": ["lookup_*"]}
    for who in (CONSUMER, OTHER_OWNER, "nobody@example.com"):
        assert client.post(f"{BASE}/preview", json=body, headers=as_(who)).status_code == 403
        assert client.put(BASE, json={**body, "reason": "Retire ticket tools from this service"}, headers=as_(who)).status_code == 403
    # system / connection MCP servers have no editable selection, even for an admin
    m365 = f"/api/assets/{quote('mcp:system:system.ai.microsoft_365', safe='')}/tool-selection"
    assert client.get(m365, headers=as_(ADMIN)).json()["data"]["editable"] is False
    assert client.put(m365, json=body, headers=as_(ADMIN)).status_code == 403
    # an admin previewing as a consumer loses the right
    assert client.post(f"{BASE}/preview", json=body, headers=as_(ADMIN, **{"x-registry-view-as": "consumer"})).status_code == 403


def test_preview_then_breaking_apply_record_only(client, monkeypatch):
    monkeypatch.setattr(provision, "_client", lambda token: (_ for _ in ()).throw(AssertionError("record_only must not call UC")))
    p = client.post(f"{BASE}/preview", json={"selectors": ["lookup_*", "!close_ticket"]}, headers=as_(OWNER)).json()
    assert p["errors"] and p["impact"] is None
    p = client.post(f"{BASE}/preview", json={"selectors": ["lookup_*", "search_*"]}, headers=as_(OWNER)).json()
    assert p["removed"] == ["create_ticket"] and p["added"] == [] and p["breaking"] is True and p["unmatched_selectors"] == ["search_*"]
    assert p["request"] == {"method": "PATCH", "path": "/api/2.1/unity-catalog/mcp-services/demo.care_tools.care_ops_mcp",
                            "query": {"update_mask": "config.include_tool_selectors", "etag": "demo-etag-1"},
                            "body": {"name": "mcp-services/demo.care_tools.care_ops_mcp",
                                     "config": {"include_tool_selectors": ["lookup_*", "search_*"]}}}
    impact = p["impact"]
    down = {i["impacted_key"] for i in impact["downstream"]}
    assert {"agent:endpoint:demo-intake-agent", "agent:endpoint:demo-care-supervisor"} <= down  # calls create_ticket / uses the service
    assert CONSUMER in {i["impacted_key"] for i in impact["subscribers"]}
    assert "sam.ito@example.com" in {i["impacted_key"] for i in impact["observed"]}  # called create_ticket, never subscribed
    assert impact["email_preview"]["subject"].startswith("[Breaking] Care Ops MCP (Unity Gateway)")

    body = {"selectors": ["lookup_*", "search_*"], "etag": "demo-etag-1"}
    assert client.put(BASE, json=body, headers=as_(OWNER)).status_code == 400  # breaking needs a reason
    assert client.put(BASE, json={**body, "etag": "stale"}, headers=as_(OWNER)).status_code == 409
    assert client.put(BASE, json={"selectors": ["create_ticket", "lookup_*"]}, headers=as_(OWNER)).status_code == 409  # no change
    r = client.put(BASE, json={**body, "reason": "Ticket writes move to the care-ops ticketing MCP"}, headers=as_(OWNER))
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["status"] == "recorded" and res["mode"] == "record_only" and res["as"] is None and res["request"] == p["request"]
    change = res["change"]["change"]
    assert change["breaking"] is True and change["change_kinds"] == ["tools_removed"] and change["title"] == "Tool selection: 1 tool hidden"
    assert "Recorded only" in change["summary"] and change["detected_by"] == "owner"
    impacted = {(i["impact_type"], i["impacted_key"]) for i in res["change"]["impact"]}
    assert ("subscriber", CONSUMER) in impacted and ("downstream_asset", "agent:endpoint:demo-intake-agent") in impacted
    assert ("observed_consumer", "sam.ito@example.com") in impacted
    assert db.query("SELECT count(*) AS n FROM notification WHERE recipient_email = %s AND kind = 'change_published'", (CONSUMER,))[0]["n"] == 1
    s = client.get(BASE, headers=as_(OWNER)).json()["data"]
    assert s["current"] == ["lookup_*", "search_*"] and s["history"][0]["status"] == "recorded" and s["history"][0]["change_id"] == change["change_id"]
    actions = [r["action"] for r in db.query("SELECT action FROM audit_log WHERE entity_id = %s ORDER BY audit_id", (SVC,))]
    assert actions[-2:] == ["mcp.tool_selection.recorded", "change.publish"]
    # record_only never moves the version snapshot (UC still has the old selection)
    snap = db.query("SELECT config_snapshot FROM asset_version WHERE asset_id = %s AND version = 'v1'", (SVC,))[0]["config_snapshot"]
    assert snap["sections"]["config"]["tool_selectors"] == ["create_ticket", "lookup_*"]


class FakeMcpServices:
    def __init__(self, fail: bool = False):
        self.calls, self.fail, self.api_client = [], fail, self

    def do(self, method, path, query=None, body=None, headers=None):
        self.calls.append((method, path, query, body))
        if self.fail:
            from databricks.sdk.errors import PermissionDenied
            raise PermissionDenied("User does not have MANAGE on MCP service 'demo.care_tools.care_ops_mcp'")
        return {"name": body["name"], "config": body["config"], "etag": "demo-etag-2"}


def test_platform_apply_as_the_approver_and_failure_keeps_the_request(client, monkeypatch):
    monkeypatch.setenv("PROVISIONING_MODE", "platform")
    fake = FakeMcpServices()
    seen = {}

    def client_for(token):
        seen["token"] = token
        return fake, "approver (on-behalf-of)" if token else "app service principal"
    monkeypatch.setattr(provision, "_client", client_for)
    # non-breaking: expose close_ticket too (no reason needed)
    r = client.put(BASE, json={"selectors": ["lookup_*", "create_ticket", "close_ticket"]},
                   headers=as_(OWNER, **{"x-forwarded-access-token": "obo-token-for-test"}))
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["status"] == "applied" and res["as"] == "approver (on-behalf-of)" and seen["token"] == "obo-token-for-test"
    method, path, query, body = fake.calls[0]
    assert (method, path, query) == ("PATCH", "/api/2.1/unity-catalog/mcp-services/demo.care_tools.care_ops_mcp",
                                     {"update_mask": "config.include_tool_selectors", "etag": "demo-etag-1"})
    assert body["config"]["include_tool_selectors"] == ["lookup_*", "create_ticket", "close_ticket"]
    assert res["change"]["change"]["breaking"] is False and res["change"]["change"]["change_kinds"] == ["tools_added"]
    attrs = db.query("SELECT attributes FROM asset WHERE asset_id = %s", (SVC,))[0]["attributes"]
    assert attrs["etag"] == "demo-etag-2" and attrs["include_tool_selectors"] == ["lookup_*", "create_ticket", "close_ticket"]
    snap = db.query("SELECT config_snapshot FROM asset_version WHERE asset_id = %s AND version = 'v1'", (SVC,))[0]["config_snapshot"]
    assert sorted(snap["sections"]["config"]["tool_selectors"]) == ["close_ticket", "create_ticket", "lookup_*"]  # the next sync sees no change
    assert "obo-token-for-test" not in str(db.query("SELECT request FROM mcp_tool_selection"))  # tokens are never stored

    # the platform refuses: nothing changes in the registry, no change_event, the request is kept for the owner
    fake.fail = True
    changes_before = db.query("SELECT count(*) AS n FROM change_event WHERE asset_id = %s", (SVC,))[0]["n"]
    r = client.put(BASE, json={"selectors": ["lookup_*"], "reason": "Read-only service from now on"}, headers=as_(ADMIN))
    assert r.status_code == 200 and r.json()["status"] == "failed" and "MANAGE" in r.json()["error"] and r.json()["change"] is None
    assert r.json()["request"]["query"]["etag"] == "demo-etag-2"
    assert db.query("SELECT count(*) AS n FROM change_event WHERE asset_id = %s", (SVC,))[0]["n"] == changes_before
    assert db.query("SELECT attributes -> 'include_tool_selectors' AS s FROM asset WHERE asset_id = %s", (SVC,))[0]["s"] == \
        ["lookup_*", "create_ticket", "close_ticket"]
    assert db.query("SELECT action FROM audit_log ORDER BY audit_id DESC LIMIT 1")[0]["action"] == "mcp.tool_selection.failed"
