"""Platform Watch: release-feed subscriptions, capability probes, update candidates and governed decisions.

* **Feeds**: RSS/Atom from Databricks release notes, MLflow, and the Databricks SDK/CLI releases. Each item is
  scored against the capability catalog (keywords) and tagged with lifecycle (GA / Public Preview / Beta),
  deprecation and breaking hints.
* **Capabilities**: APIs the registry uses, or will use once available. Each has a probe, so a feature that
  only exists on paper (announced but 404 here) is told apart from one actually available in THIS
  workspace.
* **Candidates**: what to do about it:
  - ``app_release``: a newer staged version of this app;
  - ``capability``: a newly available API with an adapter that ships disabled;
  - ``advisory``: a relevant announcement or a new API without an adapter yet. It still gets a platform
    compatibility regression run.
  Every candidate is regression-tested on a throwaway Lakebase branch (registry/regression.py) before an
  admin accepts or delays it. The auto-upgrade policy may apply non-breaking, passing candidates.
"""
from __future__ import annotations

import html
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from psycopg.types.json import Jsonb

from core import audit
from core.guard import Conflict, NotFound
from registry import authz, notify

# ─────────────────────────────── capability catalog (code-defined, synced to the table) ───────────────────────────────
CAPABILITIES: list[dict] = [
    {"capability_key": "uc_mcp_services", "label": "Unity Gateway MCP services API", "area": "mcp", "adapter": "mcp_system",
     "probe_kind": "rest", "probe_path": "/api/2.1/unity-catalog/mcp-services?parent=schemas/system.ai&page_size=1",
     "keywords": ["mcp service", "mcp services", "unity gateway", "mcp server", "mcp tool", "built-in mcp", "managed mcp"],
     "docs_url": "https://docs.databricks.com/aws/en/ai-gateway/govern-mcp-service",
     "description": "List and govern MCP servers as UC securables (owners, tool selection, rate limits)."},
    {"capability_key": "supervisor_agents_v21", "label": "Supervisor Agent API (v2.1)", "area": "agents", "adapter": "agent_bricks",
     "probe_kind": "rest", "probe_path": "/api/2.1/supervisor-agents?page_size=1",
     "keywords": ["supervisor agent", "multi-agent supervisor", "agent bricks"],
     "docs_url": "https://docs.databricks.com/aws/en/generative-ai/agent-bricks/multi-agent-supervisor",
     "description": "Supervisor agents and their tools: the cleanest agent → tool lineage source."},
    {"capability_key": "knowledge_assistants_v21", "label": "Knowledge Assistant API (v2.1)", "area": "agents", "adapter": "agent_bricks",
     "probe_kind": "rest", "probe_path": "/api/2.1/knowledge-assistants?page_size=1",
     "keywords": ["knowledge assistant"], "docs_url": "https://docs.databricks.com/aws/en/generative-ai/agent-bricks/knowledge-assistant",
     "description": "Knowledge Assistants and their knowledge sources."},
    {"capability_key": "genie_spaces", "label": "Genie spaces / Genie Agents API", "area": "agents", "adapter": "genie",
     "probe_kind": "rest", "probe_path": "/api/2.0/genie/spaces?page_size=1", "keywords": ["genie", "genie agent", "genie space"],
     "docs_url": "https://docs.databricks.com/aws/en/genie/", "description": "Genie spaces as agents, with table lineage."},
    {"capability_key": "genie_agents_api", "label": "Genie Agents API (/genie/agents)", "area": "agents", "adapter": None,
     "probe_kind": "rest", "probe_path": "/api/2.0/genie/agents", "keywords": ["genie agent", "genie agents api"],
     "docs_url": "https://docs.databricks.com/aws/en/genie/", "description": "Dedicated Genie Agents endpoint (not yet enabled in every workspace)."},
    {"capability_key": "uc_agent_services", "label": "UC agent services (registry)", "area": "agents", "adapter": None,
     "probe_kind": "rest", "probe_path": "/api/2.1/unity-catalog/agent-services?page_size=1", "keywords": ["agent service", "agent services"],
     "docs_url": "https://docs.databricks.com/aws/en/ai-gateway/agent-services", "description": "External agents registered as UC securables (Beta)."},
    {"capability_key": "uc_skills", "label": "UC skills API", "area": "skills", "adapter": "skills",
     "probe_kind": "rest", "probe_path": "/api/2.1/unity-catalog/skills?parent=schemas/system.ai&page_size=1",
     "keywords": ["skill", "skills", "skill.md", "agent skill"], "docs_url": "https://docs.databricks.com/aws/en/ai-gateway/skills",
     "description": "Skills as UC securables (SKILL.md bundles)."},
    {"capability_key": "mlflow_trace_search_v3", "label": "MLflow trace search (v3)", "area": "traces", "adapter": "traces_evals",
     "probe_kind": "rest", "probe_method": "POST", "probe_path": "/api/3.0/mlflow/traces/search",
     "probe_body": {"locations": [], "max_results": 1},
     "keywords": ["mlflow", "trace", "tracing", "assessment", "scorer", "evaluation", "judge"],
     "docs_url": "https://docs.databricks.com/aws/en/mlflow3/genai/tracing/", "description": "Agent traces and assessments per experiment."},
    {"capability_key": "ai_gateway_usage_table", "label": "system.ai_gateway.usage", "area": "usage", "adapter": "usage",
     "probe_kind": "sql", "probe_path": "SELECT 1 FROM system.ai_gateway.usage LIMIT 1",
     "keywords": ["ai_gateway.usage", "usage tracking", "system table", "usage table"],
     "docs_url": "https://docs.databricks.com/aws/en/ai-gateway/usage-tracking", "description": "Per-request usage for models and MCP."},
    {"capability_key": "external_model_spend_table", "label": "system.ai_gateway.external_model_spend", "area": "usage", "adapter": "cost",
     "probe_kind": "sql", "probe_path": "SELECT 1 FROM system.ai_gateway.external_model_spend LIMIT 1",
     "keywords": ["external model spend", "cost", "budget", "billing"],
     "docs_url": "https://docs.databricks.com/aws/en/ai-gateway/cost-observability", "description": "External model spend in USD."},
    {"capability_key": "rfa_requests", "label": "Request for access (RFA) API", "area": "access", "adapter": None,
     "probe_kind": "rest", "probe_path": "/api/3.0/rfa/destinations/catalog/system", "keywords": ["request access", "access request", "rfa"],
     "docs_url": "https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/access-requests",
     "description": "UC access-request destinations. The registry runs its own approvals until an approve API exists."},
    {"capability_key": "service_policies", "label": "Unity Gateway service policies (guardrails)", "area": "guardrails", "adapter": "usage",
     "probe_kind": "none", "keywords": ["service policy", "service policies", "guardrail", "jailbreak", "sensitive data", "pii", "block_unsafe"],
     "docs_url": "https://docs.databricks.com/aws/en/data-governance/unity-catalog/service-policies/",
     "description": "Guardrails attached in the Unity Gateway UI. Read from usage-row metadata; no list API yet."},
    {"capability_key": "agent_runtime_apps", "label": "Agent Runtime (code-first agents on Apps)", "area": "agents", "adapter": "apps",
     "probe_kind": "rest", "probe_path": "/api/2.0/apps?page_size=1", "keywords": ["agent runtime", "agent bricks cli", "code-first agent"],
     "docs_url": "https://docs.databricks.com/aws/en/generative-ai/agent-runtime/", "description": "Agents deployed as Databricks Apps named agent-bricks-*."},
]
CAP_BY_KEY = {c["capability_key"]: c for c in CAPABILITIES}

