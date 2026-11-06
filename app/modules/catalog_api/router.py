"""Me, home, search, catalog, my workspace lists, registration and the asset entity routes.

The catch-all ``GET /api/assets/{asset_id:path}`` is the LAST route of the LAST router (see modules/__init__),
so suffix routes such as ``/fields``, ``/access`` and ``/usage`` win first.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Request

from modules._http import asset_row, principal, read, user_token, write
from registry import authz, cards, fields, governance, home, subscriptions, synthetic, tool_selection

router = APIRouter(tags=["catalog"])
# Tool rows expose only descriptive attributes (never config secrets): schemas, MCP annotations, side effects.
TOOL_ATTRS = ("input_schema", "inputSchema", "output_schema", "outputSchema", "annotations", "side_effect", "title",
              "routine_body", "data_type", "security_type", "sql_data_access", "language", "observed", "task", "tools_status")


@router.get("/api/me")
def me(request: Request):
    p = principal(request)
    return read("me", lambda cur: home.me(cur, p), lambda: synthetic.me(p))


@router.get("/api/home")
def home_page(request: Request):
    p = principal(request)
    return read("home", lambda cur: home.home(cur, p), lambda: synthetic.home(p.email))


@router.get("/api/search")
def search(request: Request, q: str = ""):
    p = principal(request)
    return read("search", lambda cur: home.search(cur, q, p.email), lambda: synthetic.search(q))


@router.get("/api/catalog")
def catalog(request: Request, page: int = 1, page_size: int = 24):
    p = principal(request)
    filters = {k: v for k, v in request.query_params.items() if k not in ("page", "page_size")}
    return read("catalog", lambda cur: cards.catalog(cur, filters, p.email, page, page_size),
                lambda: synthetic.catalog(filters, page, page_size))


@router.get("/api/me/subscriptions")
def my_subscriptions(request: Request):
    p = principal(request)
    return read("my_subscriptions", lambda cur: subscriptions.mine(cur, p.email), lambda: [])


@router.get("/api/me/access")
def my_access(request: Request):
    p = principal(request)

    def fn(cur):
        cur.execute("""SELECT g.*, a.display_name AS asset_display_name, a.asset_type FROM access_grant g JOIN asset a ON a.asset_id = g.asset_id
                        WHERE g.principal = %s AND g.revoked_at IS NULL ORDER BY g.expires_at NULLS LAST LIMIT 500""", (p.email,))
        return list(cur.fetchall())
    return read("my_access", fn, lambda: [])


@router.get("/api/me/requests")
def my_requests(request: Request):
    p = principal(request)

    def fn(cur):
        from registry import access
        cur.execute("""SELECT r.*, a.display_name AS asset_display_name, a.asset_type FROM access_request r JOIN asset a ON a.asset_id = r.asset_id
                        WHERE r.requester_email = %s ORDER BY r.created_at DESC LIMIT 200""", (p.email,))
        return [access.to_api(cur, r, p) for r in cur.fetchall()]
    return read("my_requests", fn, lambda: [])


@router.get("/api/me/owned")
def my_owned(request: Request):
    p = principal(request)

    def fn(cur):
        cur.execute("SELECT DISTINCT asset_id FROM asset_owner WHERE email = %s LIMIT 300", (p.email,))
        out = cards.cards(cur, [r["asset_id"] for r in cur.fetchall()], p.email)
        for c in out:
            c["completeness_pct"] = fields.completeness(fields.list_fields(cur, c["asset_id"]))
        return out
    return read("my_owned", fn, lambda: [])


@router.post("/api/assets")
def register(request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: governance.register(cur, body, p=p))


@router.post("/api/skills")
def register_skill(request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: governance.register_skill(cur, body, p=p))


# ── entity sub-resources (before the catch-all detail route) ──
@router.get("/api/assets/{asset_id:path}/fields/history")
def field_history(asset_id: str, request: Request):
    return read("field_history", lambda cur: (asset_row(cur, asset_id), fields.history(cur, asset_id))[1], lambda: [])


@router.post("/api/assets/{asset_id:path}/fields/{field_key}/revert")
def revert_field(asset_id: str, field_key: str, request: Request, body: dict = Body(default={})):
    return write(request, lambda cur, p: fields.revert(cur, asset_id, field_key, actor=p.email, reason=body.get("reason"),
                                                      perms=authz.asset_permissions(cur, p, asset_id), request_id=p.request_id))


@router.post("/api/assets/{asset_id:path}/fields/{field_key}/resolve-drift")
def resolve_drift(asset_id: str, field_key: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: fields.resolve_drift(cur, asset_id, field_key, body.get("action") or "", actor=p.email,
                                                             perms=authz.asset_permissions(cur, p, asset_id), request_id=p.request_id))


@router.put("/api/assets/{asset_id:path}/fields/{field_key}")
def put_field(asset_id: str, field_key: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: fields.set_field(cur, asset_id, field_key, body.get("value"), actor=p.email,
                                                         perms=authz.asset_permissions(cur, p, asset_id), reason=body.get("reason"),
                                                         lock_mode=body.get("lock_mode"), request_id=p.request_id))


@router.put("/api/assets/{asset_id:path}/governance")
def put_governance(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: governance.set_governance(cur, asset_id, body, p=p, perms=authz.asset_permissions(cur, p, asset_id)))


@router.post("/api/assets/{asset_id:path}/owners")
def add_owner(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: governance.set_owner(cur, asset_id, body.get("email") or "", body.get("kind") or "owner", p=p,
                                                             perms=authz.asset_permissions(cur, p, asset_id)))


@router.delete("/api/assets/{asset_id:path}/owners/{email}/{kind}")
def remove_owner(asset_id: str, email: str, kind: str, request: Request):
    return write(request, lambda cur, p: governance.set_owner(cur, asset_id, email, kind, p=p, remove=True,
                                                             perms=authz.asset_permissions(cur, p, asset_id)))


@router.get("/api/assets/{asset_id:path}/tools")
def asset_tools(asset_id: str, request: Request):
    p = principal(request)

    def fn(cur):
        a = asset_row(cur, asset_id)
        if a["asset_type"] == "mcp_server":
            cur.execute("SELECT asset_id FROM asset WHERE parent_asset_id = %s AND lifecycle_status <> 'retired' ORDER BY display_name LIMIT 500",
                        (asset_id,))
            ids = [r["asset_id"] for r in cur.fetchall()]
        else:
            cur.execute("""SELECT DISTINCT dst_id FROM lineage_edge WHERE src_id = %s
                            AND relation IN ('uses_tool','uses_mcp','calls_agent','uses_skill') LIMIT 500""", (asset_id,))
            ids = [r["dst_id"] for r in cur.fetchall()]
        out = cards.cards(cur, ids, p.email)
        cur.execute("SELECT asset_id, attributes FROM asset WHERE asset_id = ANY(%s)", (ids,))
        attrs = {r["asset_id"]: r["attributes"] or {} for r in cur.fetchall()}
        for c in out:
            a = attrs.get(c["asset_id"], {})
            c["attributes"] = {k: a[k] for k in TOOL_ATTRS if k in a}
        return out
    return read("asset_tools", fn, lambda: synthetic.asset_tools(asset_id))


# ── MCP tool selection (UC MCP services: config.include_tool_selectors; owners and stewards) ──
@router.get("/api/assets/{asset_id:path}/tool-selection")
def get_tool_selection(asset_id: str, request: Request):
    p = principal(request)
    return read("tool_selection", lambda cur: tool_selection.state(cur, p, asset_row(cur, asset_id)),
                lambda: {"asset_id": asset_id, "editable": False, "reason_not_editable": "Registry data is unavailable.", "can_edit": False,
                         "current": [], "etag": None, "tools": [], "history": [], "mode": "record_only",
                         "limits": {"max_selectors": tool_selection.MAX_SELECTORS, "max_length": tool_selection.MAX_SELECTOR_LEN}})


@router.post("/api/assets/{asset_id:path}/tool-selection/preview")
def preview_tool_selection(asset_id: str, request: Request, body: dict = Body(...)):
    # Writes nothing, but it is owner-only and needs live data, so it goes through the write path's checks (like change previews).
    return write(request, lambda cur, p: tool_selection.preview(cur, p, asset_row(cur, asset_id), body))


@router.put("/api/assets/{asset_id:path}/tool-selection")
def put_tool_selection(asset_id: str, request: Request, body: dict = Body(...)):
    token = user_token(request)
    return write(request, lambda cur, p: tool_selection.apply(cur, p, asset_row(cur, asset_id), body, user_token=token))


@router.get("/api/assets/{asset_id:path}")
def asset_detail(asset_id: str, request: Request):
    p = principal(request)
    return read("asset_detail", lambda cur: home.asset_detail(cur, asset_id, p), lambda: synthetic.asset_detail(asset_id))
