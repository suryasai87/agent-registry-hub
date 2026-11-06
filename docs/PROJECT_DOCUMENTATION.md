# Agent Registry Hub: project documentation

A Databricks App that is the **central registry for AI Agents, MCP servers, Tools and Skills**. It shows:
- **owners**, **usage**, **cost**, **traces** and **evals**;
- **permissions**, with **request-access → owner-approval → grant**;
- **policies and guardrails**;
- **upstream/downstream lineage**, with **change-impact tracking**.

Every consumer is identified by **email**. Lakebase (Postgres) backs fast UI reads and an append-only, hash-chained audit trail.

- Research: [`RESEARCH_SUMMARY.md`](RESEARCH_SUMMARY.md) (+ five detailed notes in [`research/`](research/))
- API contract: [`API_CONTRACT.md`](API_CONTRACT.md) (the single source of truth for backend and frontend shapes)

## 1. Requirements → features

| Requirement | Where it lives |
|---|---|
| Central registry of agents, MCPs, tools, skills | **Catalog** (facets, search, grid/list), **entity pages** with 11 capability-aware tabs; the collectors keep it current |
| Usage, traces, owners, permissions | Entity tabs **Usage & Cost**, **Traces**, **Access**; owners in the header; **Usage & Cost** and **Quality** fleet pages |
| Request access, owners grant from the UI | **Request access** dialog → **Requests** review queue → *Provision* (grant directly / add to group / record only) → UC or endpoint/Genie ACL grant with expiry; reminders and expiry sweeps |
| Costs as exposed by Unity Gateway / system tables | `system.billing.usage × list_prices` (incl. `AGENT_BRICKS`, `SUPERVISOR_AGENT`), `external_model_spend`; $/1k requests, $/user, budgets, anomalies (all marked *Estimated*) |
| OSS MLflow APIs where available | MLflow 3 trace search + assessments + run metrics; MCP Registry `server.json` (the hub *serves* `/v0.1/servers`) |
| Roles and view access for all users | Viewer for every SSO user; derived Consumer/Owner; assigned Steward/Admin/Auditor; admin **View as** preview |
| Owner description widget; external MCP auto-pull + admin edit | **Overview** tab: structured fields with provenance chips (*Auto-pulled · source*, *Edited by owner*, *Edited by admin*), override-with-reason, lock mode (keep/follow), drift banner, history |
| Policies and guardrails | **Policies** tab + fleet page: chips (Unity Gateway, Serving AI Gateway, UC gates, budgets), coverage per risk tier, gaps, violations over 7 d |
| Owner experience: evals and traces | **Traces** + **Evals** tabs for Databricks-built agents (experiment linked from the endpoint tag, the Agent Bricks tile or Agent Runtime) |
| Every user of an agent recorded in Lakebase, for lineage and impact | `usage_event` (every registered use carries an email), `subscription` (email required), observed `consumes` edges from system tables → **Lineage** explorer and the **impact preview / report** |
| Release-feed subscription (Databricks release notes, OSS MLflow): a new feature or API triggers an app-update check with regression tests on a Lakebase branch, and the app prompts admins to accept or delay breaking changes; non-breaking ones can upgrade automatically | **Platform Watch** (§6a): RSS/Atom feeds → scoring → API probes → update candidates → **branch regression** → **Platform updates** page + admin banner (Accept / Delay / Reject), auto-upgrade policy, audit |
| Users who use or subscribe must enter their email | Subscribe dialog (email required, team DLs, downstream declaration); `POST /api/v1/usage` requires `consumer_email`; access requests offer **Subscribe me** prefilled from SSO |
| Lineage visible where data people look; one agent, one identity across registries; MCP tool exposure governed like a change | **Interop** (§6b): publish the hub's lineage to **Unity Catalog external lineage** (plan → admin publish, optional sync step); **Microsoft Agent 365** IDs in "Also registered in" (Graph or export file, steward review); the **MCP tool-selection editor** (UC `include_tool_selectors`, breaking changes announced through change management) |

## 2. Architecture

```
 Databricks APIs ──┐                      ┌───────────── Databricks App (FastAPI monolith, app/) ───────────────┐
 serving endpoints │                      │  React 19 SPA (app/static)  ←→  /api/* routers (app/modules/*_api)  │
 Agent Bricks v2.1 │   sync job (hourly,  │  domain services (app/registry/*): cards · fields · access ·        │
 Genie · UC conns  ├─► runs as deployer)──►  subscriptions · changes/impact · lineage · usage · policies ·      │
 MCP services      │   app/collectors/*   │  quality · governance · audit · subregistry (/v0.1/servers)         │
 UC functions/skills│                     │  tiers.serve: Lakebase → labelled synthetic (reads never 500)       │
 apps · MLflow     │                      └────────────────────────┬────────────────────────────────────────────┘
 system tables ────┘                                               │ psycopg pool, OAuth token minted per ~50 min
   ai_gateway.usage · serving.endpoint_usage ·                     ▼
   billing.usage × list_prices · access.audit ·        Lakebase project agent-registry-hub · schema registry
   mlflow.* · information_schema                         (registry tables + hash-chained audit_log)
```

- **Collectors** (`app/collectors/`, run by `jobs/sync_registry.py` via `pipeline/run_sync.py`) execute as the **deployer**, because system tables such as `system.ai_gateway.usage` are admin-restricted and listings are caller-scoped. They upsert assets, source fields, owners, grants, policies, usage, cost, traces, evals and lineage into Lakebase.
- **Change detection.** Every sync snapshots each asset's normalised config. A diff becomes a `change_event` (tools removed → breaking) with frozen impact rows and notifications.
- **The app** reads only from Lakebase (fast, never blocked by a cold warehouse). Writes are governed. Each one commits together with its audit row.
- **Provisioning** of approved requests runs **as the approver** when Apps user authorization (OBO) forwards a token, otherwise as the app SP. Locally and in tests it is `record_only`: the grant is recorded and the exact statement is shown.
- **Writes back to the platform** are few and explicit: grants (above), the **Unity Catalog external lineage** publish (admin, plan first) and **MCP tool selection** (owners/stewards). They follow the same identity rule (approver with OBO, else the app SP) and the same `record_only` mode, which stores the exact request instead of sending it.

