"""The labelled synthetic tier: a small deterministic demo fleet served ONLY when Lakebase is unreachable.

Every envelope from here carries ``source: "synthetic"`` (an amber pill in the UI), so it is never
mistaken for registry data. Identities are fictitious (example.com). Same input, same output.
"""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta, timezone

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def _r(key: str, lo: float, hi: float) -> float:
    h = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return lo + (hi - lo) * h


def _owner(email: str, kind: str = "owner") -> dict:
    name = " ".join(p.capitalize() for p in email.split("@")[0].split("."))
    return {"email": email, "kind": kind, "source": "synced", "display_name": name}


FLEET = [
    ("agent:endpoint:demo-care-supervisor", "agent", "agent_bricks_supervisor", "Care Ops Supervisor", "databricks", "agent_bricks", "Databricks",
     "Routes care-operations questions to Genie, a document assistant and UC tools.", "ana.ruiz@example.com", "high", "certified"),
    ("agent:endpoint:demo-policy-ka", "agent", "agent_bricks_knowledge_assistant", "Policy Docs Assistant", "databricks", "agent_bricks", "Databricks",
     "Answers questions over the clinical policy library with citations.", "ana.ruiz@example.com", "medium", "unreviewed"),
    ("agent:genie:demo-claims", "agent", "genie_space", "Claims Analytics (Genie)", "databricks", "genie", "Databricks",
     "Natural-language analytics over governed claims tables.", "lee.chen@example.com", "medium", "certified"),
    ("agent:endpoint:demo-intake-agent", "agent", "custom_agent", "Member Intake Agent", "databricks", "model_serving", "Databricks",
     "Custom LangGraph agent that drafts member-intake summaries.", "", "high", "unreviewed"),
    ("mcp:system:system.ai.microsoft_365", "mcp_server", "databricks_system_mcp", "Microsoft 365", "external", "databricks_system_mcp", "Microsoft",
     "Outlook mail, calendar, OneDrive and SharePoint through a Databricks-managed MCP server.", "platform.admins@example.com", "high", "verified_publisher"),
    ("mcp:connection:demo_github_mcp", "mcp_server", "external_connection", "GitHub MCP", "external", "unity_catalog", "GitHub",
     "Repository, issue and pull-request tools through a UC HTTP connection.", "dev.tools@example.com", "medium", "unreviewed"),
    ("mcp:uc:demo.care_tools", "mcp_server", "managed_uc_functions", "Care tools (UC functions)", "databricks", "unity_catalog", "Databricks",
     "Managed MCP exposing governed SQL functions in demo.care_tools.", "lee.chen@example.com", "medium", "certified"),
    ("tool:mcp:system:system.ai.microsoft_365/search_mail", "tool", "mcp_tool", "search_mail", "external", "databricks_system_mcp", "Microsoft",
     "Search the signed-in user's mailbox.", "platform.admins@example.com", "high", "verified_publisher"),
    ("tool:mcp:system:system.ai.microsoft_365/list_events", "tool", "mcp_tool", "list_events", "external", "databricks_system_mcp", "Microsoft",
     "List calendar events in a time range.", "platform.admins@example.com", "medium", "verified_publisher"),
    ("tool:uc:demo.care_tools.member_risk", "tool", "uc_function", "member_risk", "databricks", "unity_catalog", "Databricks",
     "Returns the risk tier and drivers for a member id.", "lee.chen@example.com", "medium", "certified"),
    ("skill:uc:demo.skills.cohort-study", "skill", "uc_skill", "cohort-study", "databricks", "unity_catalog", "Databricks",
     "Build a comparative-effectiveness cohort study in Python.", "yan.lo@example.com", "low", "unreviewed"),
]
PARENT = {"tool:mcp:system:system.ai.microsoft_365/search_mail": "mcp:system:system.ai.microsoft_365",
          "tool:mcp:system:system.ai.microsoft_365/list_events": "mcp:system:system.ai.microsoft_365",
          "tool:uc:demo.care_tools.member_risk": "mcp:uc:demo.care_tools"}
