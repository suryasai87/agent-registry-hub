"""Policy coverage: the share of required controls (per risk tier and asset type) an asset has in place.

Requirements live in ``policy_requirement``. An asset meets a requirement through:
* active ``policy_binding`` rows (synced from Unity AI Gateway / serving AI Gateway, or bound in the app), or
* registry facts: an owner, documented fields, a budget, certification, or
* **platform defaults** that hold for every MCP server reached through the Databricks MCP proxy. Each call
  is gated by a UC privilege (EXECUTE / USE CONNECTION) and logged to ``system.access.audit`` (mcpService /
  managedMcp), and MCP traffic is tracked in ``system.ai_gateway.usage``.
  These appear as "platform default" chips and are never shown as app-configured policies.
"""
from __future__ import annotations

PROXIED_MCP_SUBTYPES = {"managed_uc_functions", "external_connection", "custom_app", "databricks_workspace",
                        "databricks_system_mcp", "system", "system_mcp", "uc_mcp_service", "managed_genie"}



def requirements(cur) -> dict[tuple[str, str], list[dict]]:
    cur.execute("SELECT risk_tier, asset_type, requirement, label FROM policy_requirement ORDER BY requirement")
    out: dict[tuple[str, str], list[dict]] = {}
    for r in cur.fetchall():
        out.setdefault((r["risk_tier"], r["asset_type"]), []).append({"requirement": r["requirement"], "label": r["label"]})
    return out


def _is_proxied_mcp(a: dict) -> bool:
    return a["asset_type"] in ("mcp_server", "tool") and (a.get("subtype") in PROXIED_MCP_SUBTYPES or str(a["asset_id"]).startswith(("mcp:uc:", "mcp:connection:", "mcp:system:", "mcp:service:", "tool:uc:")))


def implicit_policies(a: dict) -> list[dict]:
    """Platform-default controls (facts about how Databricks proxies MCP), shown as chips."""
    if not _is_proxied_mcp(a):
        return []
    aid = a["asset_id"]
    gateway = aid.startswith(("mcp:system:", "mcp:service:"))  # Unity Gateway MCP services (/ai-gateway/mcp-services/...)
    if aid.startswith(("mcp:connection:",)) or a.get("subtype") in ("external_connection", "custom_app", "databricks_workspace"):
        gate = "USE CONNECTION on the UC connection"
    elif aid.startswith(("mcp:uc:", "tool:uc:")):
        gate = "EXECUTE on the UC functions (plus USE CATALOG / USE SCHEMA)"
    else:
        gate = "EXECUTE on the UC MCP service (plus USE CATALOG / USE SCHEMA) and the user's own OAuth"
    tracking = ("MCP calls are tracked per request in system.ai_gateway.usage and audited in system.access.audit."
                if gateway else
                "MCP calls through the Databricks MCP proxy are audited in system.access.audit (mcpService / managedMcp). "
                "The legacy /api/2.0/mcp path bypasses Unity Gateway service policies; register it as a UC MCP service to attach guardrails.")
    return [
        {"policy_id": f"platform:{aid}:access", "name": "Unity Catalog permission gate", "kind": "access",
         "provider": "unity_catalog", "phase": "n/a", "action": "deny", "status": "active", "inherited_from": "platform default",
         "summary": f"Every call requires {gate}.", "config": {}},
        {"policy_id": f"platform:{aid}:audit", "name": "Usage tracking" if gateway else "Audit logging", "kind": "usage_tracking",
         "provider": "unity_gateway" if gateway else "unity_catalog", "phase": "n/a", "action": "log", "status": "active",
         "inherited_from": "platform default", "summary": tracking, "config": {"via_unity_gateway": gateway}},
    ]


def for_assets(cur, assets: list[dict]) -> dict[str, dict]:
    """{asset_id: {pct, shield, required: [{requirement, label, met}]}} for a batch of asset rows."""
    if not assets:
        return {}
    ids = [a["asset_id"] for a in assets]
    reqs = requirements(cur)
    cur.execute(
        """SELECT b.asset_id, p.kind, p.phase FROM policy_binding b JOIN policy p ON p.policy_id = b.policy_id
            WHERE b.asset_id = ANY(%s) AND b.status = 'active'""",
        (ids,),
    )
    bound: dict[str, set[str]] = {}
    for r in cur.fetchall():
        s = bound.setdefault(r["asset_id"], set())
        s.add(r["kind"])
        if r["kind"] == "guardrail":
            if r["phase"] in ("input", "both"):
                s.add("guardrail:input")
            if r["phase"] in ("output", "both"):
                s.add("guardrail:output")
    cur.execute("SELECT DISTINCT asset_id FROM asset_owner WHERE asset_id = ANY(%s) AND kind IN ('owner','co_owner')", (ids,))
    owned = {r["asset_id"] for r in cur.fetchall()}
    cur.execute(
        """SELECT asset_id, field_key FROM asset_field WHERE asset_id = ANY(%s) AND field_key IN ('purpose','support_channel')
              AND coalesce(override_value, source_value) IS NOT NULL
              AND coalesce(override_value, source_value) NOT IN ('""'::jsonb, 'null'::jsonb, '[]'::jsonb)""",
        (ids,),
    )
    documented: dict[str, set[str]] = {}
    for r in cur.fetchall():
        documented.setdefault(r["asset_id"], set()).add(r["field_key"])
    cur.execute("SELECT asset_id FROM budget WHERE asset_id = ANY(%s)", (ids,))
    budgets = {r["asset_id"] for r in cur.fetchall()}

    out = {}
    for a in assets:
        aid = a["asset_id"]
        have = set(bound.get(aid, set()))
        if _is_proxied_mcp(a):
            have |= {"usage_tracking", "access"}
        checks = []
        for req in reqs.get((a["risk_tier"], a["asset_type"]), []):
            key = req["requirement"]
            if key == "owner":
                met = aid in owned
            elif key in ("purpose", "support_channel"):
                met = key in documented.get(aid, set())
            elif key == "budget":
                met = aid in budgets
            elif key == "certified":
                met = a["certification"] == "certified"
            else:
                met = key in have
            checks.append({**req, "met": met})
        pct = round(100 * sum(c["met"] for c in checks) / len(checks)) if checks else 100
        has_guardrail = bool({"guardrail:input", "guardrail:output"} & have)
        shield = "full" if pct == 100 else ("partial" if pct >= 50 or has_guardrail else "none")
        out[aid] = {"pct": pct, "shield": shield, "required": checks}
    return out