REGISTRY_TERMS = ["agent", "mcp", "skill", "unity gateway", "ai gateway", "mlflow", "genie", "model serving", "serving endpoint",
                  "guardrail", "trace", "evaluation", "lakebase", "system table", "unity catalog", "supervisor", "knowledge assistant",
                  "databricks apps", "budget", "rate limit"]
LIFECYCLE = [("deprecation", r"\b(deprecat\w*|end[- ]of[- ]life|retir\w+|sunset|legacy)\b"),
             ("breaking", r"\b(breaking change|no longer|removed|will be removed|renamed)\b"),
             ("ga", r"\b(generally available|is now ga|\bGA\b)"),
             ("public_preview", r"public preview"), ("beta", r"\bbeta\b")]


# ─────────────────────────────── feeds ───────────────────────────────
_ATOM = "{http://www.w3.org/2005/Atom}"


def _text(el) -> str:
    return "".join(el.itertext()).strip() if el is not None else ""


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        d = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def parse_feed(data: bytes, kind: str) -> list[dict]:
    """RSS 2.0 or Atom → [{guid, title, link, published_at, summary}] (summary is plain text, ≤ 2000 chars)."""
    root = ET.fromstring(data)
    items = []
    if kind == "rss" or root.tag == "rss":
        for it in root.iter("item"):
            link = _text(it.find("link"))
            items.append({"guid": _text(it.find("guid")) or link or _text(it.find("title")), "title": strip_html(_text(it.find("title"))),
                          "link": link, "published_at": _dt(_text(it.find("pubDate"))),
                          "summary": strip_html(_text(it.find("description")))[:2000]})
    else:
        for e in root.iter(f"{_ATOM}entry"):
            link_el = e.find(f"{_ATOM}link")
            link = link_el.get("href") if link_el is not None else ""
            items.append({"guid": _text(e.find(f"{_ATOM}id")) or link, "title": strip_html(_text(e.find(f"{_ATOM}title"))),
                          "link": link, "published_at": _dt(_text(e.find(f"{_ATOM}updated")) or _text(e.find(f"{_ATOM}published"))),
                          "summary": strip_html(_text(e.find(f"{_ATOM}content")) or _text(e.find(f"{_ATOM}summary")))[:2000]})
    return [i for i in items if i["guid"] and i["title"]]