EDGES = [
    ("agent:endpoint:demo-care-supervisor", "agent:genie:demo-claims", "calls_agent", "declared"),
    ("agent:endpoint:demo-care-supervisor", "agent:endpoint:demo-policy-ka", "calls_agent", "declared"),
    ("agent:endpoint:demo-care-supervisor", "tool:uc:demo.care_tools.member_risk", "uses_tool", "declared"),
    ("agent:endpoint:demo-care-supervisor", "mcp:system:system.ai.microsoft_365", "uses_mcp", "observed"),
    ("agent:genie:demo-claims", "table:demo.claims.claim_lines", "reads_data", "data"),
    ("tool:uc:demo.care_tools.member_risk", "table:demo.care.member_features", "reads_data", "data"),
    ("mcp:system:system.ai.microsoft_365", "tool:mcp:system:system.ai.microsoft_365/search_mail", "exposes_tool", "declared"),
    ("mcp:uc:demo.care_tools", "tool:uc:demo.care_tools.member_risk", "exposes_tool", "declared"),
    ("user:jo.park@example.com", "agent:endpoint:demo-care-supervisor", "subscribes", "declared"),
    ("user:sam.ito@example.com", "agent:endpoint:demo-care-supervisor", "consumes", "observed"),
    ("agent:endpoint:demo-intake-agent", "mcp:connection:demo_github_mcp", "uses_mcp", "observed"),
]

# A registered Unity Gateway MCP service with selectable tools (demo_seed.seed_extended): the tool-selection editor,
# Agent 365 and Unity Catalog lineage demos. Not part of FLEET, so the labelled fallback and its counts stay as they are.
CARE_MCP = "mcp:service:demo.care_tools.care_ops_mcp"
CARE_TOOL = "tool:mcp:service:demo.care_tools.care_ops_mcp/"  # + tool name
EXTENDED_FLEET = [
    (CARE_MCP, "mcp_server", "uc_mcp_service", "Care Ops MCP (Unity Gateway)", "external", "unity_catalog", "Example Health IT",
     "Member, claim and ticket tools through a governed Unity Gateway MCP service.", "lee.chen@example.com", "medium", "unreviewed"),
    (f"{CARE_TOOL}lookup_member", "tool", "mcp_tool", "lookup_member", "external", "unity_catalog",
     "Example Health IT", "Look up a member's plan and eligibility.", "lee.chen@example.com", "medium", "unreviewed"),
    (f"{CARE_TOOL}lookup_claim", "tool", "mcp_tool", "lookup_claim", "external", "unity_catalog",
     "Example Health IT", "Look up a claim's status and lines.", "lee.chen@example.com", "medium", "unreviewed"),
    (f"{CARE_TOOL}create_ticket", "tool", "mcp_tool", "create_ticket", "external", "unity_catalog",
     "Example Health IT", "Open a care-ops ticket for a member.", "lee.chen@example.com", "medium", "unreviewed"),
    (f"{CARE_TOOL}close_ticket", "tool", "mcp_tool", "close_ticket", "external", "unity_catalog",
     "Example Health IT", "Close a care-ops ticket.", "lee.chen@example.com", "high", "unreviewed"),
]
EXTENDED_ATTRIBUTES = {
    CARE_MCP: {"include_tool_selectors": ["lookup_*", "create_ticket"], "etag": "demo-etag-1", "uc_listed": True, "server_type": "EXTERNAL",
               "mcp_url": "/ai-gateway/mcp-services/demo.care_tools.care_ops_mcp",
               "source_connection": {"name": "connections/demo.care_tools.care_ops_conn", "status": "ACTIVE"}},
    f"{CARE_TOOL}lookup_member": {"side_effect": "read", "observed": True},
    f"{CARE_TOOL}lookup_claim": {"side_effect": "read", "observed": True},
    f"{CARE_TOOL}create_ticket": {"side_effect": "write", "observed": True},
    f"{CARE_TOOL}close_ticket": {"side_effect": "write", "observed": True},
}
EXTENDED_EDGES = [
    (CARE_MCP, f"{CARE_TOOL}lookup_member", "exposes_tool", "declared"),
    (CARE_MCP, f"{CARE_TOOL}lookup_claim", "exposes_tool", "declared"),
    (CARE_MCP, f"{CARE_TOOL}create_ticket", "exposes_tool", "declared"),
    ("agent:endpoint:demo-care-supervisor", CARE_MCP, "uses_mcp", "declared"),
    ("agent:endpoint:demo-intake-agent", f"{CARE_TOOL}create_ticket", "uses_tool", "observed"),
    ("agent:endpoint:demo-intake-agent", "table:demo.care.member_intake", "writes_data", "data"),
]


