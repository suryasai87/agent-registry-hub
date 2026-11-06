"""Publish the hub's lineage to Unity Catalog external lineage: a plan (dry run) first, then an audited publish.

Mapping (docs/research/01 §Q8, ``/api/2.0/lineage-tracking/external-metadata`` and ``/external-lineage``):
* each published asset is one EXTERNAL METADATA object named ``agent_registry_hub__<slug>__<hash>`` (the hash covers
  this install's ``hub_instance_id`` and the URN), ``system_type`` DATABRICKS for Databricks-native assets else OTHER,
  ``entity_type`` Agent / MCP server / Tool / Skill, ``url`` = the asset's hub page, and ``properties`` with
  ``created_by=agent-registry-hub``, ``hub_instance``, ``asset_id``, type, owners, lifecycle and certification;
* ``reads_data`` / ``writes_data`` edges to ``table:<catalog.schema.table>`` become table ↔ external metadata
  relationships (reads: table → asset, writes: asset → table); dependency edges between two assets become
  external metadata → external metadata relationships from the dependency to the dependent (uses_tool: tool → agent).
  People, service principals, volumes, indexes, apps and models (no version) stay in the hub.

``plan()`` diffs that desired state against what the hub recorded publishing (``uc_lineage_object`` /
``uc_lineage_relationship``) and lists create / update / delete operations with the exact requests, plus a digest.
``publish()`` applies the plan an admin previewed (same digest, else 409) and writes ONE audit row per run.

Ownership safety: the hub only updates or deletes objects in its own tracking tables, and re-reads each UC object
first: ``properties.created_by``, ``hub_instance`` and ``asset_id`` must match. A name taken by an object the hub did
not create is a reported conflict, never modified. Relationships are deleted only by the id the hub recorded when it
created them (or adopted one it can prove it created).

Modes (``registry.provision.mode``): ``platform`` calls the APIs (as the approver when an OBO token is forwarded, else
the app service principal; the sync job step uses the job's identity); ``record_only`` (local runs and tests) records
the exact requests and calls nothing.

Readiness (the privileges each of those identities needs, with the grant SQL) is ``registry/uc_readiness.py``.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from typing import Any
from urllib.parse import quote

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Conflict
from registry import authz, cards, graph, provision, settings

log = logging.getLogger("registry.uc_lineage")

HUB = "agent-registry-hub"
NAME_PREFIX = "agent_registry_hub__"
EM_PATH = "/api/2.0/lineage-tracking/external-metadata"
EL_PATH = "/api/2.0/lineage-tracking/external-lineage"
ENTITY_TYPE = {"agent": "Agent", "mcp_server": "MCP server", "tool": "Tool", "skill": "Skill"}
PUBLISHABLE_LIFECYCLE = ("approved", "deprecated")
DATA_RELATIONS = ("reads_data", "writes_data")
ASSET_RELATIONS = tuple(r for r in graph.DEPENDENCY_RELATIONS if r not in ("consumes", "subscribes"))
TABLE_NAME = re.compile(r"^[^.\s`]+\.[^.\s`]+\.[^.\s`]+$")
OBJECT_UPDATE_MASK = "description,url,properties"
MAX_OPS = 1000          # per run; the rest stays in the next plan
MAX_SHOWN = 300         # ops listed in the preview (the counts are always complete)
SKIP_SAMPLE = 5


def tables_exist(cur) -> bool:
    cur.execute("SELECT to_regclass('uc_lineage_object') IS NOT NULL AS ok")
    return bool(cur.fetchone()["ok"])


def metadata_name(instance: str, asset_id: str) -> str:
    """Deterministic, path-safe (letters, digits, underscores) and unique per install + URN."""
    slug = re.sub(r"[^a-z0-9]+", "_", asset_id.lower()).strip("_")[:80].strip("_")
    digest = hashlib.sha256(f"{instance}|{asset_id}".encode()).hexdigest()[:12]
    return f"{NAME_PREFIX}{slug}__{digest}"


def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def ref_key(ref: dict) -> str:
    if "table" in ref:
        return f"table:{ref['table']['name']}"
    return f"em:{ref['external_metadata']['name']}"


def _skip(skipped: dict, reason: str, sample: str) -> None:
    s = skipped.setdefault(reason, {"reason": reason, "count": 0, "sample": []})
    s["count"] += 1
    if len(s["sample"]) < SKIP_SAMPLE:
        s["sample"].append(sample)


# ====================================================================== desired state
def desired(cur, *, instance: str, app_url: str | None = None) -> tuple[dict, dict, list[dict]]:
    """(objects by asset_id, relationships by edge key, skipped edge groups) for the current registry."""
    cur.execute("SELECT src_id, dst_id, relation, edge_kind, source FROM lineage_edge ORDER BY src_id, dst_id, relation")
    edges = list(cur.fetchall())
    ids = sorted({e["src_id"] for e in edges} | {e["dst_id"] for e in edges})
    cur.execute(f"""SELECT a.asset_id, a.asset_type, a.subtype, a.display_name, a.source, a.platform, a.lifecycle_status,
                           a.certification, a.deep_link, {cards.PURPOSE_SQL} AS purpose
                      FROM asset a WHERE a.asset_id = ANY(%s)""", (ids,))
    assets = {a["asset_id"]: a for a in cur.fetchall()}
    cur.execute("SELECT asset_id, string_agg(email, ',' ORDER BY email) AS owners FROM asset_owner WHERE asset_id = ANY(%s) AND kind IN ('owner','co_owner') GROUP BY asset_id",
                (ids,))
    owners = {r["asset_id"]: r["owners"] for r in cur.fetchall()}

    skipped: dict[str, dict] = {}
    rels: dict[str, dict] = {}
    used: set[str] = set()

    def em(aid: str) -> dict:
        return {"external_metadata": {"name": metadata_name(instance, aid)}}

    def publishable(aid: str, edge: str) -> bool:
        a = assets.get(aid)
        if not a:
            _skip(skipped, "Edge to an asset that is not registered", edge)
            return False
        if a["lifecycle_status"] not in PUBLISHABLE_LIFECYCLE:
            _skip(skipped, "Asset not approved (discovered, pending, rejected or retired)", edge)
            return False
        return True

    for e in edges:
        label = f"{e['src_id']} {e['relation']} {e['dst_id']}"
        if e["relation"] not in DATA_RELATIONS + ASSET_RELATIONS:
            kind = graph.node_type(e["src_id"])
            _skip(skipped, "People stay in the hub (consumer privacy)" if kind == "user" else
                  "Service principals stay in the hub" if kind == "service_principal" else f"Relation {e['relation']} is not published", label)
            continue
        if e["relation"] in DATA_RELATIONS:
            if not graph.is_asset(e["src_id"]):
                _skip(skipped, "Data edge from a node that is not an asset", label)
                continue
            if not e["dst_id"].startswith("table:"):
                _skip(skipped, f"Data edge to a {graph.node_type(e['dst_id'])} (only UC tables are published)", label)
                continue
            table = e["dst_id"].split(":", 1)[1]
            if not TABLE_NAME.match(table):
                _skip(skipped, "Table name is not catalog.schema.table", label)
                continue
            if not publishable(e["src_id"], label):
                continue
            t = {"table": {"name": table}}
            source, target = (t, em(e["src_id"])) if e["relation"] == "reads_data" else (em(e["src_id"]), t)
            used.add(e["src_id"])
        else:
            kinds = (graph.node_type(e["src_id"]), graph.node_type(e["dst_id"]))
            if not (graph.is_asset(e["src_id"]) and graph.is_asset(e["dst_id"])):
                other = kinds[0] if not graph.is_asset(e["src_id"]) else kinds[1]
                reason = {"user": "People stay in the hub (consumer privacy)", "service_principal": "Service principals stay in the hub",
                          "model": "Model nodes need a model version", "app": "App hosting edges stay in the hub"}.get(
                    other, f"Edge to a {other} node (not published)")
                _skip(skipped, reason, label)
                continue
            if e["src_id"] == e["dst_id"] or not (publishable(e["src_id"], label) and publishable(e["dst_id"], label)):
                continue
            # src depends on dst: lineage flows from the dependency (dst) to the dependent (src).
            source, target = em(e["dst_id"]), em(e["src_id"])
            used.update((e["src_id"], e["dst_id"]))
        key = f"{ref_key(source)}>{ref_key(target)}"
        r = rels.setdefault(key, {"key": key, "source": source, "target": target, "hub_edges": []})
        r["hub_edges"].append({k: e[k] for k in ("src_id", "dst_id", "relation", "edge_kind", "source")})

    for r in rels.values():
        r["properties"] = {
            "created_by": HUB, "hub_instance": instance,
            "relations": ",".join(sorted({h["relation"] for h in r["hub_edges"]})),
            "edge_kinds": ",".join(sorted({h["edge_kind"] for h in r["hub_edges"]})),
            "edge_sources": ",".join(sorted({h["source"] for h in r["hub_edges"]}))[:500],
        }
        r["content_hash"] = _hash({"source": r["source"], "target": r["target"], "properties": r["properties"]})

    objects: dict[str, dict] = {}
    for aid in sorted(used):
        a = assets[aid]
        url = f"{app_url.rstrip('/')}/assets/{quote(aid, safe='')}" if app_url else a["deep_link"]
        body = {
            "name": metadata_name(instance, aid),
            "system_type": "DATABRICKS" if a["source"] == "databricks" else "OTHER",
            "entity_type": ENTITY_TYPE.get(a["asset_type"], a["asset_type"]),
            "description": (a["purpose"] or f"{a['display_name']} (registered in Agent Registry Hub)")[:1000],
            "properties": {k: str(v)[:500] for k, v in {
                "created_by": HUB, "hub_instance": instance, "asset_id": aid, "display_name": a["display_name"],
                "asset_type": a["asset_type"], "subtype": a["subtype"], "platform": a["platform"],
                "lifecycle_status": a["lifecycle_status"], "certification": a["certification"], "owners": owners.get(aid),
            }.items() if v},
        }
        if url:
            body["url"] = url
        objects[aid] = {"asset_id": aid, "label": a["display_name"], "body": body, "content_hash": _hash(body)}
    return objects, rels, sorted(skipped.values(), key=lambda s: -s["count"])


# ====================================================================== plan
def hub_url(cur, app_url: str | None = None) -> str | None:
    """The hub URL objects link to: the request's (app), else the one the last app publish used (the job), else APP_URL."""
    return (app_url or settings.get(cur, "hub_app_url", "") or os.environ.get("APP_URL", "") or "").rstrip("/") or None


