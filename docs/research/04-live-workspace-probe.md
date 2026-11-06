# 04 — Live workspace probe (read-only)

| | |
|---|---|
| **Workspace** | `https://your-workspace.cloud.databricks.com` (workspace_id `1234567890123456`, account `05d08df7-ae03-43ad-bbae-14babb530ec0`, metastore `metastore_aws_us_east_1` / `c0da88f1-c020-4992-b8c9-c828e556889d`) |
| **Date of probe** | 2026-10-25 (US evening; some timestamps are already 2026-10-26 UTC) |
| **Identity** | `admin@example.com`. This user **is a workspace admin** (member of `admins`, 5 groups in total). |
| **Tooling** | Databricks CLI **v1.20.0** with profile `DEFAULT` (`auth_type = databricks-cli`) for `current-user me`, `postgres list-projects`, `database list-database-instances` and the first MCP `tools/list`. All other REST calls went through `databricks-sdk 0.91.0` `WorkspaceClient(profile="DEFAULT")` plus `requests`, so the exact HTTP status codes were captured. This is the same profile and the same OAuth token as the CLI. |
| **Guard rails** | A wrapper allowed only `GET`, plus `POST` on read-only endpoints (`/sql/statements` with SELECT/DESCRIBE/SHOW/WITH only, MLflow `*/search`, MCP `tools/list` and `initialize`). Nothing was created, updated, deleted, granted, started or stopped. |
| **SQL warehouse** | `bda22e07d7130a32` ("Shared SQL Warehouse", serverless, **already RUNNING**). `4b28691c780d9875` (Serverless Starter) was **STOPPED**. Querying it would have auto-started it, so it was not used. |
| **Raw samples** | `docs/research/samples/*.json`. There is one file per probe, each ≤ 50 KB. Request/response text is redacted, `requester` emails in usage samples are masked, and serving-endpoint `environment_vars` values are redacted. A regex scan for tokens and secrets found nothing (the one hit was the connection type name `AWS_SECRETS_MANAGER`). |

> **CLI gotcha.** On this machine, some CLI v1.20 commands (e.g. `databricks current-user me`) print a preamble line to **stdout** before the JSON: `Databricks skills are not installed. To work with Databricks reliably, first run: databricks aitools install`. Any collector that shells out to the CLI must strip everything before the first `{`/`[`. Better still, call REST through the SDK.

> **Visibility caveat (inference, not probed).** Every list below ran as a **workspace admin**. For example, all 208 endpoints returned `permission_level: CAN_MANAGE`. The app's service principal (or an OBO user) will only see the objects it is granted. Treat the counts as an upper bound, and design the collectors for caller-scoped results.

---

## 1. Availability table

| # | Probe | Path / table | HTTP / SQL result | Notes |
|---|---|---|---|---|
| 1 | Serving endpoints list | `GET /api/2.0/serving-endpoints` | **200** | 208 endpoints, single page (no `next_page_token`). |
| 1 | Endpoint detail | `GET /api/2.0/serving-endpoints/{name}` | **200** | Adds `config.traffic_config`, `config.config_version`, `resource_credential_strategy`. Served entities add `workload_size`, `workload_type`, `scale_to_zero_enabled`, `environment_vars`, `state.deployment`. |
| 1 | Endpoint OpenAPI | `GET /api/2.0/serving-endpoints/{name}/openapi` | **200** | OpenAPI 3.1 document. |
| 1 | Endpoint ACL | `GET /api/2.0/permissions/serving-endpoints/{endpoint_id}` | **200** | Keyed by `id` (hex), not by name. |
| 1 | Endpoint permission levels | `GET /api/2.0/permissions/serving-endpoints/{id}/permissionLevels` | **200** | `CAN_VIEW`, `CAN_QUERY`, `CAN_MANAGE`. |
| 2 | Agent Bricks tiles | `GET /api/2.0/tiles` | **200** | 93 tiles in 1 page (MAS 41, KA 33, KIE 10, AI_EXTRACT 8, T2T 1). |
| 2 | Tile detail | `GET /api/2.0/tiles/{tile_id}` | **200** | Works for MAS/KA/AI_EXTRACT. AI_EXTRACT/KIE add `task_spec`. |
| 2 | KA list (v2.0) | `GET /api/2.0/knowledge-assistants` | **404** `ENDPOINT_NOT_FOUND` | "No API found for 'GET /knowledge-assistants'" |
| 2 | KA get (v2.0) | `GET /api/2.0/knowledge-assistants/{tile_id}` | **200** | `knowledge_assistant.{tile, knowledge_sources[], status}` |
| 2 | MAS list (v2.0) | `GET /api/2.0/multi-agent-supervisors` | **404** `ENDPOINT_NOT_FOUND` | |
| 2 | MAS get (v2.0) | `GET /api/2.0/multi-agent-supervisors/{tile_id}` | **200** | `multi_agent_supervisor.{tile, agents[], status}` |
| 2 | **KA list (v2.1)** | `GET /api/2.1/knowledge-assistants` | **200** | 33 KAs, resource-style names `knowledge-assistants/{id}`. |
| 2 | KA get + sources (v2.1) | `GET /api/2.1/knowledge-assistants/{id}`, `/knowledge-sources`, `/examples` | **200 / 200 / 200 (`{}`)** | |
| 2 | **Supervisor agents (v2.1)** | `GET /api/2.1/supervisor-agents`, `/{id}`, `/{id}/tools`, `/{id}/examples` | **200** | 41 supervisors. `tools[]` is the cleanest lineage source (see §2). |
| 2 | Other guesses | `/api/2.0/agent-bricks`, `/api/2.0/agent-bricks/{tiles,knowledge-assistants,multi-agent-supervisors,supervisor-agents}`, `/api/2.0/agentbricks/tiles`, `/api/2.0/supervisor-agents`, `/api/2.0/agents`, `/api/3.0/supervisor-agents` | **404** (empty body) | No such routes. |
| 2 | Genie Agents | `GET /api/2.0/genie/agents` | **404** `NOT_FOUND` | "The Genie Agent API is not available in this workspace." |
| 2 | ai-dev-kit MCP `manage_ka` | `action=get, tile_id=0445f231-…` | **ERROR** | `'WorkspaceClient' object has no attribute 'knowledge_assistants'` (SDK too old in the MCP server). **There is no `list` action.** |
| 2 | ai-dev-kit MCP `manage_mas` | `action=get, tile_id=0849ad0e-…` | **OK** | Returns `{tile_id, name, description, endpoint_status, agents[], examples_count, instructions}`. **There is no `list` action.** |
| 3 | Genie spaces | `GET /api/2.0/genie/spaces?page_size=100` | **200** | 230 spaces, 3 pages. **No creator/owner field.** |
| 3 | Genie space detail | `GET /api/2.0/genie/spaces/{id}` (`?include_serialized_space=true`) | **200** | Adds `parent_path`. With the flag it also adds `serialized_space` (JSON string) and `etag`. |
| 3 | Genie ACL | `GET /api/2.0/permissions/genie/{space_id}` | **200** | `object_id` = `/genie/{numeric_id}`. `/permissions/dashboards/{space_id}` returns 404. |
| 4 | UC connections | `GET /api/2.1/unity-catalog/connections?max_results=100` | **200** | 3,100 connections, metastore-wide, **31 pages**. 144 are `HTTP`. **95 have `options.is_mcp_connection == "true"`** (a string). |
| 4 | Connection effective perms | `GET /api/2.1/unity-catalog/effective-permissions/connection/{name}` | **200** | Used to find connections with `USE_CONNECTION`. |
| 4 | Managed MCP — system.ai | `POST /api/2.0/mcp/functions/system/ai` `tools/list` | **200** (CLI and REST) | 16 tools. |
| 4 | Managed MCP — UC schema | `POST /api/2.0/mcp/functions/main/supply_agentic_demo` | **200** | 3 tools. |
| 4 | Managed MCP — Genie | `POST /api/2.0/mcp/genie/01f1d0c52c5212a0a957f1117779ad81` | **200** | 2 tools: `query_space_{id}`, `poll_response_{id}`. |
| 4 | External MCP (no grant) | `POST /api/2.0/mcp/external/agentkit_deepwiki` | **403** `PERMISSION_DENIED` | "Failed request to https://mcp.deepwiki.com:443/mcp. Error: User is missing USE CONNECTION on agentkit_deepwiki" |
| 4 | External MCP (granted) | `POST /api/2.0/mcp/external/ext_mcp_you_dot_com` | **200** | 1 tool (`you-finance`), which includes `title`. |
| 4 | MCP `initialize` | `POST /api/2.0/mcp/functions/system/ai` | **200** | `serverInfo: DatabricksMCPServer 0.1.0`, `protocolVersion: 2025-06-18`. |
| 5 | UC functions | `GET /api/2.1/unity-catalog/functions?catalog_name=main&schema_name=supply_agentic_demo` | **200** | 3 functions. The list **omits** `input_params`/`return_params`; the GET includes `return_params`. |
| 5 | Function grants | `GET /api/2.1/unity-catalog/permissions/function/{full_name}` | **200** `{}` | No direct grants. |
| 5 | Function effective grants | `GET /api/2.1/unity-catalog/effective-permissions/function/{full_name}` | **200** | Includes `inherited_from_type`/`inherited_from_name`. |
| 5 | Functions, metastore-wide | `system.information_schema.routines` | **OK** | 409 functions in 94 schemas (non-`system`). This is the discovery path. |
| 6 | UC registered models | `GET /api/2.1/unity-catalog/models?max_results=20` | **200** | Returned **9** rows plus `next_page_token` (short pages). 141 models after 15 pages and **still incomplete**. |
| 6 | Model / versions / version | `GET …/models/{fn}`, `…/versions`, `…/versions/{v}` | **200** | The single-version GET adds **`model_version_dependencies`**. |
| 7 | RFA — function | `GET /api/3.0/rfa/destinations/function/{full_name}` | **200** | Also 200 with `FUNCTION` (upper case). |
| 7 | RFA — catalog | `GET /api/3.0/rfa/destinations/catalog/main` | **200** | |
| 7 | RFA — connection / table | `GET /api/3.0/rfa/destinations/connection/{name}`, `/table/{fqn}` | **200** | |
| 7 | RFA batch / list | `/api/3.0/rfa/destinations?…`, `/destinations:batchGet`, `/destinations/batch`, `/rfa/requests` | **404** `ENDPOINT_NOT_FOUND` | Only the per-securable GET exists via GET. |
| 8 | Apps | `GET /api/2.0/apps` | **200** | **Exactly 100 apps.** No `next_page_token`; re-paginated at 30 per page gives 4 pages and 100 unique names. **The workspace is at the 100-app cap.** |
| 8 | Name check | `GET /api/2.0/apps/agent-registry-hub` | **404** `NOT_FOUND` | Name is free. |
| 8 | App ACL | `GET /api/2.0/permissions/apps/{name}` | **200** | |
| 9 | Lakebase projects | `databricks postgres list-projects -o json` | **exit 0** | 54 projects, 17 owned by the current user. REST `GET /api/2.0/postgres/projects` returns **200**. |
| 9 | Branch / endpoint state | `GET /api/2.0/postgres/projects/{id}/branches`, `GET /api/2.0/postgres/{branch}/endpoints` | **200** | State lives here, not on the project. |
| 9 | Quota | `GET /api/2.0/postgres/quotas`, `/postgres/projects:quota` | **404** | There is no quota API. |
| 9 | Provisioned instances | `databricks database list-database-instances -o json` | **exit 0** | 10 instances, all `AVAILABLE`. |
| 10 | System schemas | `SHOW SCHEMAS IN system` | **OK** | 22 schemas (list in §10). |
| 10 | `system.ai_gateway.usage` | DESCRIBE + SELECT | **OK** | 40 columns. ~3.4k rows in 30 d for this workspace. |
| 10 | `system.ai_gateway.external_model_spend` | DESCRIBE + SELECT | **OK, 0 rows** | Table exists but has no rows for this workspace. |
| 10 | `system.serving.endpoint_usage` | DESCRIBE + SELECT | **OK** | 14 columns. |
| 10 | `system.serving.served_entities` | DESCRIBE + SELECT | **OK** | 18 columns. |
| 10 | `system.billing.usage` | DESCRIBE + SELECT | **OK** | 18 columns. `usage_metadata` has 56 fields. |
| 10 | `system.billing.list_prices` | DESCRIBE + SELECT | **OK** | 8 columns. |
| 10 | `system.access.audit` | DESCRIBE + aggregates | **OK** | 17 columns. |
| 10 | `system.access.table_lineage` | DESCRIBE + aggregates | **OK** | 26 columns. **No agent/serving entity types.** |
| 10 | `system.mlflow.*` | `SHOW TABLES`, DESCRIBE, SELECT | **OK** | `experiments_latest`, `runs_latest`, `run_metrics_history`. **There is no traces table.** |
| 10 | `system.telemetry.otel_*` | DESCRIBE + COUNT | **OK, 0 rows (30 d)** | `otel_spans` / `otel_logs` / `otel_metrics` exist but are empty. |
| 11 | Experiment search | `POST /api/2.0/mlflow/experiments/search` | **200** | The filter ``tags.`mlflow.experimentKind` = 'genai_development'`` works. |
| 11 | Trace search v3 | `POST /api/3.0/mlflow/traces/search` (`locations[]`) | **200** | 162 traces scanned across 10 experiments. |
| 11 | Trace list v2 | `GET /api/2.0/mlflow/traces?experiment_ids=…` | **200** | Older shape (`request_id`, `timestamp_ms`, `request_metadata[]`). |
| 11 | Trace get v3 | `GET /api/3.0/mlflow/traces/{trace_id}` | **200** | `{trace: {trace_info: …}}`. `GET …/{trace_id}/info` returns **404**. |
| 11 | Logged models | `POST /api/2.0/mlflow/logged-models/search` | **200** | `GET /api/2.0/mlflow/logged-models/search` returns **400** ("Invalid model id: search, a model id must start with 'm-'"). `GET /api/2.0/mlflow/logged-models/{m-…}` returns **200**. |
| 12 | Current user | `databricks current-user me` (= `GET /api/2.0/preview/scim/v2/Me`) | **200** | `admin@example.com`, admin = **true**. |
| + | **UC Skills** (bonus) | `GET /api/2.1/unity-catalog/skills?parent=schemas/{cat}.{schema}` | **200** | 9 skills in `main.vital_skills`. A `parent` is **required** and must start with `schemas/`. |
| + | Skill get / grants | `GET /api/2.1/unity-catalog/skills/{fqn}`, `/permissions/skill/{fqn}`, `/effective-permissions/skill/{fqn}` | **200 / 200 `{}` / 200** | `securable_type: SKILL`. |
| + | UC agent-services | `GET /api/2.1/unity-catalog/agent-services` (± `parent=schemas/…`) | **200 `{}`** | Route exists but has no objects here. `GET …/agent-services/{fqn}` returns 404 "AgentService not found". |
| + | MCP-server registries | `/api/2.1/unity-catalog/{mcp-servers,mcp_servers,external-mcp-servers}`, `/api/2.0/{mcp-servers,mcp/servers}`, `/api/2.0/ai-gateway/{skills,mcp-servers,endpoints}` | **404** | No REST list of the `system.ai.*` MCP servers was found. |

The full status map of every path tried is in `samples/00_path_availability_index.json`.