def _card(row) -> dict:
    aid, t, sub, name, src, plat, pub, purpose, owner, risk, cert = row
    req = int(_r(aid + "req", 40, 4000)) if t != "skill" else int(_r(aid, 3, 60))
    spark = [int(req / 30 * _r(f"{aid}{i}", 0.4, 1.6)) for i in range(14)]
    cov = int(_r(aid + "cov", 35, 100))
    return {
        "asset_id": aid, "asset_type": t, "subtype": sub, "display_name": name, "name": aid.split(":")[-1], "source": src, "platform": plat,
        "publisher": pub, "lifecycle_status": "approved", "runtime_status": "running", "certification": cert,
        "sensitivity": "confidential" if risk == "high" else "internal", "risk_tier": risk, "domain": "care-ops", "tags": ["demo"],
        "purpose": purpose, "owners": [_owner(owner)] if owner else [],
        "kpi": {"requests_30d": req, "users_30d": int(_r(aid + "u", 2, 60)), "cost_30d_usd": round(_r(aid + "c", 0, 900) if t == "agent" else 0, 2),
                "error_rate": round(_r(aid + "e", 0, 0.04), 4), "spark": spark},
        "policy_shield": "full" if cov == 100 else ("partial" if cov >= 50 else "none"), "coverage_pct": cov,
        "subscribers": int(_r(aid + "s", 0, 12)), "tools_count": sum(1 for v in PARENT.values() if v == aid),
        "my": {"has_access": False, "requested": False, "subscribed": False, "owner": False},
        "parent_asset_id": PARENT.get(aid), "parent_display_name": next((r[3] for r in FLEET if r[0] == PARENT.get(aid)), None),
        "last_changed_at": (NOW - timedelta(days=int(_r(aid + "d", 1, 40)))).isoformat(), "deep_link": None, "origin": "demo",
        "published_version": "v1", "latest_version": "v1", "eval_score": round(_r(aid + "ev", 0.7, 0.95), 3) if t == "agent" else None,
    }


CARDS = {row[0]: _card(row) for row in FLEET}


def me(p) -> dict:
    return {"email": p.email, "display_name": p.display_name, "roles": sorted(p.roles), "primary_role": p.primary_role,
            "view_as": p.view_as, "is_admin": "admin" in p.actual_roles, "is_steward": p.is_steward, "is_auditor": p.is_auditor,
            "counts": {"owned": 0, "subscriptions": 0, "pending_approvals": 0, "my_open_requests": 0, "unread_notifications": 0, "unacked_impacts": 0}}


def home(_email: str) -> dict:
    cards = list(CARDS.values())
    return {"kpis": {"agents": sum(c["asset_type"] == "agent" for c in cards), "mcp_servers": sum(c["asset_type"] == "mcp_server" for c in cards),
                     "tools": sum(c["asset_type"] == "tool" for c in cards), "skills": sum(c["asset_type"] == "skill" for c in cards),
                     "subscribers": 23, "requests_30d": sum(c["kpi"]["requests_30d"] for c in cards),
                     "cost_30d_usd": round(sum(c["kpi"]["cost_30d_usd"] for c in cards), 2), "governed_pct": 71.0, "ownerless": 1},
            "top_actions": [{"kind": "info", "label": "Registry data is unavailable; showing the labelled demo fleet", "count": 1,
                             "href": "/how-it-works", "severity": "warning"}],
            "my_subscriptions": [], "recent_changes": changes_feed(None)[:3],
            "trending": sorted(cards, key=lambda c: -c["kpi"]["requests_30d"])[:6], "sync": {"last_run_at": None, "status": None}}


