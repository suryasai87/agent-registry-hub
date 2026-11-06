"""Is Unity Catalog lineage publishing ready? Read-only checks of what a publish needs, per publishing identity.

A publish (``registry/uc_lineage.py``) needs, for the identity that calls the API:

* (a) ``CREATE EXTERNAL METADATA`` on the metastore. Only a metastore admin can grant it. **Blocking.**
* (b) ``MODIFY`` on each UC table a relationship touches, granted by the table's owner. Not blocking: without it only
  the relationships to that table fail (the run is ``partial``), and the next plan retries them.
* (c) the external lineage API answering for that identity (feature on, token scopes). **Blocking.**

Identity paths:

* ``app``: a publish from Governance when the Apps proxy forwards no user token. That is the app service principal,
  named by its application id (``DATABRICKS_CLIENT_ID``); locally, the identity of the CLI profile.
* ``obo``: a publish from Governance when the proxy forwards the signed-in admin's token (on-behalf-of). That is the
  admin, by email. The permission lookups use the app's client, because the forwarded token may lack the
  ``unity-catalog`` scope; check (c) uses the forwarded token itself, so a missing scope shows up there.
* ``sync``: the hourly sync step, as the job's run-as identity (``SYNC_JOB_ID`` → Jobs API ``run_as_user_name``).
  From the app only (a) and (b) are checked; the step runs all three itself before it publishes (``for_sync``).

APIs (verified read-only on your-workspace, 2026-10-28):

* ``GET /api/2.1/unity-catalog/current-metastore-assignment`` gives ``metastore_id``; ``GET …/metastore_summary``
  gives the name and the owner (members of the owner hold every privilege implicitly).
* ``GET /api/2.1/unity-catalog/effective-permissions/metastore/<id>?principal=<p>`` gives ``privilege_assignments``
  ``[{principal, privileges: [{privilege, inherited_from_type, inherited_from_name}]}]`` for ``p`` and its groups.
  The privilege is named ``CREATE_EXTERNAL_METADATA``. The same call on ``table/<fqn>`` shows ``MODIFY`` or
  ``ALL_PRIVILEGES``, possibly inherited from the schema or catalog. Ownership is not listed, so the table's
  ``owner`` (tables API) is compared too.
* ``GET /api/2.0/lineage-tracking/external-metadata?page_size=1``, a harmless list, for reachability.

Never raises for an API failure: the check becomes ``unknown`` with the reason. Results are cached for ``TTL`` seconds.
"""
from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from core import audit, tiers
from core.lakebase import describe_error
from registry import authz, provision, settings, uc_lineage
from registry.uc_grants import even_sample, grant_metastore_sql, grant_table_sql, principal_kind

log = logging.getLogger("registry.uc_readiness")

METASTORE_PRIVILEGES = frozenset({"CREATE_EXTERNAL_METADATA", "ALL_PRIVILEGES"})
TABLE_PRIVILEGES = frozenset({"MODIFY", "ALL_PRIVILEGES"})
MAX_TABLES = int(os.environ.get("UC_READINESS_MAX_TABLES", "20"))   # table lookups per identity; the rest is "not checked"
TTL = float(os.environ.get("UC_READINESS_TTL", "300"))
UNKNOWN_TTL = 30.0                     # an inconclusive answer is retried sooner
WORKERS = 6
SYNC_KEY = "uc_lineage_sync_readiness"  # registry_setting: what the sync step saw last time
GRANTS_SCRIPT = "python3 scripts/uc_lineage_grants.py <target> <profile>"

ASSIGNMENT_PATH = "/api/2.1/unity-catalog/current-metastore-assignment"
SUMMARY_PATH = "/api/2.1/unity-catalog/metastore_summary"
EFFECTIVE_PATH = "/api/2.1/unity-catalog/effective-permissions"
TABLES_PATH = "/api/2.1/unity-catalog/tables"
ME_PATH = "/api/2.0/preview/scim/v2/Me"
JOBS_GET_PATH = "/api/2.1/jobs/get"

_cache = tiers.TTLCache(ttl=TTL, maxsize=32)


def invalidate() -> int:
    return _cache.invalidate()


# ====================================================================== API helpers
def _code(e: BaseException) -> int | None:
    try:
        return uc_lineage._status_code(e)
    except Exception:  # noqa: BLE001 - the SDK error table is optional here
        value = getattr(e, "status_code", None)
        return value if isinstance(value, int) else None


