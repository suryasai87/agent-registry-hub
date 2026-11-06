"""Changes & impact: the change feed, impact reports, owner publish (with preview) and acknowledgements."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Conflict, NotFound
from registry import authz, coverage, fields, impact, metrics, notify

CHANGE_KINDS = ("description", "tools_added", "tools_removed", "schema", "model", "prompt", "policy", "owner",
                "deprecation", "sensitivity", "runtime", "endpoint", "other")
ACK_STATUSES = ("not_impacted", "impacted_will_migrate", "need_help")
BREAKING_NOTICE_DAYS = 14


def _summary_row(cur, rows: list[dict], viewer: str | None) -> list[dict]:
    if not rows:
        return []
    ids = [r["change_id"] for r in rows]
    cur.execute(
        """SELECT change_id, count(*) FILTER (WHERE email IS NOT NULL) AS people,
                  count(*) FILTER (WHERE email IS NOT NULL AND ack_status IN ('not_impacted','impacted_will_migrate','need_help')) AS acked,
                  max(ack_status) FILTER (WHERE email = %s AND ack_status <> 'not_required') AS my_ack
             FROM impact_item WHERE change_id = ANY(%s) GROUP BY change_id""",
        (viewer or "", ids),
    )
    agg = {r["change_id"]: r for r in cur.fetchall()}
    out = []
    for r in rows:
        a = agg.get(r["change_id"], {})
        out.append({
            "change_id": r["change_id"], "asset_id": r["asset_id"], "asset_display_name": r["display_name"],
            "asset_type": r["asset_type"], "from_version": r["from_version"], "to_version": r["to_version"],
            "change_kinds": list(r["change_kinds"] or []), "breaking": r["breaking"], "title": r["title"],
            "summary": r["summary"], "status": r["status"], "detected_by": r["detected_by"],
            "published_by": r["published_by"], "published_at": r["published_at"], "effective_at": r["effective_at"],
            "created_at": r["created_at"], "impacted_people": int(a.get("people") or 0), "acked": int(a.get("acked") or 0),
            "my_ack": a.get("my_ack"),
        })
    return out


def feed(cur, *, viewer: str, asset_id: str | None = None, breaking: bool | None = None, mine: bool = False,
         days: int = 90, limit: int = 200) -> list[dict]:
    clauses, params = ["c.created_at >= %s"], [datetime.now(timezone.utc) - timedelta(days=days)]
    if asset_id:
        clauses.append("c.asset_id = %s"); params.append(asset_id)
    if breaking is not None:
        clauses.append("c.breaking = %s"); params.append(breaking)
    if mine:
        clauses.append("EXISTS (SELECT 1 FROM impact_item i WHERE i.change_id = c.change_id AND i.email = %s)"); params.append(viewer)
    cur.execute(
        f"""SELECT c.*, a.display_name, a.asset_type FROM change_event c JOIN asset a ON a.asset_id = c.asset_id
             WHERE {' AND '.join(clauses)} ORDER BY c.created_at DESC LIMIT %s""",
        [*params, limit],
    )
    return _summary_row(cur, list(cur.fetchall()), viewer)


def detail(cur, change_id: int, *, viewer: str) -> dict:
    cur.execute("SELECT c.*, a.display_name, a.asset_type FROM change_event c JOIN asset a ON a.asset_id = c.asset_id WHERE c.change_id = %s",
                (change_id,))
    r = cur.fetchone()
    if not r:
        raise NotFound(f"change {change_id} not found")
    summary = _summary_row(cur, [r], viewer)[0]
    cur.execute("SELECT * FROM impact_item WHERE change_id = %s ORDER BY impact_type, hops, impacted_key", (change_id,))
    items = list(cur.fetchall())
    labels_needed = [i["impacted_key"] for i in items if i["impact_type"] == "downstream_asset"] + \
                    [i["via_asset_id"] for i in items if i["via_asset_id"]]
    cur.execute("SELECT asset_id, display_name FROM asset WHERE asset_id = ANY(%s)", (labels_needed,))
    labels = {x["asset_id"]: x["display_name"] for x in cur.fetchall()}
    impact_rows = []
    counts = {k: 0 for k in ("pending", "not_impacted", "impacted_will_migrate", "need_help", "not_required")}
    for i in items:
        if i["impact_type"] == "downstream_asset":
            label = labels.get(i["impacted_key"], i["impacted_key"])
        elif i["via_asset_id"]:
            label = f"{i['impacted_key']} (via {labels.get(i['via_asset_id'], i['via_asset_id'])})"
        else:
            label = i["impacted_key"]
        if i["email"]:
            counts[i["ack_status"]] = counts.get(i["ack_status"], 0) + 1
        impact_rows.append({**{k: i[k] for k in ("impacted_key", "impact_type", "via_asset_id", "hops", "email", "ack_status",
                                                  "ack_note", "migrate_by", "acked_at", "notified_at")}, "label": label})
    return {
        "change": {**summary, "diff": r["diff"] or [], "release_notes": r["release_notes"], "sunset_at": r["sunset_at"]},
        "impact": impact_rows, "ack_summary": counts,
        "metrics_before": r["metrics_before"], "metrics_after": r["metrics_after"],
    }


def acknowledge(cur, change_id: int, status: str, *, p: authz.Principal, note: str | None = None,
                migrate_by: str | None = None) -> list[dict]:
    if status not in ACK_STATUSES:
        raise ValueError(f"status must be one of {', '.join(ACK_STATUSES)}")
    if status == "impacted_will_migrate" and not migrate_by:
        raise ValueError("Please give the date you'll have migrated by")
    cur.execute(
        """UPDATE impact_item SET ack_status = %s, ack_note = %s, migrate_by = %s, acked_at = now()
            WHERE change_id = %s AND email = %s RETURNING *""",
        (status, (note or "").strip()[:1000] or None, migrate_by or None, change_id, p.email),
    )
    rows = list(cur.fetchall())
    if not rows:
        raise NotFound("You are not listed as impacted by this change")
    cur.execute("UPDATE subscription SET last_ack_at = now() WHERE subscriber_email = %s AND asset_id = (SELECT asset_id FROM change_event WHERE change_id = %s)",
                (p.email, change_id))
    cur.execute("SELECT c.asset_id, c.title, c.published_by FROM change_event c WHERE c.change_id = %s", (change_id,))
    c = cur.fetchone()
    audit.audit_event(p.email, "change.ack", "change", change_id, after={"status": status, "note": note, "migrate_by": migrate_by},
                      request_id=p.request_id, cur=cur)
    if status == "need_help" and c and c["published_by"] and "@" in c["published_by"]:
        notify.queue(cur, c["published_by"], "impact_help", f"{p.email} needs help with: {c['title']}", note, c["asset_id"], change_id)
    return rows


def _checks(cur, asset: dict, body: dict) -> list[dict]:
    flds = fields.list_fields(cur, asset["asset_id"])
    complete = fields.completeness(flds)
    cov = coverage.for_assets(cur, [asset]).get(asset["asset_id"], {"pct": 100, "required": []})
    missing = [c["label"] for c in cov["required"] if not c["met"]]
    cur.execute("SELECT count(*) AS n FROM asset WHERE parent_asset_id = %s AND lifecycle_status = 'discovered'", (asset["asset_id"],))
    unreviewed = int(cur.fetchone()["n"])
    effective = body.get("effective_at")
    notice_ok = True
    if body.get("breaking"):
        if not effective:
            notice_ok = False
        else:
            eff = datetime.fromisoformat(str(effective).replace("Z", "+00:00"))
            if eff.tzinfo is None:
                eff = eff.replace(tzinfo=timezone.utc)
            # calendar dates, so a date picked in any time zone isn't off by a few hours
            notice_ok = eff.date() >= (datetime.now(timezone.utc) + timedelta(days=BREAKING_NOTICE_DAYS)).date()
    return [
        {"name": "Description completeness ≥ 60%", "passed": complete >= 60, "detail": f"{complete}% complete"},
        {"name": "Required controls for the risk tier", "passed": not missing,
         "detail": "all present" if not missing else "missing: " + ", ".join(missing)},
        {"name": "No unreviewed tools", "passed": unreviewed == 0, "detail": f"{unreviewed} discovered tool(s) awaiting review"},
        {"name": f"Breaking changes give ≥ {BREAKING_NOTICE_DAYS} days notice", "passed": notice_ok,
         "detail": "not breaking" if not body.get("breaking") else ("effective date OK" if notice_ok else "set an effective date at least 14 days out")},
        {"name": "Release notes for breaking changes", "passed": (not body.get("breaking")) or bool((body.get("release_notes") or "").strip()),
         "detail": "provided" if (body.get("release_notes") or "").strip() else "required when breaking"},
    ]


def _validate(body: dict) -> dict:
    kinds = [k for k in (body.get("change_kinds") or []) if k in CHANGE_KINDS]
    if not kinds:
        raise ValueError("Pick at least one change kind")
    title = (body.get("title") or "").strip()
    if len(title) < 5:
        raise ValueError("A short title is required")
    return {**body, "change_kinds": kinds, "title": title[:200], "breaking": bool(body.get("breaking"))}


def preview(cur, asset: dict, body: dict, *, extra_start: Iterable[str] = ()) -> dict:
    body = _validate(body)
    groups = impact.preview(cur, asset["asset_id"], body["breaking"], extra_start)
    tag = "[Breaking] " if body["breaking"] else ""
    eff = body.get("effective_at") or "on publish"
    subject = f"{tag}{asset['display_name']} {body.get('to_version') or ''}: {body['title']}".replace("  ", " ")
    body_text = "\n".join(filter(None, [
        f"What changed: {', '.join(body['change_kinds'])}",
        body.get("summary"), f"Effective: {eff}", body.get("release_notes"),
        "Please acknowledge in Agent Registry Hub: not impacted · impacted, will migrate by <date> · need help.",
    ]))
    def strip(items):
        blank = {"ack_note": None, "migrate_by": None, "acked_at": None, "notified_at": None}
        return [{**blank, **{k: v for k, v in i.items() if k not in ("notify", "notify_emails", "downstream")}} for i in items]
    return {"subscribers": strip(groups["subscribers"]), "downstream": strip(groups["downstream"]),
            "observed": strip(groups["observed"]), "total_people": groups["total_people"],
            "email_preview": {"subject": subject, "body": body_text}, "checks": _checks(cur, asset, body)}


def publish(cur, asset: dict, body: dict, *, p: authz.Principal, perms: dict, detected_by: str = "owner",
            enforce_notice: bool = True, extra_start: Iterable[str] = ()) -> dict:
    """``enforce_notice=False`` for emergency status changes (pause/deprecate) and platform changes applied at once
    (MCP tool selection): they take effect now and are still announced to every impacted party. ``extra_start``
    widens the impact (``registry/impact``)."""
    authz.require(perms["can_publish"], "Only the asset's owners (or a steward) can publish a change")
    body = _validate(body)
    checks = _checks(cur, asset, body)
    blocking = [c for c in checks if enforce_notice and not c["passed"] and c["name"].startswith(("Breaking changes", "Release notes"))]
    if blocking and not p.is_steward:
        raise Conflict("Pre-publish checks failed: " + "; ".join(f"{c['name']} ({c['detail']})" for c in blocking))
    now = datetime.now(timezone.utc)
    effective = body.get("effective_at") or now.isoformat()
    to_version = (body.get("to_version") or "").strip() or None
    cur.execute(
        """INSERT INTO change_event (asset_id, from_version, to_version, change_kinds, breaking, title, summary, diff,
                 release_notes, status, detected_by, published_by, published_at, effective_at, sunset_at, metrics_before)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'published',%s,%s,now(),%s,%s,%s) RETURNING change_id""",
        (asset["asset_id"], asset.get("published_version"), to_version, body["change_kinds"], body["breaking"], body["title"],
         (body.get("summary") or "").strip() or None, Jsonb(body.get("diff") or []), (body.get("release_notes") or "").strip() or None,
         detected_by, p.email, effective, body.get("sunset_at"), Jsonb(metrics.snapshot(cur, asset["asset_id"], now))),
    )
    change_id = cur.fetchone()["change_id"]
    if to_version:
        cur.execute(
            """INSERT INTO asset_version (asset_id, version, status, source, created_by) VALUES (%s, %s, 'published', 'manual', %s)
               ON CONFLICT (asset_id, version) DO UPDATE SET status = 'published'""",
            (asset["asset_id"], to_version, p.email))
        cur.execute("UPDATE asset_version SET status = 'superseded' WHERE asset_id = %s AND version <> %s AND status = 'published'",
                    (asset["asset_id"], to_version))
        cur.execute("UPDATE asset SET published_version = %s, latest_version = %s, updated_at = now() WHERE asset_id = %s",
                    (to_version, to_version, asset["asset_id"]))
    written = impact.freeze_impact(cur, change_id, extra_start)
    audit.audit_event(p.email, "change.publish", "asset", asset["asset_id"],
                      after={"change_id": change_id, "title": body["title"], "breaking": body["breaking"], "impact_rows": written,
                             "checks": checks}, request_id=p.request_id, cur=cur)
    return detail(cur, change_id, viewer=p.email)


RUNTIME_ACTIONS = {
    "pause": ("runtime_status", "paused", "runtime", True, "Paused in the registry"),
    "resume": ("runtime_status", "running", "runtime", False, "Resumed in the registry"),
    "deprecate": ("lifecycle_status", "deprecated", "deprecation", True, "Deprecated"),
    "retire": ("lifecycle_status", "retired", "deprecation", True, "Retired"),
}


def runtime_action(cur, asset: dict, action: str, reason: str, *, p: authz.Principal, perms: dict) -> dict:
    """Registry-level status (paused/deprecated/retired) with a reason; subscribers are notified.

    The platform object (endpoint, connection) is NOT stopped here. This marks the asset in the registry
    and tells its consumers.
    """
    if action not in RUNTIME_ACTIONS:
        raise ValueError(f"action must be one of {', '.join(RUNTIME_ACTIONS)}")
    authz.require(perms["can_pause"], "Only the asset's owners (or a steward) can change its status")
    if action == "retire":
        authz.require(p.is_steward, "Only a steward or admin can retire an asset")
    if not (reason or "").strip():
        raise ValueError("A reason is required")
    column, value, kind, breaking, verb = RUNTIME_ACTIONS[action]
    before = asset[column]
    if before == value:
        raise Conflict(f"Already {value}")
    cur.execute(f"UPDATE asset SET {column} = %s, updated_at = now() WHERE asset_id = %s", (value, asset["asset_id"]))
    audit.audit_event(p.email, f"asset.{action}", "asset", asset["asset_id"], before={column: before},
                      after={column: value, "reason": reason.strip()}, request_id=p.request_id, cur=cur)
    effective = (datetime.now(timezone.utc) + timedelta(days=BREAKING_NOTICE_DAYS)).isoformat() if action in ("deprecate", "retire") else None
    result = publish(cur, {**asset, column: value}, {
        "change_kinds": [kind], "breaking": breaking, "title": f"{verb}: {reason.strip()[:150]}", "summary": reason.strip(),
        "release_notes": reason.strip(), "effective_at": effective, "diff": [{"field": column, "before": before, "after": value}],
    }, p=p, perms={**perms, "can_publish": True}, detected_by="admin" if p.is_steward and not perms.get("is_owner") else "owner",
       enforce_notice=False)
    return result


def my_impacts(cur, email: str, open_only: bool = False) -> list[dict]:
    cur.execute(
        f"""SELECT i.*, c.change_id FROM impact_item i JOIN change_event c ON c.change_id = i.change_id
             WHERE i.email = %s {"AND i.ack_status = 'pending'" if open_only else ""} ORDER BY c.created_at DESC LIMIT 200""",
        (email,),
    )
    items = list(cur.fetchall())
    if not items:
        return []
    cur.execute("SELECT c.*, a.display_name, a.asset_type FROM change_event c JOIN asset a ON a.asset_id = c.asset_id WHERE c.change_id = ANY(%s)",
                ([i["change_id"] for i in items],))
    changes = {s["change_id"]: s for s in _summary_row(cur, list(cur.fetchall()), email)}
    return [{**{k: i[k] for k in ("impacted_key", "impact_type", "via_asset_id", "hops", "email", "ack_status", "ack_note",
                                   "migrate_by", "acked_at", "notified_at")}, "label": i["impacted_key"],
             "change": changes.get(i["change_id"])} for i in items]


def since(days: int) -> date:
    return date.today() - timedelta(days=days)