## 3. Data model (Lakebase schema `registry`, `pipeline/migrations/`)

| Table | Purpose |
|---|---|
| `asset` | One row per agent / MCP server / tool / skill. A URN key (see the contract) carries type, subtype, source, platform, publisher, parent, lifecycle + runtime status, certification, sensitivity, risk tier, tags, `external_ref`, `attributes`, plus a full-text `search` column |
| `asset_field` / `asset_field_history` | Description fields with provenance: `source_value` (auto-pulled + `source_label`) vs `override_value` (owner/admin, reason, lock mode); `drift` flag; revision history |
| `asset_owner` | Owner, co-owner, sponsor, steward (synced or assigned) |
| `asset_version`, `change_event`, `impact_item` | Versions, published or detected changes (kinds, breaking, diff, metrics before/after), and **frozen impact rows per person or asset with acknowledgement status** |
| `subscription` | Email-registered consumers: team emails, kind, downstream asset or free text, environment, notification preference |
| `usage_event`, `usage_daily`, `cost_daily`, `budget` | Registered uses (with email), daily rollups from system tables, cost at list price, budgets |
| `access_settings`, `access_request`, `access_grant` | Approval policy (approvers, any/all, durations, SLA, terms), requests (SLA, expiry, approvals, provisioning result), grants (platform-synced + app-provisioned with expiry) |
| `policy`, `policy_binding`, `policy_requirement`, `policy_violation_daily` | Guardrails and controls, bindings, required controls per risk tier (coverage), violations |
| `lineage_edge` | `src` uses `dst`; `declared` (config, subscription), `observed` (usage), `data` (tables) |
| `asset_experiment`, `trace_daily`, `trace_recent`, `eval_result` | Experiment links, trace rollups, recent trace metadata (**never payloads**), scorer results |
| `notification`, `sync_run`, `role_assignment`, `app_user` | Outbox/inbox, collector runs, assigned roles |
| `feed_source`, `feed_item`, `capability`, `update_candidate`, `watch_settings` | Platform Watch: subscribed feeds, scored items, probed APIs, candidates with regression/apply reports and decisions, policy |
| `audit_log` | Append-only: UPDATE/DELETE/TRUNCATE blocked by triggers; `row_hash = sha256(prev_hash ‖ row)`; `verify_audit_chain()` |
| `registry_setting` | Admin switches (audited), e.g. `uc_lineage_publish_in_sync` (default **false**), plus `hub_instance_id` (salts UC object names per install) and the hub URL the last publish used |
| `uc_lineage_object`, `uc_lineage_relationship`, `uc_lineage_run` | What the hub published to Unity Catalog (external metadata name/id per asset, relationship id per source → target pair, content hash, mode `platform`/`record_only`, status, last error) and every publish run (digest, outcomes, errors, exact requests) |
| `external_registration` | Records from other registries (Microsoft Agent 365): Microsoft ID, name, platform, identifying hints, matched asset, method, confidence, status `matched`/`suggested`/`unmatched`/`linked`/`dismissed`, steward review |
| `mcp_tool_selection` | Every `include_tool_selectors` change requested from the app: before/after, hidden/exposed tools, breaking, etag, the exact PATCH, mode, acting identity, status `applied`/`recorded`/`failed`, change id |
| `kg_export_run` | Every knowledge graph export (admin or sync step): target, digest, mode, acting identity, status `succeeded`/`unchanged`/`conflict`/`failed`, counts, ownership conflicts, the SQL run or recorded. Settings `kg_export_in_sync` (default **false**), `kg_target_catalog` / `kg_target_schema` / `kg_store_version` |

## 4. Roles

Viewer (everyone) · Consumer (has a subscription or an app grant) · Owner (per asset) · Steward · Admin · Auditor (reads everything, writes nothing). The matrix is in `docs/research/03-ux-benchmark.md` §6. Enforcement is in `app/registry/authz.py`.
- Field overrides of synced values and certification: **steward/admin**.
- Description edits, access decisions and publishing: **owners** (and approvers).
- Role management: **admin**.
- Consumers see only their own traces and usage, and other consumers' emails are collapsed in lineage.

**Lifecycle on discovery.** Databricks-native assets (Agent Bricks, Genie, managed and Databricks-provided MCP, UC functions, UC skills, Model Serving agents) register as **approved**, because Unity Catalog and workspace ACLs already govern them. External and custom assets (third-party MCP connections, custom MCP apps and their tools) start as **discovered** and wait in the steward curation queue. Only approved MCP servers are published through `/v0.1/servers`. (Collectors: `upserts.initial_lifecycle`; existing rows: migration 006.)

## 5. Key flows

1. **Subscribe** (email required). This writes `subscription` and declared lineage (`user → asset`, and `downstream asset → asset` when declared), plus a confirmation notification.
2. **Request access** (justification ≥ 15 chars, duration ≤ owner max, terms, *Subscribe me* prefilled).
   - Approvers are resolved explicit approvers → owners → stewards → admins, and notified.
   - Approve → provision → grant with expiry. Deny needs a reason. Failed provisioning keeps the statement for Retry.
   - Sweeps: reminder at day 3, request expiry at day 7, and revocation of expired grants.
