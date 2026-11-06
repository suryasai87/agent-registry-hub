"""Catalog reads: filtered + faceted asset lists and the AssetCard shape (see docs/API_CONTRACT.md)."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from core import identity
from registry import coverage

FACETS = ("asset_type", "source", "platform", "lifecycle_status", "certification", "sensitivity", "risk_tier")
FILTER_TO_COLUMN = {
    "type": "asset_type", "source": "source", "platform": "platform", "status": "lifecycle_status",
    "certification": "certification", "sensitivity": "sensitivity", "risk": "risk_tier",
}
SORTS = {
    "relevance": "rank DESC, req30 DESC, a.display_name",
    "name": "a.display_name",
    "requests": "req30 DESC, a.display_name",
    "cost": "usd30 DESC, a.display_name",
    "changed": "changed_at DESC NULLS LAST, a.display_name",
}
EVERYONE_GROUPS = ("users", "account users")
PURPOSE_SQL = """(SELECT coalesce(f.override_value, f.source_value) #>> '{}' FROM asset_field f
                   WHERE f.asset_id = a.asset_id AND f.field_key = 'purpose')"""


def _where(filters: dict, viewer: str, skip: str | None = None, pfx: str = "") -> tuple[list[str], dict]:
    """WHERE clauses + params. ``pfx`` namespaces the placeholders so several clause sets share one statement."""
    clauses: list[str] = ["a.lifecycle_status <> 'retired'"]
    params: dict[str, Any] = {f"{pfx}viewer": viewer}
    for key, column in FILTER_TO_COLUMN.items():
        values = filters.get(key)
        if not values or column == skip:
            continue
        params[f"{pfx}{key}"] = values if isinstance(values, list) else [v for v in str(values).split(",") if v]
        clauses.append(f"a.{column} = ANY(%({pfx}{key})s)")
    if filters.get("q"):
        params[f"{pfx}q"] = filters["q"].strip()
        params[f"{pfx}qlike"] = f"%{params[pfx + 'q']}%"
        clauses.append(f"""(a.search @@ plainto_tsquery('simple', %({pfx}q)s) OR a.display_name ILIKE %({pfx}qlike)s
                            OR a.asset_id ILIKE %({pfx}qlike)s OR {PURPOSE_SQL} ILIKE %({pfx}qlike)s)""")
    if filters.get("owner"):
        params[f"{pfx}owner"] = viewer if filters["owner"] == "me" else filters["owner"].lower()
        clauses.append(f"EXISTS (SELECT 1 FROM asset_owner o WHERE o.asset_id = a.asset_id AND o.email = %({pfx}owner)s)")
    if filters.get("tag"):
        params[f"{pfx}tag"] = filters["tag"]
        clauses.append(f"%({pfx}tag)s = ANY(a.tags)")
    if filters.get("parent"):
        params[f"{pfx}parent"] = filters["parent"]
        clauses.append(f"a.parent_asset_id = %({pfx}parent)s")
    if str(filters.get("ownerless", "")).lower() == "true":
        clauses.append("NOT EXISTS (SELECT 1 FROM asset_owner o WHERE o.asset_id = a.asset_id AND o.kind IN ('owner','co_owner'))")
    if filters.get("changed_days"):
        params[f"{pfx}changed_since"] = date.today() - timedelta(days=int(filters["changed_days"]))
        clauses.append(f"EXISTS (SELECT 1 FROM change_event c WHERE c.asset_id = a.asset_id AND c.created_at >= %({pfx}changed_since)s)")
    if filters.get("asset_ids"):
        params[f"{pfx}asset_ids"] = list(filters["asset_ids"])
        clauses.append(f"a.asset_id = ANY(%({pfx}asset_ids)s)")
    rel = filters.get("rel")
    if rel == "subscribed":
        clauses.append(f"EXISTS (SELECT 1 FROM subscription s WHERE s.asset_id = a.asset_id AND s.subscriber_email = %({pfx}viewer)s AND s.status = 'active')")
    elif rel == "requested":
        clauses.append(f"EXISTS (SELECT 1 FROM access_request r WHERE r.asset_id = a.asset_id AND r.requester_email = %({pfx}viewer)s AND r.status IN ('pending','provisioning'))")
    elif rel == "owned":
        clauses.append(f"EXISTS (SELECT 1 FROM asset_owner o WHERE o.asset_id = a.asset_id AND o.email = %({pfx}viewer)s)")
    elif rel == "access":
        clauses.append(f"""EXISTS (SELECT 1 FROM access_grant g WHERE g.asset_id IN (a.asset_id, a.parent_asset_id)
                           AND g.revoked_at IS NULL AND (g.principal = %({pfx}viewer)s OR g.principal = ANY(%({pfx}everyone)s)))""")
        params[f"{pfx}everyone"] = list(EVERYONE_GROUPS)
    return clauses, params


def catalog(cur, filters: dict, viewer: str, page: int = 1, page_size: int = 24) -> dict:
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 24), 100))
    sort = SORTS.get(filters.get("sort") or "relevance", SORTS["relevance"])
    clauses, params = _where(filters, viewer)
    since = date.today() - timedelta(days=30)
    params.update({"since": since, "limit": page_size, "offset": (page - 1) * page_size})
    rank = "ts_rank(a.search, plainto_tsquery('simple', %(q)s))" if params.get("q") else "0"
    cur.execute(
        f"""
        WITH u AS (SELECT asset_id, sum(requests) AS req FROM usage_daily WHERE day >= %(since)s GROUP BY asset_id),
             c AS (SELECT asset_id, sum(usd) AS usd FROM cost_daily WHERE day >= %(since)s GROUP BY asset_id),
             ch AS (SELECT asset_id, max(created_at) AS changed_at FROM change_event GROUP BY asset_id)
        SELECT a.asset_id, count(*) OVER () AS total, {rank} AS rank,
               coalesce(u.req, 0) AS req30, coalesce(c.usd, 0) AS usd30, ch.changed_at
          FROM asset a
          LEFT JOIN u ON u.asset_id = a.asset_id
          LEFT JOIN c ON c.asset_id = a.asset_id
          LEFT JOIN ch ON ch.asset_id = a.asset_id
         WHERE {' AND '.join(clauses)}
         ORDER BY {sort}
         LIMIT %(limit)s OFFSET %(offset)s
        """,
        params,
    )
    rows = cur.fetchall()
    total = int(rows[0]["total"]) if rows else 0
    if not rows and page > 1:
        cur.execute(f"SELECT count(*) AS n FROM asset a WHERE {' AND '.join(clauses)}", params)
        total = int(cur.fetchone()["n"])
    items = cards(cur, [r["asset_id"] for r in rows], viewer)
    return {"items": items, "total": total, "page": page, "page_size": page_size, "facets": facets(cur, filters, viewer)}


def facets(cur, filters: dict, viewer: str) -> dict:
    """Counts per facet value, each computed with every filter except its own dimension."""
    parts, params = [], {}
    for i, column in enumerate(FACETS):
        clauses, p = _where(filters, viewer, skip=column, pfx=f"f{i}_")
        params.update(p)
        parts.append(f"SELECT '{column}' AS facet, a.{column}::text AS value, count(*) AS n FROM asset a "
                     f"WHERE {' AND '.join(clauses)} GROUP BY 2")
    cur.execute(" UNION ALL ".join(parts), params)
    out: dict[str, dict[str, int]] = {f: {} for f in FACETS}
    for r in cur.fetchall():
        out[r["facet"]][r["value"]] = int(r["n"])
    return out


def cards(cur, asset_ids: list[str], viewer: str) -> list[dict]:
    """AssetCard dicts for ``asset_ids``, in the given order."""
    if not asset_ids:
        return []
    since30 = date.today() - timedelta(days=30)
    since14 = date.today() - timedelta(days=13)
    p = {"ids": asset_ids, "since30": since30, "since14": since14, "viewer": viewer, "everyone": list(EVERYONE_GROUPS)}
    cur.execute(
        f"""
        SELECT a.*, {PURPOSE_SQL} AS purpose, pa.display_name AS parent_display_name,
               (SELECT count(*) FROM asset t WHERE t.parent_asset_id = a.asset_id AND t.lifecycle_status <> 'retired') AS tools_count,
               (SELECT count(*) FROM subscription s WHERE s.asset_id = a.asset_id AND s.status = 'active') AS subscribers,
               (SELECT max(created_at) FROM change_event c WHERE c.asset_id = a.asset_id) AS last_changed_at,
               EXISTS (SELECT 1 FROM subscription s WHERE s.asset_id = a.asset_id AND s.subscriber_email = %(viewer)s AND s.status = 'active') AS my_subscribed,
               EXISTS (SELECT 1 FROM access_request r WHERE r.asset_id = a.asset_id AND r.requester_email = %(viewer)s AND r.status IN ('pending','provisioning')) AS my_requested,
               EXISTS (SELECT 1 FROM access_grant g WHERE g.asset_id IN (a.asset_id, a.parent_asset_id) AND g.revoked_at IS NULL
                        AND (g.principal = %(viewer)s OR g.principal = ANY(%(everyone)s))) AS my_access
          FROM asset a LEFT JOIN asset pa ON pa.asset_id = a.parent_asset_id
         WHERE a.asset_id = ANY(%(ids)s)
        """,
        p,
    )
    base = {r["asset_id"]: r for r in cur.fetchall()}
    cur.execute(
        """SELECT asset_id, day, sum(requests) AS req, sum(errors) AS err FROM usage_daily
            WHERE asset_id = ANY(%(ids)s) AND day >= %(since30)s GROUP BY asset_id, day""",
        p,
    )
    usage: dict[str, dict] = {}
    for r in cur.fetchall():
        u = usage.setdefault(r["asset_id"], {"req": 0, "err": 0, "days": {}})
        u["req"] += int(r["req"])
        u["err"] += int(r["err"])
        u["days"][r["day"]] = int(r["req"])
    cur.execute(
        """SELECT asset_id, count(DISTINCT requester) AS users FROM usage_daily
            WHERE asset_id = ANY(%(ids)s) AND day >= %(since30)s GROUP BY asset_id""",
        p,
    )
    users = {r["asset_id"]: int(r["users"]) for r in cur.fetchall()}
    cur.execute("SELECT asset_id, sum(usd)::float AS usd FROM cost_daily WHERE asset_id = ANY(%(ids)s) AND day >= %(since30)s GROUP BY asset_id", p)
    cost = {r["asset_id"]: float(r["usd"] or 0) for r in cur.fetchall()}
    cur.execute("SELECT asset_id, email, kind, source FROM asset_owner WHERE asset_id = ANY(%(ids)s) ORDER BY kind, email", p)
    owners: dict[str, list[dict]] = {}
    for r in cur.fetchall():
        owners.setdefault(r["asset_id"], []).append({**r, "display_name": identity.display_name(r["email"])})
    cur.execute("""SELECT asset_id, avg(mean_value)::float AS score FROM eval_result
                    WHERE asset_id = ANY(%(ids)s) AND mean_value IS NOT NULL AND run_at >= now() - interval '30 days'
                    GROUP BY asset_id""", p)
    evals = {r["asset_id"]: round(r["score"], 3) for r in cur.fetchall()}
    cov = coverage.for_assets(cur, list(base.values()))
    days14 = [since14 + timedelta(days=i) for i in range(14)]
    out = []
    for aid in asset_ids:
        a = base.get(aid)
        if not a:
            continue
        u = usage.get(aid, {"req": 0, "err": 0, "days": {}})
        own = owners.get(aid, [])
        c = cov.get(aid, {"pct": 0, "shield": "none"})
        out.append({
            "asset_id": aid, "asset_type": a["asset_type"], "subtype": a["subtype"], "display_name": a["display_name"],
            "name": a["name"], "source": a["source"], "platform": a["platform"], "publisher": a["publisher"],
            "lifecycle_status": a["lifecycle_status"], "runtime_status": a["runtime_status"],
            "certification": a["certification"], "sensitivity": a["sensitivity"], "risk_tier": a["risk_tier"],
            "domain": a["domain"], "tags": list(a["tags"] or []), "purpose": a["purpose"],
            "owners": [{"email": o["email"], "kind": o["kind"], "source": o["source"], "display_name": o["display_name"]} for o in own],
            "kpi": {
                "requests_30d": u["req"], "users_30d": users.get(aid, 0), "cost_30d_usd": round(cost.get(aid, 0.0), 2),
                "error_rate": round(u["err"] / u["req"], 4) if u["req"] else None,
                "spark": [u["days"].get(d, 0) for d in days14],
            },
            "policy_shield": c["shield"], "coverage_pct": c["pct"],
            "subscribers": int(a["subscribers"]), "tools_count": int(a["tools_count"]),
            "my": {"has_access": bool(a["my_access"]), "requested": bool(a["my_requested"]),
                   "subscribed": bool(a["my_subscribed"]), "owner": any(o["email"] == viewer for o in own)},
            "parent_asset_id": a["parent_asset_id"], "parent_display_name": a["parent_display_name"],
            "last_changed_at": a["last_changed_at"], "deep_link": a["deep_link"], "origin": a["origin"],
            "published_version": a["published_version"], "latest_version": a["latest_version"], "eval_score": evals.get(aid),
        })
    return out


def card(cur, asset_id: str, viewer: str) -> dict | None:
    found = cards(cur, [asset_id], viewer)
    return found[0] if found else None
