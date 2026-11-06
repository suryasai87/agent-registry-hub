"""Microsoft Agent 365 registrations, read from Microsoft Graph through a Unity Catalog HTTP connection.

Disabled unless an admin configures ``AGENT365_CONNECTION`` (bundle variable ``agent365_connection``): a UC HTTP
connection to ``https://graph.microsoft.com`` whose OAuth machine-to-machine credential (an Entra app with
``CopilotPackages.Read.All``) is stored in the connection. The app and the job never see the secret: the call goes
through ``POST /api/2.0/external-function`` (the SDK's ``serving_endpoints.http_request``), which needs
``USE CONNECTION`` for the sync identity.

Source: ``GET /v1.0/copilot/admin/catalog/packages`` (Package Management API, Agent 365 license), every page via
``@odata.nextLink``. Matching and writes are ``registry/agent365.ingest`` (the same path as the admin's file import).
Read-only: one GET per page against Microsoft Graph, nothing is written to Databricks or Microsoft 365.
"""
from __future__ import annotations

import json
import os
from urllib.parse import parse_qsl, urlparse

from collectors.base import ApiError, Collector
from registry import agent365

NAME = "agent365"
GRAPH_PATH = os.environ.get("AGENT365_GRAPH_PATH", "/v1.0/copilot/admin/catalog/packages")
MAX_PAGES = 100


def _read(res) -> dict:
    stream = (res or {}).get("contents")
    raw = stream.read() if hasattr(stream, "read") else (stream or b"")
    text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    try:
        return json.loads(text or "{}")
    except ValueError as e:
        raise ApiError("POST", "/api/2.0/external-function", 200, "NOT_JSON", f"Microsoft Graph did not answer JSON ({e})") from e


class Agent365Collector(Collector):
    name = NAME
    label = "Microsoft Agent 365 registrations (Graph)"

    def collect(self) -> None:
        conn = agent365.graph_connection()
        if not conn:
            self.skip_reason = "AGENT365_CONNECTION is not configured (file import still works)"
            return
        records: list[dict] = []
        path, params = GRAPH_PATH, None
        for _ in range(MAX_PAGES):
            body = {"connection_name": conn, "method": "GET", "path": path, "headers": json.dumps({"Accept": "application/json"})}
            if params:
                body["params"] = json.dumps(params)
            page = _read(self.ctx.api("POST", "/api/2.0/external-function", body=body, raw=True,
                                      headers={"Accept": "text/plain", "Content-Type": "application/json"}))
            if page.get("error"):
                err = page["error"]
                raise ApiError("GET", path, None, str(err.get("code") or "GRAPH_ERROR"), str(err.get("message") or err))
            records.extend(page.get("value") or [])
            link = page.get("@odata.nextLink")
            if not link:
                break
            u = urlparse(link)  # an opaque absolute URL: replay its path + query through the connection
            path, params = u.path, dict(parse_qsl(u.query, keep_blank_values=True)) or None
        self.items_seen = len(records)
        with self.transaction() as cur:
            if not agent365.tables_exist(cur):
                self.skip_reason = "migration 007 is not applied"
                return
            counts = agent365.ingest(cur, [{agent365.norm_key(k): v for k, v in r.items()} for r in records if isinstance(r, dict)],
                                     source="graph")
        self.detail.update(counts)
        self.changed(counts["fields_changed"])
