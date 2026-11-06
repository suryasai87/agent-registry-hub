"""Home (role-aware top actions), /api/me counts, command-palette search, and the asset detail assembly."""
from __future__ import annotations

from datetime import date, timedelta
from urllib.parse import quote

from core import identity
from core.guard import NotFound
from registry import access, authz, cards, changes, fields

def asset_href(asset_id: str) -> str:
    """The SPA route of an asset page (mirrors frontend lib/assets.ts assetHref)."""
    return f"/assets/{quote(asset_id, safe='')}"


def also_registered_in(column: list | None, field: dict | None) -> list[dict]:
    """Registrations kept on the asset row (manual / other registries) plus the effective synced field value
    (Microsoft Agent 365, with any steward override applied), de-duplicated by (registry, id)."""
    out: dict[tuple, dict] = {}
    for item in [*(column or []), *((field or {}).get("value") or [])]:
        if isinstance(item, dict) and item.get("registry") and item.get("id"):
            out.setdefault((item["registry"], str(item["id"])), item)
    return list(out.values())


TAB_ORDER = ("overview", "tools", "access", "usage", "traces", "evals", "policies", "lineage", "changes", "subscribers", "audit")


def me(cur, p: authz.Principal) -> dict:
    cur.execute("""
        SELECT (SELECT count(DISTINCT asset_id) FROM asset_owner WHERE email = %(e)s) AS owned,
               (SELECT count(*) FROM subscription WHERE subscriber_email = %(e)s AND status = 'active') AS subscriptions,
               (SELECT count(*) FROM access_request WHERE status = 'pending' AND %(e)s = ANY(approvers)) AS pending_approvals,
               (SELECT count(*) FROM access_request WHERE requester_email = %(e)s AND status IN ('pending','provisioning','provision_failed')) AS my_open_requests,
               (SELECT count(*) FROM notification WHERE recipient_email = %(e)s AND channel = 'in_app' AND read_at IS NULL) AS unread_notifications,
               (SELECT count(*) FROM impact_item WHERE email = %(e)s AND ack_status = 'pending') AS unacked_impacts
    """, {"e": p.email})
    counts = {k: int(v) for k, v in (cur.fetchone() or {}).items()}
    if p.is_steward:
        cur.execute("SELECT count(*) AS n FROM access_request WHERE status = 'pending'")
        counts["pending_approvals"] = max(counts.get("pending_approvals", 0), int(cur.fetchone()["n"]))
    roles = sorted(p.roles, key=authz.ROLE_ORDER.index)
    return {"email": p.email, "display_name": p.display_name, "roles": roles, "primary_role": p.primary_role,
            "view_as": p.view_as, "is_admin": "admin" in p.actual_roles, "is_steward": p.is_steward, "is_auditor": p.is_auditor,
            "counts": counts}