---

## 2. Probe 1 — Serving endpoints

**Sample:** `samples/01_serving_endpoints_list.json`, `samples/01b_serving_endpoint_detail_and_permissions.json`

**Counts (208 endpoints):**

| `task` | count | | `endpoint_type` | count | | `tile_endpoint_metadata.problem_type` | count |
|---|---|---|---|---|---|---|---|
| `agent/v1/responses` | 80 | | *(absent)* | 148 | | `MULTI_AGENT_SUPERVISOR` | 41 |
| `llm/v1/chat` | 59 | | `FOUNDATION_MODEL_API` | 56 | | `KNOWLEDGE_ASSISTANT` | 33 |
| *(key absent — custom models)* | 56 | | `EXTERNAL_MODEL` | 4 | | `INFORMATION_EXTRACTION` | 10 |
| `agent/v1/chat` | 9 | | | | | `MODEL_SPECIALIZATION` | 1 |
| `llm/v1/embeddings` | 3 | | | | | *(none)* | 123 |
| `llm/v1/systemone` | 1 | | | | | | |

- **89 agent endpoints** have `task` starting with `agent/`. That covers the 41 MAS and 33 KA tiles (all `agent/v1/responses`) plus custom UC-model agents.
- `state.ready`: 201 `READY`, 7 `NOT_READY`.
- `ai_gateway` is present on **17** endpoints: `inference_table_config.enabled=true` on 17, `usage_tracking_config.enabled=true` on **only 6**, `rate_limits` on 3, **`guardrails` on 4** (`ads-ai-gateway`, `ati_governed_llm`, `ecp-ai-gateway`, `member-services-chat`), `fallback_config` on 1.
- `tags` are present on 45 endpoints. The tag key **`MONITOR_EXPERIMENT_ID`** links an agent endpoint to its MLflow experiment, which makes it a reliable endpoint→experiment join.
- The 56 FMAPI endpoints (`endpoint_type: FOUNDATION_MODEL_API`) have **no** `creator`, `id`, `route_optimized`, `creator_*` or `description`. They do have `task` (`llm/v1/chat|embeddings|systemone`), `capabilities{function_calling, image_input, long_context, …}` and `foundation_model.{price, input_price, price_unit ("DBUs per 1M tokens"), pricing_model, model_class, api_types[], ai_gateway_v2_supported}`. A *different* set of 56 endpoints (custom UC-model endpoints, `endpoint_type` absent) is the one with **no `task` key**.

**Field presence (list):** `name` 208, `creation_timestamp` 208 (epoch ms), `last_updated_timestamp` 208, `state` 208 (`ready`, `config_update`, `suspend`, `system_update_failure`), `config` 208 (`served_entities` 121 / legacy `served_models` 61), `permission_level` 208, `creator` 152, `id` 152, `route_optimized` 152, `task` 152, `creator_display_name` 152, `creator_kind` 152 (`User` 151, `ServicePrincipal` 1), `description` 152, `tile_endpoint_metadata` 85 (`tile_id`, `tile_model_name`, `problem_type`), `endpoint_type` 60, `capabilities` 56, `tags` 45, `ai_gateway` 17.

`config.served_entities[]` keys: `name`, `type` (`UC_MODEL` 66, `FOUNDATION_MODEL` 56, `EXTERNAL_MODEL` 6), `entity_name` (UC model FQN or `system.ai.*`), `entity_version`, `foundation_model{…}`, `external_model{provider,name,task}`. For KA/MAS endpoints the only entity is `{type: FOUNDATION_MODEL, foundation_model: {name: "ka-base-model-…"}}`, so there is **no `entity_name` to join on**. Join via `tile_endpoint_metadata.tile_id` instead.

**Trimmed example: custom agent endpoint (list item)**
```json
{
  "name": "agent_eval_demo_coordinator",
  "creator": "user01@example.com",
  "creation_timestamp": 1785095410000, "last_updated_timestamp": 1785207786000,
  "state": {"ready": "READY", "config_update": "NOT_UPDATING", "suspend": "NOT_SUSPENDED", "system_update_failure": false},
  "config": {"served_entities": [{"name": "payer_coordinator_agent-1",
     "entity_name": "ppareek.agent_eval_demo.payer_coordinator_agent", "entity_version": "1", "type": "UC_MODEL"}]},
  "tags": [{"key": "environment", "value": "dev"}, {"key": "MONITOR_EXPERIMENT_ID", "value": "2103506480290820"}],
  "id": "3b42e07b26d442f481225ba07ac05c9c", "route_optimized": false, "task": "agent/v1/responses",
  "permission_level": "CAN_MANAGE",
  "ai_gateway": {"usage_tracking_config": {"enabled": false},
     "inference_table_config": {"catalog_name": "ppareek", "schema_name": "agent_eval_demo",
                                "table_name_prefix": "payer_coordinator_agent", "enabled": true}},
  "creator_display_name": "Pulkit Pareek", "creator_kind": "User", "description": ""
}
```

**Trimmed example: Agent Bricks tile endpoint (detail)**
```json
{"name": "mas-0849ad0e-endpoint", "creator": "user02@example.com", "task": "agent/v1/responses",
 "config": {"served_entities": [{"type": "FOUNDATION_MODEL", "foundation_model": {"name": "mas-base-model-178f2777"},
            "state": {"deployment": "DEPLOYMENT_READY", "deployment_state_message": ""}}]},
 "id": "05c608a8e8b944c5b6282e6f282ef144", "resource_credential_strategy": "EMBEDDED_CREDENTIALS",
 "tile_endpoint_metadata": {"tile_id": "0849ad0e-fe02-4fdc-94f0-6569632d2d59",
   "tile_model_name": "mas-base-model-178f2777", "problem_type": "MULTI_AGENT_SUPERVISOR"}}
```

**Trimmed example: endpoint with AI Gateway guardrails (`member-services-chat`, `llm/v1/chat`, 3 external-model destinations)**
```json
"ai_gateway": {
  "usage_tracking_config": {"enabled": true},
  "inference_table_config": {"catalog_name": "ppareek", "schema_name": "agent_eval_demo",
                             "table_name_prefix": "member_services_chat", "enabled": true},
  "rate_limits": [{"calls": 60, "key": "endpoint", "renewal_period": "minute"}],
  "guardrails": {"input":  {"safety": true, "pii_detection": true, "pii": {"behavior": "MASK"}},
                 "output": {"safety": true, "pii_detection": true, "pii": {"behavior": "MASK"}}},
  "fallback_config": {"enabled": true}
}
```
Other guardrail shapes seen: `{"safety": false, "pii_detection": true, "pii": {"behavior": "MASK"}}` and `{"safety": true, "pii_detection": false, "pii": {"behavior": "NONE"}}`. `external_model` = `{"provider": "databricks-model-serving" | "openai", "name": "databricks-claude-sonnet-5", "task": "llm/v1/chat"}`.

**Detail GET** (`agents_main-drm_transformation-drm_agent`): the top-level keys add `resource_credential_strategy`. `config` = `served_entities`, `served_models`, `traffic_config`, `config_version`. Each served entity adds `workload_size`, `workload_type`, `scale_to_zero_enabled`, `environment_vars` (values redacted in the sample; may contain `{{secrets/…}}` references, so **never surface these**), `batching_config`, `state`, `creator`, `creation_timestamp`.

**ACL shape** (`GET /api/2.0/permissions/serving-endpoints/9a9ecf9effa149c8b38cdcb84485dc9f`):
```json
{"object_id": "/serving-endpoints/9a9ecf9effa149c8b38cdcb84485dc9f", "object_type": "serving-endpoint",
 "access_control_list": [
  {"user_name": "admin@example.com", "display_name": "Surya Sai Turaga",
   "all_permissions": [{"permission_level": "CAN_MANAGE", "inherited": false}]},
  {"group_name": "admins",
   "all_permissions": [{"permission_level": "CAN_MANAGE", "inherited": true, "inherited_from_object": ["/serving-endpoints"]}]}]}
```
ACL principals use one of `user_name` / `group_name` / `service_principal_name`.

---

## 3. Probe 2 — Agent Bricks (tiles, KA, MAS / Supervisor Agents)

**Samples:** `samples/02_agent_bricks_tiles.json`, `samples/02b_agent_bricks_mas_ka_aggregates.json`, `samples/02c_agent_bricks_v21_supervisor_ka.json`

### 3a. `GET /api/2.0/tiles` — 200 (the tile catalog)
Top-level `{"tiles": [...]}`, 93 tiles, one page at `page_size=100`. Counts by `tile_type`: `MAS` 41, `KA` 33, `KIE` 10, `AI_EXTRACT` 8, `T2T` 1.

Field presence: `tile_id` 93, `name` 93, `tile_type` 93, `mlflow_experiment_id` 93, `creation_timestamp_ms` 93, `last_updated_timestamp_ms` 93, `creator` 93, `creator_display_name` 93, `evaluation_run_exists` 93 (true on 4), `acl_enabled` 93 (all true), `serving_endpoint_name` 85, `description` 74, `instructions` 63, `task_spec` 19 (KIE / AI_EXTRACT), `tile_type_config` 1 (T2T).
```json
{"tile_id": "2e8a4ac6-17ca-492f-b00d-73df59a52526", "name": "brickwell-mfg-ai-supervisor", "tile_type": "MAS",
 "mlflow_experiment_id": "2347446610473193", "creation_timestamp_ms": 1792607680777, "last_updated_timestamp_ms": 1792607696589,
 "serving_endpoint_name": "mas-2e8a4ac6-endpoint", "creator": "user03@example.com",
 "creator_display_name": "Christopher Messer", "description": "Routes manufacturing questions to …",
 "evaluation_run_exists": false, "acl_enabled": true}
```

### 3b. v2.0 per-tile detail — 200 (there are no v2.0 lists)
- `GET /api/2.0/knowledge-assistants/{tile_id}` returns `knowledge_assistant.{tile{…same as above}, knowledge_sources[], status{endpoint_status}, id, name, description, instructions, creator, creation_timestamp, endpoint_name, experiment_id}`.
  `knowledge_sources[]` = `{files_source{name,type,description,files{path}} | index_source{…}, state, last_successful_update_timestamp_ms, latest_update_timestamp_ms, knowledge_source_id, indexed_row_count, file_source_index_info{summary{total_files,success_files,skipped_files,failed_files}, files_by_type, version, embedding_model, self_managed_embeddings, vector_count, …}, creation_timestamp_ms, ingestion_info{file_state_counts{…}}}`.
  Across all 33 KAs there are 25 `files_source` and 8 `index_source`. Every state is `KNOWLEDGE_SOURCE_STATE_UPDATED` and every `status.endpoint_status` is `ONLINE`.
- `GET /api/2.0/multi-agent-supervisors/{tile_id}` returns `multi_agent_supervisor.{tile{…}, agents[], status{endpoint_status, examples_storage_type}}`.
  `agents[]` = `{name, description, agent_type, <one typed ref>}`. Across all 41 MAS (103 sub-agents):

| `agent_type` | count | typed ref field |
|---|---|---|
| `genie-space` | 47 | `genie_space.id` |
| `knowledge-assistant` | 25 | `serving_endpoint.name` |
| `unity-catalog-function` | 23 | `unity_catalog_function.uc_path.{catalog,schema,name}` |
| `external-mcp-server` | 4 | `external_mcp_server.connection_name` |
| `web-search` | 3 | `web_search: {}` |
| `uc-table` | 1 | `uc_table.name` |

`status.endpoint_status`: `NOT_APPLICABLE` 23, `ONLINE` 18. `examples_storage_type` is `VOLUME_FILE` or `VECTOR_SEARCH`.

### 3c. v2.1 resource-style APIs — 200 (best shapes; both have list endpoints)
- `GET /api/2.1/supervisor-agents` returns `{"supervisor_agents": [...]}` (41). Fields: `name` (`supervisor-agents/{id}`), `display_name`, `description`, `supervisor_agent_id`, `creator`, `create_time` (RFC 3339), `endpoint_name`, `experiment_id`, `instructions` (23).
- `GET /api/2.1/supervisor-agents/{id}/tools` returns `{"tools": [{name, tool_type, tool_id, description, <typed ref>}]}`. The `tool_type` enum across all 41 supervisors:
  `genie_space` 47 (`genie_space.{id,space_id}`), `knowledge_assistant` 25 (`knowledge_assistant.{serving_endpoint_name,knowledge_assistant_id}`), `uc_function` 23 (`uc_function.name`), `uc_connection` 4 (`uc_connection.name`), `databricks_web_search` 3 (`web_search`), `uc_table` 1 (`uc_table.name`).
- `GET /api/2.1/supervisor-agents/{id}/examples` returns `{"examples": [{name, question, guidelines[], example_id}]}`.
- `GET /api/2.1/knowledge-assistants` returns `{"knowledge_assistants": [...]}` (33). Fields: `name`, `id`, `display_name`, `description`, `instructions`, `creator`, `create_time`, `endpoint_name`, `experiment_id`. The GET adds `state` (`ACTIVE`) and `knowledge_assistant_id`.
- `GET /api/2.1/knowledge-assistants/{id}/knowledge-sources` returns `{"knowledge_sources": [{name, display_name, description, source_type, files{path}, state ("UPDATED"), id, knowledge_cutoff_time, create_time}]}`.
```json
{"name": "supervisor-agents/2e8a4ac6-17ca-492f-b00d-73df59a52526/tools/document_expert",
 "tool_type": "knowledge_assistant",
 "knowledge_assistant": {"serving_endpoint_name": "ka-a176dc0c-endpoint",
                         "knowledge_assistant_id": "a176dc0c-1d6f-4f86-849a-a38eac9ca22c"},
 "description": "Unstructured manufacturing documents via Knowledge Assistant: …", "tool_id": "document_expert"}
```

### 3d. ai-dev-kit MCP tools (list/get only)
- `mcp__databricks__manage_ka(action="get", tile_id="0445f231-…")` fails with `'WorkspaceClient' object has no attribute 'knowledge_assistants'`.
- `mcp__databricks__manage_mas(action="get", tile_id="0849ad0e-…")` works and returns `{tile_id, name, description, endpoint_status: "ONLINE", agents: [{name, description, agent_type: "knowledge-assistant", serving_endpoint: {name}}, {…, agent_type: "genie-space", genie_space: {id}}], examples_count: 0, instructions: ""}`.
- **Neither tool has a `list` action** (the actions are `create_or_update`, `get`, `find_by_name`, `delete`). Don't use them for the collector.

---

## 4. Probe 3 — Genie spaces

**Sample:** `samples/03_genie_spaces.json`

`GET /api/2.0/genie/spaces?page_size=100` returns 200 with `{"spaces": [...], "next_page_token"}`. There are **230 spaces over 3 pages**.

