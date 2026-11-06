# 01 — Databricks platform APIs for the Agent Registry Hub

| | |
|---|---|
| **Researched** | 2026-10-25/26 against public docs (`docs.databricks.com/aws/en/...`, last-updated stamps Sep–Oct 2026), the REST API reference (`docs.databricks.com/api/llms.txt` → per-operation `.md`), the Unity Gateway and product release notes (Jan–Oct 2026), DAIS 2026 blogs, and Glean (Jira/Slack) |
| **Scope** | Public platform surface only. No workspace was touched. Real response shapes from the live workspace live in [`04-live-workspace-probe.md`](04-live-workspace-probe.md). This doc cross-references that file and doesn't repeat it. |
| **Confidence tags** | **[Doc]** = Verified in public docs or API reference. **[Live→04]** = confirmed by the live probe in doc 04. **[Internal]** = Verified-internal (Jira/Slack/PRD via Glean; not customer-shareable). **[Inferred]** = reasoned from docs, not stated. **[Unverified]** = could not confirm; treat as unknown. |

> **Naming in Oct 2026.** "Mosaic AI Gateway" became **Unity AI Gateway** at DAIS (June 2026) and is now just **Unity Gateway** (GA **Aug 4 2026**). Genie Spaces became **Genie Agents** (Jul 8 2026). **Knowledge Assistant and Supervisor Agent became *legacy*** (Oct 12 2026). Code-first agents now deploy to **Agent Runtime** on Databricks Apps via the **Agent Bricks CLI** (Beta, Sep 29 2026). Several APIs and docs still say "ai-gateway" or "AI Gateway (legacy)" for the old per-serving-endpoint config.

---

## Executive summary

1. **UC is now the registry for AI assets.** Model services, model provider services, **MCP services**, **skills** and **agent services** are first-class UC securables (`catalog.schema.name`), with CRUD under `/api/2.1/unity-catalog/{mcp-services|model-services|model-provider-services|skills|agent-services}` [Doc]. The hub should **index these, not re-invent them**.
2. **MCP services are GA (API GA Sep 16 2026).** The `McpService` object has `effective_owner`, `created_by/update_time`, `comment`, `config.source_connection`, `include_tool_selectors`, `rate_limits` and `etag`. Listing is **schema-scoped** (`parent=schemas/c.s` is required), so the hub must crawl catalogs and schemas [Doc].
3. **Databricks-provided MCPs live in `system.ai`**: `genie_one_mcp` (GA Sep 25 2026), `dbsql`, `web_search`, `sandbox` (Unity Gateway Beta), plus `slack`, `github`, `atlassian`, `google_drive`, `google_calendar`, `gmail` and **`microsoft_365`**. URL: `https://<ws>/ai-gateway/mcp-services/<c.s.name>`. OAuth scope: `ai-gateway`. Privilege: `EXECUTE` [Doc]. Legacy `/api/2.0/mcp/...` endpoints **bypass Unity Gateway**, so they get no UC grants, policies or traces [Doc].
4. **Agent services (Beta) are a registry only.** You get register/list/grant. There is **no runtime invocation**, no policies, no rate limits, and `owner`/`full_name` come back `null`. External agents only (`AGENT_SERVICE_TYPE_EXTERNAL`) [Doc]. Internal plans reserve `_INTERNAL/_GENIE/_APP` types and add an invocation proxy [Internal].
5. **Databricks-built agents come from four different APIs.** KA `/api/2.1/knowledge-assistants` and Supervisor `/api/2.1/supervisor-agents` are Beta and legacy, and both return `endpoint_name` and `experiment_id`. The undocumented `/api/2.0/tiles` returns all brick types [Live→04]. Agent Runtime agents are **Databricks Apps named `agent-bricks-<name>`**. Genie Agents come from `/api/2.0/genie/spaces`.
6. **Skills are UC securables (Beta, API Oct 12 2026).** The `Skill` object comes from `SKILL.md` frontmatter. Privileges reuse **volume** privileges: `READ VOLUME` = use/share, `WRITE VOLUME`+`READ VOLUME` = update, `CREATE VOLUME` = create, `MANAGE` = re-grant. Genie Code workspace/user skills (`.assistant/skills/`) are a separate, workspace-file-based concept [Doc].
7. **Guardrails are now *service policies* (Beta).** Built-ins are `system.ai.block_unsafe_content`, `block_jailbreak`, `block_hallucination` and `detect_sensitive_data`. Custom policies are SQL UDFs returning `ALLOW/DENY/ASK`. External vendor policies also exist. **Attachment is UI-only, and there is no public API to list attached policies** [Doc]. The only read paths are the unified trace table `policy_evaluated` events.
8. **Usage comes from `system.ai_gateway.usage`** (Public Preview). Rows are per request, with `service_type` ∈ `MODEL_SERVICE|MCP_SERVICE|MODEL_PROVIDER_SERVICE`, `requester`, tokens, `mcp_metadata.tool_name`, `request_tags`, `service_tags` and `session_metadata`. **$ comes from `system.billing.usage`** (`usage_metadata.ai_gateway.*` on `MODEL_SERVING` rows) and **`system.ai_gateway.external_model_spend`** (Beta, USD) [Doc].
9. **MCP calls have tokens/latency but no direct $.** MCP cost is the cost of the tool's backend (SQL warehouse, serverless, Apps, external vendor). Per-MCP $ is an **allocation the hub must compute** [Inferred].
10. **Traces live in two places.** (a) The **unified trace table** (Beta, Aug 21 2026) is an admin-created UC table of OTel spans for every gateway model and MCP call, including policy decisions. (b) **MLflow traces in UC** (GA Jul 16 2026) are `{prefix}_otel_spans` plus `{prefix}_trace_unified/_trace_metadata` views, bound to an experiment. KA/Supervisor expose `experiment_id`. Agent Runtime binds an experiment at deploy [Doc].
11. **Lineage is partial.** UC captures model-service→foundation model/provider/inference table, Genie Agent→table (`entity_metadata.genie_space_id`), UDF lineage and **model-version declared dependencies** (`model_version_dependencies`: tables/functions/connections). It **does not capture runtime agent→service→data calls** [Doc]. The hub must stitch edges from Supervisor `tools[]`, KA `knowledge-sources`, Genie `serialized_space`, App `resources[]`, usage and trace tables, and can publish its own edges via **external lineage** [Doc].
12. **Permissions.** UC grants use `/api/2.1/unity-catalog/permissions/{securable_type}/{full_name}`, which supports `mcp_service`, `model_service`, `skill` and `AGENT_SERVICE`. Workspace ACLs use `/api/2.0/permissions/{serving-endpoints|genie|knowledge-assistants|supervisor-agents|experiments|...}/{id}` [Doc].
13. **RFA (request for access) is Public Preview.** You can `POST /api/3.0/rfa/requests` and GET/PATCH destinations. **No API lists, approves or declines requests**, and documented RFA support excludes MCP services, skills and agent services. The hub must run its own approval workflow and then call the UC grants API [Doc].
14. **Budgets.** Account API `/api/2.1/accounts/{account_id}/budgets` with `resource_type = BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY`, per-user thresholds and `BLOCK_USAGE` (Beta). Gateway budget tag filters match **model-service tags only**, not request tags [Doc].
15. **OBO.** Apps declare `user_api_scopes`. UC grants, RFA and gateway asset CRUD sit under the **`unity-catalog`** API scope. Workspace object ACLs (serving endpoints, Genie, KA, Supervisor) sit under **`access-management`**. MCP tool calls use **`ai-gateway`** [Doc]. Whether every scope is selectable as an Apps user scope is [Inferred]: verify in the app create flow.

---

## Capability matrix

