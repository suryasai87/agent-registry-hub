"""Traces and evaluation results for agents with a linked MLflow experiment (``asset_experiment``).

* Traces: ``POST /api/3.0/mlflow/traces/search`` per experiment (most recent first, up to 5 pages of 100 while
  inside the window) -> ``trace_recent`` (metadata only: duration, state, tokens from
  ``trace_metadata["mlflow.trace.tokenUsage"]``, ``tags["mlflow.user"]``, trace name and compacted feedback
  assessments) -> ``trace_daily`` (traces, errors, p50/p95). Request/response text, previews and trace
  inputs/outputs are never read into the registry.
* Monitoring evals: feedback assessments aggregated per assessment name per day -> ``eval_result`` kind
  ``monitoring`` (mean of numeric/boolean values; pass rate for yes/no/match-like labels).
* Offline evals: ``system.mlflow.run_metrics_history`` joined to ``runs_latest`` (scorer aggregates such as
  ``correctness/mean``) -> ``eval_result`` kind ``offline``.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, time, timedelta, timezone

from collectors.base import ApiError, Collector
from collectors.util import duration_ms, iso_to_dt
from core import db
from psycopg.types.json import Jsonb

NAME = "traces_evals"
TRACE_SOURCE, MONITOR_SOURCE, OFFLINE_SOURCE = "mlflow_traces", "trace_assessments", "mlflow_runs"
PAGE_SIZE, MAX_PAGES = 100, 5
LINK_PRIORITY = ("endpoint_tag", "supervisor_agent", "knowledge_assistant", "tile", "app_resource", "manual")
PASS = {"yes", "pass", "passed", "match", "true", "correct", "good", "ok", "safe", "relevant", "grounded"}
FAIL = {"no", "fail", "failed", "mismatch", "no_match", "false", "incorrect", "bad", "unsafe", "irrelevant", "ungrounded"}
MAX_LABEL = 64
EXPERIMENT_ID = re.compile(r"^\d{1,30}$")

OFFLINE_SQL = """
SELECT m.experiment_id, m.run_id, m.metric_name, max_by(m.metric_value, m.metric_time) AS value,
       any_value(r.run_name) AS run_name, any_value(coalesce(r.end_time, r.start_time)) AS run_at
  FROM system.mlflow.run_metrics_history m
  JOIN system.mlflow.runs_latest r ON r.run_id = m.run_id AND r.workspace_id = m.workspace_id
 WHERE m.workspace_id = ? AND r.delete_time IS NULL AND r.start_time >= ?
   AND (m.metric_name LIKE '%/mean' OR m.metric_name LIKE '%/pass_rate' OR m.metric_name LIKE '%/percentage')
   AND m.experiment_id IN ({ids})
 GROUP BY m.experiment_id, m.run_id, m.metric_name
