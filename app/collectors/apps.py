"""Databricks Apps: who consumes which registry asset, which app hosts which custom MCP server, and the
code-first agents that run on Agent Runtime.

Source: ``GET /api/2.0/apps`` (paginated).
* Every app's ``resources[]`` -> observed ``consumes`` edges ``app:<name>`` -> serving-endpoint agent
  (``agent:endpoint:<n>``), Genie (``agent:genie:<id>``), UC function (``tool:uc:<fqn>``) or UC connection
  (``mcp:connection:<name>``), only when that asset is registered. Plain apps are lineage nodes, not assets.
* Custom MCP connections whose host is an app URL get a ``hosts`` edge ``app:<name>`` -> ``mcp:connection:<c>``.
* Apps named ``agent-bricks-*`` are Agent Runtime agents and become ``agent:app:<app_name>`` assets
  (subtype ``agent_runtime_app``), with owner, grants (app ACL), experiments and declared dependencies.
"""
from __future__ import annotations

from collectors import upserts as up
from collectors.base import Collector
from collectors.util import acl_rows, clean_text, host_of, iso_to_dt, owner_id, purpose_from, short_hash
from registry import versioning

NAME = "apps"
AGENT_PREFIX = "agent-bricks-"
RELATIONS = (("agent:endpoint:", "calls_agent"), ("agent:genie:", "calls_agent"), ("tool:uc:", "uses_tool"),
             ("mcp:connection:", "uses_mcp"))


def resource_kind(res: dict) -> str | None:
    for k in res:
        if k not in ("name", "description") and isinstance(res.get(k), dict):
            return k
    return None


def resource_target(res: dict) -> tuple[str, str | None]:
    """(kind, registry node or None) for one app resource."""
    kind = resource_kind(res) or "unknown"
    ref = res.get(kind) or {}
    if kind == "serving_endpoint" and ref.get("name"):
        return kind, f"agent:endpoint:{ref['name']}"
    if kind == "genie_space" and ref.get("space_id"):
        return kind, f"agent:genie:{ref['space_id']}"
    if kind == "uc_securable":
        st = str(ref.get("securable_type") or "").upper()
        fqn = ref.get("securable_full_name")
        if st == "FUNCTION" and fqn:
            return kind, f"tool:uc:{fqn}"
        if st == "CONNECTION" and fqn:
            return kind, f"mcp:connection:{fqn}"
    return kind, None


def resource_summary(res: dict) -> dict:
    kind = resource_kind(res) or "unknown"
    ref = res.get(kind) or {}
    keep = {k: v for k, v in ref.items() if k in ("name", "space_id", "securable_full_name", "securable_type",
                                                   "securable_kind", "experiment_id", "id", "permission", "branch",
                                                   "instance_name", "database_name", "scope", "key")}
    return {"name": res.get("name"), "kind": kind, **keep}


def runtime_of(app: dict) -> str:
    return {"ACTIVE": "running", "STOPPED": "stopped", "ERROR": "degraded"}.get(
        (app.get("compute_status") or {}).get("state") or "", "unknown")


