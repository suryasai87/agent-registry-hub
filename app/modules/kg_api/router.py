"""The registry as a knowledge graph: RDF triples materialised as Unity Catalog Delta objects in the OntoBricks layout,
for Genie agents and OntoBricks (registry/knowledge_graph.py builds the triples, registry/kg_delta.py exports them).

Preview first: ``GET /api/kg/preview`` builds the triples and the exact SQL without writing anything and returns a
digest; an admin exports that digest (``POST /api/kg/export``; a changed graph answers 409). Reads are for stewards,
admins and auditors; the export and the settings are admin-only and audited. The ontology is served as Turtle for the
OntoBricks import.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Request
from fastapi.responses import PlainTextResponse

from modules._http import principal, read, user_token, write
from registry import kg_delta, knowledge_graph

router = APIRouter(tags=["knowledge-graph"])

UNAVAILABLE = "Registry data is unavailable: the knowledge graph is built from Lakebase."


def _hub_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/api/kg/preview")
def kg_preview(request: Request):
    p = principal(request)
    return read("kg_preview", lambda cur: kg_delta.preview(cur, p, app_url=_hub_url(request)),
                lambda: {"available": False, "note": UNAVAILABLE, "can_export": False, "target": None, "triples": 0, "classes": [],
                         "predicates": [], "samples": [], "skipped": [], "objects": [], "statements": [], "digest": None, "last_run": None})


@router.get("/api/kg/status")
def kg_status(request: Request):
    p = principal(request)
    return read("kg_status", lambda cur: kg_delta.status(cur, p),
                lambda: {"available": False, "note": UNAVAILABLE, "runs": [], "target": None, "can_export": False,
                         "settings": {"export_in_sync": False, "catalog": "", "schema": "", "version": 1, "bundle_target": None}})


@router.post("/api/kg/export")
def kg_export(request: Request, body: dict = Body(default={})):
    token = user_token(request)
    return write(request, lambda cur, p: kg_delta.export(cur, p, digest=body.get("digest") or None, app_url=_hub_url(request), user_token=token))


@router.put("/api/kg/settings")
def kg_settings(request: Request, body: dict = Body(...)):
    return write(request, lambda cur, p: kg_delta.put_settings(cur, body, p=p))


@router.get("/api/kg/ontology.ttl", response_class=PlainTextResponse)
def kg_ontology():
    """The ontology (OWL, Turtle) with this install's namespace: import it into OntoBricks as the domain ontology."""
    return PlainTextResponse(knowledge_graph.turtle(knowledge_graph.default_namespace()), media_type="text/turtle",
                             headers={"Content-Disposition": 'attachment; filename="agent-registry-hub.ttl"'})