Field presence: `space_id` 230, `title` 230, `warehouse_id` 230, `create_time` 230 (RFC 3339), `update_time` 230, `description` 156. **There is no creator, owner or parent_path in the list.**
```json
{"space_id": "01f1d0c52c5212a0a957f1117779ad81", "title": "NSCLC RWE — HEOR Cohort Explorer", "description": "…",
 "warehouse_id": "bda22e07d7130a32", "create_time": "2026-10-25T22:41:09.591Z", "update_time": "2026-10-25T23:14:50.897Z"}
```
- `GET /api/2.0/genie/spaces/{id}` adds `parent_path`. With `?include_serialized_space=true` it also adds `serialized_space` (a **JSON string**) and `etag`. The parsed shape is `{version, config{sample_questions[{id, question[]}]}, data_sources{tables[{identifier, column_configs[{column_name, description[]}]}]}, instructions{text_instructions[{id, content[]}], example_question_sqls[{id, question[], sql[]}], join_specs[{id, left{identifier,alias}, right{identifier,alias}, sql[]}]}}`. `data_sources.tables[].identifier` gives **space→table lineage**.
- ACL: `GET /api/2.0/permissions/genie/{space_id}` returns 200 with `{"object_id": "/genie/1635280482778914", "object_type": "genie", "access_control_list": [{user_name, display_name, all_permissions[{permission_level, inherited, inherited_from_object[]}]}]}`. **Owner = the ACL principal with `CAN_MANAGE`, or derive it from `parent_path`.**

---

## 5. Probe 4 — UC connections and MCP

**Samples:** `samples/04_uc_connections.json`, `samples/04b_mcp_tools_list.json`

### 5a. Connections
`GET /api/2.1/unity-catalog/connections?max_results=100` returns 200 with `{"connections": [...], "next_page_token"}`. There are **3,100 connections across 31 pages**, metastore-wide: `MANAGED_POSTGRESQL` 2,693, `HTTP` 144, `POSTGRESQL` 76, `SQLSERVER` 28, `GOOGLE_DRIVE` 20, `BIGQUERY` 18, …

Field presence: `name`, `connection_type`, `owner`, `read_only`, `full_name`, `url`, `credential_type`, `connection_id`, `metastore_id`, `created_at`, `created_by`, `updated_at`, `updated_by`, `securable_type` (`CONNECTION`), `securable_kind`, `etag` (all 3,100); `comment` 2,849; `provisioning_info{state}` 407 (`ACTIVE` 402, `FAILED` 5); `options` 399; `environment_settings` 8; `properties` 2 (`purpose`).

The **MCP flag is `options.is_mcp_connection`**, a **string**. Among the 144 HTTP connections, `"true"` appears on 95 (one also has `options.mcp_resource`), `"false"` on 6, and the flag is absent on 43 (some of those are MCP servers anyway, e.g. `acx_workbook_mcp`).
- HTTP `securable_kind`: `CONNECTION_HTTP_BEARER` 87, `CONNECTION_HTTP_OAUTH_M2M` 34, `CONNECTION_HTTP_OAUTH_U2M_MAPPING` 22, `CONNECTION_HTTP_OAUTH_U2M` 1.
- The 95 MCP connections by host: third-party SaaS 72 (Tavily, You.com, Airtable, Asana, Atlassian, GitHub Copilot, DeepWiki…), Databricks Apps (`*.databricksapps.com`) 21, other Databricks workspaces' `/api/2.0/mcp/...` 2.
- `options` keys seen: `host`, `port`, `base_path`, `is_mcp_connection`, `mcp_resource`, `auth_scheme`, `oauth_scope`, `client_id`, `token_endpoint`, `authorization_endpoint`, `access_token_expiration`, `refresh_token_expiration`, … **No secret values are returned** (no `bearer_token`/`client_secret`).

Three trimmed MCP examples (name / type / owner / comment / created_by):
```json
{"name": "aa_sil_np_mcp", "connection_type": "HTTP", "credential_type": "OAUTH_M2M", "securable_kind": "CONNECTION_HTTP_OAUTH_M2M",
 "options": {"host": "https://aa-sil-np-mcp-7474644717717567.aws.databricksapps.com", "port": "443", "base_path": "/mcp", "is_mcp_connection": "true", "oauth_scope": "all-apis"},
 "owner": "user04@example.com", "created_by": "user04@example.com",
 "comment": "aa-sil-np custom MCP server (Databricks App) governed via Unity AI Gateway",
 "url": "https://aa-sil-np-mcp-7474644717717567.aws.databricksapps.com:443/mcp", "provisioning_info": {"state": "ACTIVE"}}
{"name": "agentkit_deepwiki", "credential_type": "BEARER_TOKEN", "options": {"host": "https://mcp.deepwiki.com", "base_path": "/mcp", "is_mcp_connection": "true"},
 "owner": "user05@example.com", "created_by": "user05@example.com", "comment": null}
{"name": "ah_demo_confluence_mcp", "credential_type": "OAUTH_U2M_MAPPING", "options": {"host": "https://mcp.atlassian.com", "base_path": "/v1/mcp/authv2", "is_mcp_connection": "true"},
 "owner": "user06@example.com", "created_by": "user06@example.com", "comment": "Confluence external MCP (OBO) for AH GenAI Gateway demo"}
```

### 5b. `tools/list` through the Databricks MCP proxy (JSON-RPC, read-only)
Body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, header `Accept: application/json, text/event-stream`. The response is plain JSON: `{"jsonrpc":"2.0","id":1,"result":{"tools":[…]}}`.

| Server | Path | HTTP | Tools | Tool keys | `annotations` keys |
|---|---|---|---|---|---|
| Managed — UC functions `system.ai` | `POST /api/2.0/mcp/functions/system/ai` | 200 | 16 (`system__ai__ai_classify`, …, `system__ai__python_exec`) | `name, description, inputSchema, outputSchema, annotations` | `catalog, schema, routine_body, language, openWorldHint, destructiveHint` |
| Managed — UC schema | `POST /api/2.0/mcp/functions/main/supply_agentic_demo` | 200 | 3 | same | same |
| Managed — Genie | `POST /api/2.0/mcp/genie/{space_id}` | 200 | 2 (`query_space_{id}`, `poll_response_{id}`) | same | `readOnlyHint` |
| External (no grant) | `POST /api/2.0/mcp/external/agentkit_deepwiki` | **403** | — | `PERMISSION_DENIED: … User is missing USE CONNECTION on agentkit_deepwiki` | |
| External (granted) | `POST /api/2.0/mcp/external/ext_mcp_you_dot_com` | 200 | 1 (`you-finance`) | `name, title, description, inputSchema, outputSchema, annotations` | `readOnlyHint, destructiveHint, openWorldHint` |

UC-function tools are named `{catalog}__{schema}__{function}`. Note that **`destructiveHint: true` is set on every UC function tool, including read-only SQL TVFs**. Don't use it as a risk signal.
```json
{"name": "main__supply_agentic_demo__ebom_mbom_gaps",
 "description": "Parts present in the Engineering BOM but missing from the Manufacturing BOM …",
 "inputSchema": {"type": "object", "required": [], "properties": {}},
 "outputSchema": {"type": "object", "required": ["is_truncated"], "properties": {"is_truncated": {"type": "boolean"},
   "columns": {"type": "array", "items": {"type": "string"}}, "rows": {"type": "array", "items": {"type": "array", "items": {}}}}},
 "annotations": {"catalog": "main", "routine_body": "SQL", "schema": "supply_agentic_demo", "language": "SQL",
                 "openWorldHint": true, "destructiveHint": true}}
{"name": "query_space_01f1d0c52c5212a0a957f1117779ad81", "description": "Query the NSCLC RWE — HEOR Cohort Explorer genie space …",
 "inputSchema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}, "conversation_id": {"type": "string"}}},
 "outputSchema": {"…": "content{queryAttachments[], textAttachments[], suggestedQuestions[]}, conversationId, messageId, status"},
 "annotations": {"readOnlyHint": true}}
```
`initialize` on `/api/2.0/mcp/functions/system/ai` returns `{"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "DatabricksMCPServer", "version": "0.1.0"}, "instructions": "Execute user defined functions that are defined in Unity Catalog system and Schema ai"}`.

**System MCP servers not covered by any list API.** `system.ai_gateway.usage.service_name` also shows managed **system** MCP servers that are *not* UC connections and have no list API (§1): `system.ai.genie_one_mcp`, `system.ai.google_drive`, `system.ai.microsoft_365`, `system.ai.atlassian`, `system.ai.google_calendar`, `system.ai.gmail`, `system.ai.slack`, `system.ai.github`, `system.ai.web_search`. External MCP traffic also appears under 3-part names (`tony_farias.slurm_hpc.slurm_ops`, `main.lilly_heor_rwe_demo.nsclc_mcp`) that resolve to neither a function, a table, a connection nor an `agent-services` object (404 on each).

---

## 6. Probe 5 — UC functions as tools

**Sample:** `samples/05_uc_functions.json`

`GET /api/2.1/unity-catalog/functions?catalog_name=main&schema_name=supply_agentic_demo` returns 200 with `{"functions": [...]}`: 3 functions, all `routine_body: SQL`, `data_type: TABLE_TYPE`, `security_type: DEFINER`, `sql_data_access: READS_SQL_DATA`, `is_deterministic: true`, owner `admin@example.com`.

List fields: `name, catalog_name, schema_name, full_name, data_type, full_data_type, routine_body, routine_definition, parameter_style, is_deterministic, sql_data_access, security_type, specific_name, owner, comment, properties, metastore_id, created_at, created_by, updated_at, updated_by, function_id, securable_type, securable_kind, cache_version_info, etag`. **`input_params`/`return_params` are absent from the list.** `GET /api/2.1/unity-catalog/functions/{full_name}` adds `return_params` (and `input_params` when the function has any).
- `GET /api/2.1/unity-catalog/permissions/function/{fn}` returns 200 `{}` (no direct grants; everything is inherited).
- `GET /api/2.1/unity-catalog/effective-permissions/function/{fn}` returns 200:
```json
{"privilege_assignments": [
  {"principal": "account users", "privileges": [
     {"privilege": "ALL_PRIVILEGES", "inherited_from_type": "CATALOG", "inherited_from_name": "main"},
     {"privilege": "MANAGE", "inherited_from_type": "CATALOG", "inherited_from_name": "main"},
     {"privilege": "READ_METADATA", "inherited_from_type": "METASTORE", "inherited_from_name": "metastore_aws_us_east_1"}]}]}
```
- `system.ai` has 16 functions (`ai_analyze_sentiment`, `ai_classify`, `ai_decide`, `ai_enrich`, `ai_extract`, `ai_fix_grammar`, `ai_gen`, `ai_mask`, `ai_parse_document`, `ai_prep_search`, `ai_search`, `ai_similarity`, `ai_summarize`, `ai_transcribe`, `ai_translate`, `python_exec`). This matches the MCP `tools/list` above.
- For metastore-wide discovery, `system.information_schema.routines` (non-`system`) returned **409 functions in 94 schemas** in a single query. The REST list requires catalog **and** schema.

---

## 7. Probe 6 — UC registered models (agents logged to UC)

**Sample:** `samples/06_uc_registered_models.json`

`GET /api/2.1/unity-catalog/models?max_results=20` returns 200 with `{"registered_models": [...], "next_page_token"}`. It returned **only 9 rows** plus a token (UC pages are sparse). Continuing at `max_results=100`, there were 141 models after 15 pages and the listing was still not complete. Field presence: `name, catalog_name, schema_name, full_name, owner, storage_location, metastore_id, created_at, created_by, updated_at, updated_by, securable_type, securable_kind, id, etag`. **`aliases` never appeared**, even with `include_aliases=true` (no aliases are set on the sampled models).
- `GET /api/2.1/unity-catalog/models/main.drm_transformation.drm_agent?include_aliases=true` returns 200, `securable_type: "FUNCTION"`, `securable_kind: "FUNCTION_REGISTERED_MODEL"`.
- `GET …/models/{fn}/versions?max_results=5` returns `{"model_versions": [...], "next_page_token"}`. Version keys: `model_name, catalog_name, schema_name, source ("models:/m-10b4…"), run_id, run_workspace_id, status ("READY"), version, storage_location, metastore_id, created_at, created_by, updated_at, updated_by, id, etag, model_id ("m-…", the MLflow LoggedModel)`.
- `GET …/versions/{v}` adds **`model_version_dependencies`**: `{"dependencies": [{"table": {"table_full_name": "main.drm_transformation.docs_chunks_idx"}}]}`. This is the **agent→resource lineage edge** (it can also hold `function`, `serving_endpoint`, `vector_search_index`, `connection` per the MLflow resources spec; only `table` was observed here).
- Join: serving endpoint `config.served_entities[].entity_name` = UC model `full_name`, and `entity_version` = version. `model_id` joins to MLflow logged models and to `trace_metadata["mlflow.modelId"]`.

---

## 8. Probe 7 — Access requests (RFA)

**Sample:** `samples/07_access_requests_rfa.json`

| Path | HTTP |
|---|---|
| `GET /api/3.0/rfa/destinations/function/main.supply_agentic_demo.ebom_mbom_gaps` | **200** |
| `GET /api/3.0/rfa/destinations/FUNCTION/…` (upper case) | **200** |
| `GET /api/3.0/rfa/destinations/catalog/main` | **200** |
| `GET /api/3.0/rfa/destinations/connection/ext_mcp_you_dot_com` | **200** |
| `GET /api/3.0/rfa/destinations/table/main.drm_transformation.docs_chunks_idx` | **200** |
| `GET /api/3.0/rfa/destinations?securable_type=catalog&full_name=…` | 404 `ENDPOINT_NOT_FOUND` |
| `GET /api/3.0/rfa/destinations:batchGet` / `/destinations/batch` | 404 `ENDPOINT_NOT_FOUND` |
| `GET /api/3.0/rfa/requests` | 404 `ENDPOINT_NOT_FOUND` |
```json
{"destinations": [{"destination_id": "admin@example.com", "destination_type": "EMAIL",
                   "special_destination": "SPECIAL_DESTINATION_FUNCTION_OWNER"}],
 "securable": {"type": "FUNCTION", "full_name": "main.supply_agentic_demo.ebom_mbom_gaps"},
 "are_any_destinations_hidden": false, "destination_source_securable": {"type": "FUNCTION"},
 "securable_type": "FUNCTION", "full_name": "main.supply_agentic_demo.ebom_mbom_gaps"}
```
`special_destination` values seen: `SPECIAL_DESTINATION_{FUNCTION,CATALOG,CONNECTION,TABLE}_OWNER`. No batch or list-of-requests GET exists (a batch POST was not attempted because it is out of read-only scope).

---

## 9. Probe 8 — Apps (100-app cap)

**Sample:** `samples/08_apps.json`

`GET /api/2.0/apps` returns 200 with `{"apps": [...]}`, **100 apps and no `next_page_token`**. Paginating at `page_size=30` gives 4 pages and 100 unique names. **The workspace is at the 100-app limit.** `GET /api/2.0/apps/agent-registry-hub` returns **404** ("App with name agent-registry-hub does not exist or is deleted."), so the name is free. No similarly named app exists. The current user created 26 of the 100.

`compute_status.state`: `ACTIVE` 77, `STOPPED` 19, `ERROR` 4. Field presence: `name, description, compute_status{state,message}, url, create_time, creator, update_time, updater, service_principal_id, service_principal_name, service_principal_client_id, id, oauth2_app_integration_id, oauth2_app_client_id, compute_size, thumbnail_url, effective_platform_version` (100); `default_source_code_path` 97; `active_deployment` 76; `last_deployment_id` 68; `resources` 56; `effective_budget_policy_id`/`effective_usage_policy_id` 3; `git_repository`/`default_git_source`/`compute_min_instances`/`compute_max_instances`/`space`/`space_id` 1. **`app_status` is not returned by the list.**

