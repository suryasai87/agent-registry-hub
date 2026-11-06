"""GET /api/health: Lakebase round-trip, warehouse reachability, version, kiosk mode and the caller. Never 500s.

Each probe runs with a deadline so a hung dependency cannot stall the endpoint; the warehouse probe only reads
the warehouse's state (no SQL), so a health check never starts a stopped warehouse, and is cached for 30 s.
"""
from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any, Callable

from fastapi import APIRouter, Request

from core import config, db, tiers, warehouse
from core.identity import current_user
from core.lakebase import describe_error

log = logging.getLogger("registry.health")
router = APIRouter(tags=["platform"])

PROBE_TIMEOUT = float(os.environ.get("HEALTH_PROBE_TIMEOUT", "6"))
WAREHOUSE_TTL = 30.0
_probes = ThreadPoolExecutor(max_workers=4, thread_name_prefix="health-probe")


def _within(fn: Callable[[], Any], timeout: float) -> Any:
    return _probes.submit(fn).result(timeout=timeout)


def lakebase_status() -> dict:
    lb = db.lb
    info: dict[str, Any] = {"ok": False, "latency_ms": None, **lb.describe()}
    if not lb.configured:
        info["error"] = "not configured: set LAKEBASE_ENDPOINT (Databricks Apps) or LAKEBASE_URL (local Postgres)"
        return info
    try:
        info["latency_ms"] = _within(lb.ping, PROBE_TIMEOUT)
        info["ok"] = True
    except FutureTimeout:
        info["error"] = f"no answer within {PROBE_TIMEOUT:g}s"
    except Exception as e:  # noqa: BLE001
        info["error"] = describe_error(e)
    return info


def warehouse_status() -> dict:
    if not warehouse.configured():
        return {"configured": False}

    def probe() -> dict:
        try:
            return _within(warehouse.status, PROBE_TIMEOUT)
        except FutureTimeout:
            return {"configured": True, "ok": False, "error": f"no answer within {PROBE_TIMEOUT:g}s"}

    return tiers.cached("health.warehouse", config.WAREHOUSE_ID, probe, ttl=WAREHOUSE_TTL)


@router.get("/api/health")
def health(request: Request) -> dict:
    try:
        lake = lakebase_status()
        wh = warehouse_status()
        user = current_user(request)
        return {
            "status": "ok" if lake["ok"] else "degraded",
            "app": config.APP_NAME,
            "version": config.APP_VERSION,
            "allow_mutations": config.ALLOW_MUTATIONS,
            "lakebase": lake,
            "warehouse": wh,
            "user": {"email": user["email"], "name": user["name"], "source": user["source"]},
            "time": tiers.now_iso(),
        }
    except Exception as e:  # noqa: BLE001 - the health endpoint itself must never fail
        log.exception("health check failed")
        return {"status": "error", "app": config.APP_NAME, "version": config.APP_VERSION,
                "allow_mutations": config.ALLOW_MUTATIONS, "lakebase": {"ok": False, "latency_ms": None},
                "warehouse": {"configured": warehouse.configured()}, "user": None, "error": describe_error(e),
                "time": tiers.now_iso()}
