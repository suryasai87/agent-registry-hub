"""Apply / revoke platform permissions for approved access requests.

Identity: when the Databricks Apps proxy forwards the approver's OAuth token (user authorization /
on-behalf-of), grants run AS THE APPROVER, with the owner's own rights. Otherwise they run as the app
service principal, which then needs MANAGE (UC) or CAN_MANAGE (endpoints, Genie) on the object.

Safety: ``PROVISIONING_MODE`` = ``platform`` | ``record_only``. Default: ``platform`` on Databricks Apps
(DATABRICKS_CLIENT_ID is injected), ``record_only`` everywhere else, so local runs and tests never change
real grants. In record_only mode the grant is recorded in the registry and the exact statement to apply is
returned.
"""
from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger("registry.provision")

PRINCIPAL_KEY = {"user": "user_name", "group": "group_name", "service_principal": "service_principal_name"}


def mode() -> str:
    explicit = os.environ.get("PROVISIONING_MODE", "").strip().lower()
    if explicit in ("platform", "record_only"):
        return explicit
    return "platform" if os.environ.get("DATABRICKS_CLIENT_ID") else "record_only"


def target(asset: dict, parent: dict | None = None) -> dict:
    """What a request on ``asset`` grants on the platform, and which privileges it may ask for."""
    aid = asset["asset_id"]
    ref = asset.get("external_ref") or {}
    attrs = asset.get("attributes") or {}
    if aid.startswith("tool:mcp:") and parent:
        t = target(parent)
        return {**t, "inherited_from": parent["asset_id"]}
    if aid.startswith("agent:endpoint:"):
        endpoint_id = ref.get("endpoint_id") or ref.get("id") or attrs.get("endpoint_id")
        return {"kind": "serving_endpoint", "object_id": endpoint_id, "name": asset["name"],
                "privileges": ["CAN_QUERY", "CAN_VIEW", "CAN_MANAGE"], "default": "CAN_QUERY"}
    if aid.startswith("agent:genie:"):
        return {"kind": "genie", "object_id": aid.split(":", 2)[2], "name": asset["display_name"],
                "privileges": ["CAN_RUN", "CAN_VIEW", "CAN_EDIT", "CAN_MANAGE"], "default": "CAN_RUN"}
    if aid.startswith("mcp:connection:"):
        return {"kind": "uc", "securable_type": "connection", "full_name": aid.split(":", 2)[2],
                "privileges": ["USE_CONNECTION"], "default": "USE_CONNECTION"}
    if aid.startswith("mcp:uc:"):
        return {"kind": "uc", "securable_type": "schema", "full_name": aid.split(":", 2)[2],
                "privileges": ["EXECUTE", "USE_SCHEMA"], "default": "EXECUTE",
                "note": "The principal also needs USE CATALOG on the parent catalog."}
    if aid.startswith("tool:uc:"):
        return {"kind": "uc", "securable_type": "function", "full_name": aid.split(":", 2)[2],
                "privileges": ["EXECUTE"], "default": "EXECUTE"}
    if aid.startswith(("mcp:system:", "mcp:service:")):
        # Unity Gateway MCP services (incl. Databricks-provided system.ai.* servers) are UC securables:
        # EXECUTE on the service + USE CATALOG / USE SCHEMA (docs/research/01 §3). For system.ai.* a metastore
        # admin must first hold MANAGE on system.ai, so failures surface as provision_failed + the statement.
        return {"kind": "uc", "securable_type": "mcp_service", "full_name": aid.split(":", 2)[2],
                "privileges": ["EXECUTE"], "default": "EXECUTE",
                "note": "The principal also needs USE CATALOG and USE SCHEMA on the parent catalog and schema."}
    if aid.startswith("skill:uc:"):
        # Skills reuse volume privileges: READ VOLUME to use, WRITE VOLUME to update (docs/research/01 §3).
        return {"kind": "uc", "securable_type": "skill", "full_name": aid.split(":", 2)[2],
                "privileges": ["READ_VOLUME", "WRITE_VOLUME"], "default": "READ_VOLUME",
                "note": "The principal also needs USE CATALOG and USE SCHEMA on the parent catalog and schema."}
    return {"kind": "record_only", "privileges": ["USE"], "default": "USE",
            "note": "This asset is registered manually, so there is no platform object to grant on."}


def manual_statement(t: dict, principal: str, privilege: str) -> str | None:
    if t["kind"] == "uc":
        priv = privilege.replace("_", " ")
        kind = t["securable_type"].upper().replace("_", " ")
        return f"GRANT {priv} ON {kind} `{'`.`'.join(t['full_name'].split('.'))}` TO `{principal}`"
    if t["kind"] in ("serving_endpoint", "genie"):
        path = "serving-endpoints" if t["kind"] == "serving_endpoint" else "genie"
        return f"PATCH /api/2.0/permissions/{path}/{t.get('object_id')}  {privilege} → {principal}"
    return None