Resource kinds across apps: `sql_warehouse` 45, `serving_endpoint` 25, `secret` 17, `uc_securable` 15, `job` 15, `postgres` 12, `database` 11, `genie_space` 10, `experiment` 7, `app` 1. These are app→resource lineage edges.
```json
{"name": "340b-fraud-investigator", "url": "https://340b-fraud-investigator-1234567890123456.aws.databricksapps.com",
 "compute_status": {"state": "ACTIVE", "message": "App compute is running."}, "compute_size": "MEDIUM",
 "creator": "user02@example.com", "create_time": "2026-06-24T16:31:08Z",
 "service_principal_client_id": "cb8abf0d-f894-47b0-8dc1-4ad7454c9a50", "service_principal_name": "app-46a7gs 340b-fraud-investigator",
 "resources": [{"name": "lakebase-db", "postgres": {"branch": "projects/fraud-case-mgmt/branches/production",
                "database": "projects/fraud-case-mgmt/branches/production/databases/db-vl5f-kofkzy9fim", "permission": "CAN_CONNECT_AND_CREATE"}}],
 "active_deployment": {"deployment_id": "01f17099…", "mode": "SNAPSHOT", "status": {"state": "SUCCEEDED"}}}
```
App ACL (`GET /api/2.0/permissions/apps/{name}`): `{"object_id": "/apps/{id}", "object_type": "apps", "access_control_list": [{"group_name": "users", "all_permissions": [{"permission_level": "CAN_USE", "inherited": false}]}, …]}`.

---

## 10. Probe 9 — Lakebase

**Sample:** `samples/09_lakebase.json`

- `databricks postgres list-projects --profile DEFAULT -o json` exits 0 with **54 autoscale projects**. Project keys: `name` (`projects/{id}`), `project_id`, `uid`, `create_time`, `update_time`, `status{display_name, owner, pg_version (17×41, 16×10, 18×3), compute_last_active_time, default_endpoint_settings{autoscaling_limit_min_cu, autoscaling_limit_max_cu, suspend_timeout_duration}, enable_pg_native_login, history_retention_duration, budget_policy_id(2)}`. **A project has no `state`.**
- State lives on branches and endpoints: `GET /api/2.0/postgres/projects/{id}/branches` gives `status.current_state: READY`, and `GET /api/2.0/postgres/{branch}/endpoints` gives `status.current_state: ACTIVE`, `endpoint_type: ENDPOINT_TYPE_READ_WRITE`, `hosts.{host, read_write_pooled_host}`.
- Owners: `admin@example.com` owns **17** (e.g. `finance-selfserve`, `surya-office-fleet`, `ontobricks-registry`, `cdp`, `care-digital-twin`, `ce-portal-lakebase`, `test`, …), `pulkit.pareek` 5, `christopher.messer` 3, `jeff.shmain` 3, others ≤ 2 each. The full name list is in the sample.
- **Can we create a new autoscale project?** There is no quota API (`/api/2.0/postgres/quotas` and `/projects:quota` both return 404), so this can't be proven read-only. With 54 projects there is no sign of a hard cap, but that's unverified. Recommendation: try `create-project agent-registry-hub` at deploy time. If it fails with a quota error, fall back to a new **database** on an existing user-owned project (e.g. `surya-office-fleet` or `ontobricks-registry`).
- `databricks database list-database-instances` exits 0 with **10 provisioned instances**, all `AVAILABLE` (`CU_1` ×7, `CU_2` ×3).

---

## 11. Probe 10 — System tables

**Samples:** `samples/10a_system_tables_describe.json` (all columns and full types), `samples/10b_system_tables_samples.json` (≤ 5 rows each, emails masked, no IP/UA/URL), `samples/10c_system_tables_aggregates.json`

### 11a. `SHOW SCHEMAS IN system` (22)
`__internal_logging, access, ai, ai_gateway, alert, billing, compute, data_classification, data_quality_monitoring, information_schema, lakebase, lakeflow, lakewatch, mlflow, query, replication, security_gated, serving, sharing, storage, tags, telemetry`

`SHOW TABLES` results:
- `system.ai_gateway`: `external_model_spend, usage`
- `system.serving`: `endpoint_usage, served_entities`
- `system.billing`: `account_prices, attributed_usage, cloud_infra_cost, list_prices, usage`
- `system.access`: `assistant_events, audit, clean_room_events, column_lineage, inbound_network, outbound_network, table_lineage, workspaces_latest`
- `system.mlflow`: `experiments_latest, run_metrics_history, runs_latest` (**no traces table**)
- `system.telemetry`: `otel_logs, otel_metrics, otel_spans` (0 rows in 30 d)
- `system.ai`: *(no tables)*
- `system.lakebase`: `active_session_history, compute_counters, compute_gauges, database_counters, database_gauges, ddl_history, pg_stat_statements_counters, plan_history, postgres_logs, wait_event_counters`
- `system.tags`: `governed_tags`. `system.query`: `history`. `system.information_schema` has no skill/MCP views.

### 11b. Notable sample-row facts
- `system.ai_gateway.usage` in this workspace holds only **AI Gateway v2 traffic**: FMAPI `system.ai.*` endpoints (`service_type = MODEL_SERVICE`) and **MCP** (`service_type = MCP_SERVICE`, where `endpoint_name`/`endpoint_id` are NULL and the server sits in `service_name`/`service_id`). Classic serving endpoints and Agent Bricks agents do not appear here. One masked FM row:
  `endpoint_name: system.ai.gpt-5-5`, `endpoint_tags: {"ai.model_creator":"openai","budget":"mbk-fmapi"}`, `destination_type: PAY_PER_TOKEN_FOUNDATION_MODEL`, `destination_name: system.ai.databricks-gpt-5-5`, `requester_type: SERVICE_PRINCIPAL`, `api_type: mlflow/v1/chat/completions`, `input_tokens 6123 / output_tokens 683`, `token_details.cache_read_input_tokens 4736`, `latency_ms 8737`, `time_to_first_byte_ms 4002`, `routing_information.attempts[]`.
  One MCP row: `service_type: MCP_SERVICE`, `service_name: system.ai.genie_one_mcp`, `mcp_metadata: {"tool_name":"genie_poll_response","server_type":"SYSTEM","json_rpc_method":"tools/call"}`, `invocation_metadata.source: EXTERNAL_CLIENT`, `requester_type: USER`.
- The `system.ai_gateway.usage` workspace mix is account-wide. The 30-day top workspaces are other workspaces (2.36 M, 1.21 M, … rows), so **always filter `workspace_id`**.
- `system.ai_gateway.external_model_spend` has **0 rows** for this workspace (both all-time sample and 30 d).
- `system.serving.endpoint_usage` holds per-request rows (`requester`, `status_code`, `request_time`, token and character counts, `usage_context` map, `request_streaming`, `served_entity_id`). It joins to `system.serving.served_entities` on `served_entity_id`, which gives `endpoint_name`/`task`/`entity_type`. In the last 30 days the join shows FMAPI chat 11,780 requests (24 endpoints), embeddings 12,106 (2), responses 33 (1), and **CUSTOM_MODEL 13 (1 endpoint)**. Custom and agent endpoints are almost invisible because only 6 endpoints have usage tracking enabled.
- `system.serving.served_entities` (current, `endpoint_delete_time IS NULL`): `CUSTOM_MODEL`/"" 118 rows (55 endpoints), `CUSTOM_MODEL`/`agent/v1/chat` 57 (10), `FOUNDATION_MODEL`/`llm/v1/chat` 46, `CUSTOM_MODEL`/`agent/v1/responses` 19 (6), `EXTERNAL_MODEL` 6, … Agent Bricks KA/MAS endpoints do not appear as custom models.

### 11c. DESCRIBE — all columns and types
#### `system.ai_gateway.usage` — 40 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `workspace_id` | `string` |
| 3 | `request_id` | `string` |
| 4 | `schema_version` | `int` |
| 5 | `endpoint_id` | `string` |
| 6 | `endpoint_name` | `string` |
| 7 | `endpoint_tags` | `map<string,string>` |
| 8 | `endpoint_metadata` | `struct<creator:string,creation_time:timestamp,last_updated_time:timestamp,destinations:array<struct<name:string,traffic_percent:double,type:string>>,inference_table:string,fallbacks:array<struct<name:string,traffic_percent:double,type:string>>>` |
| 9 | `event_time` | `timestamp` |
| 10 | `latency_ms` | `bigint` |
| 11 | `time_to_first_byte_ms` | `bigint` |
| 12 | `destination_type` | `string` |
| 13 | `destination_name` | `string` |
| 14 | `destination_id` | `string` |
| 15 | `destination_model` | `string` |
| 16 | `requester` | `string` |
| 17 | `requester_type` | `string` |
| 18 | `ip_address` | `string` |
| 19 | `url` | `string` |
| 20 | `user_agent` | `string` |
| 21 | `api_type` | `string` |
| 22 | `request_tags` | `map<string,string>` |
| 23 | `input_tokens` | `bigint` |
| 24 | `output_tokens` | `bigint` |
| 25 | `total_tokens` | `bigint` |
| 26 | `token_details` | `struct<cache_read_input_tokens:bigint,cache_creation_input_tokens:bigint,output_reasoning_tokens:bigint,cache_creation_5m_input_tokens:bigint,cache_creation_1h_input_tokens:bigint,file_search_count:bigint,num_web_search_queries:bigint>` |
| 27 | `response_content_type` | `string` |
| 28 | `status_code` | `int` |
| 29 | `routing_information` | `struct<attempts:array<struct<priority:string,action:string,destination:string,destination_id:string,status_code:int,error_code:string,latency_ms:bigint,start_time:timestamp,end_time:timestamp>>>` |
| 30 | `invocation_id` | `string` |
| 31 | `invocation_metadata` | `struct<source:string,service_tier:string,relayed:boolean>` |
| 32 | `service_type` | `string` |
| 33 | `service_id` | `string` |
| 34 | `service_name` | `string` |
| 35 | `service_tags` | `map<string,string>` |
| 36 | `mcp_metadata` | `struct<tool_name:string,server_type:string,client_name:string,json_rpc_method:string>` |
| 37 | `session_metadata` | `struct<client_session_id:string,client_subagent_id:string,coding_agent:string,agent_version:string,surface:string,reasoning_effort:string,smart_router_name:string>` |
| 38 | `auth_mode` | `string` |
| 39 | `model_metadata` | `struct<config:struct<created_by:string,create_time:timestamp,update_time:timestamp,inference_table:string,routing:struct<destinations:array<struct<name:string,traffic_percent:double,type:string>>,fallbacks:array<struct<name:string,traffic_percent:double,type:string>>>,rate_limits:array<struct<principal_type:string,principal:string,principal_id:string,limit:int,unit:string,interval:string>>,service_policies:array<struct<label:string,phases:array<string>,type:string,handler:string,rank:int>>>,destination_type:string,destination_name:string,destination_model:string,destination_metadata:struct<provider_model:string,provider:string,model_serving_endpoint:string,model_serving_endpoint_id:string,workspace_id:string,model_units:int,model_version:int,model_provider_service:string>,api_type:string,routing_information:struct<attempts:array<struct<priority:string,action:string,destination_name:string,status_code:int,error_code:string,latency_ms:bigint,start_time:timestamp,end_time:timestamp,outcome:string>>>,gateway_feature_results:struct<rate_limit_result:struct<principal_type:string,principal:string,principal_id:string,limit:int,unit:string,interval:string,request_tag_key:string,request_tag_value:string>,service_policies:array<struct<name:string,phase:string,decision:string,reason:string,error_reason:string>>>>` |
| 40 | `model_provider_metadata` | `struct<provider_model:string,provider:string,api_type:string,gateway_feature_results:struct<rate_limit_result:struct<principal_type:string,principal:string,principal_id:string,limit:int,unit:string,interval:string,request_tag_key:string,request_tag_value:string>,service_policies:array<struct<name:string,phase:string,decision:string,reason:string,error_reason:string>>>,config:struct<created_by:string,create_time:timestamp,update_time:timestamp,rate_limits:array<struct<principal_type:string,principal:string,principal_id:string,limit:int,unit:string,interval:string>>,service_policies:array<struct<label:string,phases:array<string>,type:string,handler:string,rank:int>>,inference_table:string>>` |

#### `system.ai_gateway.external_model_spend` — 13 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `record_id` | `string` |
| 2 | `account_id` | `string` |
| 3 | `workspace_id` | `string` |
| 4 | `usage_date` | `date` |
| 5 | `usage_start_time` | `timestamp` |
| 6 | `usage_end_time` | `timestamp` |
| 7 | `ingestion_date` | `date` |
| 8 | `usage_metadata` | `struct<provider:string,model:string,endpoint_id:string,endpoint_name:string,destination_id:string,destination_name:string>` |
| 9 | `custom_tags` | `struct<endpoint_tags:map<string,string>,request_tags:map<string,string>>` |
| 10 | `usage_unit` | `string` |
| 11 | `usage_quantity` | `decimal(38,18)` |
| 12 | `pricing_metadata` | `struct<service_tier:string,long_context:boolean>` |
| 13 | `identity_metadata` | `struct<run_by:string,run_as:string>` |

#### `system.serving.endpoint_usage` — 14 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `workspace_id` | `string` |
| 2 | `account_id` | `string` |
| 3 | `client_request_id` | `string` |
| 4 | `databricks_request_id` | `string` |
| 5 | `requester` | `string` |
| 6 | `status_code` | `int` |
| 7 | `request_time` | `timestamp` |
| 8 | `input_token_count` | `bigint` |
| 9 | `output_token_count` | `bigint` |
| 10 | `input_character_count` | `bigint` |
| 11 | `output_character_count` | `bigint` |
| 12 | `usage_context` | `map<string,string>` |
| 13 | `request_streaming` | `boolean` |
| 14 | `served_entity_id` | `string` |

#### `system.serving.served_entities` — 18 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `served_entity_id` | `string` |
| 2 | `account_id` | `string` |
| 3 | `workspace_id` | `string` |
| 4 | `created_by` | `string` |
| 5 | `endpoint_name` | `string` |
| 6 | `endpoint_id` | `string` |
| 7 | `served_entity_name` | `string` |
| 8 | `entity_type` | `string` |
| 9 | `entity_name` | `string` |
| 10 | `entity_version` | `string` |
| 11 | `endpoint_config_version` | `int` |
| 12 | `task` | `string` |
| 13 | `external_model_config` | `struct<provider:string>` |
| 14 | `foundation_model_config` | `struct<min_provisioned_throughput:bigint,max_provisioned_throughput:bigint>` |
| 15 | `custom_model_config` | `struct<min_concurrency:int,max_concurrency:int,compute_type:string>` |
| 16 | `feature_spec_config` | `struct<min_concurrency:int,max_concurrency:int,compute_type:string>` |
| 17 | `change_time` | `timestamp` |
| 18 | `endpoint_delete_time` | `timestamp` |

