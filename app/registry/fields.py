"""Descriptive fields with field-level provenance (the description widget).

effective value = override_value if one is set, else source_value.
* An owner edit on a field with no source value → provenance 'owner'.
* An edit on a field that HAS a source value (auto-pulled, e.g. an external MCP) is an override. It needs a
  steward/admin and a reason, and gets provenance 'admin'. Owners may still edit owner-authored fields.
* lock_mode 'keep' (default): later syncs keep the override and set ``drift`` when the source moves.
  'follow': the override stands until the source value next CHANGES; the sync then replaces it with the new
  source value.
* ``display_name`` overrides also rename the asset row; the collectors then stop syncing the name.
* SYSTEM_FIELDS have the same provenance semantics but are not part of the description widget: they render where
  they belong (``also_registered_in``: the Overview "At a glance" card, synced from Microsoft Agent 365).
"""
from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Forbidden, NotFound

FIELD_CATALOG: list[dict] = [
    {"field_key": "display_name", "label": "Display name", "kind": "text", "required": False, "max": 120},
    {"field_key": "purpose", "label": "Purpose", "kind": "text", "required": True, "max": 140},
    {"field_key": "description", "label": "Description", "kind": "longtext", "required": True, "max": 20000},
    {"field_key": "intended_users", "label": "Intended users", "kind": "list", "required": False},
    {"field_key": "inputs", "label": "Inputs", "kind": "longtext", "required": False, "max": 8000},
    {"field_key": "outputs", "label": "Outputs", "kind": "longtext", "required": False, "max": 8000},
    {"field_key": "data_sensitivity_notes", "label": "Data handling", "kind": "longtext", "required": False, "max": 4000},
    {"field_key": "sla", "label": "SLA / SLO", "kind": "kv", "required": False},
    {"field_key": "support_channel", "label": "Support channel", "kind": "text", "required": False, "max": 300},
    {"field_key": "limitations", "label": "Known limitations", "kind": "longtext", "required": False, "max": 8000},
    {"field_key": "example_prompts", "label": "Example prompts", "kind": "list", "required": False},
    {"field_key": "links", "label": "Links", "kind": "links", "required": False},
    {"field_key": "publisher_info", "label": "Publisher", "kind": "text", "required": False, "max": 300},
    {"field_key": "auth_model", "label": "Authentication", "kind": "text", "required": False, "max": 300},
    {"field_key": "endpoint_url", "label": "Endpoint / MCP URL", "kind": "text", "required": False, "max": 1000},
]
SYSTEM_FIELDS: list[dict] = [
    {"field_key": "also_registered_in", "label": "Also registered in", "kind": "registrations", "required": False, "max": 50},
]
BY_KEY = {f["field_key"]: f for f in FIELD_CATALOG + SYSTEM_FIELDS}
COMPLETENESS_KEYS = ("purpose", "description", "intended_users", "inputs", "outputs", "support_channel", "limitations", "example_prompts")


def _empty(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip()) or (isinstance(v, (list, dict)) and not v)


def validate(field_key: str, value: Any) -> Any:
    spec = BY_KEY.get(field_key)
    if not spec:
        raise ValueError(f"unknown field {field_key!r}")
    kind = spec["kind"]
    if value is None:
        return None
    if kind in ("text", "longtext"):
        if not isinstance(value, str):
            raise ValueError(f"{spec['label']} must be text")
        value = value.strip()
        if kind == "text":
            value = " ".join(value.split())
        if len(value) > spec.get("max", 20000):
            raise ValueError(f"{spec['label']} is limited to {spec['max']} characters")
        return value
    if kind == "list":
        if isinstance(value, str):
            value = [v.strip() for v in value.split("\n")]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError(f"{spec['label']} must be a list of text")
        return [v.strip() for v in value if v.strip()][:50]
    if kind == "links":
        if not isinstance(value, list):
            raise ValueError("Links must be a list of {label, url}")
        out = []
        for item in value[:30]:
            if not isinstance(item, dict) or not str(item.get("url", "")).startswith(("https://", "http://")):
                raise ValueError("Each link needs an http(s) url")
            out.append({"label": str(item.get("label") or item["url"])[:120], "url": str(item["url"])[:1000]})
        return out
    if kind == "registrations":
        if not isinstance(value, list):
            raise ValueError("Also registered in must be a list of {registry, id, url?}")
        out = []
        for item in value[: spec["max"]]:
            if not isinstance(item, dict) or not str(item.get("registry") or "").strip() or not str(item.get("id") or "").strip():
                raise ValueError("Each registration needs a registry and an id")
            url = str(item.get("url") or "").strip()
            if url and not url.startswith(("https://", "http://")):
                raise ValueError("A registration url must be http(s)")
            out.append({k: v for k, v in {"registry": str(item["registry"]).strip()[:80], "id": str(item["id"]).strip()[:300],
                                          "url": url[:1000] or None,
                                          **{k: item[k] for k in ("display_name", "platform", "match", "confidence") if item.get(k) is not None}}.items()
                        if v is not None})
        return out
    if kind == "kv":
        if not isinstance(value, dict):
            raise ValueError(f"{spec['label']} must be an object")
        return {str(k)[:60]: str(v)[:200] for k, v in list(value.items())[:20]}
    return value


