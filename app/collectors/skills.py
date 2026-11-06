"""UC skills: ``skill:uc:<catalog>.<schema>.<bundle>``.

There is no metastore-wide skills list, so the hosting schemas come from ``system.access.audit``
(``service_name = 'aiGatewaySkills'``, ``request_params.uc_location``: 90 days on the first run, then
incrementally from the last successful run), the schemas of skills already registered, plus ``SKILL_SCHEMAS``
(comma-separated, default ``main.vital_skills``). Per schema:
``GET /api/2.1/unity-catalog/skills?parent=schemas/<c>.<s>``; grants via ``effective-permissions/skill/<fqn>``.
``skillLoad`` audit events (by ``user_identity.email``) become usage (source ``audit_skill_load``) and
observed ``consumes`` edges user -> skill.
"""
from __future__ import annotations

import os
from datetime import date, timedelta

from collectors import upserts as up
from collectors.base import ApiError, Collector
from collectors.util import clean_text, iso_to_dt, owner_id, purpose_from, short_hash, to_date, uc_grant_rows
from core import db
from registry import versioning

NAME = "skills"
SOURCE = "audit_skill_load"

AUDIT_SQL = """
SELECT event_date AS day, action_name, request_params['uc_location'] AS uc_location,
       request_params['fully_qualified_name'] AS fqn, lower(user_identity.email) AS email,
       count(*) AS events, sum(CASE WHEN response.status_code >= 400 THEN 1 ELSE 0 END) AS errors
  FROM system.access.audit
 WHERE workspace_id = ? AND event_date >= ? AND service_name = 'aiGatewaySkills'
 GROUP BY ALL
"""
DISCOVERY_DAYS = 90
OVERLAP_DAYS = 2


def skill_schemas_from_env() -> list[str]:
    raw = os.environ.get("SKILL_SCHEMAS", "main.vital_skills")
    return [s.strip() for s in raw.split(",") if s.strip().count(".") == 1]


