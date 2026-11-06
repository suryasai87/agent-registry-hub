"""Publishing the hub's lineage to Unity Catalog external lineage: plan first, idempotent publish, ownership safety.

record_only (the default off Databricks Apps) never calls the workspace and records the exact requests. Platform mode
runs against ``FakeUnityCatalog``, an in-memory external-metadata / external-lineage API shaped like the real one
(SDK ``ExternalMetadataAPI`` / ``ExternalLineageAPI``; list entries verified read-only on the live metastore), seeded
with objects the hub did NOT create, which must never be modified or deleted.
"""
from __future__ import annotations

import copy
import json
import uuid

import pytest
from databricks.sdk.errors import NotFound, ResourceAlreadyExists
from fastapi.testclient import TestClient

from core import config, db, migrate
from registry import authz, demo_seed, settings, uc_lineage

OWNER = "ana.ruiz@example.com"
ADMIN = "admin@example.com"
GENIE = "agent:genie:demo-claims"
SUP = "agent:endpoint:demo-care-supervisor"
EM, EL = uc_lineage.EM_PATH, uc_lineage.EL_PATH


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


def as_(email: str) -> dict:
    return {"x-forwarded-email": email}


def instance() -> str:
    with db.transaction() as cur:
        return settings.instance_id(cur)


class FakeUnityCatalog:
    """``w.api_client.do`` for /lineage-tracking/external-metadata and /external-lineage. Records every call."""

    def __init__(self):
        self.objects: dict[str, dict] = {}
        self.rels: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.api_client = self

    def do(self, method, path, query=None, body=None, headers=None):
        self.calls.append((method, path))
        if path == EM or path.startswith(EM + "/"):
            name = path[len(EM) + 1:]
            if method == "POST":
                if body["name"] in self.objects:
                    raise ResourceAlreadyExists(f"External metadata '{body['name']}' already exists")
                obj = {**copy.deepcopy(body), "id": uuid.uuid4().hex, "owner": "registry-app"}
                self.objects[body["name"]] = obj
                return copy.deepcopy(obj)
            if name not in self.objects:
                raise NotFound(f"External metadata '{name}' does not exist")
            if method == "GET":
                return copy.deepcopy(self.objects[name])
            if method == "PATCH":
                for field in query["update_mask"].split(","):
                    self.objects[name][field] = copy.deepcopy(body.get(field))
                return copy.deepcopy(self.objects[name])
            if method == "DELETE":
                del self.objects[name]
                for rid in [r for r, rel in self.rels.items() if name in (self._name(rel["source"]), self._name(rel["target"]))]:
                    del self.rels[rid]
                return {}
        if path == EL:
            if method == "POST":
                if any(r["source"] == body["source"] and r["target"] == body["target"] for r in self.rels.values()):
                    raise ResourceAlreadyExists("External lineage relationship already exists")
                rid = uuid.uuid4().hex
                self.rels[rid] = {**copy.deepcopy(body), "id": rid}
                return copy.deepcopy(self.rels[rid])
            if method == "PATCH":
                if body["id"] not in self.rels:
                    raise NotFound("relationship does not exist")
                self.rels[body["id"]]["properties"] = copy.deepcopy(body["properties"])
                return copy.deepcopy(self.rels[body["id"]])
            if method == "DELETE":
                rid = query["external_lineage_relationship"].get("id")
                if rid not in self.rels:
                    raise NotFound("relationship does not exist")
                del self.rels[rid]
                return {}
            if method == "GET":  # UPSTREAM of query.object_info: the shape the live metastore returned
                target = query["object_info"]
                out = []
                for r in self.rels.values():
                    if r["target"] == target:
                        other = {"external_metadata_info": {"name": r["source"]["external_metadata"]["name"]}} if "external_metadata" in r["source"] \
                            else {"table_info": dict(zip(("catalog_name", "schema_name", "name"), r["source"]["table"]["name"].split(".")))}
                        out.append({"external_lineage_info": {"id": r["id"], "properties": r.get("properties") or {}}, **other})
                return {"external_lineage_relationships": out}
        raise AssertionError(f"unexpected call {method} {path}")

    @staticmethod
    def _name(ref):
        return (ref.get("external_metadata") or {}).get("name")

    def mutations(self) -> list[tuple[str, str]]:
        return [c for c in self.calls if c[0] != "GET"]