def effective(row: dict) -> Any:
    return row["override_value"] if row.get("override_value") is not None else row.get("source_value")


def to_api(row: dict | None, field_key: str) -> dict:
    spec = BY_KEY.get(field_key, {"label": field_key, "kind": "text", "required": False})
    row = row or {}
    return {
        "field_key": field_key, "label": spec["label"], "kind": spec["kind"], "required": spec["required"],
        "value": effective(row) if row else None,
        "source_value": row.get("source_value"), "source_label": row.get("source_label"),
        "source_synced_at": row.get("source_synced_at"),
        "override_value": row.get("override_value"), "provenance": row.get("provenance") or "source",
        "lock_mode": row.get("lock_mode") or "keep", "overridden_by": row.get("overridden_by"),
        "overridden_at": row.get("overridden_at"), "override_reason": row.get("override_reason"),
        "drift": bool(row.get("drift")),
    }


def system_field(cur, asset_id: str, field_key: str) -> dict | None:
    """One SYSTEM_FIELDS value with provenance, or None when nothing was ever recorded."""
    cur.execute("SELECT * FROM asset_field WHERE asset_id = %s AND field_key = %s", (asset_id, field_key))
    row = cur.fetchone()
    return to_api(row, field_key) if row else None


def list_fields(cur, asset_id: str) -> list[dict]:
    cur.execute("SELECT * FROM asset_field WHERE asset_id = %s", (asset_id,))
    rows = {r["field_key"]: r for r in cur.fetchall()}
    return [to_api(rows.get(f["field_key"]), f["field_key"]) for f in FIELD_CATALOG]


def completeness(fields: list[dict]) -> int:
    have = sum(1 for f in fields if f["field_key"] in COMPLETENESS_KEYS and not _empty(f["value"]))
    return round(100 * have / len(COMPLETENESS_KEYS))


def _get(cur, asset_id: str, field_key: str) -> dict | None:
    cur.execute("SELECT * FROM asset_field WHERE asset_id = %s AND field_key = %s FOR UPDATE", (asset_id, field_key))
    return cur.fetchone()


