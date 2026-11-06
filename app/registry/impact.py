"""Change impact: who and what a change to an asset affects.

Used two ways:
* ``preview(cur, asset_id, breaking)``: the owner's impact preview before publishing (no writes).
* ``freeze_impact(cur, change_id)``: called once when a change is published (by an owner, or detected by
  a sync). It writes the impact rows and queues notifications. Frozen rows record who was affected at
  publish time, so a later unsubscribe never rewrites history.

``extra`` start nodes widen the blast radius beyond the asset and its parent, e.g. the tool assets an MCP tool
selection hides: agents that declared or called exactly those tools are downstream of the change.

Impacted parties:
* subscribers: email-registered consumers of the asset, its parent (for tools), and of downstream assets
  within 2 hops for breaking changes;
* downstream assets: everything that transitively depends on the asset (lineage, up to 3 hops), and their
  owners;
* observed consumers: requesters seen in usage over the last 30 days who never registered. They get an
  invitation to subscribe.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

from registry import graph, notify

MAX_HOPS = 3
SUBSCRIBER_HOPS_BREAKING = 2


def _start_nodes(cur, asset_id: str, extra: Iterable[str] = ()) -> list[str]:
    cur.execute("SELECT parent_asset_id FROM asset WHERE asset_id = %s", (asset_id,))
    row = cur.fetchone()
    nodes = [asset_id]
    if row and row.get("parent_asset_id"):
        nodes.append(row["parent_asset_id"])
    return list(dict.fromkeys([*nodes, *extra]))


def _labels(cur, ids: list[str]) -> dict[str, str]:
    if not ids:
        return {}
    cur.execute("SELECT asset_id, display_name FROM asset WHERE asset_id = ANY(%s)", (ids,))
    return {r["asset_id"]: r["display_name"] for r in cur.fetchall()}


def compute(cur, asset_id: str, breaking: bool, extra: Iterable[str] = ()) -> dict[str, list[dict]]:
    """Impact rows (not yet persisted), grouped as subscribers / downstream / observed."""
    start = _start_nodes(cur, asset_id, extra)
    deps = graph.dependents(cur, start, max_hops=MAX_HOPS)
    downstream_assets = [d for d in deps if graph.is_asset(d["node"])]
    labels = _labels(cur, [d["node"] for d in downstream_assets] + start)
    ack = "pending" if breaking else "not_required"

    # Subscribers of the asset (and its parent) — direct impact.
    sub_scope = list(start)
    hop_of = {n: 0 for n in start}
    via_of: dict[str, str | None] = {n: None for n in start}
    if breaking:
        for d in downstream_assets:
            if d["hops"] <= SUBSCRIBER_HOPS_BREAKING:
                sub_scope.append(d["node"])
                hop_of[d["node"]] = d["hops"]
                via_of[d["node"]] = d["node"]
    cur.execute(
        """
        SELECT s.asset_id, s.subscriber_email, s.notify_emails, s.notify_pref, s.downstream_asset_id, s.downstream_name
          FROM subscription s
         WHERE s.status = 'active' AND s.asset_id = ANY(%s)
        """,
        (sub_scope,),
    )
    subscribers: dict[str, dict] = {}
    for s in cur.fetchall():
        email = s["subscriber_email"]
        hops = max(1, hop_of.get(s["asset_id"], 0) + (1 if s["asset_id"] not in start else 0))
        if email in subscribers and subscribers[email]["hops"] <= hops:
            continue
        via = via_of.get(s["asset_id"])
        subscribers[email] = {
            "impacted_key": email, "impact_type": "subscriber", "via_asset_id": via, "hops": hops,
            "email": email, "ack_status": ack,
            "notify": breaking or s["notify_pref"] == "all",
            "notify_emails": list(s["notify_emails"] or []),
            "label": email + (f" (via {labels.get(via, via)})" if via else ""),
            "downstream": s["downstream_asset_id"] or s["downstream_name"],
        }

    # Downstream assets and their owners.
    downstream: list[dict] = []
    owner_rows: dict[str, dict] = {}
    if downstream_assets:
        ids = [d["node"] for d in downstream_assets]
        cur.execute(
            "SELECT asset_id, email FROM asset_owner WHERE asset_id = ANY(%s) AND kind IN ('owner','co_owner')",
            (ids,),
        )
        owners_by_asset: dict[str, list[str]] = {}
        for r in cur.fetchall():
            owners_by_asset.setdefault(r["asset_id"], []).append(r["email"])
        for d in downstream_assets:
            downstream.append({
                "impacted_key": d["node"], "impact_type": "downstream_asset", "via_asset_id": d["via"],
                "hops": d["hops"], "email": None, "ack_status": "not_required", "notify": False,
                "label": labels.get(d["node"], d["node"]),
            })
            for email in owners_by_asset.get(d["node"], []):
                if email in owner_rows and owner_rows[email]["hops"] <= d["hops"]:
                    continue
                owner_rows[email] = {
                    "impacted_key": email, "impact_type": "downstream_owner", "via_asset_id": d["node"],
                    "hops": d["hops"], "email": email, "ack_status": ack, "notify": breaking,
                    "label": f"{email} (owner of {labels.get(d['node'], d['node'])})",
                }

    # Observed but unregistered consumers.
    since = date.today() - timedelta(days=30)
    cur.execute(
        """
        SELECT requester, max(requester_kind) AS kind, sum(requests)::bigint AS n
          FROM usage_daily
         WHERE asset_id = ANY(%s) AND day >= %s AND requester LIKE '%%@%%'
         GROUP BY requester
        """,
        (start, since),
    )
    observed: list[dict] = []
    for r in cur.fetchall():
        email = r["requester"].lower()
        if email in subscribers:
            continue
        observed.append({
            "impacted_key": email, "impact_type": "observed_consumer", "via_asset_id": None, "hops": 1,
            "email": email, "ack_status": ack, "notify": True,
            "label": f"{email} ({int(r['n'])} requests in 30 d, not subscribed)",
        })

    return {
        "subscribers": list(subscribers.values()) + list(owner_rows.values()),
        "downstream": downstream,
        "observed": observed,
    }


def preview(cur, asset_id: str, breaking: bool, extra: Iterable[str] = ()) -> dict:
    groups = compute(cur, asset_id, breaking, extra)
    people = {i["email"] for g in groups.values() for i in g if i.get("email")}
    return {**groups, "total_people": len(people)}


def freeze_impact(cur, change_id: int, extra: Iterable[str] = ()) -> int:
    """Persist impact rows for a published change and queue notifications. Idempotent per change."""
    cur.execute(
        """
        SELECT c.change_id, c.asset_id, c.breaking, c.title, c.summary, c.effective_at, a.display_name
          FROM change_event c JOIN asset a ON a.asset_id = c.asset_id
         WHERE c.change_id = %s
        """,
        (change_id,),
    )
    change = cur.fetchone()
    if not change:
        raise KeyError(f"change {change_id} not found")
    groups = compute(cur, change["asset_id"], bool(change["breaking"]), extra)
    written = 0
    tag = "[Breaking] " if change["breaking"] else ""
    for group in groups.values():
        for item in group:
            cur.execute(
                """
                INSERT INTO impact_item (change_id, impacted_key, impact_type, via_asset_id, hops, email, ack_status, notified_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END)
                ON CONFLICT (change_id, impacted_key, impact_type) DO NOTHING
                """,
                (change_id, item["impacted_key"], item["impact_type"], item["via_asset_id"], item["hops"],
                 item["email"], item["ack_status"], bool(item.get("notify") and item.get("email"))),
            )
            written += cur.rowcount
            if not (item.get("notify") and item.get("email")) or cur.rowcount == 0:
                continue
            if item["impact_type"] == "observed_consumer":
                title = f"You use {change['display_name']}, which changed. Subscribe to get impact notices"
                kind = "unregistered_consumer"
            else:
                title = f"{tag}{change['display_name']}: {change['title']}"
                kind = "change_published"
            body = change["summary"] or None
            for email in [item["email"], *item.get("notify_emails", [])]:
                notify.queue(cur, email, kind, title, body, change["asset_id"], change_id)
    return written
