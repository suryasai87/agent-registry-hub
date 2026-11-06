"""Lakebase (autoscale Postgres) connection manager, workspace-portable.

Two modes, picked from config at construction:

- ``oauth`` (Databricks Apps / any Databricks identity): ``LAKEBASE_ENDPOINT`` names the endpoint
  (``projects/<p>/branches/<b>/endpoints/<e>``). A short-lived OAuth credential is minted through the REST
  API (``POST /api/2.0/postgres/credentials``), so it works on any databricks-sdk version. The host comes from
  ``GET /api/2.0/postgres/<endpoint>`` and the Postgres role from the running identity (see ``pg_user``).
- ``dsn`` (local development / tests): ``LAKEBASE_URL`` is a static libpq DSN, e.g. a local Docker Postgres.

Guarantees:
- The credential never leaves this process: it is passed to libpq as a connection kwarg and is never logged,
  printed or returned.
- The pool is rebuilt before the token expires, and ``max_lifetime`` (3000 s) stays below the ~1 h token TTL,
  so no connection outlives its credential. Stale connections (e.g. after scale-to-zero) are checked on checkout.
- An unreachable database fails fast: the first connection is probed directly, and after a failure further
  calls fail immediately for a short back-off instead of each waiting for the pool timeout.
- DATABRICKS_AUTH_STORAGE is never set or changed here: the SDK's default credential chain is used as is.
"""
from __future__ import annotations

import logging
import math
import os
import threading
import time
from contextlib import ExitStack, contextmanager
from datetime import datetime
from typing import Any, Iterator

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

from core import config

log = logging.getLogger("registry.lakebase")

MAX_LIFETIME = 3000  # seconds; must stay below the ~1 h OAuth token TTL (never 3600)
REFRESH_CUSHION = 300  # rebuild the pool this many seconds before the token expires
DEFAULT_TOKEN_TTL = 3600
FAIL_BACKOFF = 5.0  # after a failed connect, fail fast for this long

_w: Any = None
_w_lock = threading.Lock()


class LakebaseNotConfigured(RuntimeError):
    """Neither LAKEBASE_URL nor LAKEBASE_ENDPOINT is set."""


class LakebaseUnavailable(RuntimeError):
    """Lakebase could not be reached (credential, network or pool exhaustion)."""


def describe_error(e: BaseException, limit: int = 300) -> str:
    msg = " ".join(str(e).split())
    return f"{type(e).__name__}: {msg[:limit]}" if msg else type(e).__name__


def workspace_client():
    """Explicit DATABRICKS_PROFILE wins locally; otherwise the SDK default chain (Apps SP / job / ~/.databrickscfg)."""
    global _w
    with _w_lock:
        if _w is None:
            from databricks.sdk import WorkspaceClient

            profile = os.environ.get("DATABRICKS_PROFILE")
            _w = WorkspaceClient(profile=profile) if profile and not os.environ.get("DATABRICKS_CLIENT_ID") else WorkspaceClient()
        return _w


def pg_user() -> str:
    """Postgres role: PGUSER, else the app SP's client id (Apps), else the signed-in Databricks identity."""
    for var in ("PGUSER", "DATABRICKS_CLIENT_ID"):
        value = os.environ.get(var, "").strip()
        if value:
            return value
    return workspace_client().current_user.me().user_name  # a user's email, or an SP's application id


def resolve_host(endpoint: str) -> str:
    pinned = os.environ.get("LAKEBASE_HOST") or os.environ.get("PGHOST")
    if pinned:
        return pinned
    ep = workspace_client().api_client.do("GET", f"/api/2.0/postgres/{endpoint}")
    host = ((ep or {}).get("status") or {}).get("hosts", {}).get("host")
    if not host:
        raise LakebaseUnavailable(f"endpoint {endpoint} reported no host (is it running?)")
    return host