| Capability | API / system table | Status (date) | Permission needed | Fields we'd use | Source / confidence |
|---|---|---|---|---|---|
| List/get MCP services | `GET /api/2.1/unity-catalog/mcp-services?parent=schemas/{c}.{s}&view=FULL&page_size≤200`; `GET /api/2.1/unity-catalog/mcp-services/{c.s.n}` | **GA** (API GA Sep 16 2026) | `USE CATALOG`+`USE SCHEMA`; returned only if owner/`EXECUTE`/`READ METADATA`/`MANAGE` | `name, effective_owner, created_by, create_time, updated_by, update_time, comment, config.source_connection.{name,is_deleted,options}, config.include_tool_selectors[], config.rate_limits[], etag` | [Doc] api `ai-gateway/v1/mcp-service` |
| Built-in MCP inventory | same API with `parent=schemas/system.ai` | GA (Genie One MCP GA Sep 25 2026; dbsql/sandbox/web_search need the Unity Gateway Beta) | metastore admin must self-grant `MANAGE` on `system.ai` to re-grant | as above | [Doc] built-in-mcp-services |
| MCP tool list | JSON-RPC `tools/list` POST to `https://<ws>/ai-gateway/mcp-services/{c.s.n}` | GA | `EXECUTE` + `USE CATALOG/SCHEMA`; OAuth scope `ai-gateway` | `tools[].name, description, inputSchema, annotations` (filtered by `include_tool_selectors`) | [Doc] unity-gateway/concepts; [Live→04] |
| MCP tool selection | `PATCH .../mcp-services/{c.s.n}?update_mask=config.include_tool_selectors` | GA | owner or `MANAGE` | `include_tool_selectors` (exact or `prefix*`, ≤1,024 entries, no `!exclusions`) | [Doc] mcp-service-reference |
| MCP per-user OAuth state | `GET/POST/DELETE /api/2.1/unity-catalog/mcp-services/{c.s.n}/user-credentials` | **Beta** | caller's own credential | `provisioning_info.state` (`ACTIVE`/`NOT_FOUND`) | [Doc] |
| Marketplace MCP listings | `GET /api/2.1/marketplace-consumer/listings?assets=ASSET_TYPE_MCP`; `GET /api/2.1/marketplace-consumer/installations` | GA (Marketplace) | workspace user | listing metadata. **Install creates an MCP service + `<name>_connection`** | [Doc] get-started-consumer |
| UC connections | `GET /api/2.1/unity-catalog/connections` | GA | `USE CONNECTION`/owner to see details | `connection_type=HTTP, options.host/base_path, owner, full_name` | [Doc] |
| Agent services (registry) | `GET/POST /api/2.1/unity-catalog/agent-services[?parent=schemas/c.s]`, `GET/PATCH/DELETE .../agent-services/{c.s.n}` | **Beta** (account preview "Unity Gateway" beta) | create: `CREATE SERVICE` + `USE CONNECTION`; see: explicit privilege (no `BROWSE`) | `name, agent_service_type, comment, created_by, config.{source_connection,base_path,system_prompt}`. **`owner`/`full_name` return null** | [Doc] ai-gateway/agent-services. Not in the public API reference |
| Knowledge Assistants | `GET /api/2.1/knowledge-assistants`, `/{id}`, `/{id}/knowledge-sources`, `/{id}/examples` | **Beta API / Legacy product** (Oct 12 2026) | workspace ACL `knowledge-assistants` | `name, display_name, description, instructions, creator, create_time, endpoint_name, experiment_id, state`; sources `source_type, index.index_name, files.path, file_table.table_name` | [Doc]; [Live→04] |
| Supervisor Agents | `GET /api/2.1/supervisor-agents`, `/{id}`, `/{id}/tools`, `/{id}/examples` | **Beta API / Legacy product** | ACL `supervisor-agents` | `supervisor_agent_id, display_name, creator, endpoint_name, experiment_id`; tools `tool_type ∈ {genie_space, knowledge_assistant, uc_function, uc_connection, uc_mcp, app, volume, dashboard, serving_endpoint, table, vector_search_index, catalog, schema, supervisor_agent, databricks_web_search, skill}` | [Doc]; [Live→04] |
| All Agent Bricks tiles | `GET /api/2.0/tiles`, `/api/2.0/tiles/{id}` | **Undocumented** | — | tile type (MAS/KA/KIE/AI_EXTRACT/T2T) | [Live→04] only. Do not depend on it long-term |
| Agent Runtime agents | `GET /api/2.0/apps` and filter `name LIKE 'agent-bricks-%'` | Agent Bricks CLI **Beta** (Sep 29 2026) | app `CAN_VIEW`+ | `name, url, creator, service_principal_client_id, resources[] (experiment, uc_securable, serving_endpoint, genie_space, …), user_api_scopes, active_deployment` | [Doc] agent-runtime + apps API |
| Genie Agents | `GET /api/2.0/genie/spaces`, `GET /api/2.0/genie/spaces/{id}?include_serialized_space=true` | GA (renamed Jul 8 2026) | Genie ACL (`/api/2.0/permissions/genie/{id}`) | `space_id, title, description, warehouse_id, parent_path`; `serialized_space.data_sources.{tables,metric_views}`, `instructions.sql_functions` | [Doc] |
| Skills | `GET /api/2.1/unity-catalog/skills?parent=schemas/c.s` (parent required), `GET .../skills/{c.s.n}`; contents via Files API `/api/2.0/fs/files/Skills/{c}/{s}/{n}/SKILL.md` | **Beta** (API Oct 12 2026; feature Aug 28 2026) | list/get: `READ VOLUME`/`READ METADATA`/`MANAGE` | `name, bundle_name, description, comment, created_by, effective_owner, create_time, update_time, finalize_time, etag` | [Doc] skill-reference |
| Model services | `GET /api/2.1/unity-catalog/model-services[?parent]` | GA | `EXECUTE`/`READ METADATA`/`MANAGE` | `config.routing.destinations[]/fallback`, `rate_limits[]`, `inference_table`, `effective_owner` | [Doc] |
| Service policies (guardrails) | Attach: **UI only**. Read: unified trace table `events` (`policy_evaluated`) and span attrs `databricks.policy.*` | **Beta** (workspace preview "Unity Ai Gateway Service Policies") | `MANAGE` on service to attach; `EXECUTE` on policy UDF | `policy.name/type/handler/action/phase/dry_run_*` | [Doc]. `PolicyInfo` API has no service-policy type |
| GRANT/DENY ABAC on AI assets | `/api/2.1/unity-catalog/policies/{on_securable_type}/{fullname}` (`POLICY_TYPE_GRANT`/`DENY`; securable types incl. `MCP_SERVICE`, `MODEL_SERVICE`, `AGENT_SERVICE`, `SKILL`) | GRANT on gateway types **Beta** (Aug 11 2026) | `MANAGE` | `name, to_principals, when_condition, policy_type` | [Doc] |
| Legacy endpoint guardrails | `PUT /api/2.0/serving-endpoints/{name}/ai-gateway` | Legacy (guardrails were Public Preview) | `CAN_MANAGE` | `usage_tracking_config, inference_table_config, rate_limits, guardrails.{input,output}.{safety,pii.behavior,valid_topics,invalid_keywords}, fallback_config` | [Doc] |
| Request usage | `system.ai_gateway.usage` | **Public Preview**, 365 d | account **and** metastore admin by default, or `SELECT` grant | see Q3 | [Doc] |
| External model $ | `system.ai_gateway.external_model_spend` | **Beta**, hourly | system-table grant | `usage_quantity` (USD), `usage_metadata.*`, `custom_tags.{endpoint_tags,request_tags}`, `identity_metadata.run_by` | [Doc] |
| Billing | `system.billing.usage` + `system.billing.list_prices` | GA | system-table grant | `billing_origin_product`, `usage_metadata.{ai_gateway.*, endpoint_name, app_id, app_name, agent_bricks_id}`, `identity_metadata.{run_as, created_by}`, `custom_tags` | [Doc] |
| Legacy serving usage | `system.serving.endpoint_usage`, `system.serving.served_entities` | Public Preview (90 d / 365 d) | system-table grant | `requester, token counts, usage_context, served_entity_id` → `endpoint_name, entity_type, task` | [Doc] |
| Unified trace table | admin-chosen `<c>.<s>.unity_gateway_otel_spans`-style table | **Beta** (Aug 21 2026; account preview "Enhanced Unity Gateway") | `SELECT` (default: creating metastore admin only) | OTel span cols + `attributes:` keys (`gen_ai.tool.name`, `enduser.id`, `databricks.policy.*`) | [Doc] |
| MLflow traces in UC | `<c>.<s>.<prefix>_otel_spans/_otel_annotations/_otel_logs/_otel_metrics` + views `<prefix>_trace_unified`, `<prefix>_trace_metadata` | **GA** (Jul 16 2026) | `USE CATALOG/SCHEMA` + explicit `SELECT` (and `MODIFY` to write). `ALL PRIVILEGES` is **not** enough | `trace_id, client_request_id, request_time, state, execution_duration_ms, request, response, tags, trace_metadata, spans, assessments` | [Doc] |
| Production scorers | Python `mlflow.genai.scorers` (`register/start/update/stop`, `list_scorers`, `delete_scorer`) | **Beta** | `CAN EDIT` on experiment | sample_rate, filter_string. Results land as assessments | [Doc]. No REST documented |
| Lineage | `system.access.table_lineage`, `column_lineage`; external lineage `/api/2.0/lineage-tracking/external-lineage`, `/external-metadata` | Tables GA; external lineage **GA (Jun 8 2026)** (API ref fields still say PP) | `CREATE EXTERNAL METADATA` on metastore; `MODIFY` on the node | see Q8 | [Doc] |
| UC models | `/api/2.1/unity-catalog/models[/{full_name}/versions[/{v}]|/aliases/{a}]` | GA | `EXECUTE`/`READ METADATA`/owner | `model_version_dependencies.dependencies[].{table,function,connection,credential}`, `run_id`, `aliases[]`, `created_by/at` | [Doc] |
| UC grants | `GET/PATCH /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}`; `GET .../effective-permissions/...` | GA | owner/`MANAGE` to change | `privilege_assignments[].{principal, privileges}` | [Doc] |
| Workspace ACLs | `GET/PATCH/PUT /api/2.0/permissions/{type}/{id}` (types incl. `serving-endpoints`, `genie`, `knowledge-assistants`, `supervisor-agents`, `experiments`, `registered-models`) | GA | `CAN_MANAGE` to change | `access_control_list[]` | [Doc]; endpoint ACL keyed by **id** [Live→04] |
| RFA | `POST /api/3.0/rfa/requests`; `GET /api/3.0/rfa/destinations/{securable_type}/{full_name}`; `PATCH /api/3.0/rfa/destinations` | **Public Preview** (metastore-level RFA Jun 22 2026) | any user can create; owner/`MANAGE`/metastore admin for destinations | `requests[].{behalf_of, comment≤200, securable_permissions[].{securable,permissions}}` | [Doc] |
| Budgets | `GET/POST /api/2.1/accounts/{account_id}/budgets`, `GET/PUT/DELETE .../budgets/{budget_id}` | GA; `BLOCK_USAGE` **Beta**; external spend in budgets **Beta** (Aug 28 2026); budget ACLs Oct 16 2026 | account admin (or Budget Manager/Viewer role) | `resource_type`, `filter.{workspace_id,tags}`, `alert_configurations[].{quantity_threshold, scope_type, action_configurations, principal_overrides}` | [Doc] |
| Audit | `system.access.audit` | Public Preview | system-table grant | see Q3 | [Doc] / [Internal] |