def search(q: str) -> list[dict]:
    q = (q or "").lower()
    return [{"kind": "asset", "id": c["asset_id"], "label": c["display_name"], "sublabel": c["asset_type"],
             "href": f"/assets/{c['asset_id']}", "asset_type": c["asset_type"]}
            for c in CARDS.values() if q and (q in c["display_name"].lower() or q in c["asset_id"])][:10]


def catalog(filters: dict, page: int, page_size: int) -> dict:
    items = list(CARDS.values())
    col = {"type": "asset_type", "source": "source", "platform": "platform", "status": "lifecycle_status",
           "certification": "certification", "sensitivity": "sensitivity", "risk": "risk_tier"}
    for key, c in col.items():
        if filters.get(key):
            allowed = str(filters[key]).split(",")
            items = [i for i in items if i[c] in allowed]
    if filters.get("q"):
        q = filters["q"].lower()
        items = [i for i in items if q in i["display_name"].lower() or q in (i["purpose"] or "").lower()]
    facets = {f: {} for f in ("asset_type", "source", "platform", "lifecycle_status", "certification", "sensitivity", "risk_tier")}
    for i in items:
        for f in facets:
            facets[f][i[f]] = facets[f].get(i[f], 0) + 1
    start = (max(1, page) - 1) * page_size
    return {"items": items[start:start + page_size], "total": len(items), "page": page, "page_size": page_size, "facets": facets}


def _fields(card: dict) -> list[dict]:
    from registry.fields import FIELD_CATALOG, to_api
    vals = {"purpose": card["purpose"], "description": card["purpose"] + "\n\n(Demo description: the registry database is unavailable.)",
            "publisher_info": card["publisher"]}
    return [to_api({"source_value": vals.get(f["field_key"]), "source_label": "Demo fleet", "provenance": "source"} if vals.get(f["field_key"]) else None,
                   f["field_key"]) for f in FIELD_CATALOG]


def asset_detail(asset_id: str) -> dict:
    c = CARDS.get(asset_id)
    if not c:
        raise KeyError(f"asset {asset_id} not found")
    tabs = ["overview", "tools", "access", "usage"] + (["traces", "evals"] if c["asset_type"] == "agent" else []) + \
           ["policies", "lineage", "changes", "subscribers", "audit"]
    return {"asset": {**c, "attributes": {}, "external_ref": {}, "also_registered_in": [], "also_registered_in_field": None,
                      "published_version": "v1", "latest_version": "v1",
                      "first_seen_at": NOW.isoformat(), "last_synced_at": None, "source_created_at": None, "created_by": None,
                      "completeness_pct": 25},
            "fields": _fields(c), "versions": [], "parent": CARDS.get(c["parent_asset_id"]) if c["parent_asset_id"] else None, "tabs": tabs,
            "permissions": {k: False for k in ("can_edit", "can_override", "can_manage_access", "can_publish", "can_view_all_usage",
                                               "can_view_traces", "can_curate", "can_pause", "can_edit_tool_selection")},
            "access_settings": {"approval_required": True, "approver_mode": "any", "approvers": [o["email"] for o in c["owners"]],
                                "default_duration_days": 90, "max_duration_days": 180, "sla_hours": 48, "terms_text": None,
                                "managed_externally_url": None, "privileges": ["CAN_QUERY"], "default_privilege": "CAN_QUERY"}}


def asset_tools(asset_id: str) -> list[dict]:
    kids = [k for k, v in PARENT.items() if v == asset_id] + [d for s, d, rel, _ in EDGES if s == asset_id and rel in ("uses_tool", "uses_mcp", "calls_agent")]
    return [CARDS[k] for k in dict.fromkeys(kids) if k in CARDS]


