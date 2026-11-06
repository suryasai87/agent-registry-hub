"""Agent Bricks enrichment of ``agent:endpoint:<endpoint_name>`` assets (created by ``agent_endpoints``).

Sources (read-only):
* ``GET /api/2.1/supervisor-agents`` (+ ``/{id}/tools``, ``/{id}/examples``): purpose, description, examples,
  owner, experiment, and the cleanest lineage there is (each tool is a typed reference).
* ``GET /api/2.1/knowledge-assistants`` (+ ``/{id}/knowledge-sources``, ``/{id}/examples``): sources -> reads_data.
* ``GET /api/2.0/tiles``: ``evaluation_run_exists`` and experiment ids for every brick type, plus descriptions and
  dataset lineage for Information Extraction / AI Extract tiles.

Knowledge Assistant and Supervisor Agent are legacy products since Oct 12 2026 (still listed by the v2.1
APIs), so their assets carry ``attributes.agent_bricks.platform_status = "legacy"``.

Everything lands in ``attributes.agent_bricks`` (merged, so ``agent_endpoints`` never drops it), the descriptive
source fields, owners, experiments, edges and the ``agent_bricks`` snapshot section. A tool removed from a
supervisor therefore becomes a breaking change event with frozen impact.
"""
from __future__ import annotations

from collectors import upserts as up
from collectors.base import Collector
from collectors.util import clean_text, ms_to_dt, owner_id, purpose_from, short_hash

NAME = "agent_bricks"


def tool_target(tool: dict) -> tuple[str, str, str] | None:
    """Supervisor tool -> (relation, dst node, edge kind)."""
    t = tool.get("tool_type")
    ref = tool.get(t) if isinstance(tool.get(t), dict) else {}
    if t == "genie_space":
        sid = (tool.get("genie_space") or {}).get("space_id") or (tool.get("genie_space") or {}).get("id")
        return ("calls_agent", f"agent:genie:{sid}", "declared") if sid else None
    if t == "knowledge_assistant":
        ep = (tool.get("knowledge_assistant") or {}).get("serving_endpoint_name")
        return ("calls_agent", f"agent:endpoint:{ep}", "declared") if ep else None
    if t == "uc_function":
        fn = (tool.get("uc_function") or {}).get("name")
        return ("uses_tool", f"tool:uc:{fn}", "declared") if fn else None
    if t == "uc_connection":
        conn = (tool.get("uc_connection") or {}).get("name")
        return ("uses_mcp", f"mcp:connection:{conn}", "declared") if conn else None
    if t == "uc_mcp":
        svc = (tool.get("uc_mcp") or {}).get("name")
        if svc:
            svc = svc.split("/", 1)[1] if svc.startswith("mcp-services/") else svc
            return ("uses_mcp", f"mcp:system:{svc}" if svc.startswith("system.ai.") else f"mcp:service:{svc}", "declared")
        return None
    if t in ("uc_table", "table"):
        name = (tool.get(t) or {}).get("name")
        return ("reads_data", f"table:{name}", "declared") if name else None
    if t == "databricks_web_search":
        return ("uses_tool", "web:search", "declared")
    if t == "vector_search_index":
        name = ref.get("name") or ref.get("index_name")
        return ("reads_data", f"index:{name}", "declared") if name else None
    if t == "volume":
        name = ref.get("name")
        if name:
            path = name if name.startswith("/Volumes/") else "/Volumes/" + name.replace(".", "/")
            return ("reads_data", f"volume:{path}", "declared")
        return None
    if t == "serving_endpoint":
        name = ref.get("name") or ref.get("endpoint_name")
        return ("calls_agent", f"agent:endpoint:{name}", "declared") if name else None
    if t == "app":
        name = ref.get("name")
        if name:
            return ("calls_agent", f"agent:app:{name}", "declared") if name.startswith("agent-bricks-") else ("uses_tool", f"app:{name}", "declared")
        return None
    if t == "skill":
        name = ref.get("name")
        return ("uses_skill", f"skill:uc:{name}", "declared") if name else None
    if t == "supervisor_agent":
        ep = ref.get("endpoint_name")
        return ("calls_agent", f"agent:endpoint:{ep}", "declared") if ep else None
    return None


def ka_source_target(src: dict) -> tuple[str, str] | None:
    """v2.1 knowledge source (or v2.0 shape) -> (dst node, kind)."""
    stype = src.get("source_type")
    files = src.get("files") or (src.get("files_source") or {}).get("files") or {}
    index = src.get("index") or (src.get("index_source") or {}).get("index") or {}
    table = src.get("file_table") or {}
    if files.get("path"):
        return f"volume:{files['path']}", "files"
    if index.get("index_name") or index.get("name"):
        return f"index:{index.get('index_name') or index.get('name')}", "index"
    if table.get("table_name"):
        return f"table:{table['table_name']}", "file_table"
    return (f"external:{stype}", stype) if stype else None


def example_questions(examples: list[dict]) -> list[str]:
    out = []
    for ex in examples or []:
        q = ex.get("question")
        if isinstance(q, list):
            q = " ".join(str(x) for x in q)
        q = clean_text(q)
        if q:
            out.append(q)
    return out