STRONG_BREAKING = r"\b(breaking change|will be removed|is removed|are removed|no longer (be )?supported|end[- ]of[- ]life|will stop working|must migrate)\b"


def classify(item: dict, source_id: str) -> dict:
    """Relevance 0–100 against the capability catalog + registry vocabulary, lifecycle and breaking hints.

    Capabilities are ordered strongest first: title hits weigh more than summary hits. The first one is the
    item's primary capability. Lifecycle and breaking hints read the TITLE first, so a GA announcement that
    mentions a legacy path in its body isn't flagged as a deprecation.
    """
    title = item["title"].lower()
    text = f"{title} \n {(item.get('summary') or '').lower()}"
    scored, terms, score = [], set(), 0
    for c in CAPABILITIES:
        hits = [k for k in c["keywords"] if re.search(rf"\b{re.escape(k)}\b", text)]
        if not hits:
            continue
        in_title = [k for k in hits if re.search(rf"\b{re.escape(k)}\b", title)]
        weight = 18 + 12 * bool(in_title)
        scored.append((len(in_title) * 10 + len(hits), c["capability_key"]))
        terms.update(hits)
        score += weight
    caps = [k for _, k in sorted(scored, key=lambda x: (-x[0], x[1]))]
    general = [t for t in REGISTRY_TERMS if re.search(rf"\b{re.escape(t)}\b", text)]
    terms.update(general)
    score += 4 * len(general)
    if source_id in ("mlflow_releases",):
        score += 10 if re.search(r"\b(trac|assess|scorer|evaluat|gateway|mcp|agent)", text) else 0
    if source_id in ("databricks_sdk_py", "databricks_cli"):
        score += 8 if re.search(r"\b(postgres|apps|serving|mcp|agent|genie|skills?|ai.?gateway)\b", text) else 0
    lifecycle = next((name for name, rx in LIFECYCLE if re.search(rx, title, re.I)), None) or \
        next((name for name, rx in LIFECYCLE if name not in ("deprecation", "breaking") and re.search(rx, text, re.I)), None)
    breaking = bool(lifecycle in ("deprecation", "breaking") or re.search(STRONG_BREAKING, text, re.I))
    if breaking and caps:
        score += 15
    return {"relevance": max(0, min(100, score)), "matched_capabilities": caps, "matched_terms": sorted(terms)[:20],
            "lifecycle_hint": lifecycle, "breaking_hint": breaking}


