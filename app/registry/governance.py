"""Steward/admin governance: sources & sync, curation, overrides, roles, and registration of custom assets."""
from __future__ import annotations

import logging
import os
import re
import threading

from psycopg.types.json import Jsonb

from core import audit, config, identity
from core.guard import Conflict, NotFound
from registry import authz, cards, fields

log = logging.getLogger("registry.governance")

COLLECTOR_LABELS = {
    "agent_endpoints": "Agents on Model Serving endpoints", "agent_bricks": "Agent Bricks (Supervisor, Knowledge Assistant)",
    "genie": "Genie spaces", "mcp_connections": "External / custom MCP (UC connections)",
    "mcp_managed": "Managed MCP (UC functions)", "mcp_system": "Databricks-provided MCP (Unity AI Gateway)",
    "skills": "UC skills", "apps": "Databricks Apps (consumers, agent runtime)",
    "agent365": "Microsoft Agent 365 registrations (Graph or file import)", "usage": "Usage (system tables + audit)",
    "cost": "Cost (billing × list prices)", "traces_evals": "MLflow traces & evals",
}


def sources(cur) -> dict:
    cur.execute("""SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY collector ORDER BY started_at DESC) AS rn FROM sync_run) s
                    WHERE rn <= 10 ORDER BY collector, started_at DESC""")
    by: dict[str, list] = {}
    for r in cur.fetchall():
        r.pop("rn", None)
        r.pop("detail", None)
        by.setdefault(r["collector"], []).append(r)
    names = list(COLLECTOR_LABELS) + [c for c in by if c not in COLLECTOR_LABELS]
    job_id = os.environ.get("SYNC_JOB_ID", "").strip() or None
    url = None
    if job_id:
        try:
            from core.lakebase import workspace_client
            url = f"{workspace_client().config.host.rstrip('/')}/jobs/{job_id}"
        except Exception:  # noqa: BLE001
            url = None
    return {"collectors": [{"collector": c, "label": COLLECTOR_LABELS.get(c, c), "last": (by.get(c) or [None])[0],
                            "history": by.get(c, [])} for c in names],
            "job": {"configured": bool(job_id), "job_id": job_id, "url": url}}


_inproc_lock = threading.Lock()


def trigger_sync(p: authz.Principal, collectors: list[str] | None) -> dict:
    authz.require(p.is_steward, "Only a steward or admin can trigger a sync")
    job_id = os.environ.get("SYNC_JOB_ID", "").strip()
    if job_id:
        from core.lakebase import workspace_client
        w = workspace_client()
        params = {"collectors": ",".join(collectors)} if collectors else None
        run = w.jobs.run_now(job_id=int(job_id), job_parameters=params)
        run_id = getattr(run, "run_id", None) or getattr(getattr(run, "response", None), "run_id", None)
        return {"ok": True, "run": {"mode": "job", "job_id": job_id, "run_id": run_id,
                                    "url": f"{w.config.host.rstrip('/')}/jobs/{job_id}/runs/{run_id}" if run_id else None}}
    try:
        from collectors.base import run_all
    except ImportError as e:
        raise Conflict(f"No sync job is configured (SYNC_JOB_ID) and in-process collectors are unavailable: {e}")
    if not _inproc_lock.acquire(blocking=False):
        raise Conflict("A sync is already running in this app instance")

    def work():
        try:
            run_all(collectors, triggered_by=p.email)
        except Exception:  # noqa: BLE001
            log.exception("in-process sync failed")
        finally:
            _inproc_lock.release()

    threading.Thread(target=work, name="registry-sync", daemon=True).start()
    return {"ok": True, "run": {"mode": "in_process", "collectors": collectors or "all",
                                "note": "Running inside the app with the app service principal's visibility; progress appears under Sources."}}


def curation(cur, viewer: str) -> dict:
    cur.execute("SELECT asset_id FROM asset WHERE lifecycle_status = 'discovered' ORDER BY first_seen_at DESC LIMIT 100")
    discovered = cards.cards(cur, [r["asset_id"] for r in cur.fetchall()], viewer)
    cur.execute("SELECT asset_id FROM asset WHERE lifecycle_status = 'pending_approval' ORDER BY first_seen_at DESC LIMIT 100")
    pending = cards.cards(cur, [r["asset_id"] for r in cur.fetchall()], viewer)
    cur.execute("""SELECT a.asset_id FROM asset a WHERE a.asset_type IN ('agent','mcp_server','skill') AND a.lifecycle_status NOT IN ('retired','rejected')
                     AND NOT EXISTS (SELECT 1 FROM asset_owner o WHERE o.asset_id = a.asset_id AND o.kind IN ('owner','co_owner'))
                   ORDER BY a.display_name LIMIT 100""")
    ownerless = cards.cards(cur, [r["asset_id"] for r in cur.fetchall()], viewer)
    cur.execute("""SELECT f.asset_id, a.display_name, f.field_key, f.source_value, f.override_value FROM asset_field f
                     JOIN asset a ON a.asset_id = f.asset_id WHERE f.drift ORDER BY a.display_name LIMIT 200""")
    return {"discovered": discovered, "pending_approval": pending, "ownerless": ownerless, "drifted": list(cur.fetchall())}