def _error_code(e: BaseException) -> str:
    return str(getattr(e, "error_code", "") or "").upper()


def _not_found(e: BaseException) -> bool:
    return _code(e) == 404 or any(k in _error_code(e) for k in ("NOT_FOUND", "DOES_NOT_EXIST"))


def _denied(e: BaseException) -> bool:
    return _code(e) in (401, 403) or any(k in _error_code(e) for k in ("PERMISSION_DENIED", "UNAUTHENTICATED"))


def metastore_info(w) -> dict:
    """``{metastore_id, name, owner}`` for the workspace's metastore. Raises when the assignment cannot be read."""
    a = w.api_client.do("GET", ASSIGNMENT_PATH) or {}
    mid = a.get("metastore_id")
    if not mid:
        raise RuntimeError("this workspace has no metastore assignment")
    info = {"metastore_id": mid, "name": None, "owner": None, "default_catalog_name": a.get("default_catalog_name")}
    try:
        s = w.api_client.do("GET", SUMMARY_PATH) or {}
        info.update(name=s.get("name"), owner=s.get("owner"))
    except Exception as e:  # noqa: BLE001 - only the id is needed; the owner only improves the message
        log.info("metastore summary unavailable: %s", describe_error(e))
    return info


def _effective(w, securable: str, full_name: str, principal: str) -> list[dict]:
    res = w.api_client.do("GET", f"{EFFECTIVE_PATH}/{securable}/{quote(full_name, safe='.')}", query={"principal": principal}) or {}
    out: list[dict] = []
    for a in res.get("privilege_assignments") or []:
        for pr in a.get("privileges") or []:
            entry = {"privilege": pr} if isinstance(pr, str) else dict(pr)
            out.append({"principal": a.get("principal"), **entry})
    return out


def _via(hit: dict) -> str:
    who = hit.get("principal") or "?"
    src = hit.get("inherited_from_type")
    return f"{who}, inherited from {str(src).lower()} {hit.get('inherited_from_name')}" if src else f"{who}, granted directly"


def me(w) -> dict:
    """``{user_name, groups}`` of the identity behind ``w`` (SCIM Me: an SP's userName is its application id)."""
    res = w.api_client.do("GET", ME_PATH) or {}
    return {"user_name": res.get("userName"), "groups": sorted({g.get("display") for g in res.get("groups") or [] if g.get("display")})}


def _holder(owner: str | None, principal: str, groups: list[str] | None) -> bool:
    return bool(owner) and (owner == principal or owner in (groups or []))


# ====================================================================== checks
def check_metastore(w, principal: str, meta: dict | None, *, meta_error: str | None = None, groups: list[str] | None = None) -> dict:
    owner = (meta or {}).get("owner")
    run_by = f"A metastore admin (a member of the metastore owner {owner})" if owner else "A metastore admin"
    base = {"id": "metastore_privilege", "title": "CREATE EXTERNAL METADATA on the metastore", "blocking": True,
            "remediation": {"sql": [grant_metastore_sql(principal)], "run_by": run_by}}
    if meta is None:
        return {**base, "status": "unknown", "detail": f"Couldn't read the workspace's metastore: {meta_error or 'no answer'}"}
    label = meta.get("name") or meta["metastore_id"]
    try:
        hits = _effective(w, "metastore", meta["metastore_id"], principal)
    except Exception as e:  # noqa: BLE001
        return {**base, "status": "unknown", "detail": f"Couldn't read effective permissions on metastore {label}: {describe_error(e)}"}
    held = [h for h in hits if h.get("privilege") in METASTORE_PRIVILEGES]
    if held:
        return {**base, "status": "ok", "detail": f"Held on metastore {label} ({_via(held[0])}).", "remediation": None}
    if _holder(owner, principal, groups):
        return {**base, "status": "ok", "detail": f"{principal} is a metastore admin ({owner}): every privilege is implicit.", "remediation": None}
    detail = f"{principal} does not hold CREATE EXTERNAL METADATA on metastore {label}."
    if owner and groups is None:
        detail += f" Members of the metastore owner ({owner}) hold it implicitly; membership was not checked."
    return {**base, "status": "missing", "detail": detail}


