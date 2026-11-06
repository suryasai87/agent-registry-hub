"""The registry as RDF triples (registry/knowledge_graph.py) and their Delta export in the OntoBricks layout
(registry/kg_delta.py): determinism, privacy, Agent 365 links, escaping, batching, ownership safety, the unchanged-digest
skip, the sync step gate and the ontology file.

Platform mode runs against ``FakeWorkspace``: the Statement Execution API (it parses every Spark string literal back
with Spark's unescape rules, so an escaping bug shows up as a wrong triple) and the Unity Catalog Tables / Schemas
GETs, seeded with objects the hub did NOT create, which must never be modified.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from urllib.parse import unquote

import pytest
from databricks.sdk.errors import NotFound
from fastapi.testclient import TestClient

from core import config, db, migrate, warehouse
from registry import agent365, authz, demo_seed, kg_delta, knowledge_graph as kg, provision, settings, synthetic

ROOT = Path(__file__).resolve().parents[1]
OWNER = "ana.ruiz@example.com"
ADMIN = "admin@example.com"
STEWARD = "lee.chen@example.com"
GENIE = "agent:genie:demo-claims"
SUP = "agent:endpoint:demo-care-supervisor"
KA = "agent:endpoint:demo-policy-ka"
INTAKE = "agent:endpoint:demo-intake-agent"
NS = kg.DEFAULT_NAMESPACE
TRICKY = "Claims 'Q4' \\ back\\slash\nline\ttab ${spark.app.name} — 東京 ✓ 😀 it''s"
# Emails that must never leave the hub: subscribers, notify lists, requesters, usage requesters (none of them owns an asset).
PRIVATE = ("jo.park@example.com", "care-team@example.com", "req.person@example.com", "sam.ito@example.com", "pat.lee@example.com")


@pytest.fixture
def client(pg_lb, use_lb, monkeypatch):
    use_lb(pg_lb)
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({ADMIN}))
    monkeypatch.delenv("DATABRICKS_CLIENT_ID", raising=False)
    monkeypatch.delenv("DATABRICKS_HOST", raising=False)
    monkeypatch.delenv("KG_TARGET", raising=False)
    monkeypatch.delenv("KG_NAMESPACE", raising=False)
    monkeypatch.setenv("PROVISIONING_MODE", "record_only")
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
        demo_seed.seed_extended(cur)
        cur.execute("INSERT INTO role_assignment (email, role, granted_by, reason) VALUES (%s, 'steward', %s, 'test')", (STEWARD, ADMIN))
    authz.invalidate_roles()
    import app as application
    return TestClient(application.app)


def as_(email: str) -> dict:
    return {"x-forwarded-email": email}


def admin() -> authz.Principal:
    return authz.Principal(email=ADMIN, display_name="Admin", roles=frozenset({"admin"}), request_id="test")


def build(**kw) -> kg.Graph:
    with db.transaction() as cur:
        return kg.build(cur, **kw)


def enrich():
    """Data the demo fleet lacks: a downstream subscription with a notify list, an access request, a proposed policy,
    usage events, a non-owner email inside a label and inside a lineage node id, and Agent 365 records in every status."""
    with db.transaction() as cur:
        cur.execute("""INSERT INTO subscription (asset_id, subscriber_email, notify_emails, subscriber_kind, relationship, downstream_asset_id,
                                                 use_case, notify_pref, created_by)
                       VALUES (%s, 'jo.park@example.com', '{care-team@example.com}', 'agent', 'via_downstream', %s, 'Intake tickets', 'all',
                               'jo.park@example.com')""", (synthetic.CARE_MCP, INTAKE))
        cur.execute("""INSERT INTO access_request (asset_id, requester_email, principal, privilege, justification, duration_days, subscribe_email,
                                                   sla_due_at, request_expires_at)
                       VALUES (%s, 'req.person@example.com', 'req.person@example.com', 'CAN_QUERY', 'Need it for the claims pilot please',
                               30, 'req.person@example.com', now() + interval '2 days', now() + interval '14 days')""", (SUP,))
        cur.execute("""INSERT INTO usage_event (asset_id, consumer_email, operation) VALUES (%s, 'sam.ito@example.com', 'invoke')""", (SUP,))
        cur.execute("""INSERT INTO policy (policy_id, name, kind, provider, phase, action, origin)
                       VALUES ('demo:rate:intake', 'Intake rate limit', 'rate_limit', 'unity_gateway', 'n/a', 'limit', 'demo')""")
        cur.execute("INSERT INTO policy_binding (policy_id, asset_id, status) VALUES ('demo:rate:intake', %s, 'proposed')", (INTAKE,))
        cur.execute("""INSERT INTO lineage_edge (src_id, dst_id, relation, edge_kind, source)
                       VALUES (%s, 'external:mailto:jo.park@example.com', 'uses_tool', 'declared', 'manual')""", (INTAKE,))
        csv = (ROOT / "tests" / "fixtures" / "agent365" / "m365_all_agents_export.csv").read_text()
        agent365.import_file(cur, content=csv, filename="AgentRegistry.csv", fmt=None, p=admin())
        agent365.ingest(cur, [{"displayname": "Unknown Genie Room", "platform": "Databricks Genie", "id": "T_unknown"}], source="file")
        cur.execute("SELECT external_id FROM external_registration WHERE display_name = 'Supply Forecast Genie'")
        steward = authz.Principal(email=STEWARD, display_name="Lee Chen", roles=frozenset({"steward"}), request_id="test")
        agent365.review(cur, external_id=cur.fetchone()["external_id"], action="dismiss", asset_id=None, reason="Another workspace", p=steward)
        cur.execute("SELECT external_id FROM external_registration WHERE display_name = 'Policy Docs Assistant'")
        agent365.review(cur, external_id=cur.fetchone()["external_id"], action="link", asset_id=KA, reason="Confirmed with the owner", p=steward)
        cur.execute("UPDATE asset SET display_name = 'Escalations for jo.park@example.com' WHERE asset_id = %s", (KA,))


def a(cls: str, urn: str) -> str:
    return kg.node_iri(NS, cls, urn)


# ====================================================================== unit: literals, batches, mapping, privacy, ontology
def spark_unescape(body: str) -> str:
    """Spark's unescapeSQLString for the escapes the hub emits (plus the 'stray quote' check a doubled quote trips)."""
    out, i = [], 0
    while i < len(body):
        ch = body[i]
        if ch == "\\":
            nxt = body[i + 1]
            if nxt == "u":
                out.append(chr(int(body[i + 2:i + 6], 16)))
                i += 6
                continue
            out.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0", "b": "\b", "Z": "\x1a"}.get(nxt, nxt))
            i += 2
            continue
        assert ch != "'", "an unescaped quote inside a literal"
        out.append(ch)
        i += 1
    return "".join(out)


