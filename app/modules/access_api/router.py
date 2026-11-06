"""Access requests, grants, subscriptions (email-registered consumers) and usage registration."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request

from modules._http import asset_row, principal, read, user_token, write
from registry import access, authz, subscriptions, synthetic

router = APIRouter(tags=["access"])


@router.get("/api/assets/{asset_id:path}/access")
def asset_access(asset_id: str, request: Request):
    p = principal(request)

    def fn(cur):
        a = asset_row(cur, asset_id)
        perms = authz.asset_permissions(cur, p, asset_id)
        ids = [asset_id] + ([a["parent_asset_id"]] if a["parent_asset_id"] else [])
        cur.execute("""SELECT * FROM access_grant WHERE asset_id = ANY(%s) AND revoked_at IS NULL
                        ORDER BY source, principal_type, principal LIMIT 500""", (ids,))
        grants = [{**g, "inherited": g["inherited"] or g["asset_id"] != asset_id} for g in cur.fetchall()]
        mine = [g for g in grants if g["principal"] == p.email or g["principal"] in ("users", "account users")]
        cur.execute("""SELECT r.*, a.display_name AS asset_display_name, a.asset_type FROM access_request r JOIN asset a ON a.asset_id = r.asset_id
                        WHERE r.asset_id = %s ORDER BY r.created_at DESC LIMIT 200""", (asset_id,))
        reqs = [access.to_api(cur, r, p) for r in cur.fetchall()]
        visible = grants if (perms["can_manage_access"] or p.can_read_everything) else mine
        return {"grants": visible, "my_access": mine,
                "pending_requests": [r for r in reqs if r["status"] in ("pending", "provision_failed")] if perms["can_manage_access"] or p.is_steward else [],
                "my_requests": [r for r in reqs if r["requester_email"] == p.email],
                "settings": access.settings(cur, a),
                "platform_request_destinations": (a["attributes"] or {}).get("rfa_destinations")}
    return read("asset_access", fn, lambda: synthetic.asset_access(asset_id, p.email))


@router.put("/api/assets/{asset_id:path}/access-settings")
def put_access_settings(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: access.update_settings(
        cur, asset_id, body, actor=p.email, perms=authz.asset_permissions(cur, p, asset_id), request_id=p.request_id))


@router.post("/api/assets/{asset_id:path}/access-requests")
def create_request(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: access.create(cur, asset_row(cur, asset_id), body, p=p))


@router.get("/api/requests")
def list_requests(request: Request, scope: str = "mine", status: str | None = None):
    p = principal(request)

    def fn(cur):
        clauses, params = [], []
        if scope == "review":
            clauses.append("(%s = ANY(r.approvers) OR %s)"); params += [p.email, p.is_steward]
            clauses.append("r.status IN ('pending','provision_failed')")
        elif scope == "all":
            authz.require(p.can_read_everything, "Only stewards, admins and auditors can list every request")
        else:
            clauses.append("r.requester_email = %s"); params.append(p.email)
        if status:
            clauses.append("r.status = ANY(%s)"); params.append(status.split(","))
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        cur.execute(f"""SELECT r.*, a.display_name AS asset_display_name, a.asset_type FROM access_request r
                         JOIN asset a ON a.asset_id = r.asset_id {where} ORDER BY r.sla_due_at, r.created_at DESC LIMIT 500""", params)
        return [access.to_api(cur, r, p) for r in cur.fetchall()]
    return read("requests", fn, lambda: synthetic.requests(scope, p.email))


@router.post("/api/requests/{request_id}/decision")
def decide(request_id: int, request: Request, body: dict = Body(...)):
    token = user_token(request)
    return write(request, lambda cur, p: access.decide(cur, request_id, body, p=p, user_token=token))


@router.post("/api/requests/{request_id}/retry")
def retry(request_id: int, request: Request):
    token = user_token(request)
    return write(request, lambda cur, p: access.retry(cur, request_id, p=p, user_token=token))


@router.post("/api/requests/{request_id}/cancel")
def cancel(request_id: int, request: Request):
    return write(request, lambda cur, p: access.cancel(cur, request_id, p=p))


@router.post("/api/grants/{grant_id}/revoke")
def revoke(grant_id: int, request: Request, body: dict = Body(...)):
    token = user_token(request)

    def fn(cur, p):
        cur.execute("SELECT asset_id FROM access_grant WHERE grant_id = %s", (grant_id,))
        g = cur.fetchone()
        perms = authz.asset_permissions(cur, p, g["asset_id"]) if g else {"can_manage_access": False}
        return access.revoke(cur, grant_id, body.get("reason") or "", p=p, perms=perms, user_token=token)
    return write(request, fn)


# ── subscriptions ──
@router.get("/api/assets/{asset_id:path}/subscribers")
def subscribers(asset_id: str, request: Request):
    p = principal(request)

    def fn(cur):
        asset_row(cur, asset_id)
        perms = authz.asset_permissions(cur, p, asset_id)
        data = subscriptions.for_asset(cur, asset_id)
        if not (perms["can_view_all_usage"] or p.can_read_everything):
            data = {"subscribers": [s for s in data["subscribers"] if p.email in (s["subscriber_email"], s["created_by"])],
                    "unregistered": []}
        return data
    return read("subscribers", fn, lambda: synthetic.subscribers(asset_id))


@router.post("/api/assets/{asset_id:path}/subscriptions")
def subscribe(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: subscriptions.subscribe(cur, asset_id, body, p=p))


@router.patch("/api/subscriptions/{subscription_id}")
def patch_subscription(subscription_id: int, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: subscriptions.update(cur, subscription_id, body, p=p))


@router.delete("/api/subscriptions/{subscription_id}")
def delete_subscription(subscription_id: int, request: Request):
    return write(request, lambda cur, p: subscriptions.unsubscribe(cur, subscription_id, p=p))


@router.post("/api/assets/{asset_id:path}/nudge")
def nudge(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: subscriptions.nudge(cur, asset_id, list(body.get("requesters") or []), p=p,
                                                            perms=authz.asset_permissions(cur, p, asset_id)))


@router.post("/api/assets/{asset_id:path}/use")
def use(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: subscriptions.register_usage(cur, {**body, "asset_id": asset_id, "client": "app"},
                                                                     actor=p.email, origin="app"))


@router.post("/api/v1/usage")
def register_usage(request: Request, body: dict = Body(...)):
    """For agents, notebooks and jobs: register a use of an asset. ``consumer_email`` is required."""
    return write(request, lambda cur, p: subscriptions.register_usage(cur, body, actor=p.email, origin="api"))
