"""Microsoft Agent 365 registrations → the asset's "Also registered in" (docs/research/05-agent365-interop.md).

Agent 365 *Connected platforms* syncs Databricks Genie agents into the Microsoft 365 agent registry, so one agent
lives in two registries. This module matches those registry records to registry assets and records the Microsoft ID
on the asset with field-level provenance.

Inputs (both normalised by ``parse_records``):
* Microsoft Graph (``collectors/agent365.py``): ``GET /v1.0/copilot/admin/catalog/packages`` (copilotPackage objects,
  ``{"value": [...]}``) through an admin-configured UC HTTP connection, so the app never holds a Microsoft secret;
* a file an admin uploads: the M365 admin center *Agents > All agents > Export* (CSV) or a JSON export
  (a list, a Graph page ``{"value": [...]}`` or ``{"agents": [...]}``). Column names vary, so keys are matched
  case- and punctuation-insensitively.

Only Databricks records are considered (platform/publisher mentions Databricks or Genie, or a Databricks URL appears);
everything else in the tenant export is counted as ignored and never stored.

Matching, strongest first:
1. an ID in the record: a Genie space id (``…/genie/rooms/<id>`` URLs or a source/space id column) → ``agent:genie:<id>``,
   a serving endpoint (``…/serving-endpoints/<name>``) → ``agent:endpoint:<name>``, an app name → ``agent:app:<name>``;
   a workspace host that differs from the asset's halves the confidence;
2. the normalised display name against registered agents (exact, then fuzzy), with a confidence score.
Confidence ≥ ``AUTO_MATCH`` links automatically (status ``matched``); weaker matches are ``suggested`` and unmatched
records are ``unmatched``. Both wait in the steward review list; nothing creates assets. Steward decisions
(``linked`` / ``dismissed``) survive re-imports.

Writes: ``asset_field('also_registered_in')`` gets the source value (``source_label`` "Microsoft Agent 365") through
``collectors.upserts.upsert_source_field``, so steward overrides, lock modes and drift work as for every synced field.
"""
from __future__ import annotations

import csv
import difflib
import io
import json
import re
from typing import Any, Iterable

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Conflict, NotFound
from registry import authz

REGISTRY_KEY = "microsoft_agent_365"
REGISTRY_LABEL = "Microsoft Agent 365"
SOURCE_LABEL = "Microsoft Agent 365"
FIELD_KEY = "also_registered_in"
ADMIN_CENTER_URL = "https://admin.microsoft.com/Adminportal/Home#/agents"  # All agents; per-agent deep links are undocumented
AUTO_MATCH = 0.85
MAX_RECORDS = 20000
MAX_IMPORT_BYTES = 10 * 1024 * 1024

ID_KEYS = ("id", "agentid", "packageid", "registryid", "copilotpackageid")
NAME_KEYS = ("displayname", "name", "agentname", "title")
PLATFORM_KEYS = ("platform", "sourceplatform", "connectedplatform", "externalplatform", "createdwith", "builtwith")
PUBLISHER_KEYS = ("publisher", "publishername", "publishertype")
DESCRIPTION_KEYS = ("shortdescription", "description", "longdescription")
SOURCE_ID_KEYS = ("externalid", "sourceid", "sourceagentid", "platformagentid", "spaceid", "geniespaceid", "genieagentid",
                  "agentinstanceid", "manifestid", "assetid", "externalagentid")
URL_KEYS = ("url", "sourceurl", "agenturl", "link", "endpoint", "endpointurl", "externalurl")
WORKSPACE_KEYS = ("workspaceurl", "workspacehost", "workspace", "account", "sourceaccount", "connection")
KEEP_KEYS = ("id", "displayname", "name", "platform", "publisher", "publishertype", "status", "type", "owner", "version",
             "lastmodifieddatetime", "lastmodified", "datecreated", "createddatetime", "manifestid", "assetid", "appid",
             "agentidentityid", "governancemetadata", "channel", "externalid", "sourceid", "workspaceurl", "url")

