"""Agents served on Model Serving endpoints: ``agent:endpoint:<endpoint_name>``.

Source: ``GET /api/2.0/serving-endpoints`` (agents = ``task`` starting with ``agent/``, plus endpoints deployed
by ``databricks.agents.deploy``, recognisable by the ``MONITOR_EXPERIMENT_ID`` tag even when ``task`` is absent),
the endpoint detail (``config_version``), the endpoint ACL, ``GET /api/2.0/tiles`` (display names of Agent
Bricks tiles) and UC model-version dependencies (``model_version_dependencies``) for lineage.

``environment_vars`` (and every other secret-bearing key) is dropped from the raw payloads before any field is
read, and only allow-listed keys reach the registry.
"""
from __future__ import annotations

import re

from collectors import upserts as up
from collectors.base import Collector
from collectors.util import acl_rows, ms_to_dt, owner_id, purpose_from, scrub, short_hash
from registry import versioning

NAME = "agent_endpoints"
PROBLEM_SUBTYPES = {
    "MULTI_AGENT_SUPERVISOR": "agent_bricks_supervisor",
    "KNOWLEDGE_ASSISTANT": "agent_bricks_knowledge_assistant",
    "INFORMATION_EXTRACTION": "agent_bricks_information_extraction",
}
LEGACY_PROBLEM_TYPES = ("MULTI_AGENT_SUPERVISOR", "KNOWLEDGE_ASSISTANT")
ENTITY_KEEP = ("name", "type", "entity_name", "entity_version", "workload_size", "workload_type", "scale_to_zero_enabled")
PROVIDER_PREFIXES = ("databricks-", "system.ai.", "meta-", "openai-", "anthropic-")


def is_agent_endpoint(ep: dict) -> bool:
    if str(ep.get("task") or "").startswith("agent/"):
        return True
    return any(t.get("key") == "MONITOR_EXPERIMENT_ID" for t in ep.get("tags") or [])


def subtype_of(ep: dict) -> str:
    problem = (ep.get("tile_endpoint_metadata") or {}).get("problem_type")
    if problem:
        return PROBLEM_SUBTYPES.get(problem, f"agent_bricks_{problem.lower()}")
    return "custom_agent"


def runtime_of(ep: dict) -> str:
    state = ep.get("state") or {}
    if state.get("suspend") == "SUSPENDED":
        return "stopped"
    if state.get("ready") == "READY":
        return "degraded" if state.get("config_update") == "UPDATE_FAILED" else "running"
    if state.get("ready") == "NOT_READY":
        return "degraded"
    return "unknown"


def model_family(name: str | None) -> str | None:
    """'databricks-claude-sonnet-4-5' -> 'claude'; UC models keep their full name (another model = another family)."""
    if not name:
        return None
    text = name.lower()
    if text.count(".") == 2 and not text.startswith("system.ai."):
        return text
    for prefix in PROVIDER_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix):]
    return re.split(r"[-_.:/]", text, 1)[0] or text


def served_entities(ep: dict) -> list[dict]:
    out = []
    for se in (ep.get("config") or {}).get("served_entities") or []:
        item = {k: se.get(k) for k in ENTITY_KEEP if se.get(k) is not None}
        if se.get("external_model"):
            em = se["external_model"]
            item["external_model"] = {k: em.get(k) for k in ("provider", "name", "task") if em.get(k)}
        if se.get("foundation_model"):
            item["foundation_model"] = {"name": (se["foundation_model"] or {}).get("name")}
        if (se.get("state") or {}).get("deployment"):
            item["deployment"] = se["state"]["deployment"]
        model = se.get("entity_name") or (se.get("external_model") or {}).get("name") or (se.get("foundation_model") or {}).get("name")
        item["family"] = model_family(model)
        out.append(item)
    return out


def model_node(entity: dict) -> str | None:
    if entity.get("entity_name"):
        return f"model:{entity['entity_name']}"
    if (entity.get("external_model") or {}).get("name"):
        return f"model:{entity['external_model']['name']}"
    return None


