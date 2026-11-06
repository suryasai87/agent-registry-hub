"""Write-path guards and the exception -> HTTP mapping shared by every module.

Reads degrade through ``core.tiers.serve`` and never 500. Governed writes fail loudly and precisely:

    503  WriteUnavailable / Lakebase unreachable / read-only kiosk mode (ALLOW_MUTATIONS=false)
    403  Forbidden, or Postgres refused it (SQLSTATE 42501, row-level security / privilege)
    404  NotFound
    409  Conflict, or a unique / foreign-key / exclusion violation (SQLSTATE 23505, 23503, 23P01)
    400  ValueError / KeyError, or invalid input caught by Postgres (check / not-null / bad value, 22xxx)

Usage in a route::

    @router.post("/api/things")
    def create(body: ThingIn, request: Request):
        require_writes()
        return guard(service.create, body, actor=current_user(request)["email"])
"""
from __future__ import annotations

import logging
from typing import Any, Callable, TypeVar

import psycopg
from fastapi import HTTPException
from psycopg_pool import PoolTimeout

from core import config, db
from core.lakebase import LakebaseNotConfigured, LakebaseUnavailable, describe_error

log = logging.getLogger("registry.guard")
T = TypeVar("T")

_CONFLICT_STATES = {"23505", "23503", "23P01", "40001", "40P01"}  # unique, FK, exclusion, serialization, deadlock
_BAD_INPUT_STATES = {"23502", "23514"}  # not-null, check


class WriteUnavailable(RuntimeError):
    pass


class Forbidden(PermissionError):
    pass


class NotFound(LookupError):
    pass


class Conflict(RuntimeError):
    pass


def require_writes() -> None:
    """503 unless mutations are enabled and Lakebase answers."""
    if not config.ALLOW_MUTATIONS:
        raise HTTPException(503, "Read-only kiosk mode (ALLOW_MUTATIONS=false): changes are disabled")
    try:
        db.lb.query("SELECT 1")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Lakebase unavailable, changes cannot be saved ({type(e).__name__})")


def to_http(e: BaseException) -> HTTPException | None:
    """The HTTP error for a known failure, or None for an unexpected one (which should propagate)."""
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, WriteUnavailable):
        return HTTPException(503, str(e) or "Writes are unavailable")
    if isinstance(e, Forbidden):
        return HTTPException(403, str(e) or "Forbidden")
    if isinstance(e, NotFound):
        return HTTPException(404, str(e).strip("'\"") or "Not found")
    if isinstance(e, Conflict):
        return HTTPException(409, str(e) or "Conflict")
    sqlstate = getattr(e, "sqlstate", None)
    if isinstance(e, psycopg.Error) and sqlstate:
        diag = getattr(e, "diag", None)
        detail = (getattr(diag, "message_primary", None) or str(e)).strip()
        if sqlstate == "42501":
            return HTTPException(403, "Not permitted by the database (privilege or row-level security)")
        if sqlstate in _CONFLICT_STATES:
            return HTTPException(409, detail)
        if sqlstate in _BAD_INPUT_STATES or sqlstate.startswith("22"):
            return HTTPException(400, detail)
    if isinstance(e, (LakebaseUnavailable, LakebaseNotConfigured, PoolTimeout, psycopg.OperationalError)):
        return HTTPException(503, f"Lakebase unavailable, changes cannot be saved ({type(e).__name__})")
    if isinstance(e, (ValueError, KeyError)):
        return HTTPException(400, str(e).strip("'\"") or type(e).__name__)
    return None


def guard(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a write and translate known failures to HTTP errors; unexpected errors propagate (logged by the app)."""
    try:
        return fn(*args, **kwargs)
    except Exception as e:  # noqa: BLE001
        mapped = to_http(e)
        if mapped is None:
            raise
        if mapped.status_code >= 500:
            log.warning("write %s refused: %s", getattr(fn, "__name__", "call"), describe_error(e))
        raise mapped from e