#### `system.billing.usage` — 18 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `workspace_id` | `string` |
| 3 | `record_id` | `string` |
| 4 | `sku_name` | `string` |
| 5 | `cloud` | `string` |
| 6 | `usage_start_time` | `timestamp` |
| 7 | `usage_end_time` | `timestamp` |
| 8 | `usage_date` | `date` |
| 9 | `custom_tags` | `map<string,string>` |
| 10 | `usage_unit` | `string` |
| 11 | `usage_quantity` | `decimal(38,18)` |
| 12 | `usage_metadata` | `struct<cluster_id:string,job_id:string,warehouse_id:string,instance_pool_id:string,node_type:string,job_run_id:string,notebook_id:string,dlt_pipeline_id:string,endpoint_name:string,endpoint_id:string,dlt_update_id:string,dlt_maintenance_id:string,run_name:string,job_name:string,notebook_path:string,central_clean_room_id:string,source_region:string,destination_region:string,app_id:string,app_name:string,metastore_id:string,private_endpoint_name:string,storage_api_type:string,budget_policy_id:string,ai_runtime_pool_id:string,ai_runtime_workload_id:string,uc_table_catalog:string,uc_table_schema:string,uc_table_name:string,database_instance_id:string,sharing_materialization_id:string,schema_id:string,usage_policy_id:string,base_environment_id:string,agent_bricks_id:string,index_id:string,catalog_id:string,project_id:string,branch_id:string,table_id:string,supervisor_agent_id:string,networking_client:string,associated_product:string,recipient_id:string,interactive_source:string,snapshot_id:string,ai_gateway:struct<endpoint_name:string,endpoint_id:string,destination_id:string,destination_model:string>,genie:struct<surface:string,channel:string,agent_id:string>,data_source:string,operation:string,serverless_compute_id:string,entity_full_name:string,failover_group_name:string,private_network_gateway_id:string,monitor_type:string>` |
| 13 | `identity_metadata` | `struct<run_as:string,created_by:string,owned_by:string,run_by:string>` |
| 14 | `record_type` | `string` |
| 15 | `ingestion_date` | `date` |
| 16 | `billing_origin_product` | `string` |
| 17 | `product_features` | `struct<jobs_tier:string,sql_tier:string,dlt_tier:string,is_serverless:boolean,is_photon:boolean,serving_type:string,networking:struct<connectivity_type:string,connection_method:string>,ai_runtime:struct<compute_type:string>,model_serving:struct<offering_type:string,reservation_term:string>,ai_gateway:struct<feature_type:string>,serverless_gpu:struct<workload_type:string>,agent_bricks:struct<problem_type:string,workload_type:string>,performance_target:string,ai_functions:struct<ai_function:string>,apps:struct<compute_size:string>,lakeflow_connect:struct<task_type:string,zerobus_request_type:string>,lakebase:struct<storage_type:string,compute_type:string>,ai_bi_genie:struct<capability_type:string,offering_type:string>,genie:struct<offering_type:string>>` |
| 18 | `usage_type` | `string` |

#### `system.billing.list_prices` — 8 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `price_start_time` | `timestamp` |
| 3 | `price_end_time` | `timestamp` |
| 4 | `sku_name` | `string` |
| 5 | `cloud` | `string` |
| 6 | `currency_code` | `string` |
| 7 | `usage_unit` | `string` |
| 8 | `pricing` | `struct<default:decimal(38,18),promotional:struct<default:decimal(38,18)>,effective_list:struct<default:decimal(38,18)>>` |

#### `system.billing.attributed_usage` — 16 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `record_id` | `string` |
| 2 | `usage_metadata` | `struct<dbsql_statement_id:string,warehouse_id:string,client_application:string>` |
| 3 | `identity_metadata` | `struct<executed_by:string>` |
| 4 | `start_time` | `timestamp` |
| 5 | `end_time` | `timestamp` |
| 6 | `usage_date` | `date` |
| 7 | `usage_unit` | `string` |
| 8 | `active_usage_quantity` | `decimal(38,18)` |
| 9 | `granular_tags` | `struct<query_tags:map<string,string>>` |
| 10 | `usage_record_ids` | `array<string>` |
| 11 | `account_id` | `string` |
| 12 | `workspace_id` | `string` |
| 13 | `sku_name` | `string` |
| 14 | `cloud` | `string` |
| 15 | `billing_origin_product` | `string` |
| 16 | `custom_tags` | `map<string,string>` |

#### `system.access.audit` — 17 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `workspace_id` | `string` |
| 3 | `version` | `string` |
| 4 | `event_time` | `timestamp` |
| 5 | `event_date` | `date` |
| 6 | `source_ip_address` | `string` |
| 7 | `user_agent` | `string` |
| 8 | `session_id` | `string` |
| 9 | `user_identity` | `struct<email:string,subject_name:string>` |
| 10 | `service_name` | `string` |
| 11 | `action_name` | `string` |
| 12 | `request_id` | `string` |
| 13 | `request_params` | `map<string,string>` |
| 14 | `response` | `struct<status_code:int,error_message:string,result:string>` |
| 15 | `audit_level` | `string` |
| 16 | `event_id` | `string` |
| 17 | `identity_metadata` | `struct<run_by:string,run_as:string,acting_resource:string,run_by_display_name:string,run_as_display_name:string,acting_resource_display_name:string,acting_resource_type:string>` |

#### `system.access.table_lineage` — 26 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `metastore_id` | `string` |
| 3 | `workspace_id` | `string` |
| 4 | `entity_type` | `string` |
| 5 | `entity_id` | `string` |
| 6 | `entity_run_id` | `string` |
| 7 | `source_table_full_name` | `string` |
| 8 | `source_table_catalog` | `string` |
| 9 | `source_table_schema` | `string` |
| 10 | `source_table_name` | `string` |
| 11 | `source_path` | `string` |
| 12 | `source_type` | `string` |
| 13 | `target_table_full_name` | `string` |
| 14 | `target_table_catalog` | `string` |
| 15 | `target_table_schema` | `string` |
| 16 | `target_table_name` | `string` |
| 17 | `target_path` | `string` |
| 18 | `target_type` | `string` |
| 19 | `created_by` | `string` |
| 20 | `event_time` | `timestamp` |
| 21 | `event_date` | `date` |
| 22 | `record_id` | `string` |
| 23 | `event_id` | `string` |
| 24 | `statement_id` | `string` |
| 25 | `entity_metadata` | `struct<job_info:struct<job_id:string,job_run_id:string>,dashboard_id:string,legacy_dashboard_id:string,notebook_id:string,sql_query_id:string,dlt_pipeline_info:struct<dlt_pipeline_id:string,dlt_update_id:string>,genie_space_id:string,alert_id:string>` |
| 26 | `direct_access` | `boolean` |

#### `system.access.column_lineage` — 28 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `metastore_id` | `string` |
| 3 | `workspace_id` | `string` |
| 4 | `entity_type` | `string` |
| 5 | `entity_id` | `string` |
| 6 | `entity_run_id` | `string` |
| 7 | `source_table_full_name` | `string` |
| 8 | `source_table_catalog` | `string` |
| 9 | `source_table_schema` | `string` |
| 10 | `source_table_name` | `string` |
| 11 | `source_path` | `string` |
| 12 | `source_type` | `string` |
| 13 | `source_column_name` | `string` |
| 14 | `target_table_full_name` | `string` |
| 15 | `target_table_catalog` | `string` |
| 16 | `target_table_schema` | `string` |
| 17 | `target_table_name` | `string` |
| 18 | `target_path` | `string` |
| 19 | `target_type` | `string` |
| 20 | `target_column_name` | `string` |
| 21 | `created_by` | `string` |
| 22 | `event_time` | `timestamp` |
| 23 | `event_date` | `date` |
| 24 | `record_id` | `string` |
| 25 | `event_id` | `string` |
| 26 | `statement_id` | `string` |
| 27 | `entity_metadata` | `struct<job_info:struct<job_id:string,job_run_id:string>,dashboard_id:string,legacy_dashboard_id:string,notebook_id:string,sql_query_id:string,dlt_pipeline_info:struct<dlt_pipeline_id:string,dlt_update_id:string>,genie_space_id:string,alert_id:string>` |
| 28 | `direct_access` | `boolean` |

#### `system.mlflow.experiments_latest` — 7 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `update_time` | `timestamp` |
| 3 | `delete_time` | `timestamp` |
| 4 | `workspace_id` | `string` |
| 5 | `experiment_id` | `string` |
| 6 | `name` | `string` |
| 7 | `create_time` | `timestamp` |

#### `system.mlflow.runs_latest` — 14 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `update_time` | `timestamp` |
| 3 | `delete_time` | `timestamp` |
| 4 | `workspace_id` | `string` |
| 5 | `run_id` | `string` |
| 6 | `experiment_id` | `string` |
| 7 | `created_by` | `string` |
| 8 | `start_time` | `timestamp` |
| 9 | `end_time` | `timestamp` |
| 10 | `run_name` | `string` |
| 11 | `status` | `string` |
| 12 | `params` | `map<string,string>` |
| 13 | `tags` | `map<string,string>` |
| 14 | `aggregated_metrics` | `array<struct<metric_name:string,min_value:double,max_value:double,latest_value:double>>` |

#### `system.mlflow.run_metrics_history` — 10 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `insert_time` | `timestamp` |
| 3 | `record_id` | `string` |
| 4 | `workspace_id` | `string` |
| 5 | `experiment_id` | `string` |
| 6 | `run_id` | `string` |
| 7 | `metric_name` | `string` |
| 8 | `metric_time` | `timestamp` |
| 9 | `metric_step` | `bigint` |
| 10 | `metric_value` | `double` |

#### `system.query.history` — 44 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `account_id` | `string` |
| 2 | `workspace_id` | `string` |
| 3 | `statement_id` | `string` |
| 4 | `executed_by` | `string` |
| 5 | `session_id` | `string` |
| 6 | `execution_status` | `string` |
| 7 | `compute` | `struct<type:string,cluster_id:string,warehouse_id:string>` |
| 8 | `executed_by_user_id` | `string` |
| 9 | `statement_text` | `string` |
| 10 | `statement_type` | `string` |
| 11 | `error_message` | `string` |
| 12 | `client_application` | `string` |
| 13 | `client_driver` | `string` |
| 14 | `total_duration_ms` | `bigint` |
| 15 | `waiting_for_compute_duration_ms` | `bigint` |
| 16 | `waiting_at_capacity_duration_ms` | `bigint` |
| 17 | `execution_duration_ms` | `bigint` |
| 18 | `compilation_duration_ms` | `bigint` |
| 19 | `total_task_duration_ms` | `bigint` |
| 20 | `result_fetch_duration_ms` | `bigint` |
| 21 | `start_time` | `timestamp` |
| 22 | `end_time` | `timestamp` |
| 23 | `update_time` | `timestamp` |
| 24 | `read_partitions` | `bigint` |
| 25 | `pruned_files` | `bigint` |
| 26 | `read_files` | `bigint` |
| 27 | `read_rows` | `bigint` |
| 28 | `produced_rows` | `bigint` |
| 29 | `read_bytes` | `bigint` |
| 30 | `read_io_cache_percent` | `tinyint` |
| 31 | `from_result_cache` | `boolean` |
| 32 | `spilled_local_bytes` | `bigint` |
| 33 | `written_bytes` | `bigint` |
| 34 | `shuffle_read_bytes` | `bigint` |
| 35 | `query_source` | `struct<job_info:struct<job_id:string,job_run_id:string,job_task_run_id:string>,legacy_dashboard_id:string,dashboard_id:string,alert_id:string,notebook_id:string,sql_query_id:string,genie_space_id:string,pipeline_info:struct<pipeline_id:string,update_id:string>>` |
| 36 | `executed_as_user_id` | `string` |
| 37 | `executed_as` | `string` |
| 38 | `written_rows` | `bigint` |
| 39 | `written_files` | `bigint` |
| 40 | `cache_origin_statement_id` | `string` |
| 41 | `query_parameters` | `struct<named_parameters:map<string,struct<exprs:array<struct<tag:string,data_type:struct<type_name:string,type_ddl:string,redacted_type_ddl:string>,literal:struct<data_type:struct<type_name:string,type_ddl:string,redacted_type_ddl:string>,int_value:int,long_value:bigint,double_value:double,float_value:float,byte_value:int,short_value:int,string_value:string,boolean_value:boolean,decimal_value:struct<value:string,precision:int,scale:int>,binary_value:binary,timestamp_value:bigint,timestamp_ntz_value:bigint,date_value:bigint,calendar_interval_value:struct<months:int,days:int,microseconds:bigint>,day_time_interval_value:bigint,year_month_interval_value:int>,seq_expression:struct<children:array<bigint>>,function:struct<function_name:string,arguments:array<bigint>>,alias:struct<expr:bigint,name:array<string>,metadata:string>,sort_order:struct<child:bigint,direction:string,null_ordering:string>,lambda_function:struct<function:bigint,arguments:array<struct<name_parts:array<string>>>>,window:struct<window_function:bigint,partition_spec:array<bigint>,order_spec:array<bigint>>,unresolved_extract_value:struct<child:bigint,extraction:bigint>,update_fields:struct<struct_expression:bigint,field_name:string,value_expression:bigint>,unresolved_named_lambda_variable:struct<name_parts:array<string>>,named_argument_expression:struct<key:string,value:bigint>,id:bigint>>>>,pos_parameters:array<struct<exprs:array<struct<tag:string,data_type:struct<type_name:string,type_ddl:string,redacted_type_ddl:string>,literal:struct<data_type:struct<type_name:string,type_ddl:string,redacted_type_ddl:string>,int_value:int,long_value:bigint,double_value:double,float_value:float,byte_value:int,short_value:int,string_value:string,boolean_value:boolean,decimal_value:struct<value:string,precision:int,scale:int>,binary_value:binary,timestamp_value:bigint,timestamp_ntz_value:bigint,date_value:bigint,calendar_interval_value:struct<months:int,days:int,microseconds:bigint>,day_time_interval_value:bigint,year_month_interval_value:int>,seq_expression:struct<children:array<bigint>>,function:struct<function_name:string,arguments:array<bigint>>,alias:struct<expr:bigint,name:array<string>,metadata:string>,sort_order:struct<child:bigint,direction:string,null_ordering:string>,lambda_function:struct<function:bigint,arguments:array<struct<name_parts:array<string>>>>,window:struct<window_function:bigint,partition_spec:array<bigint>,order_spec:array<bigint>>,unresolved_extract_value:struct<child:bigint,extraction:bigint>,update_fields:struct<struct_expression:bigint,field_name:string,value_expression:bigint>,unresolved_named_lambda_variable:struct<name_parts:array<string>>,named_argument_expression:struct<key:string,value:bigint>,id:bigint>>>>,truncated:boolean>` |
| 42 | `query_tags` | `map<string,string>` |
| 43 | `pruned_files_bytes` | `bigint` |
| 44 | `read_files_bytes` | `bigint` |