---

## Q1. Agent Bricks (current state)

**Product reality (Oct 2026)** [Doc, agents/concepts, agents/legacy, release notes]
- **Agent Bricks** is now the *code-first* agent platform. You build with the Agent Bricks CLI (`agentbricks`, Beta Sep 29 2026) and an `agent.toml`, serve with `DurableAgentServer`, and run on **Agent Runtime**. Agent Runtime is a Databricks App named **`agent-bricks-<name>`**, with the app SP as agent identity and tracing wired to a bound MLflow experiment. Clients call `POST /api/invocations`, `GET /api/invocations/{id}` and `GET /api/invocations/{id}/events?after=` on the app URL using an **OAuth token** (no PATs). Agents built on the legacy MLflow `AgentServer` serve `/responses`. Send `x-mlflow-return-trace-id: true` to get `metadata.trace_id`.
- **Genie Agents** (formerly Genie Spaces) are the *no-code* agent path. MCP connectors on Genie Agents are Beta (workspace preview "MCP tools in Genie Agents").
- **Legacy (Oct 12 2026):** Knowledge Assistant, Supervisor Agent, Supervisor API (deprecated), Custom LLM, custom agents on Model Serving, the legacy MLflow `AgentServer`/`LongRunningAgentServer`, AI Playground agent prototyping, and legacy memory stores.
- Information Extraction (`key-info-extraction` page) is **Beta**. Document intelligence (`ai_parse_document`, `ai_extract`, `ai_classify`) is GA per the DAIS blog.
- **Omnigent** meta-harness: Beta (Jun 17 2026). Managed Omnigent: Beta.

**APIs**
| Object | Endpoints | Key fields | Status |
|---|---|---|---|
| Knowledge Assistant | `GET/POST /api/2.1/knowledge-assistants`; `GET/PATCH/DELETE /api/2.1/knowledge-assistants/{id}`; `.../knowledge-sources[/{id}]`, `.../knowledge-sources:sync`, `.../examples` | `name="knowledge-assistants/{id}"`, `display_name`, `description`, `instructions`, `creator`, `create_time`, **`endpoint_name`**, **`experiment_id`**, `state` (CREATING/ACTIVE/FAILED), `error_info` | Beta [Doc]. v2.1 list works live [Live→04] |
| Supervisor Agent | `GET/POST /api/2.1/supervisor-agents`; `/{id}`; `/{id}/tools[/{tool_id}]`; `/{id}/examples` | `supervisor_agent_id`, `display_name`, `creator`, **`endpoint_name`**, **`experiment_id`**; tool `tool_type` plus typed sub-objects (`genie_space.id`, `knowledge_assistant.knowledge_assistant_id`, `uc_function.name`, `app.name`, `volume.name`, `uc_connection.name`) | Beta [Doc] |
| Tiles (all bricks) | `GET /api/2.0/tiles`, `/api/2.0/tiles/{id}`; v2.0 `knowledge-assistants/{tile_id}` and `multi-agent-supervisors/{tile_id}` GETs only | see 04 | **Not in the public API reference** [Live→04] |
| Genie Agents | `GET /api/2.0/genie/spaces`, `GET /api/2.0/genie/spaces/{id}`; agent mode `POST /api/2.0/genie/agents/{agent_id}/conversations/{cid}/responses` | `space_id, title, description, warehouse_id, parent_path, serialized_space, etag, create_time, update_time` | GA [Doc]. `/api/2.0/genie/agents` list returned 404 live [Live→04] |
| Agent Runtime | `GET /api/2.0/apps` (`agent-bricks-*`) | `App.resources[]`, `service_principal_client_id`, `creator`, `url`, `compute_status`, `app_status` | [Doc] |

**Serving `task` type.** `ServingEndpoint.task` is a free string (e.g. `llm/v1/chat`). The only agent-specific task value in current docs is **`agent/v1/responses`**, which the (legacy) multi-agent page requires for KA endpoints [Doc]. `system.serving.served_entities.task` documents only `llm/v1/chat|completions|embeddings`. **Recommended agent marker:** classify by origin (KA/Supervisor `endpoint_name`, tile list, `agent-bricks-*` apps) rather than by task string. Real `task` values seen on the 208 live endpoints are in 04 [Live→04].

**Billing linkage:** `billing_origin_product IN ('AGENT_BRICKS','SUPERVISOR_AGENT')`, `usage_metadata.agent_bricks_id`, and `identity_metadata.created_by` for KA/Supervisor. Agent Runtime agents bill as **`APPS`** (`usage_metadata.app_id/app_name`) plus whatever their model and tool calls cost [Doc].

Audit service names: `knowledgeAssistant`, `supervisorAgent`, `aibiGenie`, `apps` [Doc].

## Q2. Unity Gateway (successor to Mosaic AI Gateway)

**What it governs** [Doc, unity-gateway/concepts, ai-gateway index]: model services, model provider services (BYOK external providers), MCP services (registered, Databricks-provided, custom-on-Apps via direct URL only), skills, and agents. Agents are governed "as a UC model, with their tools governed as MCP services, functions and connections" (ai-gateway index page). Agent services remain the Beta registry for external agents.

- **Privileges** (model/provider/MCP services): `EXECUTE` (call), `CREATE SERVICE` (on schema), `READ METADATA`, `MANAGE`, plus `USE CATALOG/SCHEMA`. End users **don't need `USE CONNECTION`**. Reserve that for MCP authors, because it permits direct connection use outside the MCP's tool selection and policies [Doc].
- **Agent services privileges:** `EXECUTE`, `READ METADATA`, `MANAGE`, `ALL PRIVILEGES`. There's no `BROWSE` [Doc].
- **Registry or catalog UI:** the DAIS blog says Unity AI Gateway offers a "catalog of all agents, models, MCPs, Skills, and external agents" [Doc, blog]. Unity Gateway → **MCPs** page. **UC Global Search does not surface MCPs or agent services** [Doc]. That gap is part of why the hub exists.

**Agent services detail** [Doc, ai-gateway/agent-services, Beta]
```bash
POST /api/2.1/unity-catalog/agent-services?parent=schemas/main.default&agent_service_id=support_agent
{"agent_service_type":"AGENT_SERVICE_TYPE_EXTERNAL","comment":"…",
 "config":{"source_connection":{"name":"connections/main.default.my_agent_connection"},
           "base_path":"/v1/chat","system_prompt":"…"}}
```
- Updatable fields: `comment`, `config.system_prompt`, `config.base_path`.
- Grants: `PATCH /api/2.1/unity-catalog/permissions/AGENT_SERVICE/{c.s.n}`.
- Limitations: no invocation, no policies or rate limits, no SQL DDL, `full_name`/`owner` null, no Global Search, no `BROWSE`.
- **[Internal]** Epic SASP-8308 ("Agents as UC Securables" PRD) says AGENT_SERVICE is a peer of MODEL_SERVICE/MCP_SERVICE. Enum slots `AGENT_SERVICE_TYPE_INTERNAL / _GENIE / _APP` are reserved. The planned Walk scope has an invocation proxy via the gateway, definer's rights, payload logging and `ON CALL` policy edges. Reserved future fields: `guardrail_ref, memory_config, tool_bindings, version, runtime_ref`. **The hub's data model should anticipate these**, but the hub should not build on them yet.

**MCP service lifecycle** [Doc, mcp-service-reference] — `POST /api/2.1/unity-catalog/mcp-services?parent=schemas/c.s&mcp_service_id=n` with body `{comment, config:{source_connection:{name:"connections/c.s.conn"}, include_tool_selectors?, rate_limits?}}`. Use `PATCH ...?update_mask=comment|config.source_connection.name|config.include_tool_selectors|config.rate_limits` (optional `etag`), and `DELETE`. Unselected tools don't appear in `tools/list`, and calling them returns `Tool not allowed by MCP service configuration.` CLI: `databricks ai-gateway {create,list,get,update,delete}-mcp-service`. SDK: `w.ai_gateway.*`. Terraform: `databricks_ai_gateway_mcp_service`. Bundles: `resources.mcp_services` (Beta, CLI ≥1.17). Registering Genie, Apps or UC entity sources as your own MCP is **not supported**.

**Rate limits** (MCP and model services): `rate_limits[].{key ∈ RATE_LIMIT_KEY_USER|USER_GROUP|SERVICE_PRINCIPAL|SERVICE|USER_DEFAULT, renewal_period ∈ MINUTE|HOUR, principal, requests, tokens}`. A value of 0 means deny-all. MCP limits apply to `tools/call`, and callers get HTTP 429 [Doc].

**Fallbacks/traffic split:** `ModelService.config.routing.destinations[]` and `fallback.destinations[]`, with `destination_type ∈ PAY_PER_TOKEN | PROVISIONED_THROUGHPUT | EXTERNAL_FOUNDATION_MODEL` [Doc].

