"""MCP tool selection: edit a Unity Catalog MCP service's ``config.include_tool_selectors`` from the registry.

Scope: registered UC MCP services (``mcp:service:<catalog.schema.name>``). Databricks-provided ``system.ai.*`` servers
and MCP connections have no editable selection.

Selectors (docs/research/01 §MCP service lifecycle; SDK ``McpServiceConfig``): exact tool names or a prefix ending in
``*`` (``read_*``), at most 1,024 entries of at most 256 characters, no ``!`` exclusions. An EMPTY list exposes every
tool. Unselected tools disappear from ``tools/list`` and calling them fails ("Tool not allowed by MCP service
configuration").

Preview: which known tools (the ``tool:mcp:service:<fqn>/<tool>`` assets the collectors store from observed calls and
``tools/list``) stay exposed, become hidden or appear, plus the change-impact preview. Hiding a tool that is exposed
today, or narrowing an "every tool" selection, is BREAKING: it can break agents that call the tool.

Apply: ``PATCH /api/2.1/unity-catalog/mcp-services/{fqn}?update_mask=config.include_tool_selectors`` (with the
``etag`` from the last sync when known) as the approver when the Apps proxy forwards an OBO token, else the app service
principal; ``record_only`` (local, tests) stores the exact request without calling it. Every apply writes a
``mcp_tool_selection`` row and an audit row; a successful (or recorded) one publishes a ``change_event`` through
``registry/changes.publish`` with the hidden tools as extra impact start nodes, so subscribers, downstream agents and
their owners are notified. Only the asset's owners and stewards may edit (``authz.asset_permissions``).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Conflict
from registry import authz, changes, provision

log = logging.getLogger("registry.tool_selection")

MAX_SELECTORS = 1024
MAX_SELECTOR_LEN = 256
UPDATE_MASK = "config.include_tool_selectors"
PREFIX = "mcp:service:"
_BAD_CHARS = re.compile(r"[\s\x00-\x1f]")


_FQN = re.compile(r"^[^./\s?#%]+\.[^./\s?#%]+\.[^./\s?#%]+$")  # catalog.schema.name: it goes into the PATCH path


def editable(asset: dict) -> bool:
    return asset["asset_type"] == "mcp_server" and asset["asset_id"].startswith(PREFIX) and bool(_FQN.match(fqn_of(asset)))


def fqn_of(asset: dict) -> str:
    return asset["asset_id"][len(PREFIX):]


def validate(selectors: Any) -> tuple[list[str], list[str], list[str]]:
    """(clean selectors, errors, warnings). Blank entries are ignored and duplicates dropped (a warning)."""
    if selectors is None:
        selectors = []
    if isinstance(selectors, str):
        selectors = selectors.splitlines()
    if not isinstance(selectors, list) or not all(isinstance(s, str) for s in selectors):
        return [], ["Send the selectors as a list of text"], []
    clean: list[str] = []
    errors: list[str] = []
    warnings: list[str] = []
    for raw in selectors:
        s = raw.strip()
        if not s:
            continue
        if s in clean:
            warnings.append(f"“{s}” is listed twice")
            continue
        if s.startswith("!"):
            errors.append(f"“{s}”: exclusions (!) are not supported. List the tools to include instead")
        elif s == "*":
            errors.append("“*”: leave the selection empty to expose every tool")
        elif "*" in s[:-1]:
            errors.append(f"“{s}”: use an exact tool name or a prefix that ends with a single *")
        elif len(s) > MAX_SELECTOR_LEN:
            errors.append(f"“{s[:40]}…”: a selector can have at most {MAX_SELECTOR_LEN} characters")
        elif _BAD_CHARS.search(s):
            errors.append(f"“{s}”: tool names can't contain spaces or control characters")
        clean.append(s)
    if len(clean) > MAX_SELECTORS:
        errors.append(f"At most {MAX_SELECTORS:,} selectors are allowed ({len(clean):,} given)")
    return clean, errors, warnings


def selects(name: str, selectors: list[str]) -> bool:
    if not selectors:
        return True
    return any(name.startswith(s[:-1]) if s.endswith("*") else name == s for s in selectors)


def known_tools(cur, asset_id: str) -> list[dict]:
    cur.execute("""SELECT t.asset_id, t.name, t.display_name, t.attributes ->> 'side_effect' AS side_effect,
                          coalesce((SELECT sum(requests) FROM usage_daily u WHERE u.asset_id = t.asset_id AND u.day >= current_date - 30), 0)::bigint
                              AS requests_30d
                     FROM asset t WHERE t.parent_asset_id = %s AND t.asset_type = 'tool' AND t.lifecycle_status <> 'retired'
                    ORDER BY t.name""", (asset_id,))
    return list(cur.fetchall())


def current_selectors(asset: dict) -> list[str]:
    value = (asset.get("attributes") or {}).get("include_tool_selectors")
    return [str(s) for s in value] if isinstance(value, list) else []


def _request(asset: dict, selectors: list[str], etag: str | None) -> dict:
    fqn = fqn_of(asset)
    query = {"update_mask": UPDATE_MASK}
    if etag:
        query["etag"] = etag
    return {"method": "PATCH", "path": f"/api/2.1/unity-catalog/mcp-services/{fqn}", "query": query,
            "body": {"name": f"mcp-services/{fqn}", "config": {"include_tool_selectors": selectors}}}


def diff(cur, asset: dict, selectors: Any) -> dict:
    """The live preview: validation, exposed / hidden / removed / added tools, unmatched selectors, breaking."""
    clean, errors, warnings = validate(selectors)
    current = current_selectors(asset)
    tools = known_tools(cur, asset["asset_id"])
    rows, removed, added = [], [], []
    for t in tools:
        before, after = selects(t["name"], current), selects(t["name"], clean)
        rows.append({**t, "exposed_now": before, "exposed_after": after})
        if before and not after:
            removed.append(t["name"])
        elif after and not before:
            added.append(t["name"])
    unmatched = [s for s in clean if not any(selects(t["name"], [s]) for t in tools)]
    narrows_all = not current and bool(clean)
    if unmatched:
        warnings.append(f"{len(unmatched)} selector(s) match no tool the registry has seen yet; they still apply to tools/list")
    if narrows_all:
        warnings.append("Today every tool is exposed: a selection also hides tools the registry has not observed yet")
    return {"selectors": clean, "current": current, "errors": errors, "warnings": warnings, "tools": rows,
            "removed": removed, "added": added, "unmatched_selectors": unmatched,
            "exposed_count": sum(1 for r in rows if r["exposed_after"]), "hidden_count": sum(1 for r in rows if not r["exposed_after"]),
            "breaking": bool(removed) or narrows_all, "changed": sorted(current) != sorted(clean)}


def _change_body(asset: dict, d: dict, reason: str | None, recorded_only: bool = False) -> dict:
    kinds = (["tools_removed"] if d["breaking"] else []) + (["tools_added"] if d["added"] else []) or ["other"]
    parts = []
    if d["removed"]:
        parts.append(f"{len(d['removed'])} tool{'s' if len(d['removed']) != 1 else ''} hidden")
    elif d["breaking"]:
        parts.append("selection narrowed from every tool")
    if d["added"]:
        parts.append(f"{len(d['added'])} tool{'s' if len(d['added']) != 1 else ''} exposed")
    title = "Tool selection: " + (" · ".join(parts) or "selectors updated")
    summary = "; ".join(filter(None, [
        f"Hidden: {', '.join(d['removed'][:20])}" if d["removed"] else None,
        f"Exposed: {', '.join(d['added'][:20])}" if d["added"] else None,
        f"Selectors: {', '.join(d['selectors'][:20]) or '(every tool)'}",
        "Recorded only (PROVISIONING_MODE=record_only): the PATCH still has to be applied in the workspace" if recorded_only else None,
    ]))
    diff_rows = [{"field": "config.include_tool_selectors", "before": d["current"], "after": d["selectors"]}]
    diff_rows += [{"field": f"tools[{n}]", "before": "exposed", "after": "hidden"} for n in d["removed"]]
    diff_rows += [{"field": f"tools[{n}]", "before": "hidden", "after": "exposed"} for n in d["added"]]
    return {"change_kinds": kinds, "breaking": d["breaking"], "title": title[:200], "summary": summary[:2000],
            "release_notes": (reason or "").strip() or None, "diff": diff_rows}


def _extra(asset: dict, d: dict) -> list[str]:
    return [t["asset_id"] for t in d["tools"] if t["name"] in d["removed"]]


def _require(cur, p: authz.Principal, asset: dict) -> dict:
    perms = authz.asset_permissions(cur, p, asset["asset_id"])
    authz.require(editable(asset), "Tool selection applies to registered Unity Catalog MCP services (mcp:service:…) only")
    authz.require(perms["can_edit_tool_selection"], "Only the MCP service's owners (or a steward) can change its tool selection")
    return perms


def state(cur, p: authz.Principal, asset: dict) -> dict:
    """GET: the current selection, the known tools and the request history (anyone may read)."""
    perms = authz.asset_permissions(cur, p, asset["asset_id"])
    attrs = asset.get("attributes") or {}
    current = current_selectors(asset)
    tools = [{**t, "exposed_now": selects(t["name"], current)} for t in known_tools(cur, asset["asset_id"])]
    cur.execute("SELECT to_regclass('mcp_tool_selection') IS NOT NULL AS ok")
    history = []
    if cur.fetchone()["ok"]:
        cur.execute("""SELECT selection_id, before_value, after_value, removed_tools, added_tools, breaking, etag, request, mode, acting_as,
                              status, error, change_id, reason, requested_by, created_at
                         FROM mcp_tool_selection WHERE asset_id = %s ORDER BY selection_id DESC LIMIT 20""", (asset["asset_id"],))
        history = list(cur.fetchall())
    return {"asset_id": asset["asset_id"], "editable": editable(asset),
            "reason_not_editable": None if editable(asset) else "Only registered Unity Catalog MCP services have an editable tool selection.",
            "can_edit": editable(asset) and perms["can_edit_tool_selection"], "current": current, "etag": attrs.get("etag"),
            "uc_listed": bool(attrs.get("uc_listed", True)), "tools": tools, "history": history, "mode": provision.mode(),
            "limits": {"max_selectors": MAX_SELECTORS, "max_length": MAX_SELECTOR_LEN}}


def preview(cur, p: authz.Principal, asset: dict, body: dict) -> dict:
    _require(cur, p, asset)
    d = diff(cur, asset, body.get("selectors"))
    impact = None
    if d["changed"] and not d["errors"]:
        impact = changes.preview(cur, asset, _change_body(asset, d, body.get("reason")), extra_start=_extra(asset, d))
    return {**d, "impact": impact, "request": _request(asset, d["selectors"], (asset.get("attributes") or {}).get("etag")),
            "mode": provision.mode()}


def _patch(t_request: dict, user_token: str | None) -> tuple[dict, str]:
    w, acting = provision._client(user_token)
    res = w.api_client.do(t_request["method"], t_request["path"], query=t_request["query"], body=t_request["body"]) or {}
    return res, acting


def apply(cur, p: authz.Principal, asset: dict, body: dict, *, user_token: str | None = None) -> dict:
    perms = _require(cur, p, asset)
    d = diff(cur, asset, body.get("selectors"))
    if d["errors"]:
        raise ValueError("; ".join(d["errors"]))
    if not d["changed"]:
        raise Conflict("Nothing to change: this is the current selection")
    attrs = asset.get("attributes") or {}
    etag = attrs.get("etag")
    seen = body.get("etag")
    if seen is not None and etag and seen != etag:
        raise Conflict("The MCP service changed since you opened the editor (etag mismatch). Reload and try again.")
    reason = (body.get("reason") or "").strip()
    if d["breaking"] and len(reason) < 10:
        raise ValueError("Hiding tools is a breaking change: explain why and what consumers should do (at least 10 characters)")
    request = _request(asset, d["selectors"], etag)
    mode = provision.mode()
    status, acting, error, new_etag = "recorded", None, None, etag
    if mode == "platform":
        try:
            res, acting = _patch(request, user_token)
            status = "applied"
            new_etag = res.get("etag") or etag
        except Exception as e:  # noqa: BLE001 - surfaced to the owner with the exact request
            log.warning("tool selection PATCH %s failed: %s", request["path"], e)
            status, error = "failed", " ".join(str(e).split())[:500] or type(e).__name__
    cur.execute(
        """INSERT INTO mcp_tool_selection (asset_id, before_value, after_value, removed_tools, added_tools, breaking, etag, request, mode,
                                           acting_as, status, error, reason, requested_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING selection_id""",
        (asset["asset_id"], Jsonb(d["current"]), Jsonb(d["selectors"]), d["removed"], d["added"], d["breaking"], etag, Jsonb(request),
         mode, acting, status, error, reason or None, p.email),
    )
    selection_id = cur.fetchone()["selection_id"]
    audit.audit_event(p.email, f"mcp.tool_selection.{status}", "asset", asset["asset_id"],
                      before={"include_tool_selectors": d["current"], "etag": etag},
                      after={"include_tool_selectors": d["selectors"], "removed": d["removed"], "added": d["added"], "breaking": d["breaking"],
                             "mode": mode, "as": acting, "selection_id": selection_id, "error": error, "reason": reason or None},
                      request_id=p.request_id, cur=cur)
    if status == "failed":
        return {"status": status, "selection_id": selection_id, "mode": mode, "as": acting, "error": error, "request": request, "change": None}
    # The registry reflects the decision at once (record_only: the request still has to be applied). In platform mode the
    # version snapshot moves too, so the next sync does not report this change a second time.
    cur.execute("""UPDATE asset SET attributes = attributes || jsonb_build_object('include_tool_selectors', %s::jsonb, 'etag', %s::text),
                          updated_at = now() WHERE asset_id = %s""", (Jsonb(d["selectors"]), new_etag, asset["asset_id"]))
    if status == "applied":
        from registry import versioning

        versioning.patch_snapshot(cur, asset["asset_id"], "tool_selectors", d["selectors"] or None)
    detail = changes.publish(cur, {**asset, "attributes": {**attrs, "include_tool_selectors": d["selectors"]}},
                             _change_body(asset, d, reason, recorded_only=status == "recorded"), p=p, perms={**perms, "can_publish": True},
                             detected_by="admin" if p.is_steward and not perms.get("is_owner") else "owner",
                             enforce_notice=False, extra_start=_extra(asset, d))
    cur.execute("UPDATE mcp_tool_selection SET change_id = %s WHERE selection_id = %s", (detail["change"]["change_id"], selection_id))
    return {"status": status, "selection_id": selection_id, "mode": mode, "as": acting, "error": None, "request": request,
            "change": detail, "etag": new_etag,
            "note": None if status == "applied" else "PROVISIONING_MODE=record_only: apply this request in the workspace (or with the CLI)"}

