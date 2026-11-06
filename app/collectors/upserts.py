"""Idempotent writes from the collectors into the registry.

The ownership split that makes a sync safe to re-run:
* SOURCE-OWNED asset columns (name, display_name unless overridden, subtype, platform, publisher, parent,
  runtime_status, external_ref, attributes, deep_link, source timestamps, last_synced_at) are refreshed on
  every sync.
* HUMAN-GOVERNED columns (lifecycle_status once it is not 'discovered', certification, sensitivity, risk_tier,
  domain, tags) are written only when the asset is first inserted, never on update.
* Descriptive fields keep the source value and a human override side by side (``asset_field``): a sync only
  writes ``source_*``. Under a 'keep' override a source change sets ``drift``; under 'follow' it resets the
  override to the source value (with an ``asset_field_history`` row).
* A display-name override is an ``asset_field`` row with field_key 'display_name' and an override_value.

Every function takes an open dict-row cursor and returns whether it changed anything.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Iterable

from psycopg.types.json import Jsonb

from collectors.util import canonical, clean_list, clean_text
from registry import graph

SOURCE_COLUMNS = ("name", "display_name", "subtype", "source", "platform", "publisher", "parent_asset_id",
                  "runtime_status", "external_ref", "attributes", "deep_link", "sync_source", "created_by",
                  "source_created_at", "source_updated_at")
INSERT_ONLY = ("asset_type", "lifecycle_status", "certification", "sensitivity", "risk_tier", "domain", "tags", "origin")
JSON_COLUMNS = ("external_ref", "attributes")
DEFAULTS = {"lifecycle_status": "discovered", "certification": "unreviewed", "sensitivity": "internal",
            "risk_tier": "medium", "runtime_status": "unknown", "tags": [], "origin": "sync"}

_dumps = lambda o: json.dumps(o, default=str)  # noqa: E731


def initial_lifecycle(row: dict) -> str:
    """First-sight lifecycle. Databricks-native assets are already governed by Unity Catalog and workspace ACLs,
    so they register as 'approved'. External and custom ones (third-party MCP connections, custom MCP apps and
    their tools) start as 'discovered' for steward review."""
    return "approved" if row.get("source") == "databricks" else "discovered"


def J(value: Any) -> Jsonb:
    return Jsonb(value, dumps=_dumps)


def _norm(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return canonical(json.loads(_dumps(value)))
    if isinstance(value, datetime):
        return value.timestamp()
    return value


# ====================================================================== assets
def upsert_asset(cur, row: dict, *, keep_attributes: Iterable[str] = ()) -> bool:
    """Insert or refresh one asset. Returns True when anything source-owned changed (or it was inserted).

    ``keep_attributes``: attribute keys written by OTHER collectors (via ``merge_attributes``) that this
    collector's full ``attributes`` value must not drop.
    """
    asset_id = row["asset_id"]
    new = {**DEFAULTS, **{k: v for k, v in row.items() if v is not None or k in ("publisher", "parent_asset_id", "deep_link")}}
    if row.get("lifecycle_status") is None:
        new["lifecycle_status"] = initial_lifecycle(new)
    new.setdefault("display_name", new.get("name"))
    new.setdefault("external_ref", {})
    new.setdefault("attributes", {})
    cur.execute(f"SELECT {', '.join(SOURCE_COLUMNS)}, lifecycle_status FROM asset WHERE asset_id = %s FOR UPDATE",
                (asset_id,))
    old = cur.fetchone()
    if old is None:
        cols = ["asset_id", *SOURCE_COLUMNS, *INSERT_ONLY]
        values = [J(new.get(c)) if c in JSON_COLUMNS else new.get(c) for c in cols]
        values[cols.index("asset_id")] = asset_id
        cur.execute(
            f"INSERT INTO asset ({', '.join(cols)}, last_synced_at, updated_at)"
            f" VALUES ({', '.join(['%s'] * len(cols))}, now(), now())",
            values,
        )
        return True

    attrs = dict(new.get("attributes") or {})
    for key in keep_attributes:
        if key in (old.get("attributes") or {}) and key not in attrs:
            attrs[key] = old["attributes"][key]
    new["attributes"] = attrs
    cur.execute(
        "SELECT 1 FROM asset_field WHERE asset_id = %s AND field_key = 'display_name' AND override_value IS NOT NULL",
        (asset_id,),
    )
    if cur.fetchone():
        new["display_name"] = old["display_name"]
    changes = {c: new.get(c) for c in SOURCE_COLUMNS if _norm(old.get(c)) != _norm(new.get(c))}
    if old["lifecycle_status"] == "discovered" and row.get("lifecycle_status") not in (None, "discovered"):
        changes["lifecycle_status"] = row["lifecycle_status"]
    if not changes:
        cur.execute("UPDATE asset SET last_synced_at = now() WHERE asset_id = %s", (asset_id,))
        return False
    sets = ", ".join(f"{c} = %s" for c in changes)
    values = [J(v) if c in JSON_COLUMNS else v for c, v in changes.items()]
    cur.execute(f"UPDATE asset SET {sets}, last_synced_at = now(), updated_at = now() WHERE asset_id = %s",
                [*values, asset_id])
    return True


def merge_attributes(cur, asset_id: str, key: str, value: Any) -> bool:
    """Set ``attributes[key]`` (a namespaced block owned by an enrichment collector). True when it changed."""
    cur.execute(
        """UPDATE asset SET attributes = jsonb_set(attributes, ARRAY[%s], %s, true), updated_at = now()
            WHERE asset_id = %s AND attributes -> %s IS DISTINCT FROM %s""",
        (key, J(value), asset_id, key, J(value)),
    )
    return cur.rowcount > 0


def existing_assets(cur, prefix: str) -> dict[str, dict]:
    """{asset_id: {subtype, platform, attributes, parent_asset_id}} for every asset whose id starts with ``prefix``."""
    cur.execute(
        "SELECT asset_id, subtype, platform, attributes, parent_asset_id, external_ref FROM asset WHERE asset_id LIKE %s",
        (prefix.replace("%", r"\%").replace("_", r"\_") + "%",),
    )
    return {r["asset_id"]: r for r in cur.fetchall()}


def mark_missing(cur, *, sync_source: str, seen_ids: Iterable[str], asset_type: str | None = None,
                 parent_ids: Iterable[str] | None = None, id_prefix: str | None = None) -> int:
    """Flag assets this collector synced before but did not see now (never deletes: humans govern them)."""
    seen = list(dict.fromkeys(seen_ids))
    clauses = ["sync_source = %s", "NOT (asset_id = ANY(%s))",
               "coalesce((attributes ->> 'missing_from_source')::boolean, false) = false"]
    params: list[Any] = [sync_source, seen]
    if asset_type:
        clauses.append("asset_type = %s")
        params.append(asset_type)
    if parent_ids is not None:
        clauses.append("parent_asset_id = ANY(%s)")
        params.append(list(parent_ids))
    if id_prefix:
        clauses.append("asset_id LIKE %s")
        params.append(id_prefix.replace("_", r"\_") + "%")
    cur.execute(
        f"""UPDATE asset SET runtime_status = 'unknown', updated_at = now(),
                   attributes = attributes || jsonb_build_object('missing_from_source', true, 'missing_since', now())
             WHERE {' AND '.join(clauses)}""",
        params,
    )
    return cur.rowcount


# ====================================================================== descriptive fields
def _clean_value(value: Any) -> Any:
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, (list, tuple)):
        if all(isinstance(v, str) for v in value):
            return clean_list(value)
        return list(value) or None
    if isinstance(value, dict):
        return value or None
    return value


def upsert_source_field(cur, asset_id: str, field_key: str, value: Any, label: str, *, actor: str = "sync") -> bool:
    """Write the auto-pulled value of one descriptive field. Never touches a human override's value, except
    under ``lock_mode='follow'`` when the source changes (the override is then reset to the source)."""
    value = _clean_value(value)
    cur.execute("SELECT * FROM asset_field WHERE asset_id = %s AND field_key = %s FOR UPDATE", (asset_id, field_key))
    row = cur.fetchone()
    if row is None:
        if value is None:
            return False
        cur.execute(
            """INSERT INTO asset_field (asset_id, field_key, source_value, source_label, source_synced_at)
               VALUES (%s, %s, %s, %s, now())""",
            (asset_id, field_key, J(value), label),
        )
        return True
    source_changed = _norm(row.get("source_value")) != _norm(value)
    label_changed = (row.get("source_label") or None) != label
    has_override = row.get("override_value") is not None
    if not source_changed:
        cur.execute(
            "UPDATE asset_field SET source_synced_at = now(), source_label = %s WHERE asset_id = %s AND field_key = %s",
            (label, asset_id, field_key),
        )
        return label_changed
    if has_override and row.get("lock_mode") == "follow":
        cur.execute(
            """UPDATE asset_field SET source_value = %s, source_label = %s, source_synced_at = now(),
                      override_value = NULL, provenance = 'source', override_reason = NULL, overridden_by = NULL,
                      overridden_at = NULL, drift = false
                WHERE asset_id = %s AND field_key = %s""",
            (J(value), label, asset_id, field_key),
        )
        cur.execute(
            """INSERT INTO asset_field_history (asset_id, field_key, old_value, new_value, provenance, actor, reason)
               VALUES (%s, %s, %s, %s, 'source', %s, %s)""",
            (asset_id, field_key, J(row["override_value"]), J(value), actor,
             "source changed; override set to follow the source"),
        )
        return True
    cur.execute(
        """UPDATE asset_field SET source_value = %s, source_label = %s, source_synced_at = now(),
                  drift = CASE WHEN override_value IS NOT NULL THEN true ELSE drift END
            WHERE asset_id = %s AND field_key = %s""",
        (J(value) if value is not None else None, label, asset_id, field_key),
    )
    return True


def upsert_fields(cur, asset_id: str, fields: dict[str, tuple[Any, str]]) -> int:
    """Several source fields at once: {field_key: (value, label)}. Returns how many changed."""
    return sum(1 for key, (value, label) in fields.items() if upsert_source_field(cur, asset_id, key, value, label))


# ====================================================================== owners
def upsert_owner(cur, asset_id: str, email: str, kind: str = "owner", source: str = "synced",
                 added_by: str = "sync") -> bool:
    email = (email or "").strip()
    if not email:
        return False
    email = email.lower() if "@" in email else email
    cur.execute(
        """INSERT INTO asset_owner (asset_id, email, kind, source, added_by) VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (asset_id, email, kind) DO NOTHING""",
        (asset_id, email, kind, source, added_by),
    )
    return cur.rowcount > 0


def sync_owners(cur, asset_id: str, owners: Iterable[str | None], *, collector: str, kind: str = "owner") -> bool:
    """Make this collector's synced owners exactly ``owners``. Assigned owners and other collectors' are kept."""
    wanted = []
    for o in owners:
        o = (o or "").strip()
        if o:
            wanted.append(o.lower() if "@" in o else o)
    wanted = list(dict.fromkeys(wanted))
    changed = False
    for email in wanted:
        changed |= upsert_owner(cur, asset_id, email, kind, "synced", collector)
    cur.execute(
        """DELETE FROM asset_owner WHERE asset_id = %s AND kind = %s AND source = 'synced' AND added_by = %s
                                   AND NOT (email = ANY(%s))""",
        (asset_id, kind, collector, wanted),
    )
    return changed or cur.rowcount > 0


# ====================================================================== grants
def upsert_grant(cur, asset_id: str, principal: str, principal_type: str, privilege: str, *, seen_at: datetime,
                 inherited: bool = False) -> bool:
    """Mirror one platform grant. Returns True when it was new (or its inherited flag/type changed)."""
    cur.execute(
        """SELECT grant_id, inherited, principal_type FROM access_grant
            WHERE asset_id = %s AND principal = %s AND privilege = %s AND source = 'platform' AND revoked_at IS NULL
            FOR UPDATE""",
        (asset_id, principal, privilege),
    )
    row = cur.fetchone()
    if row is None:
        cur.execute(
            """INSERT INTO access_grant (asset_id, principal, principal_type, privilege, source, inherited, granted_by,
                                         last_seen_on_platform)
               VALUES (%s, %s, %s, %s, 'platform', %s, 'platform', %s)""",
            (asset_id, principal, principal_type, privilege, inherited, seen_at),
        )
        return True
    cur.execute(
        "UPDATE access_grant SET last_seen_on_platform = %s, inherited = %s, principal_type = %s WHERE grant_id = %s",
        (seen_at, inherited, principal_type, row["grant_id"]),
    )
    return row["inherited"] != inherited or row["principal_type"] != principal_type


def sync_grants(cur, asset_id: str, grants: Iterable[dict], *, seen_at: datetime) -> int:
    """Upsert the asset's platform grants and revoke the platform grants not seen in this read."""
    changed = 0
    for g in grants:
        if g.get("principal_type") not in ("user", "group", "service_principal"):
            continue
        changed += upsert_grant(cur, asset_id, g["principal"], g["principal_type"], g["privilege"],
                                seen_at=seen_at, inherited=bool(g.get("inherited")))
    cur.execute(
        """UPDATE access_grant SET revoked_at = now(), revoked_by = 'sync'
            WHERE asset_id = %s AND source = 'platform' AND revoked_at IS NULL
              AND (last_seen_on_platform IS NULL OR last_seen_on_platform < %s)""",
        (asset_id, seen_at),
    )
    return changed + cur.rowcount