**Service policies (guardrails)** [Doc, Beta. Workspace preview "Unity Ai Gateway Service Policies", or account preview "Enhanced Unity Gateway" outside CSP]
- Decisions: `ALLOW`, `DENY` (HTTP 200 with a `databricks_service_policy` object carrying `reason`), and `ASK`. ASK applies **only on MCP services, input phase**, via MCP URL-mode elicitation, and needs MCP protocol `2025-11-25`+. On model services, ASK becomes a block.
- Phases: input (`ON CALL`) and output (`ON RESULT`). Rank order is ascending on input and reversed on output. Within a rank, blocking LLM judges run in parallel first, then the rest run sequentially. **Fail-closed.** **Log mode** (dry-run) records `policy.dry_run_action` instead of enforcing.
- Built-ins (`system.ai.*`, not browsable as functions): `block_unsafe_content`, `block_jailbreak` (input on models; input/output on MCP since Oct 21 2026), `block_hallucination` (output), and `detect_sensitive_data` (deterministic; block or redact; classification tags like `class.us_ssn` and `class.credit_card`). Evaluator model is selectable, and evaluations are billed as calls to it.
- Custom: SQL UDF `fn(event VARIANT) RETURNS VARIANT` → `{result, reason}`. `LANGUAGE SQL` only, with a restricted SQL subset. `event` keys: `type` (`request`/`response`), `target`, `context.request_tags`, `context.actor.run_as`, `context.actor.context.{is_on_behalf_of, client_id, actor_resource, is_actor_authenticated}`, `context.tool.{name,arguments}`, `context.message`, `data`, `request_data`. LLM-as-judge custom policies (natural-language criteria; OpenJev evaluator option, Oct 9 2026) and **external vendor policies** via a UC HTTP connection (M2M OAuth only, ALLOW/DENY only, fail-closed, Oct 7 2026) are also available.
- Supported targets: MCP, model and model provider services. **Not agent services.** Not passthrough paths on provider services.
- **API exposure: attachment is UI-only, per service, applies to all account users. No catalog/schema-level attach and no ABAC conditions** [Doc]. `PolicyInfo` (`/api/2.1/unity-catalog/policies`) only has `ROW_FILTER/COLUMN_MASK/DENY/GRANT` types. → **The hub cannot read the policy configuration through a public API.** It can only (a) observe enforcement in the unified trace table, or (b) let admins record the policy inventory in the hub. [Unverified] whether an internal/undocumented attachment API exists. Check doc 04 if it was probed.

**Legacy (per serving endpoint) config:** `PUT /api/2.0/serving-endpoints/{name}/ai-gateway` with body `{usage_tracking_config:{enabled}, inference_table_config:{catalog_name,schema_name,table_name_prefix,enabled}, rate_limits:[{calls,key,renewal_period,principal,tokens}], guardrails:{input|output:{safety, pii:{behavior: NONE|BLOCK|MASK}, valid_topics[], invalid_keywords[]}}, fallback_config:{enabled}}`. The response also appears on `GET /api/2.0/serving-endpoints/{name}` → `ai_gateway`. Audit action: `putInferenceEndpointAiGateway` under `serverlessRealTimeInference` [Doc]. The **"Enforce Unity Gateway"** workspace setting disables legacy experiences [Doc].

**Inference tables vs unified trace table:** inference tables are per service. The unified trace table is one metastore-wide OTel table, owned by the metastore admin who creates it, with ABAC row filters recommended [Doc].

## Q3. System tables for usage and cost

### `system.ai_gateway.usage` (Public Preview, streaming, 365 d, regional) [Doc]
Columns: `account_id, workspace_id, request_id, invocation_id, schema_version INT, service_type, service_id, service_name (UC FQN), service_tags MAP, endpoint_id, endpoint_name, endpoint_tags MAP, endpoint_metadata STRUCT{creator, creation_time, last_updated_time, destinations, inference_table, fallbacks}, event_time TIMESTAMP, latency_ms LONG, time_to_first_byte_ms LONG, destination_type, destination_name, destination_id, destination_model, requester, requester_type, ip_address, url, user_agent, api_type, request_tags MAP, invocation_metadata STRUCT{source ∈ AI_PLAYGROUND|EXTERNAL_CLIENT|AI_QUERY|GUARDRAIL|MANAGED_AGENT, service_tier, relayed}, input_tokens, output_tokens, total_tokens LONG, token_details STRUCT{cache_read_input_tokens, cache_creation_input_tokens, output_reasoning_tokens, cache_creation_5m_input_tokens, cache_creation_1h_input_tokens, file_search_count, num_web_search_queries}, response_content_type, status_code INT, routing_information STRUCT{attempts[]}, mcp_metadata STRUCT{tool_name, server_type ∈ EXTERNAL|SYSTEM, json_rpc_method}, session_metadata STRUCT{client_session_id, client_subagent_id, coding_agent, agent_version, surface, reasoning_effort, smart_router_name}, auth_mode ∈ PAT|OAUTH`.
- Access: **account admin + metastore admin** by default. Records arrive in about 1 h. Usage tracking is a **billed** feature. `session_metadata` and new `token_details` were added Sep 27 2026.
- Request tags come from the header `Databricks-Ai-Gateway-Request-Tags: {"k":"v"}`. **The hub should mandate `agent_id`/`project` request tags for registered agents.** These tags are also visible to custom policies.

### `system.ai_gateway.external_model_spend` (Beta, hourly, 365 d) [Doc]
`record_id, account_id, workspace_id, usage_date DATE, usage_start_time, usage_end_time TIMESTAMP, ingestion_date DATE, usage_metadata STRUCT{provider, model, endpoint_id, endpoint_name, destination_id, destination_name}, custom_tags STRUCT{endpoint_tags, request_tags}, usage_unit='USD', usage_quantity DECIMAL, pricing_metadata STRUCT{service_tier, long_context}, identity_metadata STRUCT{run_by, run_as}`. Estimates use list prices × the optional per-provider **price multiplier** (Sep 19 2026). There is no spend for the "Custom" provider.

### `system.billing.usage` (GA, 365 d, global) [Doc]
Columns: `record_id, account_id, workspace_id, sku_name, cloud, usage_start_time, usage_end_time, usage_date, custom_tags MAP, usage_unit, usage_quantity DECIMAL, usage_metadata STRUCT, identity_metadata STRUCT{run_as, owned_by, created_by}, record_type ∈ ORIGINAL|RETRACTION|RESTATEMENT, ingestion_date, billing_origin_product, product_features STRUCT, usage_type ∈ COMPUTE_TIME|STORAGE_SPACE|NETWORK_BYTE|NETWORK_HOUR|API_OPERATION|TOKEN|GPU_TIME|ANSWER`.
- Relevant `usage_metadata` fields: `endpoint_name, endpoint_id, app_id, app_name, agent_bricks_id, warehouse_id, job_id, notebook_id, usage_policy_id, database_instance_id`. Also **`ai_gateway.{endpoint_name (UC FQN), endpoint_id, destination_model, destination_id}`** on `MODEL_SERVING` rows. Note: the `ai_gateway.*` sub-struct is documented on the *cost-observability* page but **missing from the billing reference page**. Probe `DESCRIBE system.billing.usage` (04) [Doc, discrepancy].
- `billing_origin_product` values used here: `MODEL_SERVING, AI_GATEWAY, AGENT_BRICKS, SUPERVISOR_AGENT, GENIE, AGENT_EVALUATION, APPS, AI_FUNCTIONS, VECTOR_SEARCH, SQL, LAKEBASE, NETWORKING`.
- `product_features`: `serving_type, offering_type, model_serving.offering_type, ai_gateway.feature_type, agent_bricks.{problem_type, workload_type}, ai_functions.ai_function`.
- `identity_metadata.run_by` is used for gateway requests (cost-observability page). The billing reference describes `run_as`/`created_by` [Doc].

### `system.billing.list_prices` (GA, indefinite)
`price_start_time, price_end_time, account_id, sku_name, cloud, currency_code, usage_unit, pricing STRUCT{default, …}` [Doc].

### `system.serving.endpoint_usage` / `served_entities` (Public Preview; legacy per-endpoint usage tracking)
- `endpoint_usage`: `account_id, workspace_id, client_request_id, databricks_request_id, requester, status_code, request_time, input_token_count, output_token_count, input_character_count, output_character_count, usage_context MAP, request_streaming, served_entity_id`.
- `served_entities`: `served_entity_id, account_id, workspace_id, created_by, endpoint_name, endpoint_id, served_entity_name, entity_type ∈ FEATURE_SPEC|EXTERNAL_MODEL|FOUNDATION_MODEL|CUSTOM_MODEL, entity_name, entity_version, endpoint_config_version, task, external_model_config, foundation_model_config, custom_model_config, feature_spec_config, change_time, endpoint_delete_time` [Doc].

### `system.mlflow.*` (Public Preview, 180 d)
`experiments_latest`, `runs_latest` (incl. `params`, `tags`, `aggregated_metrics`) and `run_metrics_history`. **There is no traces system table.** Traces live in UC trace locations (Q7) [Doc].

### Other tables
`system.access.assistant_events` (Genie Code), `system.query.history` (`query_source.genie_space_id`, `executed_by`, `executed_as`, **`query_tags`**, GA Sep 30 2026), `system.access.table_lineage/column_lineage`, `system.tags.governed_tags` (Beta), `system.access.outbound_network` [Doc].