LITERAL = re.compile(r"'((?:[^'\\]|\\.)*)'", re.S)


def test_spark_literals_escape_quotes_backslashes_controls_dollar_and_keep_unicode():
    lit = kg_delta.sql_string(TRICKY)
    body = lit[1:-1]
    assert lit[0] == lit[-1] == "'" and "''" not in body and "\n" not in body and "${" not in body
    assert "\\'" in body and "\\\\" in body and "\\u0024" in body and "東京 ✓ 😀" in body
    assert spark_unescape(body) == TRICKY
    for value in ("", "'", "\\", "\\'", "'\\", "a\x00b\x1fc\x7f", " ", "trailing\\"):
        assert spark_unescape(kg_delta.sql_string(value)[1:-1]) == value
    assert kg_delta.sql_string(42) == "'42'"


def test_insert_batches_stay_under_the_statement_limit_and_keep_every_triple_in_order(monkeypatch):
    triples = [(f"{NS}Tool/t{i}", f"{NS}name", ("é😀'" * (i % 7)) + "x" * (i * 13 % 400)) for i in range(600)]
    stage = "`c`.`s`.`stage`"
    batches = kg_delta.insert_batches(stage, triples, max_bytes=6_000)
    assert len(batches) > 10 and sum(n for _, n in batches) == len(triples)
    assert all(len(sql.encode()) <= 6_000 for sql, _ in batches)
    rows = []
    for sql, n in batches:
        assert sql.startswith(f"INSERT INTO {stage} (subject, predicate, object) VALUES\n") and sql.count("\n(") == n
        values = [spark_unescape(v) for v in LITERAL.findall(sql)]
        rows += [tuple(values[i:i + 3]) for i in range(0, len(values), 3)]
    assert rows == triples
    # the row cap applies too, and an oversized triple gets a statement of its own
    assert [n for _, n in kg_delta.insert_batches(stage, triples[:10], max_rows=4)] == [4, 4, 2]
    big = [("s", "p", "y" * 10_000), ("s", "p", "z")]
    assert [n for _, n in kg_delta.insert_batches(stage, big, max_bytes=6_000)] == [1, 1]
    monkeypatch.setattr(kg_delta, "HARD_STATEMENT_BYTES", 5_000)
    with pytest.raises(ValueError, match="larger than the statement limit"):
        kg_delta.insert_batches(stage, big, max_bytes=6_000)


def test_agent365_status_maps_to_the_link_predicate():
    assert kg.registration_link("linked", 1.0) == "registeredAs"
    assert kg.registration_link("matched", 0.85) == "registeredAs"
    assert kg.registration_link("matched", 0.9) == "registeredAs"
    assert kg.registration_link("matched", 0.84) == "candidateMatch"  # below the auto-link bar is only a candidate
    assert kg.registration_link("suggested", 0.72) == "candidateMatch"
    assert kg.registration_link("dismissed", None) is None and kg.registration_link("unmatched", None) is None


def test_privacy_guard_reads_percent_encoded_iris():
    t = [(kg.node_iri(NS, "Agent", "agent:app:x"), kg.RDFS_LABEL, "owner a.b@example.com"),
         (kg.node_iri(NS, "ExternalResource", "mailto:jo.park@example.com"), kg.RDF_TYPE, NS + "ExternalResource")]
    assert "%40" in t[1][0]
    assert kg.privacy_violations(t, {"a.b@example.com"}) == ["jo.park@example.com"]
    assert kg.privacy_violations(t[:1], {"A.B@example.com"}) == []


