"""Usage & cost views (per asset and fleet), budgets and anomaly flags.

Sources, pre-aggregated into Lakebase by the collectors:
* requests/tokens: ``system.ai_gateway.usage`` (FMAPI + MCP), ``system.serving.endpoint_usage``, audit
  (mcpService / managedMcp / skillLoad), plus registry ``usage_event`` (email-registered use);
* cost: ``system.billing.usage`` × ``system.billing.list_prices`` (list price, an estimate).
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from statistics import median

from core import audit
from core.guard import NotFound
from registry import authz, coverage

SOURCE_NOTES = {
    "ai_gateway_usage": "system.ai_gateway.usage (Unity AI Gateway: FMAPI + MCP traffic)",
    "endpoint_usage": "system.serving.endpoint_usage ⋈ served_entities (endpoints with usage tracking on)",
    "audit_mcp_call": "system.access.audit mcpService.mcpCall (external MCP through UC connections)",
    "audit_managed_mcp": "system.access.audit managedMcp.mcpRequest (managed UC-function / Genie MCP)",
    "audit_skill_load": "system.access.audit aiGatewaySkills.skillLoad",
    "registry_events": "Registry usage registrations (email-identified)",
    "billing_usage": "system.billing.usage × list_prices (list price, estimate)",
    "external_model_spend": "system.ai_gateway.external_model_spend (USD, estimate)",
    "demo": "Demo data (labelled)",
}


def _days(days: int) -> tuple[date, list[date]]:
    days = max(1, min(int(days or 30), 180))
    start = date.today() - timedelta(days=days - 1)
    return start, [start + timedelta(days=i) for i in range(days)]


def budget_state(cur, asset_id: str) -> dict | None:
    cur.execute("SELECT * FROM budget WHERE asset_id = %s", (asset_id,))
    b = cur.fetchone()
    if not b:
        return None
    today = date.today()
    first = today.replace(day=1)
    cur.execute("SELECT coalesce(sum(usd),0)::float AS usd FROM cost_daily WHERE asset_id = %s AND day >= %s", (asset_id, first))
    mtd = float(cur.fetchone()["usd"])
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    forecast = mtd / today.day * days_in_month if today.day else mtd
    limit = float(b["monthly_usd"])
    state = "exceeded" if mtd >= limit else ("at_risk" if forecast >= limit * b["alert_pct"] / 100 else "on_track")
    return {"monthly_usd": limit, "alert_pct": b["alert_pct"], "action": b["action"], "source": b["source"],
            "mtd_usd": round(mtd, 2), "forecast_usd": round(forecast, 2), "state": state}


def set_budget(cur, asset_id: str, body: dict, *, p: authz.Principal, perms: dict) -> dict:
    authz.require(perms["can_edit"] or p.is_steward, "Only the asset's owners or a steward can set a budget")
    monthly = float(body.get("monthly_usd") or 0)
    if monthly <= 0:
        raise ValueError("monthly_usd must be positive")
    alert = int(body.get("alert_pct") or 80)
    action = body.get("action") or "alert"
    if action not in ("alert", "block"):
        raise ValueError("action must be alert or block")
    cur.execute(
        """INSERT INTO budget (asset_id, monthly_usd, alert_pct, action, source, set_by) VALUES (%s,%s,%s,%s,'app',%s)
           ON CONFLICT (asset_id) DO UPDATE SET monthly_usd = EXCLUDED.monthly_usd, alert_pct = EXCLUDED.alert_pct,
                  action = EXCLUDED.action, set_by = EXCLUDED.set_by, set_at = now()""",
        (asset_id, monthly, alert, action, p.email),
    )
    audit.audit_event(p.email, "budget.set", "asset", asset_id, after={"monthly_usd": monthly, "alert_pct": alert, "action": action},
                      request_id=p.request_id, cur=cur)
    return budget_state(cur, asset_id)


def anomalies(cur, asset_ids: list[str] | None = None, lookback: int = 30) -> list[dict]:
    """Days where cost or requests exceed 2× the trailing 14-day median (min baseline to avoid noise)."""
    since = date.today() - timedelta(days=lookback + 14)
    where = "AND asset_id = ANY(%(ids)s)" if asset_ids else ""
    cur.execute(
        f"""SELECT asset_id, day, sum(requests)::float AS req, sum(errors)::float AS err FROM usage_daily
             WHERE day >= %(since)s {where} GROUP BY asset_id, day""", {"since": since, "ids": asset_ids})
    series: dict[tuple[str, str], dict[date, float]] = {}
    for r in cur.fetchall():
        series.setdefault((r["asset_id"], "requests"), {})[r["day"]] = r["req"]
        series.setdefault((r["asset_id"], "errors"), {})[r["day"]] = r["err"]
    cur.execute(f"SELECT asset_id, day, sum(usd)::float AS usd FROM cost_daily WHERE day >= %(since)s {where} GROUP BY asset_id, day",
                {"since": since, "ids": asset_ids})
    for r in cur.fetchall():
        series.setdefault((r["asset_id"], "cost"), {})[r["day"]] = r["usd"]
    floor = {"requests": 20.0, "errors": 5.0, "cost": 1.0}
    found = []
    start = date.today() - timedelta(days=lookback)
    for (aid, metric), pts in series.items():
        for d, v in pts.items():
            if d < start:
                continue
            window = [pts.get(d - timedelta(days=i), 0.0) for i in range(1, 15)]
            base = median(window)
            if v >= floor[metric] and v > 2 * max(base, floor[metric] / 2):
                found.append({"asset_id": aid, "day": d.isoformat(), "metric": metric, "value": round(v, 2),
                              "baseline": round(base, 2), "ratio": round(v / base, 1) if base else None})
    if not found:
        return []
    cur.execute("SELECT asset_id, display_name FROM asset WHERE asset_id = ANY(%s)", (list({f["asset_id"] for f in found}),))
    names = {r["asset_id"]: r["display_name"] for r in cur.fetchall()}
    hints = {"cost": "Spend spike: check for a model change or a single heavy requester",
             "requests": "Traffic spike: new consumer or retry loop",
             "errors": "Error spike: check traces and recent changes"}
    out = [{**f, "asset_display_name": names.get(f["asset_id"], f["asset_id"]), "hint": hints[f["metric"]],
            "ratio": f["ratio"] if f["ratio"] is not None else 99.0} for f in found]
    return sorted(out, key=lambda f: f["day"], reverse=True)[:50]


def _sources(cur, asset_ids: list[str] | None, start: date) -> list[dict]:
    where = "AND asset_id = ANY(%(ids)s)" if asset_ids else ""
    cur.execute(f"""SELECT source, max(day) AS as_of FROM usage_daily WHERE day >= %(s)s {where} GROUP BY source
                    UNION ALL SELECT source, max(day) FROM cost_daily WHERE day >= %(s)s {where} GROUP BY source""",
                {"s": start, "ids": asset_ids})
    merged: dict[str, object] = {}
    for r in cur.fetchall():  # a source can feed both usage and cost: one row each, newest as_of
        prev = merged.get(r["source"])
        merged[r["source"]] = max(filter(None, [prev, r["as_of"]]), default=None)
    return [{"name": name, "detail": SOURCE_NOTES.get(name, name), "as_of": as_of.isoformat() if as_of else None}
            for name, as_of in sorted(merged.items())]


def asset_usage(cur, asset_id: str, days: int, *, p: authz.Principal, perms: dict) -> dict:
    cur.execute("SELECT asset_id, asset_type FROM asset WHERE asset_id = %s", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    ids = [asset_id]
    if a["asset_type"] == "mcp_server":
        cur.execute("SELECT asset_id FROM asset WHERE parent_asset_id = %s", (asset_id,))
        ids += [r["asset_id"] for r in cur.fetchall()]
    start, calendar_days = _days(days)
    scope = "all" if perms["can_view_all_usage"] else "self"
    who = "" if scope == "all" else "AND lower(requester) = %(me)s"
    params = {"ids": ids, "s": start, "me": p.email}
    cur.execute(f"""SELECT day, sum(requests)::bigint AS requests, sum(errors)::bigint AS errors, sum(input_tokens)::bigint AS input_tokens,
                           sum(output_tokens)::bigint AS output_tokens, max(p95_latency_ms) AS p95
                      FROM usage_daily WHERE asset_id = ANY(%(ids)s) AND day >= %(s)s {who} GROUP BY day""", params)
    by_day = {r["day"]: r for r in cur.fetchall()}
    cur.execute("SELECT day, sum(usd)::float AS usd FROM cost_daily WHERE asset_id = ANY(%(ids)s) AND day >= %(s)s GROUP BY day", params)
    cost_day = {r["day"]: r["usd"] for r in cur.fetchall()}
    daily = []
    for d in calendar_days:
        u = by_day.get(d, {})
        daily.append({"day": d.isoformat(), "requests": int(u.get("requests") or 0), "errors": int(u.get("errors") or 0),
                      "input_tokens": int(u.get("input_tokens") or 0), "output_tokens": int(u.get("output_tokens") or 0),
                      "cost_usd": round(cost_day.get(d, 0.0), 2) if scope == "all" else 0.0})
    cur.execute(f"""SELECT requester, max(requester_kind) AS requester_kind, sum(requests)::bigint AS requests, max(day) AS last_seen
                      FROM usage_daily WHERE asset_id = ANY(%(ids)s) AND day >= %(s)s {who}
                     GROUP BY requester ORDER BY 3 DESC LIMIT 50""", params)
    consumers = list(cur.fetchall())
    cur.execute("SELECT subscriber_email FROM subscription WHERE asset_id = ANY(%s) AND status = 'active'", (ids,))
    subscribed = {r["subscriber_email"] for r in cur.fetchall()}
    total_req = sum(x["requests"] for x in daily)
    total_cost = sum(cost_day.values()) if scope == "all" else 0.0
    by_consumer = [{"requester": c["requester"], "requester_kind": c["requester_kind"], "requests": int(c["requests"]),
                    "cost_usd": round(total_cost * int(c["requests"]) / total_req, 2) if total_req and scope == "all" else None,
                    "last_seen": c["last_seen"].isoformat(), "subscribed": c["requester"].lower() in subscribed}
                   for c in consumers]
    cur.execute(f"""SELECT tool_name, sum(requests)::bigint AS requests, sum(errors)::bigint AS errors FROM usage_daily
                     WHERE asset_id = ANY(%(ids)s) AND day >= %(s)s AND tool_name <> '' {who}
                     GROUP BY tool_name ORDER BY 2 DESC LIMIT 30""", params)
    by_tool = [{"tool_name": r["tool_name"], "requests": int(r["requests"]), "errors": int(r["errors"])} for r in cur.fetchall()]
    cost_by_sku = []
    if scope == "all":
        cur.execute("""SELECT sku, source, sum(usd)::float AS usd, sum(dbus)::float AS dbus FROM cost_daily
                        WHERE asset_id = ANY(%(ids)s) AND day >= %(s)s GROUP BY sku, source ORDER BY 3 DESC""", params)
        cost_by_sku = [{"sku": r["sku"], "source": r["source"], "usd": round(r["usd"], 2), "dbus": round(r["dbus"], 3)} for r in cur.fetchall()]
    users = len({c["requester"] for c in consumers})
    errors = sum(x["errors"] for x in daily)
    p95 = max((int(u["p95"]) for u in by_day.values() if u.get("p95") is not None), default=None)
    return {
        "kpis": {"requests": total_req, "users": users, "errors": errors,
                 "error_rate": round(errors / total_req, 4) if total_req else None,
                 "input_tokens": sum(x["input_tokens"] for x in daily), "output_tokens": sum(x["output_tokens"] for x in daily),
                 "cost_usd": round(total_cost, 2),
                 "usd_per_1k_requests": round(total_cost / total_req * 1000, 4) if total_req and scope == "all" else None,
                 "usd_per_user": round(total_cost / users, 2) if users and scope == "all" else None,
                 "p95_latency_ms": p95},
        "daily": daily, "by_consumer": by_consumer, "by_tool": by_tool, "cost_by_sku": cost_by_sku,
        "budget": budget_state(cur, asset_id) if scope == "all" else None,
        "anomalies": anomalies(cur, ids) if scope == "all" else [],
        "sources": _sources(cur, ids, start), "scope": scope,
    }


def fleet(cur, days: int) -> dict:
    start, calendar_days = _days(days)
    cur.execute("""SELECT day, sum(requests)::bigint AS requests, sum(errors)::bigint AS errors, sum(input_tokens)::bigint AS i,
                          sum(output_tokens)::bigint AS o FROM usage_daily WHERE day >= %s GROUP BY day""", (start,))
    by_day = {r["day"]: r for r in cur.fetchall()}
    cur.execute("SELECT day, sum(usd)::float AS usd FROM cost_daily WHERE day >= %s GROUP BY day", (start,))
    cost_day = {r["day"]: r["usd"] for r in cur.fetchall()}
    daily = [{"day": d.isoformat(), "requests": int(by_day.get(d, {}).get("requests") or 0),
              "errors": int(by_day.get(d, {}).get("errors") or 0), "input_tokens": int(by_day.get(d, {}).get("i") or 0),
              "output_tokens": int(by_day.get(d, {}).get("o") or 0), "cost_usd": round(cost_day.get(d, 0.0), 2)}
             for d in calendar_days]
    cur.execute("""
        WITH u AS (SELECT asset_id, sum(requests)::bigint AS requests, count(DISTINCT requester) AS users FROM usage_daily WHERE day >= %(s)s GROUP BY asset_id),
             c AS (SELECT asset_id, sum(usd)::float AS usd FROM cost_daily WHERE day >= %(s)s GROUP BY asset_id)
        SELECT a.asset_id, a.display_name, a.asset_type, a.platform, coalesce(u.requests,0) AS requests, coalesce(c.usd,0) AS cost_usd,
               coalesce(u.users,0) AS users
          FROM asset a LEFT JOIN u ON u.asset_id = a.asset_id LEFT JOIN c ON c.asset_id = a.asset_id
         WHERE u.asset_id IS NOT NULL OR c.asset_id IS NOT NULL""", {"s": start})
    rows = list(cur.fetchall())
    top = sorted(rows, key=lambda r: (r["cost_usd"], r["requests"]), reverse=True)[:15]
    by_type: dict[str, dict] = {}
    by_platform: dict[str, dict] = {}
    for r in rows:
        t = by_type.setdefault(r["asset_type"], {"asset_type": r["asset_type"], "requests": 0, "cost_usd": 0.0})
        t["requests"] += int(r["requests"]); t["cost_usd"] += float(r["cost_usd"])
        pl = by_platform.setdefault(r["platform"], {"platform": r["platform"], "requests": 0, "cost_usd": 0.0})
        pl["requests"] += int(r["requests"]); pl["cost_usd"] += float(r["cost_usd"])
    cur.execute("SELECT count(DISTINCT requester) AS n FROM usage_daily WHERE day >= %s", (start,))
    users = int(cur.fetchone()["n"])
    governed = governed_traffic_pct(cur, start)
    cur.execute("SELECT b.asset_id, a.display_name FROM budget b JOIN asset a ON a.asset_id = b.asset_id")
    budgets = [{**budget_state(cur, b["asset_id"]), "asset_id": b["asset_id"], "display_name": b["display_name"]}
               for b in list(cur.fetchall())]
    return {
        "kpis": {"requests": sum(d["requests"] for d in daily), "users": users, "cost_usd": round(sum(cost_day.values()), 2),
                 "agents_active": sum(1 for r in rows if r["asset_type"] == "agent" and r["requests"]),
                 "mcp_active": sum(1 for r in rows if r["asset_type"] == "mcp_server" and r["requests"]),
                 "governed_pct": governed},
        "daily": daily,
        "top_assets": [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items() if k != "platform"} for r in top],
        "by_type": [{**v, "cost_usd": round(v["cost_usd"], 2)} for v in by_type.values()],
        "by_platform": sorted([{**v, "cost_usd": round(v["cost_usd"], 2)} for v in by_platform.values()], key=lambda x: -x["cost_usd"]),
        "anomalies": anomalies(cur), "budgets": budgets, "sources": _sources(cur, None, start),
    }


def governed_traffic_pct(cur, start: date) -> float:
    """Share of observed requests that reach an asset with at least one guardrail or a platform-default gate."""
    cur.execute("""SELECT a.asset_id, a.asset_type, a.subtype, a.risk_tier, a.certification, sum(u.requests)::bigint AS n
                     FROM usage_daily u JOIN asset a ON a.asset_id = u.asset_id WHERE u.day >= %s
                    GROUP BY a.asset_id, a.asset_type, a.subtype, a.risk_tier, a.certification""", (start,))
    rows = list(cur.fetchall())
    total = sum(int(r["n"]) for r in rows)
    if not total:
        return 0.0
    cur.execute("""SELECT DISTINCT b.asset_id FROM policy_binding b JOIN policy p ON p.policy_id = b.policy_id
                    WHERE b.status = 'active' AND p.kind IN ('guardrail','approval','rate_limit')""")
    guarded = {r["asset_id"] for r in cur.fetchall()}
    gov = sum(int(r["n"]) for r in rows if r["asset_id"] in guarded or coverage.implicit_policies(r))
    return round(100 * gov / total, 1)
