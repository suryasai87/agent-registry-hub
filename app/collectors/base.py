"""Collector framework.

* ``Context``: the workspace connection a sync runs with: ``api()`` (REST through the SDK's ``api_client.do``
  with retry/backoff on 429/5xx and exact error capture), ``sql()`` (Statement Execution via ``core.warehouse``),
  ``mcp()`` (read-only JSON-RPC to an MCP endpoint), ``pmap()`` (bounded thread pool for per-item detail
  calls), plus ``host``, ``workspace_id``, ``me`` and ``days``.
* ``Collector``: one ``sync_run`` row per collector run (running -> succeeded | partial | failed | skipped). Subclasses
  implement ``collect()``: fetch from the workspace first, then write in ``self.transaction()`` with one
  savepoint per item (``self.item(...)``) so a single bad record never aborts the whole sync. A collector that is
  not configured sets ``self.skip_reason`` and returns (its run is recorded as 'skipped').
* ``run_all(selected, triggered_by)``: runs the collectors in dependency order under a Postgres advisory lock
  (two syncs never overlap), then backfills ``change_event.metrics_after`` and runs the optional Unity Catalog
  lineage publish step (``registry/uc_lineage.sync_step``) and the optional knowledge graph export step
  (``registry/kg_delta.sync_step``), each OFF unless an admin turned it on. Callable in-process.

Collectors are READ-ONLY against Databricks: GETs, SELECT-only SQL, MLflow search and MCP ``initialize`` /
``tools/list``. Tokens are never logged or stored.
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Any, Callable, Iterable, Iterator

from psycopg.types.json import Jsonb

from core import config, db, warehouse
from core.lakebase import describe_error

log = logging.getLogger("registry.collectors")

MAX_WORKERS = 6
RETRY_STATUSES = (429, 500, 502, 503, 504)
MAX_ERRORS_KEPT = 40
DEFAULT_DAYS = int(os.environ.get("SYNC_DAYS", "30"))
MCP_PROTOCOL_VERSION = "2025-06-18"
MCP_ACCEPT = "application/json, text/event-stream"
MCP_SESSION_HEADER = "mcp-session-id"
SQL_TIMEOUT_S = float(os.environ.get("SYNC_SQL_TIMEOUT_S", "600"))
SDK_RETRY_TIMEOUT_S = int(os.environ.get("SYNC_SDK_RETRY_TIMEOUT_S", "90"))  # SDK default is 300 s per call
MCP_TIMEOUT_S = float(os.environ.get("SYNC_MCP_TIMEOUT_S", "30"))
SLOW_CALL_S = 30.0


class ApiError(RuntimeError):
    """A failed REST call, with the exact status, error code and message the API returned."""

    def __init__(self, method: str, path: str, status: int | None, error_code: str | None, message: str):
        self.method, self.path, self.status, self.error_code = method, path, status, error_code
        self.message = " ".join((message or "").split())[:500]
        super().__init__(f"{method} {path} -> {status or '?'} {error_code or ''}: {self.message}".strip())

    def as_dict(self) -> dict:
        return {"method": self.method, "path": self.path, "status": self.status, "error_code": self.error_code,
                "message": self.message}


def _status_of(err: BaseException) -> int | None:
    from databricks.sdk.errors import platform

    for code, cls in platform.STATUS_CODE_MAPPING.items():
        if isinstance(err, cls):
            return code
    for attr in ("status_code", "status"):
        value = getattr(err, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(err, "response", None)
    return getattr(response, "status_code", None) if response is not None else None


def error_info(err: BaseException) -> dict:
    if isinstance(err, ApiError):
        return err.as_dict()
    return {"error": describe_error(err, 500)}


class Context:
    """Everything a collector needs to read the workspace. Construct once per sync."""

    def __init__(self, w: Any = None, *, days: int | None = None, warehouse_id: str | None = None,
                 host: str | None = None, workspace_id: str | None = None, sleep: Callable[[float], None] = time.sleep,
                 max_workers: int = MAX_WORKERS):
        self._w = w
        self.days = max(1, int(days or DEFAULT_DAYS))
        self.warehouse_id = warehouse_id or config.WAREHOUSE_ID
        self._host = host
        self._workspace_id = workspace_id
        self._me: dict | None = None
        self._sleep = sleep
        self.max_workers = max(1, min(MAX_WORKERS, max_workers))
        self._me_lock = threading.Lock()     # guards the one-time identity lookup (which itself calls api())
        self._count_lock = threading.Lock()  # guards the call counter
        self.calls = 0

    # ------------------------------------------------------------------ identity
    @property
    def w(self):
        if self._w is None:
            self._w = collector_client()
        return self._w

    @property
    def host(self) -> str:
        if not self._host:
            self._host = str(self.w.config.host).rstrip("/")
        return self._host

    @property
    def workspace_id(self) -> str:
        if not self._workspace_id:
            self._workspace_id = str(self.w.get_workspace_id())
        return self._workspace_id

    @property
    def me(self) -> dict:
        """The calling identity: ``{user_name, groups}`` (user_name is an email or an SP application id)."""
        with self._me_lock:
            if self._me is None:
                res = self.api("GET", "/api/2.0/preview/scim/v2/Me")
                self._me = {
                    "user_name": (res.get("userName") or "").lower() if "@" in (res.get("userName") or "") else res.get("userName"),
                    "groups": sorted({g.get("display") for g in res.get("groups") or [] if g.get("display")}),
                }
            return self._me

    # ------------------------------------------------------------------ clock (overridable in tests)
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def today(self) -> date:
        return self.now().date()

    # ------------------------------------------------------------------ REST
    def api(self, method: str, path: str, body: Any = None, query: dict | None = None, *, headers: dict | None = None,
            raw: bool = False, retries: int = 3, response_headers: list[str] | None = None) -> Any:
        """One REST call through the SDK. Retries 429/5xx with jittered backoff; raises ``ApiError`` otherwise."""
        attempt = 0
        while True:
            attempt += 1
            with self._count_lock:
                self.calls += 1
            started = time.monotonic()
            try:
                res = self.w.api_client.do(method, path, query=query, body=body, headers=dict(headers or {}), raw=raw,
                                           response_headers=response_headers)
                return res
            except Exception as e:  # noqa: BLE001 - normalised to ApiError below
                status = _status_of(e)
                code = getattr(e, "error_code", None)
                message = str(e) or type(e).__name__
                # The SDK already retried 429/503 and connection errors within its budget (TimeoutError = exhausted).
                if status in RETRY_STATUSES and status not in (429, 503) and attempt <= retries:
                    retry_after = getattr(e, "retry_after_secs", None)
                    delay = float(retry_after) if retry_after else min(20.0, 0.75 * 2 ** (attempt - 1)) + random.random() * 0.25
                    log.info("%s %s -> %s; retry %d/%d in %.1fs", method, path, status, attempt, retries, delay)
                    self._sleep(delay)
                    continue
                raise ApiError(method, path, status, code, message) from e
            finally:
                took = time.monotonic() - started
                if took > SLOW_CALL_S and not path.startswith("/api/2.0/sql/statements"):  # those wait up to 50 s by design
                    log.warning("slow call: %s %s took %.0fs", method, path, took)

    def paginate(self, path: str, items_key: str, query: dict | None = None, *, page_size_param: str = "page_size",
                 page_size: int | None = 100, token_param: str = "page_token", max_pages: int = 500) -> list[dict]:
        out: list[dict] = []
        params = dict(query or {})
        if page_size and page_size_param:
            params[page_size_param] = page_size
        for _ in range(max_pages):
            res = self.api("GET", path, query=params) or {}
            out.extend(res.get(items_key) or [])
            token = res.get("next_page_token")
            if not token:
                return out
            params[token_param] = token
        raise ApiError("GET", path, None, "TOO_MANY_PAGES", f"stopped after {max_pages} pages")

    def mcp(self, path: str, method: str, params: dict | None = None, *, request_id: int = 1,
            session: str | None = None) -> tuple[dict, str | None]:
        """A read-only JSON-RPC call (``initialize`` or ``tools/list``) to a Databricks MCP endpoint.

        Returns (result, Mcp-Session-Id). Streamable-HTTP servers that keep sessions issue the id on
        ``initialize`` and require it on every later request."""
        if method not in ("initialize", "tools/list"):
            raise ValueError(f"MCP method {method!r} is not allowed (read-only collectors)")
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            body["params"] = params
        headers = {"Accept": MCP_ACCEPT, "Content-Type": "application/json"}
        if session:
            headers[MCP_SESSION_HEADER] = session
        res = self.api("POST", path, body=body, raw=True, headers=headers, retries=1,
                       response_headers=[MCP_SESSION_HEADER])
        message = read_jsonrpc(res.get("contents"), request_id, deadline=time.monotonic() + MCP_TIMEOUT_S, path=path)
        if message.get("error"):
            err = message["error"]
            raise ApiError("POST", path, 200, f"JSONRPC_{err.get('code')}", str(err.get("message") or err))
        if "result" not in message:
            raise ApiError("POST", path, 200, message.get("error_code") or "NOT_JSONRPC",
                           str(message.get("message") or "the server did not return a JSON-RPC result"))
        return message.get("result") or {}, res.get(MCP_SESSION_HEADER) or session

    def mcp_tools(self, path: str) -> tuple[dict, list[dict]]:
        """``initialize`` (serverInfo, instructions) + ``tools/list`` (all pages)."""
        init, session = self.mcp(path, "initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": config.APP_NAME, "version": config.APP_VERSION}}, request_id=0)
        tools: list[dict] = []
        cursor = None
        for page in range(20):
            result, session = self.mcp(path, "tools/list", {"cursor": cursor} if cursor else None,
                                       request_id=page + 1, session=session)
            tools.extend(result.get("tools") or [])
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return init, tools

    # ------------------------------------------------------------------ SQL
    def sql(self, statement: str, params: Any = None, *, timeout_s: float = SQL_TIMEOUT_S) -> list[dict]:
        """A SELECT on the SQL warehouse (positional ``?`` or named ``:p`` markers), via the Statement Execution API.

        Uses ``core.warehouse`` for parameter binding and result typing, but submits with
        ``on_wait_timeout=CONTINUE`` and polls: system-table scans (e.g. 30 days of ``system.access.audit``)
        routinely exceed the 50 s synchronous limit, which an interactive read would rightly cancel.
        """
        head = statement.lstrip().split(None, 1)[0].upper() if statement.strip() else ""
        if head not in ("SELECT", "WITH", "DESCRIBE", "SHOW"):
            raise ValueError("collectors only run read-only SQL")
        if not self.warehouse_id:
            raise warehouse.WarehouseNotConfigured("WAREHOUSE_ID is not set")
        text, parameters = warehouse.bind(statement, params)
        body: dict[str, Any] = {"statement": text, "warehouse_id": self.warehouse_id, "wait_timeout": warehouse.WAIT_TIMEOUT,
                                "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE"}
        if parameters:
            body["parameters"] = parameters
        res = self.api("POST", "/api/2.0/sql/statements/", body=body) or {}
        deadline = time.monotonic() + timeout_s
        delay = 1.0
        while (res.get("status") or {}).get("state") in ("PENDING", "RUNNING"):
            if time.monotonic() > deadline:
                try:
                    self.api("POST", f"/api/2.0/sql/statements/{res['statement_id']}/cancel", retries=0)
                finally:
                    raise warehouse.WarehouseError(f"statement did not finish within {timeout_s:g}s (canceled)")
            self._sleep(delay)
            delay = min(delay * 1.5, 5.0)
            res = self.api("GET", f"/api/2.0/sql/statements/{res['statement_id']}") or {}
        status = res.get("status") or {}
        if status.get("state") != "SUCCEEDED":
            message = (status.get("error") or {}).get("message") or "no error message"
            raise warehouse.WarehouseError(f"statement {status.get('state') or 'UNKNOWN'}: {' '.join(message.split())[:500]}")
        columns = [(c.get("name"), str(c.get("type_name") or "STRING").upper())
                   for c in ((res.get("manifest") or {}).get("schema") or {}).get("columns") or []]
        result = res.get("result") or {}
        data = list(result.get("data_array") or [])
        next_chunk = result.get("next_chunk_index")
        while next_chunk is not None:
            chunk = self.api("GET", f"/api/2.0/sql/statements/{res['statement_id']}/result/chunks/{next_chunk}") or {}
            data.extend(chunk.get("data_array") or [])
            next_chunk = chunk.get("next_chunk_index")
        return [{name: warehouse._convert(v, t) for (name, t), v in zip(columns, row)} for row in data]

    # ------------------------------------------------------------------ concurrency
    def pmap(self, fn: Callable[[Any], Any], items: Iterable[Any], workers: int | None = None) -> list[tuple[Any, Any, BaseException | None]]:
        """Run ``fn`` over items with a bounded pool. Returns [(item, result, error)] in input order."""
        items = list(items)
        if not items:
            return []
        n = max(1, min(workers or self.max_workers, self.max_workers, len(items)))

        def safe(item):
            try:
                return item, fn(item), None
            except Exception as e:  # noqa: BLE001 - surfaced per item to the collector
                return item, None, e

        if n == 1:
            return [safe(i) for i in items]
        with ThreadPoolExecutor(max_workers=n, thread_name_prefix="collector") as pool:
            return list(pool.map(safe, items))


def collector_client():
    """A WorkspaceClient for the sync with a bounded SDK retry budget, so a throttled call fails (and is
    recorded) in ~90 s instead of sleeping for the SDK's default 300 s. Same credential chain as the app."""
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.core import Config

    profile = os.environ.get("DATABRICKS_PROFILE")
    if profile and not os.environ.get("DATABRICKS_CLIENT_ID"):
        return WorkspaceClient(config=Config(profile=profile, retry_timeout_seconds=SDK_RETRY_TIMEOUT_S))
    return WorkspaceClient(config=Config(retry_timeout_seconds=SDK_RETRY_TIMEOUT_S))