GENIE_URL = re.compile(r"https?://([a-z0-9.-]+)/genie/(?:rooms|spaces|agents)/([A-Za-z0-9_-]+)", re.I)
ENDPOINT_URL = re.compile(r"https?://([a-z0-9.-]+)/serving-endpoints/([A-Za-z0-9_.-]+)", re.I)
DATABRICKS_HOST = re.compile(r"\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com))\b", re.I)
TOKEN = re.compile(r"^[A-Za-z0-9_.-]{3,128}$")
NAME_NOISE = re.compile(r"\b(genie|agent|space|databricks)\b")


def norm_key(key: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key or "").lower())


def norm_name(name: Any) -> str:
    text = re.sub(r"[^a-z0-9]+", " ", str(name or "").lower())
    text = NAME_NOISE.sub(" ", text)
    return " ".join(text.split())


def _first(rec: dict, keys: Iterable[str]) -> str | None:
    for k in keys:
        v = rec.get(k)
        if isinstance(v, (list, tuple)):
            v = ", ".join(str(x) for x in v if x not in (None, ""))
        if v not in (None, "") and str(v).strip():
            return str(v).strip()
    return None


# ====================================================================== parsing
def parse_records(content: str | bytes | list | dict, filename: str | None = None, fmt: str | None = None) -> list[dict]:
    """CSV / JSON text (or already-parsed JSON) → raw records with normalised keys."""
    if isinstance(content, bytes):
        if len(content) > MAX_IMPORT_BYTES:
            raise ValueError("The export is larger than 10 MB: filter it in the admin center (Platform = Databricks Genie)")
        content = content.decode("utf-8-sig", "replace")
    if isinstance(content, str):
        if len(content.encode()) > MAX_IMPORT_BYTES:
            raise ValueError("The export is larger than 10 MB: filter it in the admin center (Platform = Databricks Genie)")
        text = content.lstrip("﻿").strip()
        if not text:
            raise ValueError("The file is empty")
        kind = (fmt or "").lower() or ("json" if (filename or "").lower().endswith(".json") or text[:1] in "[{" else "csv")
        if kind == "json":
            try:
                content = json.loads(text)
            except ValueError as e:
                raise ValueError(f"Not valid JSON: {e}") from None
        else:
            sample = text[:4096]
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
            except csv.Error:
                dialect = csv.excel
            rows = list(csv.DictReader(io.StringIO(text), dialect=dialect))
            if not rows or not any(norm_key(k) in NAME_KEYS for k in (rows[0].keys() if rows else [])):
                raise ValueError("The CSV needs a header row with at least a Name (or Display name) column")
            return [{norm_key(k): (v or "").strip() for k, v in r.items() if k is not None} for r in rows][:MAX_RECORDS]
    if isinstance(content, dict):
        content = content.get("value") if isinstance(content.get("value"), list) else content.get("agents") \
            if isinstance(content.get("agents"), list) else [content]
    if not isinstance(content, list):
        raise ValueError("Expected a list of agents, a Graph page {\"value\": [...]} or {\"agents\": [...]}")
    return [{norm_key(k): v for k, v in r.items()} for r in content if isinstance(r, dict)][:MAX_RECORDS]


