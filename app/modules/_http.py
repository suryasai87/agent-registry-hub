"""Shared plumbing for the registry routers.

* ``read(name, fn, synthetic)``: every GET. It runs ``fn(cur)`` in a read-only transaction through the tier
  choke point (Lakebase → labelled synthetic fallback), so a read never returns 500.
* ``write(request, fn)``: every mutation. It checks writes are enabled, resolves the principal, runs
  ``fn(cur, p)`` in ONE transaction (change + audit row commit together), maps failures to HTTP errors and
  drops read caches.
"""
from __future__ import annotations

from typing import Any, Callable

from fastapi import Request
from fastapi.encoders import jsonable_encoder

from core import db, tiers
from core.guard import Forbidden, NotFound, guard, require_writes, to_http
from registry import authz

OBO_HEADER = "x-forwarded-access-token"


def _in_tx(fn: Callable[[Any], Any], readonly: bool = True) -> Any:
    with db.transaction() as cur:
        if readonly:
            cur.execute("SET TRANSACTION READ ONLY")
        return jsonable_encoder(fn(cur))


def read(name: str, fn: Callable[[Any], Any], synthetic: Callable[[], Any] | None = None) -> dict:
    """A domain answer (404/403/400) is a real answer: it is raised, never masked by the synthetic tier.
    Only infrastructure failures (Lakebase down, pool timeout) degrade to the labelled synthetic data."""
    domain_error: list[BaseException] = []

    def lakebase() -> Any:
        try:
            return _in_tx(fn)
        except (NotFound, Forbidden, ValueError, KeyError) as e:
            domain_error.append(e)
            raise

    def synth() -> Any:
        if domain_error:
            raise domain_error[0]
        if synthetic is None:
            raise RuntimeError("no synthetic fallback for this read")
        return jsonable_encoder(synthetic())

    envelope = tiers.serve(name, lakebase, None, synth)
    if domain_error:
        raise to_http(domain_error[0]) or domain_error[0]
    return envelope


def write(request: Request, fn: Callable[[Any, authz.Principal], Any]) -> Any:
    require_writes()
    p = authz.principal(request)
    result = guard(lambda: _in_tx(lambda cur: fn(cur, p), readonly=False))
    tiers.invalidate()
    return result


def principal(request: Request) -> authz.Principal:
    return authz.principal(request)


def user_token(request: Request) -> str | None:
    return (request.headers.get(OBO_HEADER) or "").strip() or None


def asset_row(cur, asset_id: str) -> dict:
    from core.guard import NotFound

    cur.execute("SELECT * FROM asset WHERE asset_id = %s", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    return a
