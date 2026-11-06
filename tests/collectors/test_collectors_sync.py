"""End-to-end collector tests: the fake workspace (real probe samples) -> the registry schema in Docker Postgres."""
from __future__ import annotations

import json

import pytest

from collectors import ORDER, base
from core import db

ALL = list(ORDER)


def run(ctx, selected=None, **kw):
    return base.run_all(selected, "test", ctx=ctx, **kw)


def ids(q, prefix):
    return {r["asset_id"] for r in q("SELECT asset_id FROM asset WHERE asset_id LIKE %s", (prefix + "%",))}


def field(q, asset_id, key):
    rows = q("SELECT * FROM asset_field WHERE asset_id = %s AND field_key = %s", (asset_id, key))
    return rows[0] if rows else None


# ---------------------------------------------------------------------------------------------- full sync
def test_full_sync_asset_counts_and_urns(registry, ctx_factory, q):
    result = run(ctx_factory())
    statuses = {r["collector"]: r["status"] for r in result["runs"]}
    assert statuses == {n: "succeeded" for n in ALL}, [r for r in result["runs"] if r["status"] != "succeeded"]
    runs = q("SELECT collector, status, items_seen, finished_at FROM sync_run ORDER BY run_id")
    assert [r["collector"] for r in runs] == ALL and all(r["finished_at"] for r in runs)
    assert result["kg_export"] == {"skipped": "kg_export_in_sync is off"}  # the optional knowledge graph step (default off)

    assert ids(q, "agent:endpoint:") == {f"agent:endpoint:{n}" for n in (
        "agent_eval_demo_coordinator", "agents_main-guanyu_chen-multi_agent_langgraph",
        "agents_main-guanyu_chen-simple_rag_agent", "ka-0445f231-endpoint", "kie-000ddc00-endpoint",
        "mas-0849ad0e-endpoint", "t2t-de6faa1d-endpoint", "agents_main-drm_transformation-drm_agent",
        "mas-2e8a4ac6-endpoint", "ka-a176dc0c-endpoint")}
    assert ids(q, "agent:genie:") == {"agent:genie:01f1d0c52c5212a0a957f1117779ad81", "agent:genie:01f1d0a58f67189b8e7581086da8e417",
                                      "agent:genie:01f1cfc0a28f178a87d7e680119e1c97", "agent:genie:01f1ceeb4c961f3b9bf033eacaa85e59",
                                      "agent:genie:01f1cd7bb5441dfbad0bfcb2641eacdb"}
    assert ids(q, "agent:app:") == {"agent:app:agent-bricks-meridian-ab-demo"}
    assert ids(q, "mcp:connection:") == {"mcp:connection:aa_sil_np_mcp", "mcp:connection:agentkit_deepwiki",
                                         "mcp:connection:ah_demo_confluence_mcp", "mcp:connection:ext_mcp_you_dot_com"}
    assert ids(q, "tool:mcp:connection:") == {"tool:mcp:connection:ext_mcp_you_dot_com/you-finance"}
    assert ids(q, "mcp:uc:") == {"mcp:uc:system.ai", "mcp:uc:main.supply_agentic_demo"}
    assert ids(q, "tool:uc:") == {"tool:uc:system.ai.ai_classify", "tool:uc:system.ai.python_exec",
                                  "tool:uc:main.supply_agentic_demo.ebom_mbom_gaps",
                                  "tool:uc:main.supply_agentic_demo.ecr_impact",
                                  "tool:uc:main.supply_agentic_demo.part_inventory_risk"}
    systems = ids(q, "mcp:system:")
    assert {"mcp:system:system.ai.slack", "mcp:system:system.ai.genie_one_mcp", "mcp:system:system.ai.microsoft_365",
            "mcp:system:system.ai.dbsql"} <= systems
    assert "mcp:service:main.lilly_heor_rwe_demo.nsclc_mcp" in ids(q, "mcp:service:")
    assert "mcp:service:tony_farias.slurm_hpc.slurm_ops" in ids(q, "mcp:service:")
    assert ids(q, "skill:uc:") == {"skill:uc:main.vital_skills.cohort-builder",
                                   "skill:uc:main.vital_skills.payer-provider-measure-catalog",
                                   "skill:uc:main.vital_skills.rwe-cohortstudy"}
    # endpoints that are not agents never become assets
    assert not ids(q, "agent:endpoint:member-services-chat") and not ids(q, "agent:endpoint:appeal-overturn-model")

    a = q("SELECT * FROM asset WHERE asset_id = 'agent:endpoint:mas-2e8a4ac6-endpoint'")[0]
    assert a["subtype"] == "agent_bricks_supervisor" and a["display_name"] == "brickwell-mfg-ai-supervisor"
    # Databricks-native assets register as approved (already governed by UC / workspace ACLs)
    assert a["lifecycle_status"] == "approved" and a["deep_link"].endswith("/ml/endpoints/mas-2e8a4ac6-endpoint")
    ext = q("SELECT lifecycle_status FROM asset WHERE source IN ('external','custom') AND asset_type = 'mcp_server'")
    assert ext and {r["lifecycle_status"] for r in ext} == {"discovered"}  # third-party / custom MCP wait for a steward
    assert a["attributes"]["platform_status"] == "legacy" and a["attributes"]["agent_bricks"]["platform_status"] == "legacy"
    assert field(q, a["asset_id"], "purpose")["source_label"] == "Supervisor Agent description"
    assert len(field(q, a["asset_id"], "example_prompts")["source_value"]) == 3
    genie = q("SELECT attributes FROM asset WHERE asset_id = 'agent:genie:01f1cd7bb5441dfbad0bfcb2641eacdb'")[0]["attributes"]
    assert genie["mcp_path"] == "/api/2.0/mcp/genie/01f1cd7bb5441dfbad0bfcb2641eacdb" and len(genie["tables"]) == 10
    tool = q("SELECT parent_asset_id, attributes FROM asset WHERE asset_id = 'tool:mcp:connection:ext_mcp_you_dot_com/you-finance'")[0]
    assert tool["parent_asset_id"] == "mcp:connection:ext_mcp_you_dot_com" and tool["attributes"]["side_effect"] == "read"
    status = {r["asset_id"]: r["attributes"].get("tools_status") for r in
              q("SELECT asset_id, attributes FROM asset WHERE asset_id LIKE 'mcp:connection:%%'")}
    assert status == {"mcp:connection:ext_mcp_you_dot_com": "listed", "mcp:connection:agentkit_deepwiki": "access_required",
                      "mcp:connection:aa_sil_np_mcp": "access_required", "mcp:connection:ah_demo_confluence_mcp": "access_required"}
    slack = q("SELECT publisher, attributes FROM asset WHERE asset_id = 'mcp:system:system.ai.slack'")[0]
    assert slack["publisher"] == "Slack (Salesforce)" and slack["attributes"]["uc_listed"] is True
    assert field(q, "mcp:system:system.ai.slack", "purpose")["source_label"] == "Registry catalog of Databricks system MCP servers"
    assert field(q, "mcp:system:system.ai.slack", "description")["source_label"] == "UC MCP service comment"
    assert field(q, "mcp:system:system.ai.slack", "endpoint_url")["source_value"].endswith("/ai-gateway/mcp-services/system.ai.slack")


