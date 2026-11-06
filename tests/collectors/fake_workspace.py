"""A fake Databricks workspace for the collector tests, assembled ONLY from real responses:
``docs/research/samples/*.json`` (copied to tests/fixtures/collectors) and ``live_shapes.json`` (trimmed,
read-only captures from the same workspace: the endpoints behind the sampled supervisor and knowledge assistant,
a Genie serialized space, UC MCP services, and real output rows of the collectors' own SQL).

``FakeContext`` serves REST by (method, path) and SQL by statement substring. Unknown REST paths answer 404 and
unrouted per-object ACL/grant reads answer 403, as they do for a caller without permission.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable

from collectors.base import ApiError, Context

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "collectors"
HOST = "https://your-workspace.cloud.databricks.com"
WORKSPACE_ID = "1234567890123456"
ME = {"user_name": "admin@example.com", "groups": ["admins", "users"]}


def load(name: str) -> Any:
    return json.loads((FIX / name).read_text())


class FakeContext(Context):
    def __init__(self, ws: "Workspace", days: int = 30):
        super().__init__(w=object(), days=days, warehouse_id="fake-warehouse", host=HOST, workspace_id=WORKSPACE_ID,
                         sleep=lambda s: None)
        self.ws = ws
        self._me = dict(ME)
        self.requests: list[tuple] = []
        self.statements: list[str] = []

    def api(self, method, path, body=None, query=None, *, headers=None, raw=False, retries=3):
        self.requests.append((method, path, copy.deepcopy(query), copy.deepcopy(body)))
        self.calls += 1
        handler = self.ws.routes.get((method, path))
        if handler is None:
            for prefix, status in self.ws.denied_prefixes:
                if path.startswith(prefix):
                    raise ApiError(method, path, status, "PERMISSION_DENIED", "User does not have permission")
            raise ApiError(method, path, 404, "ENDPOINT_NOT_FOUND", f"No API found for '{method} {path}'")
        result = handler(query or {}, body) if callable(handler) else handler
        if isinstance(result, Exception):
            raise result
        return copy.deepcopy(result)

    def sql(self, statement, params=None, **kwargs):
        self.statements.append(statement)
        for needle, rows in self.ws.sql:
            if needle in statement:
                return copy.deepcopy(rows(params) if callable(rows) else rows)
        raise AssertionError(f"unexpected SQL in test: {statement.strip()[:160]}")

    def mcp_tools(self, path):
        self.requests.append(("POST", path, None, {"method": "tools/list"}))
        result = self.ws.mcp.get(path)
        if result is None:
            raise ApiError("POST", path, 404, "ENDPOINT_NOT_FOUND", "no such MCP server")
        if isinstance(result, Exception):
            raise result
        return copy.deepcopy(result)


class Workspace:
    """Mutable routes so a test can change the 'source' between two syncs."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Any] = {}
        self.sql: list[tuple[str, Any]] = []
        self.mcp: dict[str, Any] = {}
        self.denied_prefixes = [("/api/2.0/permissions/", 403), ("/api/2.1/unity-catalog/effective-permissions/", 403)]

    def get(self, path: str, value: Any) -> None:
        self.routes[("GET", path)] = value

    def post(self, path: str, value: Any) -> None:
        self.routes[("POST", path)] = value


def by_query(key: str, mapping: dict[str, Any], default: Any) -> Callable:
    return lambda query, body: mapping.get((query or {}).get(key), default)


