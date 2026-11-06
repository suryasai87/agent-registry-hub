"""Email-registered consumers: subscriptions and usage registration.

Anyone who uses or subscribes to an agent, MCP server, tool or skill registers an email, plus optional team
addresses. This makes downstream impact computable: when the asset changes, these are the people notified
and asked to acknowledge.

A subscription records a DECLARED lineage edge: ``user:<email>`` subscribes to the asset. When the
subscriber names a downstream asset ("my agent uses this"), the edge is ``<downstream asset>`` uses the
asset. Every registered use writes a ``usage_event`` and an observed ``consumes`` edge.
"""
from __future__ import annotations

import re
from datetime import date

from core import audit
from core.guard import Conflict, Forbidden, NotFound
from registry import authz, graph, notify

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
KINDS = ("user", "team", "service_principal", "agent", "app")
PREFS = ("breaking_only", "all", "weekly_digest")
ENVS = ("prod", "staging", "dev")
OPERATIONS = ("invoke", "tool_call", "registered_use", "copied_endpoint", "playground")


def _email(value: str, what: str = "email") -> str:
    v = (value or "").strip().lower()
    if not EMAIL_RE.match(v):
        raise ValueError(f"A valid {what} is required (e.g. jane.doe@company.com)")
    return v


def _relation_for(asset_id: str) -> str:
    kind = graph.node_type(asset_id)
    return {"agent": "calls_agent", "mcp_server": "uses_mcp", "tool": "uses_tool", "skill": "uses_skill"}.get(kind, "consumes")


def to_api(cur, s: dict) -> dict:
    cur.execute("SELECT display_name, asset_type FROM asset WHERE asset_id = %s", (s["asset_id"],))
    a = cur.fetchone() or {}
    cur.execute(
        """SELECT EXISTS (SELECT 1 FROM access_grant g JOIN asset x ON x.asset_id = %s
                           WHERE g.asset_id IN (x.asset_id, x.parent_asset_id) AND g.revoked_at IS NULL
                             AND (g.principal = %s OR g.principal IN ('users','account users'))) AS has_access""",
        (s["asset_id"], s["subscriber_email"]),
    )
    return {
        **{k: s[k] for k in ("subscription_id", "asset_id", "subscriber_email", "subscriber_kind", "relationship",
                             "downstream_asset_id", "downstream_name", "use_case", "environment", "notify_pref", "status",
                             "created_by", "created_at", "last_ack_at")},
        "notify_emails": list(s["notify_emails"] or []),
        "asset_display_name": a.get("display_name", s["asset_id"]), "asset_type": a.get("asset_type", "agent"),
        "has_access": bool(cur.fetchone()["has_access"]),
    }


def ensure(cur, asset_id: str, email: str, *, created_by: str, use_case: str | None = None) -> dict:
    """Idempotent: an active direct-use subscription for ``email`` (used after an access approval)."""
    email = _email(email)
    cur.execute(
        """SELECT * FROM subscription WHERE asset_id = %s AND subscriber_email = %s AND status = 'active'
             AND downstream_asset_id IS NULL AND downstream_name IS NULL""",
        (asset_id, email),
    )
    row = cur.fetchone()
    if row:
        return row
    return _insert(cur, asset_id, {"subscriber_email": email, "use_case": use_case}, created_by=created_by)


def _insert(cur, asset_id: str, body: dict, *, created_by: str) -> dict:
    email = _email(body.get("subscriber_email"), "subscriber email")
    extra = sorted({_email(e, "team email") for e in (body.get("notify_emails") or []) if str(e).strip()} - {email})
    kind = body.get("subscriber_kind") or "user"
    pref = body.get("notify_pref") or "breaking_only"
    env = body.get("environment") or "prod"
    if kind not in KINDS or pref not in PREFS or env not in ENVS:
        raise ValueError("Invalid subscriber kind, notification preference or environment")
    downstream_id = body.get("downstream_asset_id") or None
    downstream_name = (body.get("downstream_name") or "").strip() or None
    if downstream_id:
        cur.execute("SELECT 1 FROM asset WHERE asset_id = %s", (downstream_id,))
        if not cur.fetchone():
            raise ValueError("The downstream asset isn't in the registry; describe it in free text instead")
        if downstream_id == asset_id:
            raise ValueError("An asset can't be its own downstream consumer")
    relationship = "via_downstream" if (downstream_id or downstream_name) else (body.get("relationship") or "direct_use")
    cur.execute(
        """INSERT INTO subscription (asset_id, subscriber_email, notify_emails, subscriber_kind, relationship,
                 downstream_asset_id, downstream_name, use_case, environment, notify_pref, created_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT DO NOTHING RETURNING *""",
        (asset_id, email, extra, kind, relationship, downstream_id, downstream_name,
         (body.get("use_case") or "").strip()[:500] or None, env, pref, created_by),
    )
    row = cur.fetchone()
    if not row:
        raise Conflict(f"{email} is already subscribed to this asset" + (" for that downstream use" if relationship == "via_downstream" else ""))
    graph.upsert_edge(cur, f"user:{email}", asset_id, "subscribes", "declared", "subscription",
                      attributes={"subscription_id": row["subscription_id"]})
    if downstream_id:
        graph.upsert_edge(cur, downstream_id, asset_id, _relation_for(asset_id), "declared", "subscription",
                          attributes={"declared_by": email})
    audit.audit_event(created_by, "subscription.create", "asset", asset_id,
                      after={"subscription_id": row["subscription_id"], "email": email, "notify_emails": extra,
                             "downstream": downstream_id or downstream_name, "pref": pref}, cur=cur)
    notify.queue(cur, email, "subscription_confirmed", "Subscribed: you'll be notified about changes",
                 f"Notification preference: {pref.replace('_', ' ')}", asset_id, row["subscription_id"])
    authz.invalidate_roles()
    return row


