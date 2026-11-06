"""The registry as RDF triples ``(subject, predicate, object)``, for Genie agents and OntoBricks.

What is emitted (one deterministic, sorted, de-duplicated list; ``build`` reads Lakebase, writes nothing):

* **Assets** (``asset``): ``rdf:type`` the ontology class of the asset type (Agent, McpServer, Tool, Skill) plus a
  subtype class where the data has one (GenieAgent ⊂ Agent, UcFunctionTool ⊂ Tool, …), ``rdfs:label``, and data
  properties: URN, source-system name, subtype, lifecycle, certification, source, platform, publisher, risk tier,
  workspace host, owners (``asset_owner`` owner/co-owner emails: already visible to every hub user), deep link, hub
  page, created/updated, and 30-day aggregates (requests, distinct requesters, estimated cost, active subscriptions,
  observed people/SP consumers) as COUNTS. The 30-day window is the last 30 complete UTC days, so the graph (and its
  digest) changes at most once a day from usage alone.
* **Lineage** (``lineage_edge``): one object property per relation (``uses_mcp`` → ``usesMcp`` …). Non-asset nodes
  become typed nodes: UC tables (``Table``, keyed by FQN), volumes, vector search indexes, models, apps and external
  resources. Edges to an asset URN that is not registered are skipped (counted).
* **Subscriptions**: asset → asset ``registeredConsumerOf`` for active subscriptions with a registered downstream
  asset. **Policies**: ``governedBy`` (active binding) / ``proposedPolicy``, and the ``Policy`` nodes.
* **Microsoft Agent 365 / Graph registry records** (``external_registration``): one ``Agent365Package`` node each
  (label, Microsoft id, platform, match status / method / confidence). ``linked`` (steward) or ``matched`` with
  confidence ≥ ``agent365.AUTO_MATCH`` → ``registeredAs`` (deliberately NOT ``owl:sameAs``: a reasoner would merge
  the Microsoft record's facts into the hub asset); ``suggested`` → ``candidateMatch`` (+ the confidence on the
  record); ``dismissed`` / ``unmatched`` → no link.

PRIVACY: people and service principals are never nodes. Subscriber, requester, notify and usage identities are
never read, only counted in SQL. ``guard`` then scans every subject/predicate/object (IRIs percent-decoded) and the
only emails allowed are asset owners'; any other email in a literal is replaced by ``[email]`` and a node whose
identifier contains one is skipped. ``privacy_violations`` is the independent check the tests (and ``build``) use.

IRIs: the ontology namespace is ``KG_NAMESPACE`` (default ``https://agent-registry-hub.example/ontology#``: the
``.example`` TLD is reserved, RFC 2606, so it is nobody's real domain). Instance IRIs follow the OntoBricks
convention ``<namespace><Class>/<percent-encoded key>``; the key is the asset URN (tables: the FQN). Literals are
plain strings (OntoBricks keeps every object in one STRING column and treats values starting with ``http`` as IRIs).

The ontology (OWL classes and properties with labels and comments) is generated from the same Python definitions:
``turtle()``; the committed copy is ``docs/ontology/agent-registry-hub.ttl`` (a test keeps them in sync)::

    cd app && python -m registry.knowledge_graph ttl [--namespace https://…#] > ../docs/ontology/agent-registry-hub.ttl

Credit: the instance-IRI convention and the Delta layout these triples feed follow OntoBricks
(github.com/databrickslabs/ontobricks, Databricks License), re-implemented from its documentation.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Iterable
from urllib.parse import quote, unquote

from registry import agent365, graph

RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"
OWL = "http://www.w3.org/2002/07/owl#"
XSD = "http://www.w3.org/2001/XMLSchema#"
RDF_TYPE = RDF + "type"
RDFS_LABEL = RDFS + "label"
DEFAULT_NAMESPACE = "https://agent-registry-hub.example/ontology#"
ONTOLOGY_VERSION = "1"
SAMPLE_PER_PREDICATE = 1
EMAIL = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
DATABRICKS_HOST = re.compile(r"^https?://([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com))(?:/|$)", re.I)
PRIVATE_NODE_TYPES = ("user", "service_principal")


# ====================================================================== ontology definitions (the single source)
@dataclass(frozen=True)
class OntClass:
    name: str
    label: str
    comment: str
    parent: str | None = None


@dataclass(frozen=True)
class ObjectProperty:
    name: str
    label: str
    comment: str
    domain: str
    range: str
    relation: str | None = None      # the lineage_edge relation it carries, if any
    inverse_of: str | None = None
    emitted: bool = True             # False: declared for reasoners/explorers only (e.g. an inverse)


@dataclass(frozen=True)
class DataProperty:
    name: str
    label: str
    comment: str
    domain: str
    range: str = "string"            # an XSD datatype local name


CLASSES: tuple[OntClass, ...] = (
    OntClass("Entity", "Registry graph node", "Anything the Agent Registry Hub graph describes: registered assets, the data and platform "
             "resources they use, policies, and records of the same agents in other registries."),
    OntClass("Asset", "Registered asset", "An agent, MCP server, tool or skill registered in the Agent Registry Hub. Instance IRIs are "
             "<namespace><Class>/<percent-encoded asset URN>; assetId holds the URN itself.", "Entity"),
    OntClass("Agent", "Agent", "An AI agent: a Genie agent, an Agent Bricks agent, a custom serving endpoint agent or an app agent.", "Asset"),
    OntClass("GenieAgent", "Genie agent", "A Databricks Genie space (AI/BI Genie agent).", "Agent"),
    OntClass("SupervisorAgent", "Agent Bricks supervisor", "An Agent Bricks multi-agent supervisor.", "Agent"),
    OntClass("KnowledgeAssistant", "Agent Bricks knowledge assistant", "An Agent Bricks knowledge assistant (document Q&A).", "Agent"),
    OntClass("InformationExtractionAgent", "Agent Bricks information extraction", "An Agent Bricks information extraction agent.", "Agent"),
    OntClass("ModelSpecializationAgent", "Agent Bricks model specialization", "An Agent Bricks model specialization agent.", "Agent"),
    OntClass("CustomAgent", "Custom serving agent", "A custom agent deployed on a Model Serving endpoint.", "Agent"),
    OntClass("AppAgent", "Databricks Apps agent", "An agent that runs as a Databricks App.", "Agent"),
    OntClass("McpServer", "MCP server", "A Model Context Protocol server that exposes tools.", "Asset"),
    OntClass("ExternalMcpServer", "External MCP server", "An external MCP server reached through a Unity Catalog HTTP connection.", "McpServer"),
    OntClass("ManagedMcpServer", "Databricks managed MCP server", "A Databricks managed MCP server (UC functions, Genie, Vector Search, DBSQL).", "McpServer"),
    OntClass("SystemMcpServer", "Databricks system MCP server", "A Databricks-provided system.ai MCP server.", "McpServer"),
    OntClass("CustomMcpServer", "Custom MCP server (app)", "A custom MCP server hosted as a Databricks App.", "McpServer"),
    OntClass("GatewayMcpService", "Unity Gateway MCP service", "An MCP service governed by Unity Gateway (a Unity Catalog securable).", "McpServer"),
    OntClass("Tool", "Tool", "A tool an agent can call: a Unity Catalog function or an MCP tool.", "Asset"),
    OntClass("UcFunctionTool", "Unity Catalog function", "A Unity Catalog function used as a tool.", "Tool"),
    OntClass("McpTool", "MCP tool", "A tool exposed by an MCP server.", "Tool"),
    OntClass("Skill", "Skill", "An agent skill (instructions and resources an agent loads on demand).", "Asset"),
    OntClass("UcSkill", "Unity Catalog skill", "A skill stored in Unity Catalog.", "Skill"),
    OntClass("DataResource", "Data resource", "Data an asset reads or writes in Unity Catalog.", "Entity"),
    OntClass("Table", "Unity Catalog table", "A Unity Catalog table or view, keyed by its catalog.schema.table name.", "DataResource"),
    OntClass("Volume", "Unity Catalog volume", "A Unity Catalog volume, keyed by its catalog.schema.volume name.", "DataResource"),
    OntClass("VectorSearchIndex", "Vector search index", "A Mosaic AI Vector Search index, keyed by its full name.", "DataResource"),
    OntClass("Model", "Model", "A registered or served model an agent uses.", "Entity"),
    OntClass("DatabricksApp", "Databricks app", "A Databricks App that hosts or calls registered assets.", "Entity"),
    OntClass("ExternalResource", "External resource", "Something outside the workspace an asset uses (a web tool, an external endpoint).", "Entity"),
    OntClass("Policy", "Policy or guardrail", "A guardrail, rate limit, budget, access or data policy bound to assets.", "Entity"),
    OntClass("Agent365Package", "Microsoft Agent 365 registry record",
             "One record in the Microsoft 365 agent registry (Agent 365 Connected platforms / Microsoft Graph copilotPackage) that mirrors "
             "a Databricks agent. registeredAs links it to the hub asset it is; candidateMatch to a suggestion a steward has not confirmed.",
             "Entity"),
)

# asset_type → the class every asset of that type gets; subtype → the extra, more specific class.
TYPE_CLASS = {"agent": "Agent", "mcp_server": "McpServer", "tool": "Tool", "skill": "Skill"}
SUBTYPE_CLASS = {
    "genie_space": "GenieAgent", "managed_genie": "GenieAgent",
    "agent_bricks_supervisor": "SupervisorAgent", "agent_bricks_knowledge_assistant": "KnowledgeAssistant",
    "agent_bricks_information_extraction": "InformationExtractionAgent", "agent_bricks_model_specialization": "ModelSpecializationAgent",
    "custom_agent": "CustomAgent", "agent_runtime_app": "AppAgent",
    "external_connection": "ExternalMcpServer", "managed_uc_functions": "ManagedMcpServer", "databricks_workspace": "ManagedMcpServer",
    "system_mcp": "SystemMcpServer", "databricks_system_mcp": "SystemMcpServer", "custom_app": "CustomMcpServer",
    "uc_mcp_service": "GatewayMcpService",
    "uc_function": "UcFunctionTool", "mcp_tool": "McpTool",
    "uc_skill": "UcSkill",
}
# graph.node_type of a non-asset lineage node → its class (people and service principals are never nodes).
NODE_CLASS = {"table": "Table", "volume": "Volume", "index": "VectorSearchIndex", "model": "Model", "app": "DatabricksApp",
              "external": "ExternalResource"}
NODE_KEY_PREFIX = {"table": "table:", "volume": "volume:", "index": "index:", "model": "model:", "app": "app:"}

OBJECT_PROPERTIES: tuple[ObjectProperty, ...] = (
    ObjectProperty("usesMcp", "uses MCP server", "The agent calls tools of this MCP server (lineage relation uses_mcp).", "Agent", "McpServer", "uses_mcp"),
    ObjectProperty("usesTool", "uses tool", "The asset calls this tool (lineage relation uses_tool).", "Asset", "Entity", "uses_tool"),
    ObjectProperty("callsAgent", "calls agent", "The agent delegates to this agent, e.g. a supervisor's sub-agent (lineage relation calls_agent).",
                   "Agent", "Agent", "calls_agent"),
    ObjectProperty("usesSkill", "uses skill", "The agent loads this skill (lineage relation uses_skill).", "Agent", "Skill", "uses_skill"),
    ObjectProperty("usesModel", "uses model", "The agent is served by or calls this model (lineage relation uses_model).", "Agent", "Model", "uses_model"),
    ObjectProperty("exposesTool", "exposes tool", "The MCP server exposes this tool (lineage relation exposes_tool).", "McpServer", "Tool", "exposes_tool"),
    ObjectProperty("consumes", "consumes", "Observed use of the asset by an app or another asset (lineage relation consumes). People and service "
                   "principals are never exported: see observedConsumers.", "Entity", "Asset", "consumes"),
    ObjectProperty("subscribes", "subscribes to", "A declared subscription edge in the lineage (lineage relation subscribes). Subscriptions by "
                   "people are never exported: see activeSubscriptions.", "Entity", "Asset", "subscribes"),
    ObjectProperty("hosts", "hosts", "The app hosts this asset, e.g. a custom MCP server (lineage relation hosts).", "DatabricksApp", "Asset", "hosts"),
    ObjectProperty("routesTo", "routes to", "The asset routes requests to this target (lineage relation routes_to).", "Asset", "Entity", "routes_to"),
    ObjectProperty("readsData", "reads data", "The asset reads this table, volume or index (lineage relation reads_data).", "Asset", "DataResource", "reads_data"),
    ObjectProperty("writesData", "writes data", "The asset writes this table or volume (lineage relation writes_data).", "Asset", "DataResource", "writes_data"),
    ObjectProperty("registeredConsumerOf", "registered consumer of", "The downstream asset is registered as a consumer of this asset through an active "
                   "hub subscription (the subscriber's identity is never exported).", "Asset", "Asset"),
    ObjectProperty("governedBy", "governed by", "An active policy or guardrail binding.", "Asset", "Policy"),
    ObjectProperty("proposedPolicy", "proposed policy", "A proposed (not yet active) policy binding.", "Asset", "Policy"),
    ObjectProperty("registeredAs", "registered as", "This Microsoft Agent 365 record is the registration of this hub asset in the Microsoft 365 agent "
                   "registry: linked by a steward, or matched automatically with confidence of at least 0.85. Deliberately not owl:sameAs, "
                   "so reasoners do not merge the Microsoft record's facts into the hub asset.", "Agent365Package", "Asset"),
    ObjectProperty("alsoRegisteredIn", "also registered in", "The hub asset's record in another registry (the inverse of registeredAs; not "
                   "materialised, a reasoner can infer it).", "Asset", "Agent365Package", inverse_of="registeredAs", emitted=False),
    ObjectProperty("candidateMatch", "candidate match", "A suggested match a steward has not confirmed yet; matchConfidence on the record holds "
                   "its confidence.", "Agent365Package", "Asset"),
)
RELATION_PROPERTY = {p.relation: p.name for p in OBJECT_PROPERTIES if p.relation}

DATA_PROPERTIES: tuple[DataProperty, ...] = (
    DataProperty("assetId", "asset URN", "The asset's URN in the hub (the key of its REST API and UI pages).", "Asset"),
    DataProperty("name", "source name", "The name in the source system (endpoint, connection, function or skill name).", "Asset"),
    DataProperty("subtype", "subtype", "The hub's asset subtype, e.g. genie_space or uc_function.", "Asset"),
    DataProperty("lifecycleStatus", "lifecycle status", "discovered, draft, pending_approval, approved, rejected, deprecated or retired.", "Asset"),
    DataProperty("certification", "certification", "certified, verified_publisher, unreviewed or deprecated.", "Asset"),
    DataProperty("source", "source", "databricks (native), external or custom.", "Asset"),
    DataProperty("platform", "platform", "Where it runs or is registered, e.g. genie, agent_bricks, unity_catalog, Databricks Genie.", "Entity"),
    DataProperty("publisher", "publisher", "The publisher of the asset (an organisation).", "Asset"),
    DataProperty("riskTier", "risk tier", "low, medium, high or critical.", "Asset"),
    DataProperty("workspace", "workspace", "The Databricks workspace host the asset lives in (from its deep link).", "Asset"),
    DataProperty("owner", "owner", "An owner or co-owner email (owners are visible to every hub user).", "Asset"),
    DataProperty("deepLink", "deep link", "The asset's page in the Databricks workspace.", "Asset", "anyURI"),
    DataProperty("hubPage", "hub page", "The asset's page in the Agent Registry Hub.", "Asset", "anyURI"),
    DataProperty("createdAt", "created at", "When the asset was created in its source system (else first seen by the hub), UTC.", "Asset", "dateTime"),
    DataProperty("updatedAt", "updated at", "When the asset last changed in its source system (else in the hub), UTC.", "Asset", "dateTime"),
    DataProperty("requests30d", "requests (30 days)", "Requests in the last 30 complete UTC days.", "Asset", "integer"),
    DataProperty("distinctRequesters30d", "distinct requesters (30 days)", "How many distinct people and service principals called it in the last 30 "
                 "complete UTC days (a count: identities are never exported).", "Asset", "integer"),
    DataProperty("costUsd30d", "estimated cost USD (30 days)", "Estimated cost in USD over the last 30 complete UTC days (system billing tables).",
                 "Asset", "decimal"),
    DataProperty("activeSubscriptions", "active subscriptions", "How many active hub subscriptions the asset has (a count: subscriber emails are "
                 "never exported).", "Asset", "integer"),
    DataProperty("observedConsumers", "observed people and SP consumers", "How many distinct people and service principals were observed using the "
                 "asset (a count from the lineage: identities are never exported).", "Asset", "integer"),
    DataProperty("policyKind", "policy kind", "guardrail, rate_limit, budget, access, tool_allowlist, data_policy, …", "Policy"),
    DataProperty("policyProvider", "policy provider", "unity_gateway, serving_ai_gateway, unity_catalog or registry.", "Policy"),
    DataProperty("policyAction", "policy action", "block, mask, flag, alert, limit, log, …", "Policy"),
    DataProperty("policyPhase", "policy phase", "input, output, both or n/a.", "Policy"),
    DataProperty("m365Id", "Microsoft 365 id", "The record's id in the Microsoft 365 agent registry.", "Agent365Package"),
    DataProperty("matchStatus", "match status", "matched, linked, suggested, unmatched or dismissed (the hub's Agent 365 review status).", "Agent365Package"),
    DataProperty("matchMethod", "match method", "genie_space_id, endpoint_name, app_name, name or steward.", "Agent365Package"),
    DataProperty("matchConfidence", "match confidence", "Confidence of the match, 0 to 1.", "Agent365Package", "decimal"),
)

_NAMES = {c.name for c in CLASSES} | {p.name for p in OBJECT_PROPERTIES} | {p.name for p in DATA_PROPERTIES}
assert len(_NAMES) == len(CLASSES) + len(OBJECT_PROPERTIES) + len(DATA_PROPERTIES), "ontology names must be unique"
BASE_CLASSES = tuple(sorted(set(TYPE_CLASS.values()) | set(NODE_CLASS.values()) | {"Policy", "Agent365Package"}))
SUBTYPE_CLASSES = tuple(sorted(set(SUBTYPE_CLASS.values())))


def default_namespace() -> str:
    return validate_namespace(os.environ.get("KG_NAMESPACE", "").strip() or DEFAULT_NAMESPACE)


def validate_namespace(ns: str) -> str:
    """An http(s) IRI ending in ``#`` or ``/`` with no characters that need escaping in Turtle or SQL."""
    if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(?::\d+)?(?:/[A-Za-z0-9._~/-]*)?[#/]", ns or ""):
        raise ValueError(f"invalid KG namespace {ns!r}: use an http(s) IRI ending in '#' or '/'")
    return ns


def iri(ns: str, name: str) -> str:
    return ns + name


def node_iri(ns: str, cls: str, key: str) -> str:
    return f"{ns}{cls}/{quote(key, safe='')}"


# ====================================================================== literals
def lit(value: Any) -> str | None:
    """A plain string literal (OntoBricks' object column is one STRING). None/'' → None (no triple)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        v = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return v.strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (float, Decimal)):
        text = f"{float(value):.4f}".rstrip("0").rstrip(".")
        return text or "0"
    text = str(value)
    return text if text.strip() else None


def money(value: Any) -> str | None:
    return None if value is None else f"{Decimal(value):.2f}"


# ====================================================================== privacy
def emails_in(text: str) -> set[str]:
    return {m.lower() for m in EMAIL.findall(unquote(text or ""))}


def privacy_violations(triples: Iterable[tuple[str, str, str]], allowed: Iterable[str]) -> list[str]:
    """Every email in any position (IRIs percent-decoded) that is not an allowed (owner) email. Empty = clean."""
    ok = {a.lower() for a in allowed}
    found: set[str] = set()
    for t in triples:
        for part in t:
            found |= emails_in(part) - ok
    return sorted(found)


def _scrub(text: str | None, allowed: set[str], counter: dict) -> str | None:
    if text is None:
        return None

    def repl(m: re.Match) -> str:
        if m.group(0).lower() in allowed:
            return m.group(0)
        counter["redacted_literals"] = counter.get("redacted_literals", 0) + 1
        return "[email]"
    return EMAIL.sub(repl, text)


# ====================================================================== build
@dataclass
class Graph:
    namespace: str
    triples: list[tuple[str, str, str]]
    classes: dict[str, int]
    predicates: dict[str, int]
    skipped: list[dict]
    privacy: dict
    samples: list[tuple[str, str, str]] = field(default_factory=list)

    @property
    def digest(self) -> str:
        return triples_digest(self.triples)


def triples_digest(triples: Iterable[tuple[str, str, str]]) -> str:
    h = hashlib.sha256()
    for s, p, o in triples:
        h.update(f"{s}\t{p}\t{o}\n".encode("utf-8", "surrogatepass"))
    return h.hexdigest()


def _skip(skipped: dict, reason: str, sample: str) -> None:
    s = skipped.setdefault(reason, {"reason": reason, "count": 0, "sample": []})
    s["count"] += 1
    if len(s["sample"]) < 3 and not emails_in(sample):
        s["sample"].append(sample)


def _workspace(deep_link: str | None) -> str | None:
    m = DATABRICKS_HOST.match(deep_link or "")
    return m.group(1).lower() if m else None


def _table_exists(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AS ok", (name,))
    return bool(cur.fetchone()["ok"])


def build(cur, *, namespace: str | None = None, app_url: str | None = None) -> Graph:
    """The registry's triples (sorted, unique) plus per-class / per-predicate counts and what was left out."""
    ns = validate_namespace(namespace) if namespace else default_namespace()
    P = lambda name: ns + name  # noqa: E731 - predicate/class IRI
    out: set[tuple[str, str, str]] = set()
    skipped: dict[str, dict] = {}
    counter: dict[str, int] = {}

    cur.execute("SELECT DISTINCT lower(email) AS email FROM asset_owner WHERE kind IN ('owner','co_owner')")
    allowed = {r["email"] for r in cur.fetchall()}

    def add(s: str, p: str, o: str | None) -> None:
        if o is not None:
            out.add((s, p, o))

    def add_lit(s: str, p: str, value: Any) -> None:
        add(s, p, _scrub(lit(value), allowed, counter))

    # ---- assets
    cur.execute("""SELECT asset_id, asset_type, subtype, name, display_name, source, platform, publisher, lifecycle_status, certification,
                          risk_tier, deep_link, coalesce(source_created_at, first_seen_at) AS created_at,
                          coalesce(source_updated_at, updated_at) AS updated_at
                     FROM asset ORDER BY asset_id""")
    assets = {a["asset_id"]: a for a in cur.fetchall()}
    cur.execute("""SELECT asset_id, email FROM asset_owner WHERE kind IN ('owner','co_owner') ORDER BY asset_id, email""")
    owners: dict[str, list[str]] = {}
    for r in cur.fetchall():
        owners.setdefault(r["asset_id"], []).append(r["email"])
    # 30-day aggregates over the last 30 COMPLETE UTC days: counts only, never identities.
    cur.execute("""SELECT asset_id, sum(requests)::bigint AS requests, count(DISTINCT requester) AS requesters FROM usage_daily
                    WHERE day >= (now() AT TIME ZONE 'UTC')::date - 30 AND day < (now() AT TIME ZONE 'UTC')::date GROUP BY asset_id""")
    usage = {r["asset_id"]: r for r in cur.fetchall()}
    cur.execute("""SELECT asset_id, sum(usd) AS usd FROM cost_daily
                    WHERE day >= (now() AT TIME ZONE 'UTC')::date - 30 AND day < (now() AT TIME ZONE 'UTC')::date GROUP BY asset_id""")
    cost = {r["asset_id"]: r["usd"] for r in cur.fetchall()}
    cur.execute("SELECT asset_id, count(*) AS n FROM subscription WHERE status = 'active' GROUP BY asset_id")
    subs = {r["asset_id"]: int(r["n"]) for r in cur.fetchall()}
    cur.execute("SELECT src_id, dst_id, relation, edge_kind FROM lineage_edge ORDER BY src_id, dst_id, relation, edge_kind")
    edges = list(cur.fetchall())
    people: dict[str, set[str]] = {}
    for e in edges:
        if graph.node_type(e["src_id"]) in PRIVATE_NODE_TYPES and e["relation"] in ("consumes", "subscribes"):
            people.setdefault(e["dst_id"], set()).add(e["src_id"])
    hub = (app_url or "").rstrip("/") or None

    asset_iri: dict[str, str] = {}
    for aid, a in assets.items():
        cls = TYPE_CLASS.get(a["asset_type"])
        if not cls:
            _skip(skipped, f"Unknown asset type {a['asset_type']}", aid)
            continue
        if emails_in(aid) - allowed:
            _skip(skipped, "Identifier contains a personal email (not exported)", "")
            continue
        s = node_iri(ns, cls, aid)
        asset_iri[aid] = s
        add(s, RDF_TYPE, P(cls))
        sub = SUBTYPE_CLASS.get(a["subtype"])
        if sub:
            add(s, RDF_TYPE, P(sub))
        add_lit(s, RDFS_LABEL, a["display_name"] or a["name"] or aid)
        add_lit(s, P("assetId"), aid)
        for key, col in (("name", "name"), ("subtype", "subtype"), ("lifecycleStatus", "lifecycle_status"), ("certification", "certification"),
                         ("source", "source"), ("platform", "platform"), ("publisher", "publisher"), ("riskTier", "risk_tier"),
                         ("deepLink", "deep_link"), ("createdAt", "created_at"), ("updatedAt", "updated_at")):
            add_lit(s, P(key), a[col])
        add_lit(s, P("workspace"), _workspace(a["deep_link"]))
        if hub:
            add_lit(s, P("hubPage"), f"{hub}/assets/{quote(aid, safe='')}")
        for email in owners.get(aid, []):
            add_lit(s, P("owner"), email)
        u = usage.get(aid)
        if u:
            add_lit(s, P("requests30d"), int(u["requests"] or 0))
            add_lit(s, P("distinctRequesters30d"), int(u["requesters"] or 0))
        if aid in cost:
            add(s, P("costUsd30d"), money(cost[aid]))
        if aid in subs:
            add_lit(s, P("activeSubscriptions"), subs[aid])
        if aid in people:
            add_lit(s, P("observedConsumers"), len(people[aid]))

    # ---- lineage
    other_nodes: dict[str, str] = {}

    def node(node_id: str, label: str) -> str | None:
        """The IRI of a lineage endpoint (registering non-asset nodes), or None when it must not be exported."""
        kind = graph.node_type(node_id)
        if kind in PRIVATE_NODE_TYPES:
            return None
        if graph.is_asset(node_id):
            if node_id not in asset_iri:
                _skip(skipped, "Edge to an asset URN that is not registered", label)
            return asset_iri.get(node_id)
        if emails_in(node_id) - allowed:
            _skip(skipped, "Identifier contains a personal email (not exported)", "")
            return None
        if node_id in other_nodes:
            return other_nodes[node_id]
        cls = NODE_CLASS.get(kind, "ExternalResource")
        prefix = NODE_KEY_PREFIX.get(kind)
        key = node_id[len(prefix):] if prefix and node_id.startswith(prefix) else node_id
        s = node_iri(ns, cls, key)
        other_nodes[node_id] = s
        add(s, RDF_TYPE, P(cls))
        add_lit(s, RDFS_LABEL, key)
        return s

    for e in edges:
        label = f"{e['src_id']} {e['relation']} {e['dst_id']}"
        kinds = (graph.node_type(e["src_id"]), graph.node_type(e["dst_id"]))
        if kinds[0] in PRIVATE_NODE_TYPES or kinds[1] in PRIVATE_NODE_TYPES:
            _skip(skipped, "People and service principals are never exported (counted on the asset instead)", "")
            continue
        prop = RELATION_PROPERTY.get(e["relation"])
        if not prop:
            _skip(skipped, f"Relation {e['relation']} has no ontology property", label)
            continue
        src, dst = node(e["src_id"], label), node(e["dst_id"], label)
        if src and dst:
            add(src, P(prop), dst)

    # ---- downstream subscriptions (asset → asset), never the subscriber
    cur.execute("""SELECT DISTINCT downstream_asset_id, asset_id FROM subscription
                    WHERE status = 'active' AND downstream_asset_id IS NOT NULL ORDER BY 1, 2""")
    for r in cur.fetchall():
        a, b = asset_iri.get(r["downstream_asset_id"]), asset_iri.get(r["asset_id"])
        if a and b and a != b:
            add(a, P("registeredConsumerOf"), b)

    # ---- policies
    cur.execute("SELECT policy_id, name, kind, provider, phase, action FROM policy ORDER BY policy_id")
    policy_iri = {}
    for pol in cur.fetchall():
        s = node_iri(ns, "Policy", pol["policy_id"])
        policy_iri[pol["policy_id"]] = s
        add(s, RDF_TYPE, P("Policy"))
        add_lit(s, RDFS_LABEL, pol["name"] or pol["policy_id"])
        for key, col in (("policyKind", "kind"), ("policyProvider", "provider"), ("policyPhase", "phase"), ("policyAction", "action")):
            add_lit(s, P(key), pol[col])
    cur.execute("SELECT policy_id, asset_id, status FROM policy_binding ORDER BY policy_id, asset_id")
    for b in cur.fetchall():
        a, pol = asset_iri.get(b["asset_id"]), policy_iri.get(b["policy_id"])
        if a and pol:
            add(a, P("governedBy" if b["status"] == "active" else "proposedPolicy"), pol)

    # ---- Microsoft Agent 365 / Graph registry records
    if _table_exists(cur, "external_registration"):
        cur.execute("""SELECT external_id, display_name, platform, status, matched_asset_id, match_method, confidence
                         FROM external_registration WHERE registry = %s ORDER BY external_id""", (agent365.REGISTRY_KEY,))
        for r in cur.fetchall():
            if emails_in(r["external_id"]) - allowed:
                _skip(skipped, "Identifier contains a personal email (not exported)", "")
                continue
            s = node_iri(ns, "Agent365Package", r["external_id"])
            add(s, RDF_TYPE, P("Agent365Package"))
            add_lit(s, RDFS_LABEL, r["display_name"] or r["external_id"])
            add_lit(s, P("m365Id"), r["external_id"])
            add_lit(s, P("platform"), r["platform"])
            add_lit(s, P("matchStatus"), r["status"])
            add_lit(s, P("matchMethod"), r["match_method"])
            link = registration_link(r["status"], r["confidence"])
            if link:  # dismissed / unmatched records carry no confidence and no link
                add_lit(s, P("matchConfidence"), r["confidence"])
            if not link or not r["matched_asset_id"]:
                continue
            target = asset_iri.get(r["matched_asset_id"])
            if not target:
                _skip(skipped, "Agent 365 record matched to an asset that is not registered", r["external_id"])
                continue
            add(s, P(link), target)

    triples = sorted(out)
    violations = privacy_violations(triples, allowed)
    if violations:  # defence in depth: the scrubbing above must make this impossible
        raise RuntimeError(f"privacy guard: {len(violations)} non-owner email(s) would be exported; refusing")
    classes: dict[str, int] = {}
    predicates: dict[str, int] = {}
    samples: dict[str, list] = {}
    for s, p, o in triples:
        predicates[p] = predicates.get(p, 0) + 1
        if p == RDF_TYPE:
            classes[o] = classes.get(o, 0) + 1
        bucket = samples.setdefault(p, [])
        if len(bucket) < SAMPLE_PER_PREDICATE:
            bucket.append((s, p, o))
    return Graph(namespace=ns, triples=triples, classes=dict(sorted(classes.items())), predicates=dict(sorted(predicates.items())),
                 skipped=sorted(skipped.values(), key=lambda x: (-x["count"], x["reason"])),
                 privacy={"allowed_owner_emails": len(allowed), "redacted_literals": counter.get("redacted_literals", 0),
                          "people_and_service_principal_edges_left_out": sum(
                              s["count"] for s in skipped.values() if s["reason"].startswith("People and service principals"))},
                 samples=[t for p in sorted(samples) for t in samples[p]])


def registration_link(status: str | None, confidence: Any) -> str | None:
    """Agent 365 review status → the predicate that links the record to the hub asset (None = no link)."""
    if status == "linked":
        return "registeredAs"
    if status == "matched":
        return "registeredAs" if confidence is not None and float(confidence) >= agent365.AUTO_MATCH else "candidateMatch"
    if status == "suggested":
        return "candidateMatch"
    return None  # dismissed, unmatched


def label_of(ns: str, term_iri: str) -> str:
    """The ontology label of a class or property IRI (the local name when it is not ours)."""
    for d in (*CLASSES, *OBJECT_PROPERTIES, *DATA_PROPERTIES):
        if term_iri == ns + d.name:
            return d.label
    return {RDF_TYPE: "type", RDFS_LABEL: "label"}.get(term_iri, re.split(r"[#/]", term_iri)[-1])


# ====================================================================== the ontology as Turtle
def _ttl_string(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r") + '"'


def ontology_iri(ns: str) -> str:
    return ns.rstrip("#/")


def turtle(namespace: str | None = None) -> str:
    """OWL classes, object properties and datatype properties with labels and comments (deterministic)."""
    ns = validate_namespace(namespace) if namespace else DEFAULT_NAMESPACE
    lines = [
        "# Agent Registry Hub ontology: GENERATED from app/registry/knowledge_graph.py, do not edit by hand.",
        "#   cd app && python -m registry.knowledge_graph ttl > ../docs/ontology/agent-registry-hub.ttl",
        "# Import it into OntoBricks as the domain ontology (Ontology > Import); the hub's Delta export",
        "# (registry/kg_delta.py) writes instances as <namespace><Class>/<percent-encoded URN>.",
        "",
        f"@prefix arh: <{ns}> .",
        f"@prefix owl: <{OWL}> .",
        f"@prefix rdf: <{RDF}> .",
        f"@prefix rdfs: <{RDFS}> .",
        f"@prefix xsd: <{XSD}> .",
        "",
        f"<{ontology_iri(ns)}> a owl:Ontology ;",
        f"    rdfs:label {_ttl_string('Agent Registry Hub')} ;",
        f"    rdfs:comment {_ttl_string('Agents, MCP servers, tools and skills registered in the Agent Registry Hub, their lineage to data, policies and models, and their records in the Microsoft 365 agent registry.')} ;",
        f"    owl:versionInfo {_ttl_string(ONTOLOGY_VERSION)} .",
        "",
        "# ---------------------------------------------------------------- classes",
    ]
    for c in CLASSES:
        lines.append(f"arh:{c.name} a owl:Class ;")
        if c.parent:
            lines.append(f"    rdfs:subClassOf arh:{c.parent} ;")
        lines += [f"    rdfs:label {_ttl_string(c.label)} ;", f"    rdfs:comment {_ttl_string(c.comment)} .", ""]
    lines.append("# ---------------------------------------------------------------- object properties (relationships)")
    for p in OBJECT_PROPERTIES:
        lines += [f"arh:{p.name} a owl:ObjectProperty ;", f"    rdfs:domain arh:{p.domain} ;", f"    rdfs:range arh:{p.range} ;"]
        if p.inverse_of:
            lines.append(f"    owl:inverseOf arh:{p.inverse_of} ;")
        lines += [f"    rdfs:label {_ttl_string(p.label)} ;", f"    rdfs:comment {_ttl_string(p.comment)} .", ""]
    lines.append("# ---------------------------------------------------------------- datatype properties (attributes)")
    for d in DATA_PROPERTIES:
        lines += [f"arh:{d.name} a owl:DatatypeProperty ;", f"    rdfs:domain arh:{d.domain} ;", f"    rdfs:range xsd:{d.range} ;",
                  f"    rdfs:label {_ttl_string(d.label)} ;", f"    rdfs:comment {_ttl_string(d.comment)} .", ""]
    return "\n".join(lines).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    import argparse
    import sys

    ap = argparse.ArgumentParser(prog="python -m registry.knowledge_graph")
    ap.add_argument("command", choices=("ttl",))
    ap.add_argument("--namespace", default=None, help=f"ontology namespace (default {DEFAULT_NAMESPACE})")
    args = ap.parse_args(argv)
    sys.stdout.write(turtle(args.namespace))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
