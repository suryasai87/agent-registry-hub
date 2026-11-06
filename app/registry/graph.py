"""Lineage traversal over ``lineage_edge`` (src depends on dst)."""
from __future__ import annotations

from typing import Iterable

# Relations along which a change to the dependency propagates to the dependent.
DEPENDENCY_RELATIONS = (
    "uses_mcp", "uses_tool", "calls_agent", "uses_skill", "uses_model", "exposes_tool",
    "consumes", "subscribes", "hosts", "routes_to",
)

NODE_PREFIXES = {
    "agent:app:": "agent", "agent:": "agent", "mcp:": "mcp_server", "tool:": "tool", "skill:": "skill",
    "user:": "user", "sp:": "service_principal", "table:": "table", "index:": "index",
    "volume:": "volume", "model:": "model", "app:": "app", "web:": "external", "external:": "external",
}


def node_type(node_id: str) -> str:
    for prefix, kind in NODE_PREFIXES.items():
        if node_id.startswith(prefix):
            return kind
    return "external"


def is_asset(node_id: str) -> bool:
    return node_type(node_id) in ("agent", "mcp_server", "tool", "skill")


def dependents(cur, start: Iterable[str], max_hops: int = 3,
               relations: Iterable[str] = DEPENDENCY_RELATIONS) -> list[dict]:
    """Every node that (transitively) depends on any node in ``start``.

    Returns ``[{node, hops, via}]`` where ``via`` is the node it depends on at the last hop
    (the closest path wins). The start nodes themselves are excluded.
    """
    start = list(dict.fromkeys(start))
    if not start:
        return []
    cur.execute(
        """
        WITH RECURSIVE dep(node, via, hops, path) AS (
            SELECT e.src_id, e.dst_id, 1, ARRAY[e.dst_id, e.src_id]
              FROM lineage_edge e
             WHERE e.dst_id = ANY(%(start)s) AND e.relation = ANY(%(rels)s)
            UNION ALL
            SELECT e.src_id, e.dst_id, d.hops + 1, d.path || e.src_id
              FROM lineage_edge e JOIN dep d ON e.dst_id = d.node
             WHERE d.hops < %(max)s AND e.relation = ANY(%(rels)s) AND NOT (e.src_id = ANY(d.path))
        )
        SELECT DISTINCT ON (node) node, hops, via
          FROM dep
         WHERE NOT (node = ANY(%(start)s))
         ORDER BY node, hops, via
        """,
        {"start": start, "rels": list(relations), "max": max_hops},
    )
    return list(cur.fetchall())


def neighborhood(cur, focus: str, depth: int, direction: str, kinds: Iterable[str],
                 limit: int = 500) -> tuple[list[dict], bool]:
    """Edges within ``depth`` hops of ``focus``. direction: up (dependencies), down (dependents), both."""
    kinds = list(kinds)
    parts = []
    if direction in ("up", "both"):
        parts.append("""
            SELECT e.*, 1 AS hops, 'up' AS dir FROM lineage_edge e WHERE e.src_id = %(f)s AND e.edge_kind = ANY(%(k)s)
        """)
    if direction in ("down", "both"):
        parts.append("""
            SELECT e.*, 1 AS hops, 'down' AS dir FROM lineage_edge e WHERE e.dst_id = %(f)s AND e.edge_kind = ANY(%(k)s)
        """)
    base = " UNION ALL ".join(parts)
    cur.execute(
        f"""
        WITH RECURSIVE walk AS (
            {base}
            UNION ALL
            SELECT e.*, w.hops + 1, w.dir
              FROM walk w
              JOIN lineage_edge e
                ON (w.dir = 'up'   AND e.src_id = w.dst_id)
                OR (w.dir = 'down' AND e.dst_id = w.src_id)
             WHERE w.hops < %(d)s AND e.edge_kind = ANY(%(k)s)
        )
        SELECT DISTINCT ON (src_id, dst_id, relation, edge_kind)
               src_id, dst_id, relation, edge_kind, source, weight_30d, last_seen, attributes, hops
          FROM walk
         ORDER BY src_id, dst_id, relation, edge_kind, hops
         LIMIT %(lim)s
        """,
        {"f": focus, "k": kinds, "d": max(1, min(depth, 4)), "lim": limit + 1},
    )
    rows = list(cur.fetchall())
    return rows[:limit], len(rows) > limit


def upsert_edge(cur, src: str, dst: str, relation: str, edge_kind: str, source: str,
                weight_30d: int | None = None, attributes: dict | None = None) -> None:
    from psycopg.types.json import Jsonb

    cur.execute(
        """
        INSERT INTO lineage_edge (src_id, dst_id, relation, edge_kind, source, weight_30d, attributes)
        VALUES (%s, %s, %s, %s, %s, coalesce(%s, 0), %s)
        ON CONFLICT (src_id, dst_id, relation, edge_kind) DO UPDATE
           SET last_seen = now(), source = EXCLUDED.source,
               weight_30d = coalesce(%s, lineage_edge.weight_30d),
               attributes = lineage_edge.attributes || EXCLUDED.attributes
        """,
        (src, dst, relation, edge_kind, source, weight_30d, Jsonb(attributes or {}), weight_30d),
    )