class AppsCollector(Collector):
    name = NAME
    label = "Databricks Apps (consumers, MCP hosting, Agent Runtime agents)"

    def collect(self) -> None:
        ctx = self.ctx
        apps = [a for a in ctx.paginate("/api/2.0/apps", "apps") if a.get("name")]
        agent_apps = [a for a in apps if a["name"].startswith(AGENT_PREFIX)]
        self.items_seen = len(apps)
        self.detail.update(apps=len(apps), agent_runtime_apps=len(agent_apps))
        acls = {}
        for a, res, err in ctx.pmap(lambda a: ctx.api("GET", f"/api/2.0/permissions/apps/{a['name']}"), agent_apps):
            if err:
                self.soft_fail("acl", f"ACL {a['name']}", err)
            else:
                acls[a["name"]] = res

        with self.transaction() as cur:
            targets = [t for a in apps for t in (resource_target(r)[1] for r in a.get("resources") or []) if t]
            registered = up.asset_ids(cur, targets)
            conns = up.existing_assets(cur, "mcp:connection:")
            by_host: dict[str, list[str]] = {}
            for cid, c in conns.items():
                host = (c.get("attributes") or {}).get("host")
                if host:
                    by_host.setdefault(host, []).append(cid)
            seen_agents, sources = [], []
            for app in apps:
                name = app["name"]
                with self.item(cur, f"app:{name}"):
                    if name.startswith(AGENT_PREFIX):
                        aid = f"agent:app:{name}"
                        self._agent_app(cur, aid, app, acls.get(name), registered)
                        seen_agents.append(aid)
                        sources.append(aid)
                    else:
                        src = f"app:{name}"
                        sources.append(src)
                        for res in app.get("resources") or []:
                            kind, target = resource_target(res)
                            if target and target in registered:
                                self.changed(up.edge(cur, src, target, "consumes", "observed", "app_resources",
                                                     attributes={"resource": res.get("name"), "kind": kind,
                                                                 "permission": (res.get(kind) or {}).get("permission")}))
                    for cid in by_host.get(host_of(app.get("url")), []):
                        self.changed(up.edge(cur, f"app:{name}", cid, "hosts", "declared", "app_hosting",
                                             attributes={"host": host_of(app.get("url")), "derived_from": "app_url"}))
                        self.changed(up.merge_attributes(cur, cid, "hosting_app_status", {
                            "app": name, "compute_state": (app.get("compute_status") or {}).get("state"),
                            "url": app.get("url")}))
                        self.count("hosting_links")
            self.changed(up.prune_edges(cur, source="app_resources", seen_at=self.seen_at, src_ids=sources))
            self.count("marked_missing", up.mark_missing(cur, sync_source=NAME, seen_ids=seen_agents))

    def _agent_app(self, cur, aid: str, app: dict, acl: dict | None, registered: set[str]) -> None:
        name = app["name"]
        resources = sorted((resource_summary(r) for r in app.get("resources") or []), key=lambda r: (r["kind"], r["name"] or ""))
        deployment = app.get("active_deployment") or {}
        self.changed(up.upsert_asset(cur, {
            "asset_id": aid, "asset_type": "agent", "subtype": "agent_runtime_app", "name": name,
            "display_name": name.removeprefix(AGENT_PREFIX) or name, "source": "databricks", "platform": "databricks_apps",
            "publisher": None, "parent_asset_id": None, "runtime_status": runtime_of(app),
            "external_ref": {"app_name": name, "app_id": app.get("id"), "url": app.get("url"),
                             "service_principal_client_id": app.get("service_principal_client_id")},
            "attributes": {k: v for k, v in {
                "url": app.get("url"), "compute_status": app.get("compute_status"), "compute_size": app.get("compute_size"),
                "service_principal_client_id": app.get("service_principal_client_id"),
                "service_principal_name": app.get("service_principal_name"), "resources": resources or None,
                "active_deployment": {"deployment_id": deployment.get("deployment_id"),
                                      "state": (deployment.get("status") or {}).get("state"),
                                      "create_time": deployment.get("create_time")} if deployment else None,
                "effective_usage_policy_id": app.get("effective_usage_policy_id"),
                "invocations_path": "/api/invocations",
            }.items() if v is not None},
            "deep_link": app.get("url"), "sync_source": NAME, "created_by": owner_id(app.get("creator")),
            "source_created_at": iso_to_dt(app.get("create_time")), "source_updated_at": iso_to_dt(app.get("update_time")),
        }))
        self.changed(up.upsert_fields(cur, aid, {
            "purpose": (purpose_from(app.get("description")), "Databricks App description"),
            "description": (clean_text(app.get("description")), "Databricks App description"),
            "endpoint_url": (f"{app['url']}/api/invocations" if app.get("url") else None, "Agent Runtime (Databricks App)"),
            "auth_model": ("Databricks OAuth token (no personal access tokens) with CAN_USE on the app",
                           "Agent Runtime (Databricks App)"),
        }))
        self.changed(up.sync_owners(cur, aid, [owner_id(app.get("creator"))], collector=NAME))
        if acl is not None:
            self.changed(up.sync_grants(cur, aid, acl_rows(acl), seen_at=self.seen_at))
        for res in app.get("resources") or []:
            kind, target = resource_target(res)
            ref = res.get(kind) or {}
            if kind == "experiment" and ref.get("experiment_id"):
                self.changed(up.link_experiment(cur, aid, ref["experiment_id"], "app_resource"))
            if not target:
                continue
            relation = next(rel for prefix, rel in RELATIONS if target.startswith(prefix))
            if relation == "calls_agent" and target.startswith("agent:endpoint:") and target not in registered:
                relation, target = "uses_model", f"model:{ref.get('name')}"
            self.changed(up.edge(cur, aid, target, relation, "declared", "app_resources",
                                 attributes={"resource": res.get("name"), "permission": ref.get("permission")}))
        if versioning.record_snapshot(cur, aid, {
            "resources": [f"{r['kind']}:{r.get('name')}" for r in resources],
            "endpoint_url": f"{app.get('url')}/api/invocations", "auth": "oauth",
            "revision": deployment.get("deployment_id") or app.get("last_deployment_id"),
            "description_hash": short_hash(clean_text(app.get("description"))),
        }):
            self.count("change_events")
