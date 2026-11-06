# 02: OSS MLflow and open standards for Agent Registry Hub

Research date: 2026-10-26. Scope: open-source MLflow 3.x, MCP (spec and registries), A2A, Agent Skills, OpenTelemetry GenAI conventions, other agent directories, and Unity Catalog OSS. At the end, a canonical data model mapped onto `docs/API_CONTRACT.md`.

**How claims are tagged**
- **[V:Sx]** means Verified against source `Sx` in the [Sources](#sources) list. Most sources are primary: GitHub source at a pinned tag, a spec file, an official doc page, or a live public API call.
- **[I]** means Inferred: my reading or recommendation, not a statement in a source.
- **Illustrative** JSON was built from a verified schema, not copied from a doc. Its field names are verified; its values are made up.

---

## 1. Executive summary

1. **OSS MLflow is at 3.17.2, released 2026-10-21.** 3.17.0 shipped on 2026-10-07 and needs a coordinated `mlflow db upgrade` with all writers stopped. [V:S1]
2. **MLflow 3.15.0 (2026-07-31) added an MCP Registry.** It stores `server.json` with semver versions, aliases, tags, auto-discovered tools and access endpoints, under `/api/3.0/mlflow/mcp-servers`. It is OSS and marked `@experimental`. MLflow has **no agent, tool or skill registry**; MCP servers are the only registered asset type. [V:S1,S7,S8,S9]
3. **Use the v3 trace REST.** It is `POST /api/3.0/mlflow/traces/search` with `locations[]`, and `GET /api/3.0/mlflow/traces/{trace_id}`. Token usage is in trace metadata `mlflow.trace.tokenUsage`, and cost in `mlflow.trace.cost` (USD JSON). Per span they are `mlflow.chat.tokenUsage` and `mlflow.llm.cost`. Most trace RPCs are `PUBLIC_UNDOCUMENTED` in the proto, so expect change. [V:S2,S4,S23]
4. **`POST /api/3.0/mlflow/traces/metrics` does server-side aggregation** over `TRACES`, `SPANS` and `ASSESSMENTS` (COUNT/SUM/AVG/PERCENTILE/MIN/MAX, dimensions, time buckets). This is the cheapest feed for usage KPIs on self-hosted MLflow. [V:S2,S4]
5. **The MLflow AI Gateway was rewritten in 3.9.0 (2026-01-29) and now runs inside the tracking server.** It has REST management for endpoints, model definitions, secrets, traffic split and fallback, **budgets** (USD; GLOBAL, WORKSPACE, ENDPOINT or USER scope; ALERT or REJECT) and **guardrails** (an LLM judge run BEFORE or AFTER the call, as VALIDATION or SANITIZATION). There are no request rate limits; only the deprecated legacy YAML gateway had them. This gateway is separate from Databricks' AI Gateway. [V:S1,S2,S11,S12]
6. **Evaluation is mostly OSS now:**
   - `mlflow.genai.evaluate`, scorers, `make_judge`, eval datasets, and scorer registration (`/api/3.0/mlflow/scorers/*`);
   - **automatic (online) evaluation** with `register()` / `start(sampling_config=…)`, OSS since 3.9.0;
   - review queues, OSS since 3.14.0.

   The Review App and labeling sessions are **Databricks-only**. [V:S1,S13,S14,S21]
7. **On Databricks only:**
   - traces stored in Unity Catalog (`UC_SCHEMA`, `UC_TABLE_PREFIX` trace locations);
   - UC prompts (`/mlflow/unity-catalog/prompts`);
   - the Review App;
   - the Databricks scorer store and review-queue helpers.

   OSS prompts live in the model-registry store, tagged `mlflow.prompt.is_prompt`. [V:S6,S20,S21,S14]
8. **The MLflow Agent Server** (since 3.6.0) exposes `/invocations`, `/responses` (ResponsesAgent only), `/agent/info` and `/health`. `/agent/info` is a cheap discovery probe for agents hosted on Databricks Apps. [V:S1,S16]
9. **OpenTelemetry GenAI conventions now live in their own repo, `open-telemetry/semantic-conventions-genai`.** Core semconv v1.42.0 (2026-06-12) deprecated and moved all `gen_ai.*` keys. The new repo is still **Development** stability and has no releases. It defines agent spans (`invoke_agent`, `execute_tool`, `invoke_workflow`, `plan`) and new **skill** attributes (`gen_ai.skill.*`). It has **no cost attribute**. [V:S70,S71,S73,S76]
10. **MLflow maps both ways to GenAI semconv:**
    - export, opt-in with `MLFLOW_ENABLE_OTEL_GENAI_SEMCONV`;
    - OTLP ingest at `/v1/traces` with header `x-mlflow-experiment-id`.

    It also ingests OpenInference, Traceloop, Langfuse, Claude Code and other dialects. [V:S17,S18]
11. **The official MCP Registry (`registry.modelcontextprotocol.io`) is still "preview".**
    - API: stable `/v0.1/…` (with `/v0` as the dev track). List and incremental sync use `updated_since`, `version=latest` and `include_deleted`.
    - Server status is `active`, `deprecated` or `deleted`.
    - Current `server.json` schema: `2025-12-11`.
    - Subregistries and aggregators add `_meta`.
    - GitHub's MCP Registry and Copilot's enterprise "MCP Registry URL" consume this same v0.1 API.

    [V:S30–S39]
12. **The latest MCP spec is `2026-07-28`, released 2026-07-28.** The protocol is now stateless: no `initialize` and no session ID, plus `server/discover`, multi-round-trip requests and `resultType`. Tool annotations are unchanged: `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` (default true). Auth is OAuth 2.1 with RFC 9728 and RFC 8707; Dynamic Client Registration is deprecated in favor of Client ID Metadata Documents. MCP moved to the Linux Foundation's Agentic AI Foundation on 2025-12-09. [V:S41–S44]
13. **A2A is at v1.0.1 (2026-05-28); v1.0.0 shipped 2026-03-12.** The project is hosted by the Linux Foundation with a 9-company TSC. Its Agent Card lives at `/.well-known/agent-card.json` and has `supportedInterfaces[]` (JSONRPC, GRPC, HTTP+JSON), `capabilities`, `securitySchemes`, `skills[]` and JWS `signatures`. [V:S50–S54]
14. **The Agent Skills spec (agentskills.io) is deliberately minimal.**
    - `name` (≤64, kebab-case, must match the directory) and `description` (≤1024) are required.
    - `license`, `compatibility` (≤500), `metadata` (string→string) and `allowed-tools` (experimental) are optional.
    - Distribution is by convention: `.agents/skills/` paths and Claude Code plugins/marketplaces.
    - Directories exist (skills.sh; Google Cloud Agent Registry `Skill`), but there is no standard registry API. [V:S60–S66,S85]
15. **Emerging cross-protocol discovery: the AI Catalog** (`/.well-known/ai-catalog.json`, `application/ai-catalog+json`, `urn:air:` identifiers). It lists A2A cards, MCP Server Cards, skills and plugins in one document. It is a draft, but it is the best candidate for our import/export format. [V:S45,S46]

---

## 2. API availability matrix

"Managed" means Databricks-managed MLflow. Path prefixes are given as they appear in the MLflow protos at `v3.17.2`.

| Capability | OSS MLflow (version, API path) | Databricks-managed only? | Source |
|---|---|---|---|
| Trace search (v3) | 3.0+: `POST /api/3.0/mlflow/traces/search` with body `{locations[], filter, max_results (default 100), order_by[], page_token}` | No. Both. UC-schema locations are Databricks-only. | [V:S2,S6,S23] |
| Trace search (v2, legacy) | `GET /api/2.0/mlflow/traces` | No | [V:S2] |
| Get one trace | `GET /api/3.0/mlflow/traces/{trace_id}` (info); `GET /api/3.0/mlflow/traces/get`; `GET /api/3.0/mlflow/traces/batchGet`; `POST /api/3.0/mlflow/traces/batchGetInfos` | No. Live on Databricks, `{trace:{trace_info}}`; `/info` returns 404. | [V:S2,S23] |
| Trace tags / delete | `PATCH`/`DELETE /api/3.0/mlflow/traces/{trace_id}/tags`; `POST /api/3.0/mlflow/traces/delete-traces` | No | [V:S2] |
| Trace metrics (server-side aggregation) | `POST /api/3.0/mlflow/traces/metrics` (`QueryTraceMetrics`) | Not checked on managed MLflow [I] | [V:S2,S4] |
| OTLP ingest | `POST /v1/traces`, header `x-mlflow-experiment-id`, OTLP/HTTP only, needs a SQL backend store | Databricks has its own OTel path (not covered here) | [V:S17] |
| GenAI semconv export | 3.11+: env `MLFLOW_ENABLE_OTEL_GENAI_SEMCONV=true`; dual export `MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT=true` | No | [V:S1,S17] |
| Token usage / cost on traces | Metadata `mlflow.trace.tokenUsage`, `mlflow.trace.cost`; span attributes `mlflow.chat.tokenUsage`, `mlflow.llm.cost` (cost computed client-side, built-in `cost_per_token` since 3.11) | No. Often missing on Databricks traces. | [V:S4,S1,S23] |
| Assessments (feedback, expectations) | `POST /api/3.0/mlflow/traces/{trace_id}/assessments`; `GET`/`PATCH`/`DELETE …/assessments/{assessment_id}`; Python `mlflow.log_feedback`, `log_expectation`, `override_feedback` | No | [V:S2,S3] |
| `mlflow.genai.evaluate`, scorers, judges | Python; `make_judge`, built-in judges, `@scorer` | No | [V:S9,S13] |
| Scorer registry | `/api/3.0/mlflow/scorers/{register,list,versions,get,delete}` (PUBLIC) | No. On Databricks the client routes to a `DatabricksStore`. | [V:S2,S14] |
| Automatic / online evaluation | 3.9+: `scorer.register()` → `.start(sampling_config=ScorerSamplingConfig(sample_rate=…))`, `.update()`, `.stop()`. LLM judges only, needs an MLflow AI Gateway endpoint. Internal REST `GET /api/3.0/mlflow/scorers/online-configs`, `PUT …/online-config`. | No. Databricks has its own "scheduled scorers". | [V:S1,S13,S15] |
| Eval datasets | `/api/3.0/mlflow/datasets/{create,search,{dataset_id},{dataset_id}/records,…}` | No | [V:S2] |
| Review queues | 3.14+: `/api/3.0/mlflow/review-queues/{create,get,list,items/add,items/list,items/set-status,…}` | Databricks variant: `mlflow.genai.databricks.review_queues` (3.17.1) | [V:S1,S2] |
| Review App / labeling sessions | `mlflow.genai.get_review_app`, `create_labeling_session` | **Yes, Databricks-only** ("only available in Databricks") | [V:S21] |
| Issues (AI issue discovery) | `/api/3.0/mlflow/issues`, `/issues/search` | No | [V:S2] |
| LoggedModel (agent versions) | `POST /api/2.0/mlflow/logged-models`; `GET`/`PATCH`/`DELETE …/{model_id}`; `POST …/search`; tags and params | No. Live on Databricks; `GET …/search` returns 400. | [V:S2,S23] |
| Link traces to a version | `mlflow.set_active_model(name=…\|model_id=…)`, `create_external_model`, `enable_git_model_versioning()`; metadata key `mlflow.modelId`; `search_traces(model_id=…)` | No | [V:S4,S22] |
| Model Registry | `/api/2.0/mlflow/registered-models/*`, `/api/2.0/mlflow/model-versions/*` | Databricks prefers UC models | [V:S2] |
| Prompt Registry | `mlflow.genai.register_prompt`, `load_prompt`, `search_prompts`, `set_prompt_alias`. Stored as registered models with tag `mlflow.prompt.is_prompt`. Link to traces: `POST /api/2.0/mlflow/traces/link-prompts`, tag `mlflow.linkedPrompts`. | UC prompts (`/mlflow/unity-catalog/prompts…`; version prefix not checked) are Databricks-only | [V:S20,S2] |
| MLflow AI Gateway management | 3.9+ (budgets 3.11, guardrails 3.12, per-user budgets 3.16): `/api/3.0/mlflow/gateway/{endpoints,model-definitions,secrets,budgets,guardrails}/…` | Separate product from Databricks AI Gateway [I] | [V:S2,S1] |
| MLflow AI Gateway invocation | Under `/gateway/`: `/{endpoint}/mlflow/invocations`, `/mlflow/v1/chat/completions`, `/mlflow/v1/models`, `/openai/v1/{chat/completions,embeddings,responses}`, `/anthropic/v1/messages`, `/gemini/v1beta/models/{endpoint}:generateContent`, `/proxy/{endpoint}/{path}` | Same as above | [V:S11] |
| **MCP Registry** | 3.15+ (experimental): `/api/3.0/mlflow/mcp-servers…` (FastAPI; also `/ajax-api/3.0/…`) | OSS. Not observed on Databricks [I; probe S23 tried other paths] | [V:S7,S8] |
| MLflow MCP server (client tool) | `mlflow mcp run` (`mlflow[mcp]>=3.5.1`); tool groups selected with `MLFLOW_MCP_TOOLS` | No. Works against a `databricks` tracking URI. | [V:S10] |
| Agent Server | 3.6+: `AgentServer("ResponsesAgent")`; routes `/invocations`, `/responses`, `/agent/info`, `/health` | No. Reads `DATABRICKS_APP_NAME` when present. | [V:S1,S16] |
| ResponsesAgent | `mlflow.pyfunc.ResponsesAgent`; types `mlflow.types.responses` | No | [V:S16] |
| Webhooks | `/api/2.0/mlflow/webhooks…` | Not checked on managed MLflow [I] | [V:S2] |
| Workspaces / RBAC (self-hosted) | `/api/3.0/mlflow/workspaces…`; RBAC 3.13; sub-resource DENY 3.17 | OSS self-host feature | [V:S1,S2] |
| Agent / tool / skill registry | **None.** No such entities in the `v3.17.2` source tree. | n/a | [V:S1 tree] |

**Stability flags.**
- Trace, dataset, review-queue and logged-model RPCs are `visibility: PUBLIC_UNDOCUMENTED`; scorer, gateway and webhook RPCs are `PUBLIC`. [V:S2]
- `mlflow/tracing/constant.py` has the comment: "NB: These keys are placeholders and subject to change." [V:S4]

---

## 3. OSS MLflow details

### 3.1 Releases that matter for us [V:S1]

| Version | Date (GitHub) | Relevant change |
|---|---|---|
| 3.6.0 | 2025-11-08 | Agent Server |
| 3.9.0 | 2026-01-29 | AI Gateway moved into the tracking server (passthrough, traffic split, fallback); online monitoring with LLM judges; distributed tracing |
| 3.11.1 | 2026-04-08 | Gateway budget alerts and limits; native GenAI semconv export; built-in cost table |
| 3.12.0 | 2026-05-05 | Gateway guardrails; multimodal attachments |
| 3.13.0 | 2026-06-01 | Unified RBAC (breaking); trace archival; coding-agent onboarding to Gateway |
| 3.14.0 | 2026-06-17 | Review queues; pytest regression tests (`@mlflow.test`) |
| 3.15.0 | 2026-07-31 | **MCP Registry** |
| 3.16.0 | 2026-09-04 | Span links; per-user Gateway budgets; basic-auth fail-closed by default |
| 3.17.0 | 2026-10-07 | Fine-grained sub-resource permissions; trace analytics daily rollups (DB upgrade required) |
| 3.17.2 | 2026-10-21 | Lineage tags on `genai.evaluate` runs (dataset, scorer and agent digests) |

### 3.2 Tracing model

**`TraceInfoV3`** [V:S2]
- `trace_id`, `client_request_id`
- `trace_location` {`type`: `MLFLOW_EXPERIMENT` | `INFERENCE_TABLE` in OSS, plus `UC_SCHEMA` | `UC_TABLE_PREFIX` on Databricks [V:S6]; `mlflow_experiment.experiment_id`}
- `request`, `response`, `request_preview`, `response_preview`
- `request_time` (Timestamp), `execution_duration` (Duration)
- `state` (`OK` | `ERROR` | `IN_PROGRESS`)
- `trace_metadata` (map), `assessments[]`, `tags` (map)

**Trace metadata keys** [V:S4]

| Key | Meaning |
|---|---|
| `mlflow.trace.tokenUsage` | JSON string, totals for the trace |
| `mlflow.trace.cost` | JSON string, USD |
| `mlflow.trace.user` | the end user of the app |
| `mlflow.trace.session` | session ID |
| `mlflow.modelId` | linked LoggedModel |
| `mlflow.sourceRun` | source run |
| `mlflow.trace.sizeStats` | size statistics |
| `mlflow.gateway.endpointId`, `mlflow.gateway.requestType`, `mlflow.gateway.caller` | set by the MLflow AI Gateway |
| `mlflow.auth.userId`, `mlflow.auth.username` | authenticated caller |

Databricks traces also carry `mlflow.databricks.modelServingEndpointName`. [V:S23]

**Trace tags** [V:S4]
- `mlflow.traceName`
- `mlflow.linkedPrompts`: `[{"name","version"}]`
- `mlflow.trace.sourceScorer`

**Span attributes** [V:S4]

| Attribute | Content |
|---|---|
| `mlflow.spanType` | span type (enum below) |
| `mlflow.spanInputs`, `mlflow.spanOutputs` | inputs and outputs |
| `mlflow.chat.tokenUsage` | `{input_tokens, output_tokens, total_tokens, cache_read_input_tokens?, cache_creation_input_tokens?, cache_creation_input_tokens_above_1hr?}` |
| `mlflow.llm.cost` | `{input_cost, output_cost, total_cost}` in USD |
| `mlflow.llm.model`, `mlflow.llm.provider` | model and provider |
| `mlflow.chat.tools` | tool definitions offered to the model |
| `mlflow.linkedPrompts` | prompts loaded in this span |
| `mlflow.gateway.linkedTraceId` | the Gateway trace this span called |
| `user.id`, `session.id` | copied to the root span for OTLP |
| `mlflow.traceTag.<k>` | user tags that survive OTLP export |
| `mlflow.spanLogLevel`, `mlflow.spanDescription` | log level and description |

**`SpanType` values** [V:S5]: `LLM`, `CHAIN`, `AGENT`, `TOOL`, `CHAT_MODEL`, `RETRIEVER`, `PARSER`, `EMBEDDING`, `RERANKER`, `MEMORY`, `UNKNOWN`, `WORKFLOW`, `TASK`, `GUARDRAIL`, `EVALUATOR`.

**Assessment metadata (judge cost and scorer lineage)** [V:S4,S19]
- `mlflow.assessment.judgeCost`, `judgeInputTokens`, `judgeOutputTokens`
- `mlflow.assessment.scorerName`, `scorerVersion`, `scorerDigest`
- `mlflow.assessment.onlineScoringSessionId`, `sourceRunId`, `scorerTraceId`

**Trace metrics API (`QueryTraceMetrics`)** [V:S2,S4]
- Request fields: `experiment_ids[]`, `view_type` (`TRACES` | `SPANS` | `ASSESSMENTS`), `metric_name`, `aggregations[{aggregation_type: COUNT|SUM|AVG|PERCENTILE|MIN|MAX, percentile_value}]`, `dimensions[]`, `filters[]`, `time_interval_seconds`, `start_time_ms`, `end_time_ms`, `max_results` (default 1000), `page_token`.
- Metric names:
  - traces: `trace_count`, `session_count`, `latency`, `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`;
  - spans: `span_count`, `latency`, `input_cost`, `output_cost`, `total_cost`;
  - assessments: `assessment_count`, `assessment_value`.
- Dimensions: `trace_name`, `trace_status`, `span_name`, `span_type`, `span_status`, `span_model_name`, `span_model_provider`, `assessment_name`, `assessment_value`.

Example search request, confirmed live on Databricks [V:S23]:
```json
POST /api/3.0/mlflow/traces/search
{"locations":[{"type":"MLFLOW_EXPERIMENT","mlflow_experiment":{"experiment_id":"3325179909192303"}}],
 "filter":"trace.status = 'OK'", "max_results":100, "order_by":["timestamp_ms DESC"]}
→ {"traces":[{ "trace_id":"tr-…", "trace_location":{…}, "request_time":"…", "execution_duration":"1.2s",
               "state":"OK", "trace_metadata":{"mlflow.trace.tokenUsage":"{\"input_tokens\":…}", "mlflow.modelId":"m-…"},
               "tags":{"mlflow.traceName":"…"}, "assessments":[…] }], "next_page_token":"…"}
```
The `filter` and `order_by` syntax comes from the proto comments [V:S2]. The response values are illustrative.

### 3.3 Assessments

`Assessment` fields [V:S3]:
- `assessment_id` (prefix `a-`), `assessment_name`, `trace_id`, `span_id?`
- `source{source_type: HUMAN|LLM_JUDGE|CODE, source_id}`
- `create_time`, `last_update_time`
- one of `feedback{value, error}`, `expectation{value | serialized_value}` or `issue`
- `rationale`, `metadata` (map), `overrides`, `valid`

Illustrative create body:
```json
POST /api/3.0/mlflow/traces/tr-123/assessments
{"assessment":{"assessment_name":"correctness","trace_id":"tr-123",
  "source":{"source_type":"LLM_JUDGE","source_id":"correctness_v2"},
  "feedback":{"value":true},"rationale":"Matches expected facts",
  "metadata":{"mlflow.assessment.scorerVersion":"2"}}}
```

### 3.4 Evaluation, scorers, judges, datasets

- **APIs.** `mlflow.genai.evaluate()`, `make_judge()`, `@scorer`, `Scorer` and built-in judges. The docs list correctness, safety, groundedness, relevance, context sufficiency, guidelines, tool-call correctness and efficiency, and conversational judges. The `mlflow.genai` package exports these, plus dataset CRUD, `optimize_prompts`, labeling and the MCP-registry functions. [V:S9,S13]
- **Automatic evaluation (OSS).** Judges run on new traces or sessions with a sample rate and an optional filter. Limits [V:S13]:
  - LLM judges only;
  - needs an MLflow AI Gateway endpoint;
  - only evaluates traces up to 1 hour old;
  - editing a judge does not re-score old traces.
- **Lineage on eval runs (3.17.2)** [V:S19]:
  - run tags `mlflow.genaiEvaluate.scorersDigest`, `mlflow.genaiEvaluate.agent.function`, `mlflow.genaiEvaluate.agent.digest`, `mlflow.genaiEvaluate.agent.uri` (e.g. `endpoints:/my-agent`);
  - every feedback carries `mlflow.assessment.scorerDigest`.

  These give an exact eval→agent link for our lineage graph.

### 3.5 LoggedModel and versions

- `LoggedModelInfo` fields [V:S2]: `model_id` (`m-…`), `experiment_id`, `name`, `creation_timestamp_ms`, `last_updated_timestamp_ms`, `artifact_uri`, `status` (`LOGGED_MODEL_PENDING` | `LOGGED_MODEL_READY` | …), `creator_id`, `model_type`, `source_run_id`, `status_message`, `tags[]`, `registrations[]`.
- Traces link to a version through metadata `mlflow.modelId`. Writers set it with `set_active_model` or `enable_git_model_versioning()`; readers query with `search_traces(model_id=…)`. [V:S4,S22]

### 3.6 MLflow AI Gateway (3.9+ rewrite)

| Entity | Fields | Source |
|---|---|---|
| `GatewayEndpoint` | `endpoint_id`, `name`, `model_mappings[]` (`weight`, `linkage_type` PRIMARY or FALLBACK, `fallback_order`), `routing_strategy` (`REQUEST_BASED_TRAFFIC_SPLIT`), `fallback_config`, `experiment_id`, **`usage_tracking`** (bool), `tags`, audit fields | [V:S2] |
| `GatewayModelDefinition` | `provider`, `model_name`, `secret_id` | [V:S2] |
| `GatewayEndpointBinding` | `resource_type`, `resource_id`, `display_name` | [V:S2] |
| `GatewayBudgetPolicy` | `budget_unit` USD, `budget_amount`, `duration` (`MINUTES`…`MONTHS`), `target_scope` GLOBAL, WORKSPACE, ENDPOINT or USER, `target_value`, `budget_action` ALERT or REJECT | [V:S2] |
| `BudgetWindow` (from `GET /api/3.0/mlflow/gateway/budgets/windows`) | `window_start_ms`, `window_end_ms`, `current_spend` | [V:S2] |
| `GatewayGuardrail` | `scorer` (an LLM judge), `stage` BEFORE or AFTER, `action` VALIDATION or SANITIZATION, `action_endpoint_id`. Built-in types in the UI: Safety, PII Detection, Custom. | [V:S2,S12] |

Behavior notes:
- When usage tracking is on, every request is logged as a trace in the endpoint's experiment, with token and cost charts. [V:S12]
- Providers ship in `mlflow/gateway/providers/`: OpenAI, Anthropic, Bedrock, Gemini, Vertex AI, Databricks, Mistral, Cohere, Groq, DeepSeek, xAI, Ollama, OpenRouter, LiteLLM, Portkey, SAP AI Core, TogetherAI, HuggingFace and others. [V:S1 tree]
- **No rate limits.** The legacy `mlflow gateway start` with YAML `limit: {calls, renewal_period}` is `@deprecated`. [V:S11]
- `MLFLOW_ENABLE_AI_GATEWAY` lets admins turn the gateway off (3.17). [V:S1]

### 3.7 MLflow MCP Registry (3.15+, experimental)

- **Entities** [V:S7,S8]:
  - `MCPServer`: `name` (reverse-DNS `<namespace>/<slug>`), `display_name`, `description`, `icons`, `workspace`, `status`, `access_endpoints`, `latest_version`, `aliases`, `tags`, audit fields;
  - `MCPServerVersion`: `version` (semver), `server_json`, `status` (`draft` | `active` | `deprecated` | `deleted`), `tools[]`, `aliases`, `tags`, `connect_options`, `source`;
  - `MCPAccessEndpoint`: `id`, `url`, `transport_type` (default `streamable-http`), `server_version` or `server_alias`, `resolved_version`.
- **Tool record** [V:S8]: `name`, `title`, `description`, `inputSchema`, `outputSchema`, **`annotations`**, `icons`, `execution`, `source`.
- **REST** (prefix `/api/3.0/mlflow/mcp-servers`) [V:S8]:

  | Method | Path | Purpose |
  |---|---|---|
  | `POST` / `GET` | `` (root) | create; search (`filter_string`, `max_results`, `order_by`, `page_token`) |
  | `GET` | `/endpoints` | search all access endpoints |
  | `GET` / `PATCH` / `DELETE` | `/{name}` | one server |
  | `POST` / `GET` | `/{name}/versions` | create version; list versions |
  | `GET` / `PATCH` / `DELETE` | `/{name}/versions/{version}` | one version |
  | `POST` / `DELETE` | `/{name}/versions/{version}/tags[/{key}]` | version tags |
  | `POST` / `GET` | `/{name}/endpoints` | access endpoints |
  | `GET` / `PATCH` / `DELETE` | `/{name}/endpoints/{endpoint_id}` | one access endpoint |
  | `POST` / `DELETE` | `/{name}/tags[/{key}]` | server tags |
  | `POST` / `GET` / `DELETE` | `/{name}/aliases[/{alias}]` | aliases; `latest` is built in |

- **Python** [V:S9]: `mlflow.genai.register_mcp_server(server_json, source, status, tools, create_access_endpoints_from_remotes, mcp_server_access_headers)`, `register_mcp_server_from_url`, `search_mcp_servers`, `refresh_mcp_server_version_tools`, `create_mcp_access_endpoint`, and others.
  - Tool discovery is a one-time, best-effort snapshot taken from the first remote.
- The create-version body accepts either a raw `server.json` or an official-registry envelope `{server, _meta}`. **We can pipe `/v0.1/servers` results straight in.** [V:S8]

Illustrative create-version body:
```json
POST /api/3.0/mlflow/mcp-servers/io.github.acme%2Fcrm/versions
{"server_json":{"name":"io.github.acme/crm","version":"1.4.0","description":"CRM lookups",
   "remotes":[{"type":"streamable-http","url":"https://mcp.acme.com/crm"}]},
 "status":"active","source":"https://github.com/acme/crm-mcp",
 "tools":[{"name":"get_account","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}
```

### 3.8 MLflow MCP server, Agent Server and ResponsesAgent

- **`mlflow mcp run`** [V:S10]:
  - exposes `search_traces`, `get_trace`, `delete_traces`, `set_trace_tag`, `delete_trace_tag`, `log_feedback`, `log_expectation`, `get_assessment`, `update_assessment`, `delete_assessment`;
  - `MLFLOW_MCP_TOOLS` selects tool groups: `genai` (default), `ml`, `all`, or a list.
  - This is a client tool and not a registry. It is a candidate asset to register: `mcp:…` with `platform=mlflow` [I].
- **Agent Server** [V:S16]: `GET /agent/info` returns `{name: $DATABRICKS_APP_NAME or "mlflow_agent_server", use_case:"agent", mlflow_version, agent_api:"responses"?}`. **Probe it to classify a Databricks App as an agent** [I].

---

## 4. MCP: registry, `server.json` and spec items to surface

### 4.1 Official MCP Registry API

- **Status.** The registry is "currently in preview. Breaking changes or data resets may occur before general availability." It gives no uptime or durability guarantees, and aggregators are told to scrape about hourly. [V:S36]
- **Base URLs.** `https://registry.modelcontextprotocol.io`; staging at `staging.registry…`. Live docs are at `/docs`, OpenAPI at `/openapi.yaml`. [V:S30]
- **Versions.** `/v0.1/` is the stable API (introduced 2025-10-17, additive changes only); `/v0/` is the dev track. `GET /v0/servers/{name}` was removed in favor of `/versions/latest`. [V:S33]
- **Endpoints** [V:S31,S32]:

  | Method | Path | Notes |
  |---|---|---|
  | `GET` | `/v0.1/servers` | `cursor`, `limit`, `search` (substring on name), `updated_since` (RFC 3339), `version` (`latest` or exact), `include_deleted` (true automatically with `updated_since`) |
  | `GET` | `/v0.1/servers/{serverName}/versions` | version history |
  | `GET` | `/v0.1/servers/{serverName}/versions/{version\|latest}` | one version |
  | `POST` | `/v0.1/publish` | |
  | `PUT` | `/v0.1/servers/{serverName}/versions/{version}` | admin only on the official registry |
  | `PATCH` | `/v0.1/servers/{serverName}/versions/{version}/status` | |
  | `PATCH` | `/v0.1/servers/{serverName}/status` | all versions at once |

  Names must be URL-encoded (`io.github.user%2Fserver`). The OpenAPI `info.version` is `"2025-12-01"`.
- **Ordering trap.** Results are sorted by name, then version **as text** (`1.10.0` sorts before `1.2.0`). Use `version=latest` or the `isLatest` flag. [V:S30]
- **Publishing auth.** GitHub OAuth or OIDC for `io.github.*`; DNS or HTTP verification for domain namespaces. Endpoints: `/v0.1/auth/{github-at,github-oidc,dns,http,oidc}`. [V:S30]
- **Subregistries.** A subregistry implements the same OpenAPI and adds custom data in `_meta`, such as ratings or scan results. **Agent Registry Hub can be a subregistry**: serve `/v0.1/servers` from Lakebase so Copilot, VS Code and others can use it as the enterprise "MCP Registry URL" [I; S36,S39].

Live response (`GET /v0.1/servers?limit=2&version=latest`, 2026-10-26) [V:S37], trimmed to one record:
```json
{"servers":[{"server":{"$schema":"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
   "name":"ac.inference.sh/mcp","title":"inference.sh","version":"2.0.1",
   "description":"run any ai model. compose agents, stack knowledge, connect tools. one api, pay per run.",
   "remotes":[{"type":"streamable-http","url":"https://api.inference.sh/mcp"}]},
  "_meta":{"io.modelcontextprotocol.registry/official":{"status":"active","statusChangedAt":"2026-07-27T10:44:51.359634Z",
   "publishedAt":"2026-07-27T10:44:51.359634Z","updatedAt":"2026-07-27T10:44:51.359634Z","isLatest":true}}}],
 "metadata":{"nextCursor":"ac.snag/snag:1.0.0","count":2}}
```

### 4.2 `server.json` schema (published `2025-12-11`)

Fields, from the published JSON Schema [V:S34]:

| Object | Field | Constraint / notes |
|---|---|---|
| ServerDetail | `name` | **required**, ≤200, pattern `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$` (reverse-DNS namespace / slug) |
| | `description` | **required**, ≤100 |
| | `version` | **required**, ≤255 |
| | `$schema`, `title` (≤100), `websiteUrl`, `icons[]` | optional |
| | `repository` | `{url*, source*, id, subfolder}` |
| | `packages[]` | see Package row |
| | `remotes[]` | see Transport row |
| | `_meta` | reverse-DNS keys, e.g. `io.modelcontextprotocol.registry/publisher-provided` |
| Package | `registryType*` | `npm`, `pypi`, `oci`, `nuget`, `mcpb`; `cargo` is in the docs |
| | `identifier*`, `transport*` | `transport` is stdio, streamable-http or sse |
| | `version`, `registryBaseUrl`, `fileSha256`, `runtimeHint` | |
| | `runtimeArguments[]`, `packageArguments[]` | positional or named |
| | `environmentVariables[]` | `{name, description, isRequired, isSecret, default, choices, format}` |
| Transport | `type` | `streamable-http` or `sse` (with `url*` and `headers[]`), or `stdio`; remotes may use `variables` for `{templated}` URLs (added 2025-12-11) |
| Icon | `src*`, `mimeType`, `sizes`, `theme` | `theme` is light or dark |

- The draft (unreleased) schema also allows URLs that start with a template variable, such as `{baseUrl}/mcp`. [V:S35]
- **Status lives outside `server.json`**: `_meta["io.modelcontextprotocol.registry/official"].status` is `active`, `deprecated` or `deleted`, with `statusMessage`. [V:S33]

Doc example, an npm package [V:S34 generic-server-json.md]:
```json
{"$schema":"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
 "name":"io.modelcontextprotocol.anonymous/brave-search","description":"MCP server for Brave Search API integration",
 "title":"Brave Search","repository":{"url":"https://github.com/modelcontextprotocol/servers","source":"github"},
 "version":"1.0.2",
 "packages":[{"registryType":"npm","registryBaseUrl":"https://registry.npmjs.org",
   "identifier":"@modelcontextprotocol/server-brave-search","version":"1.0.2","transport":{"type":"stdio"},
   "environmentVariables":[{"name":"BRAVE_API_KEY","description":"Brave Search API Key","isRequired":true,"isSecret":true}]}]}
```

### 4.3 GitHub MCP Registry, Docker MCP Catalog, Server Cards

- **GitHub MCP Registry** (`github.com/mcp`, launched 2025-09-16). Servers self-published to the OSS registry "will automatically appear". [V:S38]
  - Copilot enterprise and org policy takes an **"MCP Registry URL"**: the base URL only, and "GitHub Copilot appends the MCP v0.1 path automatically". Policy choices are **Registry only** or **Allow all**. Azure API Center can host the registry. The feature is in public preview, and `managed-settings.json` allowlists are recommended instead. [V:S39]
- **Docker MCP Catalog.** `docker/mcp-registry` holds 328 server folders, each with a `server.yaml` in the Docker `mcp-gateway` "Server Entry" format. [V:S40]
  - Core: `name`, `type` (`server` | `remote` | `poci`), `title`, `description`, `icon`, `readme`
  - Container: `image`, `command`, `volumes`, `user`, `longLived`
  - Remote: `remote{url, transport_type, headers}`
  - Secrets and auth: `secrets[{name, env, example}]`, `oauth{providers[{provider, secret, env}], scopes}`, `env`
  - Network: `disableNetwork`, `allowHosts`
  - `tools[{name, description, arguments, annotations{title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint}}]`
  - `config`
- **MCP Server Cards** (experimental extension, SEP-2127) [V:S45]:
  - a static, remote-only card with identity, transports and protocol versions;
  - recommended location `GET <streamable-http-url>/server-card`;
  - schema URL `https://static.modelcontextprotocol.io/schemas/v1/<name>.schema.json`;
  - tools are deliberately left out (use `tools/list`).

### 4.4 MCP spec: latest version and per-server items

**Latest version: `2026-07-28`** (RC 2026-05-29, stable 2026-07-28; previous version `2025-11-25`). [V:S41]

Major changes [V:S41]:
- sessions and `Mcp-Session-Id` removed;
- `initialize` handshake removed; each request carries `_meta` `io.modelcontextprotocol/protocolVersion` and `/clientCapabilities`;
- servers MUST implement `server/discover`;
- `subscriptions/listen` replaces GET streams and `resources/subscribe`;
- multi-round-trip requests (`InputRequiredResult`), and every result has a required `resultType`;
- tasks moved to the `io.modelcontextprotocol/tasks` extension.

Minor changes [V:S41]:
- `tools/list` results are `CacheableResult` (`ttlMs`, `cacheScope`) in a deterministic order;
- `Mcp-Method` and `Mcp-Name` headers are required;
- OTel `traceparent` is carried in `_meta`;
- Roots, Sampling, Logging, HTTP+SSE and DCR are deprecated.

Items to surface per server (a collector should probe `server/discover` first, then fall back to `initialize` for servers older than `2026-07-28` [I]):

| Item | Field (spec 2026-07-28) | Source |
|---|---|---|
| Tool | `name`, `title`, `description`, `inputSchema`, `outputSchema`, `icons`, `annotations`, `_meta` | [V:S42] |
| Tool annotations | `title`, `readOnlyHint` (default **false**), `destructiveHint` (default **true**), `idempotentHint` (default **false**), `openWorldHint` (default **true**). These are hints and are not trusted. | [V:S42] |
| Server capabilities | `tools`, `resources`, `prompts`, `completions`, `logging`, `experimental`, **`extensions`** | [V:S42] |
| Auth | OAuth 2.1 (draft-ietf-oauth-v2-1-13); servers MUST serve Protected Resource Metadata (RFC 9728, `/.well-known/oauth-protected-resource`); `WWW-Authenticate: Bearer resource_metadata=…, scope=…`; resource indicators (RFC 8707); AS metadata (RFC 8414); `iss` check (RFC 9207); Client ID Metadata Documents preferred over DCR (RFC 7591, deprecated) | [V:S41,S43] |
| Governance | MCP was donated to the **Agentic AI Foundation** (a Linux Foundation directed fund) on 2025-12-09 | [V:S44] |

Our risk-tier engine should treat an *absent* annotation as the spec default. That means destructive=true and openWorld=true, so the absence should raise risk [I].

---

## 5. A2A Agent Card (v1.0.1)

- **Version and dates:** v1.0.0 on 2026-03-12, v1.0.1 on 2026-05-28. The previous line was v0.3.0 (2025-07-30). [V:S50]
- **Governance:** "Originally developed by Google, the project is now hosted by the Linux Foundation." The TSC has 9 seats: Google, Microsoft, Cisco, AWS, Salesforce, ServiceNow, SAP, IBM and Bloomberg. The roadmap mentions "consolidation of efforts for registry". [V:S53,S54]
- **Discovery:** `https://{domain}/.well-known/agent-card.json`, registries or catalogs, or direct configuration. The authenticated extended card is at `GET /extendedAgentCard` (HTTP+JSON binding). [V:S51,S52]
- **AgentCard fields.** Proto names are below; JSON uses camelCase. [V:S51]

| Field | Req. | Notes |
|---|---|---|
| `name`, `description`, `version` | ✓ | |
| `supportedInterfaces[]` | ✓ | `{url*, protocolBinding*` (`JSONRPC` \| `GRPC` \| `HTTP+JSON` \| a custom URI), `protocolVersion*`, `tenant}` |
| `provider` | | `{organization*, url*}` |
| `documentationUrl`, `iconUrl` | | |
| `capabilities` | ✓ | `{streaming, pushNotifications, extendedAgentCard, extensions[{uri, description, required, params}]}` |
| `securitySchemes` | | map of name → one of `apiKeySecurityScheme`, `httpAuthSecurityScheme`, `oauth2SecurityScheme`, `openIdConnectSecurityScheme`, `mtlsSecurityScheme` |
| `securityRequirements[]` | | `{schemes: {name: [scopes]}}` |
| `defaultInputModes[]`, `defaultOutputModes[]` | ✓ | MIME types |
| `skills[]` | ✓ | `{id*, name*, description*, tags*[], examples[], inputModes[], outputModes[], securityRequirements[]}` |
| `signatures[]` | | JWS `{protected, signature, header}` |

**Spec inconsistency.** The spec's sample card uses `"security"`, but the proto field is `security_requirements`. Parse both [V:S51,S52; I for the advice].

Sample from the spec, trimmed [V:S52 §8.5]:
```json
{"name":"GeoSpatial Route Planner Agent","description":"Provides advanced route planning…",
 "supportedInterfaces":[{"url":"https://georoute-agent.example.com/a2a/v1","protocolBinding":"JSONRPC","protocolVersion":"1.0"}],
 "provider":{"organization":"Example Geo Services Inc.","url":"https://www.examplegeoservices.com"},
 "version":"1.2.0","documentationUrl":"https://docs.examplegeoservices.com/georoute-agent/api",
 "capabilities":{"streaming":true,"pushNotifications":true,"extendedAgentCard":true},
 "securitySchemes":{"google":{"openIdConnectSecurityScheme":{"openIdConnectUrl":"https://accounts.google.com/.well-known/openid-configuration"}}},
 "defaultInputModes":["application/json","text/plain"],"defaultOutputModes":["application/json","image/png"],
 "skills":[{"id":"route-optimizer-traffic","name":"Traffic-Aware Route Optimizer","description":"Calculates the optimal driving route…",
   "tags":["maps","routing"],"examples":["Plan a route from … avoiding tolls."]}],
 "signatures":[{"protected":"eyJhbGciOiJFUzI1NiIs…","signature":"QFdkNLNs…"}]}
```

**Naming collision.** A2A `skills[]` are capabilities *declared inside an agent*, not Agent Skills (`SKILL.md`). Do not create `skill:` assets from them [I; Google Cloud Agent Registry makes the same distinction, V:S85].

---

## 6. Agent Skills (SKILL.md)

- **Spec frontmatter** [V:S60]:

  | Field | Required | Constraint |
  |---|---|---|
  | `name` | ✓ | 1–64 chars; lowercase `a-z`, `0-9` and `-`; no leading, trailing or double hyphen; **must match the parent directory** |
  | `description` | ✓ | 1–1024 chars; what the skill does and when to use it |
  | `license` | | name or bundled file |
  | `compatibility` | | ≤500 chars |
  | `metadata` | | string→string map (e.g. `author`, `version`) |
  | `allowed-tools` | | space-separated, **experimental** |

  - Layout: `SKILL.md` plus optional `scripts/`, `references/`, `assets/`.
  - Progressive disclosure: about 100 tokens of metadata; a body under 5000 tokens and under 500 lines is recommended.
  - Validator: `skills-ref validate`.
- **Origin.** "Originally developed by Anthropic, released as an open standard." Repo `agentskills/agentskills`, Apache-2.0, created 2025-12-16. Databricks is listed as a client. [V:S61]
- **Claude Code extensions** (ignored elsewhere; the claude.ai/API upload accepts only the 6 spec fields) [V:S63]: `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`.
- **Where skills live:**
  - Conventions: `<project>/.agents/skills/` and `~/.agents/skills/` for cross-client use, plus client paths (`.claude/skills/`). [V:S62]
  - Claude Code plugins: `<plugin>/skills/<name>/SKILL.md`, namespaced `plugin:skill`. [V:S63]
  - Marketplaces: `.claude-plugin/marketplace.json` with `{name, owner, plugins[{name, source, description, …}]}`. Sources are a relative path, `github`, `git-subdir`, `url`, `archive`, `npm` or `command`. [V:S64]
  - Plugin manifest: `.claude-plugin/plugin.json` with `name` (required), `version`, `description`, `author`, `license`, `keywords`, `skills`, `agents`, `hooks`, `mcpServers`, `dependencies`, `userConfig`, `metadata`, and more. [V:S65]
- **Registries.** There is no standard API. Known directories:
  - skills.sh (Vercel; `npx skills add <owner/repo>`) [V:S66];
  - Google Cloud Agent Registry `Skill`/`SkillRevision`/`Publisher` (Preview) [V:S85];
  - AI Catalog types `application/agent-skills+{json,md,zip,gzip}` and `application/agent-plugins+zip` [V:S46];
  - OASF `agentskills_*` objects [V:S80].
- **Telemetry.** OTel now has `gen_ai.skill.name`, `gen_ai.skill.description`, `gen_ai.skill.source.uri` and `gen_ai.skill.resource.name` on `execute_tool` refinements (`load_skill`, read skill resource). That gives us an observed `uses_skill` edge. [V:S71,S73]

---

## 7. OpenTelemetry GenAI semantic conventions

**Where and how stable** [V:S70,S76]
- Home: `github.com/open-telemetry/semantic-conventions-genai` (created 2026-05-05).
- `model/manifest.yaml`: `stability: development`, `schema_url: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev`, depends on core semconv `v1.44.0` (released 2026-08-04).
- No releases yet (the changelog is "Unreleased").
- Core semconv v1.42.0 (2026-06-12) deprecated and moved every `gen_ai.*`, `openai.*` and `mcp.*` definition.
- Every attribute below is **Development**.

**Operations (`gen_ai.operation.name`)** [V:S72]
- `chat`, `generate_content`, `text_completion`, `embeddings`, `retrieval`, `fetch_response`
- `create_agent`, `invoke_agent`, `invoke_workflow`, `plan`, `execute_tool`
- memory: `create_memory`, `search_memory`, `update_memory`, `upsert_memory`, `delete_memory`, `create_memory_store`, `delete_memory_store`

**Agent spans** [V:S71]
- **`invoke_agent`**: span kind `CLIENT` for a remote agent or `INTERNAL` in-process; name `invoke_agent {gen_ai.agent.name}`. Attributes: `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.agent.version`, `gen_ai.provider.name` (required), `gen_ai.request.model`, `server.*`.
- **`execute_tool`**: kind `INTERNAL`, name `execute_tool {gen_ai.tool.name}`. Attributes:
  - required: `gen_ai.tool.name`;
  - conditionally required: `gen_ai.tool.call.id`, `gen_ai.agent.name`, `gen_ai.conversation.id`;
  - recommended: `gen_ai.tool.type`, `gen_ai.tool.description`;
  - opt-in: `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`.

  [V:S72]
- **Entity `gen_ai.main_agent`** [V:S74]:
  - `gen_ai.main_agent.id` must be a *stable provider-assigned* ID, for example a Bedrock agent ARN or a Google Cloud Agent Registry ID;
  - `.name` and `.description` "map to" the A2A Agent Card `name` and `description`.

**Token and other attributes** [V:S73]
- Tokens: `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_write.input_tokens`, `reasoning.output_tokens`, and per-modality `text.*`, `image.*`, `audio.*`.
- **No cost attribute.**
- Evaluation: `gen_ai.evaluation.name`, `score.value`, `score.label`, `explanation`.
- Prompts: `gen_ai.prompt.name`, `gen_ai.prompt.version`.
- Data: `gen_ai.data_source.id`.
- MCP (S75): `mcp.method.name`, `mcp.protocol.version`, `mcp.session.id`, `mcp.resource.uri`.

**MLflow mapping (export, 3.11+)** [V:S18]

| MLflow | GenAI semconv |
|---|---|
| `CHAT_MODEL` | `chat` |
| `LLM` | `generate_content` |
| `EMBEDDING` | `embeddings` |
| `TOOL` | `execute_tool` (with `gen_ai.tool.name`, `tool.call.arguments`, `tool.call.result`) |
| `AGENT` | `invoke_agent` (with `gen_ai.agent.name`) |
| other span types | the span-type string itself (e.g. `RETRIEVER`) |
| `mlflow.llm.model` | `gen_ai.request.model` |
| `mlflow.llm.provider` | `gen_ai.provider.name` |
| `mlflow.chat.tokenUsage` | `gen_ai.usage.input_tokens` / `output_tokens` |
| `mlflow.chat.tools` | `gen_ai.tool.definitions` |

MLflow `mlflow.*` attributes are dropped on export, except `mlflow.traceTag.*`.

**MLflow mapping (ingest)** [V:S18]
- Operation to span type:

  | Incoming `gen_ai.operation.name` | MLflow span type |
  |---|---|
  | `chat` | `CHAT_MODEL` |
  | `create_agent`, `invoke_agent` | `AGENT` |
  | `execute_tool` | `TOOL` |
  | `embeddings` | `EMBEDDING` |
  | `generate_content`, `text_completion`, `response` | `LLM` |

- Models: `gen_ai.response.model` and `gen_ai.request.model`.
- Tokens: `gen_ai.usage.*`, with a fallback to the legacy `cache_creation.input_tokens`.
- `invoke_workflow`, `plan`, `retrieval` and memory operations are **not mapped** [V:S18 by absence]. Expect `UNKNOWN` types for those [I].

**Implication for us** [I]
- Stamp `gen_ai.agent.id` = the registry URN on agents we host, so OTel-native backends join on our ID.
- Store incoming `gen_ai.agent.id` values in `external_ref.otel_agent_id`.
- Compute cost ourselves from tokens × price, because OTel has no cost key and MLflow computes it client-side.

---

## 8. Other agent directory standards (brief)

| Effort | What is real today | Source |
|---|---|---|
| **AI Catalog** (MCP, A2A and others) | `/.well-known/ai-catalog.json`, media type `application/ai-catalog+json`, `{specVersion, host, entries[{identifier (urn:air:…), type (media type), url \| data, displayName, description, tags, version}], signature}`. Draft working group. | [V:S46] |
| **AGNTCY OASF** | OASF v1.1.0 (2026-07-10). `record` = `{name, version, schema_version, description, authors, created_at, skills, domains, locators, modules, annotations}`; carries A2A cards and AI Catalog entries through a discovery extension. Agent Directory `agntcy/dir` v1.8.0 (2026-10-15). | [V:S80,S81] |
| **Microsoft Entra Agent ID** | Graph **v1.0** `agentIdentity` (a service principal subtype): `agentIdentityBlueprintId`, `createdByAppId`, `displayName`, `accountEnabled`, `tags`, `managerApplications`, relationships `owners` and **`sponsors`**. Blueprints hold credentials and inheritable permissions. The Graph **beta** Agent Registry `agentInstance` (`url`, `preferredTransport` JSONRPC/GRPC/HTTP+JSON, `agentCardManifest`, `originatingStore`, `ownerIds`) "will be replaced" by Agent 365 registry APIs "starting May 2026". | [V:S82,S83,S84] |
| **Google Cloud Agent Registry** | Product, not a standard. Resource types `Agent`, `McpServer`, `Endpoint` (read-only discovery), writable `Service`, `Skill`/`SkillRevision`/`Publisher` (Preview). URN identifiers. A2A 0.3 and 1.0. | [V:S85] |
| **NANDA** (MIT) | Active GitHub org `projnanda` (`nanda-index-v2`, registry server). Research-stage, no stable spec. | [V:S87] |
| **IETF** | Individual drafts only, none adopted by a working group: `draft-narvaneni-agent-uri-04` (2026-10-20, `agent:` URI and verifiable identity), `draft-cui-ai-agent-discovery-invocation-02`, `draft-raskar-agentic-web-federated-resolution-01`. | [V:S86] |
| **`agents.json`** (wild-card-ai) | OpenAPI-based; repo idle since 2025-08. Do not adopt. | [V:S88] |

The Entra `sponsors` relationship maps directly to our `Owner.kind = "sponsor"` [I].

---

## 9. Unity Catalog OSS

- **Releases:** v0.7.0 (2026-10-13; Iceberg REST, managed storage cleanup, health and metrics), v0.6.0 (2026-08-20; metric views end to end, SQL views), v0.5.0 (2026-06-18; UC Delta API). `unitycatalog-ai` 0.4.0 came out 2026-04-24. [V:S90,S92]
- **REST** (base `http://<host>:8080/api/2.1/unity-catalog`) [V:S91,S90]:
  - `/catalogs`, `/schemas`, `/tables`, `/volumes`, `/functions`, `/functions/{name}`;
  - `/models`, `/models/{full_name}/versions[/{version}[/finalize]]`;
  - `/permissions/{securable_type}/{full_name}`;
  - `/temporary-{table,volume,model-version,path}-credentials`, `/credentials`, `/external-locations`;
  - Iceberg REST at `/api/2.1/unity-catalog/iceberg`; Delta API at `/api/2.1/unity-catalog/delta/v1`.
- **AI:** `UCFunctionToolkit` makes UC functions into agent tools for LangChain, LlamaIndex, OpenAI, AutoGen, DSPy, Gemini and others. [V:S92]
- **No MCP server, agent, or skill objects** exist in UC OSS. A code search of the repo finds no MCP implementation. [V:S90 tree]
- For external, non-Databricks assets, UC OSS can only feed `tool:uc:` (functions) and `model:` nodes [I].

---

## 10. Proposed canonical registry data model, mapped onto `API_CONTRACT.md`

**Principle** [I]: keep the contract's 4 asset types and URN scheme as the core. Put standards payloads in `asset.attributes` (normalized) and `asset.external_ref` (raw IDs and URLs). Add a small number of URN kinds and relations to cover outside-Databricks sources.

### 10.1 Entities and field sources

Source codes:
- **A2A**: Agent Card [S51]
- **SJ**: MCP `server.json` [S34]
- **MCP**: live protocol (`server/discover`, `tools/list`) [S42]
- **SK**: SKILL.md [S60]
- **PL**: Claude plugin / marketplace [S64,S65]
- **OT**: OTel GenAI [S71–S73]
- **ML**: MLflow [S2,S4,S8]
- **EN**: Entra [S83]

**agent** (`asset_type=agent`)

| Canonical field | Contract location | From |
|---|---|---|
| id | `asset_id` | contract URN; external A2A agents need a new kind (§10.3) |
| name, display_name | `name`, `display_name` | A2A `name`; OT `gen_ai.agent.name`; ML Agent Server `/agent/info.name` |
| version | `published_version` / `latest_version` | A2A `version`; OT `gen_ai.agent.version`; ML LoggedModel `model_id` + `name` |
| purpose / description | field `purpose` (≤140, truncated) / `description` | A2A `description`; OT `gen_ai.agent.description` |
| publisher | `publisher`, field `publisher_info` | A2A `provider.organization` and `provider.url`; EN `createdByAppId` |
| endpoint_url | field `endpoint_url` | A2A `supportedInterfaces[0].url` |
| protocols | `attributes.interfaces[]` *(new)* | A2A `supportedInterfaces[{protocolBinding, protocolVersion, url, tenant}]` |
| capabilities | `attributes.capabilities` *(new)* | A2A `capabilities{streaming, pushNotifications, extendedAgentCard, extensions[]}` |
| auth_model | field `auth_model` | A2A `securitySchemes` + `securityRequirements`; EN blueprint |
| declared skills | `attributes.a2a_skills[]` *(new; not `skill:` assets)* | A2A `skills[{id, name, description, tags, examples, inputModes, outputModes}]` |
| example_prompts | field `example_prompts` | A2A `skills[].examples` |
| inputs / outputs | fields `inputs` / `outputs` | A2A `defaultInputModes` / `defaultOutputModes` |
| links | field `links` | A2A `documentationUrl`, `iconUrl` |
| integrity | `attributes.signatures[]` *(new)* | A2A `signatures[]` (JWS) |
| identity | `external_ref.identity` *(new key)* | EN `agentIdentityBlueprintId` and identity ID; Databricks SP application ID (`sp:` node) |
| owners | `asset_owner` (`owner`, `sponsor`) | EN `owners`, `sponsors` |
| telemetry ID | `external_ref.otel_agent_id`, `external_ref.mlflow_experiment_id`, `external_ref.logged_model_id` | OT `gen_ai.agent.id`; ML `mlflow.modelId` |

**mcp_server** (`asset_type=mcp_server`)

| Canonical field | Contract location | From |
|---|---|---|
| name (reverse-DNS) | `name` | SJ `name`; ML MCPServer `name` |
| display_name | `display_name` | SJ `title` |
| version | `published_version` / `latest_version` | SJ `version`; ML version and aliases (`attributes.aliases`) |
| purpose / description | `purpose` / `description` | SJ `description` (≤100); ML `description` |
| endpoint_url / transport | field `endpoint_url`, `attributes.transports[]` *(new)* | SJ `remotes[{type, url, headers, variables}]`; ML MCPAccessEndpoint |
| packages | `attributes.packages[]` *(new)* | SJ `packages[{registryType, identifier, version, fileSha256, transport, environmentVariables[isSecret]}]` |
| repository / links | field `links` | SJ `repository{url, source, subfolder}`, `websiteUrl` |
| icons | `attributes.icons` | SJ / MCP `icons` |
| protocol versions, capabilities | `attributes.protocol_versions[]`, `attributes.capabilities` *(new)* | MCP `server/discover` (2026-07-28) or `initialize` (older) |
| auth_model | field `auth_model` | MCP PRM `/.well-known/oauth-protected-resource`, `WWW-Authenticate scope`; SJ secret env vars; Docker `oauth` |
| source status | `attributes.source_status` *(new)* | SJ `_meta[…/official].status` (`active` \| `deprecated` \| `deleted`); ML version `status` |
| cross-registry | `also_registered_in[]` | official registry, GitHub, MLflow MCP Registry, Docker, Google Cloud |

**tool** (`asset_type=tool`, parent = an MCP server)

| Canonical field | Contract location | From |
|---|---|---|
| name / display_name | `name` / `display_name` | MCP `Tool.name` / `title` |
| description | `description`, `purpose` | MCP `description` |
| inputs / outputs | fields `inputs` / `outputs` (defaults); raw in `attributes.input_schema` / `attributes.output_schema` | MCP `inputSchema` / `outputSchema` |
| behavior hints | `attributes.annotations` (already in the DDL comment) | MCP `annotations{readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`; Docker `tools[].annotations` |
| telemetry key | lineage match key | OT `gen_ai.tool.name`, `gen_ai.tool.type`; ML `TOOL` span name |

**skill** (`asset_type=skill`)

| Canonical field | Contract location | From |
|---|---|---|
| name | `name` | SK `name` (equals the directory name) |
| purpose / description | `purpose` / `description` | SK `description` (≤1024) |
| license | `attributes.license` *(new)* | SK `license`; PL `license` |
| compatibility | `attributes.compatibility` *(new)* | SK `compatibility` |
| allowed_tools | `attributes.allowed_tools[]` *(new; the contract parses it already)* | SK `allowed-tools` |
| version | `published_version` | SK `metadata.version`, else PL `version`, else git SHA |
| publisher | `publisher` | SK `metadata.author`; PL `author.name` |
| packaging | `external_ref.package` *(new)* | PL `{marketplace, plugin, source{github \| git-subdir \| url \| npm…}}`; AI Catalog `type` (`application/agent-skills+zip`, …) |
| client extensions | `attributes.client_ext` | Claude Code fields (`context`, `agent`, `hooks`, …) |
| telemetry key | lineage match key | OT `gen_ai.skill.name`, `gen_ai.skill.source.uri` |

**model** (lineage node `model:<name>`, not an asset)
- Fields: `provider` (OT `gen_ai.provider.name`; ML `mlflow.llm.provider`), `model` (OT `gen_ai.request.model` / `response.model`; ML `mlflow.llm.model`), `serving` (Databricks endpoint, MLflow Gateway endpoint), and `uc_model` (UC OSS `/models/{full_name}/versions`).
- **Gap:** see §10.3.

**data_asset** (lineage nodes `table:`, `index:`, `volume:`)
- From UC lineage (outside this doc), OT `gen_ai.data_source.id`, and ML `RETRIEVER` spans.

**usage and cost** (`usage_event`, `usage_daily`, `cost_daily`)

| Measure | MLflow | OTel |
|---|---|---|
| requests | trace count | span count |
| tokens | `mlflow.trace.tokenUsage` / `mlflow.chat.tokenUsage` | `gen_ai.usage.*` |
| cost | `mlflow.llm.cost` / `mlflow.trace.cost` (else tokens × price) | none |
| consumer | `mlflow.trace.user`, `mlflow.auth.username`, `user.id` | |
| via gateway | `mlflow.gateway.endpointId` | |
| errors | `state=ERROR` | `error.type` |

**evals** (`AssetEvals`)
- Scorer: name, version and digest (`mlflow.assessment.*`).
- Run: `mlflow.genaiEvaluate.*` tags (3.17.2).
- Monitoring scorers: from `/api/3.0/mlflow/scorers/list` and the online configs. [V:S2,S15,S19]

**policies / guardrails** (`PolicyChip`): MLflow Gateway guardrail, mapped as follows [I mapping; V:S2 fields].

| `PolicyChip` field | MLflow guardrail field |
|---|---|
| `kind=guardrail`, `provider=mlflow_gateway` | (fixed) |
| `phase` | `stage`: BEFORE becomes `input`, AFTER becomes `output` |
| `action` | `action`: VALIDATION becomes `block`, SANITIZATION becomes `redact` |
| `config` | `{scorer_name, endpoint_id}` |

**budgets** (`Budget`): from `GatewayBudgetPolicy`.
- `monthly_usd` = `budget_amount` when the duration is MONTHS×1; otherwise normalize it.
- `action` follows `budget_action`: ALERT becomes `alert`, REJECT becomes `block`.
- `source` is a **gap**: the contract allows only `"app" | "unity_gateway"`. Add `"mlflow_gateway"`.

### 10.2 Relationship types

The contract's `lineage_edge.relation` values are `uses_tool`, `calls_agent`, `exposes_tool`, `reads_data`, `writes_data`, `uses_model`, `uses_skill`, `consumes`, `subscribes`, `routes_to`.

| Relation | Status | Declared from | Observed from |
|---|---|---|---|
| `uses_tool` (agent→tool / mcp_server) | exists | A2A extensions; agent config | OT `execute_tool` under `invoke_agent`; ML `TOOL` spans |
| `calls_agent` (agent→agent) | exists | A2A client config | OT `invoke_agent` span kind `CLIENT`; ML `AGENT` child spans |
| `exposes_tool` (mcp_server→tool) | exists | ML MCP Registry `tools[]`; Docker `tools[]` | MCP `tools/list` |
| `uses_model` (= requested `depends_on_model`) | exists | ML LoggedModel; Gateway model definitions | OT `gen_ai.request.model`; ML `mlflow.llm.model` |
| `reads_data` / `writes_data` (= requested `reads_table`) | exist | UC lineage | ML `RETRIEVER` spans; OT `gen_ai.data_source.id` |
| `uses_skill` | exists | PL `plugin.json` `skills` | OT `gen_ai.skill.name` on `load_skill` spans |
| `routes_to` (gateway→model / endpoint) | exists | ML `GatewayEndpointModelMapping` (weight, PRIMARY/FALLBACK) | `mlflow.gateway.linkedTraceId` |
| `consumes` / `subscribes` | exist | registry | usage events |
| **`uses_prompt`** | **gap: add** | ML `mlflow.linkedPrompts` | `POST /traces/link-prompts` |
| **`evaluated_by`** (agent→scorer) | **gap: add** | ML scorer registry and online config | `mlflow.genaiEvaluate.agent.*` + `scorerDigest` |
| **`guarded_by`** (asset→policy) | **gap** (policy_binding covers state, not graph) | ML guardrail attachments | Gateway violations |
| **`bundled_in`** (skill / agent / MCP → plugin) | **gap: add** | PL `marketplace.json` / `plugin.json` | n/a |
| **`same_as`** (cross-registry identity) | **gap** (currently `also_registered_in` JSON) | name or URL match across official, GitHub, MLflow and Docker registries | n/a |
| **`runs_as`** (agent→`sp:` / Entra identity) | **gap: add** | Databricks app or endpoint SP; EN `agentIdentity` | trace `mlflow.auth.*` |

### 10.3 Gaps against `API_CONTRACT.md` (URN scheme and field catalog)

1. **No URN kinds for assets outside Databricks.** Proposed additions [I]:

   | Proposed URN | Asset |
   |---|---|
   | `agent:a2a:<host><path>` | key = the Agent Card URL without `/.well-known/agent-card.json` |
   | `agent:app:<app_name>` | a Databricks App agent; the contract has only the lineage node `app:` |
   | `mcp:registry:<server.json name>` | e.g. `mcp:registry:io.github.acme/crm`; source of truth for SJ-identified servers, with `also_registered_in` listing official, GitHub, MLflow, Docker |
   | `mcp:docker:<name>` | only when there is no `server.json` name |
   | `skill:plugin:<marketplace>/<plugin>/<skill>` | skill shipped in a plugin |
   | `skill:git:<host>/<owner>/<repo>/<path>` | skill in a git repo |

   `skill:custom:<slug>` is not unique, because SKILL.md `name` is unique only inside one directory.
2. **Tool URN parsing is ambiguous.** `tool:mcp:<server urn without "mcp:">/<tool_name>` breaks when the server ID contains `/`, which every `server.json` name does (`ns/slug`). Use a separator that cannot occur, such as `#` (`tool:mcp:registry:io.github.acme/crm#get_account`), or always split on the last `/` (tool names never contain `/` [I]). [V:S34 name pattern]
3. **The `model:<name>` lineage node is too coarse.** It cannot tell apart a UC model version, a serving endpoint, a provider model behind the MLflow Gateway, and an MLflow LoggedModel. Use subtypes [I]: `model:uc:<c.s.m>/<v>`, `model:endpoint:<name>`, `model:provider:<provider>/<model>`, `model:mlflow:<m-id>`.
4. **Missing lineage node kinds:**
   - `prompt:` (`prompt:mlflow:<name>/<v>`, `prompt:uc:<c.s.name>`);
   - `scorer:` (`scorer:mlflow:<exp_id>/<name>`);
   - `dataset:` (`dataset:mlflow:<id>`);
   - `gateway:` (`gateway:mlflow:<endpoint>`, `gateway:databricks:<endpoint>`);
   - `plugin:`;
   - `NodeType` would need matching values. [I]
5. **The field catalog has no protocol or interoperability fields.** Proposed `attributes` keys, not description fields [I]: `version` (the asset already has `published_version`), `interfaces[]` / `transports[]`, `protocol_versions[]`, `capabilities`, `annotations`, `packages[]`, `license`, `compatibility`, `allowed_tools`, `signatures[]`, `source_status`, `icons`.
6. **`support_channel` and `sla` have no standard source.** A2A, `server.json` and SKILL.md carry neither. Nearest proxies: `server.json` `websiteUrl`, A2A `provider.url`, Claude plugin `supportUrl`. Expect these fields to be owner-authored.
7. **`purpose` limits.** At ≤140 it fits SJ `description` (≤100), but A2A and SK descriptions need truncation with `source_label` "A2A Agent Card" / "SKILL.md frontmatter". (The contract already notes the SKILL.md source label.)
8. **Source status is not lifecycle.** Upstream status (`active`, `deprecated`, `deleted`; MLflow `draft`) must not set `lifecycle_status` directly. Proposed handling [I]:
   - store it in `attributes.source_status`;
   - map `deleted` to `runtime_status=blocked` and raise a curation item;
   - map `deprecated` to a change event (non-breaking) that notifies subscribers.
9. **`Budget.source` lacks `mlflow_gateway`**, and `PolicyChip.provider` should allow `mlflow_gateway`.
10. **Risk-tier default from annotations.** When a tool has no annotations, MCP defaults (destructive=true, openWorld=true) should feed `risk_tier`. Store the *effective* annotations and a flag `annotations_declared: false`. [V:S42 defaults; I for policy]
11. **Export and federation.** Two optional read-only surfaces would make the hub interoperable [I]:
    - `GET /v0.1/servers` (an MCP subregistry), so Copilot and VS Code can use it as the enterprise MCP Registry URL;
    - `GET /.well-known/ai-catalog.json`, listing A2A cards, Server Cards and skills.

    Neither is in the contract today.

---

## Sources

All pages were accessed 2026-10-25/26. GitHub source is pinned to the tag named.

**MLflow**
- S1: MLflow releases (v3.17.2 2026-10-21 … v3.4.0) and the repo tree at v3.17.2: https://github.com/mlflow/mlflow/releases · https://github.com/mlflow/mlflow/tree/v3.17.2
- S2: `service.proto` (REST paths, TraceInfoV3, LoggedModel, Gateway, budgets, guardrails): https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/protos/service.proto · webhooks: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/protos/webhooks.proto · model registry: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/protos/model_registry.proto
- S3: `assessments.proto`: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/protos/assessments.proto
- S4: tracing constants: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/tracing/constant.py
- S5: `SpanType`: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/entities/span.py
- S6: Databricks tracing proto (UC trace locations): https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/protos/databricks_tracing.proto
- S7: MLflow MCP Registry docs: https://mlflow.org/docs/latest/genai/mcp-registry/
- S8: MCP Registry REST router: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/server/mcp_server_api.py · UI client: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/server/js/src/mcp-registry/api.ts
- S9: MCP Registry Python API: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/genai/mcp_servers.py · `mlflow.genai` exports: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/genai/__init__.py
- S10: MLflow MCP server docs: https://mlflow.org/docs/latest/genai/mcp/ · CLI: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/mcp/cli.py
- S11: Gateway routes: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/server/gateway_api.py · passthrough routes: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/gateway/providers/base.py · legacy CLI deprecation: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/gateway/cli.py
- S12: AI Gateway docs (guardrails, budgets, usage tracking): https://mlflow.org/docs/latest/genai/governance/ai-gateway/
- S13: Automatic evaluation: https://mlflow.org/docs/latest/genai/eval-monitor/automatic-evaluations/
- S14: Scorer register/start (MLflow vs Databricks store): https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/genai/scorers/base.py
- S15: Online-scoring config endpoints (internal): https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/server/handlers.py
- S16: Agent Server docs: https://mlflow.org/docs/latest/genai/serving/agent-server/ · server: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/genai/agent_server/server.py
- S17: GenAI semconv export: https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv · OTLP ingest: https://mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest
- S18: Export translator: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/tracing/export/genai_semconv/translator.py · ingest translator: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/tracing/otel/translation/genai_semconv.py
- S19: PR #26543 (eval lineage tags): https://github.com/mlflow/mlflow/pull/26543
- S20: Prompt constants: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/prompt/constants.py · UC prompt service: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/protos/unity_catalog_prompt_service.proto
- S21: Labeling and Review App (Databricks-only): https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/genai/labeling/__init__.py
- S22: Version tracking: https://mlflow.org/docs/latest/genai/version-tracking/track-application-versions-with-mlflow/ · fluent API: https://github.com/mlflow/mlflow/blob/v3.17.2/mlflow/tracking/fluent.py
- S23: Live workspace probe (internal): `docs/research/04-live-workspace-probe.md`

**MCP**
- S30: Official registry API: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md
- S31: Generic registry API: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/generic-registry-api.md
- S32: OpenAPI: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml
- S33: API changelog: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/CHANGELOG.md
- S34: `server.json` schema 2025-12-11: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json · spec and examples: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- S35: `server.json` changelog: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md
- S36: Aggregators and about (preview status): https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/registry-aggregators.mdx · https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/about.mdx
- S37: Live call: https://registry.modelcontextprotocol.io/v0.1/servers?limit=2&version=latest
- S38: GitHub blog, "Meet the GitHub MCP Registry" (2025-09-16): https://github.blog/ai-and-ml/github-copilot/meet-the-github-mcp-registry-the-fastest-way-to-discover-mcp-servers/
- S39: GitHub Docs, restrict MCP by registry: https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/restrict-based-on-registry
- S40: Docker server entry spec: https://github.com/docker/mcp-gateway/blob/main/docs/server-entry-spec.md · catalog: https://github.com/docker/mcp-registry
- S41: MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog · release: https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28
- S42: MCP schema 2026-07-28: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
- S43: MCP authorization 2026-07-28: https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2026-07-28/basic/authorization
- S44: Anthropic, MCP donated to the Agentic AI Foundation (2025-12-09): https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation
- S45: MCP Server Cards (experimental): https://github.com/modelcontextprotocol/ext-server-card
- S46: AI Catalog spec: https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md · https://ai-catalog.io/

**A2A**
- S50: A2A releases: https://github.com/a2aproject/A2A/releases
- S51: `a2a.proto` v1.0.1: https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto
- S52: Specification v1.0.1: https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md
- S53: Governance: https://github.com/a2aproject/A2A/blob/main/GOVERNANCE.md
- S54: Linux Foundation press release (2026-04-09): https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year

**Agent Skills and Claude plugins**
- S60: Agent Skills spec: https://agentskills.io/specification
- S61: Repo: https://github.com/agentskills/agentskills
- S62: Client implementation: https://agentskills.io/client-implementation/adding-skills-support
- S63: Claude Code skills: https://code.claude.com/docs/en/skills
- S64: Plugin marketplaces: https://code.claude.com/docs/en/plugin-marketplaces
- S65: Plugin manifest: https://code.claude.com/docs/en/plugins/manifest-reference
- S66: skills.sh: https://skills.sh

**OpenTelemetry**
- S70: GenAI semconv repo and manifest: https://github.com/open-telemetry/semantic-conventions-genai · https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/manifest.yaml
- S71: Agent spans: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- S72: Model spans and `execute_tool`: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- S73: `gen_ai.*` attribute registry: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md
- S74: GenAI entities: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/entities/gen-ai.md
- S75: MCP attributes: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/mcp.md
- S76: Core semconv v1.42.0 (GenAI moved out): https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.42.0

**Other directories**
- S80: AGNTCY OASF: https://github.com/agntcy/oasf (record: https://github.com/agntcy/oasf/blob/main/schema/objects/record.json)
- S81: AGNTCY Directory: https://github.com/agntcy/dir/releases
- S82: Entra agent identity blueprint: https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-blueprint
- S83: Graph v1.0 `agentIdentity`: https://learn.microsoft.com/en-us/graph/api/resources/agentidentity
- S84: Graph beta `agentInstance` (replacement notice): https://learn.microsoft.com/en-us/graph/api/resources/agentinstance?view=graph-rest-beta
- S85: Google Cloud Agent Registry concepts: https://docs.cloud.google.com/agent-registry/concepts
- S86: IETF datatracker: https://datatracker.ietf.org/doc/draft-narvaneni-agent-uri/ · https://datatracker.ietf.org/doc/draft-cui-ai-agent-discovery-invocation/ · https://datatracker.ietf.org/doc/draft-raskar-agentic-web-federated-resolution/
- S87: NANDA: https://github.com/projnanda
- S88: agents.json: https://github.com/wild-card-ai/agents-json

**Unity Catalog OSS**
- S90: Releases and tree: https://github.com/unitycatalog/unitycatalog/releases
- S91: OpenAPI: https://github.com/unitycatalog/unitycatalog/blob/main/api/all.yaml
- S92: UC AI changelog: https://github.com/unitycatalog/unitycatalog/blob/main/ai/CHANGELOG.md