def _check_table(w, table: str, principal: str, groups: list[str] | None) -> dict:
    try:
        hits = _effective(w, "table", table, principal)
    except Exception as e:  # noqa: BLE001
        if _not_found(e):
            return {"table": table, "status": "not_found", "detail": "Table not found (or not visible to the checking identity): its relationships will fail"}
        return {"table": table, "status": "unknown", "detail": describe_error(e, 200)}
    held = [h for h in hits if h.get("privilege") in TABLE_PRIVILEGES]
    if held:
        return {"table": table, "status": "ok", "detail": _via(held[0])}
    owner = None
    try:
        owner = (w.api_client.do("GET", f"{TABLES_PATH}/{quote(table, safe='.')}", query={"include_browse": "true"}) or {}).get("owner")
    except Exception as e:  # noqa: BLE001 - the owner only improves the message
        log.debug("table owner of %s unavailable: %s", table, describe_error(e))
    if _holder(owner, principal, groups):
        return {"table": table, "status": "ok", "detail": f"owner ({owner})", "owner": owner}
    return {"table": table, "status": "missing", "owner": owner, "sql": grant_table_sql(table, principal),
            "detail": "No MODIFY" + (f"; the owner is {owner}" if owner else "")}


def check_tables(w, principal: str, tables: list[str] | None, *, tables_error: str | None = None, groups: list[str] | None = None,
                 max_tables: int | None = None) -> dict:
    cap = MAX_TABLES if max_tables is None else max_tables
    base = {"id": "table_modify", "title": "MODIFY on the tables the relationships touch", "blocking": False,
            "remediation": None, "tables": [], "total": len(tables or []), "checked": 0, "unchecked": 0}
    if tables is None:
        return {**base, "status": "unknown", "detail": f"The plan is unavailable, so its tables are unknown: {tables_error or 'no answer'}"}
    if not tables:
        return {**base, "status": "ok", "detail": "The plan touches no Unity Catalog tables."}
    sample = even_sample(list(tables), cap)
    with ThreadPoolExecutor(max_workers=max(1, min(WORKERS, len(sample)))) as pool:
        rows = list(pool.map(lambda t: _check_table(w, t, principal, groups), sample)) if sample else []
    n = {k: sum(1 for r in rows if r["status"] == k) for k in ("ok", "missing", "not_found", "unknown")}
    unchecked = len(tables) - len(sample)
    parts = [f"{n['ok']} of {len(sample)} checked table(s) have it"]
    if n["missing"]:
        parts.append(f"{n['missing']} without MODIFY")
    if n["not_found"]:
        parts.append(f"{n['not_found']} not found")
    if n["unknown"]:
        parts.append(f"{n['unknown']} could not be checked")
    if unchecked:
        parts.append(f"{unchecked} not checked (the check samples {cap}, spread over the list)")
    status = "missing" if n["missing"] else "unknown" if n["unknown"] else "warning" if n["not_found"] else "ok"
    sql = [r["sql"] for r in rows if r.get("sql")]
    remediation = None
    if sql or unchecked:
        remediation = {"sql": sql, "run_by": "Each table's owner (or anyone with MANAGE on the table, its schema or its catalog)",
                       "note": (f"{unchecked} more table(s) were not checked: {GRANTS_SCRIPT} prints a GRANT for every table in the plan."
                                if unchecked else None)}
    return {**base, "status": status, "detail": "; ".join(parts) + ".", "tables": rows, "checked": len(sample),
            "unchecked": unchecked, "remediation": remediation}


SCOPE_FIX = ("Add the unity-catalog user authorization scope to the app (Compute › Apps › the app › Edit › User authorization, or "
             "user_api_scopes in the bundle's app resource), redeploy, and have the admin sign in again. Publishes then run as the "
             "admin, who needs the grants above.")


