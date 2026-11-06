"""Unity Gateway MCP services: Databricks system MCPs ``mcp:system:<fqn>`` and registered UC MCP services
``mcp:service:<fqn>``, with their observed tools.

Sources (read-only):
* ``system.ai_gateway.usage`` (``service_type = 'MCP_SERVICE'``, this workspace, last 90 days): which MCP
  services are called, their server type and the tools seen in ``mcp_metadata.tool_name``.
* ``GET /api/2.1/unity-catalog/mcp-services?parent=schemas/<c>.<s>&view=FULL`` (GA; ``parent`` is required, so
  the schemas are crawled: ``system.ai`` first, then the schemas of observed 3-part names, skill schemas, known
  MCP-service schemas and the most recently altered schemas from ``information_schema.schemata`` up to a cap).
  It gives the owner, comment, ``config.include_tool_selectors`` (tool selection), ``config.rate_limits`` and
  the source connection. 403/404 per schema are tolerated.
* ``effective-permissions/mcp_service/<fqn>`` for grants.

The curated ``KNOWN_SYSTEM_MCP`` catalog supplies the general facts the platform does not return in a
structured form (publisher, a one-line purpose, the auth model). Descriptions come from the service's own UC
comment when the API lists it.
"""
from __future__ import annotations

import os

from collectors import upserts as up
from collectors.base import ApiError, Collector
from collectors.util import (clean_text, host_of, iso_to_dt, owner_id, publisher_for_host, purpose_from, short_hash,
                             to_date, uc_grant_rows)
from collectors.skills import skill_schemas_from_env
from core import db
from registry import versioning

NAME = "mcp_system"
CATALOG_LABEL = "Registry catalog of Databricks system MCP servers"
COMMENT_LABEL = "UC MCP service comment"
PER_USER = "per-user OAuth (on-behalf-of)"
DATABRICKS_AUTH = "Databricks OAuth as the calling user (ai-gateway scope; EXECUTE on the MCP service)"
SCHEMA_CRAWL_CAP = int(os.environ.get("MCP_SERVICE_SCHEMA_CAP", "300"))

KNOWN_SYSTEM_MCP: dict[str, dict] = {
    "microsoft_365": {"title": "Microsoft 365", "publisher": "Microsoft", "auth": PER_USER,
                      "purpose": "Microsoft 365 (SharePoint, Outlook and Teams) through the Microsoft Graph API.",
                      "description": "Databricks-provided MCP service that connects to SharePoint, Outlook and Teams "
                                     "through the third-party Microsoft Graph API. Each user signs in with their own account."},
    "google_drive": {"title": "Google Drive", "publisher": "Google", "auth": PER_USER,
                     "purpose": "Google Drive, Docs, Sheets and Slides.",
                     "description": "Databricks-provided MCP service that connects to the third-party Google Drive, "
                                    "Docs, Sheets and Slides APIs. Each user signs in with their own account."},
    "gmail": {"title": "Gmail", "publisher": "Google", "auth": PER_USER, "purpose": "Gmail mailboxes.",
              "description": "Databricks-provided MCP service that connects to the third-party Gmail API. "
                             "Each user signs in with their own account."},
    "google_calendar": {"title": "Google Calendar", "publisher": "Google", "auth": PER_USER, "purpose": "Google Calendar.",
                        "description": "Databricks-provided MCP service that connects to the third-party Google Calendar "
                                       "API. Each user signs in with their own account."},
    "slack": {"title": "Slack", "publisher": "Slack (Salesforce)", "auth": PER_USER,
              "purpose": "Slack workspaces through the Slack MCP server.",
              "description": "Databricks-provided MCP service that connects to the third-party Slack MCP server. "
                             "Each user signs in with their own account."},
    "atlassian": {"title": "Atlassian (Jira and Confluence)", "publisher": "Atlassian", "auth": PER_USER,
                  "purpose": "Jira and Confluence through the Atlassian Rovo MCP server.",
                  "description": "Databricks-provided MCP service that connects to Jira and Confluence through the "
                                 "third-party Atlassian Rovo MCP server. Each user signs in with their own account."},
    "github": {"title": "GitHub", "publisher": "GitHub", "auth": PER_USER,
               "purpose": "GitHub through the GitHub MCP server.",
               "description": "Databricks-provided MCP service that connects to the third-party GitHub MCP server. "
                              "Each user signs in with their own account."},
    "web_search": {"title": "Web search", "publisher": "Databricks", "auth": DATABRICKS_AUTH,
                   "purpose": "Search the public web.", "description": "Databricks-provided MCP service for public web search."},
    "genie_one_mcp": {"title": "Genie One", "publisher": "Databricks", "auth": DATABRICKS_AUTH,
                      "purpose": "Structured and unstructured Databricks data through Genie One.",
                      "description": "Databricks-provided MCP service that retrieves structured and unstructured data "
                                     "from Databricks with Genie One."},
    "dbsql": {"title": "Databricks SQL", "publisher": "Databricks", "auth": DATABRICKS_AUTH,
              "purpose": "Run SQL on a Databricks SQL warehouse.",
              "description": "Databricks-provided MCP service that runs SQL queries on a Databricks SQL warehouse with "
                             "the caller's Unity Catalog and warehouse permissions."},
    "sandbox": {"title": "Databricks Sandbox", "publisher": "Databricks", "auth": DATABRICKS_AUTH,
                "purpose": "Run Python, SQL or shell code in an isolated environment.",
                "description": "Databricks-provided MCP service that runs code in an isolated environment."},
}

