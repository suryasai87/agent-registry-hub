"""The signed-in user.

On Databricks Apps the proxy authenticates the user and forwards the identity as headers:
``X-Forwarded-Email`` (email), ``X-Forwarded-Preferred-Username`` (usually the email too) and
``X-Forwarded-User`` (``<user id>@<workspace id>``). With user authorization enabled it also forwards
``X-Forwarded-Access-Token`` for on-behalf-of calls; only its presence is exposed here, never the value.
Without those headers (local development) the user is ``LOCAL_USER``.
"""
from __future__ import annotations

from fastapi import Request

from core import config

EMAIL_HEADER = "x-forwarded-email"
USERNAME_HEADER = "x-forwarded-preferred-username"
USER_HEADER = "x-forwarded-user"
TOKEN_HEADER = "x-forwarded-access-token"


def display_name(email: str) -> str:
    """'jane.doe@x.com' -> 'Jane Doe'; non-email ids are returned unchanged."""
    if "@" not in email:
        return email
    local = email.split("@")[0]
    return " ".join(p.capitalize() for p in local.replace("_", ".").replace("-", ".").split(".") if p) or email


def is_registry_admin(email: str) -> bool:
    return email.strip().lower() in config.REGISTRY_ADMINS


def has_obo_token(request: Request) -> bool:
    return bool((request.headers.get(TOKEN_HEADER) or "").strip())


def current_user(request: Request) -> dict:
    """{email, name, user_id, source: 'apps'|'local', obo_token: bool, is_admin: bool}."""
    headers = request.headers
    forwarded_user = (headers.get(USER_HEADER) or "").strip()
    candidates = [(headers.get(EMAIL_HEADER) or "").strip(), (headers.get(USERNAME_HEADER) or "").strip(), forwarded_user]
    identity = next((c for c in candidates if c), "")
    source = "apps" if identity else "local"
    email = (identity or config.LOCAL_USER).lower()
    return {
        "email": email,
        "name": display_name(email),
        "user_id": forwarded_user or None,
        "source": source,
        "obo_token": has_obo_token(request),
        "is_admin": is_registry_admin(email),
    }


def request_id(request: Request) -> str | None:
    """The id app.py's middleware assigned to this request (X-Request-Id), for audit rows and log lines."""
    return getattr(request.state, "request_id", None)