### `system.access.audit` service names [Doc unless marked]
| Area | `service_name` | Actions |
|---|---|---|
| Unity Gateway MCP calls | **`mcpService`** with action **`mcpCall`** | **[Internal]** BR-2178 / AIGOV-647 (queried live on dogfood). Docs say "`mcpCall` in `system.access.audit`", but the public audit reference omits it |
| Legacy managed MCP endpoints | `managedMcp` | `mcpRequest` (`server_type` ∈ DBSQL/UC_FUNCTIONS/AI_SEARCH/GENIE, `mcp_method`, `tool_name`, …) |
| UC HTTP connection proxy | `ucHttpConnection` | `ucHttpConnectionProxiedRequest` (`connection_name`, `http_method`, `auth_type`) |
| Model serving | `serverlessRealTimeInference` | `createServingEndpoint`, `updateServingEndpoint`, `putInferenceEndpointAiGateway`, `changeInferenceEndpointAcl`, … |
| Apps | `apps` | `createApp`, `deployApp`, `changeAppsAcl`, … |
| UC (account-level, `workspace_id='0'`) | `unityCatalog` | `updatePermissions`, `createConnection`, `createFunction`, `createRegisteredModel`, `setRegisteredModelAlias`, lineage reads… MCP-service/skill/agent-service CRUD action names are **[Unverified]** (not in the reference; skills docs say CRUD and permission changes are audited) |
| RFA | `request-for-access` | `batchCreateAccessRequests`, `requestAccess`, `updateAccessRequestDestinations`, … |
| KA / Supervisor / Genie | `knowledgeAssistant` / `supervisorAgent` / `aibiGenie` | CRUD, tools, examples |

## Q4. MCP on Databricks

| Kind | URL | Governed by UC/Gateway? | Auth scope | Notes |
|---|---|---|---|---|
| Databricks-provided (`system.ai.*`) | `https://<ws>/ai-gateway/mcp-services/system.ai.<name>` | Yes (grants, policies, usage, traces) | `ai-gateway` | `genie_one_mcp` (GA), `dbsql`/`web_search`/`sandbox` (Unity Gateway Beta), external: `slack, github, atlassian, google_drive, google_calendar, gmail, microsoft_365` (managed OAuth, per-user sign-in). Managed connectors migrated to the gateway Aug 6 2026 (Beta) [Doc] |
| Registered external | `https://<ws>/ai-gateway/mcp-services/<c>.<s>.<n>` | Yes | `ai-gateway` | Streamable HTTP only. Backed by a UC **HTTP connection** (`connection_type: HTTP`, `options.{host, port, base_path, bearer_token | OAuth fields}`; schema-level `parent:"schemas/c.s"` preferred) [Doc] |
| Marketplace MCP | as registered | Yes | `ai-gateway` | Install creates the MCP service plus `<name>_connection` [Doc] |
| Custom on Databricks Apps | `https://<app-url>/mcp` (app name prefix `mcp-`) | **No** gateway registration possible; app ACL `CAN USE` only | app user-auth scopes. OAuth only (no PAT) | Templates: MCP Server (Starter), MCP Server (OpenAPI) [Doc] |
| Legacy workspace endpoints | `/api/2.0/mcp/functions/{c}/{s}/{fn}` (scope `unity-catalog`), `/api/2.0/mcp/ai-search/{c}/{s}/{index}` (`ai-search`), `/api/2.0/mcp/sql` (`sql`), `/api/2.0/mcp/genie/{space_id}` (`genie`) | **No.** They bypass the gateway (no traces, grants or policies) | as listed | Need workspace preview "Managed MCP Servers" [Doc] |

- **Is there an `is_mcp_connection` option?** [Unverified/Not found] Current docs identify MCP-ness via the **McpService** object, not a connection option. Enumerate MCP services, then join `config.source_connection.name` to the connections list. Connections not referenced by any MCP service are "raw HTTP connections".
- **Metadata available:** from the McpService you get owner, creator/updater, timestamps, comment, connection, selectors and rate limits. From the connection you get host and base_path. From `tools/list` you get tool names, descriptions, schemas and annotations, **as seen by the calling principal after tool selection**. Server-level `serverInfo` comes from `initialize` [Doc / MCP spec]. Per-user OAuth status comes from `.../user-credentials` (Beta).
- The UC proxy for non-MCP REST also exists: `/api/2.0/unity-catalog/connections/{name}/proxy/...` [Doc, rest-api-proxy].
- Network: gateway calls to external MCPs use **serverless egress**, so the FQDN must be allow-listed under restricted network policy. Check `system.access.outbound_network` [Doc].

## Q5. Skills

There are three distinct concepts [Doc]:
1. **UC Skills / "Unity Gateway Skills"** (Beta, Aug 28 2026; REST/SDK Beta Oct 12 2026; account preview). A securable `catalog.schema.skill` in agentskills.io `SKILL.md` format, with content stored in UC-managed storage at `/Skills/{c}/{s}/{n}/`.
   - API: `POST /api/2.1/unity-catalog/skills?parent=schemas/c.s&skill_id=n` → upload via Files API (`PUT /api/2.0/fs/files/Skills/c/s/n/SKILL.md`) → `POST /api/2.1/unity-catalog/skills/{c.s.n}/finalize` (parses frontmatter into `bundle_name`/`description`). Also `GET` (list needs `parent`), `PATCH ?update_mask=comment`, `DELETE`.
   - **Privileges:** `CREATE VOLUME` (schema, create), `WRITE VOLUME` + `READ VOLUME` (update contents), `READ VOLUME` (consume/share), `READ METADATA`, `MANAGE` (change grants), `APPLY TAG`. Owner = creator. Grants: `PATCH /api/2.1/unity-catalog/permissions/skill/{c.s.n}`. ABAC GRANT policies for skills: Beta.
   - Not available: Terraform/bundles. Create/update/delete are blocked under the compliance security profile, but read still works.
   - Consumption: `ug skills add`, or the **`databricks-skill-registry` MCP server** (`list_skills`, `load_skill`, `get_skill_files`), set up by the Unity Gateway CLI. Its URL isn't documented [Unverified].
2. **Genie Code skills.** Workspace files at `Workspace/.assistant/skills/<skill>/SKILL.md` and `/Users/{user}/.assistant/skills/`. There is no dedicated API. Discover them via the Workspace API (`/api/2.0/workspace/list`) [Doc for paths; Inferred for API]. Genie One user skills have audit actions `listGenieChatUserSkills` etc.
3. **Agent skills for coding assistants.** Installed locally (`databricks aitools install`). Not a platform object.

Supervisor tools also accept `tool_type: "skill"` [Doc].

## Q6. Permissions and access requests

- **UC grants:** `GET/PATCH /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}`; body `{"changes":[{"principal":"…","add":[…],"remove":[…]}]}`. Also `GET /api/2.1/unity-catalog/effective-permissions/{type}/{name}` and `GET .../privilege-assignments/...` [Doc].
  - Securable types seen in docs: `function`, `connection`, `registered_model` (`MODEL`), `mcp_service`, `model_service`, `model_provider_service`, `skill`, `AGENT_SERVICE`.
  - Privileges: FUNCTION `EXECUTE`; CONNECTION `USE CONNECTION`/`CREATE FOREIGN …`; MODEL `EXECUTE`/`APPLY TAG`/`MANAGE`; services `EXECUTE`/`READ METADATA`/`MANAGE`; schema `CREATE SERVICE`.
- **Ownership fields:** services and skills use `effective_owner` + `created_by`/`updated_by`. Agent services have `owner: null` in Beta, so record the owner in the hub. KA/Supervisor use `creator`. Apps use `creator` + `service_principal_*`. Serving endpoints use `creator`. Genie has no owner field in list (use the ACL). UC models/functions/connections use `owner` [Doc].
- **Workspace ACLs:** `GET/PATCH/PUT /api/2.0/permissions/{request_object_type}/{id}`. Types: `serving-endpoints` (CAN_VIEW/CAN_QUERY/CAN_MANAGE, keyed by endpoint **id** [Live→04]), `genie`, `knowledge-assistants`, `supervisor-agents`, `experiments`, `registered-models`, `warehouses`, `jobs`… [Doc]. **`apps` is not in the documented list.** The app permissions page/API was not verified here [Unverified]. See 04.
- **RFA** (Public Preview) [Doc]:
  - `POST /api/3.0/rfa/requests` → `{"requests":[{"behalf_of":{"id":"…","principal_type":"USER_PRINCIPAL|GROUP_PRINCIPAL|SERVICE_PRINCIPAL"},"comment":"≤200 chars","securable_permissions":[{"securable":{"type":"FUNCTION","full_name":"c.s.f"},"permissions":["EXECUTE"]}]}]}`. Limits: ≤30 requests and ≤30 securables per principal. The response returns resolved `request_destinations[]` (`destination_type` EMAIL/SLACK/…, `destination_source_securable`, `are_any_destinations_hidden`).
  - **Documented supported types:** metastore, catalog, schema, table, external_location, connection, credential, function, registered_model, volume. The enum also lists `MCP_SERVICE/MODEL_SERVICE/SKILL/AGENT_SERVICE`, but support for those is **not documented**. Treat it as unsupported until tested.
  - `GET /api/3.0/rfa/destinations/{securable_type}/{full_name}` and `PATCH /api/3.0/rfa/destinations` (`{destinations:[{destination_id, destination_type}], securable:{type, full_name}}`).
  - Webhook payload: `requesterName, objectName, objectType, privileges, principalName, onBehalfOf, onBehalfOfType, comment, databricksWorkspaceUrl`. Requests expire after 7 d. Approvals happen in Catalog Explorer → Requests. **There is no API to list, approve or decline requests.**
- **Can the app create/route requests?** It can **create** them (for supported types) and set destinations, for example a webhook back to the hub. It **cannot** read status or approve via API. → The hub keeps its own request record. On approval it calls `PATCH /permissions/...` (UC) or `/api/2.0/permissions/...` (workspace ACL) as a principal holding `MANAGE`/`CAN_MANAGE`. RFA destination webhook → hub is a viable intake for supported types [Inferred].

## Q7. Traces and evals for Databricks-built agents