def _exists(row: dict, mode: str) -> bool:
    """Whether a tracked row stands for an object that exists in the current mode's world."""
    if row["status"] == "removed":
        return False
    has_id = bool(row.get("metadata_id") or row.get("relationship_id"))
    return has_id if mode == "platform" else (has_id or row["mode"] == "record_only")


def _object_request(op: str, obj_name: str, body: dict | None) -> dict:
    if op == "create":
        return {"method": "POST", "path": EM_PATH, "body": body}
    if op == "update":
        return {"method": "PATCH", "path": f"{EM_PATH}/{obj_name}", "query": {"update_mask": OBJECT_UPDATE_MASK}, "body": body}
    return {"method": "DELETE", "path": f"{EM_PATH}/{obj_name}"}


def _rel_request(op: str, rel: dict, rel_id: str | None) -> dict:
    ident = {"source": rel["source"], "target": rel["target"]}
    if op == "create":
        return {"method": "POST", "path": EL_PATH, "body": {**ident, "properties": rel["properties"]}}
    if op == "update":
        return {"method": "PATCH", "path": EL_PATH, "query": {"update_mask": "properties"},
                "body": {**({"id": rel_id} if rel_id else {}), **ident, "properties": rel["properties"]}}
    return {"method": "DELETE", "path": EL_PATH, "query": {"external_lineage_relationship": {**({"id": rel_id} if rel_id else {}), **ident}}}