def gateway_policies(endpoint: str, gw: dict) -> list[dict]:
    """``ai_gateway`` -> registry policies: one per guardrail check and phase, rate limit, tracking, logging, fallback."""
    out: list[dict] = []
    pid = lambda kind, phase=None: f"gw:{endpoint}:{kind}" + (f":{phase}" if phase else "")  # noqa: E731
    for phase in ("input", "output"):
        g = (gw.get("guardrails") or {}).get(phase) or {}
        if g.get("safety"):
            out.append({"policy_id": pid("safety", phase), "name": f"Safety filter ({phase})", "kind": "guardrail",
                        "phase": phase, "action": "block", "config": {"safety": True},
                        "description": f"AI Gateway safety guardrail on the {phase} of {endpoint}."})
        behavior = str((g.get("pii") or {}).get("behavior") or "").upper()
        if behavior in ("MASK", "BLOCK") or (g.get("pii_detection") and behavior != "NONE"):
            action = "mask" if behavior == "MASK" else "block" if behavior == "BLOCK" else "flag"
            out.append({"policy_id": pid("pii", phase), "name": f"PII {action} ({phase})", "kind": "guardrail",
                        "phase": phase, "action": action, "config": {"pii_behavior": behavior or None},
                        "description": f"AI Gateway PII detection on the {phase} of {endpoint} ({action})."})
        if g.get("invalid_keywords"):
            out.append({"policy_id": pid("keywords", phase), "name": f"Blocked keywords ({phase})", "kind": "guardrail",
                        "phase": phase, "action": "block", "config": {"invalid_keywords_count": len(g["invalid_keywords"])},
                        "description": f"AI Gateway keyword guardrail on the {phase} of {endpoint}."})
        if g.get("valid_topics"):
            out.append({"policy_id": pid("topics", phase), "name": f"Allowed topics ({phase})", "kind": "guardrail",
                        "phase": phase, "action": "block", "config": {"valid_topics": list(g["valid_topics"])[:20]},
                        "description": f"AI Gateway topic guardrail on the {phase} of {endpoint}."})
    limits = gw.get("rate_limits") or []
    if limits:
        summary = "; ".join(f"{r.get('calls') or r.get('tokens')} {'calls' if r.get('calls') else 'tokens'}/"
                            f"{r.get('renewal_period')} per {r.get('key')}" + (f" ({r['principal']})" if r.get("principal") else "")
                            for r in limits)
        out.append({"policy_id": pid("rate_limit"), "name": "Rate limit", "kind": "rate_limit", "phase": "input",
                    "action": "limit", "config": {"rate_limits": limits}, "description": summary})
    if (gw.get("usage_tracking_config") or {}).get("enabled"):
        out.append({"policy_id": pid("usage_tracking"), "name": "Usage tracking", "kind": "usage_tracking",
                    "phase": "n/a", "action": "log", "config": {"enabled": True},
                    "description": "AI Gateway usage tracking (system.serving.endpoint_usage)."})
    it = gw.get("inference_table_config") or {}
    if it.get("enabled"):
        table = ".".join(p for p in (it.get("catalog_name"), it.get("schema_name"), it.get("table_name_prefix")) if p)
        out.append({"policy_id": pid("inference_logging"), "name": "Payload logging (inference table)",
                    "kind": "inference_logging", "phase": "both", "action": "log",
                    "config": {"table_prefix": table}, "description": f"Requests and responses logged to {table}_payload."})
    if (gw.get("fallback_config") or {}).get("enabled"):
        out.append({"policy_id": pid("fallback"), "name": "Fallback to secondary models", "kind": "fallback",
                    "phase": "n/a", "action": "n/a", "config": {"enabled": True},
                    "description": "AI Gateway falls back to the other served entities when the primary fails."})
    for p in out:
        p["provider"] = "serving_ai_gateway"
    return out


def gateway_summary(gw: dict) -> dict:
    it = gw.get("inference_table_config") or {}
    return {
        "usage_tracking": bool((gw.get("usage_tracking_config") or {}).get("enabled")),
        "inference_table": ".".join(p for p in (it.get("catalog_name"), it.get("schema_name"), it.get("table_name_prefix")) if p)
        if it.get("enabled") else None,
        "rate_limits": gw.get("rate_limits") or [],
        "guardrails": gw.get("guardrails") or {},
        "fallback": bool((gw.get("fallback_config") or {}).get("enabled")),
    }


