"""Materialise the knowledge graph (``registry/knowledge_graph.py``) as Unity Catalog Delta objects in the OntoBricks
layout: a preview (plan + digest) first, then an audited admin export.

Objects in the target ``catalog.schema`` (base name ``triplestore_agent_registry_hub_V<n>``, as OntoBricks names a
domain's store ``triplestore_<domain>_V<version>``):

========================================  =====  ==========================================================
``<base>_data``                           TABLE  the triples ``(subject, predicate, object)``, ``CLUSTER BY (predicate, subject)``
``<base>_inferred``                       TABLE  empty companion, same shape (reasoning / app-written triples)
``<base>_graph``                          VIEW   ``_data UNION ALL _inferred`` (what OntoBricks' Explorer reads)
``<base>``                                VIEW   ``SELECT … FROM _data`` (see "the base object" below)
``<base>_adj_out`` / ``_adj_in``          TABLE  hop indexes ``(src, predicate, dst)`` / ``(dst, predicate, src)``
``<base>_entity_search``                  TABLE  ``(uri, type_uri, label, uri_lc, label_lc)`` from ``_graph``
``<base>_entity_search_asserted``         TABLE  the same from ``_data`` (Explorer Preview with Inferred off)
``<base>_props``                          TABLE  every triple of a typed subject
``kg_nodes`` / ``kg_edges`` /             VIEW   flat, commented views for Genie
``kg_registry_matches``
========================================  =====  ==========================================================

The base object: in OntoBricks it is the R2RML VIEW that maps source UC tables to triples and ``_data`` is a CTAS of
it. The hub's source is Lakebase, which UC cannot read without a Lakehouse Federation catalog the hub does not
assume, and the mapping (privacy scrubbing, Agent 365 status rules) is Python code with tests. So the triples are
computed in the app and loaded into ``_data``, and the base name is a pass-through VIEW over ``_data``: every name
OntoBricks derives from the base resolves, and nothing pretends to be a live mapping.

Writes (``core.warehouse``, Statement Execution): a staging table ``<base>_stage`` is loaded with ``INSERT … VALUES``
batches under ``MAX_STATEMENT_BYTES`` (Spark string literals escaped with backslashes, which Spark honours; doubled
quotes would silently corrupt text), its row count is checked, ``_data`` is swapped in atomically with
``CREATE OR REPLACE TABLE … AS SELECT`` from the stage, the companions are rebuilt, and the stage is dropped.

Ownership safety: every object carries TBLPROPERTIES ``created_by=agent-registry-hub``, ``hub_instance``,
``kg_role``, ``kg_digest`` and ``kg_layout``. Before any write the export reads each target name through the UC
Tables API; a name taken by an object without the hub's ``created_by`` + ``hub_instance`` is a reported conflict and
the run writes nothing. The export never drops a schema and never touches any other object; it creates the target
schema when it is missing.

Unchanged digest: the digest covers the layout, namespace, target, install id and every triple. ``platform`` mode
skips the run when every object already carries that ``kg_digest``; ``record_only`` and the sync step's cheap
pre-check compare with the last successful run in ``kg_export_run`` (migration 008).

Modes (``registry.provision.mode``): ``platform`` runs the SQL (as the admin with an OBO token, else the app SP; the
sync step as the job's identity); ``record_only`` (local runs and tests) records the statements and calls nothing.
Credit: the layout and the companion-index semantics follow OntoBricks (github.com/databrickslabs/ontobricks,
Databricks License), re-implemented from its documented schema.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from psycopg.types.json import Jsonb

from core import audit, config, warehouse
from core.guard import Conflict
from registry import authz, knowledge_graph as kg, provision, settings

log = logging.getLogger("registry.kg_delta")

HUB = "agent-registry-hub"
LAYOUT = "ontobricks-delta-1"
DOMAIN = "agent_registry_hub"
MAX_STATEMENT_BYTES = 900_000               # soft cap per INSERT (the Statement Execution limit is 16 MiB)
HARD_STATEMENT_BYTES = 16 * 1024 * 1024 - 65_536
MAX_ROWS_PER_INSERT = 5_000
STATEMENT_WAIT_S = 600.0
UC_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$")
SAMPLES_SHOWN = 60
RDF_TYPE, RDFS_LABEL = kg.RDF_TYPE, kg.RDFS_LABEL


def tables_exist(cur) -> bool:
    cur.execute("SELECT to_regclass('kg_export_run') IS NOT NULL AS ok")
    return bool(cur.fetchone()["ok"])


# ====================================================================== target
@dataclass(frozen=True)
class Target:
    catalog: str
    schema: str
    version: int = 1
    source: str = "setting"

    @property
    def base(self) -> str:
        return f"triplestore_{DOMAIN}_V{self.version}"

    @property
    def schema_name(self) -> str:
        return f"{self.catalog}.{self.schema}"

    def fqn(self, leaf: str) -> str:
        """Quoted for SQL (the hub interpolates nothing else)."""
        return f"`{self.catalog}`.`{self.schema}`.`{leaf}`"

    def name(self, leaf: str) -> str:
        return f"{self.catalog}.{self.schema}.{leaf}"

    def api_name(self, leaf: str) -> str:
        """Unity Catalog keeps names lowercase; the Tables API is keyed by the stored name."""
        return self.name(leaf).lower()


def uc_name(value: Any, what: str = "name") -> str:
    text = str(value or "").strip()
    if not UC_NAME.match(text):
        raise ValueError(f"invalid Unity Catalog {what} {text!r}: letters, digits, underscores and hyphens only")
    return text


def bundle_target() -> tuple[str, str] | None:
    """KG_TARGET (bundle variable ``kg_target``): ``catalog.schema``; ``none`` / unset = not configured."""
    raw = os.environ.get("KG_TARGET", "").strip()
    if raw.lower() in ("", "none"):
        return None
    parts = raw.split(".")
    if len(parts) != 2:
        log.warning("KG_TARGET %r is not catalog.schema: ignored", raw)
        return None
    try:
        return uc_name(parts[0], "catalog"), uc_name(parts[1], "schema")
    except ValueError as e:
        log.warning("KG_TARGET ignored: %s", e)
        return None


def target(cur) -> Target | None:
    """Settings (admin, Governance) win over the bundle variable; both empty = the export is not configured."""
    cat, sch = settings.get(cur, "kg_target_catalog") or "", settings.get(cur, "kg_target_schema") or ""
    version = int(settings.get(cur, "kg_store_version") or 1)
    if cat and sch:
        return Target(cat, sch, version, "setting")
    env = bundle_target()
    if env:
        return Target(cat or env[0], sch or env[1], version, "setting+bundle" if (cat or sch) else "bundle")
    return None


# ====================================================================== SQL text
_ESCAPES = {"\\": "\\\\", "'": "\\'", "\n": "\\n", "\r": "\\r", "\t": "\\t", "$": "\\u0024"}
_TRANSLATE = {ord(k): v for k, v in _ESCAPES.items()}
_TRANSLATE.update({c: f"\\u{c:04x}" for c in list(range(0, 0x20)) + [0x7F, 0x2028, 0x2029] if c not in _TRANSLATE})


def sql_string(value: Any) -> str:
    """A Spark SQL string literal. Backslash escapes (Spark's rule: ``'it''s'`` would be two adjacent literals and
    silently lose the quote); control characters and ``$`` (no ``${…}`` variable substitution) as ``\\uXXXX``;
    other unicode as is (the request is JSON, so it arrives intact)."""
    return "'" + str(value).translate(_TRANSLATE) + "'"


def tblproperties(instance: str, role: str, digest: str, extra: dict | None = None) -> str:
    props = {"created_by": HUB, "hub_instance": instance, "kg_role": role, "kg_digest": digest, "kg_layout": LAYOUT, **(extra or {})}
    return "TBLPROPERTIES (" + ", ".join(f"{sql_string(k)} = {sql_string(v)}" for k, v in props.items()) + ")"


SPO = "(subject STRING, predicate STRING, object STRING)"


def _typed(spo: str) -> str:
    return f"(SELECT subject FROM {spo} WHERE predicate = {sql_string(RDF_TYPE)})"


def adj_out_select(spo: str) -> str:
    """Outgoing hops to TYPED IRI objects, without rdf:type / rdfs:label (OntoBricks' typed-out semantics)."""
    return (f"SELECT DISTINCT e.subject AS src, e.predicate AS predicate, e.object AS dst FROM {spo} e "
            f"LEFT SEMI JOIN {_typed(spo)} typed ON typed.subject = e.object "
            f"WHERE e.object LIKE 'http%' AND e.predicate NOT IN ({sql_string(RDF_TYPE)}, {sql_string(RDFS_LABEL)})")


def adj_in_select(spo: str) -> str:
    """Reverse hops from TYPED subjects to IRI objects (OntoBricks' typed-in semantics: the subject is typed)."""
    return (f"SELECT DISTINCT e.object AS dst, e.predicate AS predicate, e.subject AS src FROM {spo} e "
            f"LEFT SEMI JOIN {_typed(spo)} typed ON typed.subject = e.subject "
            f"WHERE e.object LIKE 'http%' AND e.predicate NOT IN ({sql_string(RDF_TYPE)}, {sql_string(RDFS_LABEL)})")


def entity_search_select(spo: str) -> str:
    """One row per typed subject: the smallest type IRI and label (deterministic), plus lowercase search keys."""
    return ("SELECT t.subject AS uri, t.type_uri AS type_uri, coalesce(l.label, '') AS label, lower(t.subject) AS uri_lc, "
            "lower(coalesce(l.label, '')) AS label_lc "
            f"FROM (SELECT subject, min(object) AS type_uri FROM {spo} WHERE predicate = {sql_string(RDF_TYPE)} GROUP BY subject) t "
            f"LEFT JOIN (SELECT subject, min(object) AS label FROM {spo} WHERE predicate = {sql_string(RDFS_LABEL)} GROUP BY subject) l "
            "ON l.subject = t.subject")


def props_select(spo: str) -> str:
    """Every outgoing triple of a typed subject (Explorer's expansion payload)."""
    return (f"SELECT e.subject AS subject, e.predicate AS predicate, e.object AS object FROM {spo} e "
            f"LEFT SEMI JOIN {_typed(spo)} typed ON typed.subject = e.subject")


def insert_batches(stage_fqn: str, triples: list[tuple[str, str, str]], *, max_bytes: int = MAX_STATEMENT_BYTES,
                   max_rows: int = MAX_ROWS_PER_INSERT) -> list[tuple[str, int]]:
    """``[(INSERT statement, rows)]``, each statement at most ``max_bytes`` UTF-8 bytes (a single oversized triple gets a
    statement of its own, up to the hard 16 MiB limit). Order is preserved and every triple appears exactly once."""
    head = f"INSERT INTO {stage_fqn} (subject, predicate, object) VALUES\n"
    head_n = len(head.encode())
    out: list[tuple[str, int]] = []
    rows: list[str] = []
    size = head_n
    for s, p, o in triples:
        row = f"({sql_string(s)}, {sql_string(p)}, {sql_string(o)})"
        n = len(row.encode()) + 2
        if head_n + n > HARD_STATEMENT_BYTES:
            raise ValueError(f"one triple is larger than the statement limit ({n} bytes): {s[:80]}")
        if rows and (size + n > max_bytes or len(rows) >= max_rows):
            out.append((head + ",\n".join(rows), len(rows)))
            rows, size = [], head_n
        rows.append(row)
        size += n
    if rows:
        out.append((head + ",\n".join(rows), len(rows)))
    return out


# ====================================================================== objects
def objects(t: Target) -> list[dict]:
    """The hub-owned objects, in creation order (dependencies first). ``stage`` is separate (created, then dropped)."""
    b = t.base
    rows = [
        ("data", f"{b}_data", "TABLE", "The Agent Registry Hub knowledge graph as RDF triples (subject, predicate, object). Objects that start "
         "with http are IRIs, everything else is a literal. Written by the hub's export; do not edit."),
        ("inferred", f"{b}_inferred", "TABLE", "Companion for reasoning / app-written triples (same shape as _data). Emptied by every hub export."),
        ("graph", f"{b}_graph", "VIEW", "Read facade: _data UNION ALL _inferred (what OntoBricks' Explorer reads)."),
        ("base", b, "VIEW", "Pass-through view over _data. In OntoBricks this name is the R2RML mapping view; the hub computes its "
         "triples from Lakebase, so this view only keeps every derived name resolvable."),
        ("adj_out", f"{b}_adj_out", "TABLE", "Outgoing hop index (src, predicate, dst) to typed IRI objects, from _graph."),
        ("adj_in", f"{b}_adj_in", "TABLE", "Incoming hop index (dst, predicate, src) from typed subjects, from _graph."),
        ("entity_search", f"{b}_entity_search", "TABLE", "One row per typed node: uri, type_uri, label and lowercase search keys, from _graph."),
        ("entity_search_asserted", f"{b}_entity_search_asserted", "TABLE", "The entity-search index from _data only (asserted triples)."),
        ("props", f"{b}_props", "TABLE", "Every triple whose subject is a typed node (Explorer's expansion payload), from _graph."),
        ("kg_nodes", "kg_nodes", "VIEW", "One row per node of the Agent Registry Hub knowledge graph (agents, MCP servers, tools, skills, tables, "
         "policies, Microsoft Agent 365 records) with its type, label and key attributes. Read from the triple store."),
        ("kg_edges", "kg_edges", "VIEW", "One row per relationship between two nodes (agent uses MCP server, MCP server exposes tool, asset "
         "reads table, …) with both ends' labels and types. Read from the triple store."),
        ("kg_registry_matches", "kg_registry_matches", "VIEW", "Microsoft Agent 365 registry records and the hub asset (usually a Genie agent) "
         "each one is, or may be: status, method and confidence of the match."),
    ]
    return [{"role": r, "leaf": leaf, "kind": kind, "comment": c, "name": t.name(leaf), "api_name": t.api_name(leaf)} for r, leaf, kind, c in rows]


def stage_object(t: Target) -> dict:
    leaf = f"{t.base}_stage"
    return {"role": "stage", "leaf": leaf, "kind": "TABLE", "comment": "Staging table of a running hub export (dropped when it finishes).",
            "name": t.name(leaf), "api_name": t.api_name(leaf)}


def _case(column: str, mapping: dict[str, str]) -> str:
    whens = " ".join(f"WHEN {sql_string(k)} THEN {sql_string(v)}" for k, v in mapping.items())
    return f"CASE {column} {whens} END"


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


NODE_COLUMNS = [  # (column, predicate local name or special, cast, comment)
    ("node_iri", None, None, "The node's IRI: <namespace><Class>/<percent-encoded key> (asset URN, table FQN, policy id, Microsoft id)."),
    ("node_type", "@type", None, "What the node is: Agent, MCP server, Tool, Skill, Unity Catalog table, Volume, Vector search index, Model, "
     "Databricks app, External resource, Policy or guardrail, Microsoft Agent 365 registry record."),
    ("node_subtype", "@subtype", None, "The more specific kind when known, e.g. Genie agent, Agent Bricks supervisor, Unity Catalog function, MCP tool."),
    ("label", "@label", None, "Display name (for tables: catalog.schema.table)."),
    ("asset_id", "assetId", None, "The asset's URN in the Agent Registry Hub (NULL for tables, policies and other non-asset nodes)."),
    ("lifecycle_status", "lifecycleStatus", None, "discovered, draft, pending_approval, approved, rejected, deprecated or retired."),
    ("certification", "certification", None, "certified, verified_publisher, unreviewed or deprecated."),
    ("source", "source", None, "databricks (native), external or custom."),
    ("platform", "platform", None, "Where it runs or is registered, e.g. genie, agent_bricks, model_serving, unity_catalog, databricks_apps."),
    ("publisher", "publisher", None, "Publisher organisation, when known."),
    ("risk_tier", "riskTier", None, "low, medium, high or critical."),
    ("workspace", "workspace", None, "Databricks workspace host of the asset."),
    ("owners", "@owners", None, "Owner and co-owner emails, comma-separated (owners are visible to every hub user)."),
    ("deep_link", "deepLink", None, "The asset's page in the Databricks workspace."),
    ("hub_page", "hubPage", None, "The asset's page in the Agent Registry Hub."),
    ("created_at", "createdAt", "TIMESTAMP", "Created in the source system (else first seen by the hub), UTC."),
    ("updated_at", "updatedAt", "TIMESTAMP", "Last changed in the source system (else in the hub), UTC."),
    ("requests_30d", "requests30d", "BIGINT", "Requests in the last 30 complete UTC days."),
    ("distinct_requesters_30d", "distinctRequesters30d", "BIGINT", "Distinct people and service principals who called it in the last 30 complete days."),
    ("cost_usd_30d", "costUsd30d", "DECIMAL(18,2)", "Estimated cost in USD over the last 30 complete days."),
    ("active_subscriptions", "activeSubscriptions", "BIGINT", "Active hub subscriptions (a count; subscriber identities are not exported)."),
    ("observed_consumers", "observedConsumers", "BIGINT", "Distinct people and service principals observed using it (a count)."),
    ("class_iri", "@class", None, "The node's ontology class IRI."),
    ("subclass_iri", "@subclass", None, "The node's more specific ontology class IRI, when known."),
]

MATCH_COLUMNS = [
    ("package_iri", "IRI of the Microsoft Agent 365 registry record."),
    ("package_label", "The record's display name in the Microsoft 365 agent registry."),
    ("m365_id", "The record's id in the Microsoft 365 agent registry."),
    ("platform", "The record's platform, e.g. Databricks Genie."),
    ("match_status", "linked (a steward confirmed it), matched (identified automatically, confidence >= 0.85), suggested (a weaker match "
     "waiting for a steward), unmatched or dismissed."),
    ("match_method", "How it matched: genie_space_id, endpoint_name, app_name, name or steward."),
    ("match_confidence", "Confidence of the match from 0 to 1 (NULL when there is no match)."),
    ("link", "registered_as (the record IS this hub asset), candidate_match (a suggestion) or NULL (no link)."),
    ("asset_iri", "IRI of the hub asset the record is (or may be)."),
    ("asset_id", "The hub asset's URN (agent:genie:<space id> for a Genie agent)."),
    ("asset_label", "The hub asset's display name."),
    ("asset_type", "The hub asset's type (Agent, …)."),
    ("asset_subtype", "The hub asset's subtype (e.g. Genie agent)."),
]

EDGE_COLUMNS = [
    ("source_iri", "IRI of the node the relationship starts at (the dependent: the agent that uses an MCP server, the MCP server that exposes a tool)."),
    ("source_label", "Display name of the source node."),
    ("source_type", "Type of the source node (Agent, MCP server, Tool, …)."),
    ("source_asset_id", "Hub URN of the source node when it is a registered asset."),
    ("relation", "The relationship in the hub's terms: uses_mcp, uses_tool, calls_agent, uses_skill, uses_model, exposes_tool, consumes, "
     "subscribes, hosts, routes_to, reads_data, writes_data, registered_consumer_of, governed_by, proposed_policy, registered_as, candidate_match."),
    ("predicate_label", "Readable name of the relationship, e.g. 'uses MCP server'."),
    ("predicate_iri", "The relationship's ontology property IRI."),
    ("target_iri", "IRI of the node the relationship points to (the dependency: the MCP server used, the tool exposed, the table read)."),
    ("target_label", "Display name of the target node."),
    ("target_type", "Type of the target node."),
    ("target_asset_id", "Hub URN of the target node when it is a registered asset."),
]


def _view_columns(cols: list[tuple[str, str]]) -> str:
    return "(" + ", ".join(f"{c} COMMENT {sql_string(comment)}" for c, comment in cols) + ")"


def kg_nodes_select(ns: str, graph_fqn: str) -> str:
    cls_label = {ns + c.name: c.label for c in kg.CLASSES}
    base = ", ".join(sql_string(ns + c) for c in kg.BASE_CLASSES)
    sub = ", ".join(sql_string(ns + c) for c in kg.SUBTYPE_CLASSES)
    pivots = []
    for col, key, cast, _ in NODE_COLUMNS:
        if col in ("node_iri", "node_type", "node_subtype"):
            continue
        if key == "@label":
            expr = f"max(CASE WHEN predicate = {sql_string(RDFS_LABEL)} THEN object END)"
        elif key == "@class":
            expr = f"max(CASE WHEN predicate = {sql_string(RDF_TYPE)} AND object IN ({base}) THEN object END)"
        elif key == "@subclass":
            expr = f"max(CASE WHEN predicate = {sql_string(RDF_TYPE)} AND object IN ({sub}) THEN object END)"
        elif key == "@owners":
            expr = f"nullif(array_join(array_sort(collect_set(CASE WHEN predicate = {sql_string(ns + 'owner')} THEN object END)), ', '), '')"
        else:
            expr = f"max(CASE WHEN predicate = {sql_string(ns + key)} THEN object END)"
        if cast:
            expr = f"try_cast({expr} AS {cast})"
        pivots.append(f"{expr} AS {col}")
    cols = [c for c, *_ in NODE_COLUMNS]
    outer = [("node_iri" if c == "node_iri" else f"{_case('class_iri', cls_label)} AS node_type" if c == "node_type"
              else f"{_case('subclass_iri', cls_label)} AS node_subtype" if c == "node_subtype" else c) for c in cols]
    return (f"SELECT {', '.join(outer)} FROM (SELECT subject AS node_iri, {', '.join(pivots)} FROM {graph_fqn} GROUP BY subject) n "
            "WHERE class_iri IS NOT NULL")


def kg_edges_select(ns: str, graph_fqn: str, nodes_fqn: str) -> str:
    props = kg.OBJECT_PROPERTIES
    rel = {ns + p.name: (p.relation or _snake(p.name)) for p in props}
    lab = {ns + p.name: p.label for p in props}
    inlist = ", ".join(sql_string(ns + p.name) for p in props)
    return ("SELECT e.subject AS source_iri, s.label AS source_label, s.node_type AS source_type, s.asset_id AS source_asset_id, "
            f"{_case('e.predicate', rel)} AS relation, {_case('e.predicate', lab)} AS predicate_label, e.predicate AS predicate_iri, "
            "e.object AS target_iri, t.label AS target_label, t.node_type AS target_type, t.asset_id AS target_asset_id "
            f"FROM (SELECT DISTINCT subject, predicate, object FROM {graph_fqn} WHERE predicate IN ({inlist})) e "
            f"JOIN {nodes_fqn} s ON s.node_iri = e.subject JOIN {nodes_fqn} t ON t.node_iri = e.object")


def kg_matches_select(ns: str, graph_fqn: str, nodes_fqn: str) -> str:
    pkg = sql_string(ns + "Agent365Package")
    links = {ns + "registeredAs": "registered_as", ns + "candidateMatch": "candidate_match"}
    pivot = ", ".join(f"max(CASE WHEN predicate = {sql_string(ns + key)} THEN object END) AS {col}" for col, key in
                      (("m365_id", "m365Id"), ("platform", "platform"), ("match_status", "matchStatus"), ("match_method", "matchMethod"),
                       ("match_confidence", "matchConfidence")))
    return ("SELECT p.subject AS package_iri, coalesce(n.label, p.m365_id) AS package_label, p.m365_id, p.platform, p.match_status, "
            "p.match_method, try_cast(p.match_confidence AS DOUBLE) AS match_confidence, "
            f"{_case('l.predicate', links)} AS link, l.object AS asset_iri, a.asset_id, a.label AS asset_label, a.node_type AS asset_type, "
            "a.node_subtype AS asset_subtype "
            f"FROM (SELECT subject, {pivot} FROM {graph_fqn} WHERE subject IN (SELECT subject FROM {graph_fqn} WHERE predicate = "
            f"{sql_string(RDF_TYPE)} AND object = {pkg}) GROUP BY subject) p "
            f"LEFT JOIN {nodes_fqn} n ON n.node_iri = p.subject "
            f"LEFT JOIN (SELECT DISTINCT subject, predicate, object FROM {graph_fqn} WHERE predicate IN "
            f"({', '.join(sql_string(k) for k in links)})) l ON l.subject = p.subject "
            "LEFT JOIN " + nodes_fqn + " a ON a.node_iri = l.object")


def ddl(t: Target, *, ns: str, instance: str, digest: str, triples: int) -> dict[str, str]:
    """role → the statement that (re)creates that object (stage and data are created from the stage)."""
    o = {x["role"]: x for x in objects(t)}
    st = stage_object(t)
    f = {r: t.fqn(x["leaf"]) for r, x in o.items()}
    stage = t.fqn(st["leaf"])
    P = lambda role, extra=None: tblproperties(instance, role, digest, extra)  # noqa: E731
    C = lambda role: f"COMMENT {sql_string(o[role]['comment'])}"  # noqa: E731
    out = {
        "stage": f"CREATE OR REPLACE TABLE {stage} {SPO} USING DELTA COMMENT {sql_string(st['comment'])} {P('stage')}",
        "data": (f"CREATE OR REPLACE TABLE {f['data']} USING DELTA CLUSTER BY (predicate, subject) {C('data')} "
                 f"{P('data', {'kg_triples': str(triples), 'kg_namespace': ns})} AS SELECT subject, predicate, object FROM {stage}"),
        "inferred": f"CREATE OR REPLACE TABLE {f['inferred']} {SPO} USING DELTA CLUSTER BY (predicate, subject) {C('inferred')} {P('inferred')}",
        "graph": (f"CREATE OR REPLACE VIEW {f['graph']} {C('graph')} {P('graph')} AS SELECT subject, predicate, object FROM {f['data']} "
                  f"UNION ALL SELECT subject, predicate, object FROM {f['inferred']}"),
        "base": f"CREATE OR REPLACE VIEW {f['base']} {C('base')} {P('base')} AS SELECT subject, predicate, object FROM {f['data']}",
        "adj_out": (f"CREATE OR REPLACE TABLE {f['adj_out']} USING DELTA CLUSTER BY (src, predicate) {C('adj_out')} {P('adj_out')} "
                    f"AS {adj_out_select(f['graph'])}"),
        "adj_in": (f"CREATE OR REPLACE TABLE {f['adj_in']} USING DELTA CLUSTER BY (dst, predicate) {C('adj_in')} {P('adj_in')} "
                   f"AS {adj_in_select(f['graph'])}"),
        "entity_search": (f"CREATE OR REPLACE TABLE {f['entity_search']} USING DELTA CLUSTER BY (type_uri, label_lc) {C('entity_search')} "
                          f"{P('entity_search')} AS {entity_search_select(f['graph'])}"),
        "entity_search_asserted": (f"CREATE OR REPLACE TABLE {f['entity_search_asserted']} USING DELTA CLUSTER BY (type_uri, label_lc) "
                                   f"{C('entity_search_asserted')} {P('entity_search_asserted')} AS {entity_search_select(f['data'])}"),
        "props": (f"CREATE OR REPLACE TABLE {f['props']} USING DELTA CLUSTER BY (subject) {C('props')} {P('props')} "
                  f"AS {props_select(f['graph'])}"),
        "kg_nodes": (f"CREATE OR REPLACE VIEW {f['kg_nodes']} {_view_columns([(c, x) for c, _, _, x in NODE_COLUMNS])} {C('kg_nodes')} "
                     f"{P('kg_nodes')} AS {kg_nodes_select(ns, f['graph'])}"),
        "kg_edges": (f"CREATE OR REPLACE VIEW {f['kg_edges']} {_view_columns(EDGE_COLUMNS)} {C('kg_edges')} {P('kg_edges')} "
                     f"AS {kg_edges_select(ns, f['graph'], f['kg_nodes'])}"),
        "kg_registry_matches": (f"CREATE OR REPLACE VIEW {f['kg_registry_matches']} {_view_columns(MATCH_COLUMNS)} {C('kg_registry_matches')} "
                                f"{P('kg_registry_matches')} AS {kg_matches_select(ns, f['graph'], f['kg_nodes'])}"),
    }
    return out


# ====================================================================== plan / preview
def _digest(t: Target | None, ns: str, instance: str, g: kg.Graph) -> str:
    key = [LAYOUT, ns, t.name(t.base) if t else None, instance, g.digest]
    return hashlib.sha256(json.dumps(key).encode()).hexdigest()[:24]


def hub_url(cur, app_url: str | None = None) -> str | None:
    """The hub URL hub pages link to: the request's (app), else the one the last app export/publish remembered (the job)."""
    return (app_url or settings.get(cur, "hub_app_url", "") or os.environ.get("APP_URL", "") or "").rstrip("/") or None


def workspace_host(mode: str) -> str | None:
    host = os.environ.get("DATABRICKS_HOST", "").strip()
    if not host and mode == "platform":
        try:
            from core.lakebase import workspace_client
            host = workspace_client().config.host or ""
        except Exception:  # noqa: BLE001 - only used for deep links
            host = ""
    if host and not host.startswith("http"):
        host = "https://" + host
    return host.rstrip("/") or None


def explorer_url(host: str | None, t: Target, leaf: str) -> str | None:
    return f"{host}/explore/data/{quote(t.catalog.lower())}/{quote(t.schema.lower())}/{quote(leaf.lower())}" if host else None


def last_run(cur, t: Target | None, mode: str | None = None) -> dict | None:
    if not t or not tables_exist(cur):
        return None
    cur.execute(f"""SELECT run_id, digest, status, mode, started_at, finished_at FROM kg_export_run
                     WHERE target = %s AND status IN ('succeeded','unchanged') {"AND mode = %s" if mode else ""}
                     ORDER BY run_id DESC LIMIT 1""", (t.name(t.base), mode) if mode else (t.name(t.base),))
    return cur.fetchone()


def plan(cur, *, app_url: str | None = None, mode: str | None = None, namespace: str | None = None,
         max_statement_bytes: int | None = None) -> dict:
    """Everything an export would do, computed read-only. Internal keys start with ``_``."""
    mode = mode or provision.mode()
    ns = kg.validate_namespace(namespace) if namespace else kg.default_namespace()
    instance = settings.instance_id(cur)
    g = kg.build(cur, namespace=ns, app_url=hub_url(cur, app_url))
    t = target(cur)
    digest = _digest(t, ns, instance, g)
    out: dict[str, Any] = {
        "mode": mode, "namespace": ns, "instance": instance, "digest": digest, "layout": LAYOUT,
        "triples": len(g.triples),
        "classes": [{"iri": k, "name": k[len(ns):] if k.startswith(ns) else k, "label": kg.label_of(ns, k), "count": n} for k, n in g.classes.items()],
        "predicates": [{"iri": k, "name": k[len(ns):] if k.startswith(ns) else k.rsplit("#", 1)[-1], "label": kg.label_of(ns, k), "count": n,
                        "kind": _predicate_kind(ns, k)} for k, n in g.predicates.items()],
        "samples": [list(x) for x in g.samples[:SAMPLES_SHOWN]],
        "skipped": g.skipped, "privacy": g.privacy,
        "target": None, "objects": [], "statements": [], "load": None, "requirements": [], "explorer_url": None,
        "_graph": g, "_target": t,
    }
    if not t:
        out["note"] = ("No target yet: set the catalog and schema here (admin) or deploy with --var kg_target=<catalog>.<schema>. "
                       "The preview below is what an export would write.")
        return out
    host = workspace_host(mode)
    obs = objects(t)
    st = stage_object(t)
    statements = ddl(t, ns=ns, instance=instance, digest=digest, triples=len(g.triples))
    batches = insert_batches(t.fqn(st["leaf"]), g.triples, max_bytes=max_statement_bytes or MAX_STATEMENT_BYTES)
    sizes = [len(b.encode()) for b, _ in batches]
    out["target"] = {"catalog": t.catalog, "schema": t.schema, "version": t.version, "base": t.base, "source": t.source,
                     "schema_name": t.schema_name, "data_table": t.name(f"{t.base}_data")}
    out["objects"] = [{k: x[k] for k in ("role", "name", "kind", "comment")} | {"explorer_url": explorer_url(host, t, x["leaf"])} for x in obs]
    out["explorer_url"] = explorer_url(host, t, f"{t.base}_data")
    out["load"] = {"stage": st["name"], "batches": len(batches), "rows": len(g.triples), "max_statement_bytes": max_statement_bytes or MAX_STATEMENT_BYTES,
                   "largest_statement_bytes": max(sizes) if sizes else 0, "total_bytes": sum(sizes)}
    first = batches[0][0] if batches else ""
    out["statements"] = (
        [{"step": "inspect", "sql": f"GET /api/2.1/unity-catalog/tables/{x['api_name']}  (ownership check, before any write)"}
         for x in [*obs, st]]
        + [{"step": "schema", "sql": f"CREATE SCHEMA IF NOT EXISTS `{t.catalog}`.`{t.schema}` COMMENT {sql_string('Agent Registry Hub knowledge graph')}  "
            "(only when the schema is missing)"}]
        + [{"step": "stage", "sql": statements["stage"]}]
        + [{"step": "load", "sql": (first[:1500] + " …") if len(first) > 1500 else first,
            "detail": f"{len(batches)} INSERT batch(es), {len(g.triples)} rows, largest {max(sizes) if sizes else 0} bytes"}]
        + [{"step": "verify", "sql": f"SELECT count(*) AS n FROM {t.fqn(st['leaf'])}  -- must be {len(g.triples)}"}]
        + [{"step": x["role"], "sql": statements[x["role"]]} for x in obs]
        + [{"step": "drop_stage", "sql": f"DROP TABLE IF EXISTS {t.fqn(st['leaf'])}"}]
    )
    out["requirements"] = [
        f"USE CATALOG on {t.catalog}, plus CREATE SCHEMA when {t.schema_name} does not exist yet",
        f"USE SCHEMA and CREATE TABLE on {t.schema_name}",
        "CAN USE on the SQL warehouse (WAREHOUSE_ID)",
    ]
    out["_ddl"], out["_batches"], out["_stage"], out["_objects"] = statements, batches, st, obs
    return out


def _predicate_kind(ns: str, p: str) -> str:
    if p in (RDF_TYPE, RDFS_LABEL):
        return "rdf"
    return "object" if any(p == ns + o.name for o in kg.OBJECT_PROPERTIES) else "data"


def public(pl: dict) -> dict:
    return {k: v for k, v in pl.items() if not k.startswith("_")}


def preview(cur, p: authz.Principal, *, app_url: str | None = None) -> dict:
    authz.require(p.can_read_everything, "The knowledge graph export is for stewards, admins and auditors")
    pl = plan(cur, app_url=app_url)
    lr = last_run(cur, pl["_target"], pl["mode"])
    return {**public(pl), "available": tables_exist(cur), "can_export": p.is_admin and tables_exist(cur) and pl["target"] is not None,
            "last_run": lr, "unchanged_since_last_run": bool(lr and lr["digest"] == pl["digest"])}


# ====================================================================== export
class _Platform:
    """Unity Catalog reads (Tables API) and SQL (Statement Execution) for one export."""

    def __init__(self, w, warehouse_id: str):
        self.w, self.warehouse_id = w, warehouse_id
        self.ran: list[dict] = []

    def sql(self, statement: str, step: str, summary: str | None = None) -> list[dict]:
        rows = warehouse.execute(statement, client=self.w, warehouse_id=self.warehouse_id, max_wait_s=STATEMENT_WAIT_S)
        self.ran.append({"step": step, "sql": summary or statement})
        return rows

    def get(self, path: str) -> dict | None:
        try:
            return self.w.api_client.do("GET", path) or {}
        except Exception as e:  # noqa: BLE001 - 404 = missing; anything else propagates
            if _not_found(e):
                return None
            raise


def _not_found(err: BaseException) -> bool:
    from databricks.sdk.errors import NotFound

    code = str(getattr(err, "error_code", "") or "").upper()
    return isinstance(err, NotFound) or getattr(err, "status_code", None) == 404 or "NOT_FOUND" in code or "DOES_NOT_EXIST" in code


def _kind(info: dict) -> str:
    tt = str(info.get("table_type") or "").upper()
    return "VIEW" if tt == "VIEW" else "TABLE" if tt in ("MANAGED", "EXTERNAL", "") else tt


def inspect(api: _Platform, t: Target, instance: str) -> dict[str, dict]:
    """role → {exists, ours, kind, digest, created_by} for every target name (stage included), read-only."""
    out = {}
    for x in [*objects(t), stage_object(t)]:
        info = api.get(f"/api/2.1/unity-catalog/tables/{x['api_name']}")
        if info is None:
            out[x["role"]] = {"exists": False}
            continue
        props = info.get("properties") or {}
        out[x["role"]] = {"exists": True, "ours": props.get("created_by") == HUB and props.get("hub_instance") == instance,
                          "kind": _kind(info), "digest": props.get("kg_digest"), "created_by": props.get("created_by"),
                          "hub_instance": props.get("hub_instance")}
    return out


def conflicts(state: dict[str, dict], t: Target) -> list[dict]:
    by_role = {x["role"]: x for x in [*objects(t), stage_object(t)]}
    out = []
    for role, s in state.items():
        if s["exists"] and not s["ours"]:
            why = ("created by another Agent Registry Hub install" if s.get("created_by") == HUB
                   else "not created by the Agent Registry Hub" if not s.get("created_by") else f"created_by={s['created_by']}")
            out.append({"role": role, "name": by_role[role]["name"], "kind": s.get("kind"), "reason": f"exists and was {why}: left untouched"})
    return out


def _export_platform(cur, pl: dict, api: _Platform) -> dict:
    t: Target = pl["_target"]
    state = inspect(api, t, pl["instance"])
    found = conflicts(state, t)
    if found:
        return {"status": "conflict", "conflicts": found}
    if all(state[x["role"]]["exists"] and state[x["role"]]["digest"] == pl["digest"] and state[x["role"]]["kind"] == x["kind"]
           for x in pl["_objects"]):
        return {"status": "unchanged", "conflicts": []}
    if api.get(f"/api/2.1/unity-catalog/schemas/{t.schema_name.lower()}") is None:
        api.sql(f"CREATE SCHEMA IF NOT EXISTS `{t.catalog}`.`{t.schema}` COMMENT {sql_string('Agent Registry Hub knowledge graph (created by the hub export)')}",
                "schema")
    st = pl["_stage"]
    stage_fqn = t.fqn(st["leaf"])
    staged = False
    try:
        if state["stage"]["exists"] and state["stage"]["kind"] != "TABLE":
            api.sql(f"DROP VIEW IF EXISTS {stage_fqn}", "drop_stage_view")
        api.sql(pl["_ddl"]["stage"], "stage")
        staged = True
        for i, (statement, rows) in enumerate(pl["_batches"], 1):
            api.sql(statement, "load", f"INSERT INTO {stage_fqn} … -- batch {i}/{len(pl['_batches'])}: {rows} rows, {len(statement.encode())} bytes")
        n = api.sql(f"SELECT count(*) AS n FROM {stage_fqn}", "verify")
        loaded = int((n[0] if n else {}).get("n") or 0)
        if loaded != pl["triples"]:
            raise RuntimeError(f"the stage holds {loaded} rows, expected {pl['triples']}: nothing was swapped in")
        for x in pl["_objects"]:
            s = state[x["role"]]
            if s["exists"] and s["kind"] != x["kind"]:  # ours, but the other kind: Databricks cannot replace a TABLE with a VIEW
                api.sql(f"DROP {'VIEW' if s['kind'] == 'VIEW' else 'TABLE'} IF EXISTS {t.fqn(x['leaf'])}", f"drop_{x['role']}")
            api.sql(pl["_ddl"][x["role"]], x["role"])
    finally:
        if staged:
            try:
                api.sql(f"DROP TABLE IF EXISTS {stage_fqn}", "drop_stage")
            except Exception as e:  # noqa: BLE001 - a leftover stage is ours and is replaced by the next run
                log.warning("could not drop the KG stage %s: %s", stage_fqn, e)
    return {"status": "succeeded", "conflicts": []}


def _recorded(pl: dict) -> list[dict]:
    t: Target = pl["_target"]
    stage_fqn = t.fqn(pl["_stage"]["leaf"])
    out = [{"step": "stage", "sql": pl["_ddl"]["stage"]}]
    out += [{"step": "load", "sql": f"INSERT INTO {stage_fqn} … -- batch {i}/{len(pl['_batches'])}: {rows} rows, {len(s.encode())} bytes"}
            for i, (s, rows) in enumerate(pl["_batches"], 1)]
    out += [{"step": "verify", "sql": f"SELECT count(*) AS n FROM {stage_fqn}"}]
    out += [{"step": x["role"], "sql": pl["_ddl"][x["role"]]} for x in pl["_objects"]]
    return out + [{"step": "drop_stage", "sql": f"DROP TABLE IF EXISTS {stage_fqn}"}]


def export(cur, p: authz.Principal | None, *, digest: str | None = None, app_url: str | None = None, user_token: str | None = None,
           client: Any = None, acting_as: str | None = None, mode: str | None = None, max_statement_bytes: int | None = None) -> dict:
    """Export the current graph. ``p`` None = the sync job step (actor ``system:sync``). One audit row per run."""
    if p is not None:
        authz.require(p.is_admin, "Only an admin can export the knowledge graph to Unity Catalog")
    if not tables_exist(cur):
        raise Conflict("The knowledge graph export needs migration 008 (run the setup job)")
    mode = mode or provision.mode()
    pl = plan(cur, app_url=app_url, mode=mode, max_statement_bytes=max_statement_bytes)
    t: Target | None = pl["_target"]
    if t is None:
        raise Conflict("Set the target catalog and schema first (Governance, or --var kg_target=<catalog>.<schema>)")
    if digest and digest != pl["digest"]:
        raise Conflict("The knowledge graph changed since you previewed it. Review the new preview, then export.")
    from core import db

    cur.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS ok", (f"kg-export:{db.lb.schema}:{t.name(t.base)}",))
    if not cur.fetchone()["ok"]:
        raise Conflict("Another export to this target is running")
    actor = p.email if p else "system:sync"
    if p is not None and app_url:
        settings.remember(cur, "hub_app_url", app_url.rstrip("/"), actor=actor)
    api = None
    if mode == "platform":
        if not (config.WAREHOUSE_ID or "").strip():
            raise Conflict("WAREHOUSE_ID is not set: the export runs on a SQL warehouse")
        if client is not None:
            w, acting_as = client, acting_as or "sync job identity"
        else:
            w, acting_as = provision._client(user_token)
        api = _Platform(w, config.WAREHOUSE_ID)
    cur.execute("""INSERT INTO kg_export_run (triggered_by, mode, acting_as, target, digest) VALUES (%s, %s, %s, %s, %s) RETURNING run_id""",
                (actor, mode, acting_as if mode == "platform" else None, t.name(t.base), pl["digest"]))
    run_id = cur.fetchone()["run_id"]
    error, found = None, []
    try:
        if mode == "platform":
            res = _export_platform(cur, pl, api)
            statements = api.ran
        else:
            lr = last_run(cur, t, "record_only")
            res = {"status": "unchanged" if lr and lr["digest"] == pl["digest"] else "succeeded", "conflicts": []}
            statements = [] if res["status"] == "unchanged" else _recorded(pl)
        status, found = res["status"], res["conflicts"]
    except Exception as e:  # noqa: BLE001 - recorded on the run; the response carries it
        status, error = "failed", " ".join(str(e).split())[:1000] or type(e).__name__
        statements = api.ran if api else []
        log.warning("knowledge graph export %s failed: %s", run_id, error)
    counts = {"triples": pl["triples"], "classes": len(pl["classes"]), "predicates": len(pl["predicates"]),
              "batches": pl["load"]["batches"], "objects": len(pl["objects"]), "statements": len(statements)}
    cur.execute("""UPDATE kg_export_run SET status = %s, counts = %s, conflicts = %s, error = %s, statements = %s, finished_at = now()
                    WHERE run_id = %s""", (status, Jsonb(counts), Jsonb(found), error, Jsonb(statements[:500]), run_id))
    audit.audit_event(actor, "kg.export", "kg_export", run_id, before={"digest": pl["digest"], "target": t.name(t.base)},
                      after={"mode": mode, "acting_as": acting_as if mode == "platform" else None, "status": status, "counts": counts,
                             "conflicts": len(found), "error": error},
                      request_id=getattr(p, "request_id", None), cur=cur, source="job" if p is None else None)
    return {"run_id": run_id, "status": status, "mode": mode, "acting_as": acting_as if mode == "platform" else None, "digest": pl["digest"],
            "target": pl["target"], "counts": counts, "conflicts": found, "error": error, "statements": statements[:200],
            "explorer_url": pl["explorer_url"]}


# ====================================================================== status, settings, sync step
def runs(cur, limit: int = 10) -> list[dict]:
    cur.execute("""SELECT run_id, triggered_by, mode, acting_as, target, digest, status, counts, conflicts, error, started_at, finished_at,
                          jsonb_array_length(statements) AS statements_recorded
                     FROM kg_export_run ORDER BY run_id DESC LIMIT %s""", (limit,))
    return list(cur.fetchall())


def current_settings(cur) -> dict:
    env = bundle_target()
    return {"export_in_sync": bool(settings.get(cur, "kg_export_in_sync")), "catalog": settings.get(cur, "kg_target_catalog") or "",
            "schema": settings.get(cur, "kg_target_schema") or "", "version": int(settings.get(cur, "kg_store_version") or 1),
            "bundle_target": f"{env[0]}.{env[1]}" if env else None}


def status(cur, p: authz.Principal) -> dict:
    authz.require(p.can_read_everything, "The knowledge graph export is for stewards, admins and auditors")
    t = target(cur)
    base = {"settings": current_settings(cur), "can_export": p.is_admin, "namespace": kg.default_namespace(), "layout": LAYOUT,
            "target": ({"catalog": t.catalog, "schema": t.schema, "version": t.version, "base": t.base, "source": t.source,
                        "data_table": t.name(f"{t.base}_data")} if t else None)}
    if not tables_exist(cur):
        return {**base, "available": False, "note": "Migration 008 is not applied yet: run the setup job.", "runs": [], "can_export": False}
    return {**base, "available": True, "runs": runs(cur)}


SETTING_KEYS = {"export_in_sync": "kg_export_in_sync", "catalog": "kg_target_catalog", "schema": "kg_target_schema", "version": "kg_store_version"}


def put_settings(cur, body: dict, *, p: authz.Principal) -> dict:
    authz.require(p.is_admin, "Only an admin can change the knowledge graph export settings")
    given = {k: body[k] for k in SETTING_KEYS if k in body}
    if not given:
        raise ValueError(f"nothing to change: send any of {sorted(SETTING_KEYS)}")
    for k, v in given.items():
        settings.put(cur, SETTING_KEYS[k], v, p=p, reason=body.get("reason"))
    return current_settings(cur)


def sync_step(client_factory: Any, *, triggered_by: str = "schedule") -> dict:
    """The sync job's optional export step (``kg_export_in_sync``, default OFF). Never raises. Gated on migration 008's
    table: the job runs from the staged bundle with --skip-migrations, so new code may meet an old schema."""
    from core import db

    try:
        with db.transaction() as cur:
            if not (tables_exist(cur) and settings.table_exists(cur)):
                return {"skipped": "migration 008 is not applied"}
            if not settings.get(cur, "kg_export_in_sync"):
                return {"skipped": "kg_export_in_sync is off"}
            t = target(cur)
            if t is None:
                return {"skipped": "no knowledge graph target is configured"}
            mode = provision.mode()
            pl = plan(cur, mode=mode)
            lr = last_run(cur, t, mode)
            if lr and lr["digest"] == pl["digest"]:
                return {"skipped": "unchanged since the last export", "digest": pl["digest"]}
            res = export(cur, None, client=client_factory() if mode == "platform" else None, acting_as=f"sync identity ({triggered_by})",
                         mode=mode)
            return {k: res[k] for k in ("run_id", "status", "mode", "digest", "counts")} | {"error": res["error"]}
    except Exception as e:  # noqa: BLE001 - the optional step must never fail the sync
        log.warning("knowledge graph export step failed: %s", e)
        return {"error": f"{type(e).__name__}: {str(e)[:300]}"}