def _client(user_token: str | None):
    from databricks.sdk import WorkspaceClient

    from core.lakebase import workspace_client

    if user_token:
        host = workspace_client().config.host
        return WorkspaceClient(host=host, token=user_token, auth_type="pat"), "approver (on-behalf-of)"
    return workspace_client(), "app service principal"


def _workspace_acl_change(w, path: str, principal: str, principal_type: str, level: str, add: bool) -> Any:
    key = PRINCIPAL_KEY[principal_type]
    if add:
        return w.api_client.do("PATCH", f"/api/2.0/permissions/{path}",
                               body={"access_control_list": [{key: principal, "permission_level": level}]})
    current = w.api_client.do("GET", f"/api/2.0/permissions/{path}") or {}
    keep = []
    for entry in current.get("access_control_list", []):
        who_key = next((k for k in PRINCIPAL_KEY.values() if k in entry), None)
        if not who_key:
            continue
        for perm in entry.get("all_permissions", []):
            if perm.get("inherited"):
                continue
            if entry[who_key] == principal and perm.get("permission_level") == level:
                continue
            keep.append({who_key: entry[who_key], "permission_level": perm["permission_level"]})
    return w.api_client.do("PUT", f"/api/2.0/permissions/{path}", body={"access_control_list": keep})


def _add_to_group(w, group: str, principal: str, principal_type: str) -> Any:
    if principal_type != "user":
        raise ValueError("Group provisioning supports users only")
    groups = w.api_client.do("GET", "/api/2.0/preview/scim/v2/Groups", query={"filter": f'displayName eq "{group}"'}) or {}
    users = w.api_client.do("GET", "/api/2.0/preview/scim/v2/Users", query={"filter": f'userName eq "{principal}"'}) or {}
    if not groups.get("Resources"):
        raise ValueError(f"group {group!r} not found")
    if not users.get("Resources"):
        raise ValueError(f"user {principal!r} not found in the workspace")
    gid, uid = groups["Resources"][0]["id"], users["Resources"][0]["id"]
    return w.api_client.do("PATCH", f"/api/2.0/preview/scim/v2/Groups/{gid}", body={
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        "Operations": [{"op": "add", "value": {"members": [{"value": uid}]}}],
    })


def apply(t: dict, principal: str, principal_type: str, privilege: str, *, provision_mode: str = "grant_direct",
          group: str | None = None, user_token: str | None = None, revoke: bool = False) -> dict:
    """Returns {applied: bool, mode, as, statement, error?}. Never raises for platform errors."""
    statement = manual_statement(t, principal, privilege)
    if provision_mode == "record_only" or t["kind"] == "record_only" or mode() == "record_only":
        why = t.get("note") if t["kind"] == "record_only" else (
            "PROVISIONING_MODE=record_only" if mode() == "record_only" else "approver chose record-only")
        return {"applied": False, "mode": "record_only", "as": None, "statement": statement, "note": why}
    try:
        w, acting = _client(user_token)
        if provision_mode == "add_to_group" and not revoke:
            if not group:
                raise ValueError("add_to_group needs a group name")
            _add_to_group(w, group, principal, principal_type)
            return {"applied": True, "mode": "add_to_group", "as": acting, "statement": f"add {principal} to group {group}"}
        if t["kind"] == "uc":
            change = {"principal": principal, ("remove" if revoke else "add"): [privilege]}
            w.api_client.do("PATCH", f"/api/2.1/unity-catalog/permissions/{t['securable_type']}/{t['full_name']}",
                            body={"changes": [change]})
        elif t["kind"] in ("serving_endpoint", "genie"):
            if not t.get("object_id"):
                raise ValueError("the platform object id is unknown (run a sync)")
            path = ("serving-endpoints/" if t["kind"] == "serving_endpoint" else "genie/") + str(t["object_id"])
            _workspace_acl_change(w, path, principal, principal_type, privilege, add=not revoke)
        else:
            raise ValueError(f"unsupported target {t['kind']}")
        return {"applied": True, "mode": "revoke" if revoke else "grant_direct", "as": acting, "statement": statement}
    except Exception as e:  # noqa: BLE001 - surfaced to the approver as provision_failed with the manual statement
        log.warning("provisioning %s %s on %s failed: %s", privilege, principal, t.get("full_name") or t.get("object_id"), e)
        msg = str(e)
        return {"applied": False, "mode": "revoke" if revoke else provision_mode, "as": None, "statement": statement,
                "error": msg[:500]}
