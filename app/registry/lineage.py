"""Lineage graph view: nodes + edges around a focus, with impact highlighting and privacy for consumers.

Privacy: consumer identities (``user:<email>``) are visible to the asset's owners, stewards, admins and
auditors. Everyone else sees them collapsed into one "Consumers (N)" node, except their own node.
"""
from __future__ import annotations

from core import identity
from registry import authz, coverage, graph

MAX_NODES = 500


def build(cur, focus: str | None, depth: int, direction: str, kinds: list[str], *, p: authz.Principal,
          change_id: int | None = None) -> dict:
    direction = direction if direction in ("up", "down", "both") else "both"
    kinds = [k for k in kinds if k in ("declared", "observed", "data")] or ["declared", "observed", "data"]
    depth = max(1, min(int(depth or 1), 4))
    if not focus:
        return {"focus": None, "depth": depth, "direction": direction, "nodes": [], "edges": [], "truncated": False}
    rows, truncated = graph.neighborhood(cur, focus, depth, direction, kinds, limit=MAX_NODES * 2)
    ids = {focus} | {r["src_id"] for r in rows} | {r["dst_id"] for r in rows}

    asset_ids = [i for i in ids if graph.is_asset(i)]
    assets = {}
    if asset_ids:
        cur.execute("SELECT * FROM asset WHERE asset_id = ANY(%s)", (asset_ids,))
        assets = {a["asset_id"]: a for a in cur.fetchall()}
        cur.execute("SELECT asset_id, min(email) AS email FROM asset_owner WHERE asset_id = ANY(%s) AND kind IN ('owner','co_owner') GROUP BY asset_id",
                    (asset_ids,))
        owners = {r["asset_id"]: r["email"] for r in cur.fetchall()}
    else:
        owners = {}
    shields = {aid: c["shield"] for aid, c in coverage.for_assets(cur, list(assets.values())).items()}

    privileged = p.can_read_everything or (focus in assets and p.email in authz.owner_emails(cur, focus))
    hidden_users = {i for i in ids if i.startswith("user:") and i != f"user:{p.email}"} if not privileged else set()
    cluster_id = f"consumers:{focus}"

    impacted: set[str] = set()
    if change_id:
        cur.execute("SELECT asset_id FROM change_event WHERE change_id = %s", (change_id,))
        c = cur.fetchone()
        if c:
            impacted.add(c["asset_id"])
            cur.execute("SELECT impacted_key, impact_type FROM impact_item WHERE change_id = %s", (change_id,))
            for r in cur.fetchall():
                impacted.add(r["impacted_key"] if r["impact_type"] == "downstream_asset" else f"user:{r['impacted_key']}")

    nodes: dict[str, dict] = {}

    def add(node_id: str) -> str:
        if node_id in hidden_users:
            if cluster_id not in nodes:
                nodes[cluster_id] = {"id": cluster_id, "type": "user", "label": "Consumers", "subtype": "cluster",
                                     "restricted": True, "impacted": False, "focus": False, "count": 0}
            nodes[cluster_id]["count"] += 1
            nodes[cluster_id]["label"] = f"Consumers ({nodes[cluster_id]['count']})"
            if node_id in impacted:
                nodes[cluster_id]["impacted"] = True
            return cluster_id
        if node_id not in nodes:
            a = assets.get(node_id)
            kind = graph.node_type(node_id)
            if a:
                label, subtype, cert = a["display_name"], a["subtype"], a["certification"]
            elif kind == "user":
                label, subtype, cert = identity.display_name(node_id.split(":", 1)[1]), None, None
            else:
                label, subtype, cert = node_id.split(":", 1)[-1], None, None
            nodes[node_id] = {
                "id": node_id, "type": kind, "label": label, "subtype": subtype,
                "restricted": bool(graph.is_asset(node_id) and not a),
                "impacted": node_id in impacted, "focus": node_id == focus,
                "owner": owners.get(node_id), "certification": cert, "policy_shield": shields.get(node_id),
            }
        return node_id

    add(focus)
    declared_pairs = {(r["src_id"], r["dst_id"]) for r in rows if r["edge_kind"] == "declared"}
    edges: dict[tuple, dict] = {}
    for r in rows:
        s, d = add(r["src_id"]), add(r["dst_id"])
        key = (s, d, r["relation"], r["edge_kind"])
        e = edges.get(key)
        if e:
            e["weight_30d"] += int(r["weight_30d"] or 0)
            continue
        edges[key] = {
            "src": s, "dst": d, "relation": r["relation"], "edge_kind": r["edge_kind"],
            "weight_30d": int(r["weight_30d"] or 0), "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
            "source": r["source"], "impacted": (r["src_id"] in impacted and r["dst_id"] in impacted),
            "undeclared": r["edge_kind"] == "observed" and graph.is_asset(r["src_id"]) and (r["src_id"], r["dst_id"]) not in declared_pairs,
        }
        if len(nodes) >= MAX_NODES:
            truncated = True
            break
    for n in nodes.values():
        n.pop("count", None)
    return {"focus": focus, "depth": depth, "direction": direction, "nodes": list(nodes.values()),
            "edges": list(edges.values()), "truncated": truncated}
