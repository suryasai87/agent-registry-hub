# 03 - UX Benchmark: Enterprise Agent Registry and MCP / Tools / Skills Catalog

**Project:** Agent Registry Hub (Databricks App - React 19 + Tailwind v4 HSL tokens + framer-motion + recharts; FastAPI; Lakebase Postgres)
**Author role:** Senior product designer / researcher
**Research date:** 2026-10-25
**Method:** Public web search plus direct reads of product docs, launch blogs and release notes. Glean was not used. Screenshots were not viewed directly; UI descriptions come from the doc text that describes those screenshots.

**How to read the tags**

- A claim with an inline source link was checked against that source on 2026-10-25.
- **(Inferred)** = a claim about a product that the sources do not fully confirm. It may come from a secondary summary or marketing copy, or be our reading of the material.
- **(Recommendation)** = our design choice for Agent Registry Hub. No single product is the precedent for it.
- Naming note: Databricks docs dated October 2026 call the gateway **Unity Gateway** (formerly Unity AI Gateway), with an **MCPs** page under it ([Databricks MCP docs](https://docs.databricks.com/aws/en/generative-ai/mcp/), [Unity Gateway budgets](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/budgets)). This doc says "Unity Gateway" to match the current UI.

---

## 1. Executive summary - the 12 UX patterns we must adopt

| # | Pattern (one line) | Inspired by |
|---|---|---|
| 1 | **Actionable governance tiles** that open pre-filtered lists ("Agents without owners", "Agents at risk", "Pending requests", "Agents with exceptions"), shown as a role-aware **"Top actions for you"** strip on Home. | Microsoft Agent 365 / M365 admin center ([overview](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-365-overview?view=o365-worldwide), [registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide)) |
| 2 | **One catalog with typed records** (Agent, MCP, Skill, Custom/Tool), faceted by type, publisher/source, status, channel and platform, with **Customize view**, Normal/Compact density and **Export**. | AWS Agent Registry record types ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)); M365 Registry filters and actions |
| 3 | **An explicit lifecycle state machine with a required reason on each transition** (Draft, Pending approval, Approved, Rejected, Deprecated), a status-count summary, and events on every change. | AWS Agent Registry ([reviewing](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-reviewing-records.html), [EventBridge](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-eventbridge.html)) |
| 4 | **Trust badges with fixed meanings:** Certified / Deprecated (the same semantics as Unity Catalog), Verified publisher with signed provenance, plus a dedicated **Certification** tab. | Databricks `system.certification_status` ([docs](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data)); Docker MCP Catalog ([catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/)); M365 Certification tab ([agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide)) |
| 5 | **Entity pages whose tabs depend on capability**: a tab appears only when it applies to that entity. One-click lifecycle controls (Block / Pause / Stop) need a confirmation and keep the configuration so it can be restored. | M365 agent details tabs; Foundry Control Plane **Update status** ([manage agents](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents)); ServiceNow **Runtime Pause Controls** ([AICT Aug/Sep 2026](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)) |
| 6 | **"Request access" wherever a permission wall appears.** Requests route to configured destinations, send reminders, expire, require a reason to decline, and the approver picks the grant type ("Provision"). | Databricks UC access requests ([docs](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests)); Port "Enforce manual approval" ([docs](https://docs.port.io/workflows/actions-and-automations/create-self-service-experiences/set-self-service-actions-rbac/)) |
| 7 | **Subscription as a contract**: requires approval, carries legal terms and a subscriber list, and comes with a public **change log** and Deprecation/Sunset semantics for breaking changes. | Azure APIM products and revisions ([products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-add-products), [revisions](https://learn.microsoft.com/en-us/azure/api-management/api-management-revisions)); RFC 9745 / RFC 8594 |
| 8 | **Field-level provenance** for auto-pulled metadata ("synced from source" vs "edited by admin"). URL-based sync is kept up to date, and a human approves every AI-suggested enrichment. | AWS Agent Registry URL sync ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)); M365 read-only **Data & Tools**; ServiceNow **Inventory Enrichment Agent** with steward review |
| 9 | **A lineage graph with declared (dashed) vs observed (solid) edges** and governance shields on nodes. It shows one hop by default with "+" to expand, masks nodes the user cannot see, and opens a details card on click. | MuleSoft Agent Visualizer ([components](https://docs.mulesoft.com/agent-visualizer/agent-visualizer-components)); UC lineage ([docs](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage)); Apigee API hub **Supply chain** tab ([docs](https://docs.cloud.google.com/apigee/docs/apihub/manage-api-dependencies)) |
| 10 | **Unit economics and budgets backed by real billing**: Estimated cost and token columns, thresholds that alert or block, per-user overrides, and freshness labels that explain why numbers disagree. | Foundry Assets columns; Databricks Unity Gateway budgets and cost observability ([budgets](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/budgets), [cost](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/cost-observability)) |
| 11 | **Policy coverage as a headline metric** ("Governed Traffic %"), policy chips on each asset, a read-only recommendations panel, and "missing coverage" markers on the graph. | Databricks Governance Hub AI page ([docs](https://learn.microsoft.com/en-us/azure/databricks/admin/governance-hub/ai)); MuleSoft shields; Unity Gateway **Policies** tab ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)) |
| 12 | **A trace, eval and version-compare loop**: a traces table with one column per assessment, "Filter with AI", Summary vs Details & Timeline views, and eval-run comparison before any publish. | Databricks MLflow 3 trace UI ([docs](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/observe-with-traces/ui-traces)); LangSmith dashboards ([docs](https://docs.langchain.com/langsmith/dashboards)); Langfuse cost tracking ([docs](https://langfuse.com/docs/observability/features/token-and-cost-tracking)) |

**Notable finding:** Microsoft Agent 365 **Connected platforms** now syncs **Databricks Genie** agents (alongside Bedrock, Vertex AI, Agentforce, Anthropic Claude Managed Agents, Oracle and Snowflake Cortex) into the M365 registry ([connected platforms](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms)). Customers may therefore see the same Databricks agent in two registries. Agent Registry Hub should expose stable IDs and an "Also registered in" field so records can be matched across registries (Recommendation). Built in v0.3.0: see [05-agent365-interop.md](05-agent365-interop.md) for the Microsoft API and export surface (2026-10-28).

---

## 2. Per-product benchmark

### 2.1 Summary table

| Product | Category | What it does well | Concrete UI patterns worth copying | Source |
|---|---|---|---|---|
| **Microsoft Agent 365 / M365 admin center** | Agent registry + control plane | Turns governance gaps into one-click triage; risk aggregated from multiple security tools | Tiles: **Total agents / Agents without owners / Unmanaged agents / Agents at risk**. Filters: **Status, Publisher Type, Channel, Platform, Data source**. Actions: **Refresh, Export, Add agent, Manage pinned agents, Customize view, Search**. Normal/Compact list. **Risks** column opens a pane with High/Medium/Low groups, **Occurrences**, and "sourced from" deep links | [Registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide), [Overview](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-365-overview?view=o365-worldwide) |
| M365 agent details flyout | Entity page | Shows tabs based on capability; trust signals sit next to the deploy decision | Tabs: **Details, Users, Data & Tools, Security, Permissions, Certification, Activity, Agent instances, Connected Agents, Computer use**. Actions **Install / Uninstall / Block / Update in store / Pin for users**. Up to 5 tags. **Installed for** vs **Available to** | [Agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide) |
| Agent 365 Connected platforms | External discovery | Read-only sync with clear status | Per connection: last run, sync status, total synced agents, errors, **Sync agents** (manual), **Collect agent observability data** toggle | [Connected platforms](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms) |
| **Microsoft Entra Agent ID** | Agent identity | Owners **and** sponsors; agent blueprints; access packages for agents | Owners/sponsors pair; blueprint (template) with child identities; Conditional Access and ID Protection for agents | [Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/) |
| **Copilot Studio admin (Power Platform)** | Maker-platform governance | Inventory fields plus sharing limits plus DLP for agent tools | Inventory includes quarantine, sharing (viewers/editors), capability counts, connectors and knowledge (Inferred: field list from secondary summary). Managed Environments sharing limits; DLP data policies that block connectors and tools | [Agent inventory](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-agent-inventory), [DLP](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-data-loss-prevention) |
| **Azure AI Foundry Control Plane** | Fleet ops | Health, cost and identity in one inventory row; lifecycle verbs per platform | **Operate > Assets > Agents** columns: **Name, Source, Project, Status (Running/Stopped/Blocked/Unknown), Version, Published as, Error rate, Estimated cost, Token usage, Runs, Monitoring features, Entra ID**. **Traces** tab (Trace ID, Conversation ID). **Update status > Stop/Start/Block/Unblock**. Reader/Contributor/Owner roles | [Manage agents](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents), [Overview](https://learn.microsoft.com/en-us/azure/foundry/control-plane/overview) |
| **AWS Agent Registry (AgentCore)** | Registry + curation | Cleanest publish-and-curate state machine; records checked against protocol schemas | Record types **AGENT / MCP / SKILL / CUSTOM**; `name` + `recordVersion` unique. Personas **Administrator, Publisher, Curator/Approver, Consumer**. States DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, DEPRECATED. **Pending approval** counter; **Update status** with **Reason**. URL-based sync via credential provider. Hybrid search; native MCP endpoint | [Registry](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html), [Concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html), [Review](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-reviewing-records.html) |
| AgentCore Gateway / Identity / Policy / Observability / Evaluations | Runtime governance | Natural-language policy authoring with a log-only mode; evaluator scores attached to traces | Gateway turns APIs into MCP tools with auth and interceptors. Policy: write rules in natural language, translated to Cedar, with a choice of **LOG_ONLY** or **ENFORCE** (Inferred: mode names from secondary summary). CloudWatch GenAI Observability "Sessions & traces" shows evaluator scores and judge reasoning | [Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html), [Policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html), [Evaluations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations.html), [CloudWatch](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/session-traces-evaluations.html) |
| **AWS Marketplace - AI agents & tools** | External catalog | Buy, deploy and govern in one place; filter by protocol | Filters for MCP vs A2A and agent vs tool; "deploy to AgentCore" path (Inferred: exact filter labels) | [What's New](https://aws.amazon.com/about-aws/whats-new/2025/07/ai-agents-tools-aws-marketplace/), [Buyer guide](https://docs.aws.amazon.com/marketplace/latest/buyerguide/buyer-ai-agents-products.html) |
| **Google Cloud Agent Registry** (Next '26) | Registry + enforcement | The registry feeds the gateway's policy checks; URN identities | Types: agents, MCP servers + tools, endpoints, skills (Preview); publishers for skills. URNs `urn:agent:…`, `urn:mcp:…`. Workloads in the governance project register automatically; remote ones are registered as `Service`. Agent Gateway checks IAM and content-security policies | [Overview](https://docs.cloud.google.com/agent-registry/overview), [Identifiers](https://docs.cloud.google.com/agent-registry/identity-and-identifiers) |
| **Gemini Enterprise Agent Gallery** | End-user gallery | Consumer-first discovery with in-app request access | Search; chips **All, Pinned, Made by Google, From your organization, Your agents, Marketplace**; **Draft / Live** badges; pin to navigation. Marketplace card > **Request access** > admin approves > bell notification | [Agent Gallery](https://docs.cloud.google.com/gemini/enterprise/docs/agent-gallery), [Share review](https://docs.cloud.google.com/gemini/enterprise/docs/workflow-builder/share-chat-agent) |
| **Vertex AI Agent Engine** (now Gemini Enterprise Agent Platform) | Runtime | Managed runtime, sessions and memory; renamed products | Console renamed; Agent Garden / Cloud API Registry for MCP tools (Inferred: current console layout) | [Name changes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/vertex-ai-name-changes) |
| **Apigee API hub** | API catalog | MCP is a first-class API style; dependency graph at operation level | **Supply chain** tab with an interactive consumer-to-supplier graph per operation; global **API supply chain** list. Apigee manual key approval shows **Pending approval** | [MCP in API hub](https://docs.cloud.google.com/apigee/docs/apihub/register-mcp-apis), [Dependencies](https://docs.cloud.google.com/apigee/docs/apihub/manage-api-dependencies), [App approval](https://cloud.google.com/apigee/docs/api-platform/publish/creating-apps-surface-your-api) |
| **MuleSoft Agent Fabric** (Registry, Broker, Visualizer, Governance) | Cross-vendor agent network | Best agent-network map; scanners find shadow agents | Visualizer nodes: **Agentforce agents, Agents, Brokers, MCP servers**. Dashed = declared, solid = runtime edges. **Shield** = Omni Gateway-protected. Details card sections: Identity / Capabilities / Deployment / Governance / Health & links. MCP card ranks tools by throughput (top 10, **Show More**). Metrics: **Successful Requests, Failed Request Rate, A2A Calls Sent, MCP Calls Sent**. Production/Sandbox layers; 500-node cap with search. Registry shows "conformance status and instance health before you use an asset"; scanners report last-run results | [Agent Fabric](https://docs.mulesoft.com/general/agent-fabric-overview), [Visualizer components](https://docs.mulesoft.com/agent-visualizer/agent-visualizer-components), [Navigate network](https://docs.mulesoft.com/agent-visualizer/view-and-navigate-agent-network) |
| **Salesforce Agentforce Observability** | Agent ops | KPI cards, drill-down to traces, alerting | KPI cards, time-series charts, session trace waterfalls, alerts (Inferred: layout taken from marketing and summaries) | [Agentforce Observability](https://www.salesforce.com/agentforce/observability/) |
| **ServiceNow AI Control Tower** | AI asset system of record | Managed vs unmanaged triage; steward-gated enrichment; kill switch; value / ROI | **Inventory > Assets** columns: **Name, Asset type, State, Status, Managed status, Domain, Managed by, Risk classification, Updated**. Duplicates grouped for steward review. 2026 additions: **Kill Switch**, **Inventory Enrichment Agent** (completeness score, steward reviews), cost by asset/user/department, **MCP Tool Catalog & Governance**, **Runtime Pause Controls**, **Change & Offboarding Workflows** (sign-offs + dependency reviews) | [Inventory](https://www.servicenow.com/docs/r/zurich/intelligent-experiences/disc-ai-asset-inventory.html), [Aug/Sep 2026](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749) |
| **Workday Agent System of Record** | HR-style agent directory | Agents treated like workers: identity, permissions, lifecycle | Lifecycle **register, configure, activate, deactivate, archive**; "Agent System User" identity; inherits security groups; activity record. Consumption shown in Platform Consumption Console (Inferred: secondary summary) | [ASOR](https://www.workday.com/en-us/ai-platform/agent-system-of-record.html) |
| **Kong Konnect Catalog + MCP Registry** | API/AI catalog | MCP registry built on the open MCP Registry API; packages vs remotes | Entities: APIs, API packages, AI Models, MCP servers, **MCP registries (tech preview)**, Agents (beta). Reverse-DNS server names, semver, **Publish**. Dev Portal app registration is auto-approve or manual. Per-tool ACLs in AI Gateway | [Catalog](https://developer.konghq.com/catalog/), [MCP registry](https://developer.konghq.com/catalog/mcp-registry/), [Dev Portal self-service](https://developer.konghq.com/dev-portal/self-service/) |
| **Docker MCP Catalog & Toolkit** | MCP distribution | Trust tiers tied to supply-chain evidence; org-curated catalogs | Groups: **Verified servers** (provenance + SBOM), **Partner tools**, **Docker-built servers** (signed), **Remote services**; Local vs Remote; profiles; **Import catalog** (OCI) to limit approved servers and versions | [Catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/) |
| **GitHub MCP Registry** | MCP discovery | Popularity ranking, one-click install, enterprise allowlist | Sorted "by GitHub stars and community activity"; one-click install in VS Code. Copilot policy **Restrict MCP access to registry servers: Allow all / Registry only**; `allowedMcpServers` / `deniedMcpServers` | [Launch blog](https://github.blog/ai-and-ml/github-copilot/meet-the-github-mcp-registry-the-fastest-way-to-discover-mcp-servers/), [Restrict](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/restrict-based-on-registry) |
| **Official MCP Registry** | Upstream metadata | Verified namespace ownership | Reverse-DNS names (`io.github.user/…`); ownership checked via GitHub OAuth/OIDC, DNS or HTTP; publish with `mcp-publisher`; preview since 2025-09-08; API freeze v0.1 | [Repo](https://github.com/modelcontextprotocol/registry) |
| **Smithery** | MCP marketplace | A single-number quality score; try before installing | Header: identifier, "last deployed", **Try now**, **85/100** quality score, **Typed Output** badge; Homepage / Published / Repository / License / Tool Calls; **Verified** filter. Proxy shuts down Oct 31 | [Server page](https://smithery.ai/servers/checklist-day/registry) |
| **Backstage Software Catalog** | Developer portal | Entity graph card that expands into a full graph view | `EntityCatalogGraphCard` on the entity page leads to `CatalogGraphPage`; filter by relation and kind; custom nodes; card-to-full-view pattern | [catalog-graph](https://github.com/backstage/backstage/blob/master/plugins/catalog-graph/README.md) |
| **Port.io** | Developer portal | Self-service actions with configurable human approval | **Enforce manual approval**; approvers = users / teams / Admins, any or all; notify via Email / Webhook / Slack / None; run state **WAITING_FOR_APPROVAL** in **Runs** tab; per-entity **Scorecards** tab; AI agent registry blueprint | [Approvals](https://docs.port.io/workflows/actions-and-automations/create-self-service-experiences/set-self-service-actions-rbac/), [AI agent registry](https://docs.port.io/guides/all/build-ai-agent-registry/), [Scorecards](https://docs.port.io/governance/standards-and-compliance/overview/) |
| **Cortex** | Developer portal | Scorecards gain deadlines and owners | Tiered scorecards (e.g., **Bronze**); **Initiatives** with deadline and % complete; per-developer **Action Items**; Slack alerts; optional Jira issues | [Initiatives](https://www.cortex.io/post/cortex-initiatives-when-scorecards-need-a-deadline) |
| **Azure APIM / Apigee / Kong developer portals** | Subscription management | Formal consumer registration plus a change log | APIM product: **Requires subscription, Requires approval, Subscription count limit, Legal terms**. Revisions: **Make current** + "Post to Public Change log for this API". Apigee: key **Pending approval**, then Approve/Revoke. Deprecation and Sunset headers | [APIM products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-add-products), [APIM revisions](https://learn.microsoft.com/en-us/azure/api-management/api-management-revisions), [RFC 9745](https://www.rfc-editor.org/rfc/rfc9745), [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594) |
| **LangSmith** | Observability / eval | Prebuilt dashboards that read as a story; flexible custom charts | Sections **Traces, LLM Calls, Cost & Tokens, Tools (top 5), Run Types, Feedback Scores**. Metrics Count / Latency / TTFT / Tokens / Cost / Feedback score / Ratio; group-by (top 20); annotation queues; experiment comparison | [Dashboards](https://docs.langchain.com/langsmith/dashboards) |
| **Langfuse** | Observability / eval | Explicit price model; cost by user | Cost dashboard (by model, over time, top users/use cases); **Project Settings > Models** "Model Definitions" (match patterns, unit prices); usage types; spend alerts | [Cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) |
| **Arize Phoenix** | Observability / eval | Span tree plus a three-source annotation model | Span tree; annotations from human, LLM or code; datasets and experiments; sessions | [Traces](https://arize.com/docs/phoenix/tracing/llm-traces-1), [Annotations](https://arize.com/docs/phoenix/tracing/concepts-tracing/concepts-annotations) |
| **Databricks MLflow 3** | Observability / eval (native) | Assessments as columns; AI-assisted filtering | **Traces** tab columns (Trace ID, Request, Response, Session, User, Execution time, State, assessment and tag columns); **Filter with AI**; detail tabs **Summary** and **Details & Timeline**; span tabs **Chat / Inputs / Outputs / Attributes / Events**; **+ Add new assessment**; eval run comparison; production monitoring scorers | [Trace UI](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/observe-with-traces/ui-traces), [Evaluate app](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/evaluate-app), [Monitoring](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/production-monitoring) |
| **IBM watsonx.governance** | AI governance | Governed Agentic Catalog (agents + tools); agent evals; security card | Agent inventory and tool catalog; evaluators for answer relevance, faithfulness and tool-selection quality; Agent Monitoring & Insights; per-use-case Guardium security card | [Newsroom 2025-06-18](https://newsroom.ibm.com/2025-06-18-ibm-introduces-industry-first-software-to-unify-agentic-governance-and-security), [Monitoring & insights](https://www.ibm.com/new/announcements/new-security-metrics-agent-monitoring-and-insights-in-watsonx-governance) |
| **Collibra AI Governance** | AI governance | Lightweight intake; approved answers write back to the asset | **Register AI Use Case** (name, description, domain, owner); lifecycle tracker; assessments **Business Context, Data and AI Models, Legal and Ethics, Risks and Safeguards, EU AI Act, NIST AI RMF**; **Draft**, then **Submit for Review**, **Under Review**, Business Steward approves; Agent Registry page; linked agents and models | [AI Governance](https://productresources.collibra.com/docs/collibra/2026.02/Content/AIGovernance/co_about-ai-governance.htm) |
| **Credo AI** | AI governance | AI-assisted intake; policy packs recommended per use case | AI Registry (use case, model, vendor); GAIA intake; Dynamic Risk Scoring; Policy Packs; AI Agent Registry; Governance Workflows & Approvals | [AI adoption](https://www.credo.ai/solutions/ai-adoption) |
| **OneTrust AI governance** | AI governance | Change history that flags when reassessment is needed | States: proposed, in development, in testing, approved for production, restricted, under reassessment, retired. Each change entry records what changed, when, who approved, and whether reassessment is needed. Notes that risk shifts with prompt updates, model swaps and new agent actions | [AI Discovery & Registry](https://www.onetrust.com/solutions/ai-governance/ai-discovery-and-registry/) |
| **Databricks Unity Gateway (MCPs) + Governance Hub** | Native governance (visual consistency) | The native vocabulary our users already know | MCP tabs **Overview** (rate limits, **Service** QPM), **Permissions** (Grant **EXECUTE**), **Policies** (Beta: Guardrail type **Sensitive Data Detection / Custom / External**, Input/Output, **Rank**, allow/block/require approval). Tool selection: **Select manually / Advanced** + auto-include toggle. Governance Hub AI tiles **Token Usage, Governed Traffic, Unity Gateway Budgets, AI Usage, AI Spend, Active Models (30d), Active Users (30d)** + **AI recommendations** | [Govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service), [Governance Hub AI](https://learn.microsoft.com/en-us/azure/databricks/admin/governance-hub/ai) |
| **Databricks Catalog Explorer (UC)** | Native catalog (visual consistency) | Lineage, request access and certification patterns | **Lineage** tab with **See Lineage Graph** (one level, "+" expand, **Lineage details** panel, column highlight, time range, masked nodes). Request access with destinations, **Requests** page (**Review queue / My requests / All requests**), **Provision**, **Decline** with reason, "Managed externally". Certified / Deprecated badges | [Lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage), [Access requests](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests), [Certification](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data) |

### 2.2 Short notes by product family

**Microsoft (Agent 365, Entra Agent ID, Copilot Studio, Foundry Control Plane)**
- *Steal:* the Overview > "Top actions for you" > filtered Registry loop. Every governance card ("Pending Requests", "Agents at risk", "Agents without owners", "Agent with exceptions") opens a pre-filtered list where the admin can act, and the "Agents at risk" card lists the top 3 ([overview](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-365-overview?view=o365-worldwide)). Filters don't change the summary counts. The **Total agents** count stays fixed while you filter, which keeps people oriented ([registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide)).
- *Steal:* the Risk details pane. Severity sections expand, each signal shows an **Occurrences** count, and each source platform is a deep link. It also says plainly that "counts might be up to an hour behind". Stating freshness openly is a pattern we should use for cost data too.
- *Steal:* **Data & Tools** is read-only and filled by the source platform ("To change an agent's data sources or tools, the agent developer must update the agent configuration in the authoring platform") ([agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide)). This is the right default for synced fields. Our admin override (Flow 5.4) sits on top of it as an explicit exception.
- *Steal:* Entra's **owners and sponsors**: an owner runs the agent technically, and a sponsor is the accountable business person ([Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/)). Our header should show both.
- *Steal:* Foundry's Assets table packs **Status + Version + Published as + Error rate + Estimated cost + Token usage + Runs** into a single row, and makes the lifecycle verbs depend on platform: hosted agents get Start/Stop, custom agents get only Block/Unblock ([manage agents](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents)). Its "version 6 published, version 7 latest under development" example shows why we need **two version markers**.
- *Avoid:* M365 shows duplicate-looking rows for the same agent under different publisher types and explains this away as "by design" ([registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide)). We should show one entity with multiple **listings / instances** instead (Recommendation).

**AWS (Agent Registry, AgentCore, Marketplace)**
- *Steal:* the four personas (Administrator, Publisher, Curator, Consumer) map almost one-to-one to our roles. **Consumers only see approved records**, so approval doubles as a quality filter ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)).
- *Steal:* a **Reason** is required on every **Update status** change, and EventBridge emits events such as `Registry Record State changed to Deprecated` ([reviewing](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-reviewing-records.html), [events](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-eventbridge.html)). We should emit equivalent webhooks and email for subscribers.
- *Steal:* URL-based record synchronization for MCP/A2A endpoints using a stored credential provider, so records track the live server. This is the basis for our auto-pulled external MCP metadata.
- *Timing note:* the preview `bedrock-agentcore` registry namespace is discontinued on **2026-10-30**. Any AWS sync connector should target the new `agent-registry` namespace ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)).

**Google (Agent Registry, Gemini Enterprise, Agent Engine, API hub)**
- *Steal:* the Agent Gallery's consumer-side request flow: Marketplace chip > card > **Request access** > admin approval > bell notification > the agent moves into "From your organization" ([gallery](https://docs.cloud.google.com/gemini/enterprise/docs/agent-gallery)). The admin side shows **Review share request** in a **User permissions** column, with **Approve and enable / Deny**, and a toggle to skip review ([share](https://docs.cloud.google.com/gemini/enterprise/docs/workflow-builder/share-chat-agent)).
- *Steal:* Apigee API hub's **Supply chain** tab, a consumer-to-supplier dependency graph at operation level ([dependencies](https://docs.cloud.google.com/apigee/docs/apihub/manage-api-dependencies)). It maps directly to agent > tool edges.
- *Steal:* registry URNs (`urn:agent:…`, `urn:mcp:…`, `urn:skill:…`) kept separate from IAM resource names ([identifiers](https://docs.cloud.google.com/agent-registry/identity-and-identifiers)). We should do the same: a stable registry ID, distinct from UC FQNs and serving endpoint names.

**Salesforce Agentforce + MuleSoft Agent Fabric**
- *Steal (most important for lineage):* Agent Visualizer's split between **declared (dashed) and runtime (solid) edges**, the **shield** for gateway-protected nodes, and its structured details card ([components](https://docs.mulesoft.com/agent-visualizer/agent-visualizer-components)). Environment layers (Production / Sandbox) sit on top of a fixed base topology, so the graph doesn't jump around when you switch.
- *Steal:* scanners that run on a schedule or on demand and show last-run results and assets found ([Agent Fabric](https://docs.mulesoft.com/general/agent-fabric-overview)). This matches Agent 365 Connected platforms.
- Agentforce Observability: KPI cards, drill-down and trace waterfalls are confirmed only at marketing level (Inferred) ([observability](https://www.salesforce.com/agentforce/observability/)).

**ServiceNow AI Control Tower**
- *Steal:* the **Managed status** column. Unmanaged assets stay listed but are left out of governance workflows until a steward promotes them ([inventory](https://www.servicenow.com/docs/r/zurich/intelligent-experiences/disc-ai-asset-inventory.html)). This is our "Discovered (unmanaged)" vs "Registered" distinction for synced external MCPs.
- *Steal:* the **Inventory Enrichment Agent** scores metadata completeness, and a steward reviews every recommendation. Also **Change & Offboarding Workflows** requiring sign-offs and dependency reviews, and **Runtime Pause Controls** with "configurations preserved for one-click restore" ([Aug/Sep 2026](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)).
- Top-level areas (Overview, AI strategy, AI asset inventory, Value, Adoption, Risk & compliance, Security & privacy, AI cases) come from a community deck reached via a secondary summary (Inferred).

**Workday Agent System of Record**
- *Steal:* the HR metaphor. Agents are registered, configured, activated, deactivated and archived, and each has its own system user identity and an activity record ([ASOR](https://www.workday.com/en-us/ai-platform/agent-system-of-record.html)). Our lifecycle verbs should read just as plainly. Consumption tracking through Platform Consumption Console / Flex Credits is Inferred (secondary summary).

**MCP ecosystem (Kong, Docker, GitHub, official registry, Smithery)**
- *Steal:* trust tiers backed by evidence. Docker: Verified = provenance + SBOM; Docker-built = signed ([Docker](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/)). Official registry: verified namespace ownership ([MCP registry](https://github.com/modelcontextprotocol/registry)). Our "Verified publisher" badge should name the evidence it rests on.
- *Steal:* GitHub's two enforcement modes, **Allow all / Registry only** ([GitHub](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/restrict-based-on-registry)). Admins understand the trade-off immediately.
- *Steal:* Smithery's single quality score in the header plus **Try now** ([Smithery](https://smithery.ai/servers/checklist-day/registry)). Our equivalent is a readiness score: a scorecard rollup (Recommendation).
- *Steal:* Kong's split between **packages** (local install) and **remotes** (hosted endpoints) on MCP server records ([Kong MCP registry](https://developer.konghq.com/catalog/mcp-registry/)).

**Developer portals (Backstage, Port, Cortex)**
- *Steal:* the Backstage graph card that expands into a full graph page ([catalog-graph](https://github.com/backstage/backstage/blob/master/plugins/catalog-graph/README.md)). Port approvals with any-or-all approvers and channel choices ([Port](https://docs.port.io/workflows/actions-and-automations/create-self-service-experiences/set-self-service-actions-rbac/)). Cortex Initiatives that attach deadlines and Action Items to scorecard rules ([Cortex](https://www.cortex.io/post/cortex-initiatives-when-scorecards-need-a-deadline)). We should reuse the Initiative model for "acknowledge breaking change by date".

**API management portals (APIM, Apigee, Kong)**
- *Steal:* APIM's **Requires approval** + **Legal terms** + subscriber list per product ([products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-add-products)), and publishing to a public **Change log** when a revision is made current ([revisions](https://learn.microsoft.com/en-us/azure/api-management/api-management-revisions)). Deprecation and Sunset (RFC 9745 / RFC 8594) give us standard fields: `deprecated_at`, `sunset_at`, migration link.
- *Gap:* none of the portals push a "you are impacted" acknowledgement to subscribers. That is our differentiator: Flow 5.2.

**Observability and eval (LangSmith, Langfuse, Phoenix, MLflow 3)**
- *Steal:* MLflow's assessments as table columns, **Filter with AI**, and **Summary** vs **Details & Timeline** ([MLflow](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/observe-with-traces/ui-traces)). LangSmith's prebuilt section order: Traces > LLM Calls > Cost & Tokens > Tools > Run Types > Feedback ([LangSmith](https://docs.langchain.com/langsmith/dashboards)). Langfuse's visible price table (Model Definitions) ([Langfuse](https://langfuse.com/docs/observability/features/token-and-cost-tracking)).
- For Databricks-built agents, **deep-link to the MLflow experiment** rather than rebuilding a full trace explorer. Embed a summary table and a trace drawer instead (Recommendation).

**AI governance inventories (IBM, Collibra, Credo, OneTrust)**
- *Steal:* Collibra's lifecycle tracker, and its behaviour where approved assessment answers copy back to the asset page ([Collibra](https://productresources.collibra.com/docs/collibra/2026.02/Content/AIGovernance/co_about-ai-governance.htm)). OneTrust's change entry with a "reassessment needed" flag ([OneTrust](https://www.onetrust.com/solutions/ai-governance/ai-discovery-and-registry/)). Credo's policy-pack recommendations ([Credo](https://www.credo.ai/solutions/ai-adoption)). IBM's agent evals for tool-selection quality ([IBM](https://newsroom.ibm.com/2025-06-18-ibm-introduces-industry-first-software-to-unify-agentic-governance-and-security)).

**Databricks native (Catalog Explorer, Unity Gateway, Governance Hub) - for visual consistency**
- Use the same tab names where meanings overlap: **Overview, Permissions (we call it Access), Policies, Lineage, Insights (we call it Usage & Cost), History (we call it Changes & Impact)** ([Catalog Explorer](https://docs.databricks.com/aws/en/catalog-explorer/), [govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)).
- Reuse the **Certified** check and **Deprecated** warning icons with the same meaning as `system.certification_status`. Copy the search syntax `certificationStatus:certified` ([certification](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data)).
- Reuse UC's MCP taxonomy: **Databricks-provided MCPs, External MCP servers, Custom MCP servers** (Databricks Apps) ([MCP docs](https://docs.databricks.com/aws/en/generative-ai/mcp/)). Databricks's Nov 2025 MCP Catalog blog also put an "MCP Servers" tab under Agents and listed Marketplace MCPs (Public Preview) ([blog](https://www.databricks.com/blog/accelerate-ai-development-databricks-discover-govern-and-build-mcp-and-agent-bricks)). The current docs point to **Unity Gateway > MCPs**.

---

## 3. Recommended information architecture

### 3.1 Sitemap (routes)

```
/how-it-works                         How It Works (animated dots-between-boxes flow; intro + architecture)
/                                     Home (role-aware: Top actions for you, my subscriptions, fleet tiles)
/catalog                              Catalog (All) - grid/list toggle, facets, saved views
  /catalog?type=agent|mcp|tool|skill  Type-scoped views (also sidebar sub-items)
/agents/:id/:tab                      Agent entity page
/mcp/:id/:tab                         MCP server entity page
/tools/:id/:tab                       Tool entity page (child of an MCP server)
/skills/:id/:tab                      Skill entity page
/me                                   My workspace
  /me/subscriptions                   What I subscribe to + notification prefs
  /me/access                          What I can use (grants, expiry dates)
  /me/requests                        My requests (status, SLA clock)
  /me/owned                           Assets I own/sponsor (completeness, open actions)
/requests                             Review queue (owner/steward) | All requests (admin)
/changes                              Change feed (all published versions, deprecations, policy changes)
  /changes/:changeId                  Impact report (affected subscribers, downstream, acknowledgements, before/after)
/lineage                              Lineage explorer (global graph, focus/depth/impact modes)
/usage-cost                           Usage & Cost (fleet unit economics, budgets, anomalies)
/quality                              Quality (traces + evals rollup across Databricks-built agents)
/policies                             Policies & Guardrails (library, coverage, violations, recommendations)
/governance                           Steward/Admin
  /governance/sources                 Connected sources & sync (Databricks, M365, Marketplace, MCP registries)
  /governance/curation                Curation queue (Pending approval, Discovered/unmanaged, duplicates)
  /governance/overrides               Metadata overrides & drift (field provenance)
  /governance/scorecards              Readiness scorecards & initiatives (deadlines)
  /governance/ownership               Ownerless / sponsorless assets, owner transfers
/audit                                Audit log + evidence export (auditor/admin)
/settings                             Roles, notification channels, taxonomy (tags/domains), SLA defaults
```

### 3.2 Sidebar order ("How It Works" first)

| # | Item | Visible to | Badge | Notes |
|---|---|---|---|---|
| 1 | **How It Works** | All | none | Built with the `how-it-works-flow` skill. Lanes: Discover > Request > Grant > Subscribe > Use via Unity Gateway > Observe (usage / traces / cost) > Change > Notify > Acknowledge. Animated dots on bezier paths (Recommendation; house standard) |
| 2 | Home | All | Top-actions count | Tiles depend on role (Section 6) |
| 3 | Catalog > All / Agents / MCP servers / Tools / Skills | All | none | Default landing for Viewers |
| 4 | My workspace > Subscriptions / Access / Requests / Owned | All (Owned only if owner) | Expiring-soon count | |
| 5 | Requests | Owner, Steward/Admin | Pending count | Same model as UC **Review queue / All requests** ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests)) |
| 6 | Changes & Impact | All | Unacknowledged-for-me count | |
| 7 | Lineage | All (masked nodes per permission) | none | |
| 8 | Usage & Cost | Consumer (own), Owner (owned), Admin/Auditor (fleet) | Anomaly count | |
| 9 | Quality (Traces & Evals) | Owner, Steward/Admin, Auditor | Regression count | |
| 10 | Policies & Guardrails | All (read), Steward/Admin (edit) | Violations (7d) | |
| 11 | Governance > Sources / Curation / Overrides / Scorecards / Ownership | Steward/Admin | Pending approval + drift | |
| 12 | Audit | Auditor, Steward/Admin | none | |
| 13 | Settings | Admin | none | |

Rules: hide sections a role cannot use rather than disabling them. Persist the collapsed state in `localStorage`. Lazy-load Lineage, Quality and Audit routes. Show a **source pill** (Lakebase / Warehouse / Synthetic) on every page (Recommendation; house standard).

### 3.3 Global search and command palette (Cmd/Ctrl+K)

- **One box for objects and actions.** Results are grouped as Agents · MCP servers · Tools · Skills · People/Teams · Actions · Pages. Recent items and pinned items appear before typing (Gemini pinned pattern ([gallery](https://docs.cloud.google.com/gemini/enterprise/docs/agent-gallery))).
- **Hybrid search.** Keyword and semantic matching together, so "tool that reads Outlook calendar" and an exact FQN both work, as in AWS Agent Registry ([registry](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html)).
- **Structured operators** (Recommendation; modelled on UC `certificationStatus:certified` ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data))): `type:mcp`, `source:external`, `publisher:microsoft`, `owner:@me`, `team:clinical-ops`, `certified:true`, `status:deprecated`, `sensitivity:restricted`, `tag:finance`, `uses:<tool>`, `usedby:<agent>`, `changed:<7d`, `access:mine`, `subscribed:true`, `ownerless:true`.
- **"Filter with AI"** (sparkle). Turns plain English into the operator chips above, showing the chips before running so the user can edit them. Modelled on MLflow ([trace UI](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/observe-with-traces/ui-traces)).
- **Verb actions:** "Request access to …", "Subscribe to …", "Open lineage for …", "Compare versions of …", "Copy MCP URL for …", "Pause …" (admin), "Assign owner …" (admin). Each runs in place via a dialog.
- **Keyboard:** arrows to move, Enter to open, Cmd+Enter to open in a new tab, Tab to cycle groups, Esc to close. Prefixes `>` for actions, `@` for people, `#` for tags.
- **Permission-aware:** objects the user cannot see are excluded. Objects that are visible but locked show a lock icon and an inline **Request access** action.

### 3.4 Catalog list and card anatomy

**Facets** (left rail; counts update but **totals stay fixed**, per M365 ([registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide))): Type · Source (Databricks-provided / External / Custom) · Platform (Agent Bricks, Model Serving, Databricks Apps, Microsoft 365, Marketplace, other) · Status · Certification · Owner/Team · Domain/Tags · Data sensitivity · Risk · Policy coverage · My relationship (has access / requested / subscribed / owned) · Changed in last 7d · Ownerless.

**Quick chips** above the grid (Gemini-style ([gallery](https://docs.cloud.google.com/gemini/enterprise/docs/agent-gallery))): All · Pinned · Mine · Certified · Databricks-provided · External · Recently changed.

**Card anatomy** (grid view):
1. Icon or avatar, plus **type badge** (Agent / MCP / Tool / Skill) and **source chip** (e.g., "External · Microsoft 365", "Databricks-provided", "Custom · App").
2. Display name (one line), then the FQN or registry ID in mono text (one line, truncated with a tooltip).
3. **Trust badge**: Certified (check), Verified publisher (shield + evidence tooltip), Deprecated (warning), or Unreviewed (outline).
4. Status dot plus label (Live / Draft / Pending approval / Paused / Deprecated). Colour is never the only signal.
5. Description, clamped to two lines.
6. KPI micro-row: 30-day calls sparkline · active users · readiness score (0-100, Smithery-style ([Smithery](https://smithery.ai/servers/checklist-day/registry))) · policy shield (full / partial / none, MuleSoft-style).
7. Owner avatar stack (owner + sponsor). An amber "Ownerless" chip appears if neither exists.
8. My-relationship pill: Has access / Requested · 2d / Subscribed / Owner.
9. Hover or focus actions: **Subscribe**, **Request access**, **Copy MCP URL**, **Pin**.

**List view columns** (Customize view; Export CSV; Normal/Compact density): Name · Type · Source · Owner · Status · Certification · Version (published / latest) · Risk · Policy coverage · Subscribers · 30d requests · 30d cost · Error rate · Eval score · Last changed. This is modelled on Foundry Assets and M365 Registry ([Foundry](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents)).

---

## 4. Entity page anatomy

### 4.1 Shared header (all four entity types)

```
Breadcrumb:  Catalog / MCP servers / Microsoft 365 Mail
[icon] Microsoft 365 Mail                     [Certified ✓] [External · Microsoft 365] [MCP]
       registry: urn:mcp:m365-mail  ·  UC: system.ai.m365_mail                 (copy buttons)
Status: ● Live  ·  Runtime: Running  ·  Version: v3.2 (published) ▾  · v3.3 draft
Owner: (avatar) Jane Doe   Sponsor: (avatar) Clinical Ops   Support: #m365-mcp-help
Chips: Sensitivity: Confidential · Risk: Medium · Policies: 4 (shield) · Readiness 86/100
KPI ribbon (30d): 1.2M calls · 340 users · $0.42 / 1k req · 0.8% errors · Eval 0.91
[Primary CTA by role/state]   [Subscribe ▾]   [⋯ Copy URL · Open in Unity Gateway · Report issue · Pause · Deprecate]
```

- **Type badge**: Agent · MCP server (with sub-type Databricks-provided / External / Custom, from the [Databricks MCP taxonomy](https://docs.databricks.com/aws/en/generative-ai/mcp/)) · Tool · Skill.
- **Trust badge**: Certified / Deprecated, same semantics as UC ([certification](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data)). Verified publisher, with a tooltip listing the evidence (namespace verified, signed image, SBOM; per [Docker](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/) and the [MCP registry](https://github.com/modelcontextprotocol/registry)). Unreviewed.
- **Two status axes**:
  - Governance lifecycle: Draft / Pending approval / Approved-Live / Rejected / Deprecated / Retired ([AWS](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-reviewing-records.html), [OneTrust](https://www.onetrust.com/solutions/ai-governance/ai-discovery-and-registry/)).
  - Runtime state: Running / Stopped / Blocked / Paused / Unknown ([Foundry](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents)).
- **Version**: a selector that shows **published** and **latest** separately, as in Foundry's "v6 published, v7 latest". Switching versions puts the page into a read-only historical view.
- **Owners**: owner(s) plus sponsor ([Entra](https://learn.microsoft.com/en-us/entra/agent-id/)). If the owner is missing or deactivated, show an amber banner "This asset has no active owner", with **Assign owner** visible to admins.
- **Primary CTA by state and role** (Recommendation):

| Viewer state | Primary CTA |
|---|---|
| No access | Request access |
| Request pending | Request pending · day N (opens status) |
| Has access, not subscribed | Subscribe |
| Subscribed | Use / Copy MCP URL / Open in playground |
| Owner | Edit description / Publish new version |
| Steward | Review (if pending) / Certify |
| Auditor | Export evidence |

### 4.2 Tab list and what each contains

Tabs appear only when they apply to the entity, as in M365 ([agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide)). The matrix shows the default set:

| Tab | Agent | MCP server | Tool | Skill |
|---|---|---|---|---|
| Overview / Description | Yes | Yes | Yes | Yes |
| Tools (Agent: "Tools & Skills used"; MCP: "Tools exposed"; Tool: "Schema"; Skill: "Capabilities") | Yes | Yes | Yes (schema) | Yes |
| Access | Yes | Yes | Inherited from MCP (read-only + link) | Yes |
| Usage & Cost | Yes | Yes | Yes (tool calls) | Adoption only |
| Traces | Yes (Databricks-built) | Yes (tool-call spans) | Yes (filtered spans) | No (link to agent traces) |
| Evals | Yes (Databricks-built) | Optional (tool reliability) | Optional | Optional |
| Policies & Guardrails | Yes | Yes | Yes (inherited + tool-level) | Limited |
| Lineage | Yes | Yes | Yes | Yes |
| Changes & Impact | Yes | Yes | Yes | Yes |
| Subscribers | Yes | Yes | Inherited from MCP | Yes |
| Audit | Yes | Yes | Yes | Yes |

**Overview / Description**
- An owner-editable **description widget**: rich text (Markdown with live preview) plus **structured fields**. These are Purpose, Intended users, Inputs, Outputs, Data sensitivity (+ PII/PHI flags), SLA/SLO, Support channel, Known limitations, Example prompts, and Links (docs / repo / runbook). Field-by-field detail is in Flow 5.3.
- A **completeness meter**, like ServiceNow's completeness scoring ([AICT](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)), linked to the readiness scorecard.
- **Provenance chips** on every field: "Synced from source", "Edited by owner" or "Edited by admin". Click a chip to see its history (Section 5.4).
- A **"At a glance" side card**: platform / runtime, model(s), endpoint or MCP URL, environment(s), created / updated, tags, domain, "Also registered in" (e.g., M365 registry via Connected platforms ([Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms))).
- **Certification** sub-panel: who certified it and when, the attestation evidence, and the expiry date (M365 Certification tab is valid for 12 months ([agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide))).

**Tools**
- *Agent:* tools and skills the agent uses, grouped by MCP server. Each row shows tool name, side-effect class (Read / Write / Destructive), last call, 30d calls, error rate, and policy chips. Write and destructive tools are flagged for review, in line with M365's guidance that tools which "write data… warrant closer review" ([agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide)).
- *MCP server:* the exposed tools, each with a **selection state**: Enabled / Hidden (not selected) / **New - pending review**. The last state applies when "auto-include new tools" is off, mirroring Unity Gateway's tool selection ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)). Tools are ranked by throughput, top 10 with **Show more** (MuleSoft-style ([components](https://docs.mulesoft.com/agent-visualizer/agent-visualizer-components))). Also shows **Packages vs Remotes** (Kong ([MCP registry](https://developer.konghq.com/catalog/mcp-registry/))).
- *Tool:* input and output JSON schema (rendered plus raw toggle), an example call, side-effect class, idempotency, and the parent MCP.
- *Skill:* a Markdown doc plus package / repository info, matching AWS skill records ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)), and the agents that use it.

**Access**
- **Who has access**: principals, privilege (e.g., `EXECUTE` on an MCP, `CAN_QUERY` on a serving endpoint), how it was granted (direct / group / request #), granted by, and an **expiry** column.
- **My access**: my effective access plus its expiry, and a **Request more access** action.
- **Pending requests** (owner view): an inline queue with Approve / Deny.
- **Access settings** (owner): approval required yes/no, approvers (any or all, as in Port ([Port](https://docs.port.io/workflows/actions-and-automations/create-self-service-experiences/set-self-service-actions-rbac/))), default and maximum grant duration, request destinations (email / Slack / Teams / webhook / redirect URL, per UC ([destinations](https://learn.microsoft.com/en-us/azure/databricks/data-governance/unity-catalog/manage-privileges/access-request-destinations))), and legal terms text (APIM ([products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-add-products))).
- If grants live in an external system, show **"Managed externally"** with a deep link, as UC does ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests)).

**Usage & Cost**
- KPI ribbon with a period selector: Requests · Active users · Sessions · Tokens · Cost · $/1k req · $/active user · p95 latency · Error rate.
- Charts: requests over time (stacked by consumer), cost over time (stacked by model), top consumers (bar), and a budget bar (Section 7.1).
- **Top consumers** table: requester, type (user / SP / agent), requests, cost, last seen, **Subscribed?** (Yes / **No - unregistered consumer**) (Recommendation).
- **Data sources** footnote with freshness, e.g. "Requests from `system.ai_gateway.usage`; DBU cost from `system.billing.usage`; external model spend (USD, hourly) from `system.ai_gateway.external_model_spend`" ([usage](https://docs.databricks.com/aws/en/ai-gateway/usage-tracking), [cost](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/cost-observability)).

**Traces** (Databricks-built agents; MCP tool-call spans)
- An embedded traces table with MLflow columns: Trace ID, Request, Response, Session, User, Execution time, State, assessment columns, tags. Includes **Filter with AI** ([MLflow](https://docs.databricks.com/aws/en/mlflow3/genai/tracing/observe-with-traces/ui-traces)).
- A row opens a **trace drawer** with **Summary** and **Details & Timeline** sub-tabs; span detail tabs are Chat / Inputs / Outputs / Attributes / Events.
- **"Open in MLflow"** deep link for the full explorer.
- Role scoping: Consumers see only their own traces. Owners, stewards and auditors see all, with PII-redacted payloads unless the viewer has elevated rights (Recommendation).
- Policy decisions show as span badges (Allowed / Blocked / Approval required). Unity Gateway's unified trace table records tool requests, responses and policy decisions once enabled ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)).

**Evals** (Databricks-built agents)
- A scorer scoreboard (e.g., Correctness, Groundedness, Safety, Guidelines, plus custom scorers) with a 30-day trend, separated into production monitoring and offline evaluation runs ([monitoring](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/production-monitoring)).
- A **Compare versions** view: vN vs vN+1 on the same dataset, with per-scorer deltas, regressions highlighted red, and sample-level diffs ([evaluate app](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/evaluate-app)). This view feeds Flow 5.5.
- Human feedback count and an annotation-queue link (LangSmith / Phoenix patterns ([LangSmith](https://docs.langchain.com/langsmith/dashboards), [Phoenix](https://arize.com/docs/phoenix/tracing/concepts-tracing/concepts-annotations))).
- For tool-heavy agents, add a tool-selection quality metric (IBM ([IBM](https://newsroom.ibm.com/2025-06-18-ibm-introduces-industry-first-software-to-unify-agentic-governance-and-security))).

**Policies & Guardrails**
- Policy chips (Section 7.2) grouped as **Access**, **Guardrails** (Input / Output), **Rate limits**, **Budgets**, **Tool allowlist**, and **Data policies**. Each chip shows its origin: Unity Gateway service policy, UC grant, budget, or app-level rule.
- A coverage meter plus **Violations (last 7d)** with a sparkline and drill-down to traces.
- Required-policy checklist for the asset's risk tier, with gaps flagged ("Missing: Sensitive Data Detection on Output").
- **Pause / Kill switch** (admin): a reason is required, the configuration is preserved, and subscribers are notified ([ServiceNow](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749), [Foundry](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents)).

**Lineage**
- An embedded graph card centred on this entity, one hop by default, with an **Open full graph** link to `/lineage?focus=…`. Modelled on the Backstage card-to-page pattern ([catalog-graph](https://github.com/backstage/backstage/blob/master/plugins/catalog-graph/README.md)) and UC "See Lineage Graph" ([UC lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage)).
- An **accessible table alternative** with columns Direction, Type, Name, Edge kind (Declared / Observed), Last activity. Borrowed from UC's UDF lineage table (Direction, Type, Last activity).

**Changes & Impact**
- A version timeline. Each entry carries: semver, change type (Description / Tools added-removed / Schema / Model / Prompt / Policy / Owner / Deprecation), a **Breaking** flag, published by, effective date, sunset date, and release notes. Built on the APIM change-log ([revisions](https://learn.microsoft.com/en-us/azure/api-management/api-management-revisions)) and OneTrust change entry ([OneTrust](https://www.onetrust.com/solutions/ai-governance/ai-discovery-and-registry/)) patterns.
- Each entry opens its **Impact report**: affected subscribers (with acknowledgement status), downstream agents, observed consumers, and before/after metrics (eval, cost, latency, violations) for 7 days pre vs 7 days post.
- A **Draft version** banner for owners: "v3.3 draft - 2 tools added, 1 schema change (breaking). Preview impact."

**Subscribers**
- Table columns: subscriber (person / DL / SP / agent), email(s), relationship (human user / consuming agent / app), declared downstream asset, notification preference (Breaking only / All / Weekly digest), subscribed since, last acknowledgement.
- **Unregistered consumers** panel: requesters seen in usage logs during the last 30 days with no subscription, plus a **Nudge to register** bulk action (Recommendation).
- Export CSV, and **Email all subscribers** (owner, rate-limited, audited).

**Audit**
- An immutable event list: who / what / when / before-after / reason / source (UI, API, sync). Covers grants, requests, edits, overrides, status changes, publishes, pauses and certifications.
- Filter by event type and actor. **Export evidence** (CSV / JSON + PDF summary) for auditors.
- Mirrors Unity Gateway auditing to `system.access.audit` for MCP changes and `mcpCall` invocations ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)). The app's own audit table in Lakebase covers events the platform does not log, such as subscriptions and description edits (Recommendation).

---

## 5. Key flows

### 5.1 Request access > owner approval > grant (with SLA, justification, expiry)

1. **Entry points.** The header CTA; locked cards in Catalog; the command palette ("Request access to …"); a masked lineage node; and inline on any 403 shown in the app. The last mirrors UC's "Request access" on `INSUFFICIENT_PERMISSIONS` ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests)).
2. **Request form** (one dialog):
   - **For:** Me / a service principal / a group (UC supports all three).
   - **Access level:** e.g., Use (`EXECUTE`). For MCPs, an optional **tool subset**, defaulting to all enabled tools, with Write/Destructive tools flagged.
   - **Environment** (if applicable).
   - **Justification** (required; minimum length; templates such as "Building agent X for use case Y").
   - **Duration:** 30 / 90 / 180 days. The default and maximum are set per entity; "No expiry" is admin-only (Recommendation).
   - **Legal terms / data-handling acknowledgement**, if the owner configured them (APIM ([products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-add-products))).
   - **Subscribe me** checkbox: on by default, email pre-filled from SSO. This links Flow 5.2.
3. **Routing.** Approvers are resolved in this order: entity-level approvers > owners > domain steward > admin default. This copies UC's object > owner > parent > metastore resolution ([destinations](https://learn.microsoft.com/en-us/azure/databricks/data-governance/unity-catalog/manage-privileges/access-request-destinations)). Per-entity **Any approver** vs **All approvers** (Port ([Port](https://docs.port.io/workflows/actions-and-automations/create-self-service-experiences/set-self-service-actions-rbac/))). Destinations: in-app + email + Slack/Teams webhook, or a redirect URL to an external system (shown as "Managed externally").
4. **Requester confirmation.** A toast plus **My requests** entry with status "Pending · day 0 of SLA", the approver names, and a "Typically approved in ~N h" estimate computed from the median of the last 90 days (Recommendation).
5. **SLA clock** (Recommendation, with UC timings as the baseline): target 2 business days, configurable per entity. Reminder to approvers at **day 3** and auto-expire at **day 7**, matching UC ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests)). On expiry, notify the requester and offer **Resubmit** or **Escalate to steward**.
6. **Owner review** (Requests > Review queue, or inline in the entity Access tab). The request card shows: requester, team, justification, requested scope (risky tools highlighted), the requester's current access, recent similar decisions, and the asset's data sensitivity.
   - **Approve** opens a "Provision" choice: **Add to group** or **Grant directly**, as in UC ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests)).
   - **Approve with changes**: narrow the tools, shorten the expiry.
   - **Deny**: a reason is required, as in UC.
   - **Delegate** to another approver.
7. **Grant execution.** The backend applies the platform grant: UC `GRANT EXECUTE` on the MCP; endpoint permission for agents. The UI shows "Provisioning…" and then success or failure with a **Retry** action. A grant is never marked done optimistically (Recommendation).
8. **Post-grant.** The requester gets in-app and email notification (UC emails both requester and target ([UC](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests))). The entity moves to "Has access" in **My access** with its expiry date. Reminders go out at T-14 and T-3 days, with a one-click **Extend** that re-enters review if policy requires it.
9. **Recertification** (Recommendation): a quarterly owner access review lists every grant with **Keep / Revoke**, modelled on Entra access packages ([Entra](https://learn.microsoft.com/en-us/entra/agent-id/)). Grants without a decision expire.
10. **Audit.** Every step is logged: submitted, routed, reminded, approved/denied (+ reason), provisioned, expired, revoked.

### 5.2 Subscribe with email > change notification > impact acknowledgement

1. **Subscribe** (header CTA, or a side-effect of Flow 5.1). The dialog collects:
   - **Email(s)**: SSO email pre-filled and locked as primary, plus optional DLs or a team email. Non-identity addresses get a verification email (double opt-in) (Recommendation).
   - **Relationship**: I use it directly / My agent or app uses it. For the second, pick the downstream asset from the catalog, or name it free-text with "not registered yet". This creates a **declared lineage edge** (consumer > entity).
   - **Notify me about**: Breaking changes and deprecations only / All published changes / Weekly digest. Channel: email (required), plus Slack/Teams (optional).
2. **Confirmation**: the Subscribers count goes up immediately (optimistic, rolled back on error). The item appears in **My subscriptions**.
3. **Owner publishes a change** (Flow 5.5). The system classifies it as Breaking / Non-breaking / Deprecation / Policy change / Owner change, and computes recipients: subscribers whose preferences match, plus owners of downstream assets found via lineage.
4. **Notification content** (email + in-app). Title "[Breaking] Microsoft 365 Mail MCP v3.3 - effective 2026-11-10". Body:
   - what changed (human-readable diff)
   - why
   - effective and sunset dates (Deprecation / Sunset semantics, RFC 9745/8594 ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)))
   - migration steps
   - before/after metrics (eval, cost, latency)
   - a link to the impact report
   - three buttons: **Acknowledge - not impacted** / **Acknowledge - impacted, will migrate by [date]** / **I need help** (opens the support channel)
5. **Acknowledgement tracker** (owner, in Changes & Impact): the share of affected subscribers who acknowledged, by status. Unacknowledged subscribers get automatic reminders at T-7 and T-2 days before the effective date. Recipients see the ack as an **Action Item** with a deadline (Cortex Initiatives pattern ([Cortex](https://www.cortex.io/post/cortex-initiatives-when-scorecards-need-a-deadline))).
6. **Optional release gate** (owner or steward policy): block the effective date until X% of *breaking-change* subscribers have acknowledged, or a steward overrides with a reason (Recommendation).
7. **Unregistered consumers.** Requesters seen in `system.ai_gateway.usage` (the `requester` column ([usage](https://docs.databricks.com/aws/en/ai-gateway/usage-tracking))) who are not subscribed get a "You are using X, which is changing" email with a one-click **Subscribe**. The owner sees them flagged in the impact report (Recommendation).
8. **Unsubscribe / change preferences** from any email footer or My subscriptions. If access is revoked, the subscription is kept but marked "No current access" so the person still hears about deprecations (Recommendation).

### 5.3 Owner edits the description (rich text plus structured fields)

1. **Edit** (pencil on the Overview tab, or the Cmd+K action "Edit description"). The editor opens inline, not as a modal, so the page context stays visible.
2. **Structured fields** (required ones marked; each feeds the completeness meter):

| Field | Type | Notes |
|---|---|---|
| Purpose | One-line summary (≤140 chars) + rich-text long form | Required; the one-liner feeds cards and search snippets |
| Intended users / audience | Multi-select (teams, personas) + text | |
| Inputs | Structured list (name, type, description, example) or "from tool schema" | For MCPs/tools, defaults to the synced schema |
| Outputs | Structured list + example | |
| Data sensitivity | Enum: Public / Internal / Confidential / Restricted + flags PII / PHI / PCI | Raising sensitivity triggers a notice to subscribers; lowering it needs steward approval for certified assets (Recommendation) |
| SLA / SLO | Availability %, p95 latency target, support hours, RTO | Shown next to measured values, with green/amber/red against target |
| Support channel | Slack channel, email/DL, on-call link | Required for Certified |
| Known limitations | Rich text | |
| Example prompts / calls | List | Seeds the playground and eval datasets |
| Links | Docs, repo, runbook, dashboard | |
| Tags / domain | From admin taxonomy (max 5 tags, as in M365 ([agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide))) | |

3. **AI assist** (optional): "Draft from source" reads the MCP `tools/list`, the agent config or traces, and proposes field values. Proposals appear as **suggestions with Accept / Edit / Reject per field**, never auto-applied. This follows the ServiceNow steward-review model ([AICT](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)) and our governed-but-editable house rule.
4. **Autosave draft** every few seconds, labelled "Draft saved · 12:04", plus **Preview as consumer**.
5. **Save**: optimistic update with an **Undo** toast. On server error, roll back and keep the draft. Edits to certified assets in sensitive fields (Purpose, Data sensitivity, Outputs) go to steward review: "Pending review" chip, the old value stays live (Recommendation; Collibra review flow ([Collibra](https://productresources.collibra.com/docs/collibra/2026.02/Content/AIGovernance/co_about-ai-governance.htm))).
6. **History**: each save is a description revision with a diff view and **Restore**. Material edits (sensitivity, outputs) optionally create a Changes & Impact entry and notify subscribers.

### 5.4 Admin overrides external MCP metadata with field-level provenance

1. **Sync source** (Governance > Sources, or the entity's "Source & Sync" panel). Sources include the MCP server's own metadata (`server.json` / `tools/list`), an upstream registry (official MCP Registry, GitHub MCP Registry, Docker catalog), Databricks Marketplace, or the vendor listing (e.g., Microsoft 365). Sync runs on a schedule and on demand, showing last run, status, number of fields changed and errors. Modelled on AWS URL sync ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)) and Agent 365 Connected platforms ([Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms)).
2. **Discovered vs registered.** Newly synced servers arrive as **Discovered (unmanaged)** in the curation queue. A steward promotes them to Registered, rejects them, or merges them into a suspected duplicate (ServiceNow managed status and duplicate grouping ([ServiceNow](https://www.servicenow.com/docs/r/zurich/intelligent-experiences/disc-ai-asset-inventory.html))).
3. **Provenance on every field.** Each metadata field shows a chip: **"Auto-pulled · tools/list · 2h ago"** (neutral) or **"Edited by admin · R. Patel · 2026-10-20"** (brand colour). Hovering shows source value vs current value and the reason (Recommendation).
4. **Override.** Pencil on the field opens an inline editor with three parts:
   - new value
   - **reason** (required)
   - **lock mode**: "Keep my value on future syncs" (default) or "Follow source again on next sync"
   Save, and the chip turns to "Edited by admin".
5. **Drift handling.** If a later sync changes a locked field upstream, the entity shows an amber banner "Source changed 1 overridden field", with a side-by-side diff and **Keep override / Accept source / Edit**. Governance > Overrides lists all drifted fields across the fleet.
6. **Revert** one field ("Revert to source") or in bulk.
7. **Material overrides** (data sensitivity, description of write tools, owner/support) create an audit entry and optionally notify subscribers.
8. **Tool changes from source.** New tools discovered by sync arrive as **New - pending review** and are not exposed. This matches Unity Gateway with "include new tools automatically" turned off ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)). Removed tools generate a Breaking change entry and trigger Flow 5.2.

### 5.5 Owner publishes a new version > impact preview > publish

1. **Create draft vN+1.** Three paths: from a new deployment (Databricks-built agents: new serving endpoint version / Agent Bricks update), from sync (external MCP), or by hand. The header shows "Draft v3.3".
2. **Change set** is computed automatically: config diff covering instructions/prompt, model, tools added/removed, tool schema changes, policies, owners/sponsor, and description. A **semver suggestion** is offered (major if tools are removed or a schema is incompatible); the owner can override it, with a reason.
3. **Impact preview** (a full-page review, not a modal):
   - **Affected subscribers**: count and list, with their notification preference and the email that will go out (preview rendered).
   - **Downstream agents and apps** (via lineage, 1-3 hops, using the tools that changed), with their owners.
   - **Observed consumers (30d)**, including unregistered ones.
   - **Data assets** touched by changed tools (UC lineage).
4. **Before/after deltas**:
   - **Evals:** vN vs vN+1 on the same evaluation dataset, per scorer with deltas, regressions in red, and three worst sample diffs inline ([evaluate app](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/evaluate-app)).
   - **Cost:** projected $/1k requests from eval-run token counts and current prices, with a delta and a 30-day projected spend at current volume (labelled "Estimated").
   - **Latency:** p50/p95 from the eval runs.
   - **Policy:** guardrail violation rate on the eval set, and coverage change (e.g., "new tool `send_mail` has no Output guardrail").
5. **Pre-publish checks** shown as pass/fail rows (Cortex/Port scorecard style ([Port](https://docs.port.io/governance/standards-and-compliance/overview/))): eval regression within threshold; no unreviewed tools; required policies present for the risk tier; description completeness ≥ threshold; steward approval if Certified or high-risk. ServiceNow's change workflow is the model ([AICT](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)).
6. **Rollout settings:** effective date, with a minimum notice for breaking changes (e.g., 14 days, configurable; Recommendation); optional canary % (if the platform supports traffic split); release notes (required for breaking); sunset date for the previous version.
7. **Publish.** The version is marked published; notifications go out (Flow 5.2); a Changes & Impact entry is created; and the Audit log records it, much like APIM's "Make current" with a change-log post ([revisions](https://learn.microsoft.com/en-us/azure/api-management/api-management-revisions)).
8. **Post-release watch** (7 days): automatic 7d-vs-7d comparison of error rate, cost/1k, eval scores and violations. Regressions raise an owner alert with **Roll back** (re-point to vN) and **Open traces** actions.

---

## 6. Role matrix

Legend: **Yes** = allowed · **Own** = only for assets they own/sponsor · **Self** = only their own data · **Read** = view only · **-** = not allowed.

| Capability | Viewer | Consumer | Owner | Steward / Admin | Auditor |
|---|---|---|---|---|---|
| Browse catalog, public metadata, How It Works | Yes | Yes | Yes | Yes | Yes |
| View restricted metadata (instructions, full tool schemas) | - | Yes (assets with access) | Own | Yes | Read |
| Global search and command palette | Yes | Yes | Yes | Yes | Yes |
| Request access | Yes | Yes | Yes | Yes | - |
| Subscribe with email | Yes (becomes Consumer on grant) | Yes | Yes | Yes | - |
| View own usage, cost, traces | - | Self | Self | Yes | Read |
| View entity-wide usage and cost | - | Summary only (Recommendation) | Own | Yes | Read |
| View all traces for an entity | - | - | Own | Yes | Read (redacted) |
| View evals | - | Summary | Own | Yes | Read |
| Edit description and structured fields | - | - | Own | Yes | - |
| Manage tool selection / review new tools | - | - | Own | Yes | - |
| Approve / deny access requests | - | - | Own | Yes | - |
| Grant / revoke directly; run access reviews | - | - | Own | Yes | - |
| Publish new version / view impact preview | - | - | Own | Yes | Read |
| Deprecate / retire | - | - | Own (with steward sign-off if Certified) | Yes | - |
| Pause / kill switch | - | - | Own (non-Certified; Recommendation) | Yes | - |
| Override external MCP metadata | - | - | - | Yes | - |
| Connect / sync external sources; curate Discovered assets | - | - | - | Yes | Read |
| Create / attach policies and guardrails | - | - | Propose (Own) | Yes | Read |
| Assign certification (Certified / Deprecated) | - | - | Request | Yes | - |
| Assign or transfer owner; fix ownerless | - | - | Transfer own | Yes | - |
| Configure budgets and thresholds | - | - | Request | Yes | Read |
| Email all subscribers of an asset | - | - | Own | Yes | - |
| View audit log | - | Self | Own | Yes | Yes |
| Export evidence (CSV/JSON/PDF) | - | - | Own | Yes | Yes |
| Manage roles, taxonomy, notification channels | - | - | - | Yes (Admin) | - |
| "View as role" preview | - | - | - | Yes | - |

Notes:
- Roles stack. A Consumer of asset A can be the Owner of asset B. "Owner" is evaluated per entity: owners, co-owners and sponsors, following Entra owners/sponsors ([Entra](https://learn.microsoft.com/en-us/entra/agent-id/)).
- **Steward vs Admin** (Recommendation): Stewards curate (certify, approve records, override metadata, attach policies). Admins also manage roles, sources and settings. AWS's Curator vs Administrator split is the precedent ([concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-concepts.html)).
- **Auditor** is read-everything and write-nothing, plus export. It is separated so that compliance reviewers never hold grant rights. M365 gives a similar caution: View access to the Overview "doesn't grant permission to install, modify, or manage agents" ([overview](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-365-overview?view=o365-worldwide)).
- App roles map from Databricks identity (groups) at login. Platform permissions (UC grants) remain the source of truth for *runtime* access. The app's role decides only what the UI lets you do (Recommendation).

---

## 7. Cost, policy and lineage UX

### 7.1 Cost UX (unit economics, budget bars, anomaly flags)

**Data plumbing (verified columns; join design is a Recommendation)**
- Request counts, tokens, requester, request tags and MCP tool name come from `system.ai_gateway.usage`: `requester`, `requester_type`, `input_tokens`, `output_tokens`, `total_tokens`, `request_tags`, `mcp_metadata.tool_name`, `mcp_metadata.server_type`, `service_type = 'MCP_SERVICE'` ([usage](https://docs.databricks.com/aws/en/ai-gateway/usage-tracking)).
- Databricks-hosted cost comes from `system.billing.usage` `MODEL_SERVING` records enriched with `usage_metadata.ai_gateway.endpoint_name`, `destination_model`, `identity_metadata.run_by` and `custom_tags`. These are in **DBUs** ([cost](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/cost-observability)). Converting to $ needs a list-price join (Inferred: we assume `system.billing.list_prices`; validate in the data spike).
- External model spend comes from `system.ai_gateway.external_model_spend` in **USD**, aggregated hourly, with `request_tags`. Databricks labels these figures as estimates ([cost](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/cost-observability)).
- Budget state comes from Unity Gateway budgets: **Shared thresholds, Per-user thresholds, Per-user overrides**, actions **Send alert / Block usage**, evaluated near real-time ([budgets](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/budgets)).

**Unit metrics** (always show the numerator and denominator in a tooltip):

| Metric | Formula | Where shown |
|---|---|---|
| $ / 1k requests | cost / requests × 1000 | Entity KPI ribbon, catalog column, version compare |
| $ / active user (30d) | cost / distinct requesters | Entity, fleet |
| $ / session | cost / distinct `session_metadata` sessions (Inferred: field semantics) | Agents |
| $ / successful task | cost / sessions with a positive assessment or feedback | Agents with evals (Recommendation) |
| $ / tool call | MCP cost share / `tools/call` count | MCP and Tool pages |
| Tokens / request | total_tokens / requests | Diagnostics |
| Cost mix | share by destination model | Stacked bar |

**Budget bar** (recharts, horizontal):
- Fill shows month-to-date spend. A lighter extension shows the linear forecast to month-end.
- Tick marks show each threshold, labelled "Alert $4k" and "Block $5k". Status chip: On track / At risk (forecast > alert) / Exceeded / **Blocking N users**. Governance Hub has the same **Shared status / Per-user status** split ([Governance Hub](https://learn.microsoft.com/en-us/azure/databricks/admin/governance-hub/ai)).
- Per-user overrides appear as a small table under the bar (admin).
- **Freshness note**, using Databricks's own explanation: "Budget page updates near real-time; billing tables update every few hours; external spend hourly - figures can differ" ([budgets](https://learn.microsoft.com/en-us/azure/databricks/ai-gateway/budgets)).

**Anomaly flags** (Recommendation):
- Daily $/1k requests and total cost are compared with a trailing 14-day median. Flag when a value exceeds 2x the median or a robust z-score of 3.
- Each flag carries a **cause hint**: model changed (version event), token/request spike, a single requester above 50% of spend, error-retry loop (error rate up together with cost).
- The flag appears as an amber chip on the card and the entity KPI. Fleet anomalies list on Usage & Cost and in "Top actions for you". **Explain** opens a breakdown drawer.

**Role-scoped views:** Consumer sees "My spend on X", Owner sees the entity total plus top consumers, Admin and Auditor see the fleet with showback by team/tag. ServiceNow uses the same cost attribution by asset, user and department ([AICT](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)).

**Labelling:** every derived money figure is marked "Estimated" with an info icon. DBU and USD are never mixed in one chart without an explicit conversion note.

### 7.2 Policy and guardrail UX (chips, coverage meter, violations last 7d)

**Policy chips** (compact, icon + text, keyboard-focusable; a click opens the policy drawer):
- `Guardrail · Sensitive data · Input+Output · Block` and `Guardrail · Custom (UC function) · Output` / `Guardrail · External vendor · Input`. These map to Unity Gateway **Guardrail type** Sensitive Data Detection / Custom / External, with phase and **Rank** ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)).
- `Rate limit · 600 QPM` (Overview tab **Service** QPM).
- `Budget · $5k/mo · block` (Unity Gateway budget).
- `Access · EXECUTE · 3 groups` (UC grants).
- `Tools · 12 of 15 enabled · 1 pending review` (tool selection).
- `Approval required · send_mail` (policy action "require approval").
- Inherited chips (from the parent MCP or a domain default) show a small "inherited" marker and link to their origin.

**Coverage meter** (per entity and fleet):
- Headline: **% of traffic through Unity Gateway with at least one guardrail**, following Governance Hub's **Governed Traffic** tile ([Governance Hub](https://learn.microsoft.com/en-us/azure/databricks/admin/governance-hub/ai)).
- Secondary: required policies present vs required for the risk tier (e.g., "4 of 5") and tools reviewed vs total.
- A segmented ring or bar with numbers next to it. Missing items are listed as actionable rows ("Add Output sensitive-data guardrail").

**Violations last 7d:**
- Count, a 7-day sparkline, and a split by action (Blocked / Flagged / Approval required) and by policy.
- Top 3 violating requesters (owner/admin only).
- **View traces** deep-links into the Traces tab filtered to policy decisions.

**Fleet Policies page:**
- A policy library showing where each policy is applied.
- A gaps list ("12 External MCPs without Sensitive Data Detection") with bulk **Apply** (steward).
- A **recommendations** side panel, read-only like Governance Hub's AI recommendations ([Governance Hub](https://learn.microsoft.com/en-us/azure/databricks/admin/governance-hub/ai)).
- Policy changes are versioned and appear in Changes & Impact.

**Graph integration:** nodes carry a shield (full / partial / none), MuleSoft-style ([components](https://docs.mulesoft.com/agent-visualizer/agent-visualizer-components)). Choosing "Show coverage gaps" highlights unshielded nodes.

**Pause / kill switch:**
- A red-outlined action in the header overflow. The dialog requires a reason, shows the subscribers and downstream assets that will be affected, and shows that "configuration will be preserved for restore".
- Afterwards the status reads Paused, with a banner on the entity and a notification to subscribers.
- Precedents: ServiceNow Runtime Pause / Kill Switch ([AICT](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)) and Foundry Block/Unblock ([Foundry](https://learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-manage-agents)).

### 7.3 Lineage graph UX (interactive graph, focus mode, depth control, impact highlight)

**Model** (the graph-building approach is a Recommendation; column names are verified):
- **Node types:** Consumer (user / group / SP), Agent, MCP server, Tool, Skill, Data asset (UC table / view / volume / vector index / Genie space / UC function), and External system. Each type has a fixed shape and icon. Colour tokens are secondary.
- **Edge kinds:**
  - **Declared** (dashed). Sources: registry config, the agent's tool list, MCP tool selection, and subscriber-declared "my agent uses this".
  - **Observed** (solid; thickness = 30-day call volume). Sources: `system.ai_gateway.usage` (`requester` > `service_name`; `mcp_metadata.tool_name`) and MLflow trace spans.
  - **Data** (dotted-solid). Source: UC lineage, tool/function > table.
  - This split copies MuleSoft's declared-vs-runtime edges ([components](https://docs.mulesoft.com/agent-visualizer/agent-visualizer-components)).
- Edges observed in usage logs but not declared are flagged **"Undeclared dependency"**: a governance finding (Recommendation).

**Interactions:**
- **Focus mode.** Opens centred on one entity with **1 hop** by default. A "+" on a node expands one more hop in that direction, matching UC ([UC lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage)). Double-click re-centres. Breadcrumb trail of focus history.
- **Depth control.** A stepper for 1-4 hops plus a direction toggle (Upstream / Downstream / Both). The URL keeps state (`/lineage?focus=urn:mcp:m365-mail&depth=2&dir=down`).
- **Impact highlight.** Pick a change (from Changes & Impact or "What if I change tool X?"). Affected downstream paths are coloured, the rest dims to 20% opacity, and affected nodes carry a counter badge ("14 subscribers"). A side list shows the same set as a table, with export.
- **Layers and filters.** Environment layers (Prod / Non-prod) overlay a fixed base topology so nodes don't move (MuleSoft). Filters: node type, edge kind, time window (7d / 30d / 90d; UC defaults to 1 year), "only observed", "only coverage gaps".
- **Details card** on node or edge click, as a right side panel. Sections: Identity / Capabilities / Deployment / Governance / Health, with metrics (requests, failure rate), owner, trust badge and **Open entity**. MuleSoft details card is the model. Edge cards show source > target, 30-day calls, error rate, last seen and policies on the path. UC's **Lineage details** panel is similar.
- **Masked nodes.** Nodes the viewer cannot see render as grey "Restricted" nodes and cannot be expanded, with **Request access** in the card. Same as UC masked nodes ([UC lineage](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage)).
- **Scale.** Cap rendered nodes (~500, as in MuleSoft). Nodes beyond the cap collapse into cluster nodes ("+38 tools") that expand on click. Search-to-locate; minimap; fit-to-screen.
- **Embedded card vs full page.** Each entity's Lineage tab shows a small graph card, and **Open full graph** goes to the full page (Backstage ([catalog-graph](https://github.com/backstage/backstage/blob/master/plugins/catalog-graph/README.md))).
- **Motion** (framer-motion, per the house motion grammar): node entrance fade/slide 0.4s easeOut; impact path animates with flowing dots (linear, repeat), the same motif as How It Works; all of it disabled under `prefers-reduced-motion`.

---

## 8. Accessibility and performance notes

**Accessibility**
- **Colour is never the only signal.** Every status, trust badge, policy shield and graph edge pairs colour with an icon and text, or a shape/line style (dashed vs solid). Keep text contrast ≥ 4.5:1 in both dark and light themes, and muted text ≥ 70% L as in the house token system.
- **Keyboard:**
  - Tabs follow the WAI-ARIA tabs pattern (arrow keys, Home/End).
  - Tables use row-level focus with Enter to open and Space to select.
  - The command palette is fully keyboard-driven.
  - Focus is trapped in dialogs and returned to the trigger on close.
  - A visible focus ring (`--ring`) on everything focusable.
- **Graph accessibility:**
  - Every graph has an equivalent **table view** (Direction, Type, Name, Edge kind, Last activity) one toggle away.
  - Graph nodes are reachable by Tab in a logical order (focus node first, then by hop); arrow keys move between neighbours; Enter opens the details card.
  - An `aria-live` summary announces changes, e.g. "Impact highlight: 3 agents, 14 subscribers affected".
- **Charts:** each recharts chart has a "View as table" toggle, an `aria-label` summary (e.g., "Cost up 34% vs previous 30 days"), and tooltips that work on keyboard focus.
- **Async state** announced via `aria-live="polite"`: request submitted, provisioning, approved, failed.
- **Native semantics:** native `<button>`, `<select>` and `<a>`. No clickable divs. Badges have `aria-label` text such as "Certified".
- **Reduced motion:** respect `prefers-reduced-motion` across framer-motion; the How It Works dots switch to static arrows.
- **Readable at large sizes:** progressive type scaling tokens at 1280 / 1600 / 1920 / 2560 px (house standard), and a Compact density toggle for admins (M365 Normal/Compact).

**Performance**
- **Skeletons, not spinners.** Use content-shaped skeletons for cards, KPI ribbons, tables and charts. Each tab streams in on its own, so a slow cost query does not block the Overview.
- **Lazy routes and tabs.** Lineage, Quality, Audit and the graph library load on demand. Prefetch an entity's data on card hover/focus.
- **Server-side pagination and virtualization** for catalog lists, traces and audit (cap pages at 50-100 rows). Facet counts come from the server.
- **Read caching.** Heavy system-table reads (usage, billing, lineage) are pre-aggregated into Lakebase on a schedule (Recommendation: hourly), then served with a stale-while-revalidate cache (TTL ~5 min). This avoids 504s on warehouse cold starts (house gotcha) and keeps p95 page loads under 1s.
- **Data freshness stamps** on every metric block ("As of 10:05 · source: system.billing.usage"). Plus the **source pill** (Lakebase / Warehouse / Synthetic) and the never-crash fallback chain: read endpoints never 500 and degrade to labelled synthetic data (house standard).
- **Optimistic writes** where the action is cheap and reversible: subscribe/unsubscribe, pin, description draft save, tag edits, notification preferences. Each shows an Undo toast (≈6s) and rolls back on error.
- **No optimistic writes** for grants, publishes, pauses or overrides. These show an explicit pending state and confirm from the server, because they change real permissions or runtime.
- **Graph performance:** progressive expansion (one hop at a time), clustering over ~500 nodes, layout computed in a Web Worker, and layouts memoized per focus/depth.
- **Long operations** (sync, eval compare, impact preview over large lineage) run as background jobs with a progress indicator and an in-app notification when done. The UI never holds a request open past ~30s.
- **Error UX:** expandable error banners with request ID and a retry action. A frontend `ErrorBoundary` per tab, so one failing tab never blanks the whole page (house standard).

---

### Appendix A - Open questions to validate in a spike

1. DBU-to-$ conversion: confirm the `system.billing.list_prices` join and how to reconcile it with budget near-real-time estimates (Inferred).
2. Whether the `session_metadata` field in `system.ai_gateway.usage` is populated for agent traffic, so $/session can be computed (Inferred).
3. What app-level OBO vs SP permissions are needed to read `system.ai_gateway.usage`. The built-in dashboard notes that SELECT on the table is restricted to account admins ([usage](https://docs.databricks.com/aws/en/ai-gateway/usage-tracking)). Plan for a pre-aggregated copy in Lakebase.
4. API availability to change MCP tool selection after registration. Docs say this is done through the API (`config.include_tool_selectors`), not the UI ([govern MCP](https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service)). Confirm the app SP can call it.
5. Interop with Microsoft Agent 365 Connected platforms (Databricks Genie sync): which identifiers to expose so records match across both registries ([Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms)).