def _parse_expiry(value: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


class Lakebase:
    def __init__(
        self,
        *,
        url: str | None = None,
        endpoint: str | None = None,
        database: str | None = None,
        schema: str | None = None,
        port: int | None = None,
        application_name: str | None = None,
        pool_max: int | None = None,
        pool_timeout: float | None = None,
        connect_timeout: int | None = None,
    ) -> None:
        self.url = (config.LAKEBASE_URL if url is None else url).strip()
        self.endpoint = (config.LAKEBASE_ENDPOINT if endpoint is None else endpoint).strip()
        self.database = database or config.LAKEBASE_DATABASE
        self.schema = config.ident(schema or config.LAKEBASE_SCHEMA, "schema")
        self.port = port or config.LAKEBASE_PORT
        self.application_name = application_name or config.APP_NAME
        self.pool_max = pool_max or config.LAKEBASE_POOL_MAX
        self.pool_timeout = pool_timeout or config.LAKEBASE_POOL_TIMEOUT
        self.connect_timeout = connect_timeout or config.LAKEBASE_CONNECT_TIMEOUT
        self.last_error: str | None = None
        self._lock = threading.Lock()
        self._pool: ConnectionPool | None = None
        self._expires_at = 0.0
        self._retry_after = 0.0
        self._host: str | None = None

    # ------------------------------------------------------------------ configuration
    @property
    def mode(self) -> str:
        if self.url:
            return "dsn"
        if self.endpoint:
            return "oauth"
        return "unconfigured"

    @property
    def configured(self) -> bool:
        return self.mode != "unconfigured"

    @property
    def host(self) -> str:
        if self._host is None:
            self._host = resolve_host(self.endpoint)
        return self._host

    def describe(self) -> dict:
        """Where this pool points, without credentials."""
        info: dict[str, Any] = {"mode": self.mode, "schema": self.schema}
        if self.mode == "oauth":
            info.update(endpoint=self.endpoint, database=self.database, host=self._host)
        elif self.mode == "dsn":
            try:
                parts = conninfo_to_dict(self.url)
                info.update(host=parts.get("host"), port=parts.get("port"), database=parts.get("dbname"))
            except psycopg.ProgrammingError:
                info.update(host=None, database=None)
        return info

    def _mint_token(self) -> tuple[str, float]:
        res = workspace_client().api_client.do(
            "POST", "/api/2.0/postgres/credentials", body={"endpoint": self.endpoint},
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        token = res.get("token") if isinstance(res, dict) else None
        if not token:
            raise LakebaseUnavailable("the credential response carried no token")
        expires_at = _parse_expiry(res.get("expiration_time")) or time.time() + DEFAULT_TOKEN_TTL
        return token, expires_at

    def _connect_params(self) -> tuple[str, dict, float]:
        """(conninfo, connection kwargs, credential expiry epoch). The password only ever lives in kwargs."""
        kwargs: dict[str, Any] = {
            "application_name": self.application_name,
            "connect_timeout": self.connect_timeout,
            "options": f"-c search_path={self.schema},public",
        }
        if self.mode == "dsn":
            return self.url, kwargs, math.inf
        if self.mode == "oauth":
            token, expires_at = self._mint_token()
            conninfo = make_conninfo(host=self.host, port=self.port, dbname=self.database, user=pg_user(), sslmode="require")
            return conninfo, {**kwargs, "password": token}, expires_at
        raise LakebaseNotConfigured("Lakebase is not configured: set LAKEBASE_ENDPOINT (Databricks Apps) or LAKEBASE_URL (local Postgres)")

    # ------------------------------------------------------------------ pool lifecycle
    def _open_pool(self) -> tuple[ConnectionPool, float]:
        conninfo, kwargs, expires_at = self._connect_params()
        # Probe once directly: an unreachable or misconfigured database fails now with the real libpq error,
        # instead of the pool retrying in the background until its timeout.
        with psycopg.connect(conninfo, **kwargs) as probe:
            probe.execute("SELECT 1")
        pool = ConnectionPool(
            conninfo,
            kwargs=kwargs,
            min_size=1,
            max_size=self.pool_max,
            max_lifetime=MAX_LIFETIME,
            timeout=self.pool_timeout,
            check=ConnectionPool.check_connection,
            name=self.application_name,
            open=True,
        )
        return pool, expires_at

    @staticmethod
    def _close_later(pool: ConnectionPool) -> None:
        """Close a replaced pool off the request path; checked-out connections finish their work first."""
        threading.Thread(target=pool.close, kwargs={"timeout": 5.0}, name="lakebase-pool-close", daemon=True).start()

    def _ensure(self) -> ConnectionPool:
        with self._lock:
            now = time.time()
            pool = self._pool
            if pool is not None and now < self._expires_at - REFRESH_CUSHION:
                return pool
            usable_old = pool is not None and now < self._expires_at
            if now < self._retry_after:
                if usable_old:
                    return pool  # type: ignore[return-value]
                raise LakebaseUnavailable(self.last_error or "Lakebase unavailable")
            try:
                new_pool, expires_at = self._open_pool()
            except Exception as e:  # noqa: BLE001 - every failure becomes a typed, credential-free error
                self.last_error = describe_error(e)
                self._retry_after = now + FAIL_BACKOFF
                if usable_old:
                    log.warning("Lakebase credential refresh failed; keeping the current pool until it expires: %s", self.last_error)
                    return pool  # type: ignore[return-value]
                if pool is not None:
                    self._pool = None
                    self._close_later(pool)
                log.warning("Lakebase unavailable (%s): %s", self.mode, self.last_error)
                if isinstance(e, LakebaseNotConfigured):
                    raise
                raise LakebaseUnavailable(self.last_error) from e
            self._pool, self._expires_at = new_pool, expires_at
            self._retry_after = 0.0
            self.last_error = None
            if pool is not None:
                self._close_later(pool)
            log.info("Lakebase pool ready (%s, schema %s)", self.mode, self.schema)
            return new_pool

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        """A pooled connection. The block commits on success and rolls back on error."""
        pool = self._ensure()
        with ExitStack() as stack:
            try:
                conn = stack.enter_context(pool.connection())
            except PoolTimeout as e:
                self.last_error = describe_error(e)
                raise LakebaseUnavailable(f"no Lakebase connection within {self.pool_timeout:g}s") from e
            yield conn

    @contextmanager
    def direct_connection(self, autocommit: bool = False) -> Iterator[psycopg.Connection]:
        """A dedicated, non-pooled connection (migrations, long-running DDL). Closed on exit."""
        conninfo, kwargs, _ = self._connect_params()
        conn = psycopg.connect(conninfo, autocommit=autocommit, **kwargs)
        try:
            yield conn
            if not autocommit:
                conn.commit()
        except BaseException:
            if not autocommit and not conn.closed:
                try:
                    conn.rollback()
                except psycopg.Error:
                    log.warning("rollback after a failed direct transaction also failed")
            raise
        finally:
            conn.close()

    # ------------------------------------------------------------------ helpers
    def query(self, sql: str, params: Any = None) -> list[dict]:
        with self.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []

    def execute(self, sql: str, params: Any = None) -> int:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    def ping(self) -> float:
        """Round-trip a trivial query; returns latency in milliseconds (raises when unreachable)."""
        started = time.perf_counter()
        self.query("SELECT 1 AS ok")
        return round((time.perf_counter() - started) * 1000, 1)

    def close(self) -> None:
        with self._lock:
            pool, self._pool = self._pool, None
            self._expires_at = 0.0
        if pool is not None:
            pool.close()
