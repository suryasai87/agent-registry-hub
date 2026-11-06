"""Policies & guardrails views (per asset and fleet) and binding management."""
from __future__ import annotations

from datetime import date, timedelta

from core import audit
from core.guard import NotFound
from registry import authz, coverage

PROVIDER_LABEL = {"unity_gateway": "Unity AI Gateway", "serving_ai_gateway": "Serving AI Gateway",
                  "unity_catalog": "Unity Catalog", "registry": "Registry"}


def _summary(p: dict) -> str:
    cfg = p.get("config") or {}
    kind = p["kind"]
    if kind == "guardrail":
        bits = [k for k in ("safety", "pii_detection") if cfg.get(k)]
        pii = (cfg.get("pii") or {}).get("behavior")
        return f"{p['phase']} guardrail" + (f": {', '.join(bits)}" if bits else "") + (f" (PII {pii.lower()})" if pii and pii != "NONE" else "")
    if kind == "rate_limit":
        calls, period = cfg.get("calls") or cfg.get("limit"), cfg.get("renewal_period") or cfg.get("interval")
        key = cfg.get("key") or cfg.get("principal_type")
        return f"{calls} calls / {period}" + (f" per {key}" if key else "") if calls else "Rate limit"
    if kind == "usage_tracking":
        return "Usage tracked in system tables"
    if kind == "inference_logging":
        t = cfg.get("table") or ".".join(filter(None, [cfg.get("catalog_name"), cfg.get("schema_name"), cfg.get("table_name_prefix")]))
        return f"Payloads logged to {t}" if t else "Payload (inference table) logging"
    if kind == "fallback":
        return "Fallback to secondary destinations on failure"
    return p.get("description") or p["name"]


def chips(cur, asset: dict) -> list[dict]:
    cur.execute(
        """SELECT p.*, b.status, b.inherited_from FROM policy_binding b JOIN policy p ON p.policy_id = b.policy_id
            WHERE b.asset_id = %s ORDER BY p.kind, p.name""", (asset["asset_id"],))
    out = [{"policy_id": r["policy_id"], "name": r["name"], "kind": r["kind"], "provider": r["provider"], "phase": r["phase"],
            "action": r["action"], "status": r["status"], "inherited_from": r["inherited_from"], "summary": _summary(r),
            "config": r["config"] or {}} for r in cur.fetchall()]
    if asset.get("parent_asset_id"):
        cur.execute(
            """SELECT p.*, b.status FROM policy_binding b JOIN policy p ON p.policy_id = b.policy_id
                WHERE b.asset_id = %s AND b.status = 'active'""", (asset["parent_asset_id"],))
        for r in cur.fetchall():
            out.append({"policy_id": r["policy_id"], "name": r["name"], "kind": r["kind"], "provider": r["provider"], "phase": r["phase"],
                        "action": r["action"], "status": "active", "inherited_from": asset["parent_asset_id"], "summary": _summary(r),
                        "config": r["config"] or {}})
    cur.execute("SELECT * FROM budget WHERE asset_id = %s", (asset["asset_id"],))
    b = cur.fetchone()
    if b:
        out.append({"policy_id": f"budget:{asset['asset_id']}", "name": "Monthly budget", "kind": "budget", "provider": b["source"],
                    "phase": "n/a", "action": b["action"], "status": "active", "inherited_from": None,
                    "summary": f"${float(b['monthly_usd']):,.0f}/month · {b['action']} at {b['alert_pct']}%", "config": {}})
    return out + coverage.implicit_policies(asset)


def violations(cur, asset_ids: list[str] | None, days: int = 7) -> dict:
    since = date.today() - timedelta(days=days - 1)
    where = "AND v.asset_id = ANY(%(ids)s)" if asset_ids is not None else ""
    cur.execute(f"""SELECT v.day, v.action, v.policy_id, coalesce(p.name, v.policy_id) AS name, sum(v.count)::bigint AS n
                      FROM policy_violation_daily v LEFT JOIN policy p ON p.policy_id = v.policy_id
                     WHERE v.day >= %(s)s {where} GROUP BY 1,2,3,4""", {"s": since, "ids": asset_ids})
    rows = list(cur.fetchall())
    by_action: dict[str, int] = {}
    by_policy: dict[str, dict] = {}
    by_day: dict[date, int] = {}
    for r in rows:
        n = int(r["n"])
        by_action[r["action"]] = by_action.get(r["action"], 0) + n
        bp = by_policy.setdefault(r["policy_id"], {"policy_id": r["policy_id"], "name": r["name"], "count": 0})
        bp["count"] += n
        by_day[r["day"]] = by_day.get(r["day"], 0) + n
    return {"total_7d": sum(by_action.values()), "by_action": by_action,
            "by_policy": sorted(by_policy.values(), key=lambda x: -x["count"])[:10],
            "daily": [{"day": (since + timedelta(days=i)).isoformat(), "count": by_day.get(since + timedelta(days=i), 0)} for i in range(days)]}