USAGE_SQL = """
SELECT service_name, mcp_metadata.server_type AS server_type, coalesce(mcp_metadata.tool_name, '') AS tool_name,
       count(*) AS calls, min(event_time) AS first_seen, max(event_time) AS last_seen
  FROM system.ai_gateway.usage
 WHERE workspace_id = ? AND event_time >= current_timestamp() - INTERVAL 90 DAYS
   AND service_type = 'MCP_SERVICE' AND service_name IS NOT NULL
 GROUP BY ALL
"""
SCHEMATA_SQL = """
SELECT catalog_name, schema_name FROM system.information_schema.schemata
 WHERE catalog_name <> 'system' AND NOT startswith(catalog_name, '__databricks_internal')
   AND schema_name <> 'information_schema'
 ORDER BY last_altered DESC
 LIMIT {limit}
"""
SECURABLE_AUTH = {
    "CONNECTION_HTTP_OAUTH_U2M_MAPPING": PER_USER, "CONNECTION_HTTP_OAUTH_U2M": PER_USER,
    "CONNECTION_HTTP_OAUTH_M2M": "OAuth machine-to-machine (shared service credential)",
    "CONNECTION_HTTP_BEARER": "Bearer token (one shared credential stored in the connection)",
}


def urn_for(fqn: str, server_type: str | None = None) -> str:
    return f"mcp:system:{fqn}" if fqn.startswith("system.ai.") or server_type == "SYSTEM" else f"mcp:service:{fqn}"


def connection_summary(cfg: dict) -> dict | None:
    sc = (cfg or {}).get("source_connection") or {}
    if not sc:
        return None
    return {k: sc.get(k) for k in ("name", "status", "is_deleted", "url", "connection_type", "securable_kind") if sc.get(k) is not None}


