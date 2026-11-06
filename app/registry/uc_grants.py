"""Grant SQL for Unity Catalog lineage publishing. Pure functions (stdlib only), shared by ``registry/uc_readiness.py``
and ``scripts/uc_lineage_grants.py``, which runs outside the app's environment.

Unity Catalog names a service principal by its application (client) id and a user by email; both go in backticks,
and so does every part of a table name, so hyphens, capitals and keywords are safe. A backtick inside a name is
doubled. Nothing here runs a grant.
"""
from __future__ import annotations

import re

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def quote_ident(name: str) -> str:
    return "`" + str(name).replace("`", "``") + "`"


def quote_table(fqn: str) -> str:
    """``c.s.t`` → ``\\`c\\`.\\`s\\`.\\`t\\```."""
    return ".".join(quote_ident(part) for part in str(fqn).split("."))


def grant_metastore_sql(principal: str) -> str:
    return f"GRANT CREATE EXTERNAL METADATA ON METASTORE TO {quote_ident(principal)};"


def grant_table_sql(table: str, principal: str) -> str:
    return f"GRANT MODIFY ON TABLE {quote_table(table)} TO {quote_ident(principal)};"


def grant_schema_sql(schema: str, principal: str) -> str:
    return f"GRANT MODIFY ON SCHEMA {quote_table(schema)} TO {quote_ident(principal)};"


def principal_kind(principal: str | None) -> str:
    if not principal:
        return "unknown"
    if UUID.match(principal):
        return "service_principal"
    return "user" if "@" in principal else "group"


def by_schema(tables: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for t in sorted(set(tables)):
        out.setdefault(t.rsplit(".", 1)[0], []).append(t)
    return out


def even_sample(items: list, n: int) -> list:
    """``n`` items spread evenly over ``items`` (first and last included), so a capped check is not biased to one catalog."""
    if n <= 0:
        return []
    if len(items) <= n:
        return list(items)
    if n == 1:
        return [items[0]]
    step = (len(items) - 1) / (n - 1)
    return [items[round(i * step)] for i in range(n)]