def plan(cur, *, app_url: str | None = None, mode: str | None = None) -> dict:
    """The diff to apply now. Read-only. ``ops`` are ordered: relationship removals, object removals, object
    creates/updates, relationship creates/updates."""
    mode = mode or provision.mode()
    instance = settings.instance_id(cur)
    app_url = hub_url(cur, app_url)
    objects, rels, skipped = desired(cur, instance=instance, app_url=app_url)
    cur.execute("SELECT * FROM uc_lineage_object WHERE status <> 'removed'")
    t_objs = {r["asset_id"]: r for r in cur.fetchall()}
    cur.execute("SELECT * FROM uc_lineage_relationship WHERE status <> 'removed'")
    t_rels = {r["edge_key"]: r for r in cur.fetchall()}

    rel_drop, obj_drop, obj_put, rel_put = [], [], [], []
    counts = {k: {"create": 0, "update": 0, "delete": 0, "forget": 0, "unchanged": 0} for k in ("objects", "relationships")}

    for key, row in sorted(t_rels.items()):
        if key in rels:
            continue
        rel = {"source": row["source_ref"], "target": row["target_ref"]}
        op = "delete" if _exists(row, mode) else "forget"
        rel_drop.append({"op": op, "kind": "external_lineage", "key": key, "label": key, "content_hash": row["content_hash"],
                         "detail": "No longer in the hub's lineage" if op == "delete" else "Only recorded, never created in Unity Catalog: drop the record",
                         "request": _rel_request("delete", rel, row["relationship_id"]) if op == "delete" else None,
                         "_row": row})
        counts["relationships"][op] += 1
    for aid, row in sorted(t_objs.items()):
        if aid in objects:
            continue
        op = "delete" if _exists(row, mode) else "forget"
        obj_drop.append({"op": op, "kind": "external_metadata", "key": row["metadata_name"], "asset_id": aid, "label": aid,
                         "content_hash": row["content_hash"],
                         "detail": "Asset no longer has publishable lineage (or is not approved)" if op == "delete" else "Only recorded, never created in Unity Catalog: drop the record",
                         "request": _object_request("delete", row["metadata_name"], None) if op == "delete" else None, "_row": row})
        counts["objects"][op] += 1
    for aid, obj in objects.items():
        row = t_objs.get(aid)
        name = obj["body"]["name"]
        if row and _exists(row, mode):
            if row["content_hash"] == obj["content_hash"] and row["status"] == "published":
                counts["objects"]["unchanged"] += 1
                continue
            op, detail = "update", "Description, URL or properties changed" if row["status"] == "published" else f"Retry: {row['last_error'] or 'last attempt failed'}"
        else:
            op, detail = "create", "New in the hub's lineage" if not row else f"Retry: {row['last_error'] or 'not created yet'}"
        obj_put.append({"op": op, "kind": "external_metadata", "key": name, "asset_id": aid, "label": obj["label"], "detail": detail,
                        "content_hash": obj["content_hash"], "request": _object_request(op, name, obj["body"]), "_obj": obj, "_row": row})
        counts["objects"][op] += 1
    for key, rel in rels.items():
        row = t_rels.get(key)
        if row and _exists(row, mode):
            if row["content_hash"] == rel["content_hash"] and row["status"] == "published":
                counts["relationships"]["unchanged"] += 1
                continue
            op = "update"
        else:
            op = "create"
        rel_put.append({"op": op, "kind": "external_lineage", "key": key, "label": key,
                        "detail": f"{rel['properties']['relations']} ({rel['properties']['edge_kinds']})", "content_hash": rel["content_hash"],
                        "request": _rel_request(op, rel, (row or {}).get("relationship_id")), "_rel": rel, "_row": row})
        counts["relationships"][op] += 1

    ops = rel_drop + obj_drop + obj_put + rel_put
    digest = hashlib.sha256(json.dumps([[o["op"], o["kind"], o["key"], o["content_hash"]] for o in ops]).encode()).hexdigest()[:24]
    tables = sorted({r["source"]["table"]["name"] for r in rels.values() if "table" in r["source"]} |
                    {r["target"]["table"]["name"] for r in rels.values() if "table" in r["target"]})
    return {
        "mode": mode, "digest": digest, "instance": instance, "total_ops": len(ops), "truncated": len(ops) > MAX_SHOWN,
        "objects": counts["objects"], "relationships": counts["relationships"],
        "desired": {"objects": len(objects), "relationships": len(rels)},
        "ops": ops, "skipped": skipped, "tables": tables,
        "requirements": [
            "CREATE EXTERNAL METADATA on the metastore for the publishing identity",
            f"MODIFY on each of the {len(tables)} UC table(s) the relationships touch" if tables else "No UC tables are involved",
            "Objects get BROWSE for all account users on creation (Unity Catalog default)",
        ],
    }