def test_ontology_file_is_generated_from_the_definitions_and_parses():
    text = kg.turtle()
    path = ROOT / "docs" / "ontology" / "agent-registry-hub.ttl"
    if path.is_file():  # docs/** is not in the staged bundle, so Platform Watch's regression copy has no file to compare
        assert path.read_text() == text, "docs/ontology/agent-registry-hub.ttl is stale: cd app && python -m registry.knowledge_graph ttl > ../docs/ontology/agent-registry-hub.ttl"
    for d in (*kg.CLASSES, *kg.OBJECT_PROPERTIES, *kg.DATA_PROPERTIES):
        assert f"arh:{d.name} a owl:" in text and d.label in text
    assert set(kg.TYPE_CLASS.values()) | set(kg.SUBTYPE_CLASS.values()) | set(kg.NODE_CLASS.values()) <= {c.name for c in kg.CLASSES}
    assert {c.parent for c in kg.CLASSES if c.parent} <= {c.name for c in kg.CLASSES}
    names = {c.name for c in kg.CLASSES}
    assert all(p.domain in names and p.range in names for p in kg.OBJECT_PROPERTIES)
    # every lineage relation the hub records has a property (graph.DEPENDENCY_RELATIONS + the data relations)
    from registry import graph
    assert set(graph.DEPENDENCY_RELATIONS) | {"reads_data", "writes_data"} == set(kg.RELATION_PROPERTY)


def test_ontology_parses_with_rdflib():
    rdflib = pytest.importorskip("rdflib")  # optional dependency: OntoBricks parses ontologies with RDFLib
    g = rdflib.Graph().parse(data=kg.turtle(), format="turtle")
    assert len(set(g.subjects(rdflib.RDF.type, rdflib.OWL.Class))) == len(kg.CLASSES)


def test_namespace_is_configurable_and_validated(monkeypatch):
    assert kg.default_namespace() == "https://agent-registry-hub.example/ontology#"
    monkeypatch.setenv("KG_NAMESPACE", "https://kg.contoso.test/arh/")
    assert kg.default_namespace() == "https://kg.contoso.test/arh/"
    assert "@prefix arh: <https://kg.contoso.test/arh/> ." in kg.turtle("https://kg.contoso.test/arh/")
    for bad in ("kg.example#", "https://x.example/ns", "https://x.example/a b#", "https://x.example/'#"):
        with pytest.raises(ValueError):
            kg.validate_namespace(bad)


def test_execute_polls_long_statements_and_cancels_after_max_wait(monkeypatch):
    class Api:
        def __init__(self, states):
            self.states, self.calls = list(states), []

        def do(self, method, path, body=None, **_):
            self.calls.append((method, path, body))
            if path.endswith("/cancel"):
                return {}
            state = self.states.pop(0)
            return {"statement_id": "st-1", "status": {"state": state},
                    "manifest": {"schema": {"columns": [{"name": "n", "type_name": "LONG"}]}}, "result": {"data_array": [["7"]]}}

    monkeypatch.setattr(warehouse, "_sleep", lambda s: None)
    ok = type("W", (), {"api_client": Api(["PENDING", "RUNNING", "SUCCEEDED"])})()
    assert warehouse.execute("SELECT 7 AS n", client=ok, warehouse_id="wh", max_wait_s=60) == [{"n": 7}]
    assert ok.api_client.calls[0][2]["on_wait_timeout"] == "CONTINUE" and [c[0] for c in ok.api_client.calls] == ["POST", "GET", "GET"]
    clock = iter(range(0, 1000, 100))
    monkeypatch.setattr(warehouse.time, "monotonic", lambda: next(clock))
    slow = type("W", (), {"api_client": Api(["RUNNING"] * 20)})()
    with pytest.raises(warehouse.WarehouseError, match="canceled"):
        warehouse.execute("SELECT 1", client=slow, warehouse_id="wh", max_wait_s=250)
    assert slow.api_client.calls[-1][1] == "/api/2.0/sql/statements/st-1/cancel"