- **MLflow traces in UC (GA Jul 16 2026)** [Doc]. You bind an experiment to `UnityCatalog(catalog, schema, table_prefix)`, which is immutable once bound. Tables: `<prefix>_otel_spans`, `_otel_annotations` (`annotation_type` METADATA/TAG/FEEDBACK/EXPECTATION/RUN_LINK; append-only with soft deletes, so dedupe on `annotation_id` + latest `updated_at` and drop `deleted_at`), `_otel_logs`, `_otel_metrics`. Views: `<prefix>_trace_unified` (`trace_id, client_request_id, request_time, state, execution_duration_ms, request, response, trace_metadata VARIANT, tags MAP, spans LIST, assessments LIST`) and `<prefix>_trace_metadata`. **Query the views, not the OTel tables.** Readers need explicit `SELECT` (`ALL PRIVILEGES` isn't enough). OTLP ingest is `POST /api/2.0/otel/v1/traces` with header `X-Databricks-UC-Table-Name`.
- **Search:** `mlflow.search_traces(locations=[exp_id | "c.s"], filter_string=…, sql_warehouse_id=…)`. Filters include `trace.status`, `trace.timestamp_ms`, `trace.execution_time_ms`, `trace.client_request_id`, `trace.request/response LIKE`, `trace.token_count`, `span.attributes.*` and `` metadata.`mlflow.trace.user` ``. There's no `OR`.
- **REST:** the public API reference documents **no** MLflow v3 trace REST (`/api/3.0/mlflow/traces/search` is [Unverified]). For the hub, **SQL against the views via a warehouse** is the stable path [Doc].
- **Endpoint/agent → experiment → traces:**
  - KA/Supervisor: `experiment_id` field [Doc].
  - Agent Runtime: `App.resources[].experiment.experiment_id` (declared app resource) [Doc; Inferred that Agent Bricks CLI declares it].
  - Serving-endpoint agents: env var `MLFLOW_EXPERIMENT_ID` (redacted in 04 samples) [Doc].
  - Experiment → UC location: the Python SDK exposes `experiment.trace_location.full_otel_spans_table_name`. The REST `Experiment` object documents only `tags`, so the trace location is likely an experiment tag [Inferred/Unverified]. Read it with the SDK in the collector.
- **Evals/scorers (Beta):** `Scorer.register(name)` → `.start(sampling_config=ScorerSamplingConfig(sample_rate, filter_string))` → `.update/.stop`, `list_scorers()`, `get_scorer()`, `delete_scorer()`, `backfill_scorer()`. There are ≤20 scorers per experiment. UC-trace monitoring needs the experiment tag `mlflow.monitoring.sqlWarehouseId`. The job runs as the user who first registered a scorer. Results are written as **assessments** on traces, so the hub reads them from `assessments`/`_otel_annotations`. Eval cost: `billing_origin_product='AGENT_EVALUATION'` [Doc].
- **Genie Agent benchmarks:** `POST/GET /api/2.0/genie/spaces/{id}/eval-runs[/{run}/results]` [Doc].
- **Gateway-side traces:** the unified trace table (Beta) covers model and MCP hops. Shared multi-hop trace IDs are "coming soon". Gateway trace linking (W3C `traceparent`) and client-span ingestion (`/ai-gateway/otel/v1/traces`, protobuf only) are per-workspace Beta via the account team [Doc].

## Q8. Lineage

- **System tables** [Doc]: `system.access.table_lineage` (`entity_type ∈ NOTEBOOK|JOB|PIPELINE|DASHBOARD_V3|DBSQL_DASHBOARD|DBSQL_QUERY|NULL`, `entity_id`, `entity_run_id`, `source_*`/`target_*` incl. `source_type ∈ TABLE|PATH|VIEW|MATERIALIZED_VIEW|METRIC_VIEW|STREAMING_TABLE`, `created_by`, `event_time`, `event_date`, `statement_id` (→ `system.query.history`), `entity_metadata{job_info, dashboard_id, notebook_id, sql_query_id, dlt_pipeline_info, genie_space_id, alert_id}`, `direct_access`) and `column_lineage`. **No MODEL, serving-endpoint, MCP or agent entity types.**
- **Captured AI lineage** [Doc]:
  - Model service ↔ foundation models/provider (PRIMARY/FALLBACK) ↔ inference table, shown in the Catalog Explorer Lineage tab only. No documented API or system table for it.
  - UDF lineage (table level).
  - Model-version lineage and `model_version_dependencies`.
  - Genie Agent reads, via `genie_space_id`.
- **Not captured:** "workloads and agents that call a service at runtime, or the data they access through it" [Doc].
- **REST:** `GET /api/2.0/lineage-tracking/table-lineage|column-lineage` **is not in the current public API reference** [Unverified]. Use system tables.
- **External lineage (GA Jun 8 2026):**
  - `POST /api/2.0/lineage-tracking/external-metadata` (`name, system_type ∈ {…, DATABRICKS, OTHER}, entity_type` (free string), `url, description, columns, properties`) and `POST /api/2.0/lineage-tracking/external-lineage` (`source`/`target` ∈ `table | path | model_version | external_metadata`, `columns[]`, `properties`).
  - Requires `CREATE EXTERNAL METADATA` on the metastore and `MODIFY` on the node. Downstream edges also need read on the UC object; upstream edges need write.
  - → **The hub can publish agent and MCP nodes as `external_metadata` (`entity_type="agent"` / `"mcp_service"`) with edges to tables and model versions, so they show up in Catalog Explorer lineage** [Inferred design].

**What the hub must capture itself:** see "Gaps" below.

## Q9. UC Models and agents

- Agents logged with `mlflow.<flavor>.log_model(..., resources=[...])` register as UC models [Doc].
- APIs: `/api/2.1/unity-catalog/models` (list, create), `/models/{full_name}` (get, patch, delete), `/models/{full_name}/versions[/{v}]` (status `PENDING_REGISTRATION|FAILED_REGISTRATION|READY`, `source`, `run_id`, `run_workspace_id`, **`model_version_dependencies.dependencies[].{table.table_full_name, function.function_full_name, connection.connection_name, credential.credential_name}`**, `created_by/at`, `updated_by/at`, `aliases[]`), and `/models/{full_name}/aliases/{alias}` (PUT/GET/DELETE) [Doc].
- **Change history** = version list + `setRegisteredModelAlias`/`createModelVersion` audit events (`unityCatalog`) [Doc].
- **Tags:**
  - UC entity tag assignments: `/api/2.1/unity-catalog/entity-tag-assignments/{entity_type}/{entity_name}/tags[/{key}]` (GA; example `entity_type: tables`).
  - Workspace-object tags: `/api/2.0/entity-tag-assignments` for `apps, dashboards, geniespaces, notebooks` (GA Sep 25 2026).
  - Governed tag policies: `/api/2.1/tag-policies`.
  - `system.tags.governed_tags` (Beta).
  - The `entity_type` strings for `mcp_service`/`skill`/`model_service` are **[Unverified]**. Service tags clearly exist (`service_tags` in usage; budgets match model-service tags), so probe them [Doc + Unverified].

## Q10. DAIS 2026 (June 16 2026) and later

- **Unity AI Gateway** was announced at DAIS. It's now "Unity Gateway", **GA Aug 4 2026**, API/SDK/Terraform GA Sep 16 2026. DAIS themes: unified spend visibility and hard caps; smart routing; "govern models, MCP services, agents and skills through UC"; **Contextual Service Policies (Beta)**; unified tracing; Lakewatch; and partner integrations (CrowdStrike, Zscaler, Palo Alto, Okta, SailPoint, …) [Doc, blog].
- **UC at DAIS:**
  - ABAC GRANT policies (Beta for models; extended to MCP and agent services Aug 11 2026).
  - **"Context Attributes (Preview soon)"**: request context such as "access originates from an agent/app". The policy `event` already carries `is_on_behalf_of`, `client_id` and `actor_resource`.
  - Domains (PP), Glossary (soon), tag propagation (Beta Oct 12 2026).
  - External lineage GA.
  - OpenSharing (sharing Agent Skills/models).
  - Governance Hub (Beta Jul 22 2026; AI page with token usage, governed-traffic %, budgets and recommendations) [Doc, blog].
- **Agent Bricks at DAIS:** "Deploy custom agents with Databricks Apps", built-in tools governed in UC, MCP support in UC, agent memory on Lakebase (managed memory/sessions Beta Sep 16 2026), Databricks Sandbox. Later: KA/Supervisor legacy (Oct 12 2026) and Agent Bricks CLI Beta (Sep 29 2026) [Doc].
- **OBO for agents/MCP:**
  - Agent Runtime tools with `auth = "user"` run as the request user.
  - Policies can detect OBO (`is_on_behalf_of`, `client_id`).
  - **[Internal]** Agent identities ("PC Agent Identities") are an Identity-team dependency for AGENT_SERVICE public preview (SASP-8308).
- **[Internal]** "UC Agent Services (Beta) is a registry only" (EMEA Compete Messaging v2). Planned agent-service invocation via the gateway proxy and reserved internal/Genie/App agent types (SASP-8308). Public audit docs are missing `mcpService`/`mcpCall` (doc bugs BR-2178, AIGOV-647, Oct 2026).

## OBO (user authorization) scopes for the hub app

Apps declare `user_api_scopes` (UI "+Add scope" or `user_api_scopes: [...]` on create/update). The defaults are `iam.access-control:read` and `iam.current-user:read`. Scopes are enforced even when the user has the permission, and users consent once per app and scope set [Doc, dev-tools/databricks-apps/auth]. API-scope coverage, from the API scopes reference [Doc]:

| Hub action (as the signed-in user) | API scope |
|---|---|
| Read/change **UC grants**, effective permissions; RFA create/destinations; list MCP services/skills/model services; UC connections/functions/models; ABAC policies; external lineage; entity tags | **`unity-catalog`** |
| Read/change **workspace object ACLs** (serving-endpoints, genie, knowledge-assistants, supervisor-agents, experiments) | **`access-management`** |
| Serving endpoint config/list (incl. legacy `PUT .../ai-gateway`) | **`model-serving`** (docs also show `serving.serving-endpoints`) |
| Call MCP services (`tools/list`, `tools/call`) | **`ai-gateway`** (MCP docs) |
| SQL against system tables/trace views | **`sql`** |
| Genie spaces | **`genie`** (docs also show `dashboards.genie`) |
| MLflow experiments/runs | **`mlflow`** |
| Apps list/get | **`apps`** |

[Inferred] Whether each of `unity-catalog`, `access-management` and `ai-gateway` is offered in the Apps user-authorization scope picker isn't stated on the Apps page. Verify on app create. If one isn't offered, perform that action with the **app SP** (holding `MANAGE`) after an in-hub approval, and log the approver.

---

## Gaps the app must fill itself (store in Lakebase)

1. **Unified agent inventory.** There is no single "list all agents" API. Merge KA (v2.1), Supervisor (v2.1), `/api/2.0/tiles` (undocumented [Live→04]), Genie Agents, `agent-bricks-*` apps, agent-serving endpoints, UC models logged as agents, and agent services. Store a stable hub `agent_id` with a source-of-truth pointer.
2. **Owner/team/steward for agents.** Agent services return `owner=null`. KA/Supervisor/endpoints only carry `creator`. Store business owner, technical owner, team, cost center, criticality and lifecycle state (draft/approved/deprecated).
3. **Cross-schema crawling.** MCP/skill/agent-service list calls are schema-scoped, and Global Search excludes MCPs and agent services. Persist the crawl results and `etag`/`update_time` for change detection.
4. **Policy/guardrail inventory.** There's no API to read attached service policies. Store admin-declared policy attachments (name, type, phase, rank, mode) and reconcile them with observed `policy_evaluated` events (unified trace table) and observed DENY/ASK rates.
5. **Access-request workflow.** RFA has no list/approve API and doesn't document MCP/skill/agent-service types. Store requests, approvers, SLA, decision and the executed grant (with the API response and audit event id).
6. **Runtime lineage.** Agent→MCP→tool→table edges aren't captured by UC. Build edges from:
   - Supervisor `tools[]`, KA `knowledge-sources`, Genie `serialized_space`, App `resources[]` and `model_version_dependencies`. These are **declared** edges.
   - `system.ai_gateway.usage` (`requester` = agent SP + `service_name` + `mcp_metadata.tool_name`) and the unified trace table (`trace_id` chains). These are **observed** edges.
   - `system.query.history` (`executed_by` = app SP id, `query_tags`) → `table_lineage.statement_id`, giving **data-access** edges.
   Store edges with `kind (declared|observed)`, `first_seen`, `last_seen` and `call_count`, and optionally publish them as external lineage.
7. **Change-impact tracking.** Snapshot each asset's config hash (MCP `include_tool_selectors`, tool list from `tools/list`, model-service destinations, skill `finalize_time`, model version/alias, KA instructions/sources) and diff over time. Join diffs to the edge graph to compute blast radius.
8. **Agent ↔ SP ↔ experiment map.** The app SP client id (`service_principal_client_id`) appears as `requester` / `executed_by` / `run_as`. Persist SP → agent and agent → experiment/trace-location mappings, because the experiment REST object doesn't expose the UC trace location.
9. **MCP $ allocation.** No table prices MCP calls. Allocate backend cost (warehouse, Apps, serverless, vendor) to MCP services by call share. Keep allocation rules in Lakebase.
10. **Custom-on-Apps MCPs.** These can't be registered as UC MCP services. Register them in the hub (app name `mcp-*`, `/mcp` URL, `CAN USE` ACL) and tools/list them with an OAuth token.
11. **Tag normalization.** Service tags, request tags, UC tags and workspace tags live in different APIs. Store the hub's canonical tag set and push request-tag conventions (`agent_id`, `project`) to agent authors.
12. **Fast-read cache.** System tables lag (usage ~1 h, billing hours, external spend hourly). Cache rollups in Lakebase with "as of" timestamps and a source pill, per house rules.

## Cost attribution recipe

All column names below are taken from the docs cited in Q3. Run on a SQL warehouse as a principal with `SELECT` on the system tables. Recommended layering:
1. **$ per model service / user / tag (Databricks-hosted)** from `system.billing.usage` (`MODEL_SERVING` + `usage_metadata.ai_gateway.*`) × `list_prices`.
2. **$ external providers** from `system.ai_gateway.external_model_spend` (already USD).
3. **Attribute to agents** using the requester (agent SP) and/or `request_tags['agent_id']` from `system.ai_gateway.usage` as allocation weights.
4. **Agent platform $** from `AGENT_BRICKS`, `SUPERVISOR_AGENT`, `APPS` (`app_id`), `GENIE`, `AGENT_EVALUATION`.
5. **MCP $** = allocated backend cost. Usage gives calls and latency only.

```sql
-- 1) Databricks-hosted model cost by model service, destination model and requesting principal ($ at list price)
WITH u AS (
  SELECT usage_date, sku_name, cloud, usage_unit, usage_start_time,
         usage_metadata.ai_gateway.endpoint_name     AS model_service,
         usage_metadata.ai_gateway.destination_model AS destination_model,
         identity_metadata.run_by                    AS principal,
         custom_tags,
         usage_quantity
  FROM system.billing.usage
  WHERE billing_origin_product = 'MODEL_SERVING'
    AND usage_metadata.ai_gateway.endpoint_name IS NOT NULL
    AND usage_date >= current_date() - INTERVAL 30 DAYS
)
SELECT u.model_service, u.destination_model, u.principal,
       SUM(u.usage_quantity)                          AS units,
       SUM(u.usage_quantity * p.pricing.default)      AS list_cost_usd
FROM u
JOIN system.billing.list_prices p
  ON  p.sku_name = u.sku_name AND p.cloud = u.cloud AND p.usage_unit = u.usage_unit
  AND u.usage_start_time >= p.price_start_time
  AND (p.price_end_time IS NULL OR u.usage_start_time < p.price_end_time)
GROUP BY ALL
HAVING units != 0                       -- nets RETRACTION/RESTATEMENT corrections
ORDER BY list_cost_usd DESC;

-- 2) External provider spend (estimated USD) by provider service, model, principal, request tag
SELECT usage_metadata.endpoint_name           AS model_provider_service,
       usage_metadata.model                   AS model,
       identity_metadata.run_by               AS principal,
       custom_tags.request_tags['agent_id']   AS agent_id,
       SUM(usage_quantity)                    AS est_usd
FROM system.ai_gateway.external_model_spend
WHERE usage_start_time >= current_timestamp() - INTERVAL 30 DAYS
GROUP BY ALL ORDER BY est_usd DESC;

-- 3) Allocation weights: tokens per (agent, model service) from request-level usage.
--    agent key = request tag if present, else the requester (agent/app SP application id).
SELECT date_trunc('DAY', event_time)                          AS day,
       coalesce(request_tags['agent_id'], requester)          AS agent_key,
       service_name                                           AS model_service,
       requester_type,
       SUM(total_tokens)                                      AS tokens,
       COUNT(*)                                               AS requests
FROM system.ai_gateway.usage
WHERE service_type IN ('MODEL_SERVICE','MODEL_PROVIDER_SERVICE')
  AND event_time >= current_timestamp() - INTERVAL 30 DAYS
GROUP BY ALL;
-- $ per agent = Σ over (day, model_service): cost(day, model_service from query 1/2)
--               × tokens(agent, day, model_service) / Σ tokens(day, model_service)

-- 4) MCP usage per service / tool / caller (calls, errors, latency) — no $ column exists
SELECT service_name AS mcp_service, mcp_metadata.tool_name AS tool,
       mcp_metadata.server_type, requester,
       COUNT_IF(mcp_metadata.json_rpc_method = 'tools/call') AS calls,
       COUNT_IF(status_code >= 400)                         AS http_errors,
       percentile(latency_ms, 0.95)                         AS p95_ms
FROM system.ai_gateway.usage
WHERE service_type = 'MCP_SERVICE'
  AND event_time >= current_timestamp() - INTERVAL 30 DAYS
GROUP BY ALL;

-- 5) Agent-platform $ (Agent Bricks legacy bricks, Agent Runtime apps, Genie, evals)
SELECT billing_origin_product,
       coalesce(usage_metadata.agent_bricks_id, usage_metadata.app_name,
                usage_metadata.endpoint_name)              AS asset,
       identity_metadata.created_by                        AS created_by,
       SUM(usage_quantity)                                 AS units
FROM system.billing.usage
WHERE billing_origin_product IN ('AGENT_BRICKS','SUPERVISOR_AGENT','APPS','GENIE','AGENT_EVALUATION','AI_FUNCTIONS')
  AND usage_date >= current_date() - INTERVAL 30 DAYS
GROUP BY ALL HAVING units != 0;
-- join list_prices as in (1) for $. Filter APPS rows to app_name LIKE 'agent-bricks-%' or 'mcp-%'
-- to split agent runtimes and custom MCP servers from other apps.

-- 6) Per-user $ across everything: union (1) by principal + (2) by principal;
--    for SP principals, map SP application id → agent via the hub's Lakebase sp_agent_map.

-- 7) Agent → data access (for lineage and to allocate warehouse $ to MCP/agents)
SELECT q.executed_by, q.query_tags, l.source_table_full_name, COUNT(*) AS reads
FROM system.query.history q
JOIN system.access.table_lineage l ON l.statement_id = q.statement_id
WHERE q.start_time >= current_timestamp() - INTERVAL 7 DAYS
GROUP BY ALL;
```
Caveats [Doc]:
- Gateway budgets match **model-service tags only**.
- `ai_gateway.destination_model` reports the destination that actually served the request.
- Provisioned throughput isn't in gateway budgets.
- Usage tracking skips token counts for non-streaming responses >1 MiB.
- `external_model_spend` is an estimate.
- The `usage_metadata.ai_gateway` struct isn't on the billing reference page (verify with `DESCRIBE`; see 04).
- Column names in (7) (`start_time` on `query.history`) should be checked against 04 [Inferred].

## Budgets API (detail)

`/api/2.1/accounts/{account_id}/budgets` (GET list, POST) and `/budgets/{budget_id}` (GET, PUT, DELETE). Account-level, so it needs an account admin or a delegated Budget Manager/Viewer (ACLs Oct 16 2026). The `BudgetConfiguration` object has [Doc]:
- `budget_configuration_id, account_id, display_name, create_time, update_time`.
- **`resource_type ∈ BUDGET_RESOURCE_TYPE_ALL_RESOURCES | BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY`**.
- `filter.{workspace_id:{operator:IN, values[]}, tags[]:{key, value:{operator:IN, values[]}}}`.
- `alert_configurations[].{alert_configuration_id, time_period: MONTH, trigger_type: CUMULATIVE_SPENDING_EXCEEDED, quantity_type: LIST_PRICE_DOLLARS_USD, quantity_threshold, scope_type: …SHARED|…PER_USER, principal_overrides[].{principal_id, override_threshold}, action_configurations[].{action_type: EMAIL_NOTIFICATION | BLOCK_USAGE (Beta), target}}`.

Limits: ≤4 shared thresholds, ≤20 overrides, ≤1,000 budgets/account. Enforcement is near-real-time and approximate. "Include external model usage" is a Beta preview. Serverless **budget (usage) policies** are a separate API, `/api/2.1/accounts/{account_id}/budget-policies`. A workspace app needs account-level auth for these, so the hub should read budgets via an account-scoped SP or let admins mirror them [Inferred].

---

## Sources

Docs (AWS, last-updated Sep–Oct 2026):
- Agent Bricks: [agents/concepts](https://docs.databricks.com/aws/en/agents/concepts/) · [agents/legacy](https://docs.databricks.com/aws/en/agents/legacy/) · [deploy/agent-runtime](https://docs.databricks.com/aws/en/agents/deploy/agent-runtime) · [query-llms](https://docs.databricks.com/aws/en/agents/query-llms) · [knowledge-assistant](https://docs.databricks.com/aws/en/agents/agent-bricks/knowledge-assistant)
- MCP: [mcp-tools](https://docs.databricks.com/aws/en/agents/mcp-tools/) · [built-in-mcp-services](https://docs.databricks.com/aws/en/agents/mcp-tools/built-in-mcp-services) · [genie-agent MCP](https://docs.databricks.com/aws/en/agents/mcp-tools/genie-agent) · [custom-mcp](https://docs.databricks.com/aws/en/agents/mcp-tools/custom-mcp) · [authentication-networking](https://docs.databricks.com/aws/en/agents/mcp-tools/authentication-networking)
- Skills: [uc-skills](https://docs.databricks.com/aws/en/agents/uc-skills/) · [use-uc-skills](https://docs.databricks.com/aws/en/agents/uc-skills/use-uc-skills) · [genie-code/skills](https://docs.databricks.com/aws/en/genie-code/skills) · [agent-skills](https://docs.databricks.com/aws/en/agent-skills/)
- Unity Gateway: [unity-gateway](https://docs.databricks.com/aws/en/unity-gateway/) · [concepts](https://docs.databricks.com/aws/en/unity-gateway/concepts) · [ai-gateway index](https://docs.databricks.com/aws/en/ai-gateway/) · [agent-services](https://docs.databricks.com/aws/en/ai-gateway/agent-services) · [register-mcp-service](https://docs.databricks.com/aws/en/ai-gateway/register-mcp-service) · [govern-mcp-service](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service) · [mcp-service-reference](https://docs.databricks.com/aws/en/ai-gateway/mcp-service-reference) · [govern-skills](https://docs.databricks.com/aws/en/ai-gateway/govern-skills) · [skill-reference](https://docs.databricks.com/aws/en/ai-gateway/skill-reference) · [coding-agent-mcp-skills](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-mcp-skills) · [migrate-to-unity-gateway](https://docs.databricks.com/aws/en/ai-gateway/migrate-to-unity-gateway) · [overview-serving-endpoints (legacy)](https://docs.databricks.com/aws/en/ai-gateway/overview-serving-endpoints) · [configure-ai-gateway-endpoints (legacy)](https://docs.databricks.com/aws/en/ai-gateway/configure-ai-gateway-endpoints)
- Usage, cost, traces: [usage-tracking](https://docs.databricks.com/aws/en/ai-gateway/usage-tracking) · [cost-observability](https://docs.databricks.com/aws/en/ai-gateway/cost-observability) · [budgets](https://docs.databricks.com/aws/en/ai-gateway/budgets) · [request-tagging](https://docs.databricks.com/aws/en/ai-gateway/request-tagging) · [unified-trace-table](https://docs.databricks.com/aws/en/ai-gateway/unified-trace-table) · [unified-trace-table-reference](https://docs.databricks.com/aws/en/ai-gateway/unified-trace-table-reference) · [governance-hub/ai](https://docs.databricks.com/aws/en/admin/governance-hub/ai)
- Service policies: [service-policies](https://docs.databricks.com/aws/en/data-governance/unity-catalog/service-policies/) · [create-service-policy](https://docs.databricks.com/aws/en/data-governance/unity-catalog/service-policies/create-service-policy) · [policy-function-reference](https://docs.databricks.com/aws/en/data-governance/unity-catalog/service-policies/policy-function-reference)
- Access requests: [access-requests](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests) · [access-request-destinations](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-request-destinations)
- Lineage: [data-lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage) · [ai-gateway-service-lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/ai-gateway-service-lineage) · [external-lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/external-lineage)
- System tables: [system-tables](https://docs.databricks.com/aws/en/admin/system-tables/) · [billing](https://docs.databricks.com/aws/en/admin/system-tables/billing) · [pricing](https://docs.databricks.com/aws/en/admin/system-tables/pricing) · [lineage](https://docs.databricks.com/aws/en/admin/system-tables/lineage) · [mlflow](https://docs.databricks.com/aws/en/admin/system-tables/mlflow) · [query-history](https://docs.databricks.com/aws/en/admin/system-tables/query-history) · [audit log reference](https://docs.databricks.com/aws/en/admin/account-settings/audit-logs)
- MLflow: [trace-unity-catalog](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/trace-unity-catalog) · [query-via-sdk](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/observe-with-traces/query-via-sdk) · [production-monitoring](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/production-monitoring) · [manage-production-scorers](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/manage-production-scorers)
- Other: [genie-agents/external-tools](https://docs.databricks.com/aws/en/genie-agents/external-tools) · [marketplace consumer](https://docs.databricks.com/aws/en/marketplace/get-started-consumer) · [apps auth (user authorization)](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth)
- Release notes: [Unity Gateway](https://docs.databricks.com/aws/en/release-notes/unity-gateway/) · product release notes 2026 ([June](https://docs.databricks.com/aws/en/release-notes/product/2026/june)–[October](https://docs.databricks.com/aws/en/release-notes/product/2026/october))

REST API reference (`https://docs.databricks.com/api/<group>/v1/<op>.md`):
- `ai-gateway/v1` (mcp-service, skill, model-service, model-provider-service)
- `knowledge-assistants/v1`, `supervisor-agents/v1`
- `uc-rfa/v1`, `uc-grants/v1`, `uc-abac-policies/v1/policy/object`
- `uc-registered-models/v1`, `uc-external-lineage/v1`, `uc-external-metadata/v1`, `uc-entity-tag-assignments/v1`, `tag-assignments/v1`
- `model-serving/v1/serving-endpoint/object`, `access-management/v1/get-object-permissions`
- `apps/v1/app/object`, `genie/v1`, `marketplaces/v1/list-published-listings-for-consumer`, `budgets/v1/budget/object`
- [API scopes](https://docs.databricks.com/api/workspace/api/scopes)

Blogs (DAIS, Jun 16 2026): [AI governance at DAIS 2026: What's new with Unity Gateway](https://www.databricks.com/blog/ai-governance-data-ai-summit-2026-whats-new-unity-ai-gateway) · [What's new in Unity Catalog at DAIS 2026](https://www.databricks.com/blog/whats-new-unity-catalog-data-ai-summit-2026) · [Agent Bricks at DAIS 2026](https://www.databricks.com/blog/agent-bricks-dais-2026) · [Stop rogue AI: how Unity Catalog secures your agent actions](https://www.databricks.com/blog/stop-rogue-ai-how-unity-catalog-secures-your-agent-actions)

[INTERNAL] (do not share externally):
- Jira **SASP-8308** "Milestone 5 – AGENT_SERVICE: external Agent registration and invocation in UC" (PRD "Agents as UC Securables")
- Jira **BR-2178** / **AIGOV-647** (audit docs omit `mcpService`/`mcpCall`)
- "EMEA Compete Messaging v2" deck (agent services = registry only)

Live shapes: [`04-live-workspace-probe.md`](04-live-workspace-probe.md).