def public_plan(pl: dict) -> dict:
    """The plan without internal payloads, ops capped for the UI."""
    return {**pl, "ops": [{k: v for k, v in o.items() if not k.startswith("_")} for o in pl["ops"][:MAX_SHOWN]]}


# ====================================================================== apply
def _client(user_token: str | None):
    return provision._client(user_token)


def _status_code(err: BaseException) -> int | None:
    from databricks.sdk.errors import platform

    for code, cls in platform.STATUS_CODE_MAPPING.items():
        if isinstance(err, cls):
            return code
    value = getattr(err, "status_code", None)
    return value if isinstance(value, int) else None


def _already_exists(err: BaseException) -> bool:
    return _status_code(err) == 409 or "ALREADY_EXISTS" in str(getattr(err, "error_code", "") or err).upper()


def _not_found(err: BaseException) -> bool:
    return _status_code(err) == 404 or "NOT_FOUND" in str(getattr(err, "error_code", "") or "").upper() or \
        "DOES_NOT_EXIST" in str(getattr(err, "error_code", "") or "").upper()


def _ours(obj: dict | None, instance: str, asset_id: str) -> bool:
    props = (obj or {}).get("properties") or {}
    return props.get("created_by") == HUB and props.get("hub_instance") == instance and props.get("asset_id") == asset_id


def _get_object(w, name: str) -> dict | None:
    try:
        return w.api_client.do("GET", f"{EM_PATH}/{name}") or {}
    except Exception as e:  # noqa: BLE001 - 404 means it is gone; anything else propagates to the op's error
        if _not_found(e):
            return None
        raise