def curate(cur, asset_id: str, action: str, reason: str, *, p: authz.Principal) -> dict:
    authz.require(p.is_steward, "Only a steward or admin can curate assets")
    if action not in ("approve", "reject"):
        raise ValueError("action must be approve or reject")
    if not (reason or "").strip():
        raise ValueError("A reason is required")
    cur.execute("SELECT * FROM asset WHERE asset_id = %s FOR UPDATE", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    if a["lifecycle_status"] not in ("discovered", "pending_approval", "draft"):
        raise Conflict(f"This asset is already {a['lifecycle_status']}")
    new = "approved" if action == "approve" else "rejected"
    cur.execute("UPDATE asset SET lifecycle_status = %s, updated_at = now() WHERE asset_id = %s", (new, asset_id))
    audit.audit_event(p.email, f"curation.{action}", "asset", asset_id, before={"lifecycle_status": a["lifecycle_status"]},
                      after={"lifecycle_status": new, "reason": reason}, request_id=p.request_id, cur=cur)
    if a.get("created_by") and "@" in a["created_by"]:
        from registry import notify
        notify.queue(cur, a["created_by"], "curation", f"{a['display_name']} was {new} by a steward", reason, asset_id)
    return cards.card(cur, asset_id, p.email)


def set_governance(cur, asset_id: str, patch: dict, *, p: authz.Principal, perms: dict) -> dict:
    """Certification, sensitivity, risk tier, domain, tags and lifecycle. Owners may set domain/tags/sensitivity (up)."""
    cur.execute("SELECT * FROM asset WHERE asset_id = %s FOR UPDATE", (asset_id,))
    a = cur.fetchone()
    if not a:
        raise NotFound(f"asset {asset_id} not found")
    allowed_owner = {"domain", "tags", "sensitivity"}
    allowed_steward = allowed_owner | {"certification", "risk_tier", "lifecycle_status"}
    patch = {k: v for k, v in patch.items() if k in allowed_steward and v is not None}
    if not patch:
        raise ValueError("Nothing to change")
    if not p.is_steward:
        authz.require(perms["can_edit"] and set(patch) <= allowed_owner, "Only a steward can change certification, risk tier or lifecycle")
        order = ["public", "internal", "confidential", "restricted"]
        if "sensitivity" in patch and order.index(patch["sensitivity"]) < order.index(a["sensitivity"]) and a["certification"] == "certified":
            raise Conflict("Lowering the sensitivity of a certified asset needs a steward")
    if "tags" in patch:
        patch["tags"] = sorted({str(t).strip().lower() for t in patch["tags"] if str(t).strip()})[:10]
    sets = ", ".join(f"{k} = %s" for k in patch)
    cur.execute(f"UPDATE asset SET {sets}, updated_at = now() WHERE asset_id = %s", [*patch.values(), asset_id])
    audit.audit_event(p.email, "asset.governance", "asset", asset_id, before={k: a[k] for k in patch}, after=patch,
                      request_id=p.request_id, cur=cur)
    if "sensitivity" in patch and patch["sensitivity"] != a["sensitivity"]:
        from registry import changes
        changes.publish(cur, {**a, **patch}, {"change_kinds": ["sensitivity"], "breaking": False,
                                              "title": f"Sensitivity changed: {a['sensitivity']} → {patch['sensitivity']}",
                                              "diff": [{"field": "sensitivity", "before": a["sensitivity"], "after": patch["sensitivity"]}]},
                        p=p, perms={**perms, "can_publish": True}, detected_by="admin" if p.is_steward else "owner", enforce_notice=False)
    return cards.card(cur, asset_id, p.email)


def set_owner(cur, asset_id: str, email: str, kind: str, *, p: authz.Principal, perms: dict, remove: bool = False) -> dict:
    if kind not in ("owner", "co_owner", "sponsor", "steward"):
        raise ValueError("kind must be owner, co_owner, sponsor or steward")
    authz.require(p.is_steward or (perms["can_edit"] and kind != "steward"), "Only the asset's owners or a steward can change owners")
    email = (email or "").strip().lower()
    if "@" not in email:
        raise ValueError("A valid email is required")
    if remove:
        cur.execute("DELETE FROM asset_owner WHERE asset_id = %s AND email = %s AND kind = %s", (asset_id, email, kind))
        cur.execute("SELECT count(*) AS n FROM asset_owner WHERE asset_id = %s AND kind IN ('owner','co_owner')", (asset_id,))
        if kind in ("owner", "co_owner") and int(cur.fetchone()["n"]) == 0 and not p.is_steward:
            raise Conflict("An asset must keep at least one owner (a steward can make it ownerless)")
    else:
        cur.execute("""INSERT INTO asset_owner (asset_id, email, kind, source, added_by) VALUES (%s, %s, %s, 'assigned', %s)
                       ON CONFLICT DO NOTHING""", (asset_id, email, kind, p.email))
    audit.audit_event(p.email, "owner.remove" if remove else "owner.add", "asset", asset_id, after={"email": email, "kind": kind},
                      request_id=p.request_id, cur=cur)
    authz.invalidate_roles()
    return cards.card(cur, asset_id, p.email)


def overrides(cur) -> list[dict]:
    cur.execute("""SELECT f.*, a.display_name FROM asset_field f JOIN asset a ON a.asset_id = f.asset_id
                    WHERE f.override_value IS NOT NULL ORDER BY f.drift DESC, f.overridden_at DESC NULLS LAST LIMIT 500""")
    return [{**fields.to_api(r, r["field_key"]), "asset_id": r["asset_id"], "display_name": r["display_name"]} for r in cur.fetchall()]


def roles(cur) -> list[dict]:
    cur.execute("SELECT * FROM role_assignment ORDER BY role, email")
    rows = [dict(r) for r in cur.fetchall()]
    have = {(r["email"], r["role"]) for r in rows}
    for email in sorted(config.REGISTRY_ADMINS):
        if (email, "admin") not in have:
            rows.append({"email": email, "role": "admin", "domain": "*", "granted_by": "REGISTRY_ADMINS", "granted_at": None,
                         "expires_at": None, "reason": "bootstrap admin (app configuration)", "bootstrap": True})
    return rows


def grant_role(cur, email: str, role: str, reason: str, *, p: authz.Principal) -> dict:
    authz.require(p.is_admin, "Only an admin can assign roles")
    email = (email or "").strip().lower()
    if "@" not in email or role not in ("steward", "admin", "auditor"):
        raise ValueError("A valid email and a role of steward, admin or auditor are required")
    if not (reason or "").strip():
        raise ValueError("A reason is required")
    cur.execute("""INSERT INTO role_assignment (email, role, granted_by, reason) VALUES (%s, %s, %s, %s)
                   ON CONFLICT (email, role, domain) DO UPDATE SET granted_by = EXCLUDED.granted_by, reason = EXCLUDED.reason, granted_at = now()
                   RETURNING *""", (email, role, p.email, reason))
    row = cur.fetchone()
    audit.audit_event(p.email, "role.grant", "role", f"{email}:{role}", after={"reason": reason}, request_id=p.request_id, cur=cur)
    authz.invalidate_roles()
    return row


def revoke_role(cur, email: str, role: str, *, p: authz.Principal) -> dict:
    authz.require(p.is_admin, "Only an admin can remove roles")
    if email == p.email and role == "admin":
        raise Conflict("You can't remove your own admin role")
    cur.execute("DELETE FROM role_assignment WHERE email = %s AND role = %s RETURNING *", (email.lower(), role))
    if not cur.fetchone():
        raise NotFound("role assignment not found")
    audit.audit_event(p.email, "role.revoke", "role", f"{email}:{role}", request_id=p.request_id, cur=cur)
    authz.invalidate_roles()
    return {"ok": True}


# ─────────────────────────────── registration ───────────────────────────────

def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:60] or "asset"