def test_lineage_policies_grants_usage_cost_traces(registry, ctx_factory, q):
    run(ctx_factory(days=400))
    rel = {(r["src_id"], r["dst_id"], r["relation"]) for r in q("SELECT src_id, dst_id, relation FROM lineage_edge")}
    mas = "agent:endpoint:mas-2e8a4ac6-endpoint"
    assert (mas, "agent:endpoint:ka-a176dc0c-endpoint", "calls_agent") in rel
    assert (mas, "agent:genie:01f1cd7bb5441dfbad0bfcb2641eacdb", "calls_agent") in rel
    assert ("agent:endpoint:ka-a176dc0c-endpoint", "volume:/Volumes/main/brickwell_mfg_ai/source_docs/pdf", "reads_data") in rel
    assert ("agent:genie:01f1cd7bb5441dfbad0bfcb2641eacdb", "table:main.brickwell_mfg_ai.gold_active_alarms", "reads_data") in rel
    drm = "agent:endpoint:agents_main-drm_transformation-drm_agent"
    assert (drm, "table:main.drm_transformation.docs_chunks_idx", "reads_data") in rel  # model_version_dependencies
    assert (drm, "model:main.drm_transformation.drm_agent", "uses_model") in rel
    assert ("tool:uc:main.supply_agentic_demo.ebom_mbom_gaps", "table:main.supply_agentic_demo.mbom", "reads_data") in rel
    assert ("mcp:uc:system.ai", "tool:uc:system.ai.python_exec", "exposes_tool") in rel
    assert ("app:aa-sil-np-mcp", "mcp:connection:aa_sil_np_mcp", "hosts") in rel
    assert ("mcp:system:system.ai.genie_one_mcp", "tool:mcp:system:system.ai.genie_one_mcp/genie_poll_response", "exposes_tool") in rel
    assert any(r[0].startswith("user:") and r[1] == "skill:uc:main.vital_skills.rwe-cohortstudy" and r[2] == "consumes" for r in rel)
    assert any(r[0].startswith("user:") and r[1] == "mcp:system:system.ai.genie_one_mcp" for r in rel)
    kinds = {r["edge_kind"] for r in q("SELECT DISTINCT edge_kind FROM lineage_edge")}
    assert kinds == {"declared", "observed", "data"}

    policies = {r["policy_id"]: r for r in q("SELECT * FROM policy")}
    assert "gw:agents_main-drm_transformation-drm_agent:inference_logging" in policies
    ugw = policies["ugw:system.ai.claude-sonnet-5:claude-sonnet-5-unsafe-content"]
    assert ugw["provider"] == "unity_gateway" and ugw["phase"] == "both" and ugw["action"] == "block"
    bound = q("SELECT policy_id FROM policy_binding WHERE asset_id = %s", (drm,))
    assert {r["policy_id"] for r in bound} == {f"gw:{drm.split(':', 2)[2]}:inference_logging"}

    grants = q("SELECT principal, privilege, inherited FROM access_grant WHERE asset_id = %s AND revoked_at IS NULL", (drm,))
    assert {(g["principal"], g["privilege"]) for g in grants} == {("admin@example.com", "CAN_MANAGE"), ("admins", "CAN_MANAGE")}
    you = q("SELECT principal, privilege FROM access_grant WHERE asset_id = 'mcp:connection:ext_mcp_you_dot_com'")
    assert ("account users", "USE_CONNECTION") in {(g["principal"], g["privilege"]) for g in you}
    owners = q("SELECT email FROM asset_owner WHERE asset_id = 'agent:genie:01f1d0c52c5212a0a957f1117779ad81'")
    assert owners == [{"email": "user10@example.com"}]

    usage = {r["asset_id"]: r for r in q("SELECT asset_id, sum(requests) AS n FROM usage_daily GROUP BY asset_id")}
    assert usage["mcp:system:system.ai.genie_one_mcp"]["n"] > 0
    assert usage["mcp:uc:system.ai"]["n"] > 0 and usage["agent:genie:01f1d0c52c5212a0a957f1117779ad81"]["n"] > 0
    assert usage["skill:uc:main.vital_skills.rwe-cohortstudy"]["n"] == 1
    sources = {r["source"] for r in q("SELECT DISTINCT source FROM usage_daily")}
    assert sources == {"ai_gateway_usage", "audit_managed_mcp", "audit_skill_load"}
    tools = {r["tool_name"] for r in q("SELECT DISTINCT tool_name FROM usage_daily WHERE asset_id = 'mcp:system:system.ai.genie_one_mcp'")}
    assert "genie_poll_response" in tools

    cost = {r["asset_id"]: float(r["usd"]) for r in q("SELECT asset_id, sum(usd) AS usd FROM cost_daily GROUP BY asset_id")}
    assert cost.get("agent:endpoint:ka-a176dc0c-endpoint", 0) > 0          # AGENT_BRICKS + its own VS endpoint
    assert cost.get("agent:app:agent-bricks-meridian-ab-demo", 0) > 0      # Agent Runtime app
    assert cost.get("agent:endpoint:mas-0849ad0e-endpoint", 0) == 0        # VECTOR_SEARCH shared namespace is skipped
    assert all(r["is_estimate"] for r in q("SELECT is_estimate FROM cost_daily"))

    traces = q("SELECT * FROM trace_recent ORDER BY request_time")
    assert {t["trace_id"] for t in traces} == {"tr-29c2a7575a6400617082329457bfd476", "tr-cde8bd0970714b610e35fafb7dd8c4aa"}
    t = next(t for t in traces if t["trace_id"] == "tr-cde8bd0970714b610e35fafb7dd8c4aa")
    assert t["asset_id"] == "agent:endpoint:mas-2e8a4ac6-endpoint" and t["duration_ms"] == 18031 and t["input_tokens"] == 10142
    assert q("SELECT sum(traces) AS n FROM trace_daily")[0]["n"] == 2


