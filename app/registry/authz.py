"""Roles and per-asset permissions.

* Every signed-in user is a ``viewer``.
* ``consumer`` and ``owner`` are DERIVED: consumer = an active subscription or an app-provisioned grant;
  owner = listed in ``asset_owner`` (owner / co_owner / sponsor).
* ``steward``, ``admin`` and ``auditor`` are ASSIGNED in ``role_assignment``. REGISTRY_ADMINS bootstraps admins.
* An admin may preview a lower role with the ``x-registry-view-as`` header. It can only reduce privileges.

The app role decides what the UI lets you do. Platform permissions (UC grants, endpoint ACLs) stay the
source of truth for runtime access.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Request

from core import config, identity
from core.tiers import cache

ROLE_ORDER = ("viewer", "consumer", "owner", "auditor", "steward", "admin")
VIEW_AS_HEADER = "x-registry-view-as"
_ROLE_TTL = 30.0


@dataclass(frozen=True)
class Principal:
    email: str
    display_name: str
    roles: frozenset[str]
    view_as: str | None = None
    obo_token: bool = False
    request_id: str | None = None
    actual_roles: frozenset[str] = field(default_factory=frozenset)

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles

    @property
    def is_steward(self) -> bool:
        return "steward" in self.roles or self.is_admin

    @property
    def is_auditor(self) -> bool:
        return "auditor" in self.roles

    @property
    def can_read_everything(self) -> bool:
        return self.is_steward or self.is_auditor

    @property
    def primary_role(self) -> str:
        return max(self.roles, key=ROLE_ORDER.index)


def _assigned_roles(email: str) -> set[str]:
    from core import db

    def load() -> set[str]:
        rows = db.query(
            """
            SELECT role FROM role_assignment
             WHERE email = %s AND (expires_at IS NULL OR expires_at > now())
            UNION
            SELECT 'owner' FROM asset_owner WHERE email = %s AND kind IN ('owner','co_owner','sponsor')
            UNION
            SELECT 'consumer' FROM subscription WHERE subscriber_email = %s AND status = 'active'
            UNION
            SELECT 'consumer' FROM access_grant WHERE principal = %s AND source = 'app' AND revoked_at IS NULL
            """,
            (email, email, email, email),
        )
        return {r["role"] for r in rows}

    return cache.get_or_set("roles", email, load, ttl=_ROLE_TTL)


def roles_for(email: str) -> set[str]:
    roles = {"viewer"}
    if identity.is_registry_admin(email):
        roles.add("admin")
    try:
        roles |= _assigned_roles(email)
    except Exception:  # noqa: BLE001 - Lakebase down: fall back to viewer (+ bootstrap admin)
        pass
    return roles


def _apply_view_as(roles: set[str], view_as: str | None) -> tuple[set[str], str | None]:
    """Admins only, and only downwards: the preview role replaces every assigned role."""
    if not view_as or view_as not in ROLE_ORDER or view_as == "admin" or "admin" not in roles:
        return roles, None
    preview = {"viewer", view_as}
    if view_as == "owner" and "consumer" in roles:
        preview.add("consumer")
    return preview, view_as


def principal(request: Request) -> Principal:
    user = identity.current_user(request)
    email = user["email"]
    actual = roles_for(email)
    roles, view_as = _apply_view_as(set(actual), (request.headers.get(VIEW_AS_HEADER) or "").strip().lower() or None)
    return Principal(
        email=email, display_name=user["name"], roles=frozenset(roles), view_as=view_as,
        obo_token=user["obo_token"], request_id=identity.request_id(request), actual_roles=frozenset(actual),
    )


def invalidate_roles() -> None:
    """After a write that changes memberships (subscribe, grant, owner, role). Cheap: the cache is tiny."""
    cache.invalidate("roles")


# ─────────────────────────────── per-asset ───────────────────────────────

def owner_emails(cur, asset_id: str) -> set[str]:
    cur.execute("SELECT email FROM asset_owner WHERE asset_id = %s AND kind IN ('owner','co_owner','sponsor')", (asset_id,))
    return {r["email"] for r in cur.fetchall()}


def approvers_for(cur, asset_id: str) -> list[str]:
    """Explicit approvers, then owners, then domain stewards, then admins (UC-style resolution order)."""
    cur.execute("SELECT approvers FROM access_settings WHERE asset_id = %s", (asset_id,))
    row = cur.fetchone()
    if row and row["approvers"]:
        return list(row["approvers"])
    owners = sorted(owner_emails(cur, asset_id))
    if owners:
        return owners
    cur.execute(
        """
        SELECT DISTINCT r.email FROM role_assignment r JOIN asset a ON a.asset_id = %s
         WHERE r.role = 'steward' AND (r.domain = '*' OR r.domain = a.domain)
           AND (r.expires_at IS NULL OR r.expires_at > now())
        """,
        (asset_id,),
    )
    stewards = sorted(r["email"] for r in cur.fetchall())
    if stewards:
        return stewards
    cur.execute("SELECT email FROM role_assignment WHERE role = 'admin' AND (expires_at IS NULL OR expires_at > now())")
    admins = sorted({r["email"] for r in cur.fetchall()} | set(config.REGISTRY_ADMINS))
    return admins


def asset_permissions(cur, p: Principal, asset_id: str) -> dict:
    is_owner = "owner" in p.roles and p.email in owner_emails(cur, asset_id)
    cur.execute("SELECT approvers FROM access_settings WHERE asset_id = %s", (asset_id,))
    row = cur.fetchone()
    is_approver = bool(row and p.email in (row["approvers"] or []))
    steward = p.is_steward
    return {
        "can_edit": is_owner or steward,
        "can_override": steward,
        "can_manage_access": is_owner or is_approver or steward,
        "can_publish": is_owner or steward,
        "can_view_all_usage": is_owner or steward or p.is_auditor,
        "can_view_traces": is_owner or steward or p.is_auditor,
        "can_curate": steward,
        "can_pause": is_owner or steward,
        # Unity Catalog MCP services only: owners and stewards edit config.include_tool_selectors (registry/tool_selection).
        "can_edit_tool_selection": (is_owner or steward) and asset_id.startswith("mcp:service:"),
        "is_owner": is_owner,
    }


def require(condition: bool, message: str) -> None:
    from core.guard import Forbidden

    if not condition:
        raise Forbidden(message)
