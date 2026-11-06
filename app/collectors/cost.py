"""Daily cost at list price (``is_estimate = true``): ``system.billing.usage`` joined to ``list_prices`` on SKU,
cloud, unit and the price window, using ``pricing.effective_list.default``. Last ``days`` days, refreshed
incrementally (three days of overlap: billing restates recent records).

Attribution (grouped by ``(billing_origin_product, usage_metadata.endpoint_name)``, never by name alone, because
``endpoint_name`` is a shared namespace across products):
* MODEL_SERVING, AGENT_BRICKS, SUPERVISOR_AGENT, AI_GATEWAY, AGENT_EVALUATION -> ``agent:endpoint:<name>`` when
  that asset exists.
* VECTOR_SEARCH -> only a Knowledge Assistant's own vector-search endpoint (``ka-<id>-vs-endpoint``) is
  attributed, to ``agent:endpoint:ka-<id>-endpoint``; every other VS endpoint is a shared resource and skipped.
* APPS by ``usage_metadata.app_name`` -> the Agent Runtime agent ``agent:app:<name>``, else split evenly across
  the custom MCP connections that app hosts (``hosts`` edges).
"""
from __future__ import annotations

import re
from datetime import timedelta
from decimal import Decimal

from collectors.base import Collector
from collectors.util import to_date
from core import db

NAME = "cost"
SOURCE = "billing_usage"
OVERLAP_DAYS = 3
SERVING_PRODUCTS = ("MODEL_SERVING", "AGENT_BRICKS", "SUPERVISOR_AGENT", "AI_GATEWAY", "AGENT_EVALUATION")
KA_VS = re.compile(r"^(ka-[0-9a-f]{6,})-vs-endpoint$")

COST_SQL = """
SELECT u.usage_date AS day, u.billing_origin_product AS product, u.usage_metadata.endpoint_name AS endpoint_name,
       u.usage_metadata.app_name AS app_name, u.sku_name AS sku,
       sum(u.usage_quantity) AS dbus, sum(u.usage_quantity * lp.pricing.effective_list.default) AS usd
  FROM system.billing.usage u
  JOIN system.billing.list_prices lp
    ON u.sku_name = lp.sku_name AND u.cloud = lp.cloud AND u.usage_unit = lp.usage_unit
   AND u.usage_end_time >= lp.price_start_time
   AND (lp.price_end_time IS NULL OR u.usage_end_time < lp.price_end_time)
 WHERE u.workspace_id = ? AND u.usage_date >= ?
   AND u.billing_origin_product IN ('MODEL_SERVING', 'AGENT_BRICKS', 'SUPERVISOR_AGENT', 'AI_GATEWAY',
                                    'AGENT_EVALUATION', 'APPS', 'VECTOR_SEARCH')
 GROUP BY ALL
"""


class CostCollector(Collector):
    name = NAME
    label = "Cost (billing usage x list prices)"

    def collect(self) -> None:
        ctx = self.ctx
        floor = ctx.today() - timedelta(days=ctx.days)
        last = (db.query_one("SELECT max(day) AS d FROM cost_daily WHERE source = %s", (SOURCE,)) or {}).get("d")
        start = max(floor, last - timedelta(days=OVERLAP_DAYS)) if last else floor
        self.detail["start_day"] = start.isoformat()
        rows = ctx.sql(COST_SQL, [ctx.workspace_id, start])
        self.items_seen = len(rows)

        with self.transaction() as cur:
            cur.execute("SELECT asset_id, subtype FROM asset WHERE asset_id LIKE 'agent:%%'")
            agents = {r["asset_id"]: r["subtype"] for r in cur.fetchall()}
            cur.execute("""SELECT src_id, dst_id FROM lineage_edge WHERE relation = 'hosts' AND src_id LIKE 'app:%%'
                            AND dst_id LIKE 'mcp:connection:%%'""")
            hosted: dict[str, list[str]] = {}
            for r in cur.fetchall():
                hosted.setdefault(r["src_id"].removeprefix("app:"), []).append(r["dst_id"])
            agg: dict[tuple, list[Decimal]] = {}
            unattributed = Decimal(0)
            for r in rows:
                targets = self._targets(r, agents, hosted)
                usd = Decimal(r.get("usd") or 0)
                dbus = Decimal(r.get("dbus") or 0)
                if not targets:
                    unattributed += usd
                    continue
                share = Decimal(len(targets))
                for t in targets:
                    key = (to_date(r["day"]), t, r.get("sku") or "unknown")
                    cur_ = agg.setdefault(key, [Decimal(0), Decimal(0)])
                    cur_[0] += dbus / share
                    cur_[1] += usd / share
            agg = {k: v for k, v in agg.items() if k[0] and k[0] >= start}  # only the refreshed days
            cur.execute("DELETE FROM cost_daily WHERE source = %s AND day >= %s", (SOURCE, start))
            if agg:
                cur.executemany(
                    """INSERT INTO cost_daily (day, asset_id, sku, source, dbus, usd, is_estimate)
                       VALUES (%s, %s, %s, %s, %s, %s, true)
                       ON CONFLICT (day, asset_id, sku, source) DO UPDATE
                          SET dbus = EXCLUDED.dbus, usd = EXCLUDED.usd, is_estimate = true""",
                    [(k[0], k[1], k[2], SOURCE, v[0], v[1]) for k, v in agg.items()],
                )
            self.detail.update(cost_rows=len(agg), attributed_assets=len({k[1] for k in agg}),
                               unattributed_usd=float(round(unattributed, 2)))

    @staticmethod
    def _targets(r: dict, agents: dict[str, str], hosted: dict[str, list[str]]) -> list[str]:
        product, endpoint, app = r.get("product"), r.get("endpoint_name"), r.get("app_name")
        if product in SERVING_PRODUCTS and endpoint and f"agent:endpoint:{endpoint}" in agents:
            return [f"agent:endpoint:{endpoint}"]
        if product == "VECTOR_SEARCH" and endpoint:
            m = KA_VS.match(endpoint)
            aid = f"agent:endpoint:{m.group(1)}-endpoint" if m else None
            if aid and agents.get(aid) == "agent_bricks_knowledge_assistant":
                return [aid]
            return []
        if product == "APPS" and app:
            if f"agent:app:{app}" in agents:
                return [f"agent:app:{app}"]
            return sorted(hosted.get(app, []))
        return []