class McpSystemCollector(Collector):
    name = NAME
    label = "Unity Gateway MCP services (system + registered)"

    def collect(self) -> None:
        ctx = self.ctx
        usage = ctx.sql(USAGE_SQL, [ctx.workspace_id])
        observed: dict[str, dict] = {}
        for r in usage:
            fqn = r["service_name"]
            o = observed.setdefault(fqn, {"server_type": r.get("server_type"), "tools": set(), "calls": 0,
                                          "first_seen": r.get("first_seen"), "last_seen": r.get("last_seen")})
            o["calls"] += int(r.get("calls") or 0)
            if r.get("tool_name"):
                o["tools"].add(r["tool_name"])
            o["first_seen"] = min(filter(None, [o["first_seen"], r.get("first_seen")]), default=None)
            o["last_seen"] = max(filter(None, [o["last_seen"], r.get("last_seen")]), default=None)
            o["server_type"] = o["server_type"] or r.get("server_type")

        services = self._crawl(observed)
        names = sorted(set(observed) | set(services))
        self.items_seen = len(names)
        self.detail.update(observed_services=len(observed), uc_listed_services=len(services))

        grants: dict[str, list[dict]] = {}
        for fqn, res, err in ctx.pmap(lambda f: ctx.api("GET", f"/api/2.1/unity-catalog/effective-permissions/mcp_service/{f}"),
                                      sorted(services)):
            if err:
                self.soft_fail("grants", f"grants {fqn}", err)
            else:
                grants[fqn] = uc_grant_rows(res)

        with self.transaction() as cur:
            connections = set(up.existing_assets(cur, "mcp:connection:"))
            seen = []
            for fqn in names:
                obs = observed.get(fqn) or {}
                aid = urn_for(fqn, obs.get("server_type"))
                with self.item(cur, aid):
                    seen.extend(self._write(cur, aid, fqn, obs, services.get(fqn), grants.get(fqn), connections))
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen))

    # ------------------------------------------------------------------ the schema crawl
    def _crawl(self, observed: dict) -> dict[str, dict]:
        ctx = self.ctx
        order: list[str] = ["system.ai"]
        order += sorted({f.rsplit(".", 1)[0] for f in observed if f.count(".") == 2})
        order += skill_schemas_from_env()
        order += [r["s"] for r in db.query(
            "SELECT DISTINCT split_part(name, '.', 1) || '.' || split_part(name, '.', 2) AS s FROM asset "
            "WHERE asset_id LIKE %s OR asset_id LIKE %s", ("mcp:service:%", "skill:uc:%"))]
        try:
            order += [f"{r['catalog_name']}.{r['schema_name']}" for r in ctx.sql(SCHEMATA_SQL.format(limit=int(SCHEMA_CRAWL_CAP)))]
        except Exception as e:  # noqa: BLE001 - the known schemas are still crawled
            self.warn("information_schema.schemata", e)
        order = list(dict.fromkeys(s for s in order if s and s.count(".") == 1))[:SCHEMA_CRAWL_CAP + 50]
        self.detail["schemas_crawled"] = len(order)
        out: dict[str, dict] = {}
        forbidden = 0
        for schema, res, err in ctx.pmap(lambda s: ctx.paginate("/api/2.1/unity-catalog/mcp-services", "mcp_services",
                                                                 {"parent": f"schemas/{s}", "view": "FULL"}, page_size=200),
                                         order):
            if err:
                if isinstance(err, ApiError) and err.status in (403, 404):
                    forbidden += 1
                else:
                    self.warn(f"mcp-services {schema}", err)
                continue
            for svc in res or []:
                fqn = (svc.get("name") or "").removeprefix("mcp-services/")
                if fqn.count(".") == 2:
                    out[fqn] = svc
        self.detail["schemas_not_readable"] = forbidden
        return out

    # ------------------------------------------------------------------ one service
    def _write(self, cur, aid: str, fqn: str, obs: dict, svc: dict | None, grants: list[dict] | None,
               connections: set[str]) -> list[str]:
        ctx = self.ctx
        catalog, schema, short = fqn.split(".", 2) if fqn.count(".") == 2 else (None, None, fqn)
        is_system = aid.startswith("mcp:system:")
        known = KNOWN_SYSTEM_MCP.get(short) if is_system else None
        cfg = (svc or {}).get("config") or {}
        conn = connection_summary(cfg)
        publisher = (known or {}).get("publisher") or ("Databricks" if is_system else
                                                      publisher_for_host(host_of((conn or {}).get("url"))) if conn else None)
        runtime = "unknown"
        if svc is not None:
            runtime = "degraded" if conn and (conn.get("is_deleted") or conn.get("status") not in (None, "ACTIVE")) else "running"
        elif obs:
            runtime = "running"
        selectors = cfg.get("include_tool_selectors")
        rate_limits = cfg.get("rate_limits") or []
        attributes = {
            "server_type": obs.get("server_type") or ("SYSTEM" if is_system else "EXTERNAL"),
            "uc_listed": svc is not None, "effective_owner": (svc or {}).get("effective_owner"),
            "include_tool_selectors": selectors, "rate_limits": rate_limits or None, "source_connection": conn,
            "internal": "internal" in cfg or None, "mcp_url": f"/ai-gateway/mcp-services/{fqn}",
            "observed_tools": sorted(obs.get("tools") or []) or None,
            "first_seen": to_date(obs.get("first_seen")), "last_seen_date": to_date(obs.get("last_seen")),
            "id": (svc or {}).get("id"), "etag": (svc or {}).get("etag"),
        }
        self.changed(up.upsert_asset(cur, {
            "asset_id": aid, "asset_type": "mcp_server", "subtype": "system_mcp" if is_system else "uc_mcp_service",
            "name": fqn, "display_name": (known or {}).get("title") or fqn,
            "source": "databricks" if is_system else "external",
            "platform": "databricks_system_mcp" if is_system else "unity_catalog", "publisher": publisher,
            "parent_asset_id": None, "runtime_status": runtime,
            "external_ref": {"service_name": fqn, "service_id": (svc or {}).get("id")},
            "attributes": {k: v for k, v in attributes.items() if v is not None},
            "deep_link": f"{ctx.host}/explore/data/{catalog}/{schema}" if catalog else None, "sync_source": NAME,
            "created_by": owner_id((svc or {}).get("created_by")),
            "source_created_at": iso_to_dt((svc or {}).get("create_time")),
            "source_updated_at": iso_to_dt((svc or {}).get("update_time")),
        }))
        comment = clean_text((svc or {}).get("comment"))
        if known:
            purpose = (known["purpose"], CATALOG_LABEL)
            description = (comment, COMMENT_LABEL) if comment else (known["description"], CATALOG_LABEL)
            auth = (known["auth"], CATALOG_LABEL)
        else:
            purpose = (purpose_from(comment), COMMENT_LABEL)
            description = (comment, COMMENT_LABEL)
            kind = (conn or {}).get("securable_kind")
            auth = (f"{DATABRICKS_AUTH}; upstream: {SECURABLE_AUTH[kind]}" if kind in SECURABLE_AUTH else DATABRICKS_AUTH,
                    "UC MCP service source connection")
        self.changed(up.upsert_fields(cur, aid, {
            "purpose": purpose, "description": description, "auth_model": auth,
            "endpoint_url": (f"{ctx.host}/ai-gateway/mcp-services/{fqn}", "Unity Gateway MCP service URL"),
            "publisher_info": (publisher, CATALOG_LABEL if known else "UC MCP service source connection"),
        }))
        owner = owner_id((svc or {}).get("effective_owner"))
        if svc is not None:
            self.changed(up.sync_owners(cur, aid, [owner] if owner else [], collector=NAME))
        if grants is not None:
            self.changed(up.sync_grants(cur, aid, grants, seen_at=self.seen_at))

        policies = []
        for i, rl in enumerate(sorted(rate_limits, key=lambda r: str(sorted(r.items())))):
            pid = f"ugw:{fqn}:rate_limit:{i + 1}"
            what = f"{rl.get('requests') or rl.get('tokens')} {'requests' if rl.get('requests') else 'tokens'}/" \
                   f"{str(rl.get('renewal_period') or '').lower()} per {str(rl.get('key') or '').replace('RATE_LIMIT_KEY_', '').lower()}"
            policies.append({"policy_id": pid, "name": f"Rate limit: {what}", "kind": "rate_limit", "provider": "unity_gateway",
                             "phase": "input", "action": "limit", "config": rl,
                             "description": f"Unity Gateway MCP service rate limit on tools/call ({what})."})
        for p in policies:
            self.changed(up.upsert_policy(cur, p))
            self.changed(up.bind_policy(cur, p["policy_id"], aid))
        if svc is not None:
            self.changed(up.prune_policies(cur, f"ugw:{fqn}:rate_limit:", [p["policy_id"] for p in policies]))

        if conn and conn.get("name"):
            target = f"mcp:connection:{conn['name'].removeprefix('connections/')}"
            if target in connections:
                self.changed(up.edge(cur, aid, target, "routes_to", "declared", "mcp_service_config"))
        self.changed(up.prune_edges(cur, source="mcp_service_config", seen_at=self.seen_at, src_ids=[aid]))

        seen = [aid]
        server_tool_prefix = aid.replace("mcp:", "tool:mcp:", 1)
        for tool in sorted(obs.get("tools") or []):
            tid = f"{server_tool_prefix}/{tool}"
            with self.item(cur, tid):
                self.changed(up.upsert_asset(cur, {
                    "asset_id": tid, "asset_type": "tool", "subtype": "mcp_tool", "name": tool, "display_name": tool,
                    "source": "databricks" if is_system else "external",
                    "platform": "databricks_system_mcp" if is_system else "unity_catalog", "publisher": publisher,
                    "parent_asset_id": aid, "runtime_status": "unknown",
                    "external_ref": {"service_name": fqn, "tool_name": tool},
                    "attributes": {"observed": True, "side_effect": "unknown"}, "deep_link": None, "sync_source": NAME,
                }))
                self.changed(up.edge(cur, aid, tid, "exposes_tool", "observed", "gateway_usage"))
                seen.append(tid)
        # Only a UC-listed service has a known configuration; an observed-only one (or one whose schema could not be
        # read this run) is not versioned, so a crawl gap never looks like a configuration change.
        if svc is not None and versioning.record_snapshot(cur, aid, {
            "tool_selectors": selectors, "endpoint_url": f"/ai-gateway/mcp-services/{fqn}",
            "auth": (conn or {}).get("securable_kind") or "databricks", "description_hash": short_hash(comment),
            "policies": sorted(f"{p['policy_id']}#{short_hash(p['config'])}" for p in policies),
            "source_connection": (conn or {}).get("name"),
        }):
            self.count("change_events")
        return seen
