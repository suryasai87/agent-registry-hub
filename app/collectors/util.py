"""Small pure helpers shared by the collectors (no I/O)."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlparse

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
SECRET_KEYS = ("environment_vars", "databricks_api_token", "api_key", "secret", "password", "bearer_token",
               "client_secret", "access_token", "refresh_token", "private_key")

PURPOSE_MAX = 140


# ------------------------------------------------------------------ time
def ms_to_dt(ms: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc) if ms not in (None, "", 0) else None
    except (TypeError, ValueError, OverflowError):
        return None


def iso_to_dt(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    # Python accepts at most 6 fractional digits; UC skills return nanoseconds.
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def to_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def duration_ms(value: Any) -> int | None:
    """MLflow v3 ``execution_duration`` ("18.031s", "0.307s", "1500ms") -> milliseconds."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*(ms|s)?\s*", str(value))
    if not m:
        return None
    number = float(m.group(1))
    return int(round(number if m.group(2) == "ms" else number * 1000))


# ------------------------------------------------------------------ text
def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def purpose_from(text: Any, limit: int = PURPOSE_MAX) -> str | None:
    """The first sentence (or line) of a description, at most ``limit`` characters."""
    text = clean_text(text)
    if not text:
        return None
    first = text.split("\n", 1)[0].strip()
    m = re.match(r"(.+?[.!?])(\s|$)", first)
    if m and len(m.group(1)) >= 20:
        first = m.group(1)
    first = " ".join(first.split())
    if len(first) <= limit:
        return first
    cut = first[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:-")
    return cut + "…"


def clean_list(values: Iterable[Any] | None, limit: int = 50) -> list[str] | None:
    out: list[str] = []
    for v in values or []:
        t = clean_text(v)
        if t and t not in out:
            out.append(t)
        if len(out) >= limit:
            break
    return out or None


# ------------------------------------------------------------------ hashing / scrubbing
def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str, ensure_ascii=False)


def short_hash(obj: Any, n: int = 16) -> str | None:
    if obj in (None, "", [], {}):
        return None
    payload = obj if isinstance(obj, str) else canonical(obj)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:n]


def scrub(obj: Any) -> Any:
    """Drop secret-bearing keys (environment_vars, tokens, secrets) from a raw API payload, recursively."""
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items() if not any(s in k.lower() for s in SECRET_KEYS)}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return obj


# ------------------------------------------------------------------ principals
def principal_kind(principal: str | None) -> str:
    """UC principals are emails (users), application ids (service principals) or group names."""
    p = (principal or "").strip()
    if "@" in p:
        return "user"
    if UUID_RE.match(p):
        return "service_principal"
    return "group"


def acl_principal(entry: dict) -> tuple[str, str] | None:
    """Workspace ACL entry -> (principal, principal_type)."""
    if entry.get("user_name"):
        return entry["user_name"].lower(), "user"
    if entry.get("service_principal_name"):
        return entry["service_principal_name"], "service_principal"
    if entry.get("group_name"):
        return entry["group_name"], "group"
    return None


def acl_rows(acl: dict | None) -> list[dict]:
    """``/api/2.0/permissions/...`` response -> [{principal, principal_type, privilege, inherited}]."""
    rows: dict[tuple, dict] = {}
    for entry in (acl or {}).get("access_control_list") or []:
        who = acl_principal(entry)
        if not who:
            continue
        for perm in entry.get("all_permissions") or []:
            level = perm.get("permission_level")
            if not level:
                continue
            key = (who[0], level)
            inherited = bool(perm.get("inherited"))
            if key in rows:
                rows[key]["inherited"] = rows[key]["inherited"] and inherited
            else:
                rows[key] = {"principal": who[0], "principal_type": who[1], "privilege": level, "inherited": inherited}
    return list(rows.values())


def uc_grant_rows(perms: dict | None) -> list[dict]:
    """UC ``effective-permissions`` response -> [{principal, principal_type, privilege, inherited}]."""
    rows: dict[tuple, dict] = {}
    for pa in (perms or {}).get("privilege_assignments") or []:
        principal = pa.get("principal")
        if not principal:
            continue
        ptype = principal_kind(principal)
        principal = principal.lower() if ptype == "user" else principal
        for priv in pa.get("privileges") or []:
            name = priv.get("privilege") if isinstance(priv, dict) else priv
            if not name:
                continue
            inherited = bool(isinstance(priv, dict) and priv.get("inherited_from_type"))
            key = (principal, name)
            if key in rows:
                rows[key]["inherited"] = rows[key]["inherited"] and inherited
            else:
                rows[key] = {"principal": principal, "principal_type": ptype, "privilege": name, "inherited": inherited}
    return list(rows.values())


def email_or_none(value: Any) -> str | None:
    text = clean_text(value)
    return text.lower() if text and "@" in text else None


def owner_id(value: Any) -> str | None:
    """An owner identifier: emails lower-cased, service principal ids kept, 'System user' dropped."""
    text = clean_text(value)
    if not text or text.lower() in ("system user", "system"):
        return None
    return text.lower() if "@" in text else text


