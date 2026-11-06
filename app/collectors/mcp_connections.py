"""External and custom MCP servers behind UC HTTP connections: ``mcp:connection:<name>`` and their tools
``tool:mcp:connection:<name>/<tool>``.

* Discovery: ``GET /api/2.1/unity-catalog/connections`` (paginated, metastore-wide). MCP = ``connection_type
  HTTP`` and ``options.is_mcp_connection == "true"`` (a string), or the flag absent and the name or base path
  mentions ``mcp``.
* Subtype: ``custom_app`` (host ``*.databricksapps.com``, plus a ``hosts`` edge from ``app:<name>``),
  ``databricks_workspace`` (``/api/2.0/mcp`` paths), else ``external_connection``.
* Grants: ``effective-permissions/connection/{name}``.
* Tools: ``initialize`` + ``tools/list`` through ``POST /api/2.0/mcp/external/<name>`` ONLY when the caller holds
  USE_CONNECTION (otherwise ``attributes.tools_status = "access_required"``). These calls reach third-party
  servers, so they run at most every 24 h per connection (whatever the outcome) and at most two at a time.
  The ``Mcp-Session-Id`` from ``initialize`` is echoed on ``tools/list``. Failures describe the server, not the
  sync: ``user_auth_required`` (per-user OAuth not signed in), ``credential_error`` (the connection's credential
  is rejected), ``protocol_error`` or ``error``, with ``attributes.tools_error``.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from collectors import upserts as up
from collectors.base import ApiError, Collector
from collectors.util import (clean_text, databricks_app_name, host_of, owner_id, publisher_for_host, purpose_from,
                             schema_summary, short_hash, side_effect, tool_digest, uc_grant_rows)
from core import db
from registry import versioning

NAME = "mcp_connections"
TOOLS_TTL = timedelta(hours=24)
MCP_CONCURRENCY = 2
AUTH_MODELS = {
    "BEARER_TOKEN": "Bearer token (one shared credential stored in the connection)",
    "OAUTH_M2M": "OAuth machine-to-machine (shared service credential)",
    "OAUTH_U2M_MAPPING": "per-user OAuth (U2M, on-behalf-of each user)",
    "OAUTH_U2M": "per-user OAuth (U2M, on-behalf-of each user)",
}
USE_PRIVILEGES = ("USE_CONNECTION", "ALL_PRIVILEGES")
CALLER_GROUPS = ("account users", "users")


def is_mcp_connection(c: dict) -> bool:
    if c.get("connection_type") != "HTTP":
        return False
    flag = (c.get("options") or {}).get("is_mcp_connection")
    if flag is not None:
        return str(flag).lower() == "true"
    base_path = str((c.get("options") or {}).get("base_path") or "")
    return "mcp" in str(c.get("name") or "").lower() or "mcp" in base_path.lower()


def subtype_of(c: dict) -> str:
    opts = c.get("options") or {}
    host = host_of(opts.get("host") or c.get("url"))
    if host.endswith(".databricksapps.com"):
        return "custom_app"
    if str(opts.get("base_path") or "").startswith("/api/2.0/mcp"):
        return "databricks_workspace"
    return "external_connection"


def caller_can_use(c: dict, grants: list[dict], me: dict) -> bool:
    who = {(me.get("user_name") or "").lower(), *CALLER_GROUPS, *(g.lower() for g in me.get("groups") or [])}
    if (owner_id(c.get("owner")) or "").lower() in who:
        return True
    return any(g["privilege"] in USE_PRIVILEGES and g["principal"].lower() in who for g in grants)


def _checked_recently(prev: dict, now: datetime) -> bool:
    """tools/list reaches third-party servers: at most one attempt per connection per TTL, whatever the outcome."""
    at = prev.get("tools_checked_at") or prev.get("tools_listed_at")
    if not at or prev.get("tools_status") in (None, "unknown", "access_required"):
        return False
    try:
        checked = datetime.fromisoformat(str(at))
    except ValueError:
        return False
    return now - checked < TOOLS_TTL


def tools_failure(err: BaseException) -> tuple[str, str]:
    """Classify a failed initialize/tools-list call -> (tools_status, short message). These describe the remote
    server or its credential, not a sync failure."""
    message = err.message if isinstance(err, ApiError) else str(err)
    message = message.split(" Config: ", 1)[0].split("Config: host=", 1)[0].strip()
    low = message.lower()
    status = err.status if isinstance(err, ApiError) else None
    if status == 403 or "missing use connection" in low:
        kind = "access_required"
    elif "credential for user identity" in low or ("unauthenticated" in low and "user" in low):
        kind = "user_auth_required"
    elif status in (400, 401) and any(w in low for w in ("token", "oauth", "credential", "identity provider")):
        kind = "credential_error"
    elif "session" in low:
        kind = "protocol_error"
    else:
        kind = "error"
    return kind, message[:300]


class McpConnectionsCollector(Collector):
    name = NAME
    label = "MCP servers on UC connections"

    def collect(self) -> None:
        ctx = self.ctx
        conns = ctx.paginate("/api/2.1/unity-catalog/connections", "connections", page_size_param="max_results",
                             page_size=100)
        unique = {c["name"]: c for c in conns if c.get("name")}  # pages can repeat entries; one row per name
        mcps = [c for c in unique.values() if is_mcp_connection(c)]
        self.detail["connections_unique"] = len(unique)
        self.items_seen = len(mcps)
        self.detail.update(connections_listed=len(conns), mcp_connections=len(mcps))
        known = {r["asset_id"]: r["attributes"] or {} for r in
                 db.query("SELECT asset_id, attributes FROM asset WHERE asset_id LIKE %s", ("mcp:connection:%",))}

        grants: dict[str, list[dict]] = {}
        for c, res, err in ctx.pmap(lambda c: ctx.api("GET", f"/api/2.1/unity-catalog/effective-permissions/connection/{c['name']}"), mcps):
            if err:
                self.soft_fail("grants", f"grants {c['name']}", err)
            else:
                grants[c["name"]] = uc_grant_rows(res)

        now = ctx.now()
        me = ctx.me
        to_list, status = [], {}
        for c in mcps:
            prev = known.get(f"mcp:connection:{c['name']}") or {}
            if c["name"] not in grants:
                status[c["name"]] = prev.get("tools_status") or "unknown"
            elif not caller_can_use(c, grants[c["name"]], me):
                status[c["name"]] = "access_required"
            elif _checked_recently(prev, now):
                status[c["name"]] = prev.get("tools_status")
                self.count("tools_list_cached")
            else:
                to_list.append(c)
        self.detail["tools_list_calls"] = len(to_list)
        listed: dict[str, tuple[dict, list[dict]]] = {}
        failures: dict[str, str] = {}
        for c, res, err in ctx.pmap(lambda c: ctx.mcp_tools(f"/api/2.0/mcp/external/{c['name']}"), to_list,
                                    workers=MCP_CONCURRENCY):
            if err:
                if not isinstance(err, ApiError):
                    self.warn(f"tools/list {c['name']}", err)
                status[c["name"]], failures[c["name"]] = tools_failure(err)
                self.count(f"tools_list_{status[c['name']]}")
            else:
                status[c["name"]] = "listed"
                listed[c["name"]] = res
        attempted = {c["name"] for c in to_list}

        with self.transaction() as cur:
            seen = []
            for c in mcps:
                aid = f"mcp:connection:{c['name']}"
                with self.item(cur, aid):
                    self._write(cur, aid, c, known.get(aid) or {}, grants.get(c["name"]), status[c["name"]],
                                listed.get(c["name"]), now, attempted=c["name"] in attempted,
                                failure=failures.get(c["name"]))
                    seen.append(aid)
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen, asset_type="mcp_server"))

    def _write(self, cur, aid: str, c: dict, prev: dict, grants: list[dict] | None, tools_status: str,
               listing: tuple[dict, list[dict]] | None, now: datetime, *, attempted: bool = False,
               failure: str | None = None) -> None:
        ctx = self.ctx
        name = c["name"]
        opts = c.get("options") or {}
        host = host_of(opts.get("host") or c.get("url"))
        subtype = subtype_of(c)
        app_name = databricks_app_name(host, ctx.workspace_id) if subtype == "custom_app" else None
        publisher = None if subtype == "custom_app" else "Databricks" if subtype == "databricks_workspace" else publisher_for_host(host)
        cred = c.get("credential_type") or ""
        state = (c.get("provisioning_info") or {}).get("state")
        runtime = {"ACTIVE": "running", "FAILED": "degraded"}.get(state or "", "unknown")

        if listing is not None:
            init, tools = listing
            server_info = init.get("serverInfo") or {}
            instructions = clean_text(init.get("instructions"))
            digests = sorted((tool_digest(t) for t in tools if t.get("name")), key=lambda d: d["name"])
            listed_at = now.isoformat()
        else:
            tools = None
            server_info, instructions = prev.get("server_info") or {}, prev.get("instructions")
            digests, listed_at = prev.get("tools_digest"), prev.get("tools_listed_at")
        attributes = {
            "connection_type": c.get("connection_type"), "credential_type": cred, "securable_kind": c.get("securable_kind"),
            "host": host, "base_path": opts.get("base_path"), "port": opts.get("port"), "url": c.get("url"),
            "is_mcp_connection": opts.get("is_mcp_connection"), "mcp_resource": opts.get("mcp_resource"),
            "oauth_scope": opts.get("oauth_scope"), "read_only": c.get("read_only"), "provisioning_state": state,
            "connection_id": c.get("connection_id"), "hosting_app": app_name,
            "mcp_path": f"/api/2.0/mcp/external/{name}",
            "tools_status": tools_status, "tools_listed_at": listed_at,
            "tools_checked_at": now.isoformat() if attempted else prev.get("tools_checked_at"),
            "tools_error": failure if attempted else (prev.get("tools_error") if tools_status == prev.get("tools_status") else None),
            "tools_digest": digests, "tool_count": len(digests) if digests is not None else None,
            "server_info": server_info or None, "instructions": instructions,
        }
        self.changed(up.upsert_asset(cur, {
            "asset_id": aid, "asset_type": "mcp_server", "subtype": subtype, "name": name, "display_name": name,
            "source": {"custom_app": "custom", "databricks_workspace": "databricks"}.get(subtype, "external"),
            "platform": "databricks_apps" if subtype == "custom_app" else "unity_catalog", "publisher": publisher,
            "parent_asset_id": None, "runtime_status": runtime,
            "external_ref": {"connection_name": name, "connection_id": c.get("connection_id"), "url": c.get("url")},
            "attributes": {k: v for k, v in attributes.items() if v is not None},
            "deep_link": f"{ctx.host}/explore/connections/{name}", "sync_source": NAME,
            "created_by": owner_id(c.get("created_by")),
            "source_created_at": _ms(c.get("created_at")), "source_updated_at": _ms(c.get("updated_at")),
        }, keep_attributes=("hosting_app_status",)))
        description = clean_text(c.get("comment"))
        desc_label = "UC connection comment"
        if not description and instructions:
            description, desc_label = instructions, "MCP initialize.instructions"
        self.changed(up.upsert_fields(cur, aid, {
            "purpose": (purpose_from(description), desc_label),
            "description": (description, desc_label),
            "endpoint_url": (c.get("url"), "UC connection URL"),
            "auth_model": (AUTH_MODELS.get(cred, cred.replace("_", " ").lower() or None), "UC connection credential type"),
            "publisher_info": (f"{publisher} ({host})" if publisher else (f"Databricks App {app_name}" if app_name else host),
                               "UC connection host"),
        }))
        self.changed(up.sync_owners(cur, aid, [owner_id(c.get("owner"))], collector=NAME))
        if grants is not None:
            self.changed(up.sync_grants(cur, aid, grants, seen_at=self.seen_at))
        if app_name:
            self.changed(up.edge(cur, f"app:{app_name}", aid, "hosts", "declared", "app_hosting",
                                 attributes={"host": host, "derived_from": "connection_host"}))
        self.changed(up.prune_edges(cur, source="app_hosting", seen_at=self.seen_at, dst_ids=[aid]))

        if tools is not None:
            self._tools(cur, aid, name, subtype, publisher, tools)
        if versioning.record_snapshot(cur, aid, {
            "endpoint_url": c.get("url"),
            "auth": cred,
            "description_hash": short_hash(clean_text(c.get("comment"))),
        }, section="connection"):
            self.count("change_events")
        # Tools are versioned in their own section: the first successful listing (e.g. once access is granted) is
        # folded in silently; later differences are real tool changes.
        if digests is not None and versioning.record_snapshot(cur, aid, {"tools": digests}, section="tools"):
            self.count("change_events")

    def _tools(self, cur, server_id: str, name: str, subtype: str, publisher: str | None, tools: list[dict]) -> None:
        seen = []
        for t in tools:
            tname = t.get("name")
            if not tname:
                continue
            tid = f"tool:mcp:connection:{name}/{tname}"
            ann = t.get("annotations") or {}
            uc_fn = "routine_body" in ann or "catalog" in ann
            with self.item(cur, tid):
                self.changed(up.upsert_asset(cur, {
                    "asset_id": tid, "asset_type": "tool", "subtype": "mcp_tool", "name": tname,
                    "display_name": clean_text(t.get("title")) or tname,
                    "source": {"custom_app": "custom", "databricks_workspace": "databricks"}.get(subtype, "external"),
                    "platform": "databricks_apps" if subtype == "custom_app" else "unity_catalog",
                    "publisher": publisher, "parent_asset_id": server_id, "runtime_status": "unknown",
                    "external_ref": {"connection_name": name, "tool_name": tname},
                    "attributes": {k: v for k, v in {
                        "title": t.get("title"), "inputSchema": t.get("inputSchema"), "outputSchema": t.get("outputSchema"),
                        "annotations": ann or None, "side_effect": side_effect(ann, uc_function=uc_fn),
                    }.items() if v is not None},
                    "deep_link": None, "sync_source": NAME,
                }))
                self.changed(up.upsert_fields(cur, tid, {
                    "purpose": (purpose_from(t.get("description")), "MCP tools/list"),
                    "description": (t.get("description"), "MCP tools/list"),
                    "inputs": (schema_summary(t.get("inputSchema")), "MCP tools/list inputSchema"),
                }))
                self.changed(up.edge(cur, server_id, tid, "exposes_tool", "declared", "tools_list"))
                seen.append(tid)
        self.changed(up.prune_edges(cur, source="tools_list", seen_at=self.seen_at, src_ids=[server_id]))
        self.count("tools", len(seen))
        self.count("tools_marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen, asset_type="tool",
                                                           parent_ids=[server_id]))


def _ms(value):
    from collectors.util import ms_to_dt

    return ms_to_dt(value)
