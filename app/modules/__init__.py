"""Domain modules.

Each module is a package ``modules/<name>/`` whose ``router.py`` exposes ``router`` (a FastAPI ``APIRouter``
with ``/api/...`` routes). List the package name in ``MODULES`` and app.py mounts it before the SPA fallback.
"""
from __future__ import annotations

# catalog_api LAST: it holds the catch-all GET /api/assets/{asset_id:path}.
MODULES: list[str] = ["subregistry_api", "access_api", "insights_api", "changes_api", "admin_api", "watch_api", "kg_api", "catalog_api"]