# ====================================================================== integration: the triples
def test_triples_are_deterministic_sorted_and_cover_the_registry(client):
    enrich()
    g1, g2 = build(), build()
    assert g1.triples == g2.triples and g1.digest == g2.digest and g1.triples == sorted(set(g1.triples))
    t = set(g1.triples)
    genie, sup, mcp = a("Agent", GENIE), a("Agent", SUP), a("McpServer", synthetic.CARE_MCP)
    assert {(genie, kg.RDF_TYPE, NS + "Agent"), (genie, kg.RDF_TYPE, NS + "GenieAgent"), (genie, kg.RDFS_LABEL, "Claims Analytics (Genie)"),
            (genie, NS + "assetId", GENIE), (genie, NS + "owner", STEWARD), (genie, NS + "certification", "certified"),
            (genie, NS + "lifecycleStatus", "approved"), (genie, NS + "source", "databricks")} <= t
    assert genie == NS + "Agent/agent%3Agenie%3Ademo-claims"
    # lineage: one predicate per relation; UC tables keyed by FQN; the 2-hop agent → MCP → tool path
    table = kg.node_iri(NS, "Table", "demo.claims.claim_lines")
    assert {(genie, NS + "readsData", table), (table, kg.RDF_TYPE, NS + "Table"), (table, kg.RDFS_LABEL, "demo.claims.claim_lines")} <= t
    tool = a("Tool", synthetic.CARE_TOOL + "lookup_member")
    assert {(sup, NS + "usesMcp", mcp), (mcp, NS + "exposesTool", tool), (sup, NS + "callsAgent", genie),
            (a("Agent", INTAKE), NS + "writesData", kg.node_iri(NS, "Table", "demo.care.member_intake"))} <= t
    # subscriptions (asset → asset only), policies, counts instead of people
    assert (a("Agent", INTAKE), NS + "registeredConsumerOf", mcp) in t
    assert (sup, NS + "governedBy", kg.node_iri(NS, "Policy", "demo:guardrail:output")) in t
    assert (a("Agent", INTAKE), NS + "proposedPolicy", kg.node_iri(NS, "Policy", "demo:rate:intake")) in t
    assert (mcp, NS + "activeSubscriptions", "2") in t and (sup, NS + "observedConsumers", "2") in t
    assert any(s == sup and p == NS + "requests30d" for s, p, _ in t) and any(s == sup and p == NS + "costUsd30d" for s, p, _ in t)
    assert g1.classes[NS + "GenieAgent"] == 1 and g1.predicates[NS + "usesMcp"] == 3
    assert g1.privacy["people_and_service_principal_edges_left_out"] == 2 and g1.privacy["redacted_literals"] == 1
    reasons = {s["reason"] for s in g1.skipped}
    assert "People and service principals are never exported (counted on the asset instead)" in reasons
    assert "Identifier contains a personal email (not exported)" in reasons
    # a registry change moves the digest
    db.execute("UPDATE asset SET lifecycle_status = 'deprecated' WHERE asset_id = %s", (GENIE,))
    assert build().digest != g1.digest


def test_privacy_no_subscriber_requester_or_notify_email_reaches_the_output(client):
    enrich()
    leaked = {r["e"] for r in db.query("""SELECT subscriber_email AS e FROM subscription UNION SELECT unnest(notify_emails) FROM subscription
                                           UNION SELECT created_by FROM subscription UNION SELECT requester_email FROM access_request
                                           UNION SELECT subscribe_email FROM access_request UNION SELECT requester FROM usage_daily
                                           UNION SELECT consumer_email FROM usage_event""") if r["e"]}
    owners = {r["email"] for r in db.query("SELECT email FROM asset_owner")}
    assert set(PRIVATE) - {"pat.lee@example.com"} <= leaked and not leaked & owners  # the fixture keeps them apart
    g = build()
    text = unquote("\n".join("\t".join(x) for x in g.triples)).lower()
    for email in leaked | set(PRIVATE):
        assert email not in text, f"{email} leaked into the knowledge graph"
    assert kg.privacy_violations(g.triples, owners) == []
    assert (a("Agent", KA), kg.RDFS_LABEL, "Escalations for [email]") in set(g.triples)
    assert OWNER in text  # owners are exported on purpose
    with db.transaction() as cur:
        cur.execute("UPDATE kg_export_run SET status = status")  # the table exists (migration 008)
    sql = "\n".join(s for s, _ in kg_delta.insert_batches("`c`.`s`.`t`", g.triples))
    assert not any(e in sql.lower() for e in leaked)


def test_agent365_records_link_by_review_status(client):
    enrich()
    t = set(build().triples)
    by_label = {o: s for s, p, o in t if p == kg.RDFS_LABEL and s.startswith(NS + "Agent365Package/")}
    pkg = lambda name: by_label[name]  # noqa: E731
    links = {(s, p.rsplit("#", 1)[1], o) for s, p, o in t if p in (NS + "registeredAs", NS + "candidateMatch")}
    assert (pkg("Claims Analytics"), "registeredAs", a("Agent", GENIE)) in links             # matched by Genie space id (1.0)
    assert (pkg("Care Ops Supervisor"), "registeredAs", a("Agent", SUP)) in links            # matched by name (0.9)
    assert (pkg("Policy Docs Assistant"), "registeredAs", a("Agent", KA)) in links           # linked by a steward
    assert (pkg("Member Intake Agnt"), "candidateMatch", a("Agent", INTAKE)) in links        # suggested
    assert len(links) == 4 and not [x for x in links if x[0] in (pkg("Supply Forecast Genie"), pkg("Unknown Genie Room"))]
    conf = {s: o for s, p, o in t if p == NS + "matchConfidence"}
    assert float(conf[pkg("Member Intake Agnt")]) < 0.85 and conf[pkg("Claims Analytics")] == "1"
    assert pkg("Supply Forecast Genie") not in conf and pkg("Unknown Genie Room") not in conf
    status = {s: o for s, p, o in t if p == NS + "matchStatus"}
    assert status[pkg("Supply Forecast Genie")] == "dismissed" and status[pkg("Unknown Genie Room")] == "unmatched"
    assert (pkg("Claims Analytics"), NS + "m365Id", "T_6f1c2a90-0d4e-4c55-9a8e-1b2c3d4e5f60") in t
    assert not [x for x in t if x[1] == NS + "publisher" and x[0].startswith(NS + "Agent365Package/")]  # M365 publisher/owner never exported