def test_no_request_or_response_text_in_trace_recent(registry, ctx_factory, q):
    run(ctx_factory(days=400), ["agent_endpoints", "agent_bricks", "traces_evals"])
    cols = {r["column_name"] for r in q("SELECT column_name FROM information_schema.columns WHERE table_schema = %s AND table_name = 'trace_recent'",
                                        (registry.schema,))}
    assert not cols & {"request", "response", "request_preview", "response_preview", "inputs", "outputs"}
    dump = json.dumps(q("SELECT * FROM trace_recent"), default=str)
    assert "<redacted" not in dump and "mlflow.traceInputs" not in dump and "mlflow.traceOutputs" not in dump


def test_environment_vars_never_reach_the_db(registry, ctx_factory, q):
    run(ctx_factory(days=400))
    dump = []
    for t in q("SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = 'BASE TABLE'", (registry.schema,)):
        dump.append(json.dumps(q(f'SELECT * FROM "{registry.schema}"."{t["table_name"]}"'), default=str))
    text = "\n".join(dump)
    assert len(text) > 10000
    for needle in ("environment_vars", "ENABLE_LANGCHAIN_STREAMING", "RETURN_REQUEST_ID_IN_RESPONSE", "{{secrets/",
                   "databricks_api_token", "client_secret"):
        assert needle not in text, needle