#### `system.telemetry.otel_spans` — 24 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `record_id` | `string` |
| 2 | `time` | `timestamp` |
| 3 | `date` | `date` |
| 4 | `service_name` | `string` |
| 5 | `trace_id` | `string` |
| 6 | `span_id` | `string` |
| 7 | `trace_state` | `string` |
| 8 | `parent_span_id` | `string` |
| 9 | `flags` | `int` |
| 10 | `name` | `string` |
| 11 | `kind` | `string` |
| 12 | `start_time_unix_nano` | `bigint` |
| 13 | `end_time_unix_nano` | `bigint` |
| 14 | `attributes` | `variant` |
| 15 | `dropped_attributes_count` | `int` |
| 16 | `events` | `array<struct<time_unix_nano:bigint,name:string,attributes:variant,dropped_attributes_count:int>>` |
| 17 | `dropped_events_count` | `int` |
| 18 | `links` | `array<struct<trace_id:string,span_id:string,trace_state:string,attributes:variant,dropped_attributes_count:int,flags:int>>` |
| 19 | `dropped_links_count` | `int` |
| 20 | `status` | `struct<message:string,code:string>` |
| 21 | `resource` | `struct<attributes:variant,dropped_attributes_count:int>` |
| 22 | `resource_schema_url` | `string` |
| 23 | `instrumentation_scope` | `struct<name:string,version:string,attributes:variant,dropped_attributes_count:int>` |
| 24 | `span_schema_url` | `string` |

#### `system.telemetry.otel_logs` — 19 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `record_id` | `string` |
| 2 | `time` | `timestamp` |
| 3 | `date` | `date` |
| 4 | `service_name` | `string` |
| 5 | `event_name` | `string` |
| 6 | `trace_id` | `string` |
| 7 | `span_id` | `string` |
| 8 | `time_unix_nano` | `bigint` |
| 9 | `observed_time_unix_nano` | `bigint` |
| 10 | `severity_number` | `string` |
| 11 | `severity_text` | `string` |
| 12 | `body` | `variant` |
| 13 | `attributes` | `variant` |
| 14 | `dropped_attributes_count` | `int` |
| 15 | `flags` | `int` |
| 16 | `resource` | `struct<attributes:variant,dropped_attributes_count:int>` |
| 17 | `resource_schema_url` | `string` |
| 18 | `instrumentation_scope` | `struct<name:string,version:string,attributes:variant,dropped_attributes_count:int>` |
| 19 | `log_schema_url` | `string` |

#### `system.telemetry.otel_metrics` — 20 columns (SUCCEEDED)

| # | Column | Type |
|---|---|---|
| 1 | `record_id` | `string` |
| 2 | `time` | `timestamp` |
| 3 | `date` | `date` |
| 4 | `service_name` | `string` |
| 5 | `start_time_unix_nano` | `bigint` |
| 6 | `time_unix_nano` | `bigint` |
| 7 | `name` | `string` |
| 8 | `description` | `string` |
| 9 | `unit` | `string` |
| 10 | `metric_type` | `string` |
| 11 | `gauge` | `struct<value:double,exemplars:array<struct<time_unix_nano:bigint,value:double,span_id:string,trace_id:string,filtered_attributes:variant>>,attributes:variant,flags:int>` |
| 12 | `sum` | `struct<value:double,exemplars:array<struct<time_unix_nano:bigint,value:double,span_id:string,trace_id:string,filtered_attributes:variant>>,attributes:variant,flags:int,aggregation_temporality:string,is_monotonic:boolean>` |
| 13 | `histogram` | `struct<count:bigint,sum:double,bucket_counts:array<bigint>,explicit_bounds:array<double>,exemplars:array<struct<time_unix_nano:bigint,value:double,span_id:string,trace_id:string,filtered_attributes:variant>>,attributes:variant,flags:int,min:double,max:double,aggregation_temporality:string>` |
| 14 | `exponential_histogram` | `struct<attributes:variant,count:bigint,sum:double,scale:int,zero_count:bigint,positive_bucket:struct<offset:int,bucket_counts:array<bigint>>,negative_bucket:struct<offset:int,bucket_counts:array<bigint>>,flags:int,exemplars:array<struct<time_unix_nano:bigint,value:double,span_id:string,trace_id:string,filtered_attributes:variant>>,min:double,max:double,zero_threshold:double,aggregation_temporality:string>` |
| 15 | `summary` | `struct<count:bigint,sum:double,quantile_values:array<struct<quantile:double,value:double>>,attributes:variant,flags:int>` |
| 16 | `metadata` | `variant` |
| 17 | `resource` | `struct<attributes:variant,dropped_attributes_count:int>` |
| 18 | `resource_schema_url` | `string` |
| 19 | `instrumentation_scope` | `struct<name:string,version:string,attributes:variant,dropped_attributes_count:int>` |
| 20 | `metric_schema_url` | `string` |


### 11d. Distinct-value probes

**`system.billing.usage` — `billing_origin_product`, last 30 d (this workspace)**
```sql
SELECT billing_origin_product, count(*) records, round(sum(usage_quantity), 2) qty
FROM system.billing.usage
WHERE workspace_id = '1234567890123456' AND usage_date >= current_date() - 30
GROUP BY 1
ORDER BY qty DESC
```
| billing_origin_product | records | qty |
|---|---|---|
| VECTOR_SEARCH | 52324 | 209125.02 |
| APPS | 50213 | 25505.43 |
| AI_FUNCTIONS | 661 | 23054.46 |
| GENIE | 3886 | 14945.05 |
| MODEL_SERVING | 9852 | 10286.45 |
| LAKEBASE | 110679 | 6021.33 |
| SQL | 1340 | 3853.74 |
| JOBS | 20076 | 989.36 |
| NETWORKING | 90484 | 408.59 |
| INTERACTIVE | 1541 | 378.53 |
| DATA_QUALITY_MONITORING | 8780 | 344.97 |
| LAKEHOUSE_REAL_TIME | 197 | 158.93 |
| SUPERVISOR_AGENT | 28 | 147.13 |
| AGENT_BRICKS | 4 | 90.01 |
| AI_GATEWAY | 528 | 21.81 |
| LAKEFLOW_CONNECT | 252 | 18.07 |
| DLT | 127 | 17.70 |
| AGENT_EVALUATION | 20 | 13.03 |
| ALL_PURPOSE | 8 | 11.54 |
| PREDICTIVE_OPTIMIZATION | 130 | 11.15 |

**AI-related products by SKU (30 d)**
```sql
SELECT billing_origin_product, sku_name, usage_unit, count(*) records, round(sum(usage_quantity), 2) qty
FROM system.billing.usage
WHERE workspace_id = '1234567890123456' AND usage_date >= current_date() - 30 AND billing_origin_product IN ('MODEL_SERVING','AI_GATEWAY','AGENT_BRICKS','APPS','VECTOR_SEARCH','AI_FUNCTIONS','FOUNDATION_MODEL_TRAINING','AGENT_EVALUATION','ONLINE_TABLES','LAKEBASE','DATABASE','AI_RUNTIME')
GROUP BY ALL
ORDER BY qty DESC
LIMIT 40
```
| billing_origin_product | sku_name | usage_unit | records | qty |
|---|---|---|---|---|
| VECTOR_SEARCH | ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA | DBU | 52284 | 209115.92 |
| APPS | ENTERPRISE_ALL_PURPOSE_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA | DBU | 50213 | 25505.43 |
| AI_FUNCTIONS | ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA | DBU | 661 | 23054.46 |
| MODEL_SERVING | ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA | DBU | 9322 | 6767.92 |
| LAKEBASE | ENTERPRISE_DATABASE_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA | DBU | 60750 | 5986.07 |
| MODEL_SERVING | ENTERPRISE_ANTHROPIC_MODEL_SERVING | DBU | 370 | 2472.67 |
| MODEL_SERVING | ENTERPRISE_OPENAI_MODEL_SERVING | DBU | 147 | 972.01 |
| AGENT_BRICKS | ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA | DBU | 4 | 90.01 |
| MODEL_SERVING | ENTERPRISE_MOONSHOT_MODEL_SERVING | DBU | 8 | 65.03 |
| LAKEBASE | ENTERPRISE_DATABRICKS_STORAGE_US_EAST_N_VIRGINIA | DSU | 49875 | 31.88 |
| AI_GATEWAY | ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA | DBU | 528 | 21.81 |
| AGENT_EVALUATION | ENTERPRISE_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA | DBU | 20 | 13.03 |
| VECTOR_SEARCH | ENTERPRISE_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA | DBU | 40 | 9.10 |
| MODEL_SERVING | ENTERPRISE_GEMINI_MODEL_SERVING | DBU | 5 | 8.81 |
| LAKEBASE | ENTERPRISE_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA | DBU | 54 | 3.38 |

**Which attribution IDs are populated per AI product (30 d)**
```sql
SELECT billing_origin_product, count(*) records, count(usage_metadata.endpoint_name) with_endpoint_name, count(usage_metadata.endpoint_id) with_endpoint_id, count(usage_metadata.app_id) with_app_id, count(usage_metadata.app_name) with_app_name, count(usage_metadata.budget_policy_id) with_budget_policy, count(usage_metadata.usage_policy_id) with_usage_policy
FROM system.billing.usage
WHERE workspace_id = '1234567890123456' AND usage_date >= current_date() - 30 AND billing_origin_product IN ('MODEL_SERVING','AI_GATEWAY','AGENT_BRICKS','APPS','VECTOR_SEARCH','AI_FUNCTIONS','AGENT_EVALUATION','GENIE')
GROUP BY 1
ORDER BY records DESC
```
| billing_origin_product | records | with_endpoint_name | with_endpoint_id | with_app_id | with_app_name | with_budget_policy | with_usage_policy |
|---|---|---|---|---|---|---|---|
| VECTOR_SEARCH | 52324 | 52284 | 52284 | 0 | 0 | 718 | 718 |
| APPS | 50213 | 0 | 0 | 50213 | 50213 | 1831 | 1831 |
| MODEL_SERVING | 9852 | 9852 | 9852 | 0 | 0 | 27 | 27 |
| GENIE | 3886 | 0 | 0 | 0 | 0 | 0 | 0 |
| AI_FUNCTIONS | 661 | 661 | 661 | 0 | 0 | 0 | 0 |
| AI_GATEWAY | 528 | 528 | 528 | 0 | 0 | 0 | 0 |
| AGENT_EVALUATION | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| AGENT_BRICKS | 4 | 4 | 4 | 0 | 0 | 0 | 0 |

**Agent Bricks / Supervisor Agent cost rows (30 d).** `product_features.agent_bricks.problem_type` identifies the tile type.
```sql
SELECT billing_origin_product, product_features.agent_bricks.problem_type AS problem_type, product_features.agent_bricks.workload_type AS workload_type, usage_metadata.endpoint_name, round(sum(usage_quantity), 3) dbus
FROM system.billing.usage
WHERE workspace_id = '1234567890123456' AND usage_date >= current_date() - 30 AND billing_origin_product IN ('AGENT_BRICKS', 'SUPERVISOR_AGENT', 'AGENT_EVALUATION')
GROUP BY ALL
ORDER BY dbus DESC
LIMIT 15
```
| billing_origin_product | problem_type | workload_type | endpoint_name | dbus |
|---|---|---|---|---|
| AGENT_BRICKS | AGENT_BRICKS_KNOWLEDGE_ASSISTANT | AGENT_BRICKS_REAL_TIME_INFERENCE | ka-a176dc0c-endpoint | 90.006 |
| SUPERVISOR_AGENT | AGENT_BRICKS_SUPERVISOR_AGENT | AGENT_BRICKS_REAL_TIME_INFERENCE | mas-ff16a51c-endpoint | 80.991 |
| SUPERVISOR_AGENT | AGENT_BRICKS_SUPERVISOR_AGENT | AGENT_BRICKS_REAL_TIME_INFERENCE | mas-2e8a4ac6-endpoint | 44.824 |
| SUPERVISOR_AGENT | AGENT_BRICKS_SUPERVISOR_AGENT | AGENT_BRICKS_REAL_TIME_INFERENCE | mas-acd1e8ba-endpoint | 15.181 |
| AGENT_EVALUATION |  |  |  | 13.027 |
| SUPERVISOR_AGENT | AGENT_BRICKS_SUPERVISOR_AGENT | AGENT_BRICKS_REAL_TIME_INFERENCE | mas-962599b7-endpoint | 4.197 |
| SUPERVISOR_AGENT | AGENT_BRICKS_SUPERVISOR_AGENT | AGENT_BRICKS_REAL_TIME_INFERENCE | mas-ca4a76f1-endpoint | 1.306 |
| SUPERVISOR_AGENT | AGENT_BRICKS_SUPERVISOR_AGENT | AGENT_BRICKS_REAL_TIME_INFERENCE | mas-f3d3229a-endpoint | 0.636 |

**`system.billing.list_prices`, current AWS serving-related SKUs.** All are **$0.07 / DBU** list for us-east-1 serverless real-time inference and for the per-provider `*_MODEL_SERVING` SKUs. 60 rows were returned in total; the US-East and provider subset is in `10c`.
```sql
SELECT sku_name, cloud, currency_code, usage_unit, pricing.default AS list_default, pricing.effective_list.default AS effective_list, price_start_time
FROM system.billing.list_prices
WHERE price_end_time IS NULL AND cloud = 'AWS' AND (sku_name ILIKE '%SERVING%' OR sku_name ILIKE '%INFERENCE%' OR sku_name ILIKE '%GATEWAY%' OR sku_name ILIKE '%AGENT%' OR sku_name ILIKE '%APPS%' OR sku_name ILIKE '%VECTOR%')
ORDER BY sku_name
LIMIT 60
```

**`system.access.audit`, service names (7 d)**
```sql
SELECT service_name, count(*) AS events
FROM system.access.audit
WHERE workspace_id = '1234567890123456' AND event_date >= current_date() - 7 AND service_name ILIKE ANY ('%serving%', '%mcp%', '%agent%', '%genie%', '%gateway%', '%apps%')
GROUP BY 1
ORDER BY events DESC
```
| service_name | events |
|---|---|
| agentEvaluation | 8739 |
| aibiGenie | 7860 |
| agentFramework | 1737 |
| mcpService | 1198 |
| genieChat | 353 |
| apps | 339 |
| agents | 318 |
| supervisor_agent | 76 |
| supervisorAgent | 28 |
| managedMcp | 26 |
| aiGatewaySkills | 1 |

Top actions (7 d):
| service_name | action_name | events |
|---|---|---|
| agentEvaluation | getChatAssessments | 5230 |
| agentEvaluation | getScheduledScorers | 3402 |
| aibiGenie | genieGetConversationMessage | 3209 |
| aibiGenie | genieGetSpace | 1766 |
| agentFramework | getChainDeployments | 1688 |
| mcpService | mcpCall | 1198 |
| aibiGenie | getSpace | 650 |
| aibiGenie | getConversation | 469 |
| aibiGenie | getConversationMessage | 321 |
| agents | listTiles | 283 |
| aibiGenie | genieStartConversationMessage | 240 |
| aibiGenie | genieGetMessageAttachmentQueryResult | 187 |
| aibiGenie | listInstructions | 179 |
| apps | deployApp | 129 |
| aibiGenie | listConversationMessageComments | 116 |
| aibiGenie | genieListSpaces | 115 |
| genieChat | listGenieChatConversations | 113 |
| aibiGenie | listCuratedQuestions | 96 |
| aibiGenie | getMessageAttachmentQueryResult | 94 |
| genieChat | getGenieChatConversation | 79 |