# ====================================================================== integration: preview + record_only export
def test_preview_is_read_only_and_record_only_exports_are_audited_and_skip_unchanged(client):
    url = "/api/kg/preview"
    assert client.get(url, headers=as_("jo.park@example.com")).status_code == 403
    d = client.get(url, headers=as_(STEWARD)).json()["data"]
    assert d["available"] and d["target"] is None and d["can_export"] is False and d["mode"] == "record_only" and d["triples"] > 100
    assert "No target yet" in d["note"] and {c["name"] for c in d["classes"]} >= {"Agent", "GenieAgent", "McpServer", "Tool", "Table", "Policy"}
    assert client.post("/api/kg/export", json={}, headers=as_(ADMIN)).status_code == 409
    # settings: admin only, validated, audited
    put = "/api/kg/settings"
    assert client.put(put, json={"catalog": "main"}, headers=as_(STEWARD)).status_code == 403
    assert client.put(put, json={"catalog": "main`; DROP"}, headers=as_(ADMIN)).status_code == 400
    assert client.put(put, json={"version": 0}, headers=as_(ADMIN)).status_code == 400
    assert client.put(put, json={}, headers=as_(ADMIN)).status_code == 400
    ok = client.put(put, json={"catalog": "main", "schema": "agent_kg", "reason": "Genie space over the registry"}, headers=as_(ADMIN))
    assert ok.status_code == 200 and ok.json() == {"export_in_sync": False, "catalog": "main", "schema": "agent_kg", "version": 1, "bundle_target": None}
    d = client.get(url, headers=as_(ADMIN)).json()["data"]
    base = "triplestore_agent_registry_hub_V1"
    assert d["target"]["base"] == base and d["can_export"] and d["digest"] and d["last_run"] is None
    names = [o["name"] for o in d["objects"]]
    assert names == [f"main.agent_kg.{base}{x}" for x in ("_data", "_inferred", "_graph", "", "_adj_out", "_adj_in", "_entity_search",
                                                          "_entity_search_asserted", "_props")] + [f"main.agent_kg.kg_{x}" for x in ("nodes", "edges", "registry_matches")]
    steps = [s["step"] for s in d["statements"]]
    assert steps[:13] == ["inspect"] * 13 and steps[13:17] == ["schema", "stage", "load", "verify"] and steps[-1] == "drop_stage"
    ddl = {s["step"]: s["sql"] for s in d["statements"]}
    assert ddl["data"].startswith(f"CREATE OR REPLACE TABLE `main`.`agent_kg`.`{base}_data` USING DELTA CLUSTER BY (predicate, subject)")
    assert "'created_by' = 'agent-registry-hub'" in ddl["data"] and f"'kg_digest' = '{d['digest']}'" in ddl["data"]
    assert ddl["inferred"].startswith(f"CREATE OR REPLACE TABLE `main`.`agent_kg`.`{base}_inferred` (subject STRING, predicate STRING, object STRING)")
    assert f"FROM `main`.`agent_kg`.`{base}_data` UNION ALL SELECT subject, predicate, object FROM `main`.`agent_kg`.`{base}_inferred`" in ddl["graph"]
    assert "CLUSTER BY (src, predicate)" in ddl["adj_out"] and "CLUSTER BY (dst, predicate)" in ddl["adj_in"]
    assert "CLUSTER BY (type_uri, label_lc)" in ddl["entity_search"] and "CLUSTER BY (subject)" in ddl["props"]
    assert "node_type COMMENT" in ddl["kg_nodes"] and "relation COMMENT" in ddl["kg_edges"] and "match_status COMMENT" in ddl["kg_registry_matches"]
    assert not db.query("SELECT 1 FROM kg_export_run")  # the preview wrote nothing

    exp = "/api/kg/export"
    assert client.post(exp, json={"digest": d["digest"]}, headers=as_(STEWARD)).status_code == 403
    assert client.post(exp, json={"digest": "stale"}, headers=as_(ADMIN)).status_code == 409
    r = client.post(exp, json={"digest": d["digest"]}, headers=as_(ADMIN))
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["status"] == "succeeded" and run["mode"] == "record_only" and run["acting_as"] is None and run["counts"]["triples"] == d["triples"]
    assert [s["step"] for s in run["statements"]][:2] == ["stage", "load"] and run["statements"][-1]["step"] == "drop_stage"
    again = client.post(exp, json={"digest": d["digest"]}, headers=as_(ADMIN)).json()
    assert again["status"] == "unchanged" and again["statements"] == []
    assert client.get(url, headers=as_(ADMIN)).json()["data"]["unchanged_since_last_run"] is True
    audit = db.query("SELECT actor, after FROM audit_log WHERE action = 'kg.export' ORDER BY audit_id")
    assert [x["after"]["status"] for x in audit] == ["succeeded", "unchanged"] and audit[0]["actor"] == ADMIN
    db.execute("UPDATE asset SET certification = 'deprecated' WHERE asset_id = %s", (GENIE,))
    changed = client.get(url, headers=as_(ADMIN)).json()["data"]
    assert changed["digest"] != d["digest"] and changed["unchanged_since_last_run"] is False
    assert client.post(exp, json={"digest": changed["digest"]}, headers=as_(ADMIN)).json()["status"] == "succeeded"
    st = client.get("/api/kg/status", headers=as_(STEWARD)).json()["data"]
    assert st["available"] and [x["status"] for x in st["runs"]] == ["succeeded", "unchanged", "succeeded"] and st["can_export"] is False
    ttl = client.get("/api/kg/ontology.ttl")
    assert ttl.status_code == 200 and ttl.headers["content-type"].startswith("text/turtle") and ttl.text == kg.turtle()


