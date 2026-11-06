"""Changes & impact, acknowledgements, owner publish, notifications."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request

from modules._http import asset_row, principal, read, write
from registry import authz, changes, impact, synthetic

router = APIRouter(tags=["changes"])


@router.get("/api/changes")
def feed(request: Request, asset_id: str | None = None, breaking: bool | None = None, mine: bool = False, days: int = 90):
    p = principal(request)
    return read("changes", lambda cur: changes.feed(cur, viewer=p.email, asset_id=asset_id, breaking=breaking, mine=mine, days=days),
                lambda: synthetic.changes_feed(asset_id))


@router.get("/api/changes/{change_id}")
def detail(change_id: int, request: Request):
    p = principal(request)
    return read("change_detail", lambda cur: changes.detail(cur, change_id, viewer=p.email), lambda: synthetic.change_detail(change_id))


@router.post("/api/changes/{change_id}/ack")
def ack(change_id: int, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: changes.acknowledge(cur, change_id, body.get("status") or "", p=p,
                                                            note=body.get("note"), migrate_by=body.get("migrate_by")))


@router.post("/api/assets/{asset_id:path}/changes/preview")
def preview(asset_id: str, request: Request, body: dict = Body(...)):
    # A preview writes nothing, but it is owner-only and needs live data, so it goes through the write path's checks.
    def fn(cur, p):
        perms = authz.asset_permissions(cur, p, asset_id)
        authz.require(perms["can_publish"], "Only the asset's owners (or a steward) can preview a change")
        return changes.preview(cur, asset_row(cur, asset_id), body)
    return write(request, fn)


@router.post("/api/assets/{asset_id:path}/changes")
def publish(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: changes.publish(cur, asset_row(cur, asset_id), body, p=p,
                                                        perms=authz.asset_permissions(cur, p, asset_id)))


@router.post("/api/assets/{asset_id:path}/runtime")
def runtime(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: changes.runtime_action(cur, asset_row(cur, asset_id), body.get("action") or "",
                                                               body.get("reason") or "", p=p,
                                                               perms=authz.asset_permissions(cur, p, asset_id)))


@router.get("/api/me/impacts")
def my_impacts(request: Request, open: bool = False):
    p = principal(request)
    return read("my_impacts", lambda cur: changes.my_impacts(cur, p.email, open_only=open), lambda: synthetic.my_impacts(p.email))


# ── notifications ──
@router.get("/api/notifications")
def notifications(request: Request, unread: bool = False, limit: int = 100):
    p = principal(request)

    def fn(cur):
        cur.execute(f"""SELECT notification_id, kind, title, body, asset_id, ref_id, channel, delivery_status, read_at, created_at
                          FROM notification WHERE recipient_email = %s AND channel = 'in_app' {"AND read_at IS NULL" if unread else ""}
                         ORDER BY created_at DESC LIMIT %s""", (p.email, max(1, min(limit, 500))))
        return list(cur.fetchall())
    return read("notifications", fn, lambda: synthetic.notifications(p.email))


@router.post("/api/notifications/read-all")
def read_all(request: Request):
    def fn(cur, p):
        cur.execute("UPDATE notification SET read_at = now() WHERE recipient_email = %s AND read_at IS NULL", (p.email,))
        return {"ok": True, "updated": cur.rowcount}
    return write(request, fn)


@router.post("/api/notifications/{notification_id}/read")
def mark_read(notification_id: int, request: Request):
    def fn(cur, p):
        cur.execute("UPDATE notification SET read_at = coalesce(read_at, now()) WHERE notification_id = %s AND recipient_email = %s",
                    (notification_id, p.email))
        return {"ok": True, "updated": cur.rowcount}
    return write(request, fn)


__all__ = ["router", "impact"]
