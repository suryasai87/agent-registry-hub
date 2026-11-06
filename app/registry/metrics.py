"""Before/after metric snapshots for change-impact reports."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def snapshot(cur, asset_id: str, end: datetime, window_days: int = 7) -> dict:
    """Usage, cost, latency and eval means for ``asset_id`` over [end - window, end)."""
    start = end - timedelta(days=window_days)
    cur.execute(
        """
        SELECT coalesce(sum(requests), 0)::bigint AS requests, coalesce(sum(errors), 0)::bigint AS errors,
               max(p95_latency_ms) AS p95_ms
          FROM usage_daily WHERE asset_id = %s AND day >= %s::date AND day < %s::date
        """,
        (asset_id, start, end),
    )
    u = cur.fetchone() or {}
    cur.execute(
        "SELECT coalesce(sum(usd), 0)::float AS usd FROM cost_daily WHERE asset_id = %s AND day >= %s::date AND day < %s::date",
        (asset_id, start, end),
    )
    c = cur.fetchone() or {}
    cur.execute(
        "SELECT max(p95_ms) AS p95_ms FROM trace_daily WHERE asset_id = %s AND day >= %s::date AND day < %s::date",
        (asset_id, start, end),
    )
    t = cur.fetchone() or {}
    cur.execute(
        """
        SELECT scorer, avg(mean_value)::float AS v FROM eval_result
         WHERE asset_id = %s AND run_at >= %s AND run_at < %s AND mean_value IS NOT NULL
         GROUP BY scorer
        """,
        (asset_id, start, end),
    )
    evals = {r["scorer"]: round(r["v"], 4) for r in cur.fetchall()}
    requests = int(u.get("requests") or 0)
    errors = int(u.get("errors") or 0)
    p95 = u.get("p95_ms") or t.get("p95_ms")
    return {
        "window_days": window_days,
        "requests": requests,
        "error_rate": round(errors / requests, 4) if requests else None,
        "cost_usd": round(float(c.get("usd") or 0), 2),
        "p95_ms": int(p95) if p95 is not None else None,
        "eval": evals,
    }


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