# ====================================================================== integration: platform export (fake workspace)
class FakeWorkspace:
    """Statement Execution + UC Tables/Schemas GETs, enough to run the export end to end. Records every statement."""

    def __init__(self, schemas=()):
        self.schemas = {s.lower() for s in schemas}
        self.objects: dict[str, dict] = {}
        self.statements: list[str] = []
        self.api_client = self
        self.lose_a_row = False

    @staticmethod
    def _ok(rows=None, cols=None):
        return {"statement_id": "s", "status": {"state": "SUCCEEDED"}, "manifest": {"schema": {"columns": cols or []}},
                "result": {"data_array": rows or []}}

    def do(self, method, path, query=None, body=None, headers=None):
        if method == "POST" and path == "/api/2.0/sql/statements/":
            return self._sql(body["statement"])
        if method == "GET" and path.startswith("/api/2.1/unity-catalog/tables/"):
            name = path.rsplit("/", 1)[1]
            o = self.objects.get(name)
            if o is None:
                raise NotFound(f"Table '{name}' does not exist.")
            return {"full_name": name, "table_type": "VIEW" if o["kind"] == "VIEW" else "MANAGED", "properties": dict(o["props"])}
        if method == "GET" and path.startswith("/api/2.1/unity-catalog/schemas/"):
            name = path.rsplit("/", 1)[1]
            if name not in self.schemas:
                raise NotFound(f"Schema '{name}' does not exist.")
            return {"full_name": name}
        raise AssertionError(f"unexpected call {method} {path}")

    def _sql(self, sql: str):
        self.statements.append(sql)
        fq = r"`([^`]+)`\.`([^`]+)`\.`([^`]+)`"
        if m := re.match(r"CREATE SCHEMA IF NOT EXISTS `([^`]+)`\.`([^`]+)`", sql):
            self.schemas.add(f"{m[1]}.{m[2]}".lower())
            return self._ok()
        if m := re.match(rf"CREATE OR REPLACE (TABLE|VIEW) {fq}", sql):
            name = ".".join(m.groups()[1:]).lower()
            assert ".".join(m.groups()[1:3]).lower() in self.schemas, f"{name}: the schema does not exist"
            pm = re.search(r"TBLPROPERTIES \(((?:'(?:[^'\\]|\\.)*' = '(?:[^'\\]|\\.)*'(?:, )?)+)\)", sql)
            props = {spark_unescape(k): spark_unescape(v) for k, v in re.findall(r"'((?:[^'\\]|\\.)*)' = '((?:[^'\\]|\\.)*)'", pm[1])} if pm else {}
            rows = []
            if m2 := re.search(rf" AS SELECT subject, predicate, object FROM {fq}$", sql):
                rows = list(self.objects[".".join(m2.groups()).lower()]["rows"])
            self.objects[name] = {"kind": m[1], "props": props, "rows": rows, "sql": sql}
            return self._ok()
        if m := re.match(rf"INSERT INTO {fq} \(subject, predicate, object\) VALUES\n", sql):
            values = [spark_unescape(v) for v in LITERAL.findall(sql[m.end():])]
            assert len(values) % 3 == 0, "a row did not parse into three literals (an escaping bug)"
            rows = [tuple(values[i:i + 3]) for i in range(0, len(values), 3)]
            if self.lose_a_row:
                rows, self.lose_a_row = rows[1:], False
            self.objects[".".join(m.groups()).lower()]["rows"] += rows
            return self._ok()
        if m := re.match(rf"SELECT count\(\*\) AS n FROM {fq}$", sql):
            return self._ok([[str(len(self.objects[".".join(m.groups()).lower()]["rows"]))]], [{"name": "n", "type_name": "LONG"}])
        if m := re.match(rf"DROP (TABLE|VIEW) IF EXISTS {fq}$", sql):
            o = self.objects.get(".".join(m.groups()[1:]).lower())
            assert o is None or (o["props"].get("created_by") == "agent-registry-hub"), "dropped an object the hub did not create"
            self.objects.pop(".".join(m.groups()[1:]).lower(), None)
            return self._ok()
        raise AssertionError(f"unexpected SQL: {sql[:120]}")

    def writes(self) -> list[str]:
        return [s for s in self.statements if not s.startswith("SELECT")]