@pytest.fixture
def uc(monkeypatch):
    fake = FakeUnityCatalog()
    monkeypatch.setenv("PROVISIONING_MODE", "platform")
    monkeypatch.setattr(uc_lineage, "_client", lambda token: (fake, "app service principal"))
    return fake


def preview(client, who=ADMIN):
    r = client.get("/api/lineage/uc-publish", headers=as_(who))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_plan_is_a_dry_run_and_record_only_publish_is_idempotent(client, monkeypatch):
    monkeypatch.setattr(uc_lineage, "_client", lambda token: (_ for _ in ()).throw(AssertionError("record_only must not call UC")))
    assert client.get("/api/lineage/uc-publish", headers=as_("jo.park@example.com")).status_code == 403
    d = preview(client)
    plan = d["plan"]
    assert d["available"] and plan["mode"] == "record_only" and d["settings"] == {"publish_in_sync": False}
    assert plan["objects"]["create"] >= 8 and plan["relationships"]["create"] >= 8 and plan["total_ops"] == len(plan["ops"])
    ops = {(o["kind"], o["key"]): o for o in plan["ops"]}
    genie = uc_lineage.metadata_name(instance(), GENIE)
    reads = ops[("external_lineage", f"table:demo.claims.claim_lines>em:{genie}")]
    assert reads["request"] == {"method": "POST", "path": EL, "body": {
        "source": {"table": {"name": "demo.claims.claim_lines"}}, "target": {"external_metadata": {"name": genie}},
        "properties": {"created_by": "agent-registry-hub", "hub_instance": instance(), "relations": "reads_data",
                       "edge_kinds": "data", "edge_sources": "demo"}}}
    writes = [o for o in plan["ops"] if o["key"].endswith(">table:demo.care.member_intake")]
    assert writes and writes[0]["request"]["body"]["source"]["external_metadata"]["name"].startswith("agent_registry_hub__agent_endpoint_demo_intake")
    # uses_tool: the tool (dependency) feeds the agent (dependent)
    sup = uc_lineage.metadata_name(instance(), SUP)
    tool = uc_lineage.metadata_name(instance(), "tool:uc:demo.care_tools.member_risk")
    assert ("external_lineage", f"em:{tool}>em:{sup}") in ops
    obj = ops[("external_metadata", genie)]["request"]["body"]
    assert obj["system_type"] == "DATABRICKS" and obj["entity_type"] == "Agent" and obj["url"].endswith("/assets/agent%3Agenie%3Ademo-claims")
    assert obj["properties"]["created_by"] == "agent-registry-hub" and obj["properties"]["asset_id"] == GENIE
    assert ops[("external_metadata", uc_lineage.metadata_name(instance(), "mcp:connection:demo_github_mcp"))]["request"]["body"]["system_type"] == "OTHER"
    reasons = {s["reason"] for s in plan["skipped"]}
    assert "People stay in the hub (consumer privacy)" in reasons
    assert all(not o["key"].startswith("em:") or "user" not in o["key"] for o in plan["ops"])
    assert not db.query("SELECT 1 FROM uc_lineage_object")  # the preview wrote nothing

    assert client.post("/api/lineage/uc-publish", json={"digest": plan["digest"]}, headers=as_(OWNER)).status_code == 403
    assert client.post("/api/lineage/uc-publish", json={"digest": "stale"}, headers=as_(ADMIN)).status_code == 409
    r = client.post("/api/lineage/uc-publish", json={"digest": plan["digest"]}, headers=as_(ADMIN))
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["status"] == "succeeded" and run["mode"] == "record_only" and run["acting_as"] is None
    assert run["counts"]["outcomes"] == {"recorded": plan["total_ops"]} and len(run["requests"]) == plan["total_ops"]
    assert db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'lineage.uc_publish'")[0]["n"] == 1
    assert {r["mode"] for r in db.query("SELECT mode FROM uc_lineage_object")} == {"record_only"}

    again = preview(client)
    assert again["plan"]["total_ops"] == 0 and again["plan"]["objects"]["unchanged"] == plan["objects"]["create"]
    noop = client.post("/api/lineage/uc-publish", json={"digest": again["plan"]["digest"]}, headers=as_(ADMIN)).json()
    assert noop["status"] == "nothing_to_do"

    # the Genie agent is retired: its object and its table relationship are removed (recorded), nothing else moves
    db.execute("UPDATE asset SET lifecycle_status = 'retired' WHERE asset_id = %s", (GENIE,))
    after = preview(client)["plan"]
    keys = {(o["op"], o["key"]) for o in after["ops"]}
    assert ("delete", genie) in keys and ("delete", f"table:demo.claims.claim_lines>em:{genie}") in keys
    assert all(o["op"] == "delete" for o in after["ops"])