# ---------------------------------------------------------------------------------------------- provenance
def _override(asset_id, key, value, lock_mode):
    db.execute(
        """UPDATE asset_field SET override_value = %s::jsonb, provenance = 'admin', lock_mode = %s, overridden_by = 'steward@x.com',
                  overridden_at = now(), override_reason = 'clearer wording' WHERE asset_id = %s AND field_key = %s""",
        (json.dumps(value), lock_mode, asset_id, key))


def test_keep_override_survives_and_drift_flips(registry, ctx_factory, ws, q):
    aid = "agent:endpoint:mas-2e8a4ac6-endpoint"
    run(ctx_factory(), ["agent_endpoints", "agent_bricks"])
    _override(aid, "description", "Steward-approved description", "keep")
    run(ctx_factory(), ["agent_endpoints", "agent_bricks"])
    f = field(q, aid, "description")
    assert f["override_value"] == "Steward-approved description" and f["drift"] is False  # source unchanged: no drift

    sa = ws.routes[("GET", "/api/2.1/supervisor-agents")]["supervisor_agents"][0]
    sa["description"] = "Routes manufacturing questions (updated in Agent Bricks)."
    run(ctx_factory(), ["agent_endpoints", "agent_bricks"])
    f = field(q, aid, "description")
    assert f["override_value"] == "Steward-approved description" and f["provenance"] == "admin"
    assert f["source_value"] == "Routes manufacturing questions (updated in Agent Bricks)." and f["drift"] is True


