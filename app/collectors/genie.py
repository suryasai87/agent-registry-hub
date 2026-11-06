"""Genie Agents (Genie spaces): ``agent:genie:<space_id>``.

Sources: ``GET /api/2.0/genie/spaces`` (paginated), the detail with ``include_serialized_space=true`` (tables,
metric views, sample questions, instructions; re-read only when the space's ``update_time`` moved) and the ACL
``GET /api/2.0/permissions/genie/{id}`` (CAN_MANAGE users/SPs = synced owners, everything else = grants).
"""
from __future__ import annotations

import json
import re

from collectors import upserts as up
from collectors.base import Collector
from collectors.util import acl_rows, clean_text, iso_to_dt, purpose_from, short_hash
from core import db
from registry import versioning

NAME = "genie"
USER_PATH = re.compile(r"^/Users/([^/]+@[^/]+)")


def parse_serialized(text: str | None) -> dict:
    """``serialized_space`` (a JSON string) -> {tables, metric_views, sample_questions, instructions_hash}."""
    try:
        ss = json.loads(text) if text else {}
    except ValueError:
        ss = {}
    ds = ss.get("data_sources") or {}
    tables = sorted({t.get("identifier") for t in ds.get("tables") or [] if t.get("identifier")})
    metric_views = sorted({t.get("identifier") for t in ds.get("metric_views") or [] if t.get("identifier")})
    questions = []
    for q in (ss.get("config") or {}).get("sample_questions") or []:
        text_q = q.get("question")
        text_q = " ".join(text_q) if isinstance(text_q, list) else text_q
        text_q = clean_text(text_q)
        if text_q:
            questions.append(text_q)
    ins = ss.get("instructions") or {}
    instructions = {
        "text": ["".join(i.get("content") or []) for i in ins.get("text_instructions") or []],
        "sql": [["".join(e.get("question") or []), "".join(e.get("sql") or [])] for e in ins.get("example_question_sqls") or []],
        "joins": ["".join(j.get("sql") or []) for j in ins.get("join_specs") or []],
        "functions": [f.get("identifier") for f in ins.get("sql_functions") or []],
    }
    has_instructions = any(instructions.values())
    return {"tables": tables, "metric_views": metric_views, "sample_questions": questions,
            "instructions_hash": short_hash(instructions) if has_instructions else None,
            "text_instruction_count": len(instructions["text"]), "example_sql_count": len(instructions["sql"])}


def owners_and_grants(acl: dict, parent_path: str | None) -> tuple[list[str], list[dict]]:
    rows = acl_rows(acl)
    owners = [r["principal"] for r in rows if r["privilege"] == "CAN_MANAGE" and r["principal_type"] != "group"]
    grants = [r for r in rows if not (r["privilege"] == "CAN_MANAGE" and r["principal_type"] != "group")]
    if not owners and parent_path:
        m = USER_PATH.match(parent_path)
        if m:
            owners = [m.group(1).lower()]
    return owners, grants