def _find_relationship(w, rel: dict, instance: str) -> str | None:
    """The id of a relationship the hub created between rel.source and rel.target (UPSTREAM listing of the target)."""
    res = w.api_client.do("GET", EL_PATH, query={"object_info": rel["target"], "lineage_direction": "UPSTREAM", "page_size": 1000}) or {}
    for item in res.get("external_lineage_relationships") or []:
        info = item.get("external_lineage_info") or {}
        props = info.get("properties") or {}
        if props.get("created_by") != HUB or props.get("hub_instance") != instance:
            continue
        src = rel["source"]
        if "external_metadata" in src and (item.get("external_metadata_info") or {}).get("name") == src["external_metadata"]["name"]:
            return info.get("id")
        t = item.get("table_info") or {}
        if "table" in src and ".".join(filter(None, [t.get("catalog_name"), t.get("schema_name"), t.get("name")])) == src["table"]["name"]:
            return info.get("id")
    return None


def _save_object(cur, obj_row: dict, *, run_id: int, mode: str, status: str, metadata_id: str | None = None,
                 error: str | None = None, keep_id: bool = True) -> None:
    cur.execute(
        """INSERT INTO uc_lineage_object (asset_id, metadata_name, metadata_id, system_type, entity_type, content_hash, mode, status,
                                          last_error, last_run_id)
           VALUES (%(asset_id)s, %(name)s, %(mid)s, %(st)s, %(et)s, %(hash)s, %(mode)s, %(status)s, %(err)s, %(run)s)
           ON CONFLICT (asset_id) DO UPDATE SET metadata_name = EXCLUDED.metadata_name,
                  metadata_id = CASE WHEN %(keep)s THEN coalesce(EXCLUDED.metadata_id, uc_lineage_object.metadata_id) ELSE EXCLUDED.metadata_id END,
                  system_type = EXCLUDED.system_type, entity_type = EXCLUDED.entity_type, content_hash = EXCLUDED.content_hash,
                  mode = EXCLUDED.mode, status = EXCLUDED.status, last_error = EXCLUDED.last_error, last_run_id = EXCLUDED.last_run_id,
                  updated_at = now()""",
        {**obj_row, "mid": metadata_id, "mode": mode, "status": status, "err": error, "run": run_id, "keep": keep_id},
    )


def _save_rel(cur, rel: dict, *, run_id: int, mode: str, status: str, rel_id: str | None = None, error: str | None = None,
              keep_id: bool = True) -> None:
    cur.execute(
        """INSERT INTO uc_lineage_relationship (edge_key, source_ref, target_ref, hub_edges, relationship_id, content_hash, mode, status,
                                                last_error, last_run_id)
           VALUES (%(key)s, %(src)s, %(dst)s, %(edges)s, %(rid)s, %(hash)s, %(mode)s, %(status)s, %(err)s, %(run)s)
           ON CONFLICT (edge_key) DO UPDATE SET source_ref = EXCLUDED.source_ref, target_ref = EXCLUDED.target_ref, hub_edges = EXCLUDED.hub_edges,
                  relationship_id = CASE WHEN %(keep)s THEN coalesce(EXCLUDED.relationship_id, uc_lineage_relationship.relationship_id)
                                         ELSE EXCLUDED.relationship_id END,
                  content_hash = EXCLUDED.content_hash, mode = EXCLUDED.mode, status = EXCLUDED.status, last_error = EXCLUDED.last_error,
                  last_run_id = EXCLUDED.last_run_id, updated_at = now()""",
        {"key": rel["key"], "src": Jsonb(rel["source"]), "dst": Jsonb(rel["target"]), "edges": Jsonb(rel.get("hub_edges") or []),
         "rid": rel_id, "hash": rel["content_hash"], "mode": mode, "status": status, "err": error, "run": run_id, "keep": keep_id},
    )


def _mark_removed(cur, op: dict, *, run_id: int, error: str | None = None) -> None:
    table, col = ("uc_lineage_object", "asset_id") if op["kind"] == "external_metadata" else ("uc_lineage_relationship", "edge_key")
    ident = op["asset_id"] if op["kind"] == "external_metadata" else op["key"]
    cur.execute(f"UPDATE {table} SET status = 'removed', last_error = %s, last_run_id = %s, updated_at = now() WHERE {col} = %s",
                (error, run_id, ident))


def _obj_row(obj: dict) -> dict:
    b = obj["body"]
    return {"asset_id": obj["asset_id"], "name": b["name"], "st": b["system_type"], "et": b["entity_type"], "hash": obj["content_hash"]}


