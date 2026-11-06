"""Usage & cost, traces & evals, policies & guardrails, lineage (and its publication to Unity Catalog)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request
from fastapi.encoders import jsonable_encoder

from core import tiers
from core.guard import Forbidden, to_http
from modules._http import asset_row, principal, read, user_token, write
from registry import authz, lineage, policies, quality, settings, synthetic, uc_lineage, uc_readiness, usage

router = APIRouter(tags=["insights"])


@router.get("/api/assets/{asset_id:path}/usage")
def asset_usage(asset_id: str, request: Request, days: int = 30):
    p = principal(request)
    return read("asset_usage", lambda cur: usage.asset_usage(cur, asset_id, days, p=p, perms=authz.asset_permissions(cur, p, asset_id)),
                lambda: synthetic.asset_usage(asset_id, days))


@router.put("/api/assets/{asset_id:path}/budget")
def put_budget(asset_id: str, request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: usage.set_budget(cur, asset_id, body, p=p, perms=authz.asset_permissions(cur, p, asset_id)))


@router.get("/api/usage-cost")
def usage_cost(request: Request, days: int = 30):
    return read("usage_cost", lambda cur: usage.fleet(cur, days), lambda: synthetic.fleet_usage(days))


@router.get("/api/assets/{asset_id:path}/traces")
def asset_traces(asset_id: str, request: Request, limit: int = 50):
    p = principal(request)

    def fn(cur):
        asset_row(cur, asset_id)
        perms = authz.asset_permissions(cur, p, asset_id)
        return quality.traces(cur, asset_id, limit, viewer=p.email, see_all=perms["can_view_traces"])
    return read("asset_traces", fn, lambda: synthetic.asset_traces(asset_id))


@router.get("/api/assets/{asset_id:path}/evals")
def asset_evals(asset_id: str, request: Request):
    def fn(cur):
        asset_row(cur, asset_id)
        return quality.evals(cur, asset_id)
    return read("asset_evals", fn, lambda: synthetic.asset_evals(asset_id))


@router.get("/api/quality")
def quality_fleet(request: Request):
    return read("quality", quality.fleet, synthetic.quality_fleet)


@router.get("/api/assets/{asset_id:path}/policies")
def asset_policies(asset_id: str, request: Request):
    return read("asset_policies", lambda cur: policies.asset_policies(cur, asset_id), lambda: synthetic.asset_policies(asset_id))


@router.post("/api/assets/{asset_id:path}/policies/{policy_id}")
def bind_policy(asset_id: str, policy_id: str, request: Request, body: dict = Body(default={})):
    return write(request, lambda cur, p: policies.bind(cur, asset_id, policy_id, body.get("status") or "proposed", p=p,
                                                      perms=authz.asset_permissions(cur, p, asset_id)))


@router.delete("/api/assets/{asset_id:path}/policies/{policy_id}")
def unbind_policy(asset_id: str, policy_id: str, request: Request):
    return write(request, lambda cur, p: policies.unbind(cur, asset_id, policy_id, p=p))


@router.get("/api/policies")
def policies_fleet(request: Request):
    return read("policies", policies.fleet, synthetic.policies_fleet)


@router.get("/api/lineage")
def lineage_graph(request: Request, focus: str | None = None, depth: int = 1, dir: str = "both",
                  kinds: str = "declared,observed,data", change_id: int | None = None):
    p = principal(request)
    return read("lineage", lambda cur: lineage.build(cur, focus, depth, dir, kinds.split(","), p=p, change_id=change_id),
                lambda: synthetic.lineage(focus, depth, dir))


# ── Unity Catalog external lineage: plan (dry run) → admin publish; optional sync-job step (setting, default off) ──
def _hub_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/api/lineage/uc-publish")
def uc_publish_status(request: Request):
    p = principal(request)
    return read("uc_publish", lambda cur: uc_lineage.status(cur, p, app_url=_hub_url(request)),
                lambda: {"available": False, "note": "Registry data is unavailable: the plan needs Lakebase.", "plan": None,
                         "settings": {"publish_in_sync": False}, "runs": [], "tracked": {}, "failed": [], "can_publish": False})


@router.get("/api/lineage/uc-publish/readiness")
def uc_publish_readiness(request: Request, refresh: bool = False):
    """Read-only privilege checks for each publishing identity, with the grant SQL. Never 500: an API failure is an
    ``unknown`` check; a missing plan (Lakebase down) leaves the table check ``unknown`` and sets degraded_reason."""
    p = principal(request)
    try:
        data = uc_readiness.readiness(p, user_token=user_token(request), app_url=_hub_url(request), refresh=refresh)
    except Forbidden as e:
        raise to_http(e) from e
    return tiers.envelope(jsonable_encoder(data), "live", (data.get("tables") or {}).get("error"))


@router.post("/api/lineage/uc-publish")
def uc_publish(request: Request, body: dict = Body(default={})):
    token = user_token(request)
    return write(request, lambda cur, p: uc_lineage.publish(cur, p, digest=body.get("digest") or None, app_url=_hub_url(request),
                                                           user_token=token))


@router.put("/api/lineage/uc-publish/settings")
def uc_publish_settings(request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: settings.put(cur, "uc_lineage_publish_in_sync", body.get("publish_in_sync"), p=p,
                                                     reason=body.get("reason")))
