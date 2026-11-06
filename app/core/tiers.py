"""THE read choke point. Every read endpoint returns ``serve(...)`` so reads never 500.

``serve`` tries Lakebase, then the SQL warehouse, then a labeled synthetic generator, and returns an envelope::

    {"data": ..., "source": "lakebase" | "warehouse" | "synthetic" | "none",
     "degraded_reason": str | None, "as_of": "<UTC ISO-8601>"}

``degraded_reason`` explains every tier that was skipped or failed before the one that answered (None when the
first configured tier answered). ``source == "none"`` only when every tier failed; ``data`` is then None and the
UI shows an "unavailable" state instead of an error page.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from core.lakebase import describe_error

log = logging.getLogger("registry.tiers")

SOURCES = ("lakebase", "warehouse", "synthetic")
DEFAULT_TTL = 60.0

Fetch = Callable[[], Any]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def envelope(data: Any, source: str, degraded_reason: str | None = None, as_of: str | None = None) -> dict:
    return {"data": data, "source": source, "degraded_reason": degraded_reason, "as_of": as_of or now_iso()}


def serve(name: str, lakebase_fn: Fetch | None, warehouse_fn: Fetch | None = None,
          synthetic_fn: Fetch | None = None) -> dict:
    """Answer from the first tier that succeeds. Logs each failure and never raises."""
    reasons: list[str] = []
    for source, fn in zip(SOURCES, (lakebase_fn, warehouse_fn, synthetic_fn)):
        if fn is None:
            continue
        try:
            data = fn()
        except Exception as e:  # noqa: BLE001 - a failing tier degrades to the next one, never to a 500
            reason = f"{source}: {describe_error(e)}"
            reasons.append(reason)
            log.warning("read %r: %s tier failed (%s)", name, source, reason)
            log.debug("read %r: %s tier traceback", name, source, exc_info=True)
            continue
        if reasons:
            log.info("read %r served by %s (degraded)", name, source)
        return envelope(data, source, "; ".join(reasons) or None)
    if not reasons:
        reasons.append("no data tier is configured for this read")
    log.error("read %r: every tier failed: %s", name, "; ".join(reasons))
    return envelope(None, "none", "; ".join(reasons))


# ---------------------------------------------------------------------------------------------- TTL cache
class TTLCache:
    """A small thread-safe TTL cache keyed by (name, params). Bounded: the oldest entries are evicted first."""

    def __init__(self, ttl: float = DEFAULT_TTL, maxsize: int = 512) -> None:
        self.ttl = ttl
        self.maxsize = maxsize
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def key(name: str, params: Any = None) -> str:
        return name if params is None else f"{name}|{json.dumps(params, sort_keys=True, default=str)}"

    def get(self, name: str, params: Any = None) -> tuple[bool, Any]:
        k = self.key(name, params)
        with self._lock:
            hit = self._data.get(k)
            if hit is None:
                return False, None
            expires, value = hit
            if time.monotonic() >= expires:
                del self._data[k]
                return False, None
            return True, value

    def set(self, name: str, params: Any, value: Any, ttl: float | None = None) -> None:
        k = self.key(name, params)
        with self._lock:
            if k not in self._data and len(self._data) >= self.maxsize:
                oldest = min(self._data, key=lambda key: self._data[key][0])
                del self._data[oldest]
            self._data[k] = (time.monotonic() + (self.ttl if ttl is None else ttl), value)

    def get_or_set(self, name: str, params: Any, fn: Callable[[], Any], ttl: float | None = None) -> Any:
        found, value = self.get(name, params)
        if found:
            return value
        value = fn()
        self.set(name, params, value, ttl)
        return value

    def invalidate(self, name: str | None = None) -> int:
        """Drop every entry for ``name`` (all params), or everything when name is None. Returns the count."""
        with self._lock:
            if name is None:
                n = len(self._data)
                self._data.clear()
                return n
            doomed = [k for k in self._data if k == name or k.startswith(f"{name}|")]
            for k in doomed:
                del self._data[k]
            return len(doomed)


cache = TTLCache()


def cached(name: str, params: Any, fn: Callable[[], Any], ttl: float = DEFAULT_TTL) -> Any:
    """Memoize ``fn()`` for ``ttl`` seconds under (name, params). Exceptions are not cached."""
    return cache.get_or_set(name, params, fn, ttl)


def serve_cached(name: str, params: Any, lakebase_fn: Fetch | None, warehouse_fn: Fetch | None = None,
                 synthetic_fn: Fetch | None = None, ttl: float = DEFAULT_TTL) -> dict:
    """``serve`` with a TTL cache. Only healthy (non-degraded) envelopes are cached, so recovery shows at once."""
    found, value = cache.get(name, params)
    if found:
        return value
    result = serve(name, lakebase_fn, warehouse_fn, synthetic_fn)
    if result["degraded_reason"] is None:
        cache.set(name, params, result, ttl)
    return result


def invalidate(name: str | None = None) -> int:
    """Call after a write so the next read of ``name`` is fresh."""
    return cache.invalidate(name)