class AgentBricksCollector(Collector):
    name = NAME
    label = "Agent Bricks (Supervisor Agents, Knowledge Assistants, tiles)"

    def collect(self) -> None:
        ctx = self.ctx
        sas = ctx.paginate("/api/2.1/supervisor-agents", "supervisor_agents")
        kas = ctx.paginate("/api/2.1/knowledge-assistants", "knowledge_assistants")
        tiles: list[dict] = []
        try:
            tiles = ctx.paginate("/api/2.0/tiles", "tiles")
        except Exception as e:  # noqa: BLE001 - tiles only add evaluation flags and non-KA/MAS bricks
            self.warn("GET /api/2.0/tiles", e)
        self.items_seen = len(sas) + len(kas)
        self.detail.update(supervisors=len(sas), knowledge_assistants=len(kas), tiles=len(tiles))

        def sa_detail(sa):
            sid = sa["supervisor_agent_id"]
            tools = ctx.paginate(f"/api/2.1/supervisor-agents/{sid}/tools", "tools", page_size=None)
            try:
                examples = ctx.paginate(f"/api/2.1/supervisor-agents/{sid}/examples", "examples", page_size=None)
            except Exception as e:  # noqa: BLE001
                self.soft_fail("examples", f"examples {sid}", e)
                examples = None
            return tools, examples

        def ka_detail(ka):
            kid = ka["id"]
            sources = ctx.paginate(f"/api/2.1/knowledge-assistants/{kid}/knowledge-sources", "knowledge_sources", page_size=None)
            try:
                examples = ctx.paginate(f"/api/2.1/knowledge-assistants/{kid}/examples", "examples", page_size=None)
            except Exception as e:  # noqa: BLE001
                self.soft_fail("examples", f"examples {kid}", e)
                examples = None
            return sources, examples

        sa_rows = ctx.pmap(sa_detail, [s for s in sas if s.get("supervisor_agent_id")])
        ka_rows = ctx.pmap(ka_detail, [k for k in kas if k.get("id")])
        tiles_by_endpoint = {t["serving_endpoint_name"]: t for t in tiles if t.get("serving_endpoint_name")}

        with self.transaction() as cur:
            existing = up.existing_assets(cur, "agent:endpoint:")
            for sa, res, err in sa_rows:
                aid = f"agent:endpoint:{sa.get('endpoint_name')}"
                if err:
                    self.soft_fail("tools", f"tools {sa['supervisor_agent_id']}", err)
                    continue
                if aid not in existing:
                    self.count("skipped_no_endpoint_asset")
                    continue
                with self.item(cur, aid):
                    self._supervisor(cur, aid, sa, res[0], res[1], tiles_by_endpoint.get(sa.get("endpoint_name")))
            for ka, res, err in ka_rows:
                aid = f"agent:endpoint:{ka.get('endpoint_name')}"
                if err:
                    self.soft_fail("knowledge_sources", f"knowledge-sources {ka['id']}", err)
                    continue
                if aid not in existing:
                    self.count("skipped_no_endpoint_asset")
                    continue
                with self.item(cur, aid):
                    self._knowledge_assistant(cur, aid, ka, res[0], res[1], tiles_by_endpoint.get(ka.get("endpoint_name")))
            for tile in tiles:
                if tile.get("tile_type") in ("MAS", "KA"):
                    continue
                aid = f"agent:endpoint:{tile.get('serving_endpoint_name')}"
                if aid not in existing:
                    continue
                with self.item(cur, aid):
                    self._tile(cur, aid, tile)

    # ------------------------------------------------------------------ writers
    def _common(self, cur, aid: str, *, kind: str, description: str | None, examples: list[str] | None,
                label: str, creator: str | None, experiment_ids: list, block: dict) -> None:
        fields = {"purpose": (purpose_from(description), label), "description": (description, label)}
        if examples is not None:
            fields["example_prompts"] = (examples, f"{label.split(' description')[0]} examples")
        self.changed(up.upsert_fields(cur, aid, fields))
        if creator:
            self.changed(up.sync_owners(cur, aid, [owner_id(creator)], collector=NAME))
        for exp, source in experiment_ids:
            self.changed(up.link_experiment(cur, aid, exp, source))
        self.changed(up.merge_attributes(cur, aid, "agent_bricks", {"kind": kind, **{k: v for k, v in block.items() if v is not None}}))

    def _supervisor(self, cur, aid: str, sa: dict, tools: list[dict], examples: list[dict] | None, tile: dict | None) -> None:
        refs = []
        for tool in tools:
            target = tool_target(tool)
            refs.append({"name": tool.get("tool_id") or (tool.get("name") or "").rsplit("/", 1)[-1],
                         "type": tool.get("tool_type"), "target": target[1] if target else None})
            if target:
                relation, dst, kind = target
                self.changed(up.edge(cur, aid, dst, relation, kind, "supervisor_tools", attributes={
                    "tool_id": tool.get("tool_id"), "tool_type": tool.get("tool_type"),
                    "description": (clean_text(tool.get("description")) or "")[:300] or None}))
            else:
                self.count("unmapped_tool_types")
        self.changed(up.prune_edges(cur, source="supervisor_tools", seen_at=self.seen_at, src_ids=[aid]))
        tile = tile or {}
        self._common(cur, aid, kind="supervisor_agent", description=sa.get("description"),
                     examples=example_questions(examples) if examples is not None else None,
                     label="Supervisor Agent description", creator=sa.get("creator"),
                     experiment_ids=[(sa.get("experiment_id"), "supervisor_agent"), (tile.get("mlflow_experiment_id"), "tile")],
                     block={"id": sa.get("supervisor_agent_id"), "display_name": sa.get("display_name"),
                            "platform_status": "legacy", "tools": refs, "tools_count": len(refs),
                            "instructions_present": bool(clean_text(sa.get("instructions"))),
                            "examples_count": len(examples) if examples is not None else None,
                            "evaluation_run_exists": tile.get("evaluation_run_exists"),
                            "experiment_id": sa.get("experiment_id"), "tile_id": tile.get("tile_id"),
                            "create_time": sa.get("create_time")})
        from registry import versioning

        if versioning.record_snapshot(cur, aid, {
            "tools": [{"name": r["name"], "type": r["type"], "target": r["target"]} for r in refs],
            "instructions_hash": short_hash(clean_text(sa.get("instructions"))),
            "description_hash": short_hash(clean_text(sa.get("description"))),
        }, section="agent_bricks"):
            self.count("change_events")

    def _knowledge_assistant(self, cur, aid: str, ka: dict, sources: list[dict], examples: list[dict] | None,
                             tile: dict | None) -> None:
        refs = []
        for src in sources:
            target = ka_source_target(src)
            name = src.get("display_name") or src.get("id")
            refs.append({"name": name, "type": src.get("source_type"), "target": target[0] if target else None,
                         "state": src.get("state")})
            if target and not target[0].startswith("external:"):
                self.changed(up.edge(cur, aid, target[0], "reads_data", "declared", "ka_sources", attributes={
                    "source_type": src.get("source_type"), "display_name": name}))
        self.changed(up.prune_edges(cur, source="ka_sources", seen_at=self.seen_at, src_ids=[aid]))
        tile = tile or {}
        self._common(cur, aid, kind="knowledge_assistant", description=ka.get("description"),
                     examples=example_questions(examples) if examples else None,
                     label="Knowledge Assistant description", creator=ka.get("creator"),
                     experiment_ids=[(ka.get("experiment_id"), "knowledge_assistant"), (tile.get("mlflow_experiment_id"), "tile")],
                     block={"id": ka.get("id"), "display_name": ka.get("display_name"), "platform_status": "legacy",
                            "state": ka.get("state"), "knowledge_sources": refs, "sources_count": len(refs),
                            "instructions_present": bool(clean_text(ka.get("instructions"))),
                            "evaluation_run_exists": tile.get("evaluation_run_exists"),
                            "experiment_id": ka.get("experiment_id"), "tile_id": tile.get("tile_id"),
                            "create_time": ka.get("create_time")})
        from registry import versioning

        if versioning.record_snapshot(cur, aid, {
            "knowledge_sources": [{"name": r["name"], "type": r["type"], "target": r["target"]} for r in refs],
            "instructions_hash": short_hash(clean_text(ka.get("instructions"))),
            "description_hash": short_hash(clean_text(ka.get("description"))),
        }, section="agent_bricks"):
            self.count("change_events")

    def _tile(self, cur, aid: str, tile: dict) -> None:
        spec = tile.get("task_spec") or {}
        tables = sorted({(d.get("table") or {}).get("name") for d in spec.get("datasets") or [] if (d.get("table") or {}).get("name")})
        for t in tables:
            self.changed(up.edge(cur, aid, f"table:{t}", "reads_data", "declared", "tile_datasets",
                                 attributes={"tile_type": tile.get("tile_type")}))
        self.changed(up.prune_edges(cur, source="tile_datasets", seen_at=self.seen_at, src_ids=[aid]))
        instructions = clean_text(tile.get("instructions") or spec.get("instructions"))
        self._common(cur, aid, kind=str(tile.get("tile_type") or "tile").lower(), description=tile.get("description"),
                     examples=None, label="Agent Bricks tile description", creator=tile.get("creator"),
                     experiment_ids=[(tile.get("mlflow_experiment_id"), "tile")],
                     block={"tile_id": tile.get("tile_id"), "tile_type": tile.get("tile_type"),
                            "display_name": tile.get("name"), "evaluation_run_exists": tile.get("evaluation_run_exists"),
                            "instructions_present": bool(instructions), "datasets": tables,
                            "experiment_id": tile.get("mlflow_experiment_id"),
                            "create_time": ms_to_dt(tile.get("creation_timestamp_ms")).isoformat()
                            if tile.get("creation_timestamp_ms") else None})
        from registry import versioning

        if versioning.record_snapshot(cur, aid, {
            "data_sources": tables, "instructions_hash": short_hash(instructions),
            "description_hash": short_hash(clean_text(tile.get("description"))),
        }, section="agent_bricks"):
            self.count("change_events")