def normalize(raw: dict) -> dict:
    """One registry record: id, name, platform, URLs and the identifying hints found anywhere in it."""
    external_id = _first(raw, ID_KEYS) or _first(raw, SOURCE_ID_KEYS)
    texts = [str(v) for v in raw.values() if isinstance(v, (str, int, float)) and str(v).strip()]
    texts += [str(x) for v in raw.values() if isinstance(v, list) for x in v if isinstance(x, (str, int))]
    joined = " ".join(texts)
    space_ids, endpoints, hosts = [], [], set()
    for host, sid in GENIE_URL.findall(joined):
        space_ids.append(sid)
        hosts.add(host.lower())
    for host, name in ENDPOINT_URL.findall(joined):
        endpoints.append(name)
        hosts.add(host.lower())
    hosts |= {h.lower() for h in DATABRICKS_HOST.findall(joined)}
    for k in SOURCE_ID_KEYS:
        v = raw.get(k)
        if isinstance(v, str) and TOKEN.match(v.strip()):
            space_ids.append(v.strip())
    platform = _first(raw, PLATFORM_KEYS)
    publisher = _first(raw, PUBLISHER_KEYS)
    name = _first(raw, NAME_KEYS)
    url = _first(raw, URL_KEYS)
    if url and not url.lower().startswith(("https://", "http://")):
        url = None
    databricks = bool(hosts) or any("databricks" in (s or "").lower() or "genie" in (s or "").lower() for s in (platform, publisher))
    return {
        "external_id": (external_id or (f"name:{norm_name(name)}" if name else None)),
        "display_name": name, "platform": platform, "publisher": publisher, "url": url,
        "description": (_first(raw, DESCRIPTION_KEYS) or "")[:500] or None,
        "databricks": databricks,
        "hints": {"genie_space_ids": sorted(set(space_ids)), "endpoint_names": sorted(set(endpoints)), "workspace_hosts": sorted(hosts),
                  "workspace": _first(raw, WORKSPACE_KEYS)},
        "record": {k: raw[k] for k in KEEP_KEYS if raw.get(k) not in (None, "", [])},
    }


# ====================================================================== matching
def _host(url: str | None) -> str | None:
    m = re.match(r"https?://([^/]+)", url or "")
    return m.group(1).lower() if m else None


def _candidates(cur) -> list[dict]:
    cur.execute("""SELECT asset_id, display_name, name, subtype, deep_link FROM asset
                    WHERE asset_type = 'agent' AND lifecycle_status NOT IN ('retired','rejected')""")
    return list(cur.fetchall())


def match(rec: dict, agents: list[dict]) -> dict:
    """{asset_id, method, confidence, note} for one normalised record (asset_id None = unmatched)."""
    by_id = {a["asset_id"]: a for a in agents}
    hints = rec["hints"]
    hosts = set(hints["workspace_hosts"])
    for token in hints["genie_space_ids"]:
        for prefix, method, conf in (("agent:genie:", "genie_space_id", 1.0), ("agent:endpoint:", "endpoint_name", 0.95),
                                     ("agent:app:", "app_name", 0.9)):
            a = by_id.get(prefix + token)
            if a:
                return _with_host(a, method, conf, hosts)
    for name in hints["endpoint_names"]:
        a = by_id.get(f"agent:endpoint:{name}")
        if a:
            return _with_host(a, "endpoint_name", 0.95, hosts)
    target = norm_name(rec["display_name"])
    if not target:
        return {"asset_id": None, "method": None, "confidence": None, "note": "no name or identifier"}
    genie = "genie" in (rec.get("platform") or "").lower()
    exact = [a for a in agents if target in (norm_name(a["display_name"]), norm_name(a["name"]))]
    if exact:
        if genie:
            exact = sorted(exact, key=lambda a: a["subtype"] != "genie_space")
        if len(exact) == 1 or (genie and exact[0]["subtype"] == "genie_space" and exact[1]["subtype"] != "genie_space"):
            conf = 0.9 if (not genie or exact[0]["subtype"] == "genie_space") else 0.8
            return {"asset_id": exact[0]["asset_id"], "method": "name", "confidence": conf, "note": "same normalised name"}
        return {"asset_id": exact[0]["asset_id"], "method": "name", "confidence": 0.6,
                "note": f"{len(exact)} agents share this name"}
    best, score = None, 0.0
    for a in agents:
        s = max(difflib.SequenceMatcher(None, target, norm_name(a["display_name"])).ratio(),
                difflib.SequenceMatcher(None, target, norm_name(a["name"])).ratio())
        if genie and a["subtype"] == "genie_space":
            s = min(1.0, s + 0.05)
        if s > score:
            best, score = a, s
    if best and score >= 0.72:
        return {"asset_id": best["asset_id"], "method": "name", "confidence": round(score * 0.85, 2), "note": f"similar name ({score:.0%})"}
    return {"asset_id": None, "method": None, "confidence": None, "note": "no registered agent matches"}


