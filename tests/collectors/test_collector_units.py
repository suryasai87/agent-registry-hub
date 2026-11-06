"""Pure-function tests for the collectors (no database, no workspace)."""
from __future__ import annotations

import pytest

from collectors import base, util
from collectors.agent_endpoints import gateway_policies, is_agent_endpoint, model_family, subtype_of
from collectors.mcp_connections import is_mcp_connection, subtype_of as mcp_subtype
from collectors.mcp_managed import tables_in_sql
from collectors.traces_evals import compact_assessments, parse_trace
from fake_workspace import load
from registry import versioning


def test_duration_and_time_parsing():
    assert util.duration_ms("18.031s") == 18031
    assert util.duration_ms("0.307s") == 307
    assert util.duration_ms("1500ms") == 1500
    assert util.duration_ms(None) is None
    assert util.iso_to_dt("2026-09-29T22:13:52.086530155Z").microsecond == 86530  # nanoseconds from UC skills
    assert util.ms_to_dt(1783549379000).year == 2026


def test_purpose_is_first_sentence_capped():
    text = "Routes manufacturing questions to structured lakehouse analytics (Genie). And more detail."
    assert util.purpose_from(text) == "Routes manufacturing questions to structured lakehouse analytics (Genie)."
    long = "word " * 80
    assert len(util.purpose_from(long)) <= util.PURPOSE_MAX


def test_scrub_drops_secret_keys():
    detail = load("01b_serving_endpoint_detail_and_permissions.json")
    raw = detail["agents_main-drm_transformation-drm_agent"]["body"]
    gw = detail["member-services-chat"]["body"]
    text = str(util.scrub(raw)) + str(util.scrub(gw))
    assert "environment_vars" not in text and "{{secrets/" not in text and "databricks_api_token" not in text


def test_agent_endpoint_classification_from_probe_sample():
    eps = {e["name"]: e for e in load("01_serving_endpoints_list.json")["examples"]}
    assert is_agent_endpoint(eps["agent_eval_demo_coordinator"])
    assert is_agent_endpoint(eps["agents_main-guanyu_chen-multi_agent_langgraph"])  # no task, MONITOR tag
    assert not is_agent_endpoint(eps["appeal-overturn-model"])
    assert not is_agent_endpoint(eps["kie-1fbbf5ec-endpoint"])  # llm/v1/chat
    assert subtype_of(eps["mas-0849ad0e-endpoint"]) == "agent_bricks_supervisor"
    assert subtype_of(eps["ka-0445f231-endpoint"]) == "agent_bricks_knowledge_assistant"
    assert subtype_of(eps["kie-000ddc00-endpoint"]) == "agent_bricks_information_extraction"
    assert subtype_of(eps["agent_eval_demo_coordinator"]) == "custom_agent"
    assert model_family("databricks-claude-sonnet-4-5") == "claude"
    assert model_family("ppareek.agent_eval_demo.payer_coordinator_agent") == "ppareek.agent_eval_demo.payer_coordinator_agent"


def test_gateway_policies_one_per_guardrail_and_phase():
    gw = load("01b_serving_endpoint_detail_and_permissions.json")["member-services-chat"]["body"]["ai_gateway"]
    ids = {p["policy_id"]: p for p in gateway_policies("member-services-chat", gw)}
    assert set(ids) == {
        "gw:member-services-chat:safety:input", "gw:member-services-chat:safety:output",
        "gw:member-services-chat:pii:input", "gw:member-services-chat:pii:output",
        "gw:member-services-chat:rate_limit", "gw:member-services-chat:usage_tracking",
        "gw:member-services-chat:inference_logging", "gw:member-services-chat:fallback"}
    assert ids["gw:member-services-chat:pii:output"]["action"] == "mask"
    assert all(p["provider"] == "serving_ai_gateway" for p in ids.values())


def test_mcp_connection_detection_uses_the_string_flag():
    s04 = load("04_uc_connections.json")
    for c in s04["mcp_examples_trimmed"]:
        assert is_mcp_connection(c)
    assert not is_mcp_connection(s04["managed_postgresql_example"][0])
    assert not is_mcp_connection({"connection_type": "HTTP", "name": "x_mcp", "options": {"is_mcp_connection": "false"}})
    assert is_mcp_connection({"connection_type": "HTTP", "name": "acx_workbook_mcp", "options": {"host": "https://h"}})
    kinds = {c["name"]: mcp_subtype(c) for c in s04["mcp_examples_trimmed"]}
    assert kinds == {"aa_sil_np_mcp": "custom_app", "agentkit_deepwiki": "external_connection",
                     "ah_demo_confluence_mcp": "external_connection"}
    assert util.databricks_app_name("https://aa-sil-np-mcp-7474644717717567.aws.databricksapps.com") == "aa-sil-np-mcp"
    assert util.publisher_for_host("https://mcp.atlassian.com") == "Atlassian"
    assert util.publisher_for_host("https://mcp.example-vendor.io") == "example-vendor.io"
    assert util.publisher_for_host("https://agent-rwd-qa-1234567890123456.aws.databricksapps.com:443/mcp") is None
    assert util.publisher_for_host("https://adb-1.11.azuredatabricks.net") == "Databricks"


