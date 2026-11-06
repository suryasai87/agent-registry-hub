"""Agent Registry Hub: one FastAPI process serving /api/* and the built React bundle (app/static).

Route order matters: every /api router is included first, then the /api catch-all (unknown API paths answer a
JSON 404, never the SPA shell), then /_app (hashed bundles) and finally the SPA fallback that serves index.html for client
routes. Run locally with ``python app.py`` (binds $DATABRICKS_APP_PORT, default 8000).
"""
from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from importlib import import_module
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from core import config, db, health
from modules import MODULES

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("registry")

STATIC_DIR = Path(os.environ.get("STATIC_DIR") or Path(__file__).parent / "static").resolve()
API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("%s %s starting: lakebase=%s schema=%s warehouse=%s mutations=%s", config.APP_NAME, config.APP_VERSION,
             db.lb.mode, db.lb.schema, "set" if config.WAREHOUSE_ID else "unset", config.ALLOW_MUTATIONS)
    from registry import background
    background.start()  # access sweeps + notification delivery (BACKGROUND_WORKER=false disables)
    yield
    db.lb.close()


app = FastAPI(title="Agent Registry Hub", version=config.APP_VERSION, lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def assign_request_id(request: Request, call_next):
    rid = (request.headers.get("x-request-id") or uuid.uuid4().hex)[:128]
    request.state.request_id = rid
    response = await call_next(request)
    response.headers["x-request-id"] = rid
    return response


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Internal server error", "request_id": getattr(request.state, "request_id", None)},
                        status_code=500)


# ------------------------------------------------------------------ API routers (always before the fallbacks)
ROUTERS = [health.router]
for router in ROUTERS:
    app.include_router(router)
for name in MODULES:
    app.include_router(import_module(f"modules.{name}.router").router)


@app.api_route("/api", methods=API_METHODS, include_in_schema=False)
@app.api_route("/api/{rest:path}", methods=API_METHODS, include_in_schema=False)
def api_not_found(request: Request):
    return JSONResponse({"detail": f"Not Found: {request.url.path}"}, status_code=404)


# ------------------------------------------------------------------ static bundle + SPA fallback
class HashedAssets(StaticFiles):
    """Vite emits content-hashed file names under /assets, so they can be cached forever."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# Vite emits hashed bundles under /_app (build.assetsDir), leaving /assets/<urn> to the SPA's entity pages.
app.mount("/_app", HashedAssets(directory=STATIC_DIR / "_app", check_dir=False), name="bundle")


@app.get("/{full_path:path}", include_in_schema=False)
def serve_spa(full_path: str):
    if full_path:
        candidate = (STATIC_DIR / full_path).resolve()
        if candidate.is_file() and STATIC_DIR in candidate.parents:
            return FileResponse(candidate)
    index = STATIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"detail": "The frontend is not built: run `npm run build` in frontend/"}, status_code=503)


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("DATABRICKS_APP_PORT", "8000"))
    workers = int(os.environ.get("WEB_CONCURRENCY", "1"))  # one per vCPU (MEDIUM = 2)
    uvicorn.run("app:app" if workers > 1 else app, host="0.0.0.0", port=port, workers=workers,
                proxy_headers=True, forwarded_allow_ips="*")
