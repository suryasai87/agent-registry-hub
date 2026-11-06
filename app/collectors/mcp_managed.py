"""Databricks managed MCP over Unity Catalog functions: ``mcp:uc:<catalog>.<schema>`` and ``tool:uc:<fqn>``.

* Discovery: ``system.information_schema.routines`` (every non-system catalog, plus ``system.ai``) joined to
  ``information_schema.schemata`` for the schema owner. One schema with functions = one managed MCP server.
  Only SQL function bodies are read (for lineage); for Python/external functions only a SHA-256 of the body
  is selected, so their source code (which can embed credentials) never leaves the warehouse.
* Input schemas: ``tools/list`` through ``POST /api/2.0/mcp/functions/<c>/<s>``, only for ``system.ai`` and the
  schemas whose functions supervisors use (at most 40 schemas, cached 24 h).
* Parameters: ``information_schema.parameters`` (required = no default), so every tool's signature is known
  even without ``tools/list``.
* Data lineage: the table names in FROM/JOIN positions of a SQL function body -> ``reads_data``
  ``table:<fqn>`` (edge kind ``data``, source ``routine_definition``). Three-part names are taken as written
  (``resolved: "qualified"``); one- and two-part names resolve against the function's own catalog/schema
  (``resolved: "function_schema"``). CTE names are skipped.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from collectors import upserts as up
from collectors.base import Collector
from collectors.util import clean_text, iso_to_dt, owner_id, purpose_from, short_hash, side_effect
from core import db
from registry import versioning

NAME = "mcp_managed"
TOOLS_LIST_CAP = 40
TOOLS_TTL = timedelta(hours=24)

ROUTINES_SQL = """
SELECT r.routine_catalog, r.routine_schema, r.routine_name, r.specific_name, r.routine_owner, r.data_type, r.full_data_type,
       r.routine_body, r.external_language, r.security_type, r.sql_data_access, r.is_deterministic, r.comment,
       CASE WHEN r.routine_body = 'SQL' THEN substr(r.routine_definition, 1, 20000) END AS routine_definition,
       sha2(coalesce(r.routine_definition, ''), 256) AS definition_sha, r.created, r.created_by, r.last_altered,
       s.schema_owner, s.comment AS schema_comment
  FROM system.information_schema.routines r
  LEFT JOIN system.information_schema.schemata s
    ON s.catalog_name = r.routine_catalog AND s.schema_name = r.routine_schema
 WHERE (r.routine_catalog <> 'system' AND NOT startswith(r.routine_catalog, '__databricks_internal'))
    OR (r.routine_catalog = 'system' AND r.routine_schema = 'ai')
"""
PARAMS_SQL = """
SELECT specific_catalog, specific_schema, specific_name, parameter_name, data_type, parameter_default,
       ordinal_position, comment
  FROM system.information_schema.parameters
 WHERE parameter_mode = 'IN'
   AND ((specific_catalog <> 'system' AND NOT startswith(specific_catalog, '__databricks_internal'))
        OR (specific_catalog = 'system' AND specific_schema = 'ai'))