def dependency_edges(deps: list[dict], agent_names: set[str]) -> list[tuple[str, str, dict]]:
    """UC ``model_version_dependencies`` -> [(relation, dst, attributes)]."""
    out = []
    for d in deps or []:
        if (d.get("table") or {}).get("table_full_name"):
            out.append(("reads_data", f"table:{d['table']['table_full_name']}", {"dependency": "table"}))
        elif (d.get("function") or {}).get("function_full_name"):
            out.append(("uses_tool", f"tool:uc:{d['function']['function_full_name']}", {"dependency": "function"}))
        elif (d.get("connection") or {}).get("connection_name"):
            out.append(("uses_mcp", f"mcp:connection:{d['connection']['connection_name']}", {"dependency": "connection"}))
        elif d.get("serving_endpoint"):
            name = d["serving_endpoint"].get("endpoint_name") or d["serving_endpoint"].get("name")
            if name:
                out.append(("calls_agent", f"agent:endpoint:{name}", {"dependency": "serving_endpoint"}) if name in agent_names
                           else ("uses_model", f"model:{name}", {"dependency": "serving_endpoint"}))
        elif d.get("vector_search_index"):
            name = d["vector_search_index"].get("index_name") or d["vector_search_index"].get("name")
            if name:
                out.append(("reads_data", f"index:{name}", {"dependency": "vector_search_index"}))
        elif d.get("genie_space"):
            sid = d["genie_space"].get("genie_space_id") or d["genie_space"].get("space_id")
            if sid:
                out.append(("calls_agent", f"agent:genie:{sid}", {"dependency": "genie_space"}))
    return out


