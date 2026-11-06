from datetime import datetime

import pytest

from core import tiers
from core.lakebase import LakebaseUnavailable


def boom(exc):
    def _fn():
        raise exc
    return _fn


def test_lakebase_answers_first_and_is_not_degraded():
    out = tiers.serve("agents", lambda: [1], lambda: [2], lambda: [3])
    assert out["source"] == "lakebase"
    assert out["data"] == [1]
    assert out["degraded_reason"] is None
    datetime.fromisoformat(out["as_of"])  # ISO-8601


def test_falls_through_to_warehouse_with_the_lakebase_reason():
    out = tiers.serve("agents", boom(LakebaseUnavailable("connection refused")), lambda: [2], lambda: [3])
    assert out["source"] == "warehouse"
    assert out["data"] == [2]
    assert out["degraded_reason"] == "lakebase: LakebaseUnavailable: connection refused"


def test_falls_through_to_synthetic_with_every_reason():
    out = tiers.serve("agents", boom(LakebaseUnavailable("down")), boom(TimeoutError("50s")), lambda: [{"id": "synthetic-1"}])
    assert out["source"] == "synthetic"
    assert out["data"] == [{"id": "synthetic-1"}]
    assert out["degraded_reason"] == "lakebase: LakebaseUnavailable: down; warehouse: TimeoutError: 50s"


def test_never_raises_when_every_tier_fails(caplog):
    out = tiers.serve("agents", boom(RuntimeError("a")), boom(KeyError("b")), boom(ZeroDivisionError("c")))
    assert out["source"] == "none"
    assert out["data"] is None
    assert "lakebase: RuntimeError: a" in out["degraded_reason"]
    assert "warehouse: KeyError" in out["degraded_reason"]
    assert "synthetic: ZeroDivisionError: c" in out["degraded_reason"]
    assert sum(r.levelname == "WARNING" and "tier failed" in r.getMessage() for r in caplog.records) == 3  # each failure logged


def test_missing_tiers_are_skipped_and_no_tiers_is_not_an_exception():
    assert tiers.serve("x", None, None, lambda: "s")["source"] == "synthetic"
    assert tiers.serve("x", None, lambda: "w")["source"] == "warehouse"
    out = tiers.serve("x", None)
    assert out["source"] == "none" and out["degraded_reason"] == "no data tier is configured for this read"


def test_falsy_data_is_still_an_answer():
    out = tiers.serve("x", lambda: [], lambda: [9])
    assert out["source"] == "lakebase" and out["data"] == []


def test_ttl_cache_hits_expires_and_invalidates(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(tiers.time, "monotonic", lambda: clock[0])
    calls = []

    def fetch():
        calls.append(1)
        return len(calls)

    assert tiers.cached("count", {"b": 2, "a": 1}, fetch) == 1
    assert tiers.cached("count", {"a": 1, "b": 2}, fetch) == 1  # same params, any key order
    assert tiers.cached("count", {"a": 2}, fetch) == 2  # different params
    clock[0] += 61
    assert tiers.cached("count", {"a": 1, "b": 2}, fetch) == 3  # default TTL is 60 s
    assert tiers.invalidate("count") == 2
    assert tiers.cached("count", {"a": 2}, fetch) == 4


def test_exceptions_are_not_cached():
    with pytest.raises(ValueError):
        tiers.cached("bad", None, boom(ValueError("no")))
    assert tiers.cached("bad", None, lambda: "ok") == "ok"


def test_serve_cached_caches_only_healthy_answers():
    state = {"lakebase_up": False, "calls": 0}

    def lakebase():
        state["calls"] += 1
        if not state["lakebase_up"]:
            raise LakebaseUnavailable("down")
        return "fresh"

    first = tiers.serve_cached("agents", None, lakebase, synthetic_fn=lambda: "synthetic")
    assert first["source"] == "synthetic"
    state["lakebase_up"] = True
    second = tiers.serve_cached("agents", None, lakebase, synthetic_fn=lambda: "synthetic")
    assert second["source"] == "lakebase" and second["data"] == "fresh"  # recovery shows at once
    third = tiers.serve_cached("agents", None, lakebase, synthetic_fn=lambda: "synthetic")
    assert third is second and state["calls"] == 2  # healthy answer served from cache


def test_cache_is_bounded():
    cache = tiers.TTLCache(ttl=60, maxsize=3)
    for i in range(5):
        cache.set("k", i, i)
    assert len(cache._data) == 3
    assert cache.get("k", 0) == (False, None)
    assert cache.get("k", 4) == (True, 4)
