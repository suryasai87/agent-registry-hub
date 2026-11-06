"""SQL warehouse tier: the Statement Execution API over plain REST (works on any databricks-sdk version).

``execute("SELECT * FROM t WHERE id = ? AND kind = ?", [42, "mcp"])`` rewrites the positional ``?`` markers to
named ``:p0, :p1`` parameters (markers inside string literals, quoted identifiers and comments are left alone),
waits up to ``wait_timeout`` (5-50 s; the API rejects anything else) and returns ``list[dict]`` with values
converted from the result manifest's column types. Named markers with a mapping of params are accepted as is.
"""
from __future__ import annotations

import json
import re
import time
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from core import config
from core.lakebase import describe_error, workspace_client

WAIT_TIMEOUT = "50s"
POLL_INTERVAL_S = 3.0
_sleep = time.sleep  # tests replace it
_INT_TYPES = {"BYTE", "SHORT", "INT", "LONG"}
_FLOAT_TYPES = {"FLOAT", "DOUBLE"}
_JSON_TYPES = {"ARRAY", "MAP", "STRUCT"}


class WarehouseNotConfigured(RuntimeError):
    """WAREHOUSE_ID is not set."""


class WarehouseError(RuntimeError):
    """The statement failed, was canceled, or did not finish within wait_timeout."""


def configured() -> bool:
    return bool(config.WAREHOUSE_ID)


def validate_wait_timeout(value: str) -> str:
    m = re.fullmatch(r"(\d+)s", value or "")
    if not m or not 5 <= int(m.group(1)) <= 50:
        raise ValueError(f"wait_timeout must be between '5s' and '50s', got {value!r}")
    return value


def _skip_quoted(sql: str, i: int) -> int:
    """Index just past the quoted literal/identifier that starts at sql[i]."""
    quote, j, n = sql[i], i + 1, len(sql)
    while j < n:
        ch = sql[j]
        if ch == "\\" and quote != "`":
            j += 2
            continue
        if ch == quote:
            if j + 1 < n and sql[j + 1] == quote:  # doubled quote stays inside the token
                j += 2
                continue
            return j + 1
        j += 1
    return n


def positional_to_named(sql: str, count: int) -> str:
    out: list[str] = []
    i, idx, n = 0, 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch in ("'", '"', "`"):
            j = _skip_quoted(sql, i)
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j == -1 else j
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            j = n if j == -1 else j + 2
        elif ch == "?":
            out.append(f":p{idx}")
            idx += 1
            i += 1
            continue
        else:
            out.append(ch)
            i += 1
            continue
        out.append(sql[i:j])
        i = j
    if idx != count:
        raise ValueError(f"the SQL has {idx} '?' markers but {count} parameters were given")
    return "".join(out)


def parameter(name: str, value: Any) -> dict:
    """One Statement Execution parameter. A missing ``value`` key means SQL NULL."""
    if value is None:
        return {"name": name, "type": "STRING"}
    if isinstance(value, bool):
        return {"name": name, "value": "true" if value else "false", "type": "BOOLEAN"}
    if isinstance(value, int):
        return {"name": name, "value": str(value), "type": "BIGINT"}
    if isinstance(value, float):
        return {"name": name, "value": repr(value), "type": "DOUBLE"}
    if isinstance(value, Decimal):
        t = value.as_tuple()
        scale = max(0, -int(t.exponent)) if isinstance(t.exponent, int) else 0
        precision = min(38, max(len(t.digits), scale, 1))
        return {"name": name, "value": str(value), "type": f"DECIMAL({precision},{min(scale, precision)})"}
    if isinstance(value, datetime):
        return {"name": name, "value": value.isoformat(), "type": "TIMESTAMP"}
    if isinstance(value, date):
        return {"name": name, "value": value.isoformat(), "type": "DATE"}
    if isinstance(value, str):
        return {"name": name, "value": value, "type": "STRING"}
    raise ValueError(f"unsupported SQL parameter type {type(value).__name__} for {name!r}")


def bind(sql: str, params: Sequence[Any] | Mapping[str, Any] | None) -> tuple[str, list[dict]]:
    if params is None:
        return sql, []
    if isinstance(params, Mapping):
        return sql, [parameter(str(k), v) for k, v in params.items()]
    if isinstance(params, (str, bytes)):
        raise ValueError("params must be a sequence or mapping, not a string")
    values = list(params)
    return positional_to_named(sql, len(values)), [parameter(f"p{i}", v) for i, v in enumerate(values)]