# ------------------------------------------------------------------ hosts / publishers
PUBLISHERS = (
    ("atlassian.com", "Atlassian"), ("githubcopilot.com", "GitHub"), ("github.com", "GitHub"),
    ("deepwiki.com", "DeepWiki"), ("tavily.com", "Tavily"), ("you.com", "You.com"), ("airtable.com", "Airtable"),
    ("asana.com", "Asana"), ("graph.microsoft.com", "Microsoft"), ("microsoft.com", "Microsoft"),
    ("office.com", "Microsoft"), ("glean.com", "Glean"), ("notion.com", "Notion"), ("notion.so", "Notion"),
    ("linear.app", "Linear"), ("slack.com", "Slack"), ("stripe.com", "Stripe"), ("hubspot.com", "HubSpot"),
    ("sentry.dev", "Sentry"), ("cloudflare.com", "Cloudflare"), ("glama.ai", "Glama"), ("box.com", "Box"),
    ("zapier.com", "Zapier"), ("salesforce.com", "Salesforce"), ("snowflake.com", "Snowflake"),
    ("servicenow.com", "ServiceNow"), ("monday.com", "monday.com"), ("intercom.com", "Intercom"),
    ("paypal.com", "PayPal"), ("square.com", "Square"), ("vercel.com", "Vercel"), ("huggingface.co", "Hugging Face"),
    ("exa.ai", "Exa"), ("perplexity.ai", "Perplexity"), ("brave.com", "Brave"), ("firecrawl.dev", "Firecrawl"),
    ("context7.com", "Upstash (Context7)"), ("upstash.com", "Upstash"), ("smithery.ai", "Smithery"),
)
_TWO_LEVEL_TLDS = ("co.uk", "com.au", "co.jp", "com.br", "co.in", "co.nz", "com.mx")


def host_of(url_or_host: str | None) -> str:
    text = (url_or_host or "").strip()
    if not text:
        return ""
    parsed = urlparse(text if "://" in text else f"https://{text}")
    return (parsed.hostname or "").lower()


def registrable_domain(host: str) -> str:
    parts = [p for p in host.split(".") if p]
    if len(parts) <= 2:
        return host
    tail2 = ".".join(parts[-2:])
    if tail2 in _TWO_LEVEL_TLDS and len(parts) >= 3:
        return ".".join(parts[-3:])
    return tail2


def publisher_for_host(host: str) -> str | None:
    """Publisher of a remote MCP host. Databricks Apps are custom (the owner publishes them): None."""
    host = host_of(host)
    if not host or host.endswith(".databricksapps.com"):
        return None
    if host.endswith(".databricks.com") or host.endswith(".azuredatabricks.net") or host.endswith(".gcp.databricks.com"):
        return "Databricks"
    for suffix, name in PUBLISHERS:
        if host == suffix or host.endswith("." + suffix):
            return name
    return registrable_domain(host)


def databricks_app_name(host: str, workspace_id: str | None = None) -> str | None:
    """'aa-sil-np-mcp-7474644717717567.aws.databricksapps.com' -> 'aa-sil-np-mcp'."""
    host = host_of(host)
    if not host.endswith(".databricksapps.com"):
        return None
    label = host.split(".", 1)[0]
    if workspace_id and label.endswith(f"-{workspace_id}"):
        return label[: -(len(workspace_id) + 1)]
    m = re.match(r"^(.*)-\d{6,}$", label)
    return m.group(1) if m else label


# ------------------------------------------------------------------ schemas
def schema_summary(schema: dict | None, limit: int = 30) -> str | None:
    """A human-readable summary of a JSON-schema ``properties`` object (for the ``inputs`` field)."""
    props = (schema or {}).get("properties") or {}
    if not props:
        return None
    required = set((schema or {}).get("required") or [])
    lines = []
    for name, spec in list(props.items())[:limit]:
        spec = spec if isinstance(spec, dict) else {}
        kind = spec.get("type") or ("enum" if spec.get("enum") else "any")
        if isinstance(kind, list):
            kind = "|".join(str(k) for k in kind)
        flag = "required" if name in required else "optional"
        desc = clean_text(spec.get("description"))
        lines.append(f"- {name} ({kind}, {flag})" + (f": {' '.join(desc.split())[:200]}" if desc else ""))
    if len(props) > limit:
        lines.append(f"- … {len(props) - limit} more")
    return "\n".join(lines)


def tool_digest(tool: dict) -> dict:
    """The diff-relevant identity of an MCP tool: name, required params and a schema hash."""
    schema = tool.get("inputSchema") or {}
    return {
        "name": tool.get("name"),
        "required": sorted(schema.get("required") or []),
        "schema_hash": short_hash(schema),
    }


def side_effect(annotations: dict | None, *, uc_function: bool = False, sql_data_access: str | None = None) -> str:
    """read | write | destructive | unknown, from MCP annotations (or UC function metadata)."""
    ann = annotations or {}
    if uc_function:
        # destructiveHint is set on every UC function tool (even read-only TVFs), so it carries no signal.
        access = (sql_data_access or "").upper()
        if access == "MODIFIES_SQL_DATA":
            return "write"
        if access in ("READS_SQL_DATA", "CONTAINS_SQL", "NO_SQL") and (ann.get("routine_body") or "SQL").upper() == "SQL":
            return "read"
        return "unknown"
    if ann.get("readOnlyHint") is True:
        return "read"
    if ann.get("destructiveHint") is True:
        return "destructive"
    if ann.get("readOnlyHint") is False:
        return "write"
    return "unknown"
