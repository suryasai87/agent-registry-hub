"""Audit trail reads: role-scoped listing, chain verification and evidence export."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timedelta, timezone

from registry import authz


def _scope(cur, p: authz.Principal, entity_type: str | None, entity_id: str | None) -> tuple[str, list]:
    if p.can_read_everything:
        return "", []
    if entity_type == "asset" and entity_id and p.email in authz.owner_emails(cur, entity_id):
        return "", []
    return " AND actor = %s", [p.email]


def list_rows(cur, p: authz.Principal, *, entity_type=None, entity_id=None, actor=None, action=None, days=30,
              page=1, page_size=50) -> dict:
    clauses, params = ["at >= %s"], [datetime.now(timezone.utc) - timedelta(days=max(1, min(int(days or 30), 3650)))]
    for col, val in (("entity_type", entity_type), ("entity_id", entity_id), ("actor", actor)):
        if val:
            clauses.append(f"{col} = %s"); params.append(val)
    if action:
        clauses.append("action ILIKE %s"); params.append(f"{action}%")
    extra, extra_params = _scope(cur, p, entity_type, entity_id)
    where = " AND ".join(clauses) + extra
    params += extra_params
    page, page_size = max(1, int(page or 1)), max(1, min(int(page_size or 50), 500))
    cur.execute(f"SELECT count(*) AS n FROM audit_log WHERE {where}", params)
    total = int(cur.fetchone()["n"])
    cur.execute(f"""SELECT audit_id, at, actor, action, entity_type, entity_id, before, after, reason, source, row_hash
                      FROM audit_log WHERE {where} ORDER BY audit_id DESC LIMIT %s OFFSET %s""",
                [*params, page_size, (page - 1) * page_size])
    return {"rows": list(cur.fetchall()), "total": total, "page": page, "page_size": page_size}


def verify(cur) -> dict:
    cur.execute("SELECT count(*) AS n FROM audit_log")
    checked = int(cur.fetchone()["n"])
    cur.execute("SELECT * FROM verify_audit_chain()")
    problems = list(cur.fetchall())
    return {"intact": not problems, "checked": checked, "problems": problems[:100]}


def export(cur, p: authz.Principal, fmt: str, **filters) -> tuple[str, str, str]:
    data = list_rows(cur, p, page=1, page_size=500, **filters)["rows"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if fmt == "json":
        return json.dumps(data, default=str, indent=2), "application/json", f"registry-audit-{stamp}.json"
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["audit_id", "at", "actor", "action", "entity_type", "entity_id", "reason", "source", "before", "after", "row_hash"]
    w.writerow(cols)
    for r in data:
        w.writerow([json.dumps(r[c], default=str) if c in ("before", "after") else r[c] for c in cols])
    return buf.getvalue(), "text/csv", f"registry-audit-{stamp}.csv"
