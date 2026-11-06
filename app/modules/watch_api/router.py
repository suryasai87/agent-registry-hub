"""Platform Watch: release feeds, capability probes, update candidates (regression on a Lakebase branch) and
admin decisions. Reads are for admins, stewards and auditors. Decisions and settings are admin-only.

Accept/check trigger the updates job (``WATCH_JOB_ID``: the bundle's ``registry_updates`` job, CAN_MANAGE_RUN for
the app SP). That job migrates production, enables the adapter or deploys the staged app, and records every step.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, Body, Request

from core.guard import Conflict, guard
from modules._http import principal, read, write
from registry import authz, platform_watch as pw

router = APIRouter(tags=["platform-watch"])


def _reader(p: authz.Principal) -> None:
    authz.require(p.can_read_everything, "Platform updates are for admins, stewards and auditors")


def _run_job(mode: str, candidate_id: int | None, actor: str) -> dict:
    job_id = os.environ.get("WATCH_JOB_ID", "").strip()
    if not job_id or job_id.lower() == "none":
        return {"mode": "not_configured", "note": "The updates job isn't configured (WATCH_JOB_ID). Run "
                f"`python jobs/platform_updates.py --mode {mode}" + (f" --candidate {candidate_id}`" if candidate_id else "`")}
    from core.lakebase import workspace_client
    w = workspace_client()
    params = {"mode": mode, "candidate": str(candidate_id or ""), "triggered_by": actor}
    run = w.jobs.run_now(job_id=int(job_id), job_parameters=params)
    run_id = getattr(run, "run_id", None) or getattr(getattr(run, "response", None), "run_id", None)
    return {"mode": "job", "job_id": job_id, "run_id": run_id,
            "url": f"{w.config.host.rstrip('/')}/jobs/{job_id}/runs/{run_id}" if run_id else None}


@router.get("/api/platform-watch")
def overview(request: Request):
    p = principal(request)
    return read("watch_overview", lambda cur: (_reader(p), {**pw.overview(cur), "job_configured": bool(
        os.environ.get("WATCH_JOB_ID", "").strip() not in ("", "none"))})[1],
                lambda: {"counts": {}, "sources": [], "settings": {}, "ready": 0, "attention": 0, "job_configured": False})


@router.get("/api/platform-watch/candidates")
def list_candidates(request: Request, status: str | None = None):
    p = principal(request)
    return read("watch_candidates", lambda cur: (_reader(p), pw.candidates(cur, status))[1], lambda: [])


@router.get("/api/platform-watch/feed")
def list_feed(request: Request, min_relevance: int = 0, source: str | None = None, limit: int = 200):
    p = principal(request)
    return read("watch_feed", lambda cur: (_reader(p), pw.feed(cur, min_relevance, source, limit))[1], lambda: [])


@router.get("/api/platform-watch/capabilities")
def list_capabilities(request: Request):
    p = principal(request)
    return read("watch_capabilities", lambda cur: (_reader(p), pw.capabilities(cur))[1], lambda: [])


@router.post("/api/platform-watch/candidates/{candidate_id}/decision")
def decide(candidate_id: int, request: Request, body: dict = Body(...)):
    action = body.get("action") or ""
    row = write(request, lambda cur, p: pw.decide(cur, candidate_id, action, p=p, delay_until=body.get("delay_until"),
                                                  note=body.get("note")))
    if action == "accept" and row.get("kind") != "advisory":
        p = principal(request)
        row["apply_run"] = guard(_run_job, "apply", candidate_id, p.email)
    return row


@router.post("/api/platform-watch/candidates/{candidate_id}/check")
def run_check(candidate_id: int, request: Request):
    def fn(cur, p):
        authz.require(p.is_admin, "Only an admin can start a regression run")
        cur.execute("SELECT status FROM update_candidate WHERE candidate_id = %s", (candidate_id,))
        c = cur.fetchone()
        if not c:
            from core.guard import NotFound
            raise NotFound(f"candidate {candidate_id} not found")
        if c["status"] in ("applying", "applied", "rejected", "testing"):
            raise Conflict(f"This candidate is {c['status']}")
        return {"ok": True}
    write(request, fn)
    return guard(_run_job, "check", candidate_id, principal(request).email)


@router.post("/api/platform-watch/run")
def run_watch(request: Request):
    p = principal(request)
    authz.require(p.is_admin, "Only an admin can run Platform Watch")
    return guard(_run_job, "watch", None, p.email)


@router.put("/api/platform-watch/settings/{key}")
def put_setting(key: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: pw.set_setting(cur, key, body.get("value"), p=p))


@router.post("/api/platform-watch/feed/{item_id}/dismiss")
def dismiss(item_id: int, request: Request):
    def fn(cur, p):
        authz.require(p.is_steward, "Only a steward or admin can triage the release feed")
        cur.execute("UPDATE feed_item SET status = 'dismissed' WHERE item_id = %s RETURNING item_id", (item_id,))
        if not cur.fetchone():
            from core.guard import NotFound
            raise NotFound("feed item not found")
        return {"ok": True}
    return write(request, fn)