def build() -> Workspace:
    ws = Workspace()
    s01, s01b, s02 = load("01_serving_endpoints_list.json"), load("01b_serving_endpoint_detail_and_permissions.json"), load("02_agent_bricks_tiles.json")
    s02c, s03, s04 = load("02c_agent_bricks_v21_supervisor_ka.json"), load("03_genie_spaces.json"), load("04_uc_connections.json")
    s04b, s06, s08 = load("04b_mcp_tools_list.json"), load("06_uc_registered_models.json"), load("08_apps.json")
    s10c, s11, s13 = load("10c_system_tables_aggregates.json"), load("11_mlflow_experiments_traces_logged_models.json"), load("13_uc_skills_and_agent_services.json")
    live = load("live_shapes.json")

    # ---------------------------------------------------------------- serving endpoints
    detail_keys = ("agents_main-drm_transformation-drm_agent", "member-services-chat",
                   "mas-0849ad0e-endpoint", "ka-0445f231-endpoint")
    details = {k: s01b[k]["body"] for k in detail_keys}
    # The list API is served the DETAIL bodies where we have them, so environment_vars (and a {{secrets/...}}
    # reference) are present in what the collector reads: they must never reach the registry.
    endpoints = [details.get(e["name"], e) for e in s01["examples"]] + [details["agents_main-drm_transformation-drm_agent"],
                                                                         details["member-services-chat"]] + live["serving_endpoints_extra"]
    ws.get("/api/2.0/serving-endpoints", {"endpoints": endpoints})
    for e in endpoints:
        ws.get(f"/api/2.0/serving-endpoints/{e['name']}", details.get(e["name"], e))
    ws.get("/api/2.0/permissions/serving-endpoints/9a9ecf9effa149c8b38cdcb84485dc9f",
           s01b["agents_main-drm_transformation-drm_agent__permissions"]["body"])
    for e in live["serving_endpoints_extra"]:
        ws.get(f"/api/2.0/permissions/serving-endpoints/{e['id']}", live["endpoint_acls"][e["name"]])
    ws.get("/api/2.1/unity-catalog/models/main.drm_transformation.drm_agent/versions/1", s06["version_detail"]["body"])

    # ---------------------------------------------------------------- Agent Bricks
    tiles = list(s02["list_examples"])
    ws.get("/api/2.0/tiles", {"tiles": tiles})
    sa = s02c["supervisor_agent_get"]["body"]
    ws.get("/api/2.1/supervisor-agents", {"supervisor_agents": [sa] + s02c["supervisor_agents_list"]["examples"]})
    ws.get(f"/api/2.1/supervisor-agents/{sa['supervisor_agent_id']}/tools", s02c["supervisor_agent_tools"]["body"])
    ws.get(f"/api/2.1/supervisor-agents/{sa['supervisor_agent_id']}/examples", s02c["supervisor_agent_examples"]["body"])
    other = s02c["tool_examples_by_type"]
    ws.get("/api/2.1/supervisor-agents/a9fab447-722e-400d-ad3e-14434005ae4c/tools",
           {"tools": [other["genie_space"], other["uc_function"]]})
    ws.get("/api/2.1/supervisor-agents/8d9e9b71-2c90-4bee-bf33-86c4d6dd6f6e/tools", {"tools": []})
    ka = s02c["knowledge_assistant_get"]["body"]
    ws.get("/api/2.1/knowledge-assistants", {"knowledge_assistants": [ka]})
    ws.get(f"/api/2.1/knowledge-assistants/{ka['id']}/knowledge-sources", s02c["knowledge_sources"]["body"])
    ws.get(f"/api/2.1/knowledge-assistants/{ka['id']}/examples", {})

    # ---------------------------------------------------------------- Genie
    spaces = s03["examples"] + [live["genie_space_list_item"]]
    ws.get("/api/2.0/genie/spaces", {"spaces": spaces})
    ws.get(f"/api/2.0/genie/spaces/{s03['examples'][0]['space_id']}", s03["detail"]["get_space"]["body"])
    ws.get(f"/api/2.0/genie/spaces/{live['genie_space_detail']['space_id']}", live["genie_space_detail"])
    ws.get(f"/api/2.0/permissions/genie/{s03['examples'][0]['space_id']}", s03["detail"]["permissions_genie"]["body"])
    ws.get(f"/api/2.0/permissions/genie/{live['genie_space_detail']['space_id']}", live["genie_space_acl"])

    # ---------------------------------------------------------------- UC connections + external MCP
    conns = [{k: v for k, v in c.items() if k != "options_keys_present_but_omitted"} for c in s04["mcp_examples_trimmed"]]
    conns += [live["connection_you_dot_com"]] + s04["managed_postgresql_example"]
    ws.get("/api/2.1/unity-catalog/connections", {"connections": conns})
    for name, perms in live["connection_effective_permissions"].items():
        ws.get(f"/api/2.1/unity-catalog/effective-permissions/connection/{name}", perms)
    you = s04b["external_ext_mcp_you_dot_com"]
    ws.mcp["/api/2.0/mcp/external/ext_mcp_you_dot_com"] = ({}, you["tools"])
    deep = s04b["external_agentkit_deepwiki"]["error"]
    ws.mcp["/api/2.0/mcp/external/agentkit_deepwiki"] = ApiError("POST", "/api/2.0/mcp/external/agentkit_deepwiki", 403,
                                                                deep["error_code"], deep["message"])
    for name in ("aa_sil_np_mcp", "ah_demo_confluence_mcp"):
        ws.mcp[f"/api/2.0/mcp/external/{name}"] = ApiError("POST", f"/api/2.0/mcp/external/{name}", 403, "PERMISSION_DENIED",
                                                           f"User is missing USE CONNECTION on {name}")

    # ---------------------------------------------------------------- UC functions (managed MCP)
    ws.sql.append(("FROM system.information_schema.routines", live["routines_rows"]))
    ws.sql.append(("FROM system.information_schema.parameters", live["parameters_rows"]))
    ws.mcp["/api/2.0/mcp/functions/system/ai"] = (s04b["system_ai_initialize"]["body"]["result"], s04b["system_ai"]["example_tools"])

    # ---------------------------------------------------------------- Unity Gateway MCP services
    ws.sql.append(("mcp_metadata.server_type AS server_type", live["mcp_system_usage_rows"]))
    ws.sql.append(("FROM system.information_schema.schemata", []))
    ws.get("/api/2.1/unity-catalog/mcp-services", by_query("parent", {
        "schemas/system.ai": {"mcp_services": live["mcp_services_system_ai"]},
        "schemas/main.lilly_heor_rwe_demo": {"mcp_services": live["mcp_services_lilly"]},
    }, {}))
    ws.get("/api/2.1/unity-catalog/effective-permissions/mcp_service/system.ai.slack", live["mcp_service_effective_permissions_slack"])

    # ---------------------------------------------------------------- skills
    ws.sql.append(("service_name = 'aiGatewaySkills'", [
        {"day": r["day"], "action_name": "skillLoad", "uc_location": r["fqn"].rsplit(".", 1)[0], "fqn": r["fqn"],
         "email": r["email"], "events": r["loads"], "errors": r["errors"]} for r in live["skill_load_rows"]]))
    skills = s13["list"]["examples"] + [s13["get"]["body"]]
    ws.get("/api/2.1/unity-catalog/skills", by_query("parent", {"schemas/main.vital_skills": {"skills": skills}}, {}))
    for s in skills:
        ws.get(f"/api/2.1/unity-catalog/effective-permissions/skill/{s['name'].removeprefix('skills/')}",
               s13["effective_permissions"]["body"])

    # ---------------------------------------------------------------- apps
    ws.get("/api/2.0/apps", {"apps": s08["examples"]})
    ws.get("/api/2.0/permissions/apps/agent-bricks-meridian-ab-demo", live["app_acl_agent_bricks_meridian"])

    # ---------------------------------------------------------------- usage, policies, cost
    ws.sql.append(("percentile_approx(latency_ms, 0.95)", live["gateway_usage_rows"]))
    ws.sql.append(("explode(model_metadata.config.service_policies)", live["policy_config_rows"]))
    ws.sql.append(("explode(model_metadata.config.rate_limits)", []))
    ws.sql.append(("gateway_feature_results.service_policies", []))
    ws.sql.append(("FROM system.serving.endpoint_usage", [
        {"day": "2026-10-25", "endpoint_name": r[0], "requester": "p***@databricks.com", "requests": int(r[1]), "errors": 0,
         "input_tokens": int(r[2]), "output_tokens": int(r[3])} for r in s10c["AGG_serving_endpoint_usage_top10_30d"]["rows"]]))
    ws.sql.append(("service_name = 'mcpService'", live["audit_mcp_call_rows"]))
    ws.sql.append(("service_name = 'managedMcp'", live["audit_managed_mcp_rows"]))
    ws.sql.append(("JOIN system.billing.list_prices", live["cost_rows"]))

    # ---------------------------------------------------------------- traces + evals
    ts = s11["trace_search_v3"]
    traces = [ts["example_trace_drm_agent"], ts["example_trace_with_token_usage"], ts["example_trace_with_assessments"]]

    def search(query, body):
        exp = body["locations"][0]["mlflow_experiment"]["experiment_id"]
        return {"traces": [t for t in traces if t["trace_location"]["mlflow_experiment"]["experiment_id"] == exp]}

    ws.post("/api/3.0/mlflow/traces/search", search)
    ws.sql.append(("FROM system.mlflow.run_metrics_history", live["offline_eval_rows"]))
    return ws