"""


def compact_assessments(items: list[dict] | None) -> list[dict]:
    """Feedback assessments -> [{name, value, source_type}]; values are scalars only (no free text)."""
    out = []
    for a in items or []:
        if "feedback" not in a or a.get("valid") is False:
            continue
        value = (a.get("feedback") or {}).get("value")
        if isinstance(value, str):
            value = value.strip()
            if len(value) > MAX_LABEL or "\n" in value:
                value = None
        elif not isinstance(value, (bool, int, float)) or value is None:
            value = None
        out.append({"name": a.get("assessment_name"), "value": value,
                    "source_type": (a.get("source") or {}).get("source_type")})
    return [x for x in out if x["name"]]


def parse_trace(t: dict, asset_id: str, experiment_id: str) -> dict | None:
    trace_id = t.get("trace_id")
    request_time = iso_to_dt(t.get("request_time"))
    if not trace_id or request_time is None:
        return None
    meta = t.get("trace_metadata") or {}
    tags = t.get("tags") or {}
    tokens = {}
    raw = meta.get("mlflow.trace.tokenUsage")
    if raw:
        try:
            tokens = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except (ValueError, TypeError):
            tokens = {}
    return {
        "trace_id": trace_id, "asset_id": asset_id, "experiment_id": experiment_id, "request_time": request_time,
        "duration_ms": duration_ms(t.get("execution_duration")), "state": t.get("state"),
        "input_tokens": _int(tokens.get("input_tokens")), "output_tokens": _int(tokens.get("output_tokens")),
        "user_ref": tags.get("mlflow.user"), "trace_name": tags.get("mlflow.traceName"),
        "assessments": compact_assessments(t.get("assessments")),
    }


def _int(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def score(value) -> tuple[float | None, bool | None]:
    """(numeric score, pass flag) for one assessment value."""
    if isinstance(value, bool):
        return float(value), value
    if isinstance(value, (int, float)):
        return float(value), None
    if isinstance(value, str):
        v = value.lower()
        if v in PASS:
            return 1.0, True
        if v in FAIL:
            return 0.0, False
        try:
            return float(v), None
        except ValueError:
            return None, None
    return None, None


def monitoring_rows(traces: list[dict]) -> list[tuple]:
    groups: dict[tuple, dict] = {}
    for t in traces:
        day = t["request_time"].date()
        for a in t.get("assessments") or []:
            num, passed = score(a.get("value"))
            if num is None and passed is None:
                continue
            g = groups.setdefault((t["asset_id"], day, a["name"]), {"nums": [], "passes": 0, "judged": 0})
            if num is not None:
                g["nums"].append(num)
            if passed is not None:
                g["judged"] += 1
                g["passes"] += int(passed)
    rows = []
    for (asset_id, day, name), g in sorted(groups.items()):
        mean = sum(g["nums"]) / len(g["nums"]) if g["nums"] else None
        pass_rate = g["passes"] / g["judged"] if g["judged"] else None
        rows.append((asset_id, f"monitoring:{day.isoformat()}", name, "monitoring", mean, pass_rate,
                     max(len(g["nums"]), g["judged"]), datetime.combine(day, time.min, tzinfo=timezone.utc), MONITOR_SOURCE))
    return rows


class TracesEvalsCollector(Collector):
    name = NAME
    label = "MLflow traces and evaluations"

    def collect(self) -> None:
        ctx = self.ctx
        links = db.query("SELECT asset_id, experiment_id, link_source FROM asset_experiment")
        primary: dict[str, str] = {}
        by_exp: dict[str, list[tuple[str, str]]] = {}
        for r in links:
            if EXPERIMENT_ID.match(r["experiment_id"] or ""):
                by_exp.setdefault(r["experiment_id"], []).append((r["asset_id"], r["link_source"]))
        for exp, assets in by_exp.items():
            assets.sort(key=lambda a: LINK_PRIORITY.index(a[1]) if a[1] in LINK_PRIORITY else len(LINK_PRIORITY))
            primary[exp] = assets[0][0]
        self.items_seen = len(by_exp)
        cutoff = ctx.now() - timedelta(days=ctx.days)

        def search(exp: str) -> list[dict]:
            body = {"locations": [{"type": "MLFLOW_EXPERIMENT", "mlflow_experiment": {"experiment_id": exp}}],
                    "max_results": PAGE_SIZE, "order_by": ["timestamp_ms DESC"]}
            out: list[dict] = []
            for _ in range(MAX_PAGES):
                res = ctx.api("POST", "/api/3.0/mlflow/traces/search", body=body) or {}
                page = res.get("traces") or []
                out.extend(page)
                oldest = min((iso_to_dt(t.get("request_time")) for t in page if t.get("request_time")), default=None)
                if not res.get("next_page_token") or (oldest and oldest < cutoff):
                    break
                body["page_token"] = res["next_page_token"]
            return out

        traces: list[dict] = []
        unreadable = 0
        for exp, res, err in ctx.pmap(search, sorted(by_exp)):
            if err:
                if isinstance(err, ApiError) and err.status in (403, 404):
                    unreadable += 1
                else:
                    self.warn(f"traces {exp}", err)
                continue
            for t in res:
                endpoint = (t.get("trace_metadata") or {}).get("mlflow.databricks.modelServingEndpointName")
                linked = {a for a, _ in by_exp[exp]}
                asset = f"agent:endpoint:{endpoint}" if endpoint and f"agent:endpoint:{endpoint}" in linked else primary[exp]
                row = parse_trace(t, asset, exp)
                if row and row["request_time"] >= cutoff:
                    traces.append(row)
        self.detail.update(experiments=len(by_exp), experiments_not_readable=unreadable, traces=len(traces))

        offline: list[dict] | None = []
        exps = sorted(by_exp)
        try:
            for i in range(0, len(exps), 200):
                chunk = exps[i:i + 200]
                offline += ctx.sql(OFFLINE_SQL.format(ids=", ".join("?" * len(chunk))),
                                   [ctx.workspace_id, cutoff - timedelta(days=60), *chunk])
        except Exception as e:  # noqa: BLE001 - traces still sync
            self.warn("offline eval query", e)
            offline = None

        assets = sorted({a for v in by_exp.values() for a, _ in v})
        with self.transaction() as cur:
            if traces:
                cur.executemany(
                    """INSERT INTO trace_recent (trace_id, asset_id, experiment_id, request_time, duration_ms, state,
                                                 input_tokens, output_tokens, user_ref, trace_name, assessments, synced_at)
                       VALUES (%(trace_id)s, %(asset_id)s, %(experiment_id)s, %(request_time)s, %(duration_ms)s, %(state)s,
                               %(input_tokens)s, %(output_tokens)s, %(user_ref)s, %(trace_name)s, %(assessments)s, now())
                       ON CONFLICT (trace_id) DO UPDATE SET asset_id = EXCLUDED.asset_id, state = EXCLUDED.state,
                           duration_ms = EXCLUDED.duration_ms, input_tokens = EXCLUDED.input_tokens,
                           output_tokens = EXCLUDED.output_tokens, assessments = EXCLUDED.assessments, synced_at = now()""",
                    [{**t, "assessments": Jsonb(t["assessments"])} for t in traces],
                )
            cur.execute("DELETE FROM trace_recent WHERE request_time < %s OR NOT (experiment_id = ANY(%s))",
                        (cutoff, exps))
            self.count("traces_pruned", cur.rowcount)
            # Days inside the window are recomputed from trace_recent; older days keep their history.
            first_day = cutoff.date() + timedelta(days=1)
            cur.execute("DELETE FROM trace_daily WHERE source = %s AND day >= %s", (TRACE_SOURCE, first_day))
            cur.execute(
                """INSERT INTO trace_daily (day, asset_id, traces, errors, p50_ms, p95_ms, source)
                   SELECT (request_time AT TIME ZONE 'UTC')::date, asset_id, count(*),
                          count(*) FILTER (WHERE state = 'ERROR'),
                          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int,
                          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int, %s
                     FROM trace_recent WHERE (request_time AT TIME ZONE 'UTC')::date >= %s GROUP BY 1, 2""",
                (TRACE_SOURCE, first_day),
            )
            self.count("trace_daily_rows", cur.rowcount)
            cur.execute("SELECT asset_id, request_time, assessments FROM trace_recent WHERE (request_time AT TIME ZONE 'UTC')::date >= %s",
                        (first_day,))
            mon = monitoring_rows(cur.fetchall())
            cur.execute("DELETE FROM eval_result WHERE source = %s AND run_at >= %s",
                        (MONITOR_SOURCE, datetime.combine(first_day, time.min, tzinfo=timezone.utc)))
            if mon:
                cur.executemany(
                    """INSERT INTO eval_result (asset_id, run_id, scorer, kind, mean_value, pass_rate, n, run_at, source)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""", mon)
            self.count("monitoring_eval_rows", len(mon))
            if offline is not None:
                rows = self._offline_rows(offline, primary)
                cur.execute("DELETE FROM eval_result WHERE source = %s AND asset_id = ANY(%s)", (OFFLINE_SOURCE, assets))
                if rows:
                    cur.executemany(
                        """INSERT INTO eval_result (asset_id, run_id, scorer, version, kind, mean_value, pass_rate, run_at, source)
                           VALUES (%s, %s, %s, %s, 'offline', %s, %s, %s, %s)""", rows)
                self.count("offline_eval_rows", len(rows))

    @staticmethod
    def _offline_rows(rows: list[dict], primary: dict[str, str]) -> list[tuple]:
        merged: dict[tuple, dict] = {}
        for r in rows:
            asset = primary.get(str(r.get("experiment_id")))
            name = str(r.get("metric_name") or "")
            if not asset or "/" not in name or r.get("value") is None:
                continue
            scorer, stat = name.rsplit("/", 1)
            m = merged.setdefault((asset, r["run_id"], scorer), {"run_name": r.get("run_name"), "run_at": r.get("run_at")})
            value = float(r["value"])
            if stat == "mean":
                m["mean"] = value
            else:
                m["pass_rate"] = value / 100 if value > 1 else value
        out = []
        for (asset, run_id, scorer), m in sorted(merged.items()):
            run_at = iso_to_dt(m["run_at"])
            if run_at is None:
                continue
            out.append((asset, run_id, scorer, None, m.get("mean", m.get("pass_rate")), m.get("pass_rate"),
                        run_at, OFFLINE_SOURCE))
        return out