def rescore(cur) -> int:
    """Re-classify stored items, e.g. after the capability catalog changed in a new release."""
    cur.execute("SELECT item_id, source_id, title, summary FROM feed_item")
    n = 0
    for it in list(cur.fetchall()):
        c = classify(it, it["source_id"])
        cur.execute("""UPDATE feed_item SET relevance = %s, matched_capabilities = %s, matched_terms = %s, lifecycle_hint = %s,
                              breaking_hint = %s WHERE item_id = %s""",
                    (c["relevance"], c["matched_capabilities"], c["matched_terms"], c["lifecycle_hint"], c["breaking_hint"], it["item_id"]))
        n += 1
    return n


def http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "agent-registry-hub/1.0 (+platform-watch)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed allow-list of https feed URLs
        return r.read()


def fetch_feeds(cur, fetch=http_get, max_new_per_source: int = 200) -> dict:
    cur.execute("SELECT * FROM feed_source WHERE enabled ORDER BY source_id")
    out = {}
    for src in list(cur.fetchall()):
        try:
            items = parse_feed(fetch(src["url"]), src["kind"])
        except Exception as e:  # noqa: BLE001 - one bad feed never stops the others
            cur.execute("UPDATE feed_source SET last_fetched_at = now(), last_status = %s WHERE source_id = %s",
                        (f"error: {type(e).__name__}: {str(e)[:200]}", src["source_id"]))
            out[src["source_id"]] = {"error": str(e)[:200]}
            continue
        new = 0
        for it in items[:max_new_per_source]:
            c = classify(it, src["source_id"])
            # The release notes publish one announcement under several guids (one anchor per docs page), so an item
            # counts as new only if its guid AND its (title, publish date) are new for that source.
            cur.execute(
                """INSERT INTO feed_item (source_id, guid, title, link, published_at, summary, relevance, matched_capabilities,
                         matched_terms, lifecycle_hint, breaking_hint)
                   SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s
                    WHERE NOT EXISTS (SELECT 1 FROM feed_item f WHERE f.source_id = %s AND f.title = %s
                                        AND f.published_at IS NOT DISTINCT FROM %s)
                   ON CONFLICT (source_id, guid) DO NOTHING""",
                (src["source_id"], it["guid"][:1000], it["title"][:500], it["link"], it["published_at"], it["summary"],
                 c["relevance"], c["matched_capabilities"], c["matched_terms"], c["lifecycle_hint"], c["breaking_hint"],
                 src["source_id"], it["title"][:500], it["published_at"]))
            new += cur.rowcount
        cur.execute("""UPDATE feed_source SET last_fetched_at = now(), last_status = %s,
                         items_total = (SELECT count(*) FROM feed_item WHERE source_id = %s) WHERE source_id = %s""",
                    (f"ok: {len(items)} items, {new} new", src["source_id"], src["source_id"]))
        out[src["source_id"]] = {"items": len(items), "new": new}
    return out


# ─────────────────────────────── capabilities ───────────────────────────────
def sync_catalog(cur) -> None:
    """Upsert the code-defined catalog. Probe results, first_available_at and adapter_enabled are kept."""
    for c in CAPABILITIES:
        cur.execute(
            """INSERT INTO capability (capability_key, label, area, description, docs_url, keywords, probe_kind, probe_method,
                     probe_path, probe_body, adapter, adapter_enabled)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (capability_key) DO UPDATE SET label = EXCLUDED.label, area = EXCLUDED.area,
                     description = EXCLUDED.description, docs_url = EXCLUDED.docs_url, keywords = EXCLUDED.keywords,
                     probe_kind = EXCLUDED.probe_kind, probe_method = EXCLUDED.probe_method, probe_path = EXCLUDED.probe_path,
                     probe_body = EXCLUDED.probe_body, adapter = EXCLUDED.adapter""",
            (c["capability_key"], c["label"], c["area"], c.get("description"), c.get("docs_url"), c["keywords"], c["probe_kind"],
             c.get("probe_method", "GET"), c.get("probe_path"), Jsonb(c.get("probe_body")) if c.get("probe_body") else None,
             c.get("adapter"), bool(c.get("adapter"))),
        )