def test_follow_override_resets_to_source(registry, ctx_factory, ws, q):
    aid = "mcp:connection:aa_sil_np_mcp"
    run(ctx_factory(), ["mcp_connections"])
    _override(aid, "purpose", "Temporary wording", "follow")
    conn = next(c for c in ws.routes[("GET", "/api/2.1/unity-catalog/connections")]["connections"] if c["name"] == "aa_sil_np_mcp")
    conn["comment"] = "aa-sil-np custom MCP server for the supply analytics app."
    run(ctx_factory(), ["mcp_connections"])
    f = field(q, aid, "purpose")
    assert f["override_value"] is None and f["provenance"] == "source" and f["drift"] is False
    assert f["source_value"] == "aa-sil-np custom MCP server for the supply analytics app."
    hist = q("SELECT old_value, new_value, actor FROM asset_field_history WHERE asset_id = %s AND field_key = 'purpose'", (aid,))
    assert hist == [{"old_value": "Temporary wording", "new_value": "aa-sil-np custom MCP server for the supply analytics app.",
                     "actor": "sync"}]


def test_human_governed_columns_survive_resync(registry, ctx_factory, ws, q):
    aid = "agent:genie:01f1cd7bb5441dfbad0bfcb2641eacdb"
    run(ctx_factory(), ["genie"])
    db.execute("""UPDATE asset SET lifecycle_status = 'approved', certification = 'certified', sensitivity = 'restricted',
                  risk_tier = 'high', domain = 'manufacturing', tags = ARRAY['gxp','ops'] WHERE asset_id = %s""", (aid,))
    db.execute("""INSERT INTO asset_field (asset_id, field_key, override_value, provenance) VALUES (%s, 'display_name', '"Mfg analytics"', 'admin')""", (aid,))
    db.execute("INSERT INTO asset_owner (asset_id, email, kind, source, added_by) VALUES (%s, 'lead@x.com', 'steward', 'assigned', 'admin@x.com')", (aid,))
    space = next(s for s in ws.routes[("GET", "/api/2.0/genie/spaces")]["spaces"] if s["space_id"] == aid.rsplit(":", 1)[1])
    space["title"] = "Brickwell manufacturing analytics v2"
    run(ctx_factory(), ["genie"])
    a = q("SELECT * FROM asset WHERE asset_id = %s", (aid,))[0]
    assert (a["lifecycle_status"], a["certification"], a["sensitivity"], a["risk_tier"], a["domain"], a["tags"]) == \
           ("approved", "certified", "restricted", "high", "manufacturing", ["gxp", "ops"])
    assert a["name"] == "Brickwell manufacturing analytics v2"  # source-owned column refreshed
    assert a["display_name"] != "Brickwell manufacturing analytics v2"  # display-name override respected
    assert {"email": "lead@x.com"} in q("SELECT email FROM asset_owner WHERE asset_id = %s", (aid,))


def test_platform_grants_revoked_when_no_longer_seen(registry, ctx_factory, ws, q):
    drm_acl = "/api/2.0/permissions/serving-endpoints/9a9ecf9effa149c8b38cdcb84485dc9f"
    run(ctx_factory(), ["agent_endpoints"])
    acl = ws.routes[("GET", drm_acl)]
    acl["access_control_list"] = [e for e in acl["access_control_list"] if e.get("group_name") != "admins"]
    run(ctx_factory(), ["agent_endpoints"])
    rows = q("SELECT principal, revoked_at, revoked_by FROM access_grant WHERE asset_id LIKE %s ORDER BY principal",
             ("%drm_agent",))
    assert [(r["principal"], r["revoked_at"] is not None, r["revoked_by"]) for r in rows] == \
           [("admins", True, "sync"), ("admin@example.com", False, None)]