def asset_policies(cur, asset_id: str) -> dict:
    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    cov = coverage.for_assets(cur, [a])[asset_id]
    return {"chips": chips(cur, a), "coverage": {"pct": cov["pct"], "required": cov["required"]},
            "violations": violations(cur, [asset_id]), "risk_tier": a["risk_tier"]}


def bind(cur, asset_id: str, policy_id: str, status: str, *, p: authz.Principal, perms: dict) -> dict:
    if status not in ("active", "proposed"):
        raise ValueError("status must be active or proposed")
    if status == "active":
        authz.require(p.is_steward, "Only a steward or admin can activate a policy (owners can propose)")
    else:
        authz.require(perms["can_edit"] or p.is_steward, "Only the asset's owners can propose policies")
    cur.execute("SELECT * FROM policy WHERE policy_id = %s", (policy_id,))
    pol = cur.fetchone()
    if not pol:
        raise NotFound(f"policy {policy_id} not found")
    cur.execute("""INSERT INTO policy_binding (policy_id, asset_id, status, bound_by) VALUES (%s, %s, %s, %s)
                   ON CONFLICT (policy_id, asset_id) DO UPDATE SET status = EXCLUDED.status, bound_by = EXCLUDED.bound_by, bound_at = now()""",
                (policy_id, asset_id, status, p.email))
    audit.audit_event(p.email, f"policy.{status}", "asset", asset_id, after={"policy_id": policy_id}, request_id=p.request_id, cur=cur)
    return {"policy_id": pol["policy_id"], "name": pol["name"], "kind": pol["kind"], "provider": pol["provider"], "phase": pol["phase"],
            "action": pol["action"], "status": status, "inherited_from": None, "summary": _summary(pol), "config": pol["config"] or {}}


def unbind(cur, asset_id: str, policy_id: str, *, p: authz.Principal) -> dict:
    authz.require(p.is_steward, "Only a steward or admin can remove a policy binding")
    cur.execute("SELECT origin FROM policy WHERE policy_id = %s", (policy_id,))
    pol = cur.fetchone()
    if pol and pol["origin"] == "sync":
        raise ValueError("This policy is synced from the platform; change it in Unity AI Gateway instead")
    cur.execute("DELETE FROM policy_binding WHERE policy_id = %s AND asset_id = %s", (policy_id, asset_id))
    audit.audit_event(p.email, "policy.unbind", "asset", asset_id, before={"policy_id": policy_id}, request_id=p.request_id, cur=cur)
    return {"ok": True}


def fleet(cur) -> dict:
    cur.execute("""SELECT p.*, (SELECT count(*) FROM policy_binding b WHERE b.policy_id = p.policy_id AND b.status = 'active') AS applied
                     FROM policy p ORDER BY applied DESC, p.kind, p.name LIMIT 500""")
    library = [{"policy_id": r["policy_id"], "name": r["name"], "kind": r["kind"], "provider": r["provider"], "phase": r["phase"],
                "action": r["action"], "description": r["description"] or _summary(r), "applied_count": int(r["applied"]),
                "origin": r["origin"]} for r in cur.fetchall()]
    cur.execute("SELECT * FROM asset WHERE asset_type IN ('agent','mcp_server') AND lifecycle_status NOT IN ('retired','rejected')")
    assets = list(cur.fetchall())
    cov = coverage.for_assets(cur, assets)
    gaps: dict[tuple, dict] = {}
    for a in assets:
        for req in cov[a["asset_id"]]["required"]:
            if req["met"]:
                continue
            g = gaps.setdefault((req["requirement"], a["asset_type"], a["risk_tier"]), {
                "requirement": req["requirement"], "label": req["label"], "asset_type": a["asset_type"],
                "risk_tier": a["risk_tier"], "missing_count": 0, "sample_assets": []})
            g["missing_count"] += 1
            if len(g["sample_assets"]) < 5:
                g["sample_assets"].append({"asset_id": a["asset_id"], "display_name": a["display_name"]})
    from registry.usage import governed_traffic_pct
    pct = round(sum(c["pct"] for c in cov.values()) / len(cov), 1) if cov else 0.0
    return {"library": library, "gaps": sorted(gaps.values(), key=lambda g: -g["missing_count"])[:40],
            "coverage_pct": pct, "governed_traffic_pct": governed_traffic_pct(cur, date.today() - timedelta(days=29)),
            "violations": violations(cur, None)}