def classify_probe(status: int | None, body: str) -> str:
    b = (body or "").lower()
    if status is None:
        return "error"
    if 200 <= status < 300:
        return "available"
    if status == 404 and ("endpoint_not_found" in b or "no api found" in b or "not available in this workspace" in b or not b.strip()):
        return "unavailable"
    if "not available in this workspace" in b or "feature_disabled" in b or "not enabled" in b:
        return "unavailable"
    if status in (401, 403):
        return "no_access"
    if 400 <= status < 500:
        return "available"  # the route exists; our probe parameters were rejected
    return "error"


def probe_capabilities(cur, rest_call, sql_call=None) -> dict:
    """``rest_call(method, path, body) -> (status, text)``; ``sql_call(statement) -> None`` (raises on failure)."""
    sync_catalog(cur)
    cur.execute("SELECT * FROM capability ORDER BY capability_key")
    changes = {}
    for cap in list(cur.fetchall()):
        if cap["probe_kind"] == "none":
            continue
        status_code, detail = None, ""
        try:
            if cap["probe_kind"] == "rest":
                status_code, detail = rest_call(cap["probe_method"], cap["probe_path"], cap["probe_body"])
                state = classify_probe(status_code, detail)
            else:
                if sql_call is None:
                    continue
                try:
                    sql_call(cap["probe_path"])
                    state, status_code = "available", 200
                except Exception as e:  # noqa: BLE001
                    msg = str(e).lower()
                    state = "no_access" if ("permission" in msg or "insufficient" in msg) else (
                        "unavailable" if ("not found" in msg or "does not exist" in msg or "table_or_view_not_found" in msg) else "error")
                    detail = str(e)[:300]
        except Exception as e:  # noqa: BLE001
            state, detail = "error", f"{type(e).__name__}: {str(e)[:300]}"
        cur.execute(
            """UPDATE capability SET status = %s, http_status = %s, probe_detail = %s, last_probed_at = now(),
                      first_available_at = CASE WHEN %s IN ('available','no_access') AND first_available_at IS NULL THEN now() ELSE first_available_at END
                WHERE capability_key = %s RETURNING (xmax = 0) AS inserted""",
            (state, status_code, (detail or "")[:500], state, cap["capability_key"]))
        if cap["status"] != state:
            changes[cap["capability_key"]] = {"from": cap["status"], "to": state}
    return changes


# ─────────────────────────────── migrations analysis ───────────────────────────────
BREAKING_SQL = [
    (r"\bdrop\s+(table|schema|view|materialized\s+view|function|type)\b", "drops an object"),
    (r"\bdrop\s+column\b", "drops a column"),
    (r"\balter\s+column\s+\w+\s+(set\s+data\s+)?type\b", "changes a column type"),
    (r"\brename\s+(column|to)\b", "renames a table or column"),
    (r"\bset\s+not\s+null\b", "adds a NOT NULL constraint"),
    (r"\btruncate\b", "truncates data"),
    (r"\bdelete\s+from\b", "deletes rows"),
    (r"\bdrop\s+constraint\b", "drops a constraint"),
]


def analyze_migration(text: str) -> dict:
    """Static breaking-change analysis: explicit ``-- breaking: <why>`` headers, plus destructive DDL/DML."""
    body = re.sub(r"--[^\n]*", "", text)  # ignore comments for the DDL scan
    reasons = [m.strip() for m in re.findall(r"^--\s*breaking:\s*(.+)$", text, re.I | re.M)]
    for rx, why in BREAKING_SQL:
        if re.search(rx, body, re.I):
            reasons.append(why)
    allow_loss = bool(re.search(r"^--\s*allow-data-loss\b", text, re.I | re.M))
    return {"breaking": bool(reasons), "reasons": sorted(set(reasons)), "allow_data_loss": allow_loss,
            "statements": len([s for s in body.split(";") if s.strip()])}


def pending_migrations(cur, directory) -> list[dict]:
    from core import migrate

    cur.execute("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")
    applied = set()
    if cur.fetchone()["ok"]:
        cur.execute("SELECT version FROM schema_migrations")
        applied = {r["version"] for r in cur.fetchall()}
    out = []
    for m in migrate.discover(directory):
        if m.version not in applied:
            out.append({"version": m.version, **analyze_migration(m.text)})
    return out


