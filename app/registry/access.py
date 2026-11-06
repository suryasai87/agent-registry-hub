"""Access requests → owner approval → platform grant (with SLA, justification and expiry).

The flow follows Unity Catalog's request-for-access behaviour:
* approvers are resolved explicit approvers → owners → domain stewards → admins;
* a reminder goes out at day 3 and the request expires at day 7;
* a deny needs a reason;
* the approver picks how to provision (grant directly, add to a group, record only).
A grant is never shown as done optimistically: the request moves pending → provisioning →
provisioned | provision_failed, and a failed provisioning keeps the exact statement to apply by hand.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Conflict, Forbidden, NotFound
from registry import authz, notify, provision, subscriptions

REQUEST_TTL_DAYS = 7
REMINDER_AFTER_DAYS = 3
MIN_JUSTIFICATION = 15


def _now() -> datetime:
    return datetime.now(timezone.utc)


def settings(cur, asset: dict) -> dict:
    cur.execute("SELECT * FROM access_settings WHERE asset_id = %s", (asset["asset_id"],))
    row = cur.fetchone() or {}
    parent = None
    if asset.get("parent_asset_id"):
        cur.execute("SELECT * FROM asset WHERE asset_id = %s", (asset["parent_asset_id"],))
        parent = cur.fetchone()
    t = provision.target(asset, parent)
    return {
        "approval_required": row.get("approval_required", True),
        "approver_mode": row.get("approver_mode", "any"),
        "approvers": list(row.get("approvers") or []),
        "default_duration_days": row.get("default_duration_days", 90),
        "max_duration_days": row.get("max_duration_days", 180),
        "sla_hours": row.get("sla_hours", 48),
        "terms_text": row.get("terms_text"),
        "managed_externally_url": row.get("managed_externally_url"),
        "privileges": t["privileges"],
        "default_privilege": t["default"],
        "target_note": t.get("note"),
        "provisioning_mode": provision.mode() if t["kind"] != "record_only" else "record_only",
    }


def update_settings(cur, asset_id: str, patch: dict, *, actor: str, perms: dict, request_id: str | None) -> dict:
    authz.require(perms["can_manage_access"], "Only the asset's owners or approvers can change its access settings")
    allowed = {"approval_required", "approver_mode", "approvers", "default_duration_days", "max_duration_days",
               "sla_hours", "terms_text", "managed_externally_url"}
    patch = {k: v for k, v in patch.items() if k in allowed and v is not None}
    if "approvers" in patch:
        patch["approvers"] = sorted({e.strip().lower() for e in patch["approvers"] if "@" in str(e)})
    if patch.get("default_duration_days") and patch.get("max_duration_days") and patch["default_duration_days"] > patch["max_duration_days"]:
        raise ValueError("The default duration can't exceed the maximum")
    cur.execute("SELECT * FROM access_settings WHERE asset_id = %s", (asset_id,))
    before = cur.fetchone()
    cur.execute("INSERT INTO access_settings (asset_id, updated_by) VALUES (%s, %s) ON CONFLICT (asset_id) DO NOTHING",
                (asset_id, actor))
    if patch:
        assignments = ", ".join(f"{c} = %s" for c in patch)  # column names come from the allow-list above
        cur.execute(f"UPDATE access_settings SET {assignments}, updated_by = %s, updated_at = now() WHERE asset_id = %s",
                    [*patch.values(), actor, asset_id])
    audit.audit_event(actor, "access.settings", "asset", asset_id, before=before, after=patch, request_id=request_id, cur=cur)
    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (asset_id,))
    return settings(cur, cur.fetchone())


def sla_state(r: dict) -> str:
    if r["status"] not in ("pending", "provisioning"):
        return "closed"
    now = _now()
    if r["sla_due_at"] < now:
        return "overdue"
    if r["sla_due_at"] - now < timedelta(hours=12):
        return "due_soon"
    return "on_track"


def to_api(cur, r: dict, viewer: authz.Principal | None = None) -> dict:
    out = {k: r[k] for k in (
        "request_id", "asset_id", "requester_email", "principal", "principal_type", "privilege", "tool_subset",
        "justification", "duration_days", "terms_accepted", "subscribe_email", "status", "approvers", "decided_by",
        "decided_at", "decision_reason", "provision_mode", "provision_detail", "grant_expires_at", "sla_due_at",
        "request_expires_at", "created_at")}
    out["tool_subset"] = list(out["tool_subset"] or [])
    out["approvers"] = list(out["approvers"] or [])
    out["asset_display_name"] = r.get("asset_display_name") or r["asset_id"]
    out["asset_type"] = r.get("asset_type") or "agent"
    out["sla_state"] = sla_state(r)
    out["can_decide"] = bool(viewer and r["status"] in ("pending", "provision_failed") and
                             (viewer.email in out["approvers"] or viewer.is_steward) and viewer.email != r["requester_email"])
    return out


def _load(cur, request_id: int, lock: bool = False) -> dict:
    cur.execute(
        f"""SELECT r.*, a.display_name AS asset_display_name, a.asset_type FROM access_request r
              JOIN asset a ON a.asset_id = r.asset_id WHERE r.request_id = %s {'FOR UPDATE OF r' if lock else ''}""",
        (request_id,),
    )
    r = cur.fetchone()
    if not r:
        raise NotFound(f"request {request_id} not found")
    return r


def create(cur, asset: dict, body: dict, *, p: authz.Principal) -> dict:
    if asset["lifecycle_status"] in ("retired", "rejected"):
        raise Conflict("This asset is retired; access can't be requested")
    s = settings(cur, asset)
    privilege = (body.get("privilege") or s["default_privilege"]).upper()
    if privilege not in s["privileges"]:
        raise ValueError(f"privilege must be one of {', '.join(s['privileges'])}")
    justification = (body.get("justification") or "").strip()
    if len(justification) < MIN_JUSTIFICATION:
        raise ValueError(f"Please explain why you need access (at least {MIN_JUSTIFICATION} characters)")
    duration = int(body.get("duration_days") or s["default_duration_days"])
    if not 1 <= duration <= s["max_duration_days"]:
        raise ValueError(f"duration must be between 1 and {s['max_duration_days']} days")
    if s["terms_text"] and not body.get("terms_accepted"):
        raise ValueError("Please accept the owner's terms of use")
    principal = (body.get("principal") or p.email).strip()
    principal_type = body.get("principal_type") or "user"
    if principal_type not in ("user", "group", "service_principal"):
        raise ValueError("principal_type must be user, group or service_principal")
    if principal_type == "user":
        principal = principal.lower()
    subscribe_email = (body.get("subscribe_email") or "").strip().lower() or None
    if subscribe_email and not subscriptions.EMAIL_RE.match(subscribe_email):
        raise ValueError("subscribe_email is not a valid email address")
    cur.execute(
        """SELECT request_id FROM access_request WHERE asset_id = %s AND principal = %s AND privilege = %s
             AND status IN ('pending','provisioning')""",
        (asset["asset_id"], principal, privilege),
    )
    if cur.fetchone():
        raise Conflict("An open request for this access already exists")
    approvers = s["approvers"] or authz.approvers_for(cur, asset["asset_id"])
    now = _now()
    cur.execute(
        """INSERT INTO access_request (asset_id, requester_email, principal, principal_type, privilege, tool_subset,
                 justification, duration_days, terms_accepted, subscribe_email, approvers, sla_due_at, request_expires_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING request_id""",
        (asset["asset_id"], p.email, principal, principal_type, privilege, list(body.get("tool_subset") or []),
         justification, duration, bool(body.get("terms_accepted")), subscribe_email, approvers,
         now + timedelta(hours=s["sla_hours"]), now + timedelta(days=REQUEST_TTL_DAYS)),
    )
    rid = cur.fetchone()["request_id"]
    audit.audit_event(p.email, "access.request", "asset", asset["asset_id"],
                      after={"request_id": rid, "principal": principal, "privilege": privilege, "duration_days": duration},
                      request_id=p.request_id, cur=cur)
    if not s["approval_required"]:
        return decide(cur, rid, {"decision": "approve", "reason": "auto-approved (approval not required)"},
                      p=p, auto=True)
    for email in approvers:
        notify.queue(cur, email, "access_request", f"Access request: {p.email} → {asset['display_name']} ({privilege})",
                     justification, asset["asset_id"], rid)
    notify.queue(cur, p.email, "access_request_submitted", f"Request sent: {asset['display_name']} ({privilege})",
                 f"Approvers: {', '.join(approvers) or 'none configured'}", asset["asset_id"], rid)
    return to_api(cur, _load(cur, rid), p)


def _provision(cur, r: dict, asset: dict, *, actor: str, provision_mode: str, group: str | None,
               user_token: str | None, request_id: str | None) -> dict:
    parent = None
    if asset.get("parent_asset_id"):
        cur.execute("SELECT * FROM asset WHERE asset_id = %s", (asset["parent_asset_id"],))
        parent = cur.fetchone()
    t = provision.target(asset, parent)
    result = provision.apply(t, r["principal"], r["principal_type"], r["privilege"], provision_mode=provision_mode,
                             group=group, user_token=user_token)
    ok = result["applied"] or result["mode"] == "record_only"
    status = "provisioned" if ok else "provision_failed"
    expires = _now() + timedelta(days=int(r["duration_days"]))
    cur.execute(
        """UPDATE access_request SET status = %s, provision_mode = %s, provision_group = %s, provision_detail = %s,
                  grant_expires_at = %s, updated_at = now() WHERE request_id = %s""",
        (status, provision_mode, group, Jsonb(result), expires if ok else None, r["request_id"]),
    )
    if ok:
        grant_asset = (t.get("inherited_from") or asset["asset_id"])
        cur.execute(
            """INSERT INTO access_grant (asset_id, principal, principal_type, privilege, source, request_id, granted_by, expires_at)
               VALUES (%s, %s, %s, %s, 'app', %s, %s, %s)
               ON CONFLICT (asset_id, principal, privilege, source) WHERE revoked_at IS NULL
               DO UPDATE SET expires_at = EXCLUDED.expires_at, request_id = EXCLUDED.request_id, granted_by = EXCLUDED.granted_by""",
            (grant_asset, r["principal"], r["principal_type"], r["privilege"], r["request_id"], actor, expires),
        )
        if r.get("subscribe_email"):
            subscriptions.ensure(cur, asset["asset_id"], r["subscribe_email"], created_by=r["requester_email"],
                                 use_case=r["justification"][:500])
        notify.queue(cur, r["requester_email"], "access_decision",
                     f"Access granted: {asset['display_name']} ({r['privilege']}) until {expires:%Y-%m-%d}",
                     result.get("note") or result.get("statement"), asset["asset_id"], r["request_id"])
    else:
        notify.queue(cur, r["requester_email"], "access_decision",
                     f"Approved, but provisioning failed: {asset['display_name']}",
                     "The approver has been asked to retry or apply the grant manually.", asset["asset_id"], r["request_id"])
    audit.audit_event(actor, "access.provision" if ok else "access.provision_failed", "asset", asset["asset_id"],
                      after={"request_id": r["request_id"], **{k: v for k, v in result.items() if k != "error"},
                             "error": result.get("error")}, request_id=request_id, cur=cur)
    authz.invalidate_roles()
    return to_api(cur, _load(cur, r["request_id"]))


def decide(cur, request_id: int, body: dict, *, p: authz.Principal, auto: bool = False,
           user_token: str | None = None) -> dict:
    r = _load(cur, request_id, lock=True)
    if r["status"] != "pending":
        raise Conflict(f"This request is {r['status']}")
    if not auto:
        authz.require(p.email in (r["approvers"] or []) or p.is_steward, "You are not an approver for this asset")
        authz.require(p.email != r["requester_email"] or p.is_admin, "You can't approve your own request")
    decision = body.get("decision")
    reason = (body.get("reason") or "").strip() or None
    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (r["asset_id"],))
    asset = cur.fetchone()
    if decision == "deny":
        if not reason:
            raise ValueError("A reason is required to deny a request")
        cur.execute("""UPDATE access_request SET status = 'denied', decided_by = %s, decided_at = now(),
                          decision_reason = %s, updated_at = now() WHERE request_id = %s""", (p.email, reason, request_id))
        audit.audit_event(p.email, "access.deny", "asset", r["asset_id"], after={"request_id": request_id, "reason": reason},
                          request_id=p.request_id, cur=cur)
        notify.queue(cur, r["requester_email"], "access_decision", f"Access denied: {asset['display_name']}", reason,
                     r["asset_id"], request_id)
        return to_api(cur, _load(cur, request_id), p)
    if decision != "approve":
        raise ValueError("decision must be approve or deny")
    if body.get("duration_days"):
        d = int(body["duration_days"])
        if not 1 <= d <= int(r["duration_days"]):
            raise ValueError("An approver can shorten, not extend, the requested duration")
        cur.execute("UPDATE access_request SET duration_days = %s WHERE request_id = %s", (d, request_id))
        r["duration_days"] = d
    cur.execute("SELECT approver_mode FROM access_settings WHERE asset_id = %s", (r["asset_id"],))
    mode_row = cur.fetchone()
    approvals = list(r["approvals"] or []) + [{"by": "auto" if auto else p.email, "at": _now().isoformat(), "decision": "approve"}]
    cur.execute("UPDATE access_request SET approvals = %s WHERE request_id = %s", (Jsonb(approvals), request_id))
    if not auto and mode_row and mode_row["approver_mode"] == "all":
        approved_by = {a["by"] for a in approvals}
        remaining = [e for e in (r["approvers"] or []) if e not in approved_by]
        if remaining and not p.is_admin:
            audit.audit_event(p.email, "access.approve_partial", "asset", r["asset_id"],
                              after={"request_id": request_id, "remaining": remaining}, request_id=p.request_id, cur=cur)
            return to_api(cur, _load(cur, request_id), p)
    cur.execute("""UPDATE access_request SET status = 'provisioning', decided_by = %s, decided_at = now(),
                      decision_reason = %s, updated_at = now() WHERE request_id = %s""",
                ("auto" if auto else p.email, reason, request_id))
    audit.audit_event("system:auto-approve" if auto else p.email, "access.approve", "asset", r["asset_id"],
                      after={"request_id": request_id, "provision_mode": body.get("provision_mode") or "grant_direct"},
                      request_id=p.request_id, cur=cur)
    r = _load(cur, request_id)
    return _provision(cur, r, asset, actor=p.email, provision_mode=body.get("provision_mode") or "grant_direct",
                      group=body.get("group"), user_token=user_token, request_id=p.request_id)


def retry(cur, request_id: int, *, p: authz.Principal, user_token: str | None = None) -> dict:
    r = _load(cur, request_id, lock=True)
    if r["status"] != "provision_failed":
        raise Conflict("Only a failed provisioning can be retried")
    authz.require(p.email in (r["approvers"] or []) or p.is_steward, "You are not an approver for this asset")
    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (r["asset_id"],))
    return _provision(cur, r, cur.fetchone(), actor=p.email, provision_mode=r["provision_mode"] or "grant_direct",
                      group=r.get("provision_group"), user_token=user_token, request_id=p.request_id)


def cancel(cur, request_id: int, *, p: authz.Principal) -> dict:
    r = _load(cur, request_id, lock=True)
    authz.require(r["requester_email"] == p.email or p.is_admin, "Only the requester can cancel a request")
    if r["status"] != "pending":
        raise Conflict(f"This request is {r['status']}")
    cur.execute("UPDATE access_request SET status = 'cancelled', updated_at = now() WHERE request_id = %s", (request_id,))
    audit.audit_event(p.email, "access.cancel", "asset", r["asset_id"], after={"request_id": request_id}, request_id=p.request_id, cur=cur)
    return to_api(cur, _load(cur, request_id), p)


def revoke(cur, grant_id: int, reason: str, *, p: authz.Principal, perms: dict, user_token: str | None = None) -> dict:
    cur.execute("SELECT * FROM access_grant WHERE grant_id = %s FOR UPDATE", (grant_id,))
    g = cur.fetchone()
    if not g:
        raise NotFound(f"grant {grant_id} not found")
    if g["revoked_at"]:
        raise Conflict("This grant is already revoked")
    authz.require(perms["can_manage_access"], "Only the asset's owners or approvers can revoke access")
    if not (reason or "").strip():
        raise ValueError("A reason is required to revoke access")
    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (g["asset_id"],))
    asset = cur.fetchone()
    result = provision.apply(provision.target(asset), g["principal"], g["principal_type"], g["privilege"],
                             user_token=user_token, revoke=True)
    if result.get("error"):
        raise Conflict(f"The platform refused the revoke: {result['error']}. Statement: {result.get('statement')}")
    cur.execute("UPDATE access_grant SET revoked_at = now(), revoked_by = %s WHERE grant_id = %s RETURNING *", (p.email, grant_id))
    out = cur.fetchone()
    if g.get("request_id"):
        cur.execute("UPDATE access_request SET status = 'revoked', updated_at = now() WHERE request_id = %s", (g["request_id"],))
    audit.audit_event(p.email, "access.revoke", "asset", g["asset_id"], before=g, after={"reason": reason, **result},
                      request_id=p.request_id, cur=cur)
    if "@" in g["principal"]:
        notify.queue(cur, g["principal"], "access_revoked", f"Access revoked: {asset['display_name']}", reason, g["asset_id"], g["request_id"])
    authz.invalidate_roles()
    return out


def sweep(cur) -> dict:
    """Reminders at day 3, expiry at day 7, grant-expiry reminders at T-14/T-3, and expired app grants revoked."""
    now = _now()
    cur.execute(
        """SELECT r.*, a.display_name FROM access_request r JOIN asset a ON a.asset_id = r.asset_id
            WHERE r.status = 'pending' AND r.reminded_at IS NULL AND r.created_at < %s""",
        (now - timedelta(days=REMINDER_AFTER_DAYS),),
    )
    reminded = 0
    for r in cur.fetchall():
        for email in r["approvers"] or []:
            notify.queue(cur, email, "access_request_reminder", f"Reminder: {r['requester_email']} is waiting for {r['display_name']}",
                         r["justification"], r["asset_id"], r["request_id"])
        cur.execute("UPDATE access_request SET reminded_at = now() WHERE request_id = %s", (r["request_id"],))
        reminded += 1
    cur.execute(
        """UPDATE access_request SET status = 'expired', updated_at = now()
            WHERE status = 'pending' AND request_expires_at < now() RETURNING request_id, requester_email, asset_id""")
    expired = cur.fetchall()
    for r in expired:
        notify.queue(cur, r["requester_email"], "access_request_expired", "Your access request expired without a decision",
                     "Resubmit it, or ask a steward to escalate.", r["asset_id"], r["request_id"])
        audit.audit_event("system:sweep", "access.expire", "asset", r["asset_id"], after={"request_id": r["request_id"]}, cur=cur)
    cur.execute(
        """SELECT g.*, a.display_name FROM access_grant g JOIN asset a ON a.asset_id = g.asset_id
            WHERE g.source = 'app' AND g.revoked_at IS NULL AND g.expires_at IS NOT NULL AND g.expires_at < now()""")
    revoked = 0
    for g in cur.fetchall():
        cur.execute("SELECT * FROM asset WHERE asset_id = %s", (g["asset_id"],))
        result = provision.apply(provision.target(cur.fetchone()), g["principal"], g["principal_type"], g["privilege"], revoke=True)
        if result.get("error"):
            continue
        cur.execute("UPDATE access_grant SET revoked_at = now(), revoked_by = 'system:expiry' WHERE grant_id = %s", (g["grant_id"],))
        audit.audit_event("system:sweep", "access.expire_grant", "asset", g["asset_id"], before=g, after=result, cur=cur)
        if "@" in g["principal"]:
            notify.queue(cur, g["principal"], "grant_expired", f"Access expired: {g['display_name']}", None, g["asset_id"], g["request_id"])
        revoked += 1
    return {"reminded": reminded, "expired_requests": len(expired), "expired_grants": revoked}
