from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as app_module
from core import config

STATIC = Path(app_module.STATIC_DIR)
built = pytest.mark.skipif(not (STATIC / "index.html").is_file(), reason="frontend not built (cd frontend && npm run build)")


@pytest.fixture
def client():
    with TestClient(app_module.app) as c:
        yield c


def test_health_is_200_even_when_lakebase_is_unreachable(client, use_lb, unreachable_lb, monkeypatch):
    use_lb(unreachable_lb)
    monkeypatch.setattr(config, "WAREHOUSE_ID", "")
    r = client.get("/api/health", headers={"x-forwarded-email": "jane.doe@example.com"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "degraded"
    assert body["lakebase"]["ok"] is False and body["lakebase"]["latency_ms"] is None
    assert "OperationalError" in body["lakebase"]["error"]
    assert body["warehouse"] == {"configured": False}
    assert body["user"]["email"] == "jane.doe@example.com"
    assert body["version"] == config.APP_VERSION
    assert isinstance(body["allow_mutations"], bool)


def test_health_when_lakebase_is_unconfigured(client, use_lb):
    from core.lakebase import Lakebase

    use_lb(Lakebase(url="", endpoint=""))
    body = client.get("/api/health").json()
    assert body["lakebase"]["ok"] is False and "not configured" in body["lakebase"]["error"]


def test_health_ok_against_postgres(client, use_lb, pg_lb):
    use_lb(pg_lb)
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["lakebase"]["ok"] is True and body["lakebase"]["latency_ms"] >= 0
    assert body["lakebase"]["mode"] == "dsn"


def test_unknown_api_routes_are_json_404_for_every_method(client):
    for method in ("get", "post", "put", "patch", "delete"):
        r = getattr(client, method)("/api/nope")
        assert r.status_code == 404, method
        assert r.headers["content-type"].startswith("application/json")
        assert r.json() == {"detail": "Not Found: /api/nope"}
    assert client.get("/api").status_code == 404


def test_request_id_is_echoed_or_assigned(client):
    assert client.get("/api/nope", headers={"x-request-id": "abc-123"}).headers["x-request-id"] == "abc-123"
    assert len(client.get("/api/nope").headers["x-request-id"]) == 32


@built
def test_root_and_client_routes_serve_index_html(client):
    index = (STATIC / "index.html").read_text()
    for path in ("/", "/how-it-works", "/some/deep/client/route"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers["content-type"].startswith("text/html")
        assert r.text == index
        assert r.headers["cache-control"] == "no-cache"
    assert "<title>Agent Registry Hub</title>" in index


@built
def test_hashed_assets_are_served_with_long_cache(client):
    asset = next((STATIC / "_app").glob("*.js"))
    r = client.get(f"/_app/{asset.name}")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]
    assert client.get("/_app/missing-file.js").status_code == 404


@built
def test_entity_page_urls_serve_the_spa(client):
    """/assets/<urn> is the SPA's entity route: a direct load or a refresh must return index.html, never a 404."""
    index = (STATIC / "index.html").read_text()
    for path in ("/assets/agent%3Aendpoint%3Ademo-care-supervisor", "/assets/mcp%3Asystem%3Asystem.ai.microsoft_365/usage",
                 "/assets/tool%3Amcp%3Aconnection%3Agithub%2Fsearch_issues/overview"):
        r = client.get(path)
        assert r.status_code == 200 and r.text == index, path


def test_static_lookup_cannot_escape_the_bundle(client):
    r = client.get("/%2e%2e/requirements.txt")
    assert "fastapi" not in r.text


def test_openapi_lives_under_api(client):
    assert client.get("/api/openapi.json").json()["info"]["title"] == "Agent Registry Hub"