def _convert(value: Any, type_name: str) -> Any:
    if value is None:
        return None
    if type_name in _INT_TYPES:
        return int(value)
    if type_name in _FLOAT_TYPES:
        return float(value)
    if type_name == "DECIMAL":
        return Decimal(value)
    if type_name == "BOOLEAN":
        return str(value).lower() == "true"
    if type_name in _JSON_TYPES and isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def execute(sql: str, params: Sequence[Any] | Mapping[str, Any] | None = None, *, wait_timeout: str = WAIT_TIMEOUT,
            warehouse_id: str | None = None, client: Any = None, max_wait_s: float | None = None) -> list[dict]:
    """``max_wait_s``: for long DDL (or a warehouse that is still starting), keep the statement running past
    ``wait_timeout`` and poll it until it finishes, canceling it after ``max_wait_s`` seconds in total."""
    wid = warehouse_id or config.WAREHOUSE_ID
    if not wid:
        raise WarehouseNotConfigured("WAREHOUSE_ID is not set")
    statement, parameters = bind(sql, params)
    body: dict[str, Any] = {
        "statement": statement,
        "warehouse_id": wid,
        "wait_timeout": validate_wait_timeout(wait_timeout),
        "on_wait_timeout": "CONTINUE" if max_wait_s else "CANCEL",
        "format": "JSON_ARRAY",
        "disposition": "INLINE",
    }
    if parameters:
        body["parameters"] = parameters
    api = (client or workspace_client()).api_client
    started = time.monotonic()
    res = api.do("POST", "/api/2.0/sql/statements/", body=body) or {}
    status = res.get("status") or {}
    state = status.get("state")
    while max_wait_s and state in ("PENDING", "RUNNING") and res.get("statement_id"):
        if time.monotonic() - started > max_wait_s:
            try:
                api.do("POST", f"/api/2.0/sql/statements/{res['statement_id']}/cancel")
            except Exception:  # noqa: BLE001 - the error below is what matters
                pass
            raise WarehouseError(f"statement did not finish within {max_wait_s:.0f} s (state {state}); canceled")
        _sleep(POLL_INTERVAL_S)
        res = api.do("GET", f"/api/2.0/sql/statements/{res['statement_id']}") or {}
        status = res.get("status") or {}
        state = status.get("state")
    if state != "SUCCEEDED":
        if state in ("PENDING", "RUNNING", "CANCELED"):
            raise WarehouseError(f"statement did not finish within {wait_timeout} (state {state})")
        message = (status.get("error") or {}).get("message") or "no error message"
        raise WarehouseError(f"statement {state or 'UNKNOWN'}: {' '.join(message.split())[:300]}")
    columns = [(c.get("name"), str(c.get("type_name") or "STRING").upper())
               for c in ((res.get("manifest") or {}).get("schema") or {}).get("columns") or []]
    result = res.get("result") or {}
    rows: list[list[Any]] = list(result.get("data_array") or [])
    next_chunk = result.get("next_chunk_index")
    while next_chunk is not None:
        chunk = api.do("GET", f"/api/2.0/sql/statements/{res['statement_id']}/result/chunks/{next_chunk}") or {}
        rows.extend(chunk.get("data_array") or [])
        next_chunk = chunk.get("next_chunk_index")
    return [{name: _convert(v, t) for (name, t), v in zip(columns, row)} for row in rows]


def status(warehouse_id: str | None = None, client: Any = None) -> dict:
    """Warehouse state without running SQL (so a health check never starts a stopped warehouse)."""
    wid = warehouse_id or config.WAREHOUSE_ID
    if not wid:
        return {"configured": False}
    try:
        info = (client or workspace_client()).api_client.do("GET", f"/api/2.0/sql/warehouses/{wid}") or {}
        state = info.get("state")
        return {"configured": True, "ok": state in ("RUNNING", "STARTING", "STOPPED", "STOPPING"), "state": state,
                "name": info.get("name")}
    except Exception as e:  # noqa: BLE001 - health reporting never raises
        return {"configured": True, "ok": False, "error": describe_error(e)}