# ---------------------------------------------------------------------------------------------- change events
def test_tool_removed_creates_one_breaking_change_with_impact(registry, ctx_factory, ws, q):
    mas = "agent:endpoint:mas-2e8a4ac6-endpoint"
    run(ctx_factory())
    assert q("SELECT count(*) AS n FROM change_event")[0]["n"] == 0  # first sighting writes v1, no events
    assert q("SELECT version, status FROM asset_version WHERE asset_id = %s", (mas,)) == [{"version": "v1", "status": "published"}]
    # a registered consumer of the supervisor, and a downstream agent (with an owner) that depends on it
    db.execute("""INSERT INTO subscription (asset_id, subscriber_email, created_by, notify_pref)
                  VALUES (%s, 'consumer@example.com', 'consumer@example.com', 'breaking_only')""", (mas,))
    downstream = "agent:endpoint:agent_eval_demo_coordinator"
    db.execute("INSERT INTO lineage_edge (src_id, dst_id, relation, edge_kind, source) VALUES (%s, %s, 'calls_agent', 'declared', 'manual')",
               (downstream, mas))

    tools = ws.routes[("GET", "/api/2.1/supervisor-agents/2e8a4ac6-17ca-492f-b00d-73df59a52526/tools")]["tools"]
    tools[:] = [t for t in tools if t["tool_id"] != "document_expert"]
    run(ctx_factory())
    changes = q("SELECT * FROM change_event")
    assert len(changes) == 1
    c = changes[0]
    assert c["asset_id"] == mas and c["breaking"] is True and c["detected_by"] == "sync" and c["status"] == "published"
    assert c["change_kinds"] == ["tools_removed"] and c["title"] == "1 tool removed"
    assert c["from_version"] == "v1" and c["to_version"] == "v2" and c["published_at"] is not None
    assert c["diff"] == [{"field": "tools[document_expert]", "before": {"name": "document_expert", "type": "knowledge_assistant",
                                                                          "target": "agent:endpoint:ka-a176dc0c-endpoint"}, "after": None}]
    assert set(c["metrics_before"]) == {"window_days", "requests", "error_rate", "cost_usd", "p95_ms", "eval"}
    impact = {(r["impact_type"], r["impacted_key"]): r for r in q("SELECT * FROM impact_item WHERE change_id = %s", (c["change_id"],))}
    assert ("subscriber", "consumer@example.com") in impact
    assert ("downstream_asset", downstream) in impact
    assert ("downstream_owner", "user01@example.com") in impact
    assert impact[("subscriber", "consumer@example.com")]["ack_status"] == "pending"
    notified = {r["recipient_email"] for r in q("SELECT recipient_email FROM notification WHERE ref_id = %s", (str(c["change_id"]),))}
    assert {"consumer@example.com", "user01@example.com"} <= notified
    assert q("SELECT version, status FROM asset_version WHERE asset_id = %s ORDER BY version", (mas,)) == \
           [{"version": "v1", "status": "superseded"}, {"version": "v2", "status": "published"}]
    audit = q("SELECT actor, action, entity_id FROM audit_log WHERE action = 'change.detected' AND entity_id = %s", (mas,))
    assert audit and audit[-1]["actor"] == "sync"
    # the removed tool's declared edge is gone
    assert not q("SELECT 1 FROM lineage_edge WHERE src_id = %s AND dst_id = 'agent:endpoint:ka-a176dc0c-endpoint'", (mas,))


def test_second_identical_run_is_idempotent(registry, ctx_factory, q):
    first = run(ctx_factory(days=400))
    counts = lambda: {t: q(f"SELECT count(*) AS n FROM {t}")[0]["n"] for t in  # noqa: E731
                      ("asset", "asset_version", "change_event", "lineage_edge", "access_grant", "policy", "usage_daily",
                       "cost_daily", "trace_recent", "asset_field", "asset_owner", "eval_result")}
    before = counts()
    second = run(ctx_factory(days=400))
    assert counts() == before
    assert before["change_event"] == 0
    changed = {r["collector"]: r["items_changed"] for r in second["runs"]}
    assert all(v == 0 for v in changed.values()), changed
    assert all(r["status"] == "succeeded" for r in first["runs"] + second["runs"])