def test_uc_function_side_effect_ignores_destructive_hint():
    ann = load("04b_mcp_tools_list.json")["uc_schema_functions"]["example_tools"][0]["annotations"]
    assert ann["destructiveHint"] is True
    assert util.side_effect(ann, uc_function=True, sql_data_access="READS_SQL_DATA") == "read"
    ext = load("04b_mcp_tools_list.json")["external_ext_mcp_you_dot_com"]["tools"][0]["annotations"]
    assert util.side_effect(ext) == "read"


def test_sql_lineage_from_routine_definition():
    # the sampled body of main.supply_agentic_demo.ebom_mbom_gaps (05_uc_functions.json)
    body = ("SELECT e.part_id, p.part_name, p.subsystem, p.criticality, e.revision\n  FROM ebom e JOIN parts_master p "
            "ON e.part_id = p.part_id\n  LEFT JOIN mbom m ON e.part_id = m.part_id\n  WHERE m.part_id IS NULL")
    got = dict(tables_in_sql(body, "main", "supply_agentic_demo"))
    assert got == {"main.supply_agentic_demo.ebom": "function_schema",
                   "main.supply_agentic_demo.parts_master": "function_schema",
                   "main.supply_agentic_demo.mbom": "function_schema"}
    cte = "WITH x AS (SELECT * FROM main.core.dim_division) SELECT * FROM x JOIN range(3) r"
    assert tables_in_sql(cte, "c", "s") == [("main.core.dim_division", "qualified")]


def test_jsonrpc_parses_json_and_event_stream():
    assert base.parse_jsonrpc(b'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')["result"] == {"tools": []}
    sse = b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"t"}]}}\n\n'
    assert base.parse_jsonrpc(sse)["result"]["tools"][0]["name"] == "t"


def test_context_mcp_refuses_non_read_methods():
    ctx = base.Context(w=object(), host="https://h", workspace_id="1")
    with pytest.raises(ValueError, match="not allowed"):
        ctx.mcp("/api/2.0/mcp/external/x", "tools/call")
    with pytest.raises(ValueError, match="read-only"):
        ctx.sql("DELETE FROM t")


def test_api_retries_5xx_then_captures_exact_error():
    from databricks.sdk.errors import platform

    class Api:
        def __init__(self):
            self.n = 0

        def do(self, method, path, **kw):
            self.n += 1
            if self.n < 3:
                raise platform.InternalError("busy")  # 429/503 are retried inside the SDK; 5xx others here
            raise platform.PermissionDenied("User is missing USE CONNECTION on x", error_code="PERMISSION_DENIED")

    class W:
        api_client = Api()

    ctx = base.Context(w=W(), host="https://h", workspace_id="1", sleep=lambda s: None)
    with pytest.raises(base.ApiError) as e:
        ctx.api("GET", "/api/2.0/x")
    assert W.api_client.n == 3
    assert e.value.status == 403 and e.value.error_code == "PERMISSION_DENIED" and "USE CONNECTION" in e.value.message


@pytest.mark.parametrize("before,after,breaking,kinds", [
    ({"tools": [{"name": "a"}, {"name": "b"}]}, {"tools": [{"name": "a"}]}, True, ["tools_removed"]),
    ({"tools": [{"name": "a"}]}, {"tools": [{"name": "a"}, {"name": "b"}]}, False, ["tools_added"]),
    ({"tools": [{"name": "a", "required": []}]}, {"tools": [{"name": "a", "required": ["q"]}]}, True, ["schema"]),
    ({"tools": [{"name": "a"}]}, {"tools": [{"name": "a", "required": ["q"]}]}, False, ["schema"]),
    ({"served_entities": [{"name": "m", "family": "claude"}]}, {"served_entities": [{"name": "m", "family": "gpt"}]}, True, ["model"]),
    ({"served_entities": [{"name": "m", "family": "x.y.z", "entity_version": "1"}]},
     {"served_entities": [{"name": "m", "family": "x.y.z", "entity_version": "2"}]}, False, ["model"]),
    ({"sensitivity": "internal"}, {"sensitivity": "restricted"}, True, ["sensitivity"]),
    ({"sensitivity": "restricted"}, {"sensitivity": "internal"}, False, ["sensitivity"]),
    ({"endpoint_url": "https://a"}, {"endpoint_url": "https://b"}, True, ["endpoint"]),
    ({"auth": "BEARER_TOKEN"}, {"auth": "OAUTH_U2M_MAPPING"}, True, ["auth"]),
    ({"description_hash": "1"}, {"description_hash": "2"}, False, ["description"]),
    ({"instructions_hash": "1"}, {"instructions_hash": "2"}, False, ["prompt"]),
])
def test_breaking_rules(before, after, breaking, kinds):
    result = versioning.compare(versioning.normalize(before), versioning.normalize(after))
    assert result["breaking"] is breaking
    assert result["kinds"] == kinds