class GenieCollector(Collector):
    name = NAME
    label = "Genie Agents (Genie spaces)"

    def collect(self) -> None:
        ctx = self.ctx
        spaces = [s for s in ctx.paginate("/api/2.0/genie/spaces", "spaces") if s.get("space_id")]
        self.items_seen = len(spaces)
        known = {r["asset_id"]: r["attributes"] or {} for r in
                 db.query("SELECT asset_id, attributes FROM asset WHERE asset_id LIKE 'agent:genie:%%'")}

        def stale(s):
            attrs = known.get(f"agent:genie:{s['space_id']}") or {}
            return attrs.get("detail_update_time") != s.get("update_time") or "tables" not in attrs

        need = [s for s in spaces if stale(s)]
        self.detail["details_read"] = len(need)
        details = {}
        for s, res, err in ctx.pmap(lambda s: ctx.api("GET", f"/api/2.0/genie/spaces/{s['space_id']}",
                                                      query={"include_serialized_space": "true"}), need):
            if err:
                self.soft_fail("detail", f"space {s['space_id']}", err)
            else:
                details[s["space_id"]] = res
        acls = {}
        for s, res, err in ctx.pmap(lambda s: ctx.api("GET", f"/api/2.0/permissions/genie/{s['space_id']}"), spaces):
            if err:
                self.soft_fail("acl", f"ACL {s['space_id']}", err)
            else:
                acls[s["space_id"]] = res

        with self.transaction() as cur:
            seen = []
            for s in spaces:
                aid = f"agent:genie:{s['space_id']}"
                with self.item(cur, aid):
                    self._write(cur, aid, s, details.get(s["space_id"]), known.get(aid) or {}, acls.get(s["space_id"]))
                    seen.append(aid)
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen))

    def _write(self, cur, aid: str, s: dict, detail: dict | None, prev: dict, acl: dict | None) -> None:
        ctx = self.ctx
        sid = s["space_id"]
        if detail is not None:
            parsed = parse_serialized(detail.get("serialized_space"))
            parsed["parent_path"] = detail.get("parent_path")
            parsed["detail_update_time"] = s.get("update_time")
        elif "tables" in prev:
            parsed = {k: prev.get(k) for k in ("tables", "metric_views", "sample_questions", "instructions_hash",
                                                "text_instruction_count", "example_sql_count", "parent_path",
                                                "detail_update_time")}
        else:
            parsed = None
        title = clean_text(s.get("title")) or sid
        attributes = {"mcp_path": f"/api/2.0/mcp/genie/{sid}", "warehouse_id": s.get("warehouse_id"),
                      "update_time": s.get("update_time"), **(parsed or {})}
        self.changed(up.upsert_asset(cur, {
            "asset_id": aid, "asset_type": "agent", "subtype": "genie_space", "name": title, "display_name": title,
            "source": "databricks", "platform": "genie", "publisher": None, "parent_asset_id": None,
            "runtime_status": "running", "external_ref": {"space_id": sid, "warehouse_id": s.get("warehouse_id")},
            "attributes": {k: v for k, v in attributes.items() if v is not None},
            "deep_link": f"{ctx.host}/genie/rooms/{sid}", "sync_source": NAME,
            "source_created_at": iso_to_dt(s.get("create_time")), "source_updated_at": iso_to_dt(s.get("update_time")),
        }))
        fields = {
            "purpose": (purpose_from(s.get("description")), "Genie space description"),
            "description": (s.get("description"), "Genie space description"),
            "endpoint_url": (f"{ctx.host}/api/2.0/mcp/genie/{sid}", "Managed MCP (Genie)"),
            "auth_model": ("Databricks OAuth as the calling user (Genie space permissions apply)", "Managed MCP (Genie)"),
        }
        if parsed is not None:
            fields["example_prompts"] = (parsed.get("sample_questions"), "Genie sample questions")
        self.changed(up.upsert_fields(cur, aid, fields))
        if acl is not None:
            owners, grants = owners_and_grants(acl, (parsed or {}).get("parent_path"))
            self.changed(up.sync_owners(cur, aid, owners, collector=NAME))
            self.changed(up.sync_grants(cur, aid, grants, seen_at=self.seen_at))
        if parsed is None:
            return
        for table in sorted(set(parsed.get("tables") or []) | set(parsed.get("metric_views") or [])):
            self.changed(up.edge(cur, aid, f"table:{table}", "reads_data", "declared", "genie_space",
                                 attributes={"metric_view": table in (parsed.get("metric_views") or [])}))
        self.changed(up.prune_edges(cur, source="genie_space", seen_at=self.seen_at, src_ids=[aid]))
        if versioning.record_snapshot(cur, aid, {
            "tables": sorted(set(parsed.get("tables") or []) | set(parsed.get("metric_views") or [])),
            "instructions_hash": parsed.get("instructions_hash"),
            "description_hash": short_hash(clean_text(s.get("description"))),
        }):
            self.count("change_events")