def asset_access(asset_id: str, _email: str) -> dict:
    d = asset_detail(asset_id)
    return {"grants": [], "my_access": [], "pending_requests": [], "my_requests": [], "settings": d["access_settings"],
            "platform_request_destinations": None}


def subscribers(asset_id: str) -> dict:
    return {"subscribers": [], "unregistered": [{"requester": "sam.ito@example.com", "requester_kind": "user", "requests_30d": 41,
                                                 "last_seen": (NOW - timedelta(days=1)).date().isoformat()}] if asset_id in CARDS else []}


def requests(_scope: str, _email: str) -> list:
    return []


def _daily(key: str, days: int, base: float) -> list[dict]:
    start = NOW.date() - timedelta(days=days - 1)
    out = []
    for i in range(days):
        req = int(base * _r(f"{key}{i}", 0.5, 1.5))
        out.append({"day": (start + timedelta(days=i)).isoformat(), "requests": req, "errors": int(req * _r(f"{key}e{i}", 0, 0.03)),
                    "input_tokens": req * 900, "output_tokens": req * 160, "cost_usd": round(req * 0.004, 2)})
    return out


def asset_usage(asset_id: str, days: int) -> dict:
    c = CARDS.get(asset_id) or {"kpi": {"requests_30d": 0}}
    daily = _daily(asset_id, max(1, min(days, 90)), c["kpi"]["requests_30d"] / 30)
    req = sum(d["requests"] for d in daily)
    cost = round(sum(d["cost_usd"] for d in daily), 2)
    return {"kpis": {"requests": req, "users": 12, "errors": sum(d["errors"] for d in daily), "error_rate": 0.012, "input_tokens": req * 900,
                     "output_tokens": req * 160, "cost_usd": cost, "usd_per_1k_requests": round(cost / req * 1000, 3) if req else None,
                     "usd_per_user": round(cost / 12, 2), "p95_latency_ms": 2400},
            "daily": daily, "by_consumer": [{"requester": "sam.ito@example.com", "requester_kind": "user", "requests": req // 3, "cost_usd": round(cost / 3, 2),
                                             "last_seen": NOW.date().isoformat(), "subscribed": False}],
            "by_tool": [], "cost_by_sku": [], "budget": None, "anomalies": [],
            "sources": [{"name": "demo", "detail": "Demo data (labelled)", "as_of": None}], "scope": "all"}


def fleet_usage(days: int) -> dict:
    daily = _daily("fleet", max(1, min(days, 90)), 900)
    top = sorted(CARDS.values(), key=lambda c: -c["kpi"]["requests_30d"])[:10]
    return {"kpis": {"requests": sum(d["requests"] for d in daily), "users": 64, "cost_usd": round(sum(d["cost_usd"] for d in daily), 2),
                     "agents_active": 4, "mcp_active": 3, "governed_pct": 71.0},
            "daily": daily, "top_assets": [{"asset_id": c["asset_id"], "display_name": c["display_name"], "asset_type": c["asset_type"],
                                            "requests": c["kpi"]["requests_30d"], "cost_usd": c["kpi"]["cost_30d_usd"], "users": c["kpi"]["users_30d"]} for c in top],
            "by_type": [], "by_platform": [], "anomalies": [], "budgets": [],
            "sources": [{"name": "demo", "detail": "Demo data (labelled)", "as_of": None}]}


def asset_traces(asset_id: str) -> dict:
    return {"experiment_id": None, "deep_link": None, "traces": [], "daily": [], "note": "Demo data: traces are unavailable while the registry database is down."}


def asset_evals(asset_id: str) -> dict:
    return {"experiment_id": None, "scorers": [], "runs": [], "deep_link": None, "note": "Demo data: evals are unavailable while the registry database is down."}