def _with_host(a: dict, method: str, conf: float, hosts: set[str]) -> dict:
    asset_host = _host(a.get("deep_link"))
    if hosts and asset_host and asset_host not in hosts:
        return {"asset_id": a["asset_id"], "method": method, "confidence": round(conf / 2, 2),
                "note": f"the record names another workspace ({', '.join(sorted(hosts))})"}
    return {"asset_id": a["asset_id"], "method": method, "confidence": conf, "note": "identifier in the record"}


# ====================================================================== writes
def _entry(reg: dict) -> dict:
    """One ``also_registered_in`` entry. No volatile fields (sync time lives in asset_field.source_synced_at), so a
    re-import with the same data never looks like a source change."""
    return {k: v for k, v in {
        "registry": REGISTRY_LABEL, "id": reg["external_id"], "url": reg.get("url") or ADMIN_CENTER_URL,
        "display_name": reg.get("display_name"), "platform": reg.get("platform"),
        "match": reg.get("match_method"), "confidence": reg.get("confidence"),
    }.items() if v is not None}


def refresh_field(cur, asset_ids: Iterable[str]) -> int:
    """Recompute the Agent 365 source value of ``also_registered_in`` for these assets. Returns how many changed."""
    from collectors import upserts as up

    changed = 0
    for aid in sorted({a for a in asset_ids if a}):
        cur.execute("SELECT 1 FROM asset WHERE asset_id = %s", (aid,))
        if not cur.fetchone():
            continue
        cur.execute("""SELECT * FROM external_registration WHERE registry = %s AND matched_asset_id = %s AND status IN ('matched','linked')
                        ORDER BY external_id""", (REGISTRY_KEY, aid))
        entries = [_entry(r) for r in cur.fetchall()]
        changed += up.upsert_source_field(cur, aid, FIELD_KEY, entries or None, SOURCE_LABEL)
    return changed


def ingest(cur, raw_records: list[dict], *, source: str, run_id: int | None = None) -> dict:
    """Match and store every Databricks record; refresh the affected assets' field. Returns the counts."""
    agents = _candidates(cur)
    counts = {"records": len(raw_records), "ignored_not_databricks": 0, "matched": 0, "suggested": 0, "unmatched": 0,
              "kept_steward_decision": 0, "fields_changed": 0}
    touched: set[str] = set()
    seen: set[str] = set()
    for raw in raw_records:
        rec = normalize(raw)
        if not rec["databricks"]:
            counts["ignored_not_databricks"] += 1
            continue
        if not rec["external_id"] or rec["external_id"] in seen:
            continue
        seen.add(rec["external_id"])
        m = match(rec, agents)
        status = "unmatched" if not m["asset_id"] else ("matched" if (m["confidence"] or 0) >= AUTO_MATCH else "suggested")
        cur.execute("SELECT * FROM external_registration WHERE registry = %s AND external_id = %s FOR UPDATE", (REGISTRY_KEY, rec["external_id"]))
        old = cur.fetchone()
        if old and old["status"] in ("linked", "dismissed"):
            counts["kept_steward_decision"] += 1
            cur.execute("""UPDATE external_registration SET display_name = %s, platform = %s, publisher = %s, url = %s, record = %s, hints = %s,
                                  last_seen_at = now(), last_run_id = %s, source = %s WHERE registry = %s AND external_id = %s""",
                        (rec["display_name"], rec["platform"], rec["publisher"], rec["url"], Jsonb(rec["record"]), Jsonb({**rec["hints"], "note": m["note"]}),
                         run_id, source, REGISTRY_KEY, rec["external_id"]))
            if old["status"] == "linked":
                touched.add(old["matched_asset_id"])
            continue
        counts[status] += 1
        cur.execute(
            """INSERT INTO external_registration (registry, external_id, display_name, platform, publisher, url, record, hints,
                                                  matched_asset_id, match_method, confidence, status, source, last_run_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (registry, external_id) DO UPDATE SET display_name = EXCLUDED.display_name, platform = EXCLUDED.platform,
                      publisher = EXCLUDED.publisher, url = EXCLUDED.url, record = EXCLUDED.record, hints = EXCLUDED.hints,
                      matched_asset_id = EXCLUDED.matched_asset_id, match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence,
                      status = EXCLUDED.status, source = EXCLUDED.source, last_seen_at = now(), last_run_id = EXCLUDED.last_run_id""",
            (REGISTRY_KEY, rec["external_id"], rec["display_name"], rec["platform"], rec["publisher"], rec["url"], Jsonb(rec["record"]),
             Jsonb({**rec["hints"], "note": m["note"]}), m["asset_id"], m["method"], m["confidence"], status, source, run_id),
        )
        touched.update(filter(None, [m["asset_id"] if status == "matched" else None, (old or {}).get("matched_asset_id")]))
    counts["fields_changed"] = refresh_field(cur, touched)
    counts["assets_linked"] = len({a for a in touched if a})
    return counts


