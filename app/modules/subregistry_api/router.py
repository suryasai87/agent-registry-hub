"""The hub as an MCP **subregistry**: the official MCP Registry read API (``/v0.1/servers``) served from Lakebase.

MCP clients that accept an enterprise "MCP Registry URL" (GitHub Copilot, VS Code and others) can list the
approved MCP servers in standard ``server.json`` form (schema 2025-12-11). Governance data rides in ``_meta``
under our own reverse-DNS key: owners, certification, sensitivity, coverage, subscribers and the registry link.
Only approved, non-retired MCP servers are listed. Remotes point at the Databricks MCP proxy and need a
Databricks OAuth token (Authorization header).
"""
from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from core import db

router = APIRouter(tags=["mcp-subregistry"])
SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
META_KEY = "com.databricks.agent-registry-hub"


def _host() -> str:
    try:
        from core.lakebase import workspace_client
        return workspace_client().config.host.rstrip("/")
    except Exception:  # noqa: BLE001
        return ""


def _namespace(host: str) -> str:
    parts = re.sub(r"^https?://", "", host).split("/")[0].split(".")
    return ".".join(reversed([p for p in parts if p])) or "local.registry"


def _remote_url(a: dict, host: str, endpoint_url: str | None) -> str | None:
    aid = a["asset_id"]
    if aid.startswith("mcp:uc:"):
        cat, sch = aid.split(":", 2)[2].split(".", 1)
        return f"{host}/api/2.0/mcp/functions/{cat}/{sch}"
    if aid.startswith("mcp:connection:"):
        return f"{host}/api/2.0/mcp/external/{aid.split(':', 2)[2]}"
    if aid.startswith(("mcp:system:", "mcp:service:")):
        return f"{host}/ai-gateway/mcp-services/{aid.split(':', 2)[2]}"
    return endpoint_url


def _server(a: dict, host: str, ns: str, app_url: str) -> dict:
    slug = re.sub(r"[^a-zA-Z0-9._-]", ".", a["asset_id"].split(":", 1)[1])[:150]
    url = _remote_url(a, host, a.get("endpoint_url"))
    server = {"$schema": SCHEMA, "name": f"{ns}/{slug}", "title": a["display_name"][:100],
              "description": (a.get("purpose") or a["display_name"])[:100], "version": a.get("published_version") or "1.0.0"}
    if url:
        server["remotes"] = [{"type": "streamable-http", "url": url,
                              "headers": [{"name": "Authorization", "description": "Bearer <Databricks OAuth token>",
                                           "isRequired": True, "isSecret": True}]}]
    status = "deprecated" if a["lifecycle_status"] == "deprecated" else "active"
    return {"server": server, "_meta": {
        "io.modelcontextprotocol.registry/official": {"status": status, "updatedAt": a["updated_at"], "isLatest": True},
        META_KEY: {"asset_id": a["asset_id"], "publisher": a.get("publisher"), "certification": a["certification"],
                   "sensitivity": a["sensitivity"], "risk_tier": a["risk_tier"], "owners": a.get("owners") or [],
                   "subscribers": a.get("subscribers", 0), "tools": a.get("tools", []),
                   "registry_url": f"{app_url}/assets/{quote(a['asset_id'], safe='')}" if app_url else None}}}


def _rows(search: str | None, after: str | None, limit: int) -> list[dict]:
    clauses = ["a.asset_type = 'mcp_server'", "a.lifecycle_status IN ('approved','deprecated')"]
    params: list = []
    if search:
        clauses.append("(a.display_name ILIKE %s OR a.asset_id ILIKE %s)"); params += [f"%{search}%"] * 2
    if after:
        clauses.append("a.asset_id > %s"); params.append(after)
    return db.query(f"""
        SELECT a.asset_id, a.display_name, a.publisher, a.lifecycle_status, a.certification, a.sensitivity, a.risk_tier,
               a.published_version, a.updated_at,
               (SELECT coalesce(f.override_value, f.source_value) #>> '{{}}' FROM asset_field f WHERE f.asset_id = a.asset_id AND f.field_key = 'purpose') AS purpose,
               (SELECT coalesce(f.override_value, f.source_value) #>> '{{}}' FROM asset_field f WHERE f.asset_id = a.asset_id AND f.field_key = 'endpoint_url') AS endpoint_url,
               (SELECT array_agg(o.email ORDER BY o.email) FROM asset_owner o WHERE o.asset_id = a.asset_id AND o.kind IN ('owner','co_owner')) AS owners,
               (SELECT count(*) FROM subscription s WHERE s.asset_id = a.asset_id AND s.status = 'active') AS subscribers,
               (SELECT array_agg(t.name ORDER BY t.name) FROM asset t WHERE t.parent_asset_id = a.asset_id AND t.lifecycle_status = 'approved') AS tools
          FROM asset a WHERE {' AND '.join(clauses)} ORDER BY a.asset_id LIMIT %s""", [*params, limit + 1])


@router.get("/v0.1/servers")
def list_servers(request: Request, cursor: str | None = None, limit: int = 30, search: str | None = None, version: str | None = None):
    limit = max(1, min(limit, 100))
    try:
        rows = _rows(search, cursor, limit)
    except Exception as e:  # noqa: BLE001 - registry clients get a clean 503, never a stack trace
        return JSONResponse({"detail": f"registry unavailable ({type(e).__name__})"}, status_code=503)
    host, app_url = _host(), str(request.base_url).rstrip("/")
    ns = _namespace(host)
    page = rows[:limit]
    body = {"servers": [_server(r, host, ns, app_url) for r in page],
            "metadata": {"count": len(page), **({"nextCursor": page[-1]["asset_id"]} if len(rows) > limit else {})}}
    return JSONResponse(jsonable_encoder(body))


@router.get("/v0.1/servers/{server_name:path}/versions/{version}")
def get_server(server_name: str, version: str, request: Request):
    host = _host()
    ns = _namespace(host)
    slug = server_name.split("/", 1)[1] if "/" in server_name else server_name
    try:
        rows = [r for r in _rows(None, None, 1000) if re.sub(r"[^a-zA-Z0-9._-]", ".", r["asset_id"].split(":", 1)[1])[:150] == slug]
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"detail": f"registry unavailable ({type(e).__name__})"}, status_code=503)
    if not rows:
        return JSONResponse({"detail": f"server {server_name} not found"}, status_code=404)
    return JSONResponse(jsonable_encoder(_server(rows[0], host, ns, str(request.base_url).rstrip("/"))))
