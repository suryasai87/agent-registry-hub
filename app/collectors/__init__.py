"""Registry collectors: read the Databricks workspace (REST + system tables) and upsert the Lakebase registry.

``ORDER`` is the dependency order: assets first (agents, Genie, MCP servers, tools, skills), then the edges
that need those assets to exist (apps), then usage, cost and traces/evals. ``OPTIONAL`` collectors run after them,
only when an admin configured their source (or when selected explicitly, which records a 'skipped' run):
Microsoft Agent 365 registrations, matched to the agents the sync just refreshed.
"""
from __future__ import annotations

from importlib import import_module

ORDER = (
    "agent_endpoints",
    "agent_bricks",
    "genie",
    "mcp_connections",
    "mcp_managed",
    "mcp_system",
    "skills",
    "apps",
    "usage",
    "cost",
    "traces_evals",
)
OPTIONAL = ("agent365",)

_CLASS_NAMES = {
    "agent_endpoints": "AgentEndpointsCollector",
    "agent_bricks": "AgentBricksCollector",
    "genie": "GenieCollector",
    "mcp_connections": "McpConnectionsCollector",
    "mcp_managed": "McpManagedCollector",
    "mcp_system": "McpSystemCollector",
    "skills": "SkillsCollector",
    "apps": "AppsCollector",
    "agent365": "Agent365Collector",
    "usage": "UsageCollector",
    "cost": "CostCollector",
    "traces_evals": "TracesEvalsCollector",
}


def configured(name: str) -> bool:
    """Whether an OPTIONAL collector's source is configured (ORDER collectors always are)."""
    if name == "agent365":
        from registry.agent365 import graph_connection

        return graph_connection() is not None
    return name in ORDER


def get(name: str):
    if name not in _CLASS_NAMES:
        raise KeyError(f"unknown collector {name!r}")
    return getattr(import_module(f"collectors.{name}"), _CLASS_NAMES[name])


def run_all(selected=None, triggered_by: str = "schedule", **kwargs):
    from collectors.base import run_all as _run_all

    return _run_all(selected, triggered_by, **kwargs)