# ─────────────────────────────── candidates ───────────────────────────────
def get_setting(cur, key: str, default=None):
    cur.execute("SELECT value FROM watch_settings WHERE key = %s", (key,))
    r = cur.fetchone()
    return r["value"] if r else default


def _version_tuple(v: str | None) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v or "0")[:4]) or (0,)


def _upsert_candidate(cur, **c) -> int | None:
    cur.execute(
        """INSERT INTO update_candidate (kind, title, summary, from_version, to_version, capability_key, feed_item_ids, migrations,
                 breaking, breaking_reasons)
           VALUES (%(kind)s, %(title)s, %(summary)s, %(from_version)s, %(to_version)s, %(capability_key)s, %(feed_item_ids)s,
                   %(migrations)s, %(breaking)s, %(breaking_reasons)s)
           ON CONFLICT (kind, coalesce(capability_key, ''), coalesce(to_version, '')) WHERE status NOT IN ('applied','rejected')
           -- coalesce: array_agg over no rows is NULL (a capability advisory has no feed items) and the column is NOT NULL
           DO UPDATE SET feed_item_ids = coalesce((SELECT array_agg(DISTINCT x ORDER BY x)
                                                   FROM unnest(update_candidate.feed_item_ids || EXCLUDED.feed_item_ids) x), '{}'),
                         updated_at = now()
           RETURNING candidate_id, (xmax = 0) AS inserted""",
        {"summary": None, "from_version": None, "to_version": None, "capability_key": None, "feed_item_ids": [],
         "breaking": False, "breaking_reasons": [], **c, "migrations": Jsonb(c.get("migrations") or [])},
    )
    r = cur.fetchone()
    return r["candidate_id"] if r and r["inserted"] else None


def detect_candidates(cur, *, staged_root=None, staged_version: str | None = None) -> list[int]:
    """Create candidates from (1) a newer staged app version, (2) capability transitions, (3) relevant feed items."""
    created: list[int] = []
    running = get_setting(cur, "running_version")
    if staged_root is not None and staged_version and _version_tuple(staged_version) > _version_tuple(running):
        migs = pending_migrations(cur, staged_root / "pipeline" / "migrations")
        reasons = sorted({f"{m['version']}: {r}" for m in migs for r in m["reasons"]})
        cid = _upsert_candidate(cur, kind="app_release", title=f"Agent Registry Hub {staged_version} is staged",
                                summary=f"Running {running or 'unknown'} → staged {staged_version}; {len(migs)} pending migration(s).",
                                from_version=running, to_version=staged_version, migrations=migs,
                                breaking=bool(reasons), breaking_reasons=reasons)
        if cid:
            created.append(cid)
    # newly available APIs: adapter shipped but disabled → capability; no adapter yet → advisory
    cur.execute("""SELECT * FROM capability WHERE status IN ('available','no_access') AND first_available_at > now() - interval '30 days'
                     AND (adapter IS NULL OR NOT adapter_enabled)""")
    for cap in list(cur.fetchall()):
        kind = "capability" if cap["adapter"] else "advisory"
        cid = _upsert_candidate(cur, kind=kind, capability_key=cap["capability_key"],
                                title=f"New API available here: {cap['label']}",
                                summary=(f"{cap['description'] or ''} Probe {cap['probe_method']} {cap['probe_path']} → {cap['status']} "
                                         f"(HTTP {cap['http_status']}).").strip())
        if cid:
            created.append(cid)
    # relevant announcements → ONE advisory per matched capability (items aggregate), each gets a compatibility run
    threshold = int(get_setting(cur, "relevance_threshold", 35) or 35)
    cur.execute("""SELECT * FROM feed_item WHERE status = 'new' AND relevance >= %s AND matched_capabilities <> '{}'
                     AND fetched_at > now() - interval '45 days'
                    ORDER BY relevance DESC, published_at DESC NULLS LAST LIMIT 100""", (threshold,))
    by_cap: dict[str, list[dict]] = {}
    for it in cur.fetchall():
        by_cap.setdefault(it["matched_capabilities"][0], []).append(it)
    for key, items in by_cap.items():
        cap = CAP_BY_KEY.get(key, {"label": key})
        breaking = [i for i in items if i["breaking_hint"]]
        cid = _upsert_candidate(
            cur, kind="advisory", capability_key=key, title=f"Release notes: {cap['label']}",
            feed_item_ids=[i["item_id"] for i in items],
            summary="; ".join(i["title"] for i in items[:5])[:600],
            breaking=bool(breaking), breaking_reasons=[f"announcement: {i['title'][:120]}" for i in breaking][:5])
        cur.execute("UPDATE feed_item SET status = 'linked', candidate_id = coalesce(candidate_id, %s, "
                    "(SELECT candidate_id FROM update_candidate WHERE kind = 'advisory' AND capability_key = %s AND status NOT IN ('applied','rejected') LIMIT 1)) "
                    "WHERE item_id = ANY(%s)", (cid, key, [i["item_id"] for i in items]))
        if cid:
            created.append(cid)
    if created:
        cur.execute("SELECT DISTINCT email FROM role_assignment WHERE role IN ('admin','steward')")
        from core import config
        admins = {r["email"] for r in cur.fetchall()} | set(config.REGISTRY_ADMINS)
        for email in admins:
            notify.queue(cur, email, "platform_update", f"{len(created)} platform update candidate(s) detected",
                         "Regression tests run on a Lakebase branch before anything changes. Review them in Platform updates.",
                         None, ",".join(map(str, created)))
    return created