def check_api(w, *, label: str = "this identity") -> dict:
    base = {"id": "api_reachable", "title": "External lineage API answers", "blocking": True, "remediation": None}
    if w is None:
        return {**base, "status": "skipped", "detail": "Checked by the sync step itself, as the job's identity, before it publishes."}
    try:
        w.api_client.do("GET", uc_lineage.EM_PATH, query={"page_size": 1})
        return {**base, "status": "ok", "detail": f"GET {uc_lineage.EM_PATH}?page_size=1 answered for {label}."}
    except Exception as e:  # noqa: BLE001
        msg = describe_error(e, 300)
        if _denied(e):
            scope = "scope" in msg.lower()
            return {**base, "status": "missing", "detail": f"The API refused {label}: {msg}",
                    "remediation": {"sql": [], "run_by": "The app's owner (CAN MANAGE on the app)" if scope else "A workspace admin",
                                    "note": SCOPE_FIX if scope else "The identity cannot use the external lineage API in this workspace."}}
        if _not_found(e) or any(k in (_error_code(e) + msg.upper()) for k in ("ENDPOINT_NOT_FOUND", "FEATURE_DISABLED", "NOT_IMPLEMENTED")):
            return {**base, "status": "missing", "detail": f"The external lineage API is not available in this workspace: {msg}",
                    "remediation": {"sql": [], "run_by": "A workspace admin", "note": "Unity Catalog external lineage must be enabled for this workspace."}}
        return {**base, "status": "unknown", "detail": f"Couldn't reach the API: {msg}"}


def summarize(checks: list[dict]) -> tuple[str, str | None]:
    """(status, reason). blocked: a blocking check is missing. unknown: some check is inconclusive. partial: the
    blocking checks pass but some tables lack MODIFY (or are missing), so those relationships fail. ready: all pass."""
    blocking_missing = [c for c in checks if c["blocking"] and c["status"] == "missing"]
    if blocking_missing:
        return "blocked", " ".join(c["detail"] for c in blocking_missing)
    unknown = [c for c in checks if c["status"] == "unknown"]
    if unknown:
        return "unknown", " ".join(c["detail"] for c in unknown)
    partial = [c for c in checks if c["status"] in ("missing", "warning")]
    if partial:
        return "partial", " ".join(c["detail"] for c in partial)
    return "ready", None


def check_identity(*, path: str, label: str, applies_to: str, principal: str | None, lookup, own=None, own_label: str | None = None,
                   tables: list[str] | None, tables_error: str | None = None, meta: dict | None, meta_error: str | None = None,
                   groups: list[str] | None = None, identity_error: str | None = None, memo: dict | None = None,
                   max_tables: int | None = None) -> dict:
    """The three checks for one identity. ``lookup`` reads permissions; ``own`` (the identity's own client, or None)
    probes the API. ``memo`` shares (a) and (b) between paths that resolve to the same principal."""
    out = {"path": path, "label": label, "applies_to": applies_to, "principal": principal, "principal_kind": principal_kind(principal)}
    if not principal:
        checks = [{"id": "identity", "title": "Publishing identity", "blocking": True, "status": "unknown", "remediation": None,
                   "detail": f"Couldn't resolve the identity: {identity_error or 'unknown'}"}]
        status, reason = summarize(checks)
        return {**out, "status": status, "reason": reason, "checks": checks, "remediation_sql": []}
    key = (principal, tuple(groups) if groups is not None else None)
    shared = (memo or {}).get(key)
    if shared is None:
        shared = (check_metastore(lookup, principal, meta, meta_error=meta_error, groups=groups),
                  check_tables(lookup, principal, tables, tables_error=tables_error, groups=groups, max_tables=max_tables))
        if memo is not None:
            memo[key] = shared
    checks = [*shared, check_api(own, label=own_label or principal)]
    status, reason = summarize(checks)
    sql = [s for c in checks if c.get("remediation") for s in c["remediation"].get("sql") or []]
    return {**out, "status": status, "reason": reason, "checks": checks, "remediation_sql": sql}


# ====================================================================== the app's endpoint
def _lookup_client():
    return provision._client(None)[0]


def _obo_client(token: str):
    return provision._client(token)[0]


def _plan_inputs(app_url: str | None) -> tuple[list[str] | None, str | None, dict | None]:
    """(plan tables, why they are unavailable, last sync-step check) from Lakebase, in a short read-only transaction."""
    from core import db

    try:
        with db.transaction() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            if not uc_lineage.tables_exist(cur):
                return None, "migration 007 is not applied", None
            last = settings.get(cur, SYNC_KEY) if settings.table_exists(cur) else None
            return uc_lineage.plan(cur, app_url=app_url, mode="platform")["tables"], None, last
    except Exception as e:  # noqa: BLE001 - readiness still checks the metastore and the API
        return None, f"Lakebase: {describe_error(e, 200)}", None