30-day request-param keys of interest:
- `mcpService.mcpCall` (2,695): `fully_qualified_name`, `json_rpc_method`, `tool_name`, `is_write`, `amount_of_bytes_sent`, `auth_type`, `connection_id`, `connection_name`, `http_method`.
- `managedMcp.mcpRequest`: `server_type`, `mcp_method`, `tool_name`, `genie_space_id`, `index_name`, `catalog_name`, `schema_name`.
- `supervisorAgent.{list,get,listTools,createTool,createExample,create}`: `name`/`parent` = `supervisor-agents/{id}`.
- **`aiGatewaySkills.skillLoad`**: `fully_qualified_name` = `main.vital_skills.rwe-cohortstudy`, `uc_location` = `main.vital_skills`. This is how skill locations can be discovered (see §13).
- `agents.{listTiles,getTile,createTile,listEvaluationRuns,listQualityReports}`, `apps.{deployApp,createApp,deleteApp,startApp,stopApp,changeAppsAcl}`, `serverlessRealTimeInference.{createServingEndpoint,updateServingEndpoint,changeInferenceEndpointAcl}`.

**`system.access.table_lineage`, `entity_type` (30 d)**
```sql
SELECT entity_type, count(*) AS events
FROM system.access.table_lineage
WHERE workspace_id = '1234567890123456' AND event_date >= current_date() - 30
GROUP BY 1
ORDER BY events DESC
```
| entity_type | events |
|---|---|
| JOB | 55120 |
|  | 41447 |
| PIPELINE | 4550 |
| DASHBOARD_V3 | 735 |
| NOTEBOOK | 622 |
| DBSQL_QUERY | 31 |

There are **no** `SERVING_ENDPOINT`, `AGENT`, `GENIE` or `APP` entity types. `entity_metadata` does carry `genie_space_id` (and so does `system.query.history.query_source.genie_space_id`).

**`system.mlflow`**: 227 live experiments, 255 runs updated in the last 30 d. `run_metrics_history.metric_name` holds eval scorer aggregates such as `correctness/mean`, `groundedness/mean`, `abstention/mean`.

**AI Gateway usage breakdown (30 d)**
| service_type | api_type | destination_type | is_mcp | n | tokens |
|---|---|---|---|---|---|
| MCP_SERVICE |  |  | true | 2685 |  |
| MODEL_SERVICE | mlflow/v1/chat/completions | PAY_PER_TOKEN_FOUNDATION_MODEL | false | 366 | 1416937 |
| MODEL_SERVICE | openai/v1/responses | PAY_PER_TOKEN_FOUNDATION_MODEL | false | 212 | 12530777 |
| MODEL_SERVICE |  | PAY_PER_TOKEN_FOUNDATION_MODEL | false | 46 | 16409 |
| MODEL_SERVICE | mlflow/v1/responses | PAY_PER_TOKEN_FOUNDATION_MODEL | false | 44 | 120829 |
| MODEL_SERVICE | mlflow/v1/embeddings | PAY_PER_TOKEN_FOUNDATION_MODEL | false | 21 | 257 |
| MODEL_SERVICE | anthropic/v1/messages | PAY_PER_TOKEN_FOUNDATION_MODEL | false | 9 | 195631 |

MCP traffic by server (30 d):
| service_type | service_name | server_type | n | tools | clients |
|---|---|---|---|---|---|
| MCP_SERVICE | system.ai.genie_one_mcp | SYSTEM | 591 | 2 | [] |
| MCP_SERVICE | system.ai.google_drive | SYSTEM | 335 | 1 | [] |
| MCP_SERVICE | system.ai.microsoft_365 | SYSTEM | 316 | 0 | [] |
| MCP_SERVICE | system.ai.atlassian | SYSTEM | 311 | 1 | [] |
| MCP_SERVICE | system.ai.google_calendar | SYSTEM | 308 | 0 | [] |
| MCP_SERVICE | system.ai.gmail | SYSTEM | 307 | 1 | [] |
| MCP_SERVICE | system.ai.slack | SYSTEM | 306 | 1 | [] |
| MCP_SERVICE | tony_farias.slurm_hpc.slurm_ops | EXTERNAL | 141 | 8 | [] |
| MCP_SERVICE | tony_farias.slurm_hpc.slurm_readonly | EXTERNAL | 33 | 3 | [] |
| MCP_SERVICE | system.ai.github | SYSTEM | 25 | 0 | [] |
| MCP_SERVICE | system.ai.web_search | SYSTEM | 11 | 1 | [] |
| MCP_SERVICE | main.lilly_heor_rwe_demo.nsclc_mcp | EXTERNAL | 1 | 0 | [] |

---

## 12. Aggregates (Probe 10 asks)

### 12a. AI Gateway usage per endpoint, last 30 days, top 10
```sql
SELECT endpoint_name, count(*) AS requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(total_tokens) AS total_tokens, count(DISTINCT requester) AS distinct_requesters, round(avg(latency_ms)) AS avg_latency_ms, sum(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_requests
FROM system.ai_gateway.usage
WHERE workspace_id = '1234567890123456' AND event_time >= current_timestamp() - INTERVAL 30 DAYS
GROUP BY endpoint_name
ORDER BY requests DESC
LIMIT 10
```
| endpoint_name | requests | input_tokens | output_tokens | total_tokens | distinct_requesters | avg_latency_ms | error_requests |
|---|---|---|---|---|---|---|---|
|  | 2685 |  |  |  | 9 | 5706.0 | 3 |
| system.ai.gpt-5-6-sol | 208 | 12383987 | 60013 | 12444000 | 1 | 4612.0 | 0 |
| system.ai.gpt-5-4-mini | 96 | 392644 | 19673 | 412317 | 2 | 1844.0 | 0 |
| system.ai.claude-sonnet-5-5 | 80 | 172246 | 13920 | 186166 | 2 | 2176.0 | 1 |
| system.ai.claude-sonnet-4-5 | 70 | 579852 | 11028 | 590880 | 2 | 3254.0 | 0 |
| system.ai.claude-sonnet-4-6 | 43 | 13064 | 3163 | 16227 | 1 |  | 9 |
| system.ai.gpt-5-nano | 38 | 19528 | 2300 | 21828 | 2 | 1110.0 | 0 |
| system.ai.gpt-5-5 | 35 | 158319 | 8331 | 166650 | 2 | 3624.0 | 0 |
| main.merck_genie_eval_poc.genie_eval_llm | 26 | 10967 | 2059 | 13026 | 1 | 2881.0 | 0 |
| system.ai.gpt-oss-120b | 26 | 2910 | 65769 | 68679 | 2 | 21022.0 | 0 |

The NULL `endpoint_name` row holds the 2,685 MCP calls (key them by `service_name` instead). One UC model shows up (`main.merck_genie_eval_poc.genie_eval_llm`). Everything else is `system.ai.*` FMAPI.

Complementary view, `system.serving.endpoint_usage` ⋈ `served_entities` (classic serving path), top 10:
```sql
SELECT se.endpoint_name, count(*) AS requests, sum(eu.input_token_count) AS input_tokens, sum(eu.output_token_count) AS output_tokens
FROM system.serving.endpoint_usage eu
JOIN (SELECT DISTINCT served_entity_id, endpoint_name
FROM system.serving.served_entities
WHERE workspace_id = '1234567890123456') se
ON eu.served_entity_id = se.served_entity_id
WHERE eu.workspace_id = '1234567890123456'
AND eu.request_time >= current_timestamp() - INTERVAL 30 DAYS
GROUP BY 1
ORDER BY requests DESC
LIMIT 10
```
| endpoint_name | requests | input_tokens | output_tokens |
|---|---|---|---|
| databricks-qwen3-embedding-0-6b | 10702 | 236506220 | 0 |
| databricks-claude-sonnet-5-5 | 5736 | 6620540 | 932080 |
| databricks-gpt-5-6-sol | 1461 | 58997062 | 630550 |
| databricks-gte-large-en | 1404 | 14605799 | 0 |
| databricks-claude-opus-5-5 | 1179 | 207029 | 99734 |
| databricks-claude-sonnet-4-6 | 900 | 865441 | 367964 |
| databricks-claude-sonnet-5 | 848 | 3488723 | 3268763 |
| databricks-gemini-3-8-flash | 656 | 484824 | 31988 |
| databricks-claude-sonnet-4-5 | 342 | 368249 | 76712 |
| databricks-claude-opus-5 | 127 | 2293962 | 221912 |

### 12b. $ per `usage_metadata.endpoint_name`, last 30 days, top 10 (`billing.usage` × `list_prices`)
First as requested, across **all** products that set `endpoint_name`:
```sql
SELECT u.usage_metadata.endpoint_name AS endpoint_name, u.billing_origin_product, round(sum(u.usage_quantity), 3) AS dbus, round(sum(u.usage_quantity * lp.pricing.effective_list.default), 2) AS usd_list
FROM system.billing.usage u
JOIN system.billing.list_prices lp
ON u.sku_name = lp.sku_name AND u.cloud = lp.cloud AND u.usage_unit = lp.usage_unit AND u.usage_end_time >= lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
WHERE u.workspace_id = '1234567890123456'
AND u.usage_date >= current_date() - 30 AND u.usage_metadata.endpoint_name IS NOT NULL
GROUP BY 1, 2
ORDER BY usd_list DESC
LIMIT 10
```
| endpoint_name | billing_origin_product | dbus | usd_list |
|---|---|---|---|
| databricks-ai-parse-document | AI_FUNCTIONS | 14611.498 | 1022.80 |
| databricks-ai-extract | AI_FUNCTIONS | 5124.741 | 358.73 |
| databricks-ai-gen | MODEL_SERVING | 3331.610 | 233.21 |
| agents_main-hls_payer_care_manager-care_manager_age | MODEL_SERVING | 2882.027 | 201.74 |
| chunking_eval_endpoint | VECTOR_SEARCH | 2872.000 | 201.04 |
| ka-3c892aa6-vs-endpoint | VECTOR_SEARCH | 2872.000 | 201.04 |
| ka-da062992-vs-endpoint | VECTOR_SEARCH | 2872.000 | 201.04 |
| ka-fbc8e087-vs-endpoint | VECTOR_SEARCH | 2872.000 | 201.04 |
| ka-86b5a3bc-vs-endpoint | VECTOR_SEARCH | 2872.000 | 201.04 |
| mas-0849ad0e-endpoint | VECTOR_SEARCH | 2872.000 | 201.04 |

> **Gotcha.** `usage_metadata.endpoint_name` is a shared namespace. For `VECTOR_SEARCH` it holds the **VS endpoint** name (`ka-…-vs-endpoint`, and even `mas-0849ad0e-endpoint` as a VS endpoint), and for `AI_FUNCTIONS` it holds `databricks-ai-*`. Group by `(billing_origin_product, endpoint_name)`, never by name alone.

Serving products only (`MODEL_SERVING`, `AGENT_BRICKS`, `AI_GATEWAY`, `AGENT_EVALUATION`):
```sql
SELECT u.usage_metadata.endpoint_name AS endpoint_name, u.billing_origin_product, round(sum(u.usage_quantity), 3) AS dbus, round(sum(u.usage_quantity * lp.pricing.effective_list.default), 2) AS usd_list
FROM system.billing.usage u
JOIN system.billing.list_prices lp
ON u.sku_name = lp.sku_name AND u.cloud = lp.cloud AND u.usage_unit = lp.usage_unit AND u.usage_end_time >= lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
WHERE u.workspace_id = '1234567890123456'
AND u.usage_date >= current_date() - 30
AND u.billing_origin_product IN ('MODEL_SERVING', 'AGENT_BRICKS', 'AI_GATEWAY', 'AGENT_EVALUATION') AND u.usage_metadata.endpoint_name IS NOT NULL
GROUP BY 1, 2
ORDER BY usd_list DESC
LIMIT 10
```
| endpoint_name | billing_origin_product | dbus | usd_list |
|---|---|---|---|
| databricks-ai-gen | MODEL_SERVING | 3331.610 | 233.21 |
| agents_main-hls_payer_care_manager-care_manager_age | MODEL_SERVING | 2882.027 | 201.74 |
| databricks-claude-sonnet-4-6 | MODEL_SERVING | 1064.858 | 74.54 |
| databricks-gpt-5-6-sol | MODEL_SERVING | 907.829 | 63.55 |
| databricks-claude-sonnet-5 | MODEL_SERVING | 625.307 | 43.77 |
| databricks-claude-sonnet-5-5 | MODEL_SERVING | 361.726 | 25.32 |
| databricks-claude-opus-5 | MODEL_SERVING | 267.427 | 18.72 |
| evo2-7b-embeddings | MODEL_SERVING | 248.950 | 17.43 |
| ka-a176dc0c-endpoint | AGENT_BRICKS | 90.006 | 6.30 |
| databricks-qwen3-embedding-0-6b | MODEL_SERVING | 84.228 | 5.90 |

`SUPERVISOR_AGENT` is a separate `billing_origin_product`. It was not in the filter above and must be added (e.g. `mas-ff16a51c-endpoint` 80.99 DBU ≈ $5.67). `usd_list` uses `pricing.effective_list.default` and is list price, not the account's negotiated price (`system.billing.account_prices` exists but was not probed).

---

## 13. Probe 11 — MLflow (experiments, traces, logged models)

**Sample:** `samples/11_mlflow_experiments_traces_logged_models.json`

- `POST /api/2.0/mlflow/experiments/search` `{"max_results":20,"order_by":["last_update_time DESC"]}` returns 200 with `{"experiments": [...], "next_page_token"}`. Experiment keys: `experiment_id, name, artifact_location, lifecycle_stage, last_update_time, creation_time, tags[{key,value}]`. Tag keys: `mlflow.ownerEmail`, `mlflow.ownerId`, `mlflow.experimentType`, `mlflow.experiment.sourceName`, `mlflow.experiment.sourceId/sourceType`, **`mlflow.experimentKind`** (`genai_development`).
  - Agent filter: ``"filter": "tags.`mlflow.experimentKind` = 'genai_development'"`` works (200, full page of 20, e.g. `mas-2e8a4ac6-dev-experiment`, `ka-a176dc0c-dev-experiment`, `/Shared/agentbricks_traces/…`). The un-backticked `tags.mlflow.experimentKind` and `name LIKE '%agent%'` also return 200.
  - Experiment linkage: endpoint tag `MONITOR_EXPERIMENT_ID`, tile `mlflow_experiment_id`, v2.1 KA/SA `experiment_id`.
- **Trace search v3** `POST /api/3.0/mlflow/traces/search` with `{"locations":[{"type":"MLFLOW_EXPERIMENT","mlflow_experiment":{"experiment_id":"3325179909192303"}}],"max_results":3}` returns 200 with `{"traces": [...], "next_page_token"}`. Across 162 traces in 10 agent experiments:
  - Trace keys: `trace_id` ("tr-…"), `client_request_id`, `trace_location{type, mlflow_experiment{experiment_id}}`, `request`, `response`, `request_preview`, `response_preview`, `request_time` (RFC 3339), `execution_duration` (e.g. `"18.031s"`, a string), `state` (`OK` 158 / `ERROR` 4), `trace_metadata{}`, `tags{}`, and **`assessments[]` (only on 58/162)**.
  - `trace_metadata` keys: `mlflow.trace.sizeBytes`, `mlflow.trace.sizeStats` (JSON string: `total_size_bytes`, `num_spans`, …), `mlflow.trace_schema.version` ("3"), **`mlflow.trace.tokenUsage`** (JSON string `{"input_tokens":10142,"output_tokens":414,"total_tokens":10556}`, **only 28/162**), **`mlflow.databricks.modelServingEndpointName`** and **`mlflow.modelId`** (42/162), `mlflow.trace.session` (3), `mlflow.source.*`, `mlflow.user`, `mlflow.traceInputs/Outputs`, `mlflow.sourceRun`, `mlflow.databricks.notebook*`.
  - `tags` keys: `mlflow.artifactLocation`, `mlflow.user`, `mlflow.traceName` (e.g. `predict_stream`), `mlflow.traceError`, `mlflow.eval.requestId` (41), `message_id`.
  - `assessments[]` keys: `assessment_id, assessment_name, trace_id, span_id, source{source_type (HUMAN|CODE|LLM_JUDGE), source_id}, create_time, last_update_time, metadata{mlflow.assessment.sourceRunId}`, plus one of `feedback{value}` (with `rationale`, `valid`) or `expectation{value | serialized_value{serialization_format, value}}`.