# ─────────────────────────────── reads + decisions (app) ───────────────────────────────
def overview(cur) -> dict:
    cur.execute("SELECT status, count(*) AS n FROM update_candidate GROUP BY status")
    counts = {r["status"]: int(r["n"]) for r in cur.fetchall()}
    cur.execute("SELECT * FROM feed_source ORDER BY source_id")
    sources = list(cur.fetchall())
    cur.execute("SELECT key, value FROM watch_settings")
    settings = {r["key"]: r["value"] for r in cur.fetchall()}
    return {"counts": counts, "sources": sources, "settings": settings,
            "ready": counts.get("passed", 0), "attention": counts.get("failed", 0) + counts.get("apply_failed", 0)}


def candidates(cur, status: str | None = None) -> list[dict]:
    where, params = ("WHERE status = ANY(%s)", [status.split(",")]) if status else ("", [])
    cur.execute(f"SELECT * FROM update_candidate {where} ORDER BY (status IN ('passed','failed','testing','detected','delayed')) DESC, updated_at DESC LIMIT 200",
                params)
    rows = list(cur.fetchall())
    ids = sorted({i for r in rows for i in (r["feed_item_ids"] or [])})
    items = {}
    if ids:
        cur.execute("SELECT item_id, source_id, title, link, published_at, lifecycle_hint FROM feed_item WHERE item_id = ANY(%s)", (ids,))
        items = {r["item_id"]: r for r in cur.fetchall()}
    for r in rows:
        r["feed_items"] = [items[i] for i in (r["feed_item_ids"] or []) if i in items]
    return rows


def feed(cur, min_relevance: int = 0, source: str | None = None, limit: int = 200) -> list[dict]:
    clauses, params = ["relevance >= %s"], [min_relevance]
    if source:
        clauses.append("source_id = %s"); params.append(source)
    cur.execute(f"""SELECT item_id, source_id, title, link, published_at, left(summary, 400) AS summary, relevance, matched_capabilities,
                           matched_terms, lifecycle_hint, breaking_hint, status, candidate_id
                      FROM feed_item WHERE {' AND '.join(clauses)} ORDER BY published_at DESC NULLS LAST, relevance DESC LIMIT %s""",
                [*params, max(1, min(limit, 500))])
    return list(cur.fetchall())


def capabilities(cur) -> list[dict]:
    cur.execute("SELECT * FROM capability ORDER BY area, label")
    return list(cur.fetchall())


ACTIONS = ("accept", "delay", "reject", "acknowledge")


