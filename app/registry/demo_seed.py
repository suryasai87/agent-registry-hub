"""Write the deterministic demo fleet (registry/synthetic.py) into a Lakebase schema, every row marked
``origin='demo'`` / source ``demo``. Used by the flow tests and to rehearse locally. Never runs on its own in a
deployed app. ``seed_extended`` adds the demo Unity Gateway MCP service (tool selection, Agent 365, UC lineage).

    cd app && LAKEBASE_URL=... LAKEBASE_SCHEMA=demo python -m registry.demo_seed
"""
from __future__ import annotations

from datetime import date, timedelta

from psycopg.types.json import Jsonb

from registry import graph, synthetic


def _insert(cur, rows, attributes: dict | None = None) -> int:
    n = 0
    for row in rows:
        aid, t, sub, name, src, plat, pub, purpose, owner, risk, cert = row
        cur.execute(
            """INSERT INTO asset (asset_id, asset_type, subtype, name, display_name, source, platform, publisher, parent_asset_id,
                     lifecycle_status, runtime_status, certification, sensitivity, risk_tier, domain, tags, origin, deep_link, attributes)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NULL,'approved','running',%s,%s,%s,'care-ops','{demo}','demo',NULL,%s)
               ON CONFLICT (asset_id) DO NOTHING""",
            (aid, t, sub, aid.split(":")[-1], name, src, plat, pub, cert, "confidential" if risk == "high" else "internal", risk,
             Jsonb((attributes or {}).get(aid) or ({"endpoint_id": f"demo-{abs(hash(aid)) % 10**8}"} if aid.startswith("agent:endpoint:") else {}))),
        )
        n += cur.rowcount
        if owner:
            cur.execute("INSERT INTO asset_owner (asset_id, email, kind, source) VALUES (%s,%s,'owner','synced') ON CONFLICT DO NOTHING", (aid, owner))
        cur.execute("""INSERT INTO asset_field (asset_id, field_key, source_value, source_label, source_synced_at)
                       VALUES (%s, 'purpose', %s, 'Demo fleet', now()) ON CONFLICT DO NOTHING""", (aid, Jsonb(purpose)))
        cur.execute("""INSERT INTO asset_version (asset_id, version, status, source) VALUES (%s, 'v1', 'published', 'sync')
                       ON CONFLICT DO NOTHING""", (aid,))
    return n


def seed(cur) -> int:
    n = _insert(cur, synthetic.FLEET)
    for child, parent in synthetic.PARENT.items():
        cur.execute("UPDATE asset SET parent_asset_id = %s WHERE asset_id = %s", (parent, child))
    for s, d, rel, kind in synthetic.EDGES:
        graph.upsert_edge(cur, s, d, rel, kind, "demo", weight_30d=120 if kind == "observed" else 0)
    today = date.today()
    for aid, card in synthetic.CARDS.items():
        if card["asset_type"] == "skill":
            continue
        for i in range(30):
            day = today - timedelta(days=i)
            req = int(card["kpi"]["requests_30d"] / 30 * synthetic._r(f"{aid}{i}", 0.5, 1.5))
            for who, share in (("sam.ito@example.com", 0.6), ("jo.park@example.com", 0.4)):
                cur.execute("""INSERT INTO usage_daily (day, asset_id, requester, requester_kind, source, requests, errors, input_tokens, output_tokens, p95_latency_ms)
                               VALUES (%s,%s,%s,'user','demo',%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                            (day, aid, who, int(req * share), int(req * share * 0.01), int(req * share) * 900, int(req * share) * 150, 2400))
            if card["asset_type"] == "agent":
                cur.execute("""INSERT INTO cost_daily (day, asset_id, sku, source, dbus, usd) VALUES (%s,%s,'SERVERLESS_REAL_TIME_INFERENCE','demo',%s,%s)
                               ON CONFLICT DO NOTHING""", (day, aid, req * 0.05, req * 0.0035))
    cur.execute("""INSERT INTO policy (policy_id, name, kind, provider, phase, action, config, origin)
                   VALUES ('demo:guardrail:output', 'Output safety + PII mask', 'guardrail', 'serving_ai_gateway', 'output', 'mask',
                           '{"safety": true, "pii_detection": true, "pii": {"behavior": "MASK"}}', 'demo') ON CONFLICT DO NOTHING""")
    cur.execute("""INSERT INTO policy_binding (policy_id, asset_id, status) VALUES ('demo:guardrail:output', 'agent:endpoint:demo-care-supervisor', 'active')
                   ON CONFLICT DO NOTHING""")
    return n


def seed_extended(cur) -> int:
    """The demo Unity Gateway MCP service (synthetic.EXTENDED_FLEET) with four tools, an agent that calls one, a
    subscriber and 30 days of tool usage. Run after ``seed``; the flow tests for tool selection, Agent 365 and UC lineage
    use it."""
    n = _insert(cur, synthetic.EXTENDED_FLEET, synthetic.EXTENDED_ATTRIBUTES)
    for aid, *_ in synthetic.EXTENDED_FLEET[1:]:
        cur.execute("UPDATE asset SET parent_asset_id = %s, name = display_name WHERE asset_id = %s", (synthetic.CARE_MCP, aid))
    cur.execute("""UPDATE asset_version SET config_snapshot = %s WHERE asset_id = %s AND version = 'v1'""",
                (Jsonb({"sections": {"config": {"tool_selectors": ["create_ticket", "lookup_*"]}}}), synthetic.CARE_MCP))
    cur.execute("UPDATE asset SET latest_version = 'v1', published_version = 'v1' WHERE asset_id = %s", (synthetic.CARE_MCP,))
    for s, d, rel, kind in synthetic.EXTENDED_EDGES:
        graph.upsert_edge(cur, s, d, rel, kind, "demo", weight_30d=60 if kind == "observed" else 0)
    cur.execute("""INSERT INTO subscription (asset_id, subscriber_email, subscriber_kind, use_case, notify_pref, created_by)
                   VALUES (%s, 'jo.park@example.com', 'user', 'Care-ops ticket automation', 'all', 'jo.park@example.com')
                   ON CONFLICT DO NOTHING""", (synthetic.CARE_MCP,))
    today = date.today()
    tool = f"{synthetic.CARE_TOOL}create_ticket"
    for i in range(30):
        cur.execute("""INSERT INTO usage_daily (day, asset_id, requester, requester_kind, source, requests, errors)
                       VALUES (%s, %s, 'sam.ito@example.com', 'user', 'demo', %s, 0) ON CONFLICT DO NOTHING""",
                    (today - timedelta(days=i), tool, 4 + i % 3))
    return n


if __name__ == "__main__":
    from core import db, migrate

    migrate.main([]) if hasattr(migrate, "main") else None
    with db.transaction() as c:
        print("seeded", seed(c) + seed_extended(c), "assets")
    db.lb.close()