def test_platform_publish_never_touches_objects_the_hub_did_not_create(client, uc):
    inst = instance()
    collide = uc_lineage.metadata_name(inst, SUP)
    uc.objects[collide] = {"name": collide, "system_type": "OTHER", "entity_type": "Dataset", "id": "foreign-1",
                           "properties": {"created_by": "someone-else"}}
    uc.objects["vendor_feed_orders"] = {"name": "vendor_feed_orders", "system_type": "KAFKA", "entity_type": "TOPIC", "id": "foreign-2",
                                        "properties": {"Connection Name": "orders"}}
    foreign = copy.deepcopy(uc.objects)
    plan = preview(client)["plan"]
    assert plan["mode"] == "platform"
    run = client.post("/api/lineage/uc-publish", json={"digest": plan["digest"]}, headers=as_(ADMIN)).json()
    assert run["status"] == "partial" and run["acting_as"] == "app service principal"
    conflicts = [e for e in run["errors"] if e["key"] == collide]
    assert conflicts and "did not create" in conflicts[0]["error"]
    assert uc.objects[collide] == foreign[collide] and uc.objects["vendor_feed_orders"] == foreign["vendor_feed_orders"]
    assert not [c for c in uc.mutations() if c[1] in (f"{EM}/{collide}", f"{EM}/vendor_feed_orders")]
    hub_objects = {n for n, o in uc.objects.items() if (o.get("properties") or {}).get("created_by") == "agent-registry-hub"}
    assert len(hub_objects) == plan["objects"]["create"] - 1
    assert all((r.get("properties") or {}).get("hub_instance") == inst for r in uc.rels.values())
    row = db.query("SELECT status, metadata_id, last_error FROM uc_lineage_object WHERE asset_id = %s", (SUP,))[0]
    assert row["status"] == "failed" and row["metadata_id"] is None and "left untouched" in row["last_error"]

    # idempotent: a second publish only retries the conflict (and the relationships that need the supervisor object)
    calls_before = len(uc.mutations())
    second = preview(client)["plan"]
    assert second["objects"]["create"] == 1 and second["objects"]["update"] == 0 and second["objects"]["unchanged"] == len(hub_objects)
    assert all(SUP.split(":")[-1].replace("-", "_") in o["key"] for o in second["ops"])
    client.post("/api/lineage/uc-publish", json={"digest": second["digest"]}, headers=as_(ADMIN))
    assert uc.objects[collide] == foreign[collide]
    assert len(uc.mutations()) - calls_before <= len(second["ops"])

    # tracking lost for one object: the hub re-creates, sees ALREADY_EXISTS, proves it is its own object and adopts it
    db.execute("DELETE FROM uc_lineage_object WHERE asset_id = %s", (GENIE,))
    adopt = preview(client)["plan"]
    res = client.post("/api/lineage/uc-publish", json={"digest": adopt["digest"]}, headers=as_(ADMIN)).json()
    genie = uc_lineage.metadata_name(inst, GENIE)
    assert {"op": "create", "kind": "external_metadata", "key": genie, "label": "Claims Analytics (Genie)", "outcome": "adopted"} in res["results"]
    assert len([n for n in uc.objects if n == genie]) == 1

    # a hub object someone else took over (properties rewritten) is left alone when the asset goes away
    uc.objects[genie]["properties"] = {"created_by": "data-platform-team"}
    db.execute("UPDATE asset SET lifecycle_status = 'retired' WHERE asset_id = %s", (GENIE,))
    gone = preview(client)["plan"]
    res = client.post("/api/lineage/uc-publish", json={"digest": gone["digest"]}, headers=as_(ADMIN)).json()
    outcome = {(r["kind"], r["key"]): r["outcome"] for r in res["results"]}
    assert outcome[("external_metadata", genie)] == "skipped_not_ours" and genie in uc.objects
    assert ("DELETE", f"{EM}/{genie}") not in uc.calls

    # a normally retired asset: the hub verifies ownership, then deletes its relationships and its object
    tool = uc_lineage.metadata_name(inst, "tool:uc:demo.care_tools.member_risk")
    db.execute("UPDATE asset SET lifecycle_status = 'retired' WHERE asset_id = 'tool:uc:demo.care_tools.member_risk'")
    last = preview(client)["plan"]
    client.post("/api/lineage/uc-publish", json={"digest": last["digest"]}, headers=as_(ADMIN))
    assert tool not in uc.objects and ("DELETE", f"{EM}/{tool}") in uc.calls
    assert uc.objects["vendor_feed_orders"] == foreign["vendor_feed_orders"] and uc.objects[collide] == foreign[collide]
    audit = db.query("SELECT after FROM audit_log WHERE action = 'lineage.uc_publish' ORDER BY audit_id")
    assert len(audit) == 5 and audit[0]["after"]["mode"] == "platform"