# ====================================================================== policies
def upsert_policy(cur, policy: dict) -> bool:
    cur.execute("SELECT name, kind, provider, phase, action, config, description FROM policy WHERE policy_id = %s FOR UPDATE",
                (policy["policy_id"],))
    old = cur.fetchone()
    fields = ("name", "kind", "provider", "phase", "action", "config", "description")
    new = {"phase": "n/a", "action": "n/a", "config": {}, "description": None, **policy}
    if old is not None and all(_norm(old[f]) == _norm(new.get(f)) for f in fields):
        cur.execute("UPDATE policy SET synced_at = now() WHERE policy_id = %s", (policy["policy_id"],))
        return False
    cur.execute(
        """INSERT INTO policy (policy_id, name, kind, provider, phase, action, config, description, origin, synced_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'sync', now())
           ON CONFLICT (policy_id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, provider = EXCLUDED.provider,
               phase = EXCLUDED.phase, action = EXCLUDED.action, config = EXCLUDED.config,
               description = EXCLUDED.description, synced_at = now(), updated_at = now()""",
        (new["policy_id"], new["name"], new["kind"], new["provider"], new["phase"], new["action"], J(new["config"]),
         new["description"]),
    )
    return True


def bind_policy(cur, policy_id: str, asset_id: str, *, inherited_from: str | None = None) -> bool:
    cur.execute(
        """INSERT INTO policy_binding (policy_id, asset_id, status, inherited_from, bound_by)
           VALUES (%s, %s, 'active', %s, 'sync') ON CONFLICT (policy_id, asset_id) DO NOTHING""",
        (policy_id, asset_id, inherited_from),
    )
    return cur.rowcount > 0