def import_file(cur, *, content: str, filename: str | None, fmt: str | None, p: authz.Principal) -> dict:
    """An admin uploads an M365 admin-center export. One sync_run row (collector agent365) + one audit row."""
    authz.require(p.is_admin, "Only an admin can import a Microsoft Agent 365 export")
    if not tables_exist(cur):
        raise Conflict("Agent 365 import needs migration 007 (run the setup job)")
    records = parse_records(content, filename, fmt)
    cur.execute("""INSERT INTO sync_run (collector, status, triggered_by, detail) VALUES ('agent365', 'running', %s, %s) RETURNING run_id""",
                (p.email, Jsonb({"input": "file", "filename": (filename or "")[:200]})))
    run_id = cur.fetchone()["run_id"]
    counts = ingest(cur, records, source="file", run_id=run_id)
    cur.execute("""UPDATE sync_run SET status = 'succeeded', finished_at = now(), items_seen = %s, items_changed = %s, detail = detail || %s
                    WHERE run_id = %s""", (counts["records"], counts["fields_changed"], Jsonb(counts), run_id))
    audit.audit_event(p.email, "agent365.import", "agent365", run_id, after={"filename": (filename or "")[:200], **counts},
                      request_id=p.request_id, cur=cur)
    return {"run_id": run_id, **counts}


def review(cur, *, external_id: str, action: str, asset_id: str | None, reason: str, p: authz.Principal) -> dict:
    """Steward decision on one record: link it to an asset (confirm or correct a match), dismiss it, or reopen it."""
    authz.require(p.is_steward, "Only a steward or admin can review Agent 365 registrations")
    if action not in ("link", "dismiss", "reopen"):
        raise ValueError("action must be link, dismiss or reopen")
    if not (reason or "").strip():
        raise ValueError("A reason is required")
    cur.execute("SELECT * FROM external_registration WHERE registry = %s AND external_id = %s FOR UPDATE", (REGISTRY_KEY, external_id))
    row = cur.fetchone()
    if not row:
        raise NotFound(f"registration {external_id} not found")
    before = {k: row[k] for k in ("status", "matched_asset_id", "match_method", "confidence")}
    if action == "link":
        target = asset_id or row["matched_asset_id"]
        if not target:
            raise ValueError("Pick the asset to link this registration to")
        cur.execute("SELECT asset_type FROM asset WHERE asset_id = %s", (target,))
        a = cur.fetchone()
        if not a:
            raise NotFound(f"asset {target} not found")
        if a["asset_type"] != "agent":
            raise ValueError("Agent 365 registrations link to agents")
        new = {"status": "linked", "matched_asset_id": target, "match_method": "steward", "confidence": 1.0}
    elif action == "dismiss":
        new = {"status": "dismissed", "matched_asset_id": None, "match_method": None, "confidence": None}
    else:
        new = {"status": "unmatched", "matched_asset_id": None, "match_method": None, "confidence": None}
    cur.execute("""UPDATE external_registration SET status = %(status)s, matched_asset_id = %(matched_asset_id)s, match_method = %(match_method)s,
                          confidence = %(confidence)s, reviewed_by = %(by)s, reviewed_at = now(), review_note = %(note)s
                    WHERE registry = %(reg)s AND external_id = %(id)s RETURNING *""",
                {**new, "by": p.email, "note": reason.strip()[:1000], "reg": REGISTRY_KEY, "id": external_id})
    after = cur.fetchone()
    refresh_field(cur, [row["matched_asset_id"], new["matched_asset_id"]])
    audit.audit_event(p.email, f"agent365.{action}", "agent365_registration", external_id, before=before,
                      after={**new, "reason": reason.strip()}, request_id=p.request_id, cur=cur)
    return after