@pytest.fixture
def uc(monkeypatch):
    fake = FakeWorkspace(schemas=["main.existing"])
    monkeypatch.setenv("PROVISIONING_MODE", "platform")
    monkeypatch.setattr(config, "WAREHOUSE_ID", "wh-test")
    monkeypatch.setattr(provision, "_client", lambda token: (fake, "app service principal"))
    monkeypatch.setattr(kg_delta, "MAX_STATEMENT_BYTES", 10_000)  # several batches even for the demo fleet
    return fake


def preview(client, who=ADMIN) -> dict:
    r = client.get("/api/kg/preview", headers=as_(who))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_platform_export_writes_the_ontobricks_layout_and_is_idempotent(client, uc, monkeypatch):
    monkeypatch.setenv("KG_TARGET", "main.agent_kg")  # the bundle variable
    db.execute("UPDATE asset SET display_name = %s WHERE asset_id = %s", (TRICKY, GENIE))
    d = preview(client)
    assert d["mode"] == "platform" and d["target"]["source"] == "bundle" and d["load"]["batches"] > 3
    r = client.post("/api/kg/export", json={"digest": d["digest"]}, headers=as_(ADMIN)).json()
    assert r["status"] == "succeeded" and r["acting_as"] == "app service principal" and r["conflicts"] == [] and r["error"] is None
    base = "main.agent_kg.triplestore_agent_registry_hub_v1"
    assert "main.agent_kg" in uc.schemas and uc.writes()[0].startswith("CREATE SCHEMA IF NOT EXISTS `main`.`agent_kg`")
    assert f"{base}_stage" not in uc.objects  # dropped
    expected = {f"{base}{x}" for x in ("_data", "_inferred", "_graph", "", "_adj_out", "_adj_in", "_entity_search", "_entity_search_asserted", "_props")} | \
        {f"main.agent_kg.kg_{x}" for x in ("nodes", "edges", "registry_matches")}
    assert set(uc.objects) == expected
    inst = db.query("SELECT value FROM registry_setting WHERE key = 'hub_instance_id'")[0]["value"]
    for o in uc.objects.values():
        assert o["props"]["created_by"] == "agent-registry-hub" and o["props"]["hub_instance"] == inst and o["props"]["kg_digest"] == d["digest"]
    assert uc.objects[f"{base}_data"]["kind"] == "TABLE" and uc.objects[f"{base}_graph"]["kind"] == "VIEW" and uc.objects[base]["kind"] == "VIEW"
    # every triple arrived intact through the Spark literals (quotes, backslashes, newline, ${…}, unicode, emoji)
    with db.transaction() as cur:
        g = kg.build(cur, app_url="http://testserver")
    assert uc.objects[f"{base}_data"]["rows"] == g.triples and uc.objects[f"{base}_data"]["props"]["kg_triples"] == str(len(g.triples))
    assert (a("Agent", GENIE), kg.RDFS_LABEL, TRICKY) in set(uc.objects[f"{base}_data"]["rows"])
    loads = [s for s in uc.statements if s.startswith("INSERT INTO")]
    assert len(loads) == d["load"]["batches"] and all(len(s.encode()) <= 10_000 for s in loads)
    order = [re.match(r"CREATE OR REPLACE (?:TABLE|VIEW) `[^`]+`\.`[^`]+`\.`([^`]+)`", s)[1] for s in uc.writes() if s.startswith("CREATE OR REPLACE")]
    assert order[0].endswith("_stage") and order[1].endswith("_data") and order[-3:] == ["kg_nodes", "kg_edges", "kg_registry_matches"]
    assert uc.writes()[-1] == f"DROP TABLE IF EXISTS `main`.`agent_kg`.`triplestore_agent_registry_hub_V1_stage`"
    run = db.query("SELECT status, digest, statements FROM kg_export_run")[0]
    assert run["status"] == "succeeded" and run["digest"] == d["digest"] and any("batch 1/" in s["sql"] for s in run["statements"])

    # unchanged: the TBLPROPERTIES digest matches on every object, so nothing is written
    before = len(uc.statements)
    again = client.post("/api/kg/export", json={"digest": preview(client)["digest"]}, headers=as_(ADMIN)).json()
    assert again["status"] == "unchanged" and len(uc.statements) == before

    # one of ours turned into the other kind: dropped (it is ours) and recreated
    uc.objects[f"{base}_inferred"]["kind"] = "VIEW"
    third = client.post("/api/kg/export", json={}, headers=as_(ADMIN)).json()
    assert third["status"] == "succeeded" and f"DROP VIEW IF EXISTS `main`.`agent_kg`.`triplestore_agent_registry_hub_V1_inferred`" in uc.statements
    assert uc.objects[f"{base}_inferred"]["kind"] == "TABLE"