def test_description_change_is_non_breaking_and_backfill_metrics(registry, ctx_factory, ws, q):
    run(ctx_factory(), ["skills"])
    listing = ws.routes[("GET", "/api/2.1/unity-catalog/skills")]({"parent": "schemas/main.vital_skills"}, None)
    listing["skills"][0]["description"] = "Cohort builder for OMOP and FHIR data (revised)."
    run(ctx_factory(), ["skills"])
    c = q("SELECT * FROM change_event")
    assert len(c) == 1 and c[0]["breaking"] is False and c[0]["change_kinds"] == ["description"]
    db.execute("UPDATE change_event SET published_at = now() - interval '8 days'")
    from registry import versioning

    with db.transaction() as cur:
        assert versioning.backfill_metrics_after(cur) == 1
    assert q("SELECT metrics_after FROM change_event")[0]["metrics_after"]["window_days"] == 7


def test_offline_and_monitoring_evals(registry, ctx_factory, ws, q):
    rows = ws.sql[[n for n, _ in ws.sql].index("FROM system.mlflow.run_metrics_history")][1]
    for r in rows:  # re-key the sampled scorer rows onto the supervisor's experiment
        r["experiment_id"] = "2347446610473193"
    run(ctx_factory(days=400), ["agent_endpoints", "agent_bricks", "traces_evals"])
    offline = q("SELECT scorer, mean_value, kind FROM eval_result WHERE kind = 'offline'")
    assert offline and {r["scorer"] for r in offline} <= {"abstention", "correctness", "groundedness"}
    assert all(r["mean_value"] is not None for r in offline)


# ---------------------------------------------------------------------------------------------- framework
def test_failed_collector_is_recorded_and_others_continue(registry, ctx_factory, ws, q):
    ws.routes[("GET", "/api/2.0/genie/spaces")] = base.ApiError("GET", "/api/2.0/genie/spaces", 500, "INTERNAL_ERROR", "boom")
    result = run(ctx_factory(), ["agent_endpoints", "genie"])
    statuses = {r["collector"]: r["status"] for r in result["runs"]}
    assert statuses == {"agent_endpoints": "succeeded", "genie": "failed"} and result["ok"] is True
    row = q("SELECT status, error, detail FROM sync_run WHERE collector = 'genie'")[0]
    assert row["status"] == "failed" and "500" in row["error"] and row["detail"]["fatal"]["status"] == 500


def test_run_all_skips_when_another_sync_holds_the_lock(registry, ctx_factory, q):
    with registry.direct_connection(autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (base.lock_key("some_other_schema"),))
        assert run(ctx_factory(), ["genie"])["runs"][0]["status"] == "succeeded"  # another schema's sync: no wait
        conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (base.lock_key("some_other_schema"),))
        conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (base.lock_key(registry.schema),))
        result = run(ctx_factory(), ["genie"])
        conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (base.lock_key(registry.schema),))
    assert result["skipped"] is True
    assert [r["status"] for r in q("SELECT status FROM sync_run ORDER BY run_id")] == ["succeeded", "skipped"]


def test_unknown_collector_is_rejected():
    with pytest.raises(ValueError, match="unknown collectors"):
        base.resolve(["nope"])


def test_job_exit_codes(monkeypatch, capsys):
    import importlib.util
    from pathlib import Path

    import collectors

    path = Path(__file__).resolve().parents[2] / "jobs" / "sync_registry.py"
    spec = importlib.util.spec_from_file_location("sync_registry_job", path)
    job = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(job)
    root = str(path.parents[1])
    monkeypatch.setattr(collectors, "run_all", lambda *a, **k: {"ok": False, "runs": [{"status": "failed"}]})
    assert job.main(["--root", root, "--skip-migrations", "--collectors", "genie"]) == 1
    monkeypatch.setattr(collectors, "run_all", lambda *a, **k: {"ok": True, "runs": [{"status": "partial"}, {"status": "failed"}]})
    assert job.main(["--root", root, "--skip-migrations"]) == 0
    assert job.main(["--root", root, "--skip-migrations", "--collectors", "bogus"]) == 2
    assert '"ok": true' in capsys.readouterr().out
