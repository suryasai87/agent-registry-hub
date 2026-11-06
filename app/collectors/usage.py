"""Daily usage rollups, Unity Gateway service policies and violations, and observed ``consumes`` edges.

Sources (all filtered to this workspace), refreshed incrementally per day: each source re-reads from two days
before its latest stored day (late-arriving rows), never earlier than ``days`` ago, and replaces those days.
* ``system.ai_gateway.usage``: MCP rows -> the matching MCP asset by ``service_name`` (with ``tool_name``);
  model rows -> ``agent:endpoint:<endpoint_name>`` only when that asset exists. Requests, errors (status >= 400),
  tokens, p95 latency (``percentile_approx``), requester and requester kind. Source ``ai_gateway_usage``.
  The same table carries the only readable copy of Unity Gateway SERVICE POLICIES (guardrails) and rate limits
  (``model_metadata.config.service_policies`` / ``rate_limits`` and the provider equivalents): they become
  ``ugw:<service or endpoint>:<label>`` policies (provider ``unity_gateway``) bound to the mapped asset, and
  decisions other than ALLOW in ``gateway_feature_results.service_policies[]`` -> ``policy_violation_daily``.
* ``system.serving.endpoint_usage`` joined to ``served_entities`` -> agent endpoints (source ``endpoint_usage``).
* ``system.access.audit`` ``mcpService.mcpCall`` (``connection_name``) -> ``mcp:connection:*`` (source
  ``audit_mcp_call``) and ``managedMcp.mcpRequest`` -> ``mcp:uc:*`` / ``agent:genie:*`` (``audit_managed_mcp``).
Then every requester with usage in the last 30 days gets an observed ``consumes`` edge ``user:<email>`` /
``sp:<application id>`` -> asset, weighted by its 30-day requests.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone

from collectors import upserts as up
from collectors.base import Collector
from collectors.mcp_system import urn_for
from collectors.util import principal_kind, to_date

NAME = "usage"
EDGE_SOURCE = "usage"
GATEWAY, ENDPOINT, MCP_CALL, MANAGED = "ai_gateway_usage", "endpoint_usage", "audit_mcp_call", "audit_managed_mcp"
OVERLAP_DAYS = 2

GATEWAY_SQL = """
SELECT to_date(event_time) AS day, service_type, service_name, endpoint_name,
       coalesce(mcp_metadata.tool_name, '') AS tool_name, requester, requester_type,
       count(*) AS requests, sum(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
       coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens,
       percentile_approx(latency_ms, 0.95) AS p95_latency_ms
  FROM system.ai_gateway.usage
 WHERE workspace_id = ? AND event_time >= ?
 GROUP BY ALL
"""
POLICY_CONFIG_SQL = """
SELECT coalesce(service_name, endpoint_name) AS target, service_type, sp.label AS label, to_json(sp.phases) AS phases,
       sp.type AS type, sp.handler AS handler, sp.rank AS rank, max(event_time) AS last_seen
  FROM system.ai_gateway.usage LATERAL VIEW explode(model_metadata.config.service_policies) t AS sp
 WHERE workspace_id = ? AND event_time >= ?
 GROUP BY ALL
UNION ALL
SELECT coalesce(service_name, endpoint_name) AS target, service_type, sp.label AS label, to_json(sp.phases) AS phases,
       sp.type AS type, sp.handler AS handler, sp.rank AS rank, max(event_time) AS last_seen
  FROM system.ai_gateway.usage LATERAL VIEW explode(model_provider_metadata.config.service_policies) t AS sp
 WHERE workspace_id = ? AND event_time >= ?
 GROUP BY ALL
"""
RATE_LIMIT_SQL = """
SELECT coalesce(service_name, endpoint_name) AS target, service_type, to_json(rl) AS rate_limit, max(event_time) AS last_seen
  FROM system.ai_gateway.usage LATERAL VIEW explode(model_metadata.config.rate_limits) t AS rl
 WHERE workspace_id = ? AND event_time >= ?
 GROUP BY ALL
"""
DECISIONS_SQL = """
SELECT to_date(event_time) AS day, coalesce(service_name, endpoint_name) AS target, service_type,
       d.name AS policy_name, d.phase AS phase, d.decision AS decision, count(*) AS n
  FROM system.ai_gateway.usage LATERAL VIEW explode(model_metadata.gateway_feature_results.service_policies) t AS d
 WHERE workspace_id = ? AND event_time >= ? AND d.decision <> 'ALLOW'
 GROUP BY ALL
UNION ALL
SELECT to_date(event_time) AS day, coalesce(service_name, endpoint_name) AS target, service_type,
       d.name AS policy_name, d.phase AS phase, d.decision AS decision, count(*) AS n
  FROM system.ai_gateway.usage LATERAL VIEW explode(model_provider_metadata.gateway_feature_results.service_policies) t AS d
 WHERE workspace_id = ? AND event_time >= ? AND d.decision <> 'ALLOW'
 GROUP BY ALL
"""
ENDPOINT_SQL = """
SELECT to_date(eu.request_time) AS day, se.endpoint_name, eu.requester,
       count(*) AS requests, sum(CASE WHEN eu.status_code >= 400 THEN 1 ELSE 0 END) AS errors,
       coalesce(sum(eu.input_token_count), 0) AS input_tokens, coalesce(sum(eu.output_token_count), 0) AS output_tokens
  FROM system.serving.endpoint_usage eu
  JOIN (SELECT DISTINCT served_entity_id, endpoint_name FROM system.serving.served_entities WHERE workspace_id = ?) se
    ON eu.served_entity_id = se.served_entity_id
 WHERE eu.workspace_id = ? AND eu.request_time >= ?
 GROUP BY ALL
"""
MCP_CALL_SQL = """
SELECT event_date AS day, request_params['connection_name'] AS connection_name,
       coalesce(request_params['tool_name'], '') AS tool_name, lower(user_identity.email) AS requester,
       count(*) AS requests, sum(CASE WHEN response.status_code >= 400 THEN 1 ELSE 0 END) AS errors
  FROM system.access.audit
 WHERE workspace_id = ? AND event_date >= ? AND service_name = 'mcpService' AND action_name = 'mcpCall'
   AND request_params['connection_name'] IS NOT NULL
 GROUP BY ALL
"""
MANAGED_SQL = """
SELECT event_date AS day, request_params['server_type'] AS server_type, request_params['genie_space_id'] AS genie_space_id,
       request_params['catalog_name'] AS catalog_name, request_params['schema_name'] AS schema_name,
       request_params['index_name'] AS index_name, coalesce(request_params['tool_name'], '') AS tool_name,
       lower(user_identity.email) AS requester,
       count(*) AS requests, sum(CASE WHEN response.status_code >= 400 THEN 1 ELSE 0 END) AS errors
  FROM system.access.audit
 WHERE workspace_id = ? AND event_date >= ? AND service_name = 'managedMcp' AND action_name = 'mcpRequest'
 GROUP BY ALL
"""
REQUESTER_KINDS = {"USER": "user", "SERVICE_PRINCIPAL": "service_principal"}
DECISION_ACTIONS = {"DENY": "deny", "ASK": "ask", "BLOCK": "block", "MASK": "mask", "REDACT": "mask", "FLAG": "flag"}


def phase_of(phases: list[str]) -> str:
    p = {str(x).lower() for x in phases or []}
    inp = bool(p & {"pre_call", "input", "on_call", "request"})
    out = bool(p & {"post_call", "output", "on_result", "response"})
    return "both" if inp and out else "input" if inp else "output" if out else "n/a"


def policy_action(handler: str | None, ptype: str | None) -> str:
    h = (handler or "").lower()
    if "detect_sensitive_data" in h:
        return "mask"
    if h.rsplit(".", 1)[-1].startswith("block_"):
        return "block"
    return "deny"


def requester_kind(requester: str, requester_type: str | None = None) -> str:
    if requester_type and requester_type.upper() in REQUESTER_KINDS:
        return REQUESTER_KINDS[requester_type.upper()]
    kind = principal_kind(requester)
    return kind if kind in ("user", "service_principal") else "unknown"


def _start_of_day(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=timezone.utc)


class UsageCollector(Collector):
    name = NAME
    label = "Usage (AI Gateway, serving endpoints, MCP audit)"

    def collect(self) -> None:
        ctx = self.ctx
        today = ctx.today()
        floor = today - timedelta(days=ctx.days)
        from core import db

        latest = {r["source"]: r["d"] for r in db.query(
            "SELECT source, max(day) AS d FROM usage_daily WHERE source = ANY(%s) GROUP BY source",
            ([GATEWAY, ENDPOINT, MCP_CALL, MANAGED],))}
        start = {s: max(floor, (latest[s] - timedelta(days=OVERLAP_DAYS)) if latest.get(s) else floor)
                 for s in (GATEWAY, ENDPOINT, MCP_CALL, MANAGED)}
        self.detail["start_days"] = {k: v.isoformat() for k, v in start.items()}
        ws = ctx.workspace_id
        data: dict[str, list[dict] | None] = {}
        for source, sql, params in (
            (GATEWAY, GATEWAY_SQL, [ws, _start_of_day(start[GATEWAY])]),
            (ENDPOINT, ENDPOINT_SQL, [ws, ws, _start_of_day(start[ENDPOINT])]),
            (MCP_CALL, MCP_CALL_SQL, [ws, start[MCP_CALL]]),
            (MANAGED, MANAGED_SQL, [ws, start[MANAGED]]),
        ):
            try:
                data[source] = ctx.sql(sql, params)
            except Exception as e:  # noqa: BLE001 - other sources still refresh
                self.warn(f"{source} query", e)
                data[source] = None
        policy_rows = rate_rows = decision_rows = None
        policy_start = _start_of_day(floor)
        try:
            policy_rows = ctx.sql(POLICY_CONFIG_SQL, [ws, policy_start, ws, policy_start])
            rate_rows = ctx.sql(RATE_LIMIT_SQL, [ws, policy_start])
            decision_rows = ctx.sql(DECISIONS_SQL, [ws, _start_of_day(start[GATEWAY]), ws, _start_of_day(start[GATEWAY])])
        except Exception as e:  # noqa: BLE001
            self.warn("service policy queries", e)
        self.items_seen = sum(len(v or []) for v in data.values())

        with self.transaction() as cur:
            cur.execute("SELECT asset_id FROM asset WHERE asset_type IN ('agent', 'mcp_server')")
            assets = {r["asset_id"] for r in cur.fetchall()}
            rows: dict[str, dict[tuple, list]] = {}
            if data[GATEWAY] is not None:
                rows[GATEWAY] = self._gateway(data[GATEWAY], assets)
            if data[ENDPOINT] is not None:
                rows[ENDPOINT] = self._simple(data[ENDPOINT], lambda r: f"agent:endpoint:{r.get('endpoint_name')}", assets)
            if data[MCP_CALL] is not None:
                rows[MCP_CALL] = self._simple(data[MCP_CALL], lambda r: f"mcp:connection:{r.get('connection_name')}", assets)
            if data[MANAGED] is not None:
                rows[MANAGED] = self._simple(data[MANAGED], self._managed_target, assets)
            for source, agg in rows.items():
                agg = {k: v for k, v in agg.items() if k[0] and k[0] >= start[source]}  # only the refreshed days
                cur.execute("DELETE FROM usage_daily WHERE source = %s AND day >= %s", (source, start[source]))
                if agg:
                    cur.executemany(
                        """INSERT INTO usage_daily (day, asset_id, requester, requester_kind, source, requests, errors,
                                                    input_tokens, output_tokens, p95_latency_ms, tool_name)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT (day, asset_id, requester, source, tool_name) DO UPDATE
                              SET requester_kind = EXCLUDED.requester_kind, requests = EXCLUDED.requests,
                                  errors = EXCLUDED.errors, input_tokens = EXCLUDED.input_tokens,
                                  output_tokens = EXCLUDED.output_tokens, p95_latency_ms = EXCLUDED.p95_latency_ms""",
                        [(k[0], k[1], k[2], v[0], source, v[1], v[2], v[3], v[4], v[5], k[3]) for k, v in agg.items()],
                    )
                self.count(f"rows_{source}", len(agg))
            if policy_rows is not None:
                self._policies(cur, policy_rows, rate_rows or [], assets)
            if decision_rows is not None:
                self._violations(cur, decision_rows, assets, start[GATEWAY])
            self._edges(cur)

    # ------------------------------------------------------------------ mapping
    def _gateway_target(self, r: dict, assets: set[str]) -> str | None:
        if r.get("service_type") == "MCP_SERVICE":
            sn = r.get("service_name") or ""
            for candidate in (urn_for(sn), f"mcp:connection:{sn}", f"mcp:uc:{sn}"):
                if candidate in assets:
                    return candidate
            return None
        for name in (r.get("endpoint_name"), r.get("service_name")):
            if name and f"agent:endpoint:{name}" in assets:
                return f"agent:endpoint:{name}"
        return None

    @staticmethod
    def _managed_target(r: dict) -> str | None:
        if r.get("genie_space_id"):
            return f"agent:genie:{r['genie_space_id']}"
        if r.get("catalog_name") and r.get("schema_name") and not r.get("index_name"):
            return f"mcp:uc:{r['catalog_name']}.{r['schema_name']}"
        return None

    def _gateway(self, data: list[dict], assets: set[str]) -> dict[tuple, list]:
        agg: dict[tuple, list] = {}
        for r in data:
            target = self._gateway_target(r, assets)
            if not target:
                self.count("gateway_rows_unmapped")
                continue
            requester = (r.get("requester") or "unknown").strip()
            requester = requester.lower() if "@" in requester else requester
            key = (to_date(r["day"]), target, requester, r.get("tool_name") or "")
            cur = agg.setdefault(key, [requester_kind(requester, r.get("requester_type")), 0, 0, 0, 0, None])
            cur[1] += int(r.get("requests") or 0)
            cur[2] += int(r.get("errors") or 0)
            cur[3] += int(r.get("input_tokens") or 0)
            cur[4] += int(r.get("output_tokens") or 0)
            p95 = r.get("p95_latency_ms")
            if p95 is not None:
                cur[5] = max(int(p95), cur[5] or 0)
        return agg

    def _simple(self, data: list[dict], target_fn, assets: set[str]) -> dict[tuple, list]:
        agg: dict[tuple, list] = {}
        for r in data:
            target = target_fn(r)
            if not target or target not in assets:
                continue
            requester = (r.get("requester") or "unknown").strip()
            requester = requester.lower() if "@" in requester else requester
            key = (to_date(r["day"]), target, requester, r.get("tool_name") or "")
            cur = agg.setdefault(key, [requester_kind(requester), 0, 0, 0, 0, None])
            cur[1] += int(r.get("requests") or 0)
            cur[2] += int(r.get("errors") or 0)
            cur[3] += int(r.get("input_tokens") or 0)
            cur[4] += int(r.get("output_tokens") or 0)
        return agg

    # ------------------------------------------------------------------ policies
    def _policies(self, cur, policy_rows: list[dict], rate_rows: list[dict], assets: set[str]) -> None:
        keep: list[str] = []
        for r in policy_rows:
            target, label = r.get("target"), r.get("label")
            if not target or not label:
                continue
            phases = json.loads(r["phases"]) if isinstance(r.get("phases"), str) else (r.get("phases") or [])
            pid = f"ugw:{target}:{label}"
            keep.append(pid)
            self.changed(up.upsert_policy(cur, {
                "policy_id": pid, "name": label, "kind": "guardrail", "provider": "unity_gateway",
                "phase": phase_of(phases), "action": policy_action(r.get("handler"), r.get("type")),
                "config": {"label": label, "phases": phases, "type": r.get("type"), "handler": r.get("handler"),
                           "rank": r.get("rank"), "target": target, "service_type": r.get("service_type"),
                           "_source": GATEWAY},
                "description": f"Unity Gateway service policy on {target}: {r.get('handler') or r.get('type')}.",
            }))
            self._bind(cur, pid, target, r.get("service_type"), assets)
        for i, r in enumerate(sorted(rate_rows, key=lambda x: (x.get("target") or "", x.get("rate_limit") or ""))):
            target = r.get("target")
            if not target:
                continue
            rl = json.loads(r["rate_limit"]) if isinstance(r.get("rate_limit"), str) else (r.get("rate_limit") or {})
            who = rl.get("principal") or rl.get("principal_type") or "everyone"
            pid = f"ugw:{target}:rate_limit:{who}:{rl.get('interval') or ''}"
            keep.append(pid)
            self.changed(up.upsert_policy(cur, {
                "policy_id": pid, "name": f"Rate limit {rl.get('limit')} {rl.get('unit') or ''}/{rl.get('interval') or ''} ({who})",
                "kind": "rate_limit", "provider": "unity_gateway", "phase": "input", "action": "limit",
                "config": {**rl, "target": target, "_source": GATEWAY},
                "description": f"Unity Gateway rate limit on {target}.",
            }))
            self._bind(cur, pid, target, r.get("service_type"), assets)
        cur.execute(
            """DELETE FROM policy WHERE origin = 'sync' AND provider = 'unity_gateway' AND config ->> '_source' = %s
                                    AND NOT (policy_id = ANY(%s))""",
            (GATEWAY, keep),
        )
        self.changed(cur.rowcount)
        self.count("gateway_policies", len(keep))

    def _bind(self, cur, pid: str, target: str, service_type: str | None, assets: set[str]) -> None:
        asset = self._gateway_target({"service_type": service_type, "service_name": target, "endpoint_name": target}, assets)
        if asset:
            self.changed(up.bind_policy(cur, pid, asset))

    def _violations(self, cur, rows: list[dict], assets: set[str], start: date) -> None:
        cur.execute("DELETE FROM policy_violation_daily WHERE source = %s AND day >= %s", (GATEWAY, start))
        agg: dict[tuple, int] = {}
        for r in rows:
            asset = self._gateway_target({"service_type": r.get("service_type"), "service_name": r.get("target"),
                                          "endpoint_name": r.get("target")}, assets)
            if not asset or not r.get("policy_name"):
                continue
            key = (to_date(r["day"]), asset, f"ugw:{r['target']}:{r['policy_name']}",
                   DECISION_ACTIONS.get(str(r.get("decision") or "").upper(), str(r.get("decision") or "flag").lower()))
            agg[key] = agg.get(key, 0) + int(r.get("n") or 0)
        agg = {k: v for k, v in agg.items() if k[0] and k[0] >= start}
        if agg:
            cur.executemany(
                """INSERT INTO policy_violation_daily (day, asset_id, policy_id, action, count, source)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (day, asset_id, policy_id, action) DO UPDATE SET count = EXCLUDED.count, source = EXCLUDED.source""",
                [(*k, v, GATEWAY) for k, v in agg.items()],
            )
        self.count("violation_rows", len(agg))

    # ------------------------------------------------------------------ consumes edges
    def _edges(self, cur) -> None:
        cur.execute(
            """SELECT requester, max(requester_kind) AS kind, asset_id, sum(requests)::bigint AS n
                 FROM usage_daily
                WHERE source = ANY(%s) AND day >= %s AND requester <> 'unknown'
                GROUP BY requester, asset_id""",
            ([GATEWAY, ENDPOINT, MCP_CALL, MANAGED], self.ctx.today() - timedelta(days=30)),
        )
        n = 0
        for r in cur.fetchall():
            node = f"user:{r['requester']}" if "@" in r["requester"] else f"sp:{r['requester']}"
            self.changed(up.edge(cur, node, r["asset_id"], "consumes", "observed", EDGE_SOURCE, weight_30d=int(r["n"]),
                                 attributes={"requester_kind": r["kind"]}))
            n += 1
        self.count("consumes_edges", n)
        self.changed(up.prune_edges(cur, source=EDGE_SOURCE, seen_at=self.seen_at, edge_kind="observed"))