def _apply_platform(cur, w, op: dict, *, run_id: int, instance: str) -> str:
    """One operation against Unity Catalog. Returns the outcome label; raises on failure (recorded by the caller)."""
    kind, what = op["kind"], op["op"]
    if kind == "external_metadata":
        name, aid = op["key"], op["asset_id"]
        if what == "forget":
            _mark_removed(cur, op, run_id=run_id)
            return "forgotten"
        if what == "delete":
            existing = _get_object(w, name)
            if existing is None:
                _mark_removed(cur, op, run_id=run_id, error="already gone from Unity Catalog")
                return "already_gone"
            if not _ours(existing, instance, aid):
                _mark_removed(cur, op, run_id=run_id, error="left untouched: the object is not one the hub created")
                return "skipped_not_ours"
            w.api_client.do("DELETE", f"{EM_PATH}/{name}")
            _mark_removed(cur, op, run_id=run_id)
            return "deleted"
        obj = op["_obj"]
        if what == "update":
            existing = _get_object(w, name)
            if existing is not None and not _ours(existing, instance, aid):
                raise Conflict("the UC object with this name was not created by the hub: left untouched")
            if existing is not None:
                res = w.api_client.do("PATCH", f"{EM_PATH}/{name}", query={"update_mask": OBJECT_UPDATE_MASK}, body=obj["body"]) or {}
                _save_object(cur, _obj_row(obj), run_id=run_id, mode="platform", status="published", metadata_id=res.get("id") or existing.get("id"))
                return "updated"
        try:
            res = w.api_client.do("POST", EM_PATH, body=obj["body"]) or {}
            _save_object(cur, _obj_row(obj), run_id=run_id, mode="platform", status="published", metadata_id=res.get("id"))
            return "created"
        except Exception as e:  # noqa: BLE001 - a name collision may be our own object (tracking lost) or someone else's
            if not _already_exists(e):
                raise
            existing = _get_object(w, name)
            if not _ours(existing, instance, aid):
                raise Conflict("the name is taken by a Unity Catalog object the hub did not create: left untouched") from e
            res = w.api_client.do("PATCH", f"{EM_PATH}/{name}", query={"update_mask": OBJECT_UPDATE_MASK}, body=obj["body"]) or {}
            _save_object(cur, _obj_row(obj), run_id=run_id, mode="platform", status="published", metadata_id=res.get("id") or (existing or {}).get("id"))
            return "adopted"

    row = op.get("_row") or {}
    if what == "forget":
        _mark_removed(cur, op, run_id=run_id)
        return "forgotten"
    if what == "delete":
        try:
            w.api_client.do("DELETE", EL_PATH, query=op["request"]["query"])
        except Exception as e:  # noqa: BLE001
            if not _not_found(e):
                raise
        _mark_removed(cur, op, run_id=run_id)
        return "deleted"
    rel = op["_rel"]
    if what == "update" and row.get("relationship_id"):
        try:
            w.api_client.do("PATCH", EL_PATH, query={"update_mask": "properties"}, body=op["request"]["body"])
            _save_rel(cur, rel, run_id=run_id, mode="platform", status="published", rel_id=row["relationship_id"])
            return "updated"
        except Exception as e:  # noqa: BLE001 - deleted out of band: create it again below
            if not _not_found(e):
                raise
    body = {"source": rel["source"], "target": rel["target"], "properties": rel["properties"]}
    try:
        res = w.api_client.do("POST", EL_PATH, body=body) or {}
        _save_rel(cur, rel, run_id=run_id, mode="platform", status="published", rel_id=res.get("id"), keep_id=False)
        return "created"
    except Exception as e:  # noqa: BLE001
        if not _already_exists(e):
            raise
        rid = _find_relationship(w, rel, instance)
        if not rid:
            raise Conflict("a relationship between these objects exists but the hub did not create it: left untouched") from e
        w.api_client.do("PATCH", EL_PATH, query={"update_mask": "properties"}, body={"id": rid, **body})
        _save_rel(cur, rel, run_id=run_id, mode="platform", status="published", rel_id=rid, keep_id=False)
        return "adopted"


def _apply_recorded(cur, op: dict, *, run_id: int) -> str:
    row = op.get("_row") or {}
    if row.get("mode") == "platform" and (row.get("metadata_id") or row.get("relationship_id")):
        return "recorded"  # a real UC object: record_only never rewrites what platform mode published
    if op["op"] in ("delete", "forget"):
        _mark_removed(cur, op, run_id=run_id, error=None if op["op"] == "forget" else "recorded only (record_only mode)")
        return "recorded"
    if op["kind"] == "external_metadata":
        _save_object(cur, _obj_row(op["_obj"]), run_id=run_id, mode="record_only", status="published")
    else:
        _save_rel(cur, op["_rel"], run_id=run_id, mode="record_only", status="published")
    return "recorded"