```json
{"trace_id": "tr-cde8bd0970714b610e35fafb7dd8c4aa",
 "trace_location": {"type": "MLFLOW_EXPERIMENT", "mlflow_experiment": {"experiment_id": "2347446610473193"}},
 "request_time": "2026-10-21T20:18:26.878Z", "execution_duration": "18.031s", "state": "OK",
 "trace_metadata": {"mlflow.trace.tokenUsage": "{\"input_tokens\": 10142, \"output_tokens\": 414, \"total_tokens\": 10556}",
   "mlflow.trace.sizeStats": "{\"total_size_bytes\": 300524, \"num_spans\": 11, …}", "mlflow.trace_schema.version": "3",
   "mlflow.source.name": "/databricks/mas.runfiles/_main/agentbricks/mas/python/main.py"},
 "tags": {"mlflow.traceName": "predict_stream", "mlflow.user": "15854ef5-…"}}
{"assessment_name": "result_match", "source": {"source_type": "CODE", "source_id": "default"},
 "feedback": {"value": "match"}, "rationale": "gt_rows=20 genie_rows=20", "valid": true}
```
- **Fallback v2** `GET /api/2.0/mlflow/traces?experiment_ids=3325179909192303&max_results=3` returns 200 with the older shape: `{request_id, experiment_id, timestamp_ms, execution_time_ms, status, request_metadata[{key,value}], tags[{key,value}]}`. `request_metadata` carries `mlflow.modelId`, `mlflow.trace.request`/`response`, `mlflow.trace.sizeBytes`.
- `GET /api/3.0/mlflow/traces/{trace_id}` returns 200 `{trace: {trace_info: {…same keys…}}}`. `GET /api/3.0/mlflow/traces/{trace_id}/info` returns 404.
- **Logged models:** `POST /api/2.0/mlflow/logged-models/search` `{"experiment_ids":["3325179909192303"],"max_results":5}` returns 200 with `{"models": [{"info": {model_id ("m-…"), experiment_id, name ("agent"), creation_timestamp_ms, last_updated_timestamp_ms, artifact_uri, status ("LOGGED_MODEL_READY"), creator_id, source_run_id, tags[{key,value}]}, "data": {}}]}`. `GET /api/2.0/mlflow/logged-models/search` returns 400 (it is parsed as a model id). `GET /api/2.0/mlflow/logged-models/{model_id}` returns 200.

---

## 14. Probe 12 — Current user
`databricks current-user me --profile DEFAULT` gives `userName = admin@example.com`. `groups[].display` contains **`admins`**, so this user is a **workspace admin**.

---

## 15. Bonus — UC Skills and agent-services (found via audit)

**Sample:** `samples/13_uc_skills_and_agent_services.json`

The audit service `aiGatewaySkills.skillLoad` pointed to UC-native **Skills**:
- `GET /api/2.1/unity-catalog/skills` returns 400 "parent is required". `parent=main.vital_skills` returns 400 "parent must include a collection prefix, e.g. 'agent-services/cat.schema.name'". `parent=catalogs/…/schemas/…` and `parent=agent-services/…` both return 400 "parent must start with 'schemas/'".
- **`GET /api/2.1/unity-catalog/skills?parent=schemas/main.vital_skills` returns 200** with `{"skills": [...]}`, **9 skills**. Fields: `name` (`skills/{cat}.{schema}.{bundle}`), `bundle_name`, `description`, `etag`, `create_time`, `update_time`, `finalize_time`, `created_by`, `updated_by`, `id`, `effective_owner`, `securable_type` (`SKILL`), `metastore_id`.
- `GET /api/2.1/unity-catalog/skills/{fqn}` returns 200 (same fields). `GET /api/2.1/unity-catalog/permissions/skill/{fqn}` returns 200 `{}`. `GET /api/2.1/unity-catalog/effective-permissions/skill/{fqn}` returns 200 (inherited from catalog).
```json
{"name": "skills/main.vital_skills.rwe-cohortstudy", "bundle_name": "rwe-cohortstudy",
 "description": "Conduct real-world evidence (RWE) comparative effectiveness studies in Python. …",
 "create_time": "2026-09-28T18:57:19.004010128Z", "update_time": "2026-09-29T22:13:52.086530155Z",
 "finalize_time": "2026-09-29T22:13:52.086530155Z", "created_by": "user07@example.com",
 "effective_owner": "user07@example.com", "securable_type": "SKILL", "id": "e1dc4183-…"}
```
- No metastore-wide skills list exists, and `information_schema` has no skills view. Discover the schemas that host skills from `system.access.audit` (`service_name='aiGatewaySkills'`, `request_params.uc_location`), then list per schema.
- `GET /api/2.1/unity-catalog/agent-services` (± `parent=schemas/…`) returns **200 `{}`**. The route exists but nothing is registered in the schemas tried.

---

## 16. Recommendations — collector viability

| Collector | Primary source (viable) | Fallback / caveat |
|---|---|---|
| **Agents: Agent Bricks** | `GET /api/2.1/supervisor-agents` + `/{id}/tools` + `/{id}/examples`; `GET /api/2.1/knowledge-assistants` + `/{id}/knowledge-sources`; `GET /api/2.0/tiles` for KIE / AI_EXTRACT / T2T and `evaluation_run_exists` | v2.0 `knowledge-assistants/{tile_id}` and `multi-agent-supervisors/{tile_id}` (no list). Don't depend on the ai-dev-kit `manage_ka` (broken) or `manage_mas` (no list). |
| **Agents: custom / endpoints** | `GET /api/2.0/serving-endpoints`, filter `task LIKE 'agent/%'` (89). Join tiles via `tile_endpoint_metadata.tile_id`. Join UC models via `served_entities[].entity_name/entity_version`. Join experiments via the `MONITOR_EXPERIMENT_ID` tag. | 56 custom endpoints have **no `task` key**. Classify them by served entity type, not by `task`. Visibility is caller-scoped. |
| **MCP servers** | UC connections where `connection_type='HTTP' AND options.is_mcp_connection == 'true'` (95; string compare). Managed MCP is derived from Genie spaces (`/mcp/genie/{id}`), UC schemas with functions (`/mcp/functions/{c}/{s}`) and `system/ai`. | Listing connections is **31 pages** metastore-wide; cache it (TTL ≥ 15 min) or try `system.information_schema.connections` (the view exists; its content was not probed). System MCP servers (`system.ai.slack`, `google_drive`, …) have **no list API**, so harvest them from `system.ai_gateway.usage.service_name`. The 43 HTTP connections without the flag need a heuristic (name/`base_path` contains `mcp`). |
| **MCP tools** | `POST /api/2.0/mcp/{functions/{c}/{s} \| genie/{id} \| external/{conn}}` `tools/list` gives `name, title?, description, inputSchema, outputSchema, annotations` | External MCP returns **403** without `USE CONNECTION`. Store "tools unknown, request access" and show an RFA button (`/api/3.0/rfa/destinations/connection/{name}`). Calling third-party servers on a schedule has side effects (rate limits), so cache aggressively. `destructiveHint` is always true on UC tools. |
| **Tools: UC functions** | Discovery: `system.information_schema.routines` (409 in 94 schemas). Detail: `GET /api/2.1/unity-catalog/functions/{fn}` (list omits params). | The REST list requires catalog+schema. |
| **Skills** | `GET /api/2.1/unity-catalog/skills?parent=schemas/{c}.{s}` and `/skills/{fqn}`; permissions use securable `skill` | No global list. Seed schemas from audit `aiGatewaySkills.skillLoad.uc_location` plus a configurable list. |
| **Usage** | `system.ai_gateway.usage` (FMAPI + MCP, rich: tokens, latency, TTFB, routing attempts, `mcp_metadata`, `session_metadata.coding_agent`) and `system.serving.endpoint_usage ⋈ served_entities` | **Agent endpoints are nearly absent from both** (usage tracking is on for only 6 endpoints, and 13 custom-model requests in 30 d). For agents, fall back to MLflow trace counts per experiment, and/or inference tables (enabled on 17 endpoints via `inference_table_config.{catalog_name, schema_name, table_name_prefix}`; the `_payload` suffix is per docs and was not probed). Always filter `workspace_id`. |
| **Cost** | `system.billing.usage ⋈ list_prices` on `sku_name, cloud, usage_unit` and the time window, using `pricing.effective_list.default`. Key `(billing_origin_product, usage_metadata.endpoint_name)` for serving, `usage_metadata.app_name` for APPS, `usage_metadata.{agent_bricks_id, supervisor_agent_id}` and `product_features.agent_bricks.problem_type` for tiles. | Include `SUPERVISOR_AGENT` and `AGENT_BRICKS`, not just `MODEL_SERVING`. Separate VECTOR_SEARCH (same `endpoint_name` field, different namespace). `external_model_spend` is empty here, so treat it as optional. List price ≠ negotiated price. |
| **Traces** | `POST /api/3.0/mlflow/traces/search` per agent experiment (`locations[]`). Token usage comes from `trace_metadata["mlflow.trace.tokenUsage"]` (JSON string). Endpoint and model links come from `mlflow.databricks.modelServingEndpointName` / `mlflow.modelId`. | No `system.mlflow` traces table, and `system.telemetry.otel_spans` is empty, so this has to be REST per experiment. Token usage is missing on most traces; show "n/a". The v2 `GET /api/2.0/mlflow/traces` is a fallback. Never store `request`/`response` (PII). |
| **Evals** | Trace `assessments[]` (feedback/expectation, HUMAN/CODE/LLM_JUDGE). `system.mlflow.runs_latest` + `run_metrics_history` (`correctness/mean`, `groundedness/mean`, …). Tile `evaluation_run_exists`. | Assessments are only on ~36% of the traces sampled. |
| **Permissions** | Workspace objects: `/api/2.0/permissions/{serving-endpoints/{id}, apps/{name}, genie/{space_id}}`. UC: `/api/2.1/unity-catalog/effective-permissions/{function,connection,skill,…}/{fqn}`. | Serving ACLs are keyed by endpoint **id**. Genie has no owner field; use the ACL `CAN_MANAGE` holder. |
| **Access requests** | `GET /api/3.0/rfa/destinations/{type}/{fqn}` (function, catalog, connection, table) gives the deep-link and owner destination | There is no batch GET and no list of pending requests, so call per object lazily (on detail view). |
| **Guardrails** | Endpoint `ai_gateway.{guardrails, rate_limits, fallback_config, usage_tracking_config, inference_table_config}`. For v2 gateway: `ai_gateway.usage.model_metadata.config.{rate_limits, service_policies}` and `gateway_feature_results` | Only 4 endpoints have guardrails, so most agents will show "no guardrails". That is a real finding to surface, not a bug. |
| **Lineage** | Build from API edges: SA tools (genie_space / uc_function / knowledge_assistant / uc_connection / uc_table / web_search), UC `model_version_dependencies`, KA `knowledge_sources.files.path` / index, Genie `serialized_space.data_sources.tables`, app `resources[]` | `system.access.table_lineage` has **no agent/serving entity types** (JOB, PIPELINE, DASHBOARD_V3, NOTEBOOK, DBSQL_QUERY, NULL). Use it only for downstream table→table hops. |
| **App deployment** | The name `agent-registry-hub` is free | **The workspace is at the 100-app cap.** Deploying will fail until a slot is freed. Ask the user which of their own 26 apps to retire (do **not** touch other users' apps), or deploy to another workspace. |
| **Lakebase** | Try a new autoscale project `agent-registry-hub` (54 exist; there is no quota API, so availability can't be checked read-only) | Fallback: a new database on an existing user-owned project (e.g. `surya-office-fleet`, `ontobricks-registry`). State lives on branch/endpoint `status.current_state`. |
| **Auth** | REST through the SDK with exact status codes | The CLI v1.20 stdout preamble breaks naive JSON parsing. The warehouse for collectors should be one that is kept running, or accept that statements auto-start serverless warehouses. |

**Bottom line.** Every registry entity has a working read path in this workspace: agents (endpoints + v2.1 Agent Bricks), MCP servers (UC connections + managed MCP), tools (UC functions + MCP `tools/list`), skills (UC skills API) and Genie. Cost (billing × list_prices) and FMAPI/MCP usage (`ai_gateway.usage`) are viable from system tables. **Agent-level usage and traces need the MLflow REST fallback**, because there is no system traces table and tracking coverage is thin. Lineage must be assembled from API edges. The two deployment blockers are the **100-app cap** and the **unverifiable Lakebase project quota**.

## 17. Addendum (2026-10-28) — external lineage and MCP service shapes

Read-only GETs with profile DEFAULT, for the Unity Catalog lineage publisher and the tool-selection editor. Only shapes and counts are recorded here, no object names.

| Call | Result |
|---|---|
| `GET /api/2.0/lineage-tracking/external-metadata?page_size=200` (6 pages) | `{external_metadata: [...], next_page_token}`; 1,200 objects visible in the metastore, none with `properties.created_by = agent-registry-hub`. Item keys: `name, system_type, entity_type, description, columns, properties, owner, metastore_id, create_time, created_by, update_time, updated_by, id, securable_type, securable_kind` (`url` on 21 of them). Names use only letters, digits, `-`, `:` and `_` (max length seen 146). `system_type` values seen: KAFKA, MICROSOFT_SQL_SERVER, OTHER, POSTGRESQL, POWER_BI, SALESFORCE, SAP, SERVICENOW, SNOWFLAKE |
| `GET …/external-metadata/{name}` on a missing name | `NOT_FOUND` |
| `GET /api/2.0/lineage-tracking/external-lineage?object_info.external_metadata.name=…&lineage_direction=UPSTREAM\|DOWNSTREAM` | `{external_lineage_relationships: [{external_lineage_info: {id, columns?, properties?}, external_metadata_info \| table_info \| …: {name, system_type, entity_type, event_time}}]}`; `{}` when there are none. The list does not echo `source`/`target`: the other node is in the `*_info` block |
| `GET /api/2.1/unity-catalog/effective-permissions/metastore/{id}` | the probing user holds only `CREATE_CATALOG` on the metastore; other principals hold `CREATE_EXTERNAL_METADATA`. Publishing as this identity would fail until a metastore admin grants it |
| `GET /api/2.1/unity-catalog/mcp-services?parent=schemas/system.ai&view=FULL` | item keys `name (mcp-services/<fqn>), effective_owner, id, securable_type, metastore_id, create/update time + by, comment, config{source_connection{…}, service_policies[…]}, etag`; `include_tool_selectors` absent on the `system.ai.*` services. `GET …/mcp-services/{fqn}` returns the same keys with an `etag` |