class AgentEndpointsCollector(Collector):
    name = NAME
    label = "Agents on Model Serving endpoints"

    def collect(self) -> None:
        ctx = self.ctx
        endpoints = [scrub(e) for e in (ctx.api("GET", "/api/2.0/serving-endpoints") or {}).get("endpoints") or []]
        agents = [e for e in endpoints if is_agent_endpoint(e) and e.get("name")]
        self.items_seen = len(agents)
        self.detail["endpoints_listed"] = len(endpoints)
        agent_names = {e["name"] for e in agents}

        tiles: dict[str, dict] = {}
        try:
            for t in ctx.paginate("/api/2.0/tiles", "tiles"):
                tiles[t.get("tile_id")] = t
        except Exception as e:  # noqa: BLE001 - tile names only improve display names
            self.warn("GET /api/2.0/tiles", e)

        details: dict[str, dict] = {}
        for ep, res, err in ctx.pmap(lambda ep: scrub(ctx.api("GET", f"/api/2.0/serving-endpoints/{ep['name']}")), agents):
            if err:
                self.soft_fail("detail", f"detail {ep['name']}", err)  # the list item is used instead (no config_version)
            else:
                details[ep["name"]] = res
        acls: dict[str, dict | None] = {}
        for ep, res, err in ctx.pmap(lambda ep: ctx.api("GET", f"/api/2.0/permissions/serving-endpoints/{ep['id']}"),
                                     [e for e in agents if e.get("id")]):
            if err:
                self.soft_fail("acl", f"ACL {ep['name']}", err)
            else:
                acls[ep["name"]] = res

        versions_needed = sorted({(se["entity_name"], str(se["entity_version"]))
                                  for e in agents for se in (details.get(e["name"], e).get("config") or {}).get("served_entities") or []
                                  if se.get("type") == "UC_MODEL" and se.get("entity_name") and se.get("entity_version")})
        deps: dict[tuple, list] = {}
        for key, res, err in ctx.pmap(lambda k: ctx.api("GET", f"/api/2.1/unity-catalog/models/{k[0]}/versions/{k[1]}"),
                                      versions_needed):
            if err:
                self.soft_fail("model_version", f"model version {key[0]}/{key[1]}", err)
            else:
                deps[key] = ((res or {}).get("model_version_dependencies") or {}).get("dependencies") or []
        self.detail["model_versions_read"] = len(deps)

        with self.transaction() as cur:
            seen = []
            for ep in agents:
                aid = f"agent:endpoint:{ep['name']}"
                with self.item(cur, aid):
                    self._write(cur, aid, details.get(ep["name"], ep), tiles, acls.get(ep["name"]), deps, agent_names)
                    seen.append(aid)
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen))

    # ------------------------------------------------------------------ one endpoint
    def _write(self, cur, aid: str, ep: dict, tiles: dict, acl: dict | None, deps: dict, agent_names: set[str]) -> None:
        ctx = self.ctx
        name = ep["name"]
        tem = ep.get("tile_endpoint_metadata") or {}
        tile = tiles.get(tem.get("tile_id")) or {}
        problem = tem.get("problem_type")
        entities = served_entities(ep)
        tags = {t.get("key"): t.get("value") for t in ep.get("tags") or [] if t.get("key")}
        gw = ep.get("ai_gateway") or {}
        policies = gateway_policies(name, gw)
        attributes = {
            "task": ep.get("task"),
            "endpoint_type": ep.get("endpoint_type"),
            "served_entities": entities,
            "tile_id": tem.get("tile_id"),
            "tile_model_name": tem.get("tile_model_name"),
            "problem_type": problem,
            "tile_type": tile.get("tile_type"),
            "state": ep.get("state") or {},
            "route_optimized": ep.get("route_optimized"),
            "config_version": (ep.get("config") or {}).get("config_version"),
            "tags": tags,
            "monitor_experiment_id": tags.get("MONITOR_EXPERIMENT_ID"),
            "ai_gateway": gateway_summary(gw),
            "creator_display_name": ep.get("creator_display_name"),
            "creator_kind": ep.get("creator_kind"),
        }
        if problem in LEGACY_PROBLEM_TYPES:
            attributes["platform_status"] = "legacy"
        display = tile.get("name") or name
        self.changed(up.upsert_asset(cur, {
            "asset_id": aid, "asset_type": "agent", "subtype": subtype_of(ep), "name": name, "display_name": display,
            "source": "databricks", "platform": "agent_bricks" if tem.get("tile_id") else "model_serving",
            "publisher": None, "parent_asset_id": None, "runtime_status": runtime_of(ep),
            "external_ref": {"endpoint_name": name, "endpoint_id": ep.get("id"), "tile_id": tem.get("tile_id")},
            "attributes": {k: v for k, v in attributes.items() if v not in (None, {}, [])},
            "deep_link": f"{ctx.host}/ml/endpoints/{name}", "sync_source": NAME, "created_by": owner_id(ep.get("creator")),
            "source_created_at": ms_to_dt(ep.get("creation_timestamp")),
            "source_updated_at": ms_to_dt(ep.get("last_updated_timestamp")),
        }, keep_attributes=("agent_bricks",)))

        fields = {
            "endpoint_url": (f"{ctx.host}/serving-endpoints/{name}/invocations", "Serving endpoint"),
            "auth_model": ("Databricks OAuth or personal access token with CAN_QUERY on the endpoint", "Serving endpoint ACL model"),
        }
        if not tem.get("tile_id"):  # Agent Bricks descriptions are owned by the agent_bricks collector
            fields["purpose"] = (purpose_from(ep.get("description")), "Serving endpoint description")
            fields["description"] = (ep.get("description"), "Serving endpoint description")
        self.changed(up.upsert_fields(cur, aid, fields))
        if ep.get("creator"):
            self.changed(up.sync_owners(cur, aid, [owner_id(ep["creator"])], collector=NAME))
        if tags.get("MONITOR_EXPERIMENT_ID"):
            self.changed(up.link_experiment(cur, aid, tags["MONITOR_EXPERIMENT_ID"], "endpoint_tag"))

        for p in policies:
            self.changed(up.upsert_policy(cur, p))
            self.changed(up.bind_policy(cur, p["policy_id"], aid))
        self.changed(up.prune_policies(cur, f"gw:{name}:", [p["policy_id"] for p in policies]))

        if acl is not None:
            self.changed(up.sync_grants(cur, aid, acl_rows(acl), seen_at=self.seen_at))

        for entity in entities:
            node = model_node(entity)
            if node:
                self.changed(up.edge(cur, aid, node, "uses_model", "declared", "served_entity",
                                     attributes={"type": entity.get("type"), "version": entity.get("entity_version")}))
            key = (entity.get("entity_name"), str(entity.get("entity_version")))
            for relation, dst, attrs in dependency_edges(deps.get(key, []), agent_names):
                self.changed(up.edge(cur, aid, dst, relation, "declared", "uc_model_dependencies",
                                     attributes={**attrs, "model": key[0], "version": key[1]}))
        for source in ("served_entity", "uc_model_dependencies"):
            self.changed(up.prune_edges(cur, source=source, seen_at=self.seen_at, src_ids=[aid]))

        snapshot = {
            "served_entities": [{"name": e.get("name"), "type": e.get("type"), "entity_name": e.get("entity_name"),
                                 "entity_version": e.get("entity_version"), "family": e.get("family"),
                                 "external_model": e.get("external_model")} for e in entities],
            "task": ep.get("task"),
            "policies": sorted(f"{p['policy_id']}#{short_hash(p['config'])}" for p in policies),
            "endpoint_url": f"/serving-endpoints/{name}/invocations",
            "auth": "databricks",
        }
        if not tem.get("tile_id"):
            snapshot["description_hash"] = short_hash(ep.get("description"))
        change = versioning.record_snapshot(cur, aid, snapshot, section="endpoint",
                                            source_version=(ep.get("config") or {}).get("config_version"))
        if change:
            self.count("change_events")
