"""Traces & evals for Databricks-built agents (owner experience), from the collector's cached rows.

Payloads (request/response) are never stored. Consumers see only their own traces, matched on the MLflow
user tag. Owners, stewards and auditors see all traces.
"""
from __future__ import annotations

from datetime import date, timedelta

from core.lakebase import workspace_client


def _deep_link(experiment_id: str | None) -> str | None:
    if not experiment_id:
        return None
    try:
        host = workspace_client().config.host.rstrip("/")
    except Exception:  # noqa: BLE001
        return None
    return f"{host}/ml/experiments/{experiment_id}/traces"


def _experiment(cur, asset_id: str) -> str | None:
    cur.execute("SELECT experiment_id FROM asset_experiment WHERE asset_id = %s ORDER BY link_source LIMIT 1", (asset_id,))
    r = cur.fetchone()
    return r["experiment_id"] if r else None


def _has_table(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AS ok", (name,))
    return bool(cur.fetchone()["ok"])


def traces(cur, asset_id: str, limit: int, *, viewer: str, see_all: bool) -> dict:
    exp = _experiment(cur, asset_id)
    rows = []
    if _has_table(cur, "trace_recent"):
        where = "" if see_all else "AND lower(coalesce(user_ref,'')) = %(me)s"
        cur.execute(f"""SELECT * FROM trace_recent WHERE asset_id = %(a)s {where} ORDER BY request_time DESC LIMIT %(n)s""",
                    {"a": asset_id, "me": viewer, "n": max(1, min(limit, 200))})
        rows = list(cur.fetchall())
    cur.execute("SELECT day, sum(traces)::bigint AS traces, sum(errors)::bigint AS errors, max(p95_ms) AS p95 FROM trace_daily "
                "WHERE asset_id = %s AND day >= %s GROUP BY day ORDER BY day", (asset_id, date.today() - timedelta(days=30)))
    daily = [{"day": r["day"].isoformat(), "traces": int(r["traces"]), "errors": int(r["errors"]), "p95_ms": r["p95"]}
             for r in cur.fetchall()] if see_all else []
    note = None
    if not exp:
        note = ("No MLflow experiment is linked to this asset. Databricks-built agents link one through the endpoint tag "
                "MONITOR_EXPERIMENT_ID or the Agent Bricks experiment, and traces appear after the next sync.")
    elif not rows:
        note = "No traces cached yet for this experiment." if see_all else "You have no traces on this agent yet (consumers see only their own)."
    out = []
    for r in rows:
        out.append({
            "trace_id": r["trace_id"], "request_time": r["request_time"].isoformat() if r.get("request_time") else None,
            "duration_ms": r.get("duration_ms"), "state": r.get("state"),
            "input_tokens": r.get("input_tokens"), "output_tokens": r.get("output_tokens"),
            "user": r.get("user_ref") if see_all else viewer, "trace_name": r.get("trace_name"),
            "assessments": r.get("assessments") or [],
        })
    return {"experiment_id": exp, "deep_link": _deep_link(exp), "traces": out, "daily": daily, "note": note}


def evals(cur, asset_id: str) -> dict:
    exp = _experiment(cur, asset_id)
    cur.execute("SELECT * FROM eval_result WHERE asset_id = %s ORDER BY run_at", (asset_id,))
    rows = list(cur.fetchall())
    scorers: dict[tuple[str, str], dict] = {}
    runs: dict[str, dict] = {}
    for r in rows:
        key = (r["scorer"], r["kind"])
        s = scorers.setdefault(key, {"name": r["scorer"], "kind": r["kind"], "trend": [], "n": 0, "_vals": [], "_pass": []})
        if r["mean_value"] is not None:
            s["trend"].append({"day": r["run_at"].date().isoformat(), "value": round(float(r["mean_value"]), 4)})
            s["_vals"].append(float(r["mean_value"]))
        if r["pass_rate"] is not None:
            s["_pass"].append(float(r["pass_rate"]))
        s["n"] += int(r["n"] or 0)
        if r["kind"] == "offline":
            run = runs.setdefault(r["run_id"], {"run_id": r["run_id"], "version": r["version"], "run_at": r["run_at"].isoformat(), "scorers": {}})
            if r["mean_value"] is not None:
                run["scorers"][r["scorer"]] = round(float(r["mean_value"]), 4)
    out = []
    for s in scorers.values():
        vals, passes = s.pop("_vals"), s.pop("_pass")
        recent = vals[-7:]
        s["mean"] = round(sum(recent) / len(recent), 4) if recent else None
        s["pass_rate"] = round(sum(passes[-7:]) / len(passes[-7:]), 4) if passes else None
        s["trend"] = s["trend"][-30:]
        out.append(s)
    note = None if out else ("No evaluation results yet. Run mlflow.genai.evaluate() or enable production monitoring "
                             "scorers on the agent's experiment; results appear after the next sync.")
    return {"experiment_id": exp, "scorers": sorted(out, key=lambda s: (s["kind"], s["name"])),
            "runs": sorted(runs.values(), key=lambda r: r["run_at"], reverse=True)[:20], "deep_link": _deep_link(exp), "note": note}


def fleet(cur) -> dict:
    since = date.today() - timedelta(days=30)
    cur.execute("""
        SELECT a.asset_id, a.display_name,
               (SELECT experiment_id FROM asset_experiment e WHERE e.asset_id = a.asset_id LIMIT 1) AS experiment_id,
               coalesce(sum(t.traces),0)::bigint AS traces, coalesce(sum(t.errors),0)::bigint AS errors, max(t.p95_ms) AS p95
          FROM asset a LEFT JOIN trace_daily t ON t.asset_id = a.asset_id AND t.day >= %s
         WHERE a.asset_type = 'agent' AND (EXISTS (SELECT 1 FROM asset_experiment e WHERE e.asset_id = a.asset_id)
                                           OR EXISTS (SELECT 1 FROM eval_result r WHERE r.asset_id = a.asset_id))
         GROUP BY a.asset_id, a.display_name ORDER BY 4 DESC, 2 LIMIT 300""", (since,))
    agents = list(cur.fetchall())
    ids = [a["asset_id"] for a in agents]
    cur.execute("""SELECT asset_id, scorer, avg(mean_value) FILTER (WHERE run_at >= now() - interval '7 days')::float AS recent,
                          avg(mean_value) FILTER (WHERE run_at < now() - interval '7 days' AND run_at >= now() - interval '30 days')::float AS prior
                     FROM eval_result WHERE asset_id = ANY(%s) AND mean_value IS NOT NULL GROUP BY asset_id, scorer""", (ids,))
    means: dict[str, dict] = {}
    regress: set[str] = set()
    for r in cur.fetchall():
        v = r["recent"] if r["recent"] is not None else r["prior"]
        if v is not None:
            means.setdefault(r["asset_id"], {})[r["scorer"]] = round(v, 4)
        if r["recent"] is not None and r["prior"] is not None and r["recent"] < r["prior"] - 0.05:
            regress.add(r["asset_id"])
    return {"agents": [{
        "asset_id": a["asset_id"], "display_name": a["display_name"], "traces_30d": int(a["traces"]),
        "error_rate": round(int(a["errors"]) / int(a["traces"]), 4) if a["traces"] else None, "p95_ms": a["p95"],
        "scorer_means": means.get(a["asset_id"], {}), "regression": a["asset_id"] in regress, "experiment_id": a["experiment_id"],
    } for a in agents]}