def read_jsonrpc(stream: Any, request_id: int, *, deadline: float, path: str = "") -> dict:
    """Read a JSON-RPC response from a raw HTTP stream, stopping as soon as the response message is complete.

    MCP servers may answer with ``text/event-stream`` and keep the stream open (keep-alive pings), so reading
    to EOF could block forever. The read is bounded by ``deadline``."""
    buf = b""
    try:
        while True:
            chunk = stream.read(512) if hasattr(stream, "read") else b""
            if not chunk:
                try:
                    return parse_jsonrpc(buf)
                except ValueError as e:
                    raise ApiError("POST", path, 200, "NOT_JSONRPC", f"unparseable MCP response ({e})") from e
            buf += chunk
            text = buf.lstrip()
            if text.startswith(b"{"):
                try:
                    return json.loads(text)
                except ValueError:
                    pass
            elif b"data:" in buf:
                msg = parse_jsonrpc(buf.rsplit(b"\n", 1)[0] if not buf.endswith(b"\n") else buf)
                if msg and (msg.get("id") in (request_id, None) or "result" in msg or "error" in msg):
                    return msg
            if text.startswith(b"<"):
                raise ApiError("POST", path, 200, "NOT_JSONRPC", "the server answered with HTML, not JSON-RPC")
            if time.monotonic() > deadline:
                raise ApiError("POST", path, None, "TIMEOUT", f"no complete JSON-RPC response within {MCP_TIMEOUT_S:g}s")
    finally:
        close = getattr(stream, "close", None)
        if close:
            close()