def test_auto_title():
    r = versioning.compare({"tools": [{"name": "a"}, {"name": "b"}, {"name": "c"}], "instructions_hash": "1"},
                           {"tools": [{"name": "c"}], "instructions_hash": "2"})
    assert versioning.title_for(r["parts"]) == "2 tools removed · instructions updated"


def test_trace_parsing_keeps_no_payloads():
    ts = load("11_mlflow_experiments_traces_logged_models.json")["trace_search_v3"]
    row = parse_trace(ts["example_trace_with_token_usage"], "agent:endpoint:mas-2e8a4ac6-endpoint", "2347446610473193")
    assert row["duration_ms"] == 18031 and row["input_tokens"] == 10142 and row["output_tokens"] == 414
    assert row["trace_name"] == "predict_stream" and row["user_ref"] == "15854ef5-560b-4320-bdba-7a00bb02a19e"
    assert set(row) == {"trace_id", "asset_id", "experiment_id", "request_time", "duration_ms", "state", "input_tokens",
                        "output_tokens", "user_ref", "trace_name", "assessments"}
    compact = compact_assessments(ts["example_trace_with_assessments"]["assessments"])
    assert {"name": "result_match", "value": "match", "source_type": "CODE"} in compact
    assert {"name": "passed", "value": True, "source_type": "CODE"} in compact
    assert all(a["name"] not in ("gt_sql", "gt_rows") for a in compact)  # expectations (ground truth) are not kept


def test_mcp_read_stops_at_the_response_even_if_the_stream_stays_open():
    class KeepAliveStream:
        """An SSE stream that sends the response, then keep-alive comments forever."""

        def __init__(self):
            self.parts = [b"event: message\n", b'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"t"}]}}\n\n']
            self.closed = False

        def read(self, n):
            return self.parts.pop(0) if self.parts else b": ping\n"

        def close(self):
            self.closed = True

    import time

    stream = KeepAliveStream()
    msg = base.read_jsonrpc(stream, 1, deadline=time.monotonic() + 5)
    assert msg["result"]["tools"][0]["name"] == "t" and stream.closed

    class Silent(KeepAliveStream):
        def read(self, n):
            return b": ping\n"

    with pytest.raises(base.ApiError, match="TIMEOUT"):
        base.read_jsonrpc(Silent(), 1, deadline=time.monotonic() + 0.05)


def test_me_lookup_does_not_deadlock_and_counts_calls():
    import threading

    class Api:
        def do(self, method, path, **kw):
            assert path == "/api/2.0/preview/scim/v2/Me"
            return {"userName": "Jane.Doe@Example.com", "groups": [{"display": "admins"}, {"display": "users"}]}

    class W:
        api_client = Api()

    ctx = base.Context(w=W(), host="https://h", workspace_id="1")
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("me", ctx.me), daemon=True)
    t.start()
    t.join(5)
    assert not t.is_alive(), "Context.me deadlocked"
    assert out["me"] == {"user_name": "jane.doe@example.com", "groups": ["admins", "users"]} and ctx.calls == 1


def test_mcp_session_id_is_echoed_on_tools_list():
    class Stream:
        def __init__(self, payload):
            self.payload = payload

        def read(self, n):
            out, self.payload = self.payload, b""
            return out

        def close(self):
            pass

    class Api:
        def __init__(self):
            self.seen = []

        def do(self, method, path, headers=None, body=None, response_headers=None, **kw):
            self.seen.append((body["method"], dict(headers or {})))
            if body["method"] == "initialize":
                return {"contents": Stream(b'{"jsonrpc":"2.0","id":0,"result":{"serverInfo":{"name":"tavily"}}}'),
                        "mcp-session-id": "sess-123"}
            if (headers or {}).get("mcp-session-id") != "sess-123":
                return {"contents": Stream(b'{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Missing mcp-session-id header"}}')}
            return {"contents": Stream(b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"tavily-search"}]}}\n\n')}

    class W:
        api_client = Api()

    init, tools = base.Context(w=W(), host="https://h", workspace_id="1").mcp_tools("/api/2.0/mcp/external/tavily")
    assert init["serverInfo"]["name"] == "tavily" and [t["name"] for t in tools] == ["tavily-search"]
    assert W.api_client.seen[1][1]["mcp-session-id"] == "sess-123"


@pytest.mark.parametrize("err,kind", [
    (base.ApiError("POST", "/p", 403, "PERMISSION_DENIED", "User is missing USE CONNECTION on x"), "access_required"),
    (base.ApiError("POST", "/p", 200, None, '{"error_code":"UNAUTHENTICATED","message":"Credential for user identity(\'1\') is not found"}'), "user_auth_required"),
    (base.ApiError("POST", "/p", 401, None, "Failed to obtain a fresh access token from the identity provider (HTTP status code 401)"), "credential_error"),
    (base.ApiError("POST", "/p", 400, None, "{'code': -32600, 'message': 'Missing mcp-session-id header.'}"), "protocol_error"),
    (base.ApiError("POST", "/p", 200, "NOT_JSONRPC", "the server answered with HTML, not JSON-RPC"), "error"),
])
def test_tools_list_failures_are_classified(err, kind):
    from collectors.mcp_connections import tools_failure

    assert tools_failure(err)[0] == kind
