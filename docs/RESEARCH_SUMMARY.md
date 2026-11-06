# Agent Registry Hub: research summary

This summary condenses five detailed research notes (all in [`docs/research/`](research/)):

| # | Note | What it covers |
|---|---|---|
| 01 | [Databricks platform APIs](research/01-databricks-platform-apis.md) | Agent Bricks, Unity Gateway, MCP services, skills, permissions, RFA, budgets, traces, lineage, OBO scopes |
| 02 | [OSS MLflow + open standards](research/02-oss-mlflow-and-standards.md) | MLflow 3.17, MCP Registry `server.json`, A2A Agent Card, SKILL.md, OTel GenAI conventions |
| 03 | [UX benchmark](research/03-ux-benchmark.md) | ~35 products: Agent 365, AWS Agent Registry, MuleSoft Agent Fabric, ServiceNow AI Control Tower, Backstage/Port, APIM portals, LangSmith… |
| 04 | [Live workspace probe](research/04-live-workspace-probe.md) | Real API shapes, counts and gotchas from `your-workspace` (read-only), with 21 JSON samples; §17 external lineage and MCP service shapes (2026-10-28) |
| 05 | [Microsoft Agent 365 interop](research/05-agent365-interop.md) | Connected platforms (Databricks Genie), the registry export, the Graph Package Management API, and how the hub matches Microsoft IDs into "Also registered in" |

Researched 2026-10-25/26. Each claim in the notes is tagged Doc, Live, Internal, Inferred or Unverified. Items marked [INTERNAL] there are Databricks-internal and must not be shared outside.

## 1. What the platform gives us (and what it doesn't)

**Unity Catalog is becoming the system of record for AI assets.** MCP services (GA, Sep 2026), skills (Beta), model services, and agent services (Beta, registry only) are UC securables with owners, grants and comments. The hub **indexes** these instead of re-inventing them. It then adds what no API provides: email-identified consumers, access-approval workflows with expiry, field-level description provenance, change-impact tracking, and a cross-asset lineage graph.