def home(cur, p: authz.Principal) -> dict:
    since = date.today() - timedelta(days=30)
    cur.execute("""
        SELECT count(*) FILTER (WHERE asset_type = 'agent') AS agents, count(*) FILTER (WHERE asset_type = 'mcp_server') AS mcp_servers,
               count(*) FILTER (WHERE asset_type = 'tool') AS tools, count(*) FILTER (WHERE asset_type = 'skill') AS skills,
               count(*) FILTER (WHERE asset_type IN ('agent','mcp_server') AND NOT EXISTS (
                   SELECT 1 FROM asset_owner o WHERE o.asset_id = asset.asset_id AND o.kind IN ('owner','co_owner'))) AS ownerless
          FROM asset WHERE lifecycle_status NOT IN ('retired','rejected')""")
    k = cur.fetchone()
    cur.execute("SELECT count(DISTINCT subscriber_email) AS n FROM subscription WHERE status = 'active'")
    subs = int(cur.fetchone()["n"])
    cur.execute("SELECT coalesce(sum(requests),0)::bigint AS n FROM usage_daily WHERE day >= %s", (since,))
    req = int(cur.fetchone()["n"])
    cur.execute("SELECT coalesce(sum(usd),0)::float AS n FROM cost_daily WHERE day >= %s", (since,))
    cost = float(cur.fetchone()["n"])
    from registry.usage import governed_traffic_pct
    m = me(cur, p)["counts"]
    actions = []

    def act(kind, label, count, href, severity="info"):
        if count:
            actions.append({"kind": kind, "label": label, "count": int(count), "href": href, "severity": severity})

    act("approvals", "Access requests waiting for you", m["pending_approvals"], "/requests", "warning")
    act("impacts", "Changes that affect you, awaiting acknowledgement", m["unacked_impacts"], "/me?tab=impacts", "critical")
    act("requests", "Your open access requests", m["my_open_requests"], "/me?tab=requests")
    cur.execute("SELECT count(*) AS n FROM access_grant WHERE principal = %s AND revoked_at IS NULL AND expires_at < now() + interval '14 days'",
                (p.email,))
    act("expiring", "Your access expiring within 14 days", cur.fetchone()["n"], "/me?tab=access", "warning")
    if "owner" in p.roles:
        cur.execute("""SELECT count(DISTINCT a.asset_id) AS n FROM asset a JOIN asset_owner o ON o.asset_id = a.asset_id AND o.email = %s
                        WHERE NOT EXISTS (SELECT 1 FROM asset_field f WHERE f.asset_id = a.asset_id AND f.field_key = 'purpose'
                                            AND coalesce(f.override_value, f.source_value) IS NOT NULL)""", (p.email,))
        act("describe", "Assets you own without a documented purpose", cur.fetchone()["n"], "/catalog?owner=me", "info")
    if p.is_steward:
        act("ownerless", "Agents and MCP servers without an owner", k["ownerless"], "/governance?tab=curation", "warning")
        cur.execute("SELECT count(*) AS n FROM asset WHERE lifecycle_status IN ('discovered','pending_approval')")
        act("curation", "Assets awaiting curation", cur.fetchone()["n"], "/governance?tab=curation")
        cur.execute("SELECT count(*) AS n FROM asset_field WHERE drift")
        act("drift", "Overridden fields whose source changed", cur.fetchone()["n"], "/governance?tab=overrides", "warning")
    if p.is_admin:
        cur.execute("SELECT to_regclass('update_candidate') IS NOT NULL AS ok")
        if cur.fetchone()["ok"]:
            cur.execute("""SELECT count(*) FILTER (WHERE status = 'passed') AS ready,
                                  count(*) FILTER (WHERE status IN ('failed','apply_failed')) AS failed,
                                  count(*) FILTER (WHERE status = 'passed' AND breaking) AS breaking
                             FROM update_candidate""")
            u = cur.fetchone()
            act("updates_breaking", "Platform updates with breaking changes awaiting your decision", u["breaking"], "/platform-updates", "critical")
            act("updates_ready", "Platform updates passed regression: accept or delay", int(u["ready"]) - int(u["breaking"]), "/platform-updates", "warning")
            act("updates_failed", "Platform updates failed regression on a Lakebase branch", u["failed"], "/platform-updates", "critical")
    cur.execute("""SELECT asset_id FROM usage_daily WHERE day >= %s GROUP BY asset_id ORDER BY sum(requests) DESC LIMIT 6""", (since,))
    trending = cards.cards(cur, [r["asset_id"] for r in cur.fetchall()], p.email)
    cur.execute("SELECT asset_id FROM subscription WHERE subscriber_email = %s AND status = 'active' ORDER BY created_at DESC LIMIT 6", (p.email,))
    mine = cards.cards(cur, list(dict.fromkeys(r["asset_id"] for r in cur.fetchall())), p.email)
    recent = changes.feed(cur, viewer=p.email, days=30, limit=8)
    recent.sort(key=lambda c: (not c["breaking"], c["created_at"]), reverse=False)
    cur.execute("SELECT max(finished_at) AS at, (array_agg(status ORDER BY started_at DESC))[1] AS status FROM sync_run")
    s = cur.fetchone() or {}
    return {
        "kpis": {"agents": int(k["agents"]), "mcp_servers": int(k["mcp_servers"]), "tools": int(k["tools"]), "skills": int(k["skills"]),
                 "subscribers": subs, "requests_30d": req, "cost_30d_usd": round(cost, 2),
                 "governed_pct": governed_traffic_pct(cur, since), "ownerless": int(k["ownerless"])},
        "top_actions": actions, "my_subscriptions": mine, "recent_changes": recent, "trending": trending,
        "sync": {"last_run_at": s.get("at").isoformat() if s.get("at") else None, "status": s.get("status")},
    }


