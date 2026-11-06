"""Governance (sources & sync, curation, overrides, roles, Microsoft Agent 365 registrations) and the audit trail."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request
from fastapi.responses import Response

from core import db
from core.guard import guard
from modules._http import principal, read, write
from registry import agent365, auditlog, authz, governance, synthetic

router = APIRouter(tags=["governance"])


def _governor(p: authz.Principal) -> None:
    authz.require(p.can_read_everything, "Governance is for stewards, admins and auditors")


@router.get("/api/governance/sources")
def sources(request: Request):
    p = principal(request)
    return read("gov_sources", lambda cur: (_governor(p), governance.sources(cur))[1], synthetic.gov_sources)


@router.post("/api/governance/sync")
def sync(request: Request, body: dict = Body(default={})):
    p = principal(request)
    return guard(governance.trigger_sync, p, body.get("collectors") or None)


@router.get("/api/governance/curation")
def curation(request: Request):
    p = principal(request)
    return read("gov_curation", lambda cur: (_governor(p), governance.curation(cur, p.email))[1], synthetic.gov_curation)


@router.post("/api/governance/curation/{asset_id:path}")
def curate(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: governance.curate(cur, asset_id, body.get("action") or "", body.get("reason") or "", p=p))


@router.get("/api/governance/overrides")
def overrides(request: Request):
    p = principal(request)
    return read("gov_overrides", lambda cur: (_governor(p), governance.overrides(cur))[1], lambda: [])


@router.get("/api/governance/roles")
def roles(request: Request):
    p = principal(request)
    return read("gov_roles", lambda cur: (_governor(p), governance.roles(cur))[1], synthetic.gov_roles)


@router.post("/api/governance/roles")
def grant_role(request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: governance.grant_role(cur, body.get("email") or "", body.get("role") or "", body.get("reason") or "", p=p))


@router.delete("/api/governance/roles/{email}/{role}")
def revoke_role(email: str, role: str, request: Request):
    return write(request, lambda cur, p: governance.revoke_role(cur, email, role, p=p))


# ── Microsoft Agent 365 registrations ("Also registered in"): Graph collector + admin file import + steward review ──
@router.get("/api/agent365")
def agent365_overview(request: Request):
    p = principal(request)
    return read("agent365", lambda cur: agent365.overview(cur, p),
                lambda: {"registry": agent365.REGISTRY_LABEL, "available": False, "graph": {"configured": False, "connection": None},
                         "counts": {}, "review": [], "linked": [], "runs": [], "can_import": False, "can_review": False})


@router.post("/api/agent365/import")
def agent365_import(request: Request, body: dict = Body(...)):
    content = body.get("content")
    if not isinstance(content, (str, list, dict)):
        content = ""
    return write(request, lambda cur, p: agent365.import_file(cur, content=content, filename=body.get("filename"),
                                                             fmt=body.get("format"), p=p))


@router.post("/api/agent365/review")
def agent365_review(request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: agent365.review(cur, external_id=str(body.get("external_id") or ""), action=body.get("action") or "",
                                                        asset_id=body.get("asset_id"), reason=body.get("reason") or "", p=p))


# ── audit ──
@router.get("/api/audit")
def audit_rows(request: Request, entity_type: str | None = None, entity_id: str | None = None, actor: str | None = None,
               action: str | None = None, days: int = 30, page: int = 1, page_size: int = 50):
    p = principal(request)
    return read("audit", lambda cur: auditlog.list_rows(cur, p, entity_type=entity_type, entity_id=entity_id, actor=actor,
                                                        action=action, days=days, page=page, page_size=page_size),
                lambda: {"rows": [], "total": 0})


@router.get("/api/audit/verify")
def audit_verify(request: Request):
    p = principal(request)
    return read("audit_verify", lambda cur: (_governor(p), auditlog.verify(cur))[1],
                lambda: {"intact": False, "checked": 0, "problems": [{"audit_id": 0, "problem": "Lakebase unavailable: cannot verify"}]})


@router.get("/api/audit/export")
def audit_export(request: Request, format: str = "csv", entity_type: str | None = None, entity_id: str | None = None,
                 actor: str | None = None, action: str | None = None, days: int = 30):
    p = principal(request)

    def run():
        with db.transaction() as cur:
            return auditlog.export(cur, p, format, entity_type=entity_type, entity_id=entity_id, actor=actor, action=action, days=days)
    body, media, filename = guard(run)
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename}"'})