def set_field(cur, asset_id: str, field_key: str, value: Any, *, actor: str, perms: dict,
              reason: str | None = None, lock_mode: str | None = None, request_id: str | None = None) -> dict:
    value = validate(field_key, value)
    cur.execute("SELECT 1 FROM asset WHERE asset_id = %s", (asset_id,))
    if not cur.fetchone():
        raise NotFound(f"asset {asset_id} not found")
    row = _get(cur, asset_id, field_key)
    has_source = bool(row and not _empty(row.get("source_value")))
    if has_source:
        if not perms.get("can_override"):
            raise Forbidden("This field is synced from the source system. Only a steward or admin can override it.")
        if not (reason or "").strip():
            raise ValueError("A reason is required to override a synced value")
        provenance = "admin"
    else:
        if not (perms.get("can_edit") or perms.get("can_override")):
            raise Forbidden("Only the asset's owners (or a steward/admin) can edit its description")
        provenance = "admin" if (perms.get("can_override") and not perms.get("is_owner")) else "owner"
    lock = lock_mode if lock_mode in ("keep", "follow") else (row or {}).get("lock_mode") or "keep"
    before = to_api(row, field_key) if row else None
    cur.execute(
        """
        INSERT INTO asset_field (asset_id, field_key, override_value, provenance, lock_mode, override_reason,
                                 overridden_by, overridden_at, drift)
        VALUES (%s, %s, %s, %s, %s, %s, %s, now(), false)
        ON CONFLICT (asset_id, field_key) DO UPDATE
           SET override_value = EXCLUDED.override_value, provenance = EXCLUDED.provenance,
               lock_mode = EXCLUDED.lock_mode, override_reason = EXCLUDED.override_reason,
               overridden_by = EXCLUDED.overridden_by, overridden_at = now(), drift = false
        RETURNING *
        """,
        (asset_id, field_key, Jsonb(value), provenance, lock, reason, actor),
    )
    after_row = cur.fetchone()
    cur.execute(
        """INSERT INTO asset_field_history (asset_id, field_key, old_value, new_value, provenance, actor, reason)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (asset_id, field_key, Jsonb(before["value"] if before else None), Jsonb(value), provenance, actor, reason),
    )
    if field_key == "display_name" and value:
        cur.execute("UPDATE asset SET display_name = %s, updated_at = now() WHERE asset_id = %s", (value, asset_id))
    else:
        cur.execute("UPDATE asset SET updated_at = now() WHERE asset_id = %s", (asset_id,))
    audit.audit_event(actor, "field.override" if provenance == "admin" else "field.edit", "asset", asset_id,
                      before={"field": field_key, "value": before["value"] if before else None},
                      after={"field": field_key, "value": value, "provenance": provenance, "reason": reason},
                      request_id=request_id, cur=cur)
    return to_api(after_row, field_key)


def revert(cur, asset_id: str, field_key: str, *, actor: str, perms: dict, reason: str | None = None,
           request_id: str | None = None) -> dict:
    row = _get(cur, asset_id, field_key)
    if not row or row.get("override_value") is None:
        raise ValueError("Nothing to revert: the field shows the source value")
    if row["provenance"] == "admin" and not perms.get("can_override"):
        raise Forbidden("Only a steward or admin can revert an admin override")
    if row["provenance"] == "owner" and not (perms.get("can_edit") or perms.get("can_override")):
        raise Forbidden("Only the asset's owners can clear this value")
    cur.execute(
        """UPDATE asset_field SET override_value = NULL, provenance = 'source', override_reason = NULL,
                  overridden_by = NULL, overridden_at = NULL, drift = false
            WHERE asset_id = %s AND field_key = %s RETURNING *""",
        (asset_id, field_key),
    )
    after = cur.fetchone()
    cur.execute(
        """INSERT INTO asset_field_history (asset_id, field_key, old_value, new_value, provenance, actor, reason)
           VALUES (%s, %s, %s, %s, 'source', %s, %s)""",
        (asset_id, field_key, Jsonb(row["override_value"]), Jsonb(row.get("source_value")), actor, reason or "revert to source"),
    )
    audit.audit_event(actor, "field.revert", "asset", asset_id, before={"field": field_key, "value": row["override_value"]},
                      after={"field": field_key, "value": row.get("source_value")}, request_id=request_id, cur=cur)
    return to_api(after, field_key)


def resolve_drift(cur, asset_id: str, field_key: str, action: str, *, actor: str, perms: dict,
                  request_id: str | None = None) -> dict:
    if not perms.get("can_override"):
        raise Forbidden("Only a steward or admin can resolve drift on synced fields")
    row = _get(cur, asset_id, field_key)
    if not row or not row.get("drift"):
        raise ValueError("This field has no drift to resolve")
    if action == "accept_source":
        return revert(cur, asset_id, field_key, actor=actor, perms=perms, reason="accepted source change", request_id=request_id)
    if action != "keep":
        raise ValueError("action must be keep or accept_source")
    cur.execute("UPDATE asset_field SET drift = false WHERE asset_id = %s AND field_key = %s RETURNING *", (asset_id, field_key))
    after = cur.fetchone()
    audit.audit_event(actor, "field.keep_override", "asset", asset_id, after={"field": field_key}, request_id=request_id, cur=cur)
    return to_api(after, field_key)


def history(cur, asset_id: str, limit: int = 200) -> list[dict]:
    cur.execute(
        "SELECT id, field_key, old_value, new_value, provenance, actor, reason, at FROM asset_field_history WHERE asset_id = %s ORDER BY at DESC, id DESC LIMIT %s",
        (asset_id, limit),
    )
    return list(cur.fetchall())