def search(cur, q: str, viewer: str) -> list[dict]:
    q = (q or "").strip()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    cur.execute(f"""
        SELECT a.asset_id, a.display_name, a.asset_type, a.subtype, a.publisher,
               ts_rank(a.search, plainto_tsquery('simple', %(q)s)) AS rank
          FROM asset a
         WHERE a.lifecycle_status <> 'retired'
           AND (a.search @@ plainto_tsquery('simple', %(q)s) OR a.display_name ILIKE %(like)s OR a.asset_id ILIKE %(like)s
                OR {cards.PURPOSE_SQL} ILIKE %(like)s)
         ORDER BY (a.display_name ILIKE %(prefix)s) DESC, rank DESC, a.asset_type, a.display_name LIMIT 15""",
                {"q": q, "like": like, "prefix": f"{q}%"})
    hits = [{"kind": "asset", "id": r["asset_id"], "label": r["display_name"],
             "sublabel": " · ".join(filter(None, [r["asset_type"].replace("_", " "), r["publisher"]])),
             "href": asset_href(r["asset_id"]), "asset_type": r["asset_type"]} for r in cur.fetchall()]
    cur.execute("SELECT DISTINCT email FROM asset_owner WHERE email ILIKE %s ORDER BY email LIMIT 5", (like,))
    hits += [{"kind": "person", "id": r["email"], "label": identity.display_name(r["email"]), "sublabel": r["email"],
              "href": f"/catalog?owner={r['email']}"} for r in cur.fetchall()]
    return hits


def asset_detail(cur, asset_id: str, p: authz.Principal) -> dict:
    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    card = cards.card(cur, asset_id, p.email)
    flds = fields.list_fields(cur, asset_id)
    perms = authz.asset_permissions(cur, p, asset_id)
    cur.execute("SELECT version, status, source, created_by, created_at FROM asset_version WHERE asset_id = %s ORDER BY created_at DESC LIMIT 50",
                (asset_id,))
    versions = list(cur.fetchall())
    parent = cards.card(cur, a["parent_asset_id"], p.email) if a["parent_asset_id"] else None
    cur.execute("SELECT EXISTS (SELECT 1 FROM asset_experiment WHERE asset_id = %s) AS exp, EXISTS (SELECT 1 FROM eval_result WHERE asset_id = %s) AS ev",
                (asset_id, asset_id))
    q = cur.fetchone()
    tabs = ["overview", "tools", "access", "usage"]
    if a["asset_type"] == "agent" and (q["exp"] or q["ev"]):
        tabs += ["traces", "evals"]
    if a["asset_type"] == "skill":
        tabs.remove("tools")
    tabs += ["policies", "lineage", "changes", "subscribers", "audit"]
    if a["asset_type"] == "tool" and a["parent_asset_id"]:
        tabs.remove("subscribers")  # tools inherit subscribers from their MCP server
    attrs = dict(a["attributes"] or {})
    attrs.pop("environment_vars", None)
    also_field = fields.system_field(cur, asset_id, "also_registered_in")
    return {
        "asset": {**card, "attributes": attrs, "external_ref": a["external_ref"] or {},
                  "also_registered_in": also_registered_in(a["also_registered_in"], also_field),
                  "also_registered_in_field": also_field, "published_version": a["published_version"],
                  "latest_version": a["latest_version"], "first_seen_at": a["first_seen_at"], "last_synced_at": a["last_synced_at"],
                  "source_created_at": a["source_created_at"], "created_by": a["created_by"],
                  "completeness_pct": fields.completeness(flds)},
        "fields": flds, "versions": versions, "parent": parent, "tabs": [t for t in TAB_ORDER if t in tabs],
        "permissions": {k: v for k, v in perms.items() if k != "is_owner"},
        "access_settings": access.settings(cur, a),
    }