def _unique_id(cur, prefix: str, slug: str) -> str:
    candidate, n = f"{prefix}{slug}", 2
    while True:
        cur.execute("SELECT 1 FROM asset WHERE asset_id = %s", (candidate,))
        if not cur.fetchone():
            return candidate
        candidate, n = f"{prefix}{slug}-{n}", n + 1


def register(cur, body: dict, *, p: authz.Principal) -> dict:
    asset_type = body.get("asset_type")
    if asset_type not in ("agent", "mcp_server", "skill"):
        raise ValueError("asset_type must be agent, mcp_server or skill")
    name = (body.get("name") or body.get("display_name") or "").strip()
    display = (body.get("display_name") or name).strip()
    purpose = (body.get("purpose") or "").strip()
    if len(display) < 3 or not purpose:
        raise ValueError("A display name and a one-line purpose are required")
    prefix = {"agent": "agent:custom:", "mcp_server": "mcp:custom:", "skill": "skill:custom:"}[asset_type]
    asset_id = _unique_id(cur, prefix, _slug(name))
    sensitivity = body.get("sensitivity") or "internal"
    cur.execute(
        """INSERT INTO asset (asset_id, asset_type, subtype, name, display_name, source, platform, publisher, lifecycle_status,
                 sensitivity, tags, origin, created_by, attributes, external_ref)
           VALUES (%s,%s,%s,%s,%s,'custom',%s,%s,'pending_approval',%s,%s,'app',%s,%s,%s)""",
        (asset_id, asset_type, body.get("subtype") or ({"agent": "custom_agent", "mcp_server": "custom_mcp", "skill": "agent_skill"}[asset_type]),
         name, display, (body.get("platform") or "manual")[:60], (body.get("publisher") or "").strip() or None, sensitivity,
         sorted({str(t).strip().lower() for t in (body.get("tags") or []) if str(t).strip()})[:10], p.email,
         Jsonb(body.get("attributes") or {}), Jsonb({"endpoint_url": body.get("endpoint_url")} if body.get("endpoint_url") else {})),
    )
    cur.execute("INSERT INTO asset_owner (asset_id, email, kind, source, added_by) VALUES (%s, %s, 'owner', 'assigned', %s)", (asset_id, p.email, p.email))
    owner_perms = {"can_edit": True, "can_override": False, "is_owner": True}
    fields.set_field(cur, asset_id, "purpose", purpose[:140], actor=p.email, perms=owner_perms, request_id=p.request_id)
    for key in ("description", "endpoint_url", "support_channel"):
        if body.get(key):
            fields.set_field(cur, asset_id, key, body[key], actor=p.email, perms=owner_perms, request_id=p.request_id)
    for key, value in (body.get("extra_fields") or {}).items():
        fields.set_field(cur, asset_id, key, value, actor=p.email, perms=owner_perms, request_id=p.request_id)
    audit.audit_event(p.email, "asset.register", "asset", asset_id, after={"asset_type": asset_type, "display_name": display},
                      request_id=p.request_id, cur=cur)
    authz.invalidate_roles()
    return cards.card(cur, asset_id, p.email)


FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)(.*)\Z", re.S)


def parse_skill_md(text: str) -> tuple[dict, str]:
    """Minimal YAML frontmatter parser for SKILL.md: scalars, quoted values, inline [a, b] lists, '- item' lists,
    one nested map level, and block scalars (``|`` literal, ``>`` folded, with optional -/+ chomping)."""
    m = FRONTMATTER.match(text or "")
    if not m:
        raise ValueError("SKILL.md must start with a YAML frontmatter block between --- lines")
    meta: dict = {}
    lines = m.group(1).splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        if not raw.strip() or raw.lstrip().startswith("#") or raw.startswith((" ", "\t")) or ":" not in raw:
            continue
        key, v = (x.strip() for x in raw.split(":", 1))
        if v[:1] in ("|", ">"):
            block = []
            while i < len(lines) and (not lines[i].strip() or lines[i].startswith((" ", "\t"))):
                block.append(lines[i].strip())
                i += 1
            meta[key] = ("\n".join(block) if v[0] == "|" else " ".join(b for b in block if b)).strip()
            continue
        if v == "":
            nested_list, nested_map = [], {}
            while i < len(lines) and lines[i].startswith((" ", "\t")):
                line = lines[i].strip()
                i += 1
                if line.startswith("- "):
                    nested_list.append(line[2:].strip().strip("'\""))
                elif ":" in line:
                    k2, v2 = line.split(":", 1)
                    nested_map[k2.strip()] = v2.strip().strip("'\"")
            meta[key] = nested_list or nested_map or ""
            continue
        if v.startswith("[") and v.endswith("]"):
            meta[key] = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[key] = v.strip("'\"")
    return meta, m.group(2).strip()


def register_skill(cur, body: dict, *, p: authz.Principal) -> dict:
    meta, instructions = parse_skill_md(body.get("skill_md") or "")
    name = str(meta.get("name") or "").strip()
    description = str(meta.get("description") or "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
        raise ValueError("SKILL.md 'name' is required: lowercase letters, digits and hyphens, at most 64 characters")
    if not description or len(description) > 1024:
        raise ValueError("SKILL.md 'description' is required (at most 1024 characters)")
    allowed = meta.get("allowed-tools")
    if isinstance(allowed, str):
        allowed = [t for t in re.split(r"[,\s]+", allowed) if t]
    card = register(cur, {
        "asset_type": "skill", "name": f"{identity.display_name(p.email).split(' ')[0].lower()}-{name}", "display_name": name,
        "platform": "agent_skills", "purpose": description[:140], "description": description + ("\n\n" + instructions[:15000] if instructions else ""),
        "tags": body.get("tags") or [],
        "attributes": {"skill_name": name, "license": meta.get("license"), "allowed_tools": allowed or [], "compatibility": meta.get("compatibility"),
                       "metadata": meta.get("metadata") if isinstance(meta.get("metadata"), dict) else None, "standard": "agentskills.io SKILL.md"},
    }, p=p)
    return card