"""

_IDENT = r"(?:`[^`]+`|[A-Za-z_][\w$-]*)"
FROM_JOIN = re.compile(rf"\b(?:FROM|JOIN)\s+({_IDENT}(?:\s*\.\s*{_IDENT}){{0,2}})(?![\w$`.-])(?!\s*[.(])", re.I)
CTE_NAME = re.compile(rf"(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)({_IDENT})\s+AS\s*\(", re.I)
SQL_KEYWORDS = {"select", "lateral", "values", "unnest", "explode", "table", "range", "read_files", "stream"}


def _unquote(part: str) -> str:
    return part.strip().strip("`")


def tables_in_sql(sql: str | None, catalog: str, schema: str) -> list[tuple[str, str]]:
    """[(fqn, resolution)] for the tables a SQL function body reads. resolution: qualified | function_schema."""
    if not sql:
        return []
    ctes = {_unquote(m.group(1)).lower() for m in CTE_NAME.finditer(sql)}
    out: dict[str, str] = {}
    for m in FROM_JOIN.finditer(sql):
        parts = [_unquote(p) for p in re.split(r"\s*\.\s*", m.group(1))]
        if parts[0].lower() in SQL_KEYWORDS:
            continue
        if len(parts) == 1:
            if parts[0].lower() in ctes:
                continue
            out.setdefault(f"{catalog}.{schema}.{parts[0]}".lower(), "function_schema")
        elif len(parts) == 2:
            out.setdefault(f"{catalog}.{parts[0]}.{parts[1]}".lower(), "function_schema")
        else:
            out.setdefault(".".join(parts).lower(), "qualified")
    return sorted(out.items())


def params_summary(plist: list[dict]) -> str | None:
    if not plist:
        return "No parameters."
    lines = []
    for x in plist:
        flag = "required" if x.get("parameter_default") is None else f"optional, default {x['parameter_default']}"
        desc = clean_text(x.get("comment"))
        lines.append(f"- {x.get('parameter_name')} ({x.get('data_type')}, {flag})" + (f": {desc}" if desc else ""))
    return "\n".join(lines)


def language_of(r: dict) -> str:
    return r.get("external_language") or ("SQL" if (r.get("routine_body") or "").upper() == "SQL" else (r.get("routine_body") or "unknown"))


class McpManagedCollector(Collector):
    name = NAME
    label = "Managed MCP over UC functions"

    def collect(self) -> None:
        ctx = self.ctx
        rows = ctx.sql(ROUTINES_SQL)
        params: dict[tuple, list[dict]] = {}
        for prm in ctx.sql(PARAMS_SQL):
            params.setdefault((prm["specific_catalog"], prm["specific_schema"], prm["specific_name"]), []).append(prm)
        for plist in params.values():
            plist.sort(key=lambda x: int(x.get("ordinal_position") or 0))
        self.params = params
        schemas: dict[str, dict] = {}
        for r in rows:
            key = f"{r['routine_catalog']}.{r['routine_schema']}"
            s = schemas.setdefault(key, {"catalog": r["routine_catalog"], "schema": r["routine_schema"],
                                         "owner": r.get("schema_owner"), "comment": r.get("schema_comment"), "functions": []})
            s["functions"].append(r)
        self.items_seen = len(rows) + len(schemas)
        self.detail.update(functions=len(rows), schemas=len(schemas))

        known = {r["asset_id"]: r["attributes"] or {} for r in
                 db.query("SELECT asset_id, attributes FROM asset WHERE asset_id LIKE %s", ("mcp:uc:%",))}
        referenced = {r["dst_id"].removeprefix("tool:uc:").rsplit(".", 1)[0] for r in db.query(
            "SELECT DISTINCT dst_id FROM lineage_edge WHERE source = 'supervisor_tools' AND dst_id LIKE %s", ("tool:uc:%",))}
        now = ctx.now()
        wanted = [k for k in ["system.ai", *sorted(referenced)] if k in schemas]
        wanted = list(dict.fromkeys(wanted))[:TOOLS_LIST_CAP]

        def fresh(key):
            at = (known.get(f"mcp:uc:{key}") or {}).get("tools_listed_at")
            try:
                return at and now - datetime.fromisoformat(at) < TOOLS_TTL
            except ValueError:
                return False

        to_list = [k for k in wanted if not fresh(k)]
        self.detail["tools_list_calls"] = len(to_list)
        listed: dict[str, list[dict]] = {}
        for key, res, err in ctx.pmap(lambda k: ctx.mcp_tools("/api/2.0/mcp/functions/" + k.replace(".", "/", 1))[1],
                                      to_list, workers=2):
            if err:
                self.warn(f"tools/list {key}", err)
            else:
                listed[key] = res

        with self.transaction() as cur:
            seen_servers, seen_tools = [], []
            for key, s in sorted(schemas.items()):
                sid = f"mcp:uc:{key}"
                with self.item(cur, sid):
                    tools_ok = self._schema(cur, sid, key, s, known.get(sid) or {}, listed.get(key), now)
                    seen_servers.append(sid)
                    seen_tools.extend(tools_ok)
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen_servers + seen_tools))

    def _schema(self, cur, sid: str, key: str, s: dict, prev: dict, listing: list[dict] | None, now: datetime) -> list[str]:
        ctx = self.ctx
        catalog, schema = s["catalog"], s["schema"]
        is_system = key == "system.ai"
        schemas_by_tool = {}
        if listing is not None:
            for t in listing:
                schemas_by_tool[t.get("name")] = t
        input_schemas = {**(prev.get("input_schemas") or {})}
        if listing is not None:
            input_schemas = {name: {"inputSchema": t.get("inputSchema"), "outputSchema": t.get("outputSchema")}
                             for name, t in schemas_by_tool.items() if name}
        attributes = {
            "mcp_path": f"/api/2.0/mcp/functions/{catalog}/{schema}", "function_count": len(s["functions"]),
            "tools_listed_at": now.isoformat() if listing is not None else prev.get("tools_listed_at"),
            "input_schemas": input_schemas or None,
        }
        self.changed(up.upsert_asset(cur, {
            "asset_id": sid, "asset_type": "mcp_server", "subtype": "managed_uc_functions", "name": key,
            "display_name": key, "source": "databricks", "platform": "unity_catalog",
            "publisher": "Databricks" if is_system else None, "parent_asset_id": None, "runtime_status": "running",
            "external_ref": {"catalog": catalog, "schema": schema},
            "attributes": {k: v for k, v in attributes.items() if v is not None},
            "deep_link": f"{ctx.host}/explore/data/{catalog}/{schema}", "sync_source": NAME,
        }))
        self.changed(up.upsert_fields(cur, sid, {
            "purpose": (purpose_from(s.get("comment")), "UC schema comment"),
            "description": (s.get("comment"), "UC schema comment"),
            "endpoint_url": (f"{ctx.host}/api/2.0/mcp/functions/{catalog}/{schema}", "Managed MCP (UC functions)"),
            "auth_model": ("Databricks OAuth as the calling user (EXECUTE on each function)", "Managed MCP (UC functions)"),
        }))
        if owner_id(s.get("owner")):
            self.changed(up.sync_owners(cur, sid, [owner_id(s["owner"])], collector=NAME))

        seen, digests = [], []
        for r in sorted(s["functions"], key=lambda r: r["routine_name"]):
            fqn = f"{catalog}.{schema}.{r['routine_name']}"
            tid = f"tool:uc:{fqn}"
            mcp_name = f"{catalog}__{schema}__{r['routine_name']}"
            io = input_schemas.get(mcp_name) or {}
            plist = self.params.get((catalog, schema, r.get("specific_name") or r["routine_name"]), [])
            required = [x["parameter_name"] for x in plist if x.get("parameter_default") is None and x.get("parameter_name")]
            signature = [[x.get("parameter_name"), x.get("data_type"), x.get("parameter_default") is not None] for x in plist]
            with self.item(cur, tid):
                self.changed(up.upsert_asset(cur, {
                    "asset_id": tid, "asset_type": "tool", "subtype": "uc_function", "name": fqn,
                    "display_name": r["routine_name"], "source": "databricks", "platform": "unity_catalog",
                    "publisher": "Databricks" if is_system else None, "parent_asset_id": sid, "runtime_status": "running",
                    "external_ref": {"function_full_name": fqn, "mcp_tool_name": mcp_name},
                    "attributes": {k: v for k, v in {
                        "routine_body": r.get("routine_body"), "data_type": r.get("data_type"),
                        "full_data_type": r.get("full_data_type"), "security_type": r.get("security_type"),
                        "sql_data_access": r.get("sql_data_access"), "language": language_of(r),
                        "is_deterministic": r.get("is_deterministic"), "mcp_tool_name": mcp_name,
                        "parameters": [{"name": x.get("parameter_name"), "type": x.get("data_type"),
                                        "required": x.get("parameter_default") is None,
                                        "comment": clean_text(x.get("comment"))} for x in plist] or None,
                        "inputSchema": io.get("inputSchema"), "outputSchema": io.get("outputSchema"),
                        "side_effect": side_effect({"routine_body": r.get("routine_body")}, uc_function=True,
                                                   sql_data_access=r.get("sql_data_access")),
                    }.items() if v is not None},
                    "deep_link": f"{ctx.host}/explore/data/functions/{catalog}/{schema}/{r['routine_name']}",
                    "sync_source": NAME, "created_by": owner_id(r.get("created_by")),
                    "source_created_at": iso_to_dt(r.get("created")), "source_updated_at": iso_to_dt(r.get("last_altered")),
                }))
                fields = {"purpose": (purpose_from(r.get("comment")), "UC function comment"),
                          "description": (r.get("comment"), "UC function comment")}
                fields["inputs"] = (params_summary(plist), "UC function parameters")
                if r.get("full_data_type"):
                    fields["outputs"] = (f"Returns {r.get('data_type')}: {r['full_data_type']}"[:2000], "UC function return type")
                self.changed(up.upsert_fields(cur, tid, fields))
                if owner_id(r.get("routine_owner")):
                    self.changed(up.sync_owners(cur, tid, [owner_id(r["routine_owner"])], collector=NAME))
                self.changed(up.edge(cur, sid, tid, "exposes_tool", "declared", "information_schema"))
                if (r.get("routine_body") or "").upper() == "SQL":
                    for table, resolution in tables_in_sql(r.get("routine_definition"), catalog, schema):
                        if table == fqn.lower():
                            continue
                        self.changed(up.edge(cur, tid, f"table:{table}", "reads_data", "data", "routine_definition",
                                             attributes={"resolved": resolution}))
                self.changed(up.prune_edges(cur, source="routine_definition", seen_at=self.seen_at, src_ids=[tid]))
                digests.append({"name": mcp_name, "required": sorted(required),
                                "schema_hash": short_hash([signature, r.get("full_data_type")])})
                if versioning.record_snapshot(cur, tid, {
                    "tools": [{"name": mcp_name, "required": sorted(required), "schema_hash": short_hash(signature)}],
                    "signature_hash": short_hash([r.get("full_data_type"), r.get("data_type"), r.get("security_type")]),
                    "definition_hash": (r.get("definition_sha") or "")[:16] or None,
                    "description_hash": short_hash(clean_text(r.get("comment"))),
                }):
                    self.count("change_events")
                seen.append(tid)
        self.changed(up.prune_edges(cur, source="information_schema", seen_at=self.seen_at, src_ids=[sid]))
        if versioning.record_snapshot(cur, sid, {"tools": digests}):
            self.count("change_events")
        return seen