3. **Describe and override.**
   - Owners edit owner-authored fields.
   - Synced fields (e.g. an external MCP's description, publisher or auth model) can be **overridden by a steward/admin with a reason**. The lock mode decides whether the next sync keeps or replaces the override, and a changed source under a kept override raises **drift**.
4. **Publish a change.**
   - Preview shows the subscribers, the downstream assets (lineage ≤ 3 hops) and their owners, the observed but unregistered consumers, the email preview and pre-publish checks.
   - Publish freezes `impact_item` rows and notifies. Breaking changes need ≥ 14 days notice and release notes.
   - Recipients acknowledge: *not impacted*, *will migrate by date*, or *need help* (which notifies the publisher).
   - Metrics before/after (7 d) are backfilled by the sync.
5. **Register usage from code** (agents, notebooks, jobs):
   ```bash
   curl -X POST "$APP_URL/api/v1/usage" -H "Authorization: Bearer $(databricks auth token | jq -r .access_token)" \
     -H 'Content-Type: application/json' \
     -d '{"asset_id":"mcp:system:system.ai.microsoft_365","consumer_email":"jane.doe@company.com","operation":"tool_call","via_asset_id":"agent:endpoint:my-agent"}'
   ```
6. **MCP subregistry.** `GET $APP_URL/v0.1/servers` lists the approved MCP servers in standard `server.json` form, with governance metadata under `_meta["com.databricks.agent-registry-hub"]`.
7. **Publish lineage to Unity Catalog** (admin): Governance › Unity Catalog lineage shows the plan (creates, updates and deletes with their requests); **Publish** applies exactly that plan (§6b).
8. **Microsoft Agent 365 IDs**: the Graph collector or an admin's export import matches Microsoft records to agents; stewards review the rest; the Overview shows the Microsoft ID with provenance (§6b).
9. **Change an MCP service's tool selection** (owners, stewards): Tools exposed › Edit selection → live preview → impact preview → Apply (§6b).

## 6a. Platform Watch: release feeds → branch-tested, governed self-upgrade

| Stage | What happens | Code |
|---|---|---|
| Subscribe | The `registry_updates` job (every 6 h, and on demand from the app) reads RSS/Atom feeds: **Databricks release notes** (`docs.databricks.com/aws/en/feed.xml`), **MLflow releases**, and the **Databricks SDK / CLI releases**. Items are stored once per guid. | `registry/platform_watch.fetch_feeds` |
| Score | Each item is scored 0–100 against the **capability catalog**: APIs the registry uses or will use (MCP services, Supervisor/KA, Genie, skills, MLflow traces, usage/cost tables, RFA, service policies, Agent Runtime). Title hits weigh most. Lifecycle (GA / Public Preview / Beta / deprecation) and breaking hints are read from the title first. | `classify`, `CAPABILITIES` |
| Probe | Every capability is probed in **this** workspace with a read-only REST call or a `SELECT 1` on a system table: available / unavailable (`ENDPOINT_NOT_FOUND`, "not available in this workspace") / no_access / error. `first_available_at` records when a new API appeared. | `probe_capabilities`, `classify_probe` |
| Candidates | **app_release**: the staged bundle `VERSION` is newer than the running one (`watch_settings.running_version`), with pending migrations analysed for breaking DDL/DML (`-- breaking:` headers, DROP/RENAME/TYPE/NOT NULL/DELETE). **capability**: a newly available API whose adapter ships disabled. **advisory**: one per capability for relevant announcements, or a new API without an adapter. | `detect_candidates`, `analyze_migration` |
| Regression | On a **throwaway Lakebase branch** (copy-on-write from production, TTL): row-count snapshot → pending migrations → **data preservation** (no rows lost unless `-- allow-data-loss`) → collector compatibility into the branch → **read-path smoke checks on the live-data copy** (catalog, home, lineage, usage, policies, quality, changes, subregistry; each under 5 s) → **pytest suite** with scratch schemas on the branch. The branch is deleted on success and kept on failure for debugging. | `registry/regression.check`, `LakebaseBranches` |
| Decide | Admins get a banner plus Home top actions. **Platform updates** shows the regression timeline, migrations and breaking reasons. **Accept** (a breaking change needs a note) starts the apply job; **Delay** (default 7 days; it resurfaces automatically); **Reject** (reason required). Advisories are acknowledged. Everything is audited. | `watch_api`, `decide`, `resurface_delayed` |
| Apply | Migrate production, enable the adapter, and for app releases **deploy the staged app source** (`POST /api/2.0/apps/{name}/deployments`). `running_version` is then updated. Failures are recorded as `apply_failed` with the step detail. | `registry/regression.apply` |
| Auto-upgrade | `watch_settings.auto_upgrade`: `never` / `non_breaking` (default) / `all`. Only regression-passed app releases and capabilities qualify; advisories always wait for a person. | `check` |

**Safety rules.** The sync and watch jobs run from the *staged* bundle, so they never apply pending migrations: the sync uses `--skip-migrations`, and watch bootstraps only its own tables (≤ `005`). Schema changes reach production only via the setup job on an explicit deploy, or via an accepted (or policy-eligible) Platform Watch apply after its branch regression passed. A test (`test_watch_bootstrap_never_applies_staged_migrations`) guards this.

**Release flow.** Bump `VERSION` **and** `app/VERSION` (Platform Watch stages by the root file; the app reports `app/VERSION` in `/api/health`; a test keeps them equal), add additive migrations, then run `STAGE_ONLY=1 ./scripts/deploy.sh demo DEFAULT`. The bundle is staged, the app is not restarted, and Platform Watch runs. Review the candidate under **Platform updates** and accept or delay it. The branch regression runs pytest on a copy of `regression.REGRESSION_DIRS` / `REGRESSION_FILES` only (the bundle never syncs `docs/` or `frontend/`); a test fails if any test reads another top-level path.

## 6b. Interop: Unity Catalog lineage, Microsoft Agent 365, MCP tool selection, the knowledge graph

### Publish lineage to Unity Catalog external lineage (`registry/uc_lineage.py`)

| | |
|---|---|
| What is published | Each approved (or deprecated) asset with publishable lineage becomes an **external metadata** object: name `agent_registry_hub__<urn slug>__<hash(install id + URN)>`, `system_type` DATABRICKS (Databricks-native) or OTHER, `entity_type` Agent / MCP server / Tool / Skill, `url` = the hub page, `properties` `created_by=agent-registry-hub`, `hub_instance`, `asset_id`, type, owners, lifecycle, certification. `reads_data` / `writes_data` edges to `table:<catalog.schema.table>` become table ↔ object **relationships** (reads: table → asset; writes: asset → table). Dependency edges between two assets become object → object relationships from the dependency to the dependent (`uses_tool`: tool → agent). People, service principals, volumes, indexes, apps and models stay in the hub; the plan lists them as *not published*. |
| Plan first | `GET /api/lineage/uc-publish` diffs the desired state against `uc_lineage_object` / `uc_lineage_relationship` and lists every create / update / delete with its exact request, plus a digest. It writes nothing. |
| Publish | An **admin** publishes the previewed digest (`POST`; a changed plan answers 409). Each run writes one `audit_log` row (`lineage.uc_publish`) and one `uc_lineage_run` row with outcomes, errors and, in record_only, the requests. Up to 1,000 operations per run; the rest stays in the next plan. |
| Ownership safety | The hub updates or deletes only objects in its tracking tables, and re-reads each one first: `created_by`, `hub_instance` and `asset_id` must match. A name taken by an object the hub did not create is a reported conflict and is never modified; a hub object someone else took over is left in place. A lost tracking row is **adopted** only when the existing object provably is the hub's. Relationships are deleted only by the id the hub recorded. |
| Identity and mode | As the admin when the Apps proxy forwards an OBO token, else the app SP. `record_only` (local, tests) records the requests and calls nothing. |
| Sync-job step | After the collectors and the metrics backfill, `run_all` publishes **only when an admin turned on** *Publish during the hourly sync* (`uc_lineage_publish_in_sync`, default off, audited). It runs as the job's identity and never fails the sync. It checks readiness first and **skips while blocked or unknown**, recording why (§7a). |
| Needs | `CREATE EXTERNAL METADATA` on the metastore and `MODIFY` on each table a relationship touches, for the publishing identity. New objects get BROWSE for all account users (the UC default). |
| Readiness (`registry/uc_readiness.py`) | `GET /api/lineage/uc-publish/readiness` checks, read-only and per identity (app SP, the signed-in admin with OBO, the sync job's run-as identity), the metastore privilege, `MODIFY` on a sample of the plan's tables, and that the external lineage API answers. It returns `ready` / `partial` / `blocked` / `unknown` with the exact grant SQL and who runs it, cached 5 min. While it says `blocked`, Governance disables Publish. Runbook: §7a. |

### Microsoft Agent 365 → "Also registered in" (`registry/agent365.py`, `collectors/agent365.py`)

Agent 365 *Connected platforms* lists Databricks Genie agents in the Microsoft 365 agent registry ([research 05](research/05-agent365-interop.md)).
- **Inputs.**
  - The optional `agent365` collector pages `GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages` through the UC HTTP connection named in `AGENT365_CONNECTION` (bundle variable `agent365_connection`, default `none` = off). The Entra credential lives in the connection, never in the app or the job.
  - An **admin** uploads the admin-center export (*Agents › All agents › Export*, CSV) or a JSON export in Governance › Agent 365.
- **Matching.** Only Databricks records are kept.
  - A Genie space id or Genie URL in the record (→ `agent:genie:<id>`), a serving endpoint or an app name match with confidence 1.0 / 0.95 / 0.9. The confidence is halved when the record names another workspace host.
  - Otherwise the normalised name matches (exact 0.9, fuzzy lower).
  - ≥ 0.85 links. Weaker matches are *suggested* and the rest *unmatched*; both wait for a **steward** (link / dismiss / reopen, each with a reason). Decisions survive re-imports. No asset is ever created.
- **Provenance.** Links are the source value of `asset_field('also_registered_in')`, with source label *Microsoft Agent 365*. A steward can unlink a wrong match (an override with a reason: later imports keep it, and raise drift when the source changes) or revert. Each import writes one `sync_run` row (collector `agent365`) and one audit row; reviews are audited.
- **Display.** Overview › At a glance › *Also registered in*: the registry link, the Microsoft ID (copy), the platform, how it matched, and the provenance.

### MCP tool-selection editor (`registry/tool_selection.py`)

- **Where.** The *Tools exposed* tab of a registered UC MCP service (`mcp:service:<fqn>`). Databricks-provided `system.ai.*` servers and UC connections have no editable selection.
- **Who.** The service's owners and stewards (`asset_permissions.can_edit_tool_selection`). Everyone else sees the current selection read-only.
- **Rules.** Exact tool names or a prefix ending in `*`, at most 1,024 entries of at most 256 characters, no `!` exclusions; an empty selection exposes every tool. The editor validates and previews every keystroke against the known `tool:mcp:service:<fqn>/*` assets.
- **Change management.**
  - *Preview impact* calls `POST …/tool-selection/preview`: the hidden and exposed tools plus the impact preview. The hidden tools are extra start nodes, so agents that call exactly those tools count as downstream.
  - Hiding a tool that is exposed today, or narrowing "every tool", is **breaking**. A reason is required, and Apply publishes a breaking `change_event` (effective now) that notifies subscribers, downstream owners and observed callers.
- **Apply.**
  - `PATCH /api/2.1/unity-catalog/mcp-services/{fqn}?update_mask=config.include_tool_selectors` (with the last synced `etag`), as the approver with an OBO token, else the app SP. In `record_only` the exact request is stored and shown.
  - A refused PATCH changes nothing in the registry, announces nothing, and keeps the request for the owner.
  - A successful one updates the asset and its version snapshot, so the next sync does not report the same change again.
  - Every attempt is audited (`mcp.tool_selection.applied|recorded|failed`).

### Knowledge graph for Genie and OntoBricks (`registry/knowledge_graph.py`, `registry/kg_delta.py`)

The registry as RDF triples `(subject, predicate, object)`, materialised as Unity Catalog Delta objects in the layout [OntoBricks](https://github.com/databrickslabs/ontobricks) documents, so Genie agents can answer graph questions in SQL and OntoBricks' Explorer can open the store. The layout and the companion-index semantics were re-implemented from OntoBricks' documented schema (Databricks License; no code copied); credit to the OntoBricks authors.

**What is emitted** (sorted, de-duplicated, deterministic; the digest changes only when the registry does):

| | Triples |
|---|---|
| Assets | `rdf:type` the class of the asset type (`Agent`, `McpServer`, `Tool`, `Skill`) **plus** a subtype class where the data has one (`GenieAgent` ⊂ `Agent`, `SupervisorAgent`, `KnowledgeAssistant`, `ExternalMcpServer`, `UcFunctionTool`, `McpTool`, …); `rdfs:label`; `assetId` (URN), `name`, `subtype`, `lifecycleStatus`, `certification`, `source`, `platform`, `publisher`, `riskTier`, `workspace` (deep-link host), `owner` (one per owner / co-owner), `deepLink`, `hubPage`, `createdAt`, `updatedAt` |
| 30-day aggregates | `requests30d`, `distinctRequesters30d`, `costUsd30d` (estimate), `activeSubscriptions`, `observedConsumers`: counts only, over the last 30 **complete** UTC days so usage moves the digest at most daily |
| Lineage | One object property per `lineage_edge` relation: `usesMcp`, `usesTool`, `callsAgent`, `usesSkill`, `usesModel`, `exposesTool`, `consumes`, `subscribes`, `hosts`, `routesTo`, `readsData`, `writesData`. Non-asset ends become typed nodes: `Table` (keyed by `catalog.schema.table`), `Volume`, `VectorSearchIndex`, `Model`, `DatabricksApp`, `ExternalResource`. Edges to an unregistered asset URN are left out and counted |
| Subscriptions, policies | `registeredConsumerOf` (downstream asset → asset, active subscriptions only); `governedBy` (active binding) / `proposedPolicy`; `Policy` nodes with kind, provider, phase, action |
| Microsoft Agent 365 / Graph | One `Agent365Package` node per `external_registration` record (label, `m365Id`, `platform`, `matchStatus`, `matchMethod`, `matchConfidence`). **linked** (steward) or **matched** with confidence ≥ 0.85 → `registeredAs` the hub asset (deliberately not `owl:sameAs`, which would make a reasoner merge the Microsoft record's facts into the hub asset; `alsoRegisteredIn` is declared as its inverse); **suggested** → `candidateMatch` (+ the confidence); **dismissed** / **unmatched** → no link |

**Privacy.** People and service principals are never nodes: subscriber, requester, notify-list and usage identities are not read at all, only counted in SQL. A guard then scans every subject, predicate and object (IRIs percent-decoded); the only emails allowed are asset owners' (already visible to every hub user). Any other email in a literal becomes `[email]`, a node whose identifier contains one is skipped, and `build` refuses to return if a non-owner email is still present. The Microsoft record's owner and publisher are never exported. A test fails if any email from `subscription`, `access_request`, `usage_daily` or `usage_event` appears in the output.

**IRIs and the ontology.** The namespace is `KG_NAMESPACE` (default `https://agent-registry-hub.example/ontology#`; `.example` is reserved, RFC 2606). Instances follow OntoBricks' `<namespace><Class>/<percent-encoded key>`, e.g. `…#Agent/agent%3Agenie%3A<space id>`. Literals are plain strings (OntoBricks keeps every object in one STRING column and treats values starting with `http` as IRIs). The OWL ontology (30 classes, 18 object properties, 28 datatype properties, each with a label and a comment) is generated from the same Python definitions into [`docs/ontology/agent-registry-hub.ttl`](ontology/agent-registry-hub.ttl); a test keeps the file in sync, and `GET /api/kg/ontology.ttl` serves it with the configured namespace.

**Objects** in the target `catalog.schema` (base `triplestore_agent_registry_hub_V<n>`, OntoBricks' `triplestore_<domain>_V<version>` with domain `agent_registry_hub`):

| Object | Kind | Shape / role |
|---|---|---|
| `<base>_data` | TABLE | `(subject, predicate, object)` STRING, `CLUSTER BY (predicate, subject)` |
| `<base>_inferred` | TABLE | same shape, empty; for OntoBricks reasoning / app-written triples (emptied by each export, like an OntoBricks full Build) |
| `<base>_graph` | VIEW | `_data UNION ALL _inferred`: what OntoBricks' Explorer reads |
| `<base>` | VIEW | pass-through over `_data` (see below) |
| `<base>_adj_out` / `_adj_in` | TABLE | `(src, predicate, dst)` `CLUSTER BY (src, predicate)` / `(dst, predicate, src)` `CLUSTER BY (dst, predicate)`; IRI objects only, no `rdf:type`/`rdfs:label`; out-hops need a typed object, in-hops a typed subject |
| `<base>_entity_search` / `_entity_search_asserted` | TABLE | `(uri, type_uri, label, uri_lc, label_lc)` `CLUSTER BY (type_uri, label_lc)`, one row per typed node (smallest type and label), from `_graph` / `_data` |
| `<base>_props` | TABLE | every triple of a typed subject, `CLUSTER BY (subject)` |
| `kg_nodes`, `kg_edges`, `kg_registry_matches` | VIEW | flat, table- and column-commented views for Genie: nodes with type, subtype, label, URN and attributes; edges with source/target IRI, label, type, URN, the hub relation and the predicate label; Agent 365 record ↔ hub asset with status, method, confidence and link |

*The base object.* In OntoBricks it is the R2RML VIEW that maps source UC tables to triples, and `_data` is a CTAS of it. The hub's source is Lakebase, which Unity Catalog cannot read without a Lakehouse Federation catalog the hub does not assume, and the mapping (privacy scrubbing, Agent 365 rules) is tested Python. So the app computes the triples, loads `_data`, and the base name is a pass-through VIEW over `_data`: every name OntoBricks derives from the base resolves, and nothing pretends to be a live mapping.

**Preview → export.**
- `GET /api/kg/preview` (stewards, admins, auditors) builds the triples and returns counts per class and predicate, samples, what was left out, the target FQNs with Catalog Explorer links, every SQL statement (the INSERT batches summarised) and a digest. It writes nothing.
- `POST /api/kg/export {digest}` (**admin**) exports exactly that digest (409 when the graph changed, there is no target, or another export to the target is running). Writes go through `core.warehouse` (Statement Execution): `CREATE OR REPLACE` a staging table, `INSERT … VALUES` batches under 900 KB each, a row-count check, an atomic `CREATE OR REPLACE TABLE <base>_data … AS SELECT` from the stage, the companions and views, then `DROP` the stage. String literals use backslash escapes (Databricks SQL turns `'d''achat'` into `dachat` without an error); control characters and `$` are `\uXXXX`; unicode passes through the JSON request. Verified on the live warehouse with quotes, backslashes, newlines, `${…}`, CJK and emoji.
- **Unchanged digest:** in platform mode the run is skipped (`unchanged`, no SQL) when every object already carries `kg_digest` = the digest in its TBLPROPERTIES; record-only runs and the sync step compare with the last successful `kg_export_run`.
- **Ownership safety:** every object carries TBLPROPERTIES `created_by=agent-registry-hub`, `hub_instance`, `kg_role`, `kg_digest`, `kg_layout`. Before any write the export reads each target name through the UC Tables API; a name taken by an object without the hub's `created_by` + `hub_instance` (including another hub install's) is a reported **conflict** and the run writes nothing. The export creates the target schema when it is missing, never drops a schema, and never touches any other object. An object of its own of the other kind (TABLE ↔ VIEW) is dropped and recreated.
- One `kg_export_run` row and one `audit_log` row (`kg.export`) per run. `record_only` (local, tests) records the statements and calls nothing.
- **Settings:** target catalog / schema / version in Governance (admin, audited) win over the bundle variable `kg_target` (`--var kg_target=<catalog>.<schema>`, default `none` = not configured). *Export during the hourly sync* (`kg_export_in_sync`) is **off** by default; the step runs after the UC lineage step, skips when the digest is unchanged, runs as the job's identity and never fails the sync. Staged jobs never migrate: the step is gated on `kg_export_run` existing.
- **Needs:** `USE CATALOG` (+ `CREATE SCHEMA` the first time), `USE SCHEMA` + `CREATE TABLE` on the target schema, and `CAN USE` on the SQL warehouse, for the app SP or the exporting admin (OBO).

**Open it in OntoBricks.** Import `docs/ontology/agent-registry-hub.ttl` as the domain ontology; name the domain `agent_registry_hub`, set its version to the hub's `kg_store_version` (default 1), choose the Databricks (Delta) graph backend with *table* materialisation, and point its triple-store location (registry `catalog.schema`) at the export schema. Explorer then reads `<base>_graph` and the `_adj_*`, `_entity_search*` and `_props` companions. Do **not** run OntoBricks *Build* on this domain: it would replace `_data` from an (empty) R2RML mapping, and the hub would then see objects without its TBLPROPERTIES and report conflicts instead of overwriting them. *Refresh cache* only rebuilds the companions and is safe. This was checked against OntoBricks' documentation and SQL (master @ 97b27c7), not against a running OntoBricks.

**Genie space.** `python scripts/create_kg_genie_space.py --target <catalog>.<schema>` prints (dry run) a Genie space over `kg_nodes`, `kg_edges`, `kg_registry_matches` and `<base>_graph`: one-line instructions (the Genie API re-splits instruction text on newlines) and 10 example question SQLs (Agent 365 packages ↔ Genie agents, records awaiting a steward, what breaks if an MCP server changes, agents that use tool Y and read table Z, tools per MCP server, top table readers, supervisors and sub-agents, 30-day usage and cost, high-risk agents without a guardrail, every fact about one node). `--verify --warehouse-id <id>` runs each example SQL read-only; only `--create --yes` creates the space.

## 6. Never-crash and auditability

- Every read goes through `modules/_http.read` → `core.tiers.serve`: Lakebase first, then the **labelled synthetic** demo fleet (amber *Synthetic* pill). A domain 404/403 is returned as such, never masked.
- Writes return 400/403/404/409/503 with a clear `detail`. They are never optimistic for grants, publishes or overrides.
- The frontend has an ErrorBoundary per route and per tab, plus a source pill on every page.
- Audit: every governed change writes one `audit_log` row in the same transaction. `GET /api/audit/verify` recomputes the hash chain, and CSV/JSON export is available for auditors.

## 7. Deployment runbook

Prerequisites:
- Databricks CLI ≥ 1.20, authenticated (`databricks auth login -p <PROFILE>`).
- A **free app slot**. Workspaces cap at 100 apps; `your-workspace` was at the cap on 2026-10-25.

```bash
./scripts/deploy.sh demo DEFAULT                         # default workspace target
./scripts/deploy.sh new_workspace <PROFILE> --var warehouse_id=<id>
CODE_ONLY=1 ./scripts/deploy.sh demo DEFAULT             # app code only
```

The script:
1. builds the frontend (via the npm proxy);
2. runs `bundle validate` + `deploy`, which creates the Lakebase project `agent-registry-hub` (prevent_destroy), the app, and the setup and sync jobs;
3. runs `registry_setup`: migrations, the app SP's `LAKEBASE_OAUTH_V1` role, least-privilege grants (audit_log is INSERT/SELECT only);
4. runs `bundle run registry_app`;
5. triggers the first `registry_sync` (the job is then hourly);
6. verifies `ACTIVE` + `SUCCEEDED` and HTTP 200 on `/`, `/api/health`, `/api/me`, `/api/catalog`.

Options:
- **OBO grants:** add Apps user authorization scopes (`unity-catalog`, `access-management`, plus `ai-gateway` / `sql` as needed) so approvals provision as the approver. Without them, the app SP needs MANAGE / CAN_MANAGE on the objects, or approvers apply the shown statement.
- **Email delivery:** `--var notify_webhook_url=https://…` posts each email notification as JSON `{to, subject, body, link}` to any relay. Delivery status is recorded.
- **Skills:** `--var skill_schemas=cat.schema,…` adds UC schemas to scan, besides those found in audit logs.
- **Bootstrap admins:** `--var registry_admins=a@x.com,b@x.com` (default: the deployer).
- **Platform Watch cadence:** `--var watch_cron="0 40 */6 * * ?"`. **Staged releases:** `STAGE_ONLY=1 ./scripts/deploy.sh …` (see §6a).
- **Unity Catalog lineage publishing:** see §7a. In short: a metastore admin grants `CREATE EXTERNAL METADATA`, table owners grant `MODIFY`, the Readiness checklist confirms it, then an admin publishes once by hand before turning on the hourly step.
- **Microsoft Agent 365 via Graph:**
  1. Create an Entra app with the application permission `CopilotPackages.Read.All` (the tenant needs an Agent 365 license).
  2. Create a UC HTTP connection to `https://graph.microsoft.com` (base path `/`, OAuth machine-to-machine with the Entra token endpoint and scope `https://graph.microsoft.com/.default`).
  3. Grant `USE CONNECTION` to the sync job owner, then deploy with `--var agent365_connection=<connection>`.
  Without it, admins import the export file.
- **MCP tool selection:** the PATCH needs owner or `MANAGE` on the MCP service, plus `USE CATALOG` / `USE SCHEMA`. With the `unity-catalog` user-authorization scope it runs as the approver.
- **Knowledge graph export:** `--var kg_target=<catalog>.<schema>` (or set it in Governance › Unity Catalog lineage › Knowledge graph). The exporting identity needs `USE CATALOG` (+ `CREATE SCHEMA` when the schema is new), `USE SCHEMA` and `CREATE TABLE`. Preview, export once by hand, then turn on *Export during the hourly sync* if wanted. `KG_NAMESPACE` changes the ontology namespace (regenerate the `.ttl` with the same value).

## 7a. Turning on UC lineage publishing

Publishing is wired and tested but stays dormant until the publishing identity holds two Unity Catalog privileges. No code change is needed once they are granted: the next Re-check turns the checklist green and enables Publish. The one possible configuration change is the `unity-catalog` user-authorization scope, needed only when the proxy forwards user tokens (the `obo` path below).

**Who publishes as whom.**

| Path | Identity | Used when |
|---|---|---|
| `app` | The app service principal, by its **application (client) id** | An admin clicks Publish and the Apps proxy forwards no user token |
| `obo` | The signed-in admin, by email | An admin clicks Publish and the proxy forwards their token (user authorization). The API call needs the `unity-catalog` user-authorization scope; without it the readiness API check fails with the fix |
| `sync` | The sync job's run-as identity (the deployer unless `run_as` is set) | *Publish during the hourly sync* is on |

**Who grants what.**

| Grant | Who runs it | Blocking? |
|---|---|---|
| ``GRANT CREATE EXTERNAL METADATA ON METASTORE TO `<application-id or email>`;`` | A **metastore admin** (a member of the metastore owner, e.g. `metastore_admins`) | Yes: nothing can be published without it |
| ``GRANT MODIFY ON TABLE `c`.`s`.`t` TO `<application-id or email>`;`` (or the broader `ON SCHEMA`) | Each **table owner**, or anyone with `MANAGE` on the table, its schema or its catalog | No: without it only that table's relationships fail (the run is `partial`), and the next plan retries them |

Steps:

1. **Print the grants.** This only prints; it never runs a grant:
   ```bash
   python3 scripts/uc_lineage_grants.py demo DEFAULT > /tmp/uc_lineage_grants.sql
   ```
   - The script resolves the app SP via `databricks apps get <app>` and the sync job identity via `databricks jobs get`.
   - It reads the tables from the deployed app's latest plan (`GET /api/lineage/uc-publish` with your CLI token; you need the steward, admin or auditor role). If the app is unreachable, pass `--tables-file`.
   - Options: `--app-only` (skip the sync identity) and `--principal <email>` (an admin who publishes with OBO).
2. **Grant.** Send block 1 to a metastore admin and the per-schema blocks of block 2 to the table owners. Service principals are named by application id in backticks, e.g. ``GRANT CREATE EXTERNAL METADATA ON METASTORE TO `cd960439-5173-4ef4-8f1d-1cefe69d5435`;``.
3. **Verify readiness.** Open Governance › Unity Catalog lineage › Readiness and click **Re-check** (the answer is otherwise cached for 5 minutes, or 30 s when it is `unknown`). Or from a shell:
   ```bash
   curl -s -H "Authorization: Bearer $(databricks auth token -p DEFAULT | jq -r .access_token)" \
     "$APP_URL/api/lineage/uc-publish/readiness?refresh=true" | jq '.data | {status, reason, active_path}'
   ```

   | Status | Meaning | Publish |
   |---|---|---|
   | `ready` | Every check passes for the identity Publish uses | Enabled |
   | `partial` | The metastore privilege and the API are fine; some sampled tables lack `MODIFY` or do not exist | Enabled, with a warning: those relationships fail and are retried |
   | `blocked` | `CREATE EXTERNAL METADATA` is missing, or the API refuses the identity (e.g. a forwarded token without the `unity-catalog` scope) | **Disabled**, with the reason |
   | `unknown` | A check's API call failed, so nothing is claimed | Enabled; the run reports any refusal |
   | `not_required` | `record_only` mode: nothing is sent | Enabled |

   The table check samples 20 tables spread over the plan (`UC_READINESS_MAX_TABLES`); the script covers every table.
4. **First manual publish.** Review the plan, then click **Publish**. The run row shows `succeeded` or `partial`, with per-operation errors. Check an agent in Catalog Explorer › Lineage, or a table's lineage graph.
5. **Turn on the hourly step**, only after a good manual run, and only once the `sync` path in the checklist is `ready` or `partial`: grant the sync identity too (the script's block 1 lists it), then flip *Publish during the hourly sync*. Each hourly run checks readiness as the job's own identity before it publishes. When `blocked` or `unknown`, it skips the publish and never fails or raises. It also:
   - logs a warning;
   - returns `uc_lineage.skipped` in the job's JSON summary;
   - updates the status row `registry_setting.uc_lineage_sync_readiness` (shown as *Last hourly check* in the checklist);
   - writes one `lineage.uc_publish_skipped` audit row each time the skip reason changes.

**Live state (your-workspace, 2026-10-28, read-only check).**
- The app SP (`cd960439-5173-4ef4-8f1d-1cefe69d5435`) and the sync identity (the deployer) both lack `CREATE EXTERNAL METADATA`, so the status is `blocked`. The external lineage list API answers for the deployer.
- The app reports only the default user-authorization scopes (`iam.current-user:read`, `iam.access-control:read`). If the proxy forwards those tokens, UI publishes take the `obo` path and need the `unity-catalog` scope as well.

## 8. Local development and tests

```bash
docker start arh-pg || docker run -d --name arh-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:16   # local only: no password
uv venv .venv && uv pip install --index-url https://pypi.org/simple/ -r requirements-dev.txt
cd app && LAKEBASE_URL=postgresql://postgres@localhost:55432/postgres LAKEBASE_SCHEMA=registry_demo python -m core.migrate
python -m registry.demo_seed            # optional demo fleet (origin=demo) + the demo UC MCP service (seed_extended)
LAKEBASE_URL=… LAKEBASE_SCHEMA=registry_demo LOCAL_USER=you@company.com REGISTRY_ADMINS=you@company.com DATABRICKS_APP_PORT=8765 python app.py
cd ../frontend && npm install && npm run dev            # http://localhost:5173 (proxies /api → :8765)
TEST_DATABASE_URL=postgresql://postgres@localhost:55432/postgres ../.venv/bin/python -m pytest -q   # from repo root
npm test && npm run build                                # frontend
```

A real-data rehearsal runs the collectors read-only against the workspace into local Postgres:

```bash
cd app && LAKEBASE_URL=… LAKEBASE_SCHEMA=registry DATABRICKS_CONFIG_PROFILE=DEFAULT WAREHOUSE_ID=bda22e07d7130a32 ../.venv/bin/python ../jobs/sync_registry.py --root .. --days 30
```

## 9. Known limits and next steps

- **Service-policy attachment is UI-only** in Unity Gateway, and there is no list API. The hub reads policies from usage-row metadata and endpoint configs, and records registry-level policies itself.
- **RFA has no list or approve API**, so approvals live in the hub. Provisioning uses the UC permissions and workspace ACL APIs.
- **Agent-level usage is thin** on endpoints without usage tracking. Turn on usage tracking / inference tables, and use `POST /api/v1/usage` from agents.
- **Pause / deprecate are registry statuses.** They notify consumers but do not stop the platform object.
- **The Agent 365 Graph shape is not verified in a tenant.** Whether `/copilot/admin/catalog/packages` returns Connected-platform (Databricks Genie) agents, and which field carries the Genie space id, is undocumented ([research 05](research/05-agent365-interop.md)). The matcher scans every field for space ids and Databricks URLs, and the export-file import works either way.
- **UC lineage publishing needs a metastore privilege** (`CREATE EXTERNAL METADATA`) that most identities do not hold, including the app SP and the deployer of `your-workspace` on 2026-10-28. Readiness shows exactly what is missing; the grants, verification and turn-on steps are the runbook in §7a. Model nodes (no version) and volumes are not published.
- **The knowledge graph is not verified inside OntoBricks or Genie.** The Delta layout, column shapes, clustering and IRI conventions follow OntoBricks' documentation and SQL (master @ 97b27c7), and the export, its companions and the Genie example SQLs ran on the live warehouse, but no OntoBricks instance opened the store and no Genie space was created. Agent 365 triples are only as good as the unverified Graph payload above; the local registry used for the live run had no Agent 365 records, so `kg_registry_matches` was empty there. The base `triplestore_…_V<n>` object is a view over `_data`, not an R2RML mapping (see §6b).
- **Tool selection knows only observed tools.** Tools that were never called or listed are invisible to the preview, so narrowing "every tool" is always treated as breaking.
- **Done in v0.4.0:** the knowledge-graph export (registry → RDF triples → Delta in the OntoBricks layout, plus Genie views; §6b) and UC lineage publishing readiness (§7a). Deployed on `your-workspace` as **v0.4.2** on 2026-10-28:
  - 0.4.0 was rejected by its own branch regression, because two tests read files outside the regression copy;
  - 0.4.1 fixed the copy and passed;
  - 0.4.2 bumped `app/VERSION`.
  - On that install, `kg_target` = `main.agent_registry_hub_kg`. It has not been exported yet: the first export and the Genie space (`scripts/create_kg_genie_space.py --create --yes`) are pending.
- **Done in v0.3.0** (moved off this list): UC external lineage publishing, Microsoft Agent 365 IDs in "Also registered in", and the MCP tool-selection editor (§6b).
- **Next steps:**
  - expose `/.well-known/ai-catalog.json`;
  - verify the Agent 365 Graph shape in a licensed tenant, and add a per-agent admin-center deep link;
  - **OBO scopes (backlog).** The app declares only the default user scopes (`iam.current-user:read`, `iam.access-control:read`), so actions taken as the signed-in admin fall back to the app SP. Add `user_api_scopes` to the app resource in `databricks.yml`: `unity-catalog` (UC grants, RFA, external lineage publish), `access-management` (serving / Genie / KA / Supervisor ACLs) and `ai-gateway` (MCP `tools/list`). First confirm each is offered in the Apps scope picker ([research 01](research/01-databricks-platform-apis.md#obo-user-authorization-scopes-for-the-hub-app)). If one is not, keep that action on the app SP after an in-hub approval, as today. Once added, users consent once per app and scope set, and UC lineage readiness (§7a) checks the forwarded token, so a missing scope shows up there.