def _sync_principal(lookup) -> tuple[str | None, str | None]:
    job_id = os.environ.get("SYNC_JOB_ID", "").strip()
    if not job_id:
        return None, "SYNC_JOB_ID is not set here (the app resource sync-job provides it on Databricks Apps)"
    try:
        job = lookup.api_client.do("GET", JOBS_GET_PATH, query={"job_id": job_id}) or {}
    except Exception as e:  # noqa: BLE001
        return None, f"Couldn't read sync job {job_id}: {describe_error(e, 200)}"
    run_as = (job.get("settings") or {}).get("run_as") or {}
    who = job.get("run_as_user_name") or run_as.get("service_principal_name") or run_as.get("user_name") or job.get("creator_user_name")
    return (who, None) if who else (None, f"sync job {job_id} names no run-as identity")


def _app_principal(lookup) -> tuple[str | None, list[str] | None, str | None]:
    groups = None
    try:
        info = me(lookup)
        groups = info["groups"]
        who = os.environ.get("DATABRICKS_CLIENT_ID", "").strip() or info["user_name"]
        return who, groups, None
    except Exception as e:  # noqa: BLE001
        who = os.environ.get("DATABRICKS_CLIENT_ID", "").strip()
        return (who or None), None, (None if who else f"Couldn't read the app identity: {describe_error(e, 200)}")


def compute(*, user_email: str | None, user_token: str | None, app_url: str | None = None, lookup=None, obo=None,
            max_tables: int | None = None) -> dict:
    """Readiness for the paths a publish can take from this app. Never raises."""
    tables, tables_error, last_sync = _plan_inputs(app_url)
    paths: list[dict] = []
    meta = meta_error = None
    try:
        lookup = lookup if lookup is not None else _lookup_client()
    except Exception as e:  # noqa: BLE001
        lookup, lookup_error = None, f"Couldn't build the app's workspace client: {describe_error(e, 200)}"
    else:
        lookup_error = None
    if lookup is not None:
        try:
            meta = metastore_info(lookup)
        except Exception as e:  # noqa: BLE001
            meta_error = describe_error(e, 200)
    memo: dict = {}
    common = {"lookup": lookup, "tables": tables, "tables_error": tables_error, "meta": meta, "meta_error": meta_error, "memo": memo,
              "max_tables": max_tables}

    if lookup is None:
        app_who, app_groups, app_err = None, None, lookup_error
    else:
        app_who, app_groups, app_err = _app_principal(lookup)
    app_path = check_identity(path="app", label="App service principal" if os.environ.get("DATABRICKS_CLIENT_ID") else "App identity (local profile)",
                              applies_to="Publish from this page when no user token is forwarded", principal=app_who, own=lookup,
                              own_label="the app service principal", groups=app_groups, identity_error=app_err, **common)
    if user_token:
        try:
            own = obo if obo is not None else _obo_client(user_token)
            try:
                obo_groups = me(own)["groups"]
            except Exception as e:  # noqa: BLE001 - membership only matters for metastore admins
                log.info("OBO identity groups unavailable: %s", describe_error(e))
                obo_groups = None
            obo_path = check_identity(path="obo", label="You (on-behalf-of)", applies_to="Publish from this page (your forwarded token is used)",
                                      principal=user_email, own=own, own_label="your forwarded token", groups=obo_groups, **common)
        except Exception as e:  # noqa: BLE001
            obo_path = check_identity(path="obo", label="You (on-behalf-of)", applies_to="Publish from this page (your forwarded token is used)",
                                      principal=None, identity_error=f"Couldn't use the forwarded token: {describe_error(e, 200)}", **common)
        paths += [obo_path, app_path]
    else:
        paths.append(app_path)

    if lookup is None:
        sync_who, sync_err = None, lookup_error
    else:
        sync_who, sync_err = _sync_principal(lookup)
    sync_path = check_identity(path="sync", label="Sync job identity", applies_to="Publish during the hourly sync (when turned on)",
                               principal=sync_who, own=None, identity_error=sync_err, **common)
    sync_path["last_check"] = last_sync
    paths.append(sync_path)

    active = paths[0]
    return {
        "status": active["status"], "reason": active["reason"], "active_path": active["path"], "mode": "platform", "enforced": True,
        "obo_token_forwarded": bool(user_token), "metastore": meta, "paths": paths,
        "tables": {"total": len(tables or []), "max_checked": MAX_TABLES if max_tables is None else max_tables, "error": tables_error},
        "remediation_sql": active["remediation_sql"], "grants_script": GRANTS_SCRIPT,
        "checked_at": tiers.now_iso(), "cached": False, "ttl_seconds": int(TTL),
    }


