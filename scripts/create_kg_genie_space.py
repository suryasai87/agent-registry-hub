"""Print a Genie space definition over the hub's knowledge graph export (registry/kg_delta.py). DRY RUN by default.

Tables: the flat, commented views ``kg_nodes``, ``kg_edges``, ``kg_registry_matches`` plus the triple view
``triplestore_agent_registry_hub_V<n>_graph``; one-line instructions (the Genie API re-splits instruction text on
newlines); 10 example question SQLs written against the views' real columns.

    python scripts/create_kg_genie_space.py --target main.agent_kg                       # print the definition (JSON)
    python scripts/create_kg_genie_space.py --target main.agent_kg --verify \\
        --warehouse-id <id> --profile DEFAULT                                             # also RUN every example SQL (read-only)
    python scripts/create_kg_genie_space.py --target main.agent_kg --warehouse-id <id> --create --yes   # creates the space

``--create`` is the only path that changes anything (``POST /api/2.0/genie/spaces``) and needs ``--yes``; without it
the script only prints. Creating a space is a separate, explicit decision: review the printed definition first.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

TITLE = "Agent Registry Hub knowledge graph"
DESCRIPTION = ("Ask about the agents, MCP servers, tools and skills registered in the Agent Registry Hub: what uses what, what reads "
               "which tables, what breaks when something changes, and which Microsoft Agent 365 records are which Genie agents.")


def _id(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()  # noqa: S324 - a stable 32-hex id, not security


def instructions(base: str) -> list[str]:
    return [
        "kg_nodes has one row per node; node_type is Agent, MCP server, Tool, Skill, Unity Catalog table, Unity Catalog volume, Vector search "
        "index, Model, Databricks app, External resource, Policy or guardrail, or Microsoft Agent 365 registry record.",
        "node_subtype is the specific kind, e.g. Genie agent, Agent Bricks supervisor, Agent Bricks knowledge assistant, Unity Catalog "
        "function, MCP tool, External MCP server; Genie agents are kg_nodes rows with node_subtype = 'Genie agent'.",
        "kg_edges has one row per relationship from source (the dependent) to target (the dependency); relation is one of uses_mcp, "
        "uses_tool, calls_agent, uses_skill, uses_model, exposes_tool, consumes, hosts, routes_to, reads_data, writes_data, "
        "registered_consumer_of, governed_by, proposed_policy, registered_as, candidate_match.",
        "For 'what breaks if X changes' follow kg_edges backwards: rows whose target_iri is X, and for an MCP server also rows whose "
        "target_iri is a tool that X exposes (relation exposes_tool).",
        "Match names case-insensitively with lower(label) and LIKE; tables are labelled catalog.schema.table.",
        "kg_registry_matches lists Microsoft Agent 365 registry records: link = 'registered_as' means the record IS that hub asset "
        "(linked by a steward, or matched with confidence >= 0.85); 'candidate_match' is only a suggestion; NULL means no match.",
        "requests_30d, distinct_requesters_30d and cost_usd_30d cover the last 30 complete days; costs are estimates in USD.",
        "No person appears in this data except asset owners (the owners column); never guess who uses an asset, use the counts.",
        f"{base}_graph holds raw RDF triples (subject, predicate, object); objects starting with http are IRIs, everything else is a "
        "literal; prefer the kg_ views and use the triples only for facts the views do not show.",
    ]


def examples(s: str, base: str) -> list[tuple[str, str]]:
    """(question, SQL) pairs. ``s`` is the quoted catalog.schema prefix."""
    return [
        ("Which Microsoft Agent 365 packages map to which Genie agents?",
         f"SELECT package_label, m365_id, match_status, match_method, match_confidence, asset_label, asset_id\n"
         f"FROM {s}.kg_registry_matches\nWHERE link = 'registered_as' AND asset_subtype = 'Genie agent'\nORDER BY package_label"),
        ("Which Agent 365 records still need a steward decision?",
         f"SELECT package_label, m365_id, platform, match_status, match_confidence, asset_label AS suggested_asset\n"
         f"FROM {s}.kg_registry_matches\nWHERE match_status IN ('suggested', 'unmatched')\nORDER BY match_confidence DESC NULLS LAST, package_label"),
        ("What breaks if the Microsoft 365 MCP server changes?",
         f"WITH mcp AS (SELECT node_iri FROM {s}.kg_nodes WHERE node_type = 'MCP server' AND lower(label) = lower('Microsoft 365')),\n"
         f"tools AS (SELECT e.target_iri FROM {s}.kg_edges e JOIN mcp ON e.source_iri = mcp.node_iri WHERE e.relation = 'exposes_tool')\n"
         f"SELECT DISTINCT e.source_label AS dependent, e.source_type, e.relation, e.target_label AS through\n"
         f"FROM {s}.kg_edges e\nWHERE (e.target_iri IN (SELECT node_iri FROM mcp) AND e.relation IN ('uses_mcp', 'consumes', 'registered_consumer_of'))\n"
         f"   OR (e.target_iri IN (SELECT target_iri FROM tools) AND e.relation IN ('uses_tool', 'consumes'))\nORDER BY dependent"),
        ("Which agents use the python_exec tool and read tables in the system catalog?",
         f"SELECT DISTINCT t.source_label AS agent, t.target_label AS tool, r.target_label AS table_read\n"
         f"FROM {s}.kg_edges t JOIN {s}.kg_edges r ON r.source_iri = t.source_iri\n"
         f"WHERE t.relation = 'uses_tool' AND t.source_type = 'Agent' AND lower(t.target_label) LIKE '%python_exec%'\n"
         f"  AND r.relation = 'reads_data' AND r.target_label LIKE 'system.%'\nORDER BY agent, table_read"),
        ("Which tools does each MCP server expose?",
         f"SELECT source_label AS mcp_server, count(*) AS tools, array_join(slice(array_sort(collect_list(target_label)), 1, 10), ', ') AS first_tools\n"
         f"FROM {s}.kg_edges\nWHERE relation = 'exposes_tool'\nGROUP BY source_label\nORDER BY tools DESC\nLIMIT 25"),
        ("Which agents read the most Unity Catalog tables?",
         f"SELECT source_label AS agent, source_asset_id, count(DISTINCT target_iri) AS tables_read\n"
         f"FROM {s}.kg_edges\nWHERE relation = 'reads_data' AND source_type = 'Agent' AND target_type = 'Unity Catalog table'\n"
         f"GROUP BY source_label, source_asset_id\nORDER BY tables_read DESC\nLIMIT 20"),
        ("Which supervisors call which agents?",
         f"SELECT source_label AS supervisor, target_label AS sub_agent, target_type\n"
         f"FROM {s}.kg_edges\nWHERE relation = 'calls_agent'\nORDER BY supervisor, sub_agent"),
        ("What were the most used agents and MCP servers in the last 30 days, and what did they cost?",
         f"SELECT node_type, label, requests_30d, distinct_requesters_30d, cost_usd_30d, owners\n"
         f"FROM {s}.kg_nodes\nWHERE requests_30d IS NOT NULL\nORDER BY requests_30d DESC\nLIMIT 20"),
        ("Which high-risk agents have no active policy or guardrail?",
         f"SELECT n.label, n.node_subtype, n.asset_id, n.owners\nFROM {s}.kg_nodes n\n"
         f"WHERE n.node_type = 'Agent' AND n.risk_tier IN ('high', 'critical')\n"
         f"  AND NOT EXISTS (SELECT 1 FROM {s}.kg_edges e WHERE e.source_iri = n.node_iri AND e.relation = 'governed_by')\nORDER BY n.label"),
        ("List every fact the graph holds about the Genie agent with the most tables",
         f"WITH g AS (SELECT source_iri FROM {s}.kg_edges e JOIN {s}.kg_nodes n ON n.node_iri = e.source_iri\n"
         f"           WHERE e.relation = 'reads_data' AND n.node_subtype = 'Genie agent'\n"
         f"           GROUP BY source_iri ORDER BY count(*) DESC, source_iri LIMIT 1)\n"
         f"SELECT t.predicate, t.object\nFROM {s}.`{base}_graph` t JOIN g ON t.subject = g.source_iri\nORDER BY t.predicate, t.object"),
    ]


def definition(catalog: str, schema: str, version: int, warehouse_id: str | None) -> dict:
    from registry.kg_delta import Target

    t = Target(catalog, schema, version)
    s = f"`{catalog}`.`{schema}`"
    tables = sorted([f"{catalog}.{schema}.kg_nodes", f"{catalog}.{schema}.kg_edges", f"{catalog}.{schema}.kg_registry_matches",
                     t.name(f"{t.base}_graph")])
    ex = sorted(({"id": _id(q), "question": [q], "sql": [line + "\n" for line in sql.split("\n")]} for q, sql in examples(s, t.base)),
                key=lambda e: e["id"])
    space = {
        "version": 2,
        "config": {"sample_questions": sorted(({"id": _id("sample:" + q), "question": [q]} for q, _ in examples(s, t.base)[:5]),
                                              key=lambda x: x["id"])},
        "data_sources": {"tables": [{"identifier": x} for x in tables]},
        "instructions": {"text_instructions": [{"id": _id("instructions"), "content": [line + "\n" for line in instructions(t.base)]}],
                         "example_question_sqls": ex},
    }
    return {"title": TITLE, "description": DESCRIPTION, "warehouse_id": warehouse_id, "tables": tables, "serialized_space": space}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--target", required=True, help="catalog.schema of the knowledge graph export")
    ap.add_argument("--version", type=int, default=1, help="the <n> in triplestore_agent_registry_hub_V<n>")
    ap.add_argument("--warehouse-id", default=os.environ.get("WAREHOUSE_ID"))
    ap.add_argument("--profile", default=None, help="Databricks CLI profile (sets DATABRICKS_PROFILE)")
    ap.add_argument("--verify", action="store_true", help="run every example SQL on the warehouse (read-only SELECTs)")
    ap.add_argument("--create", action="store_true", help="create the space (POST /api/2.0/genie/spaces); needs --yes")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args(argv)
    if args.profile:
        os.environ["DATABRICKS_PROFILE"] = args.profile
    catalog, _, schema = args.target.partition(".")
    if not catalog or not schema or "." in schema:
        ap.error("--target must be catalog.schema")
    d = definition(catalog, schema, args.version, args.warehouse_id)
    out: dict = {"dry_run": not args.create, **d}
    if args.verify:
        from core import warehouse

        if not args.warehouse_id:
            ap.error("--verify needs --warehouse-id")
        checks = []
        for e in d["serialized_space"]["instructions"]["example_question_sqls"]:
            try:
                rows = warehouse.execute("".join(e["sql"]), warehouse_id=args.warehouse_id, max_wait_s=300)
                checks.append({"question": e["question"][0], "ok": True, "rows": len(rows)})
            except Exception as err:  # noqa: BLE001 - reported per question
                checks.append({"question": e["question"][0], "ok": False, "error": str(err)[:300]})
        out["verify"] = checks
    if args.create:
        if not (args.yes and args.warehouse_id):
            ap.error("--create needs --yes and --warehouse-id (review the dry run first)")
        from core.lakebase import workspace_client

        body = {"title": d["title"], "description": d["description"], "warehouse_id": args.warehouse_id,
                "serialized_space": json.dumps(d["serialized_space"])}
        out["created"] = workspace_client().api_client.do("POST", "/api/2.0/genie/spaces", body=body)
    print(json.dumps(out, indent=2))
    return 0 if all(c["ok"] for c in out.get("verify", [])) else 1


if __name__ == "__main__":
    raise SystemExit(main())