def _record_failure(cur, op: dict, *, run_id: int, mode: str, error: str, foreign: bool) -> None:
    """``foreign``: the UC object is not one the hub created, so the row must stop claiming it (no id, never deleted)."""
    if op["op"] in ("delete", "forget"):
        table, col = ("uc_lineage_object", "asset_id") if op["kind"] == "external_metadata" else ("uc_lineage_relationship", "edge_key")
        ident = op["asset_id"] if op["kind"] == "external_metadata" else op["key"]
        cur.execute(f"UPDATE {table} SET last_error = %s, last_run_id = %s, updated_at = now() WHERE {col} = %s", (error, run_id, ident))
    elif op["kind"] == "external_metadata":
        _save_object(cur, _obj_row(op["_obj"]), run_id=run_id, mode=mode, status="failed", error=error,
                     keep_id=op["op"] == "update" and not foreign)
    else:
        _save_rel(cur, op["_rel"], run_id=run_id, mode=mode, status="failed", error=error)


def publish(cur, p: authz.Principal | None, *, digest: str | None = None, app_url: str | None = None,
            user_token: str | None = None, client: Any = None, acting_as: str | None = None, mode: str | None = None) -> dict:
    """Apply the current plan. ``p`` None = the sync job step (actor ``system:sync``). One audit row per run."""
    if p is not None:
        authz.require(p.is_admin, "Only an admin can publish lineage to Unity Catalog")
    if not tables_exist(cur):
        raise Conflict("Unity Catalog lineage publishing needs migration 007 (run the setup job)")
    mode = mode or provision.mode()
    pl = plan(cur, app_url=app_url, mode=mode)
    if digest and digest != pl["digest"]:
        raise Conflict("The plan changed since you previewed it. Review the new preview, then publish.")
    actor = p.email if p else "system:sync"
    if p is not None and app_url:
        settings.remember(cur, "hub_app_url", app_url.rstrip("/"), actor=actor)
    w = None
    if mode == "platform" and pl["ops"]:
        if client is not None:
            w, acting_as = client, acting_as or "sync job identity"
        else:
            w, acting_as = _client(user_token)
    cur.execute("""INSERT INTO uc_lineage_run (triggered_by, mode, acting_as, plan_digest) VALUES (%s, %s, %s, %s) RETURNING run_id""",
                (actor, mode, acting_as if mode == "platform" else None, pl["digest"]))
    run_id = cur.fetchone()["run_id"]
    results, errors, requests = [], [], []
    outcome_counts: dict[str, int] = {}
    for op in pl["ops"][:MAX_OPS]:
        try:
            with cur.connection.transaction():  # a savepoint: one failing op never loses the others' bookkeeping
                outcome = _apply_platform(cur, w, op, run_id=run_id, instance=pl["instance"]) if mode == "platform" else \
                    _apply_recorded(cur, op, run_id=run_id)
        except Exception as e:  # noqa: BLE001 - recorded per op; the run is 'partial'
            msg = " ".join(str(e).split())[:500] or type(e).__name__
            _record_failure(cur, op, run_id=run_id, mode=mode, error=msg, foreign=isinstance(e, Conflict))
            outcome = "failed"
            errors.append({"op": op["op"], "kind": op["kind"], "key": op["key"], "error": msg})
        outcome_counts[outcome] = outcome_counts.get(outcome, 0) + 1
        if op["request"] is not None and (mode == "record_only" or outcome == "failed"):
            requests.append({"op": op["op"], "kind": op["kind"], "key": op["key"], **op["request"]})
        results.append({"op": op["op"], "kind": op["kind"], "key": op["key"], "label": op["label"], "outcome": outcome})
    applied = sum(n for k, n in outcome_counts.items() if k != "failed")
    status = "nothing_to_do" if not results else "succeeded" if not errors else "partial" if applied else "failed"
    counts = {"objects": pl["objects"], "relationships": pl["relationships"], "outcomes": outcome_counts,
              "processed": len(results), "remaining": max(0, pl["total_ops"] - MAX_OPS)}
    cur.execute("""UPDATE uc_lineage_run SET status = %s, counts = %s, errors = %s, requests = %s, finished_at = now() WHERE run_id = %s""",
                (status, Jsonb(counts), Jsonb(errors[:200]), Jsonb(requests[:2000]), run_id))
    audit.audit_event(actor, "lineage.uc_publish", "uc_lineage", run_id, before={"plan_digest": pl["digest"]},
                      after={"mode": mode, "acting_as": acting_as if mode == "platform" else None, "status": status,
                             "outcomes": outcome_counts, "errors": len(errors)},
                      request_id=getattr(p, "request_id", None), cur=cur, source="job" if p is None else None)
    return {"run_id": run_id, "status": status, "mode": mode, "acting_as": acting_as if mode == "platform" else None,
            "plan_digest": pl["digest"], "counts": counts, "errors": errors, "requests": requests[:MAX_SHOWN], "results": results[:MAX_SHOWN]}