def prune_policies(cur, prefix: str, keep_ids: Iterable[str]) -> int:
    """Delete synced policies whose id starts with ``prefix`` and that the source no longer reports."""
    cur.execute(
        "DELETE FROM policy WHERE origin = 'sync' AND policy_id LIKE %s AND NOT (policy_id = ANY(%s))",
        (prefix.replace("_", r"\_").replace("%", r"\%") + "%", list(keep_ids)),
    )
    return cur.rowcount


# ====================================================================== experiments
def link_experiment(cur, asset_id: str, experiment_id: Any, link_source: str) -> bool:
    exp = clean_text(experiment_id)
    if not exp:
        return False
    cur.execute(
        """INSERT INTO asset_experiment (asset_id, experiment_id, link_source) VALUES (%s, %s, %s)
           ON CONFLICT (asset_id, experiment_id) DO NOTHING""",
        (asset_id, exp, link_source),
    )
    return cur.rowcount > 0


# ====================================================================== lineage
def edge(cur, src: str, dst: str, relation: str, edge_kind: str, source: str, *, weight_30d: int | None = None,
         attributes: dict | None = None) -> bool:
    """``graph.upsert_edge`` that reports whether the edge is new."""
    cur.execute("SELECT 1 FROM lineage_edge WHERE src_id = %s AND dst_id = %s AND relation = %s AND edge_kind = %s",
                (src, dst, relation, edge_kind))
    existed = cur.fetchone() is not None
    graph.upsert_edge(cur, src, dst, relation, edge_kind, source, weight_30d=weight_30d, attributes=attributes)
    return not existed


def prune_edges(cur, *, source: str, seen_at: datetime, edge_kind: str | None = None,
                src_ids: Iterable[str] | None = None, dst_ids: Iterable[str] | None = None,
                relation: str | None = None) -> int:
    """Delete edges written by ``source`` for the given nodes that this run did not refresh."""
    clauses, params = ["source = %s", "last_seen < %s"], [source, seen_at]
    if edge_kind:
        clauses.append("edge_kind = %s")
        params.append(edge_kind)
    if relation:
        clauses.append("relation = %s")
        params.append(relation)
    if src_ids is not None:
        clauses.append("src_id = ANY(%s)")
        params.append(list(src_ids))
    if dst_ids is not None:
        clauses.append("dst_id = ANY(%s)")
        params.append(list(dst_ids))
    cur.execute(f"DELETE FROM lineage_edge WHERE {' AND '.join(clauses)}", params)
    return cur.rowcount


def asset_ids(cur, ids: Iterable[str]) -> set[str]:
    ids = list(dict.fromkeys(i for i in ids if i))
    if not ids:
        return set()
    cur.execute("SELECT asset_id FROM asset WHERE asset_id = ANY(%s)", (ids,))
    return {r["asset_id"] for r in cur.fetchall()}