def test_sync_step_is_off_by_default_and_the_switch_is_admin_only_and_audited(client):
    assert uc_lineage.sync_step(lambda: None) == {"skipped": "uc_lineage_publish_in_sync is off"}
    url = "/api/lineage/uc-publish/settings"
    assert client.put(url, json={"publish_in_sync": True}, headers=as_(OWNER)).status_code == 403
    assert client.put(url, json={"publish_in_sync": "yes"}, headers=as_(ADMIN)).status_code == 400
    ok = client.put(url, json={"publish_in_sync": True, "reason": "Catalog Explorer should show agent lineage"}, headers=as_(ADMIN))
    assert ok.status_code == 200 and ok.json() == {"key": "uc_lineage_publish_in_sync", "value": True}
    step = uc_lineage.sync_step(lambda: (_ for _ in ()).throw(AssertionError("record_only must not build a client")))
    assert step["status"] == "succeeded" and step["mode"] == "record_only" and step["errors"] == 0
    row = db.query("SELECT actor, after FROM audit_log WHERE action = 'lineage.uc_publish'")[0]
    assert row["actor"] == "system:sync"
    assert db.query("SELECT after FROM audit_log WHERE action = 'registry.setting'")[0]["after"]["value"] is True
    assert preview(client)["settings"]["publish_in_sync"] is True


def test_metadata_names_are_deterministic_path_safe_and_per_install():
    a = uc_lineage.metadata_name("install-a", "tool:mcp:service:demo.care_tools.care_ops_mcp/lookup_member")
    assert a == uc_lineage.metadata_name("install-a", "tool:mcp:service:demo.care_tools.care_ops_mcp/lookup_member")
    assert a != uc_lineage.metadata_name("install-b", "tool:mcp:service:demo.care_tools.care_ops_mcp/lookup_member")
    assert a.startswith("agent_registry_hub__tool_mcp_service_demo_care_tools_care_ops_mcp_lookup_member__")
    assert set(a) <= set("abcdefghijklmnopqrstuvwxyz0123456789_") and len(a) <= 120
    assert json.dumps(uc_lineage.ref_key({"table": {"name": "c.s.t"}})) == '"table:c.s.t"'