class SkillsCollector(Collector):
    name = NAME
    label = "UC skills"

    def collect(self) -> None:
        ctx = self.ctx
        today = ctx.today()
        # One audit scan, incremental: 90 days the first time, then from the last successful run (minus overlap).
        last = (db.query_one("""SELECT max(started_at) AS t FROM sync_run WHERE collector = %s
                                 AND status IN ('succeeded', 'partial')""", (NAME,)) or {}).get("t")
        start = today - timedelta(days=DISCOVERY_DAYS)
        if last:
            start = max(start, last.date() - timedelta(days=OVERLAP_DAYS))
        self.detail["audit_start"] = start.isoformat()
        schemas = list(skill_schemas_from_env())
        schemas += [r["s"] for r in db.query(
            "SELECT DISTINCT split_part(name, '.', 1) || '.' || split_part(name, '.', 2) AS s FROM asset WHERE asset_id LIKE %s",
            ("skill:uc:%",))]
        audit: list[dict] | None
        try:
            audit = ctx.sql(AUDIT_SQL, [ctx.workspace_id, start])
        except Exception as e:  # noqa: BLE001 - the configured and known schemas still sync
            self.warn("aiGatewaySkills audit events", e)
            audit = None
        for r in audit or []:
            loc = r.get("uc_location") or (r.get("fqn") or "").rsplit(".", 1)[0]
            if loc.count(".") == 1:
                schemas.append(loc)
        schemas = list(dict.fromkeys(schemas))
        self.detail["schemas"] = schemas

        skills: list[dict] = []
        for schema, res, err in ctx.pmap(lambda s: ctx.paginate("/api/2.1/unity-catalog/skills", "skills",
                                                                 {"parent": f"schemas/{s}"}, page_size=None), schemas):
            if err:
                if isinstance(err, ApiError) and err.status in (403, 404):
                    self.count("schemas_not_readable")
                else:
                    self.warn(f"skills {schema}", err)
                continue
            skills.extend(s for s in res if s.get("name"))
        self.items_seen = len(skills)

        grants = {}
        for s, res, err in ctx.pmap(lambda s: ctx.api("GET", f"/api/2.1/unity-catalog/effective-permissions/skill/{_fqn(s)}"), skills):
            if err:
                self.soft_fail("grants", f"grants {_fqn(s)}", err)
            else:
                grants[_fqn(s)] = uc_grant_rows(res)

        cutoff = max(start, today - timedelta(days=ctx.days))
        loads = None if audit is None else [
            {"day": r.get("day"), "fqn": r.get("fqn"), "email": r.get("email"), "loads": r.get("events"), "errors": r.get("errors")}
            for r in audit if r.get("action_name") == "skillLoad" and r.get("fqn")]

        with self.transaction() as cur:
            seen = []
            for s in skills:
                aid = f"skill:uc:{_fqn(s)}"
                with self.item(cur, aid):
                    self._write(cur, aid, s, grants.get(_fqn(s)))
                    seen.append(aid)
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen))
            if loads is not None:
                self._usage(cur, loads, cutoff, set(seen), today)

    def _write(self, cur, aid: str, s: dict, grants: list[dict] | None) -> None:
        ctx = self.ctx
        fqn = _fqn(s)
        catalog, schema, bundle = fqn.split(".", 2)
        description = clean_text(s.get("description")) or clean_text(s.get("comment"))
        self.changed(up.upsert_asset(cur, {
            "asset_id": aid, "asset_type": "skill", "subtype": "uc_skill", "name": fqn,
            "display_name": s.get("bundle_name") or bundle, "source": "databricks", "platform": "unity_catalog",
            "publisher": None, "parent_asset_id": None, "runtime_status": "running" if s.get("finalize_time") else "unknown",
            "external_ref": {"skill_full_name": fqn, "skill_id": s.get("id")},
            "attributes": {k: v for k, v in {
                "bundle_name": s.get("bundle_name"), "finalize_time": s.get("finalize_time"),
                "content_path": f"/Skills/{catalog}/{schema}/{bundle}/SKILL.md", "etag": s.get("etag"),
                "effective_owner": s.get("effective_owner"), "comment": clean_text(s.get("comment")),
            }.items() if v is not None},
            "deep_link": f"{ctx.host}/explore/data/{catalog}/{schema}", "sync_source": NAME,
            "created_by": owner_id(s.get("created_by")),
            "source_created_at": iso_to_dt(s.get("create_time")), "source_updated_at": iso_to_dt(s.get("update_time")),
        }))
        self.changed(up.upsert_fields(cur, aid, {
            "purpose": (purpose_from(description), "UC skill description"),
            "description": (description, "UC skill description"),
        }))
        if owner_id(s.get("effective_owner")):
            self.changed(up.sync_owners(cur, aid, [owner_id(s["effective_owner"])], collector=NAME))
        if grants is not None:
            self.changed(up.sync_grants(cur, aid, grants, seen_at=self.seen_at))
        if versioning.record_snapshot(cur, aid, {"revision": s.get("finalize_time"),
                                                 "description_hash": short_hash(description)}):
            self.count("change_events")

    def _usage(self, cur, loads: list[dict], cutoff: date, skills: set[str], today: date) -> None:
        cur.execute("DELETE FROM usage_daily WHERE source = %s AND day >= %s", (SOURCE, cutoff))
        rows = []
        for r in loads:
            aid = f"skill:uc:{r['fqn']}"
            email = (r.get("email") or "").strip().lower()
            if aid not in skills or not email:
                continue
            day = to_date(r.get("day"))
            if not day or day < cutoff:
                continue
            rows.append((day, aid, email, "user", SOURCE, int(r.get("loads") or 0), int(r.get("errors") or 0)))
        if rows:
            cur.executemany(
                """INSERT INTO usage_daily (day, asset_id, requester, requester_kind, source, requests, errors)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (day, asset_id, requester, source, tool_name) DO UPDATE
                      SET requests = EXCLUDED.requests, errors = EXCLUDED.errors""",
                rows,
            )
        self.count("usage_rows", len(rows))
        # Weights come from the stored rollup (the audit read is incremental, older days are not re-read).
        cur.execute(
            """SELECT requester, asset_id, sum(requests)::bigint AS n FROM usage_daily
                WHERE source = %s AND day >= %s GROUP BY requester, asset_id ORDER BY 1, 2""",
            (SOURCE, today - timedelta(days=30)),
        )
        for r in cur.fetchall():
            self.changed(up.edge(cur, f"user:{r['requester']}", r["asset_id"], "consumes", "observed", SOURCE,
                                 weight_30d=int(r["n"])))
        self.changed(up.prune_edges(cur, source=SOURCE, seen_at=self.seen_at, edge_kind="observed"))


def _fqn(skill: dict) -> str:
    return str(skill["name"]).removeprefix("skills/")