def subscribe(cur, asset_id: str, body: dict, *, p: authz.Principal) -> dict:
    cur.execute("SELECT lifecycle_status FROM asset WHERE asset_id = %s", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    if a["lifecycle_status"] == "retired":
        raise Conflict("This asset is retired")
    email = _email(body.get("subscriber_email"), "subscriber email")
    if email != p.email and not p.is_steward and body.get("subscriber_kind", "user") == "user":
        # Registering someone else is allowed for team/agent/app subscriptions (DLs, service accounts)
        # but a personal subscription must be your own address.
        raise Forbidden("Use your own email for a personal subscription, or choose Team / Agent / App")
    return to_api(cur, _insert(cur, asset_id, body, created_by=p.email))


def update(cur, subscription_id: int, patch: dict, *, p: authz.Principal) -> dict:
    cur.execute("SELECT * FROM subscription WHERE subscription_id = %s FOR UPDATE", (subscription_id,))
    s = cur.fetchone()
    if not s:
        raise NotFound("subscription not found")
    authz.require(p.email in (s["subscriber_email"], s["created_by"]) or p.is_steward, "This isn't your subscription")
    sets, vals = [], []
    if "notify_pref" in patch:
        if patch["notify_pref"] not in PREFS:
            raise ValueError("Invalid notification preference")
        sets.append("notify_pref = %s"); vals.append(patch["notify_pref"])
    if "notify_emails" in patch:
        sets.append("notify_emails = %s")
        vals.append(sorted({_email(e, "team email") for e in patch["notify_emails"] if str(e).strip()}))
    if "use_case" in patch:
        sets.append("use_case = %s"); vals.append((patch["use_case"] or "").strip()[:500] or None)
    if "environment" in patch:
        if patch["environment"] not in ENVS:
            raise ValueError("Invalid environment")
        sets.append("environment = %s"); vals.append(patch["environment"])
    if not sets:
        raise ValueError("Nothing to update")
    cur.execute(f"UPDATE subscription SET {', '.join(sets)}, updated_at = now() WHERE subscription_id = %s RETURNING *",
                [*vals, subscription_id])
    row = cur.fetchone()
    audit.audit_event(p.email, "subscription.update", "asset", s["asset_id"], before={k: s[k] for k in ("notify_pref", "notify_emails")},
                      after=patch, request_id=p.request_id, cur=cur)
    return to_api(cur, row)


def unsubscribe(cur, subscription_id: int, *, p: authz.Principal) -> dict:
    cur.execute("SELECT * FROM subscription WHERE subscription_id = %s FOR UPDATE", (subscription_id,))
    s = cur.fetchone()
    if not s or s["status"] != "active":
        raise NotFound("active subscription not found")
    authz.require(p.email in (s["subscriber_email"], s["created_by"]) or p.is_steward, "This isn't your subscription")
    cur.execute("UPDATE subscription SET status = 'unsubscribed', updated_at = now() WHERE subscription_id = %s", (subscription_id,))
    cur.execute("DELETE FROM lineage_edge WHERE src_id = %s AND dst_id = %s AND relation = 'subscribes'",
                (f"user:{s['subscriber_email']}", s["asset_id"]))
    audit.audit_event(p.email, "subscription.cancel", "asset", s["asset_id"], before={"subscription_id": subscription_id},
                      request_id=p.request_id, cur=cur)
    authz.invalidate_roles()
    return {"ok": True}


def for_asset(cur, asset_id: str) -> dict:
    cur.execute("SELECT * FROM subscription WHERE asset_id = %s AND status = 'active' ORDER BY created_at DESC", (asset_id,))
    subs = [to_api(cur, s) for s in cur.fetchall()]
    emails = {s["subscriber_email"] for s in subs}
    since = date.fromordinal(date.today().toordinal() - 30)
    cur.execute(
        """SELECT requester, max(requester_kind) AS requester_kind, sum(requests)::bigint AS requests_30d, max(day) AS last_seen
             FROM usage_daily WHERE asset_id = %s AND day >= %s GROUP BY requester ORDER BY 3 DESC LIMIT 200""",
        (asset_id, since),
    )
    unregistered = [
        {**r, "requests_30d": int(r["requests_30d"]), "last_seen": r["last_seen"].isoformat()}
        for r in cur.fetchall() if r["requester"].lower() not in emails
    ]
    return {"subscribers": subs, "unregistered": unregistered}


def mine(cur, email: str) -> list[dict]:
    cur.execute("SELECT * FROM subscription WHERE (subscriber_email = %s OR %s = ANY(notify_emails)) AND status = 'active' ORDER BY created_at DESC",
                (email, email))
    return [to_api(cur, s) for s in cur.fetchall()]


def nudge(cur, asset_id: str, requesters: list[str], *, p: authz.Principal, perms: dict) -> dict:
    authz.require(perms["can_manage_access"] or perms["can_edit"], "Only the asset's owners can nudge consumers")
    cur.execute("SELECT display_name FROM asset WHERE asset_id = %s", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound("asset not found")
    sent = 0
    for r in requesters[:200]:
        if EMAIL_RE.match((r or "").lower()):
            sent += notify.queue(cur, r, "unregistered_consumer",
                                 f"You use {a['display_name']}. Register your email so you hear about changes",
                                 f"{p.email} asks consumers to subscribe so they're notified before breaking changes.", asset_id)
    audit.audit_event(p.email, "subscription.nudge", "asset", asset_id, after={"requesters": requesters[:200]}, request_id=p.request_id, cur=cur)
    return {"ok": True, "notified": sent}


def register_usage(cur, body: dict, *, actor: str, origin: str = "api") -> dict:
    """POST /api/v1/usage and the UI "use" actions: every use carries the consumer's email."""
    asset_id = body.get("asset_id")
    cur.execute("SELECT asset_id FROM asset WHERE asset_id = %s", (asset_id,))
    if not cur.fetchone():
        raise NotFound(f"asset {asset_id} not found")
    email = _email(body.get("consumer_email"), "consumer email")
    op = body.get("operation") or "registered_use"
    if op not in OPERATIONS:
        raise ValueError(f"operation must be one of {', '.join(OPERATIONS)}")
    via = body.get("via_asset_id") or None
    cur.execute(
        """INSERT INTO usage_event (asset_id, consumer_email, consumer_kind, via_asset_id, operation, client, request_id,
                 status, latency_ms, input_tokens, output_tokens, note, origin)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING event_id""",
        (asset_id, email, body.get("consumer_kind") or "user", via, op, (body.get("client") or origin)[:60],
         (body.get("request_id") or None), (body.get("status") or "ok")[:20], body.get("latency_ms"),
         body.get("input_tokens"), body.get("output_tokens"), (body.get("note") or "")[:500] or None, origin),
    )
    event_id = cur.fetchone()["event_id"]
    cur.execute(
        """INSERT INTO usage_daily (day, asset_id, requester, requester_kind, source, requests, errors, input_tokens, output_tokens)
           VALUES (current_date, %s, %s, %s, 'registry_events', 1, %s, coalesce(%s,0), coalesce(%s,0))
           ON CONFLICT (day, asset_id, requester, source, tool_name) DO UPDATE
              SET requests = usage_daily.requests + 1, errors = usage_daily.errors + EXCLUDED.errors,
                  input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
                  output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens""",
        (asset_id, email, body.get("consumer_kind") or "user", 0 if (body.get("status") or "ok") == "ok" else 1,
         body.get("input_tokens"), body.get("output_tokens")),
    )
    graph.upsert_edge(cur, f"user:{email}", asset_id, "consumes", "observed", "usage_event")
    if via:
        graph.upsert_edge(cur, via, asset_id, _relation_for(asset_id), "observed", "usage_event")
    if op in ("registered_use", "copied_endpoint"):
        audit.audit_event(actor, f"usage.{op}", "asset", asset_id, after={"consumer_email": email, "event_id": event_id}, cur=cur)
    return {"ok": True, "event_id": event_id}