def not_required(mode: str) -> dict:
    return {"status": "not_required", "reason": "Record-only mode sends nothing to Unity Catalog, so no privileges are needed. "
            "The checks run when PROVISIONING_MODE is platform (the default on Databricks Apps).",
            "active_path": None, "mode": mode, "enforced": False, "obo_token_forwarded": False, "metastore": None, "paths": [],
            "tables": {"total": 0, "max_checked": MAX_TABLES, "error": None}, "remediation_sql": [], "grants_script": GRANTS_SCRIPT,
            "checked_at": tiers.now_iso(), "cached": False, "ttl_seconds": int(TTL)}


def readiness(p: authz.Principal, *, user_token: str | None = None, app_url: str | None = None, refresh: bool = False,
              mode: str | None = None) -> dict:
    """``GET /api/lineage/uc-publish/readiness``: stewards, admins and auditors. Cached for TTL seconds per identity."""
    authz.require(p.can_read_everything, "Unity Catalog lineage readiness is for stewards, admins and auditors")
    mode = mode or provision.mode()
    if mode != "platform":
        return not_required(mode)
    key = {"obo": p.email if user_token else None}
    if not refresh:
        found, value = _cache.get("readiness", key)
        if found:
            return {**value, "cached": True}
    try:
        result = compute(user_email=p.email, user_token=user_token, app_url=app_url)
    except Exception as e:  # noqa: BLE001 - belt and braces: readiness never 500s
        log.warning("UC lineage readiness failed: %s", describe_error(e))
        result = {**not_required("platform"), "status": "unknown", "enforced": True, "reason": f"The readiness check failed: {describe_error(e, 300)}"}
    _cache.set("readiness", key, result, ttl=UNKNOWN_TTL if result["status"] == "unknown" else TTL)
    return result


# ====================================================================== the sync step
def for_sync(client, tables: list[str] | None, *, max_tables: int | None = None) -> dict:
    """All three checks for the sync job's own identity, with its own client. Never raises."""
    try:
        info = me(client)
        principal, groups, err = info["user_name"], info["groups"], None
    except Exception as e:  # noqa: BLE001
        principal, groups, err = None, None, describe_error(e, 200)
    meta = meta_error = None
    try:
        meta = metastore_info(client)
    except Exception as e:  # noqa: BLE001
        meta_error = describe_error(e, 200)
    return check_identity(path="sync", label="Sync job identity", applies_to="Publish during the hourly sync", principal=principal,
                          lookup=client, own=client, own_label="the sync job identity", tables=tables, meta=meta, meta_error=meta_error,
                          groups=groups, identity_error=err, max_tables=max_tables)


def summary(result: dict) -> dict:
    return {"status": result["status"], "reason": result["reason"], "principal": result.get("principal"),
            "checks": [{"id": c["id"], "status": c["status"], "detail": c["detail"][:300]} for c in result["checks"]]}


def record_sync(cur, result: dict, *, triggered_by: str, skipped: bool) -> None:
    """The status row (registry_setting ``uc_lineage_sync_readiness``) on every run, plus one audit row when the step is
    skipped for a reason it was not already skipped for (hourly repeats of the same block would only add noise)."""
    if not settings.table_exists(cur):
        return
    prev = settings.get(cur, SYNC_KEY) or {}
    value = {**summary(result), "skipped": skipped, "triggered_by": triggered_by, "checked_at": tiers.now_iso()}
    settings.remember(cur, SYNC_KEY, value, actor="system:sync")
    same = prev.get("skipped") and (prev.get("status"), prev.get("reason")) == (value["status"], value["reason"])
    if skipped and not same:
        audit.audit_event("system:sync", "lineage.uc_publish_skipped", "uc_lineage", "sync",
                          before={k: prev.get(k) for k in ("status", "reason", "skipped")} if prev else None,
                          after={k: value[k] for k in ("status", "reason", "principal", "triggered_by", "checks")},
                          cur=cur, source="job")