def decide(cur, candidate_id: int, action: str, *, p: authz.Principal, delay_until: str | None = None, note: str | None = None) -> dict:
    authz.require(p.is_admin, "Only an admin can accept, delay or reject platform updates")
    if action not in ACTIONS:
        raise ValueError(f"action must be one of {', '.join(ACTIONS)}")
    cur.execute("SELECT * FROM update_candidate WHERE candidate_id = %s FOR UPDATE", (candidate_id,))
    c = cur.fetchone()
    if not c:
        raise NotFound(f"candidate {candidate_id} not found")
    if c["status"] in ("applied", "applying", "rejected"):
        raise Conflict(f"This candidate is already {c['status']}")
    if action == "accept":
        if c["kind"] != "advisory" and c["status"] != "passed":
            raise Conflict("Only a candidate whose regression passed can be accepted. Run the regression first")
        if c["breaking"] and not (note or "").strip():
            raise ValueError("Accepting a breaking change needs a note (what you checked, who you told)")
        new = "accepted"
    elif action == "delay":
        days = int(get_setting(cur, "default_delay_days", 7) or 7)
        until = datetime.fromisoformat(delay_until.replace("Z", "+00:00")) if delay_until else datetime.now(timezone.utc) + timedelta(days=days)
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        if until <= datetime.now(timezone.utc):
            raise ValueError("Delay until must be in the future")
        cur.execute("UPDATE update_candidate SET delay_until = %s WHERE candidate_id = %s", (until, candidate_id))
        new = "delayed"
    elif action == "acknowledge":
        if c["kind"] != "advisory":
            raise ValueError("Only advisories can be acknowledged; accept or delay updates")
        new = "applied"
    else:
        if not (note or "").strip():
            raise ValueError("A reason is required to reject an update")
        new = "rejected"
    cur.execute("""UPDATE update_candidate SET status = %s, decided_by = %s, decided_at = now(), decision_note = %s, updated_at = now(),
                      applied_at = CASE WHEN %s = 'applied' THEN now() ELSE applied_at END WHERE candidate_id = %s RETURNING *""",
                (new, p.email, (note or "").strip() or None, new, candidate_id))
    row = cur.fetchone()
    audit.audit_event(p.email, f"platform_update.{action}", "update_candidate", candidate_id,
                      before={"status": c["status"]}, after={"status": new, "note": note, "delay_until": row["delay_until"]},
                      request_id=p.request_id, cur=cur)
    return row


def set_setting(cur, key: str, value, *, p: authz.Principal) -> dict:
    authz.require(p.is_admin, "Only an admin can change Platform Watch settings")
    allowed = {"auto_upgrade": ("never", "non_breaking", "all"), "relevance_threshold": None, "default_delay_days": None,
               "keep_failed_branch_hours": None}
    if key not in allowed:
        raise ValueError(f"unknown setting {key}")
    if allowed[key] and value not in allowed[key]:
        raise ValueError(f"{key} must be one of {', '.join(allowed[key])}")
    if allowed[key] is None:
        value = int(value)
        if not 0 <= value <= 1000:
            raise ValueError(f"{key} is out of range")
    cur.execute("""INSERT INTO watch_settings (key, value, updated_by) VALUES (%s, %s, %s)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()""",
                (key, Jsonb(value), p.email))
    audit.audit_event(p.email, "platform_watch.setting", "watch_settings", key, after={"value": value}, request_id=p.request_id, cur=cur)
    return {"key": key, "value": value}


def resurface_delayed(cur) -> int:
    """Delayed candidates whose delay passed go back to their tested state and admins are reminded."""
    cur.execute("""UPDATE update_candidate SET status = CASE WHEN regression IS NOT NULL AND (regression->>'passed')::boolean THEN 'passed'
                                                            WHEN regression IS NOT NULL THEN 'failed' ELSE 'detected' END,
                          updated_at = now()
                    WHERE status = 'delayed' AND delay_until <= now() RETURNING candidate_id, title""")
    rows = cur.fetchall()
    for r in rows:
        if r["candidate_id"]:
            cur.execute("SELECT DISTINCT email FROM role_assignment WHERE role = 'admin'")
            from core import config
            for email in {x["email"] for x in cur.fetchall()} | set(config.REGISTRY_ADMINS):
                notify.queue(cur, email, "platform_update", f"Delayed update is due again: {r['title']}", None, None, r["candidate_id"])
    return len(rows)


def record_running_version(cur, version: str) -> None:
    cur.execute("""INSERT INTO watch_settings (key, value, updated_by) VALUES ('running_version', %s, 'app')
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""", (Jsonb(version),))