def test_platform_export_never_modifies_objects_the_hub_did_not_create(client, uc, monkeypatch):
    monkeypatch.setenv("KG_TARGET", "main.existing")
    foreign = {"kind": "VIEW", "props": {"owner_team": "analytics"}, "rows": [], "sql": "theirs"}
    uc.objects["main.existing.kg_nodes"] = dict(foreign)
    uc.objects["main.existing.unrelated_table"] = {"kind": "TABLE", "props": {}, "rows": [("x", "y", "z")], "sql": "theirs"}
    r = client.post("/api/kg/export", json={}, headers=as_(ADMIN)).json()
    assert r["status"] == "conflict" and [c["name"] for c in r["conflicts"]] == ["main.existing.kg_nodes"]
    assert "not created by the Agent Registry Hub" in r["conflicts"][0]["reason"]
    assert uc.statements == [] and uc.objects["main.existing.kg_nodes"] == foreign  # nothing ran at all
    # another hub install's object is a conflict too (hub_instance differs)
    uc.objects["main.existing.kg_nodes"] = {"kind": "VIEW", "props": {"created_by": "agent-registry-hub", "hub_instance": "other"}, "rows": [], "sql": ""}
    r = client.post("/api/kg/export", json={}, headers=as_(ADMIN)).json()
    assert r["status"] == "conflict" and "another Agent Registry Hub install" in r["conflicts"][0]["reason"] and uc.statements == []
    del uc.objects["main.existing.kg_nodes"]
    # a stage that lost a row: nothing is swapped in, the stage is dropped, the run says why
    uc.lose_a_row = True
    r = client.post("/api/kg/export", json={}, headers=as_(ADMIN)).json()
    assert r["status"] == "failed" and "expected" in r["error"] and not [n for n in uc.objects if n.endswith("_data")]
    assert uc.statements[-1].startswith("DROP TABLE IF EXISTS") and uc.statements[-1].endswith("_stage`")
    assert uc.objects["main.existing.unrelated_table"]["rows"] == [("x", "y", "z")]  # never touched
    assert [x["after"]["status"] for x in db.query("SELECT after FROM audit_log WHERE action = 'kg.export' ORDER BY audit_id")] == \
        ["conflict", "conflict", "failed"]
    assert all(not re.search(r"DROP SCHEMA", s, re.I) for s in uc.statements)


# ====================================================================== the sync step
def test_sync_step_is_gated_on_migration_008_off_by_default_and_skips_unchanged(pg_lb, use_lb, monkeypatch, tmp_path):
    use_lb(pg_lb)
    monkeypatch.setenv("PROVISIONING_MODE", "record_only")
    monkeypatch.setenv("KG_TARGET", "main.agent_kg")
    staged = tmp_path / "migrations"
    staged.mkdir()
    for f in sorted((ROOT / "pipeline" / "migrations").glob("*.sql")):
        if f.name < "008":
            shutil.copy(f, staged / f.name)
    migrate.run(pg_lb, schema=pg_lb.schema, directory=staged)  # production before the release that adds 008
    never = lambda: (_ for _ in ()).throw(AssertionError("record_only must not build a client"))  # noqa: E731
    assert kg_delta.sync_step(never) == {"skipped": "migration 008 is not applied"}
    assert not db.query("SELECT 1 FROM schema_migrations WHERE version LIKE '008%'")  # the step never migrates
    migrate.run(pg_lb, schema=pg_lb.schema)
    with db.transaction() as cur:
        demo_seed.seed(cur)
    assert kg_delta.sync_step(never) == {"skipped": "kg_export_in_sync is off"}
    with db.transaction() as cur:
        settings.put(cur, "kg_export_in_sync", True, p=admin(), reason="nightly graph")
    first = kg_delta.sync_step(never)
    assert first["status"] == "succeeded" and first["mode"] == "record_only" and first["error"] is None
    second = kg_delta.sync_step(never)
    assert second["skipped"] == "unchanged since the last export" and second["digest"] == first["digest"]
    row = db.query("SELECT actor, source FROM audit_log WHERE action = 'kg.export'")
    assert row == [{"actor": "system:sync", "source": "job"}]


# ====================================================================== the Genie space script (dry run only)
def test_genie_space_script_prints_a_definition_and_never_creates_by_default(monkeypatch, capsys):
    import importlib.util
    import json

    spec = importlib.util.spec_from_file_location("create_kg_genie_space", ROOT / "scripts" / "create_kg_genie_space.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    import core.lakebase
    monkeypatch.setattr(core.lakebase, "workspace_client", lambda: (_ for _ in ()).throw(AssertionError("a dry run must not call the workspace")))
    assert mod.main(["--target", "main.agent_kg"]) == 0
    out = json.loads(capsys.readouterr().out)
    space = out["serialized_space"]
    assert out["dry_run"] is True and "created" not in out and space["version"] == 2
    assert out["tables"] == ["main.agent_kg.kg_edges", "main.agent_kg.kg_nodes", "main.agent_kg.kg_registry_matches",
                             "main.agent_kg.triplestore_agent_registry_hub_V1_graph"]
    ex = space["instructions"]["example_question_sqls"]
    assert 8 <= len(ex) <= 10 and [e["id"] for e in ex] == sorted(e["id"] for e in ex)
    assert any("Agent 365" in e["question"][0] and "Genie" in e["question"][0] for e in ex)
    assert all("`main`.`agent_kg`." in "".join(e["sql"]) for e in ex)
    lines = space["instructions"]["text_instructions"][0]["content"]
    assert len(space["instructions"]["text_instructions"]) == 1 and all(line.count("\n") == 1 and line.endswith("\n") for line in lines)
    with pytest.raises(SystemExit):
        mod.main(["--target", "main.agent_kg", "--create"])  # --create without --yes is refused