def quality_fleet() -> dict:
    return {"agents": [{"asset_id": c["asset_id"], "display_name": c["display_name"], "traces_30d": c["kpi"]["requests_30d"],
                        "error_rate": c["kpi"]["error_rate"], "p95_ms": 2400, "scorer_means": {"correctness": round(_r(c["asset_id"], 0.7, 0.95), 3)},
                        "regression": False, "experiment_id": None} for c in CARDS.values() if c["asset_type"] == "agent"]}


def asset_policies(asset_id: str) -> dict:
    c = CARDS.get(asset_id)
    if not c:
        raise KeyError(f"asset {asset_id} not found")
    return {"chips": [], "coverage": {"pct": c["coverage_pct"], "required": []},
            "violations": {"total_7d": 0, "by_action": {}, "by_policy": [], "daily": []}, "risk_tier": c["risk_tier"]}


def policies_fleet() -> dict:
    return {"library": [], "gaps": [], "coverage_pct": 68.0, "governed_traffic_pct": 71.0,
            "violations": {"total_7d": 0, "by_action": {}, "by_policy": [], "daily": []}}


def lineage(focus: str | None, depth: int, direction: str) -> dict:
    if not focus:
        return {"focus": None, "depth": depth, "direction": direction, "nodes": [], "edges": [], "truncated": False}
    from registry.graph import node_type
    edges = [e for e in EDGES if focus in (e[0], e[1])] if depth <= 1 else EDGES
    ids = {focus} | {e[0] for e in edges} | {e[1] for e in edges}
    nodes = [{"id": i, "type": node_type(i), "label": CARDS[i]["display_name"] if i in CARDS else i.split(":", 1)[-1],
              "subtype": CARDS.get(i, {}).get("subtype"), "restricted": False, "impacted": False, "focus": i == focus,
              "owner": None, "certification": CARDS.get(i, {}).get("certification"), "policy_shield": CARDS.get(i, {}).get("policy_shield")} for i in ids]
    return {"focus": focus, "depth": depth, "direction": direction, "nodes": nodes,
            "edges": [{"src": s, "dst": d, "relation": r, "edge_kind": k, "weight_30d": 120 if k == "observed" else 0,
                       "last_seen": NOW.isoformat(), "source": "demo", "impacted": False, "undeclared": False} for s, d, r, k in edges],
            "truncated": False}


def changes_feed(asset_id: str | None) -> list[dict]:
    rows = [{"change_id": 1, "asset_id": "agent:endpoint:demo-care-supervisor", "asset_display_name": "Care Ops Supervisor", "asset_type": "agent",
             "from_version": "v3", "to_version": "v4", "change_kinds": ["tools_removed", "prompt"], "breaking": True,
             "title": "Removed legacy claims tool · instructions updated", "summary": "Demo change.", "status": "published",
             "detected_by": "sync", "published_by": "sync", "published_at": NOW.isoformat(), "effective_at": NOW.isoformat(),
             "created_at": NOW.isoformat(), "impacted_people": 6, "acked": 4, "my_ack": None}]
    return [r for r in rows if not asset_id or r["asset_id"] == asset_id]


def change_detail(change_id: int) -> dict:
    c = next((r for r in changes_feed(None) if r["change_id"] == change_id), None)
    if not c:
        raise KeyError(f"change {change_id} not found")
    return {"change": {**c, "diff": [{"field": "tools", "before": ["claims_lookup", "member_risk"], "after": ["member_risk"]}],
                       "release_notes": None, "sunset_at": None},
            "impact": [], "ack_summary": {"pending": 2, "not_impacted": 3, "impacted_will_migrate": 1, "need_help": 0, "not_required": 0},
            "metrics_before": None, "metrics_after": None}


def my_impacts(_email: str) -> list:
    return []


def notifications(_email: str) -> list:
    return []


def gov_sources() -> dict:
    return {"collectors": [], "job": {"configured": False, "job_id": None, "url": None}}


def gov_curation() -> dict:
    return {"discovered": [], "pending_approval": [], "ownerless": [CARDS["agent:endpoint:demo-intake-agent"]], "drifted": []}


def gov_roles() -> list:
    return []


def demo_day(i: int) -> date:
    return NOW.date() - timedelta(days=i)
