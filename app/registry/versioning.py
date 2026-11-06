"""Config snapshots, versions and sync-detected change events.

``record_snapshot(cur, asset_id, snapshot)`` normalises and hashes a collector's config snapshot and compares
it with the asset's latest ``asset_version``:

* first sighting: writes v1 (no change event);
* unchanged: nothing;
* changed: writes the next version (``v{n+1}``, or the source's own label such as an endpoint's
  ``config_version`` -> "config 4"), supersedes the previous one, inserts a published ``change_event``
  (``detected_by='sync'``, change kinds, breaking flag, an auto title such as "2 tools removed · instructions
  updated", a field diff and ``metrics_before``), freezes its impact (``impact.freeze_impact``) and audits it.

An asset's snapshot is a set of named SECTIONS so that two collectors can describe one asset (e.g. the serving
endpoint config and its Agent Bricks tools) without overwriting each other. The first time a section appears it
is folded into the current version silently.

Breaking rules: a tool removed; a tool's input schema gained a required parameter; a served model/entity
changed family; sensitivity raised; the endpoint URL or authentication changed. Description-only changes are
non-breaking.

Snapshot conventions understood by the diff: ``tools`` (list of {name, required[], schema_hash, ...} or names),
``served_entities`` (list of {name, family, ...}), ``endpoint_url``, ``auth``, ``sensitivity``,
``instructions_hash``, ``description_hash``, ``policies``, ``tables`` / ``knowledge_sources`` / ``data_sources``,
``tool_selectors``, ``revision``. Any other key is a generic configuration change.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import timedelta
from typing import Any

from psycopg.types.json import Jsonb

from registry import impact, metrics

DEFAULT_SECTION = "config"
SENSITIVITY_ORDER = ("public", "internal", "confidential", "restricted")
_dumps = lambda o: json.dumps(o, default=str, sort_keys=True)  # noqa: E731

TOOL_KEYS = ("tools",)
MODEL_KEYS = ("served_entities", "models")
DATA_KEYS = ("tables", "knowledge_sources", "data_sources")
PROMPT_KEYS = ("instructions_hash", "prompt_hash")
DESCRIPTION_KEYS = ("description_hash", "description")
KIND_ORDER = ("tools_removed", "tools_added", "schema", "model", "endpoint", "auth", "sensitivity", "prompt",
              "tool_selection", "data", "policy", "content", "description", "config")


# ====================================================================== normalisation
def _sort_key(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("name") if item.get("name") is not None else json.dumps(item, sort_keys=True, default=str))
    return json.dumps(item, sort_keys=True, default=str)


def normalize(obj: Any) -> Any:
    """JSON round-trip (as JSONB would store it), dict keys sorted, lists order-insensitive, Nones dropped."""
    obj = json.loads(json.dumps(obj, default=str))

    def walk(o: Any) -> Any:
        if isinstance(o, dict):
            return {k: walk(v) for k, v in sorted(o.items()) if v is not None}
        if isinstance(o, list):
            return sorted((walk(v) for v in o), key=_sort_key)
        return o

    return walk(obj)


def digest(obj: Any) -> str:
    return hashlib.sha256(json.dumps(normalize(obj), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# ====================================================================== diff
def _by_name(items: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in items or []:
        name = item.get("name") if isinstance(item, dict) else item
        if name is not None:
            out[str(name)] = item
    return out


def _family(entity: Any) -> str:
    if isinstance(entity, dict):
        return str(entity.get("family") or entity.get("entity_name") or entity.get("name") or "")
    return str(entity)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def compare(before: dict, after: dict) -> dict:
    """Diff two normalised section snapshots -> {diff, kinds, breaking, parts}."""
    diff: list[dict] = []
    kinds: list[str] = []
    parts: list[str] = []
    part_kinds: list[str] = []
    breaking = False
    current = {"kind": "config"}

    def kind(k: str) -> None:
        current["kind"] = k
        if k not in kinds:
            kinds.append(k)

    class _Parts(list):
        def append(self, text: str) -> None:  # noqa: D401 - remembers which kind produced each title part
            super().append(text)
            part_kinds.append(current["kind"])

    parts = _Parts()

    for key in sorted(set(before) | set(after)):
        b, a = before.get(key), after.get(key)
        if json.dumps(b, sort_keys=True) == json.dumps(a, sort_keys=True):
            continue
        if key in TOOL_KEYS:
            bm, am = _by_name(b), _by_name(a)
            removed = sorted(set(bm) - set(am))
            added = sorted(set(am) - set(bm))
            changed = [n for n in sorted(set(bm) & set(am)) if json.dumps(bm[n], sort_keys=True) != json.dumps(am[n], sort_keys=True)]
            gained_required = []
            for n in changed:
                # A tool whose required params were unknown before (no "required" key) cannot "gain" one.
                if not (isinstance(bm[n], dict) and isinstance(am[n], dict) and "required" in bm[n] and "required" in am[n]):
                    continue
                if set(am[n]["required"] or []) - set(bm[n]["required"] or []):
                    gained_required.append(n)
            for n in removed:
                diff.append({"field": f"{key}[{n}]", "before": bm[n], "after": None})
            for n in added:
                diff.append({"field": f"{key}[{n}]", "before": None, "after": am[n]})
            for n in changed:
                diff.append({"field": f"{key}[{n}]", "before": bm[n], "after": am[n]})
            if removed:
                kind("tools_removed")
                parts.append(f"{_plural(len(removed), 'tool')} removed")
                breaking = True
            if added:
                kind("tools_added")
                parts.append(f"{_plural(len(added), 'tool')} added")
            if changed:
                kind("schema")
                if gained_required:
                    breaking = True
                    parts.append(f"{_plural(len(gained_required), 'tool')} gained required parameters")
                rest = len(changed) - len(gained_required)
                if rest:
                    parts.append(f"{_plural(rest, 'tool')} changed")
            continue
        diff.append({"field": key, "before": b, "after": a})
        if key in MODEL_KEYS:
            kind("model")
            fb = {_family(e) for e in (b or [])}
            fa = {_family(e) for e in (a or [])}
            if fb != fa:
                breaking = True
                parts.append("model family changed")
            else:
                parts.append("served model updated")
        elif key in ("endpoint_url", "url"):
            kind("endpoint")
            breaking = True
            parts.append("endpoint URL changed")
        elif key in ("auth", "auth_model"):
            kind("auth")
            breaking = True
            parts.append("authentication changed")
        elif key == "sensitivity":
            kind("sensitivity")
            rank = {s: i for i, s in enumerate(SENSITIVITY_ORDER)}
            if rank.get(str(a), -1) > rank.get(str(b), -1):
                breaking = True
                parts.append("sensitivity raised")
            else:
                parts.append("sensitivity changed")
        elif key in PROMPT_KEYS:
            kind("prompt")
            parts.append("instructions updated")
        elif key in DESCRIPTION_KEYS:
            kind("description")
            parts.append("description updated")
        elif key == "policies":
            kind("policy")
            parts.append("policies updated")
        elif key in DATA_KEYS:
            kind("data")
            parts.append("data sources updated")
        elif key == "tool_selectors":
            kind("tool_selection")
            parts.append("tool selection changed")
        elif key == "revision":
            kind("content")
            parts.append("new revision published")
        else:
            kind("config")
            if "configuration updated" not in parts:
                parts.append("configuration updated")
    order = {k: i for i, k in enumerate(KIND_ORDER)}
    ranked = sorted(range(len(parts)), key=lambda i: (order.get(part_kinds[i], len(order)), i))
    return {"diff": diff, "kinds": sorted(kinds, key=lambda k: order.get(k, len(order))),
            "breaking": breaking, "parts": [parts[i] for i in ranked]}


def title_for(parts: list[str]) -> str:
    text = " · ".join(dict.fromkeys(parts)) or "configuration updated"
    return (text[0].upper() + text[1:])[:200]


# ====================================================================== versions
_CONFIG_LABEL = re.compile(r"^config (\d+)(?:\.(\d+))?$")


def _labels(cur, asset_id: str) -> set[str]:
    cur.execute("SELECT version FROM asset_version WHERE asset_id = %s", (asset_id,))
    return {r["version"] for r in cur.fetchall()}


def _next_label(cur, asset_id: str, latest: str | None, source_version: Any) -> str:
    used = _labels(cur, asset_id)
    base = None
    if source_version not in (None, ""):
        base = f"config {source_version}"
    elif latest and _CONFIG_LABEL.match(latest):
        base = f"config {_CONFIG_LABEL.match(latest).group(1)}"
    if base:
        if base not in used:
            return base
        k = 1
        while f"{base}.{k}" in used:
            k += 1
        return f"{base}.{k}"
    n = len(used) + 1
    while f"v{n}" in used:
        n += 1
    return f"v{n}"


def record_snapshot(cur, asset_id: str, snapshot: dict, actor: str = "sync", *, section: str = DEFAULT_SECTION,
                    source_version: Any = None) -> int | None:
    """Version the asset's config. Returns the new change_id when a change was detected, else None."""
    snap = normalize(snapshot or {})
    cur.execute("SELECT latest_version FROM asset WHERE asset_id = %s FOR UPDATE", (asset_id,))
    asset = cur.fetchone()
    if asset is None:
        raise KeyError(f"asset {asset_id} not found")
    latest_label = asset["latest_version"]
    latest = None
    if latest_label:
        cur.execute("SELECT config_snapshot FROM asset_version WHERE asset_id = %s AND version = %s",
                    (asset_id, latest_label))
        row = cur.fetchone()
        latest = row["config_snapshot"] if row else None

    if latest is None:
        label = _next_label(cur, asset_id, None, source_version)
        full = {"sections": {section: snap}, "source_versions": {section: source_version} if source_version is not None else {}}
        cur.execute(
            """INSERT INTO asset_version (asset_id, version, status, config_snapshot, source, created_by)
               VALUES (%s, %s, 'published', %s, 'sync', %s)""",
            (asset_id, label, Jsonb(full, dumps=_dumps), actor),
        )
        cur.execute("UPDATE asset SET latest_version = %s, published_version = %s WHERE asset_id = %s",
                    (label, label, asset_id))
        return None

    full = copy.deepcopy(latest)
    sections = full.setdefault("sections", {})
    source_versions = full.setdefault("source_versions", {})
    if section not in sections:
        sections[section] = snap
        if source_version is not None:
            source_versions[section] = source_version
        cur.execute("UPDATE asset_version SET config_snapshot = %s WHERE asset_id = %s AND version = %s",
                    (Jsonb(full, dumps=_dumps), asset_id, latest_label))
        return None

    before = normalize(sections[section])
    if digest(before) == digest(snap):
        return None

    result = compare(before, snap)
    sections[section] = snap
    if source_version is not None:
        source_versions[section] = source_version
    label = _next_label(cur, asset_id, latest_label, source_version)
    cur.execute("UPDATE asset_version SET status = 'superseded' WHERE asset_id = %s AND version = %s",
                (asset_id, latest_label))
    cur.execute(
        """INSERT INTO asset_version (asset_id, version, status, config_snapshot, source, created_by)
           VALUES (%s, %s, 'published', %s, 'sync', %s)""",
        (asset_id, label, Jsonb(full, dumps=_dumps), actor),
    )
    cur.execute("UPDATE asset SET latest_version = %s, published_version = %s, updated_at = now() WHERE asset_id = %s",
                (label, label, asset_id))

    now = metrics.utcnow()
    title = title_for(result["parts"])
    summary = f"Detected by the registry sync ({section}): {latest_label} → {label}."
    cur.execute(
        """INSERT INTO change_event (asset_id, from_version, to_version, change_kinds, breaking, title, summary, diff,
                                     status, detected_by, published_by, published_at, effective_at, metrics_before)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'published', 'sync', %s, %s, %s, %s) RETURNING change_id""",
        (asset_id, latest_label, label, result["kinds"], result["breaking"], title, summary,
         Jsonb(result["diff"], dumps=_dumps), actor, now, now,
         Jsonb(metrics.snapshot(cur, asset_id, now), dumps=_dumps)),
    )
    change_id = cur.fetchone()["change_id"]
    impact.freeze_impact(cur, change_id)
    from core import audit

    audit.audit_event(actor, "change.detected", "asset", asset_id, before={"version": latest_label},
                      after={"version": label, "change_id": change_id, "change_kinds": result["kinds"],
                             "breaking": result["breaking"], "title": title}, cur=cur)
    return change_id