def parse_jsonrpc(payload: bytes | str) -> dict:
    """A JSON-RPC response that arrived as plain JSON or as a ``text/event-stream`` of ``data:`` lines."""
    text = payload.decode("utf-8", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload or "")
    text = text.strip()
    if not text:
        return {}
    if text.startswith("{"):
        return json.loads(text)
    last: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk.startswith("{"):
                msg = json.loads(chunk)
                if "result" in msg or "error" in msg:
                    last = msg
    return last


# ====================================================================== collector base
class Collector:
    name = ""
    label = ""

    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.items_seen = 0
        self.items_changed = 0
        self.detail: dict[str, Any] = {}
        self.errors: list[dict] = []
        self.error_count = 0
        self.seen_at = None  # the DB clock at the start of the write transaction
        self.skip_reason: str | None = None  # set by collect() when the source is not configured

    # ------------------------------------------------------------------ bookkeeping
    def warn(self, what: str, err: BaseException | str) -> None:
        self.error_count += 1
        if len(self.errors) < MAX_ERRORS_KEPT:
            info = {"error": err} if isinstance(err, str) else error_info(err)
            self.errors.append({"item": what, **info})
        log.warning("%s: %s: %s", self.name, what, err)

    def soft_fail(self, key: str, what: str, err: BaseException) -> None:
        """A per-item optional read failed. 403/404 are expected for a caller-scoped identity (e.g. the app SP
        cannot read another user's ACL), so they are counted under ``<key>_not_readable``; anything else is an
        error that makes the run 'partial'."""
        if isinstance(err, ApiError) and err.status in (403, 404):
            self.count(f"{key}_not_readable")
        else:
            self.warn(what, err)

    def count(self, key: str, n: int = 1) -> None:
        self.detail[key] = self.detail.get(key, 0) + n

    def changed(self, flag: bool | int) -> None:
        if flag:
            self.items_changed += int(flag)

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        with db.transaction() as cur:
            cur.execute("SELECT now() AS now")
            self.seen_at = cur.fetchone()["now"]
            yield cur

    @contextmanager
    def item(self, cur, what: str) -> Iterator[bool]:
        """A savepoint around one item's writes. A failure rolls back only that item and is recorded."""
        try:
            with cur.connection.transaction():
                yield True
        except Exception as e:  # noqa: BLE001 - one bad record must not abort the sync
            self.warn(what, e)

    def collect(self) -> None:
        raise NotImplementedError

    # ------------------------------------------------------------------ the sync_run row
    def run(self, triggered_by: str = "schedule") -> dict:
        started = time.monotonic()
        run_id = _start_run(self.name, triggered_by)
        status, error = "succeeded", None
        try:
            self.collect()
            if self.skip_reason:
                status, error = "skipped", self.skip_reason
            elif self.error_count:
                status = "partial"
        except Exception as e:  # noqa: BLE001 - the run row records the failure
            status, error = "failed", describe_error(e, 1000)
            if isinstance(e, ApiError):
                self.detail["fatal"] = e.as_dict()
            log.exception("collector %s failed", self.name)
        self.detail["duration_s"] = round(time.monotonic() - started, 2)
        if self.errors:
            self.detail["errors"] = self.errors
            self.detail["error_count"] = self.error_count
        _finish_run(run_id, status, self.items_seen, self.items_changed, self.detail, error)
        return {"run_id": run_id, "collector": self.name, "status": status, "items_seen": self.items_seen,
                "items_changed": self.items_changed, "error": error, "error_count": self.error_count,
                "duration_s": self.detail["duration_s"]}