# ====================================================================== status
def tables_exist(cur) -> bool:
    cur.execute("SELECT to_regclass('external_registration') IS NOT NULL AS ok")
    return bool(cur.fetchone()["ok"])


def graph_connection() -> str | None:
    """The UC HTTP connection that reaches Microsoft Graph (AGENT365_CONNECTION; "none"/unset = disabled)."""
    import os

    name = os.environ.get("AGENT365_CONNECTION", "").strip()
    return None if name.lower() in ("", "none") else name


def overview(cur, p: authz.Principal) -> dict:
    authz.require(p.can_read_everything, "Agent 365 interop is for stewards, admins and auditors")
    conn = graph_connection()
    base = {"registry": REGISTRY_LABEL, "graph": {"configured": bool(conn), "connection": conn,
                                                    "endpoint": "GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages"},
            "auto_match": AUTO_MATCH, "can_import": p.is_admin, "can_review": p.is_steward}
    if not tables_exist(cur):
        return {**base, "available": False, "counts": {}, "review": [], "linked": [], "runs": []}
    cur.execute("SELECT status, count(*) AS n FROM external_registration WHERE registry = %s GROUP BY status", (REGISTRY_KEY,))
    counts = {r["status"]: int(r["n"]) for r in cur.fetchall()}
    cols = """r.external_id, r.display_name, r.platform, r.publisher, r.url, r.hints, r.matched_asset_id, r.match_method, r.confidence,
              r.status, r.source, r.first_seen_at, r.last_seen_at, r.reviewed_by, r.reviewed_at, r.review_note,
              a.display_name AS asset_display_name"""
    cur.execute(f"""SELECT {cols} FROM external_registration r LEFT JOIN asset a ON a.asset_id = r.matched_asset_id
                     WHERE r.registry = %s AND r.status IN ('suggested','unmatched')
                     ORDER BY (r.status = 'suggested') DESC, r.confidence DESC NULLS LAST, r.display_name LIMIT 500""", (REGISTRY_KEY,))
    queue = list(cur.fetchall())
    cur.execute(f"""SELECT {cols} FROM external_registration r LEFT JOIN asset a ON a.asset_id = r.matched_asset_id
                     WHERE r.registry = %s AND r.status IN ('matched','linked','dismissed')
                     ORDER BY r.status, a.display_name NULLS LAST, r.display_name LIMIT 500""", (REGISTRY_KEY,))
    decided = list(cur.fetchall())
    cur.execute("""SELECT run_id, collector, started_at, finished_at, status, items_seen, items_changed, error, triggered_by, detail
                     FROM sync_run WHERE collector = 'agent365' ORDER BY started_at DESC LIMIT 10""")
    return {**base, "available": True, "counts": counts, "review": queue, "linked": decided, "runs": list(cur.fetchall())}