# ====================================================================== status + sync step
def runs(cur, limit: int = 10) -> list[dict]:
    cur.execute("""SELECT run_id, triggered_by, mode, acting_as, status, plan_digest, counts, errors, started_at, finished_at,
                          jsonb_array_length(requests) AS requests_recorded
                     FROM uc_lineage_run ORDER BY run_id DESC LIMIT %s""", (limit,))
    return list(cur.fetchall())


def status(cur, p: authz.Principal, *, app_url: str | None = None) -> dict:
    authz.require(p.can_read_everything, "Unity Catalog lineage publishing is for stewards, admins and auditors")
    if not tables_exist(cur):
        return {"available": False, "note": "Migration 007 is not applied yet: run the setup job.", "plan": None,
                "settings": {"publish_in_sync": False}, "runs": [], "tracked": {}, "can_publish": False}
    cur.execute("""SELECT 'objects' AS t, status, mode, count(*) AS n FROM uc_lineage_object GROUP BY status, mode
                   UNION ALL SELECT 'relationships', status, mode, count(*) FROM uc_lineage_relationship GROUP BY status, mode""")
    tracked: dict[str, dict] = {"objects": {}, "relationships": {}}
    for r in cur.fetchall():
        tracked[r["t"]][f"{r['status']}:{r['mode']}"] = int(r["n"])
    cur.execute("""SELECT asset_id AS key, metadata_name AS name, last_error, updated_at FROM uc_lineage_object WHERE status = 'failed'
                   UNION ALL SELECT edge_key, edge_key, last_error, updated_at FROM uc_lineage_relationship WHERE status = 'failed'
                   ORDER BY updated_at DESC LIMIT 50""")
    failed = list(cur.fetchall())
    return {"available": True, "plan": public_plan(plan(cur, app_url=app_url)),
            "settings": {"publish_in_sync": bool(settings.get(cur, "uc_lineage_publish_in_sync"))},
            "runs": runs(cur), "tracked": tracked, "failed": failed, "can_publish": p.is_admin}


def sync_step(client_factory: Any, *, triggered_by: str = "schedule") -> dict:
    """The sync job's optional publish step (setting ``uc_lineage_publish_in_sync``, default OFF). Never raises.
    ``client_factory()`` returns the sync's WorkspaceClient; it is only called when there is something to publish.

    In platform mode the step first checks readiness as the job's identity (``registry/uc_readiness.for_sync``):
    ``blocked`` or ``unknown`` skips the publish, logs the reason and records it (the ``uc_lineage_sync_readiness``
    status row, plus an audit row when the reason is new); ``ready`` or ``partial`` publishes as before."""
    from core import db
    from registry import uc_readiness

    try:
        with db.transaction() as cur:
            if not (tables_exist(cur) and settings.table_exists(cur)):
                return {"skipped": "migration 007 is not applied"}
            if not settings.get(cur, "uc_lineage_publish_in_sync"):
                return {"skipped": "uc_lineage_publish_in_sync is off"}
            platform = provision.mode() == "platform"
            tables: list[str] | None = None
            if platform:
                pl = plan(cur, mode="platform")
                if not pl["ops"]:
                    return {"skipped": "nothing to publish"}
                tables = pl["tables"]
        client, ready, acting_as = None, None, f"sync identity ({triggered_by})"
        if platform:
            client = client_factory()
            ready = uc_readiness.for_sync(client, tables)
            if ready["principal"]:
                acting_as = f"sync identity {ready['principal']} ({triggered_by})"
            if ready["status"] in ("blocked", "unknown"):
                reason = f"readiness {ready['status']}: {ready['reason']}"
                log.warning("UC lineage publish step skipped: %s", reason)
                with db.transaction() as cur:
                    uc_readiness.record_sync(cur, ready, triggered_by=triggered_by, skipped=True)
                return {"skipped": reason[:500], "readiness": uc_readiness.summary(ready)}
        with db.transaction() as cur:
            if ready is not None:
                uc_readiness.record_sync(cur, ready, triggered_by=triggered_by, skipped=False)
            res = publish(cur, None, client=client, acting_as=acting_as)
            out = {k: res[k] for k in ("run_id", "status", "mode", "counts")} | {"errors": len(res["errors"])}
            return out | ({"readiness": ready["status"]} if ready is not None else {})
    except Exception as e:  # noqa: BLE001 - the optional step must never fail the sync
        log.warning("UC lineage publish step failed: %s", e)
        return {"error": f"{type(e).__name__}: {str(e)[:300]}"}