def patch_snapshot(cur, asset_id: str, key: str, value: Any, *, section: str = DEFAULT_SECTION) -> bool:
    """Set one key of the latest version's section in place (None removes it), without a new version or change event.

    For a change the app itself applied on the platform and already published (e.g. an MCP tool selection), so the
    next sync compares against the new configuration instead of detecting the same change again."""
    cur.execute("SELECT latest_version FROM asset WHERE asset_id = %s", (asset_id,))
    row = cur.fetchone()
    if not row or not row["latest_version"]:
        return False
    cur.execute("SELECT config_snapshot FROM asset_version WHERE asset_id = %s AND version = %s FOR UPDATE",
                (asset_id, row["latest_version"]))
    snap = cur.fetchone()
    full = copy.deepcopy((snap or {}).get("config_snapshot") or {})
    sections = full.get("sections") or {}
    if section not in sections:
        return False
    if value is None:
        sections[section].pop(key, None)
    else:
        sections[section][key] = normalize(value)
    cur.execute("UPDATE asset_version SET config_snapshot = %s WHERE asset_id = %s AND version = %s",
                (Jsonb(full, dumps=_dumps), asset_id, row["latest_version"]))
    return True


def backfill_metrics_after(cur, window_days: int = 7) -> int:
    """Fill ``metrics_after`` for published changes older than the window (the 7 days after publishing)."""
    cur.execute(
        """SELECT change_id, asset_id, published_at FROM change_event
            WHERE status = 'published' AND metrics_after IS NULL AND published_at IS NOT NULL
              AND published_at <= now() - make_interval(days => %s)
            ORDER BY change_id""",
        (window_days,),
    )
    rows = cur.fetchall()
    for r in rows:
        after = metrics.snapshot(cur, r["asset_id"], r["published_at"] + timedelta(days=window_days), window_days)
        cur.execute("UPDATE change_event SET metrics_after = %s WHERE change_id = %s",
                    (Jsonb(after, dumps=_dumps), r["change_id"]))
    return len(rows)