| Need | Platform source (verified) | Gap the hub fills in Lakebase |
|---|---|---|
| Agent inventory | Serving endpoints `task=agent/*` (89 here); `/api/2.1/supervisor-agents` (+`/tools`), `/api/2.1/knowledge-assistants` (+sources); Genie `/api/2.0/genie/spaces`; Agent Runtime apps `agent-bricks-*` | One catalog across all four, with owners, descriptions and trust badges |
| MCP inventory | UC HTTP connections with `options.is_mcp_connection="true"` (95 here); managed MCP for UC-function schemas and Genie; UC **MCP services** (`/api/2.1/unity-catalog/mcp-services?parent=schemas/c.s`); Databricks-provided `system.ai.*` servers (e.g. **`system.ai.microsoft_365`**), visible in `system.ai_gateway.usage` | General info is auto-pulled (publisher, auth model, URL, `tools/list`); **admins override fields** with provenance, and drift is detected |
| Tools | UC functions (`information_schema.routines`: 409 in 94 schemas); MCP `tools/list` (name, schemas, readOnly/destructive hints) | Side-effect classification, per-tool usage, a review state |
| Skills | UC Skills API (Beta; list per schema; privileges reuse READ/WRITE VOLUME); SKILL.md open standard | Register a SKILL.md in the app, with a steward approval gate |
| Owners | `creator`, `owner`, `effective_owner`, Genie ACL `CAN_MANAGE` | Owner, co-owner, sponsor and steward; an ownerless queue |
| Usage | `system.ai_gateway.usage` (FMAPI + MCP per request, `requester`, tokens, `mcp_metadata.tool_name`); `system.serving.endpoint_usage`; audit `mcpService.mcpCall` | **Every use registered with an email** (`POST /api/v1/usage`, UI) → downstream impact |
| Cost | `system.billing.usage × list_prices` (incl. `AGENT_BRICKS`, `SUPERVISOR_AGENT`); `external_model_spend` (USD) | Unit economics ($/1k requests, $/user), budgets, anomaly flags. MCP $ has no direct source, so it is allocated |
| Traces & evals | MLflow 3 trace search `POST /api/3.0/mlflow/traces/search` per experiment; assessments; `system.mlflow.run_metrics_history` | Owner-facing traces/evals tab; consumers see only their own traces |
| Permissions | UC `/permissions/{type}/{name}`; workspace ACLs for endpoints and Genie | — |
| Access requests | RFA `POST /api/3.0/rfa/requests` exists, but **no API lists or approves requests**, and MCP services and skills aren't covered | The hub's own request → approve → provision flow (SLA, expiry, reminders) |
| Guardrails | Unity Gateway **service policies** (Beta): built-ins `block_unsafe_content`, `block_jailbreak`, `detect_sensitive_data`; custom ALLOW/DENY/**ASK** UDFs. Attach is **UI-only**, with **no list API**. Legacy endpoint `ai_gateway.guardrails` (only 4 endpoints here) | Policy inventory + coverage per risk tier, gaps, and violations (from `gateway_feature_results.service_policies[]`) |
| Lineage | UC lineage has **no agent/serving entity types**; Supervisor tools, KA sources, Genie `serialized_space`, app `resources[]`, model-version dependencies | A stitched graph with declared, observed and data edges, plus impact highlighting |
| Budgets | Account budgets API (`BUDGET_RESOURCE_TYPE_UNITY_AI_GATEWAY`, `BLOCK_USAGE` Beta) | App budgets with forecasts; Unity Gateway budgets shown when present |

**Naming (Oct 2026):**
- Mosaic AI Gateway → Unity AI Gateway → **Unity Gateway** (GA Aug 4).
- Genie spaces → **Genie Agents**.
- Knowledge Assistant and Supervisor Agent are **legacy** (Oct 12). Code-first agents deploy to **Agent Runtime** as Apps.
- The legacy `/api/2.0/mcp/...` proxy **bypasses** Unity Gateway policies. The governed path is `/ai-gateway/mcp-services/<fqn>`.

## 2. OSS MLflow and open standards

- **MLflow 3.17 (OSS) has no agent, tool or skill registry.** Its only registry is an experimental **MCP server registry** (`/api/3.0/mlflow/mcp-servers`, 3.15+). Tracing, assessments, `genai.evaluate`, scheduled scorers and the rewritten **MLflow AI Gateway** (budgets plus LLM-judge guardrails) are OSS. The Review App and traces-in-UC are Databricks-only.
- **MCP Registry v0.1** (`/v0.1/servers`, `server.json` 2025-12-11) is the de-facto catalog format. **The hub serves it** (`/v0.1/servers`), so Copilot and VS Code can use the hub as an enterprise MCP Registry URL.
- **A2A Agent Card** (v1.0.1) describes external agents. **SKILL.md** frontmatter (`name` ≤64, `description` ≤1024, `allowed-tools`) describes skills, and the hub parses it. **OTel GenAI** conventions (`gen_ai.agent.*`, `gen_ai.tool.*`) are still Development stability.

## 3. UX patterns adopted (from the benchmark)

1. A role-aware **"Top actions for you"** strip on Home (Agent 365).
2. **One typed catalog** with facets and quick chips (AWS Agent Registry, M365).
3. **Two status axes**: governance lifecycle and runtime (AWS, Foundry).
4. **Trust badges with fixed meanings**: Certified, Verified publisher, Unreviewed, Deprecated (UC certification, Docker).
5. **Field-level provenance**: "Auto-pulled", "Edited by owner" and "Edited by admin", with drift detection (AWS URL sync, ServiceNow).
6. **Request access everywhere**, with an SLA, a reminder at day 3, expiry at day 7, a required deny reason, and a provision choice for the approver (UC RFA, Port).
7. **Subscription as a contract**: email required, team DLs, downstream declaration (Azure APIM).
8. **Impact acknowledgement loop**: notify, then "not impacted", "will migrate by <date>" or "need help". No benchmarked product does this; it is our differentiator.
9. **Impact preview before publish**, with pre-publish checks and 14-day notice for breaking changes (APIM, Cortex).
10. A **lineage graph**: declared edges dashed, observed solid, data dotted; focus, depth and impact modes; consumer privacy (MuleSoft Agent Visualizer, UC lineage).
11. **Policy coverage as a headline metric**: chips, a coverage meter, violations over 7 days (Databricks Governance Hub).
12. **Unit economics marked "Estimated"**, with freshness notes (Unity Gateway cost observability).

## 4. Key gotchas the build had to absorb (from the live probe)

- **App cap:** the workspace is at the **100-app cap**, so deploying needs a free slot.
- **Admin-only visibility:** `system.ai_gateway.usage` is admin-only by default, and listings are caller-scoped. Collectors therefore run as the deployer in a job and land aggregates in Lakebase.
- **Usage gaps:** agent endpoints are almost absent from the usage tables (usage tracking is on for 6 of 208 endpoints). Agent activity therefore also comes from MLflow traces and from **email-registered usage**.
- **Billing joins:** `usage_metadata.endpoint_name` is a shared namespace (Vector Search reuses it), so join on `(billing_origin_product, endpoint_name)`.
- **`destructiveHint`:** it is `true` on every UC-function MCP tool, so it isn't a risk signal there.
- **External MCP `tools/list`:** returns 403 without USE CONNECTION. The registry then marks the tools as "access required", and **Request access** is the remedy.