def _start_run(collector: str, triggered_by: str, status: str = "running", error: str | None = None) -> int:
    with db.transaction() as cur:
        cur.execute(
            """INSERT INTO sync_run (collector, status, triggered_by, error, finished_at)
               VALUES (%s, %s, %s, %s, CASE WHEN %s <> 'running' THEN now() END) RETURNING run_id""",
            (collector, status, triggered_by, error, status),
        )
        return cur.fetchone()["run_id"]


def _finish_run(run_id: int, status: str, seen: int, changed: int, detail: dict, error: str | None) -> None:
    with db.transaction() as cur:
        cur.execute(
            """UPDATE sync_run SET finished_at = now(), status = %s, items_seen = %s, items_changed = %s,
                      detail = %s, error = %s WHERE run_id = %s""",
            (status, seen, changed, Jsonb(detail, dumps=lambda o: json.dumps(o, default=str)), error, run_id),
        )


# ====================================================================== run_all
LOCK_KEY = "agent-registry-hub:sync"


def lock_key(schema: str | None = None) -> str:
    """The advisory-lock key, per registry schema: syncs into different schemas (tests, branch schemas) never block
    each other; two syncs into the same schema never overlap."""
    return f"{LOCK_KEY}:{schema or db.lb.schema}"


def run_all(selected: Iterable[str] | None = None, triggered_by: str = "schedule", *, ctx: Context | None = None,
            days: int | None = None, backfill: bool = True) -> dict:
    """Run the collectors (all, or ``selected``) in dependency order. Never two syncs at once."""
    from collectors import OPTIONAL, ORDER, get

    names = resolve(selected)
    ctx = ctx or Context(days=days)
    with db.lb.direct_connection(autocommit=True) as lock_conn:
        key = lock_key()
        got = lock_conn.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (key,)).fetchone()[0]
        if not got:
            runs = [{"run_id": _start_run(n, triggered_by, "skipped", "another sync is already running"),
                     "collector": n, "status": "skipped"} for n in names]
            return {"ok": False, "skipped": True, "runs": runs}
        try:
            # Holding the lock means no other sync is alive: rows still 'running' belong to a process that died.
            with db.transaction() as cur:
                cur.execute("""UPDATE sync_run SET status = 'failed', finished_at = now(),
                                      error = 'interrupted: the sync process ended before this collector finished'
                                WHERE status = 'running'""")
            runs = []
            for name in ORDER + OPTIONAL:
                if name in names:
                    runs.append(get(name)(ctx).run(triggered_by))
            result: dict[str, Any] = {"ok": any(r["status"] in ("succeeded", "partial", "skipped") for r in runs), "runs": runs,
                                      "api_calls": ctx.calls}
            if backfill:
                from registry import kg_delta, uc_lineage, versioning

                with db.transaction() as cur:
                    result["metrics_after_backfilled"] = versioning.backfill_metrics_after(cur)
                result["uc_lineage"] = uc_lineage.sync_step(lambda: ctx.w, triggered_by=triggered_by)
                result["kg_export"] = kg_delta.sync_step(lambda: ctx.w, triggered_by=triggered_by)
            return result
        finally:
            lock_conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (key,))


def resolve(selected: Iterable[str] | None) -> list[str]:
    from collectors import OPTIONAL, ORDER, configured

    if selected is None:
        return list(ORDER) + [n for n in OPTIONAL if configured(n)]
    known = ORDER + OPTIONAL
    names = [s.strip() for s in selected if s and s.strip()]
    unknown = sorted(set(names) - set(known))
    if unknown:
        raise ValueError(f"unknown collectors {unknown}; choose from {list(known)}")
    return [n for n in known if n in names]
