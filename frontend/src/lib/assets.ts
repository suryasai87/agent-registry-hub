// Asset URN helpers shared by every page (URN scheme: docs/API_CONTRACT.md).
import type { AssetType } from "./types";

/** Client route of an asset's entity page. URNs contain ':' '.' '/', so encode them as one path segment. */
export function assetHref(assetId: string, tab?: string): string {
  return `/assets/${encodeURIComponent(assetId)}${tab ? `/${tab}` : ""}`;
}

/** API path prefix for an asset. */
export function assetApi(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

export function typeOf(assetId: string): AssetType | null {
  if (assetId.startsWith("agent:")) return "agent";
  if (assetId.startsWith("mcp:")) return "mcp_server";
  if (assetId.startsWith("tool:")) return "tool";
  if (assetId.startsWith("skill:")) return "skill";
  return null;
}

/** Tool URNs are `tool:mcp:<server>/<tool>`: the tool name is everything after the LAST '/'. */
export function toolName(assetId: string): string {
  const i = assetId.lastIndexOf("/");
  return i >= 0 ? assetId.slice(i + 1) : assetId.split(".").pop() ?? assetId;
}

export const TYPE_LABEL: Record<AssetType, string> = { agent: "Agent", mcp_server: "MCP server", tool: "Tool", skill: "Skill" };

export const SUBTYPE_LABEL: Record<string, string> = {
  agent_bricks_supervisor: "Supervisor Agent",
  agent_bricks_knowledge_assistant: "Knowledge Assistant",
  agent_bricks_information_extraction: "Information Extraction",
  custom_agent: "Custom agent (Model Serving)",
  agent_runtime_app: "Agent Runtime app",
  genie_space: "Genie space",
  managed_uc_functions: "Managed MCP · UC functions",
  external_connection: "External MCP · UC connection",
  custom_app: "Custom MCP · Databricks App",
  databricks_workspace: "MCP · other workspace",
  databricks_system_mcp: "Databricks-provided MCP",
  system: "Databricks-provided MCP",
  system_mcp: "Databricks-provided MCP",
  agent_bricks_model_specialization: "Agent Bricks · Custom LLM",
  uc_mcp_service: "Unity Gateway MCP service",
  uc_function: "UC function",
  mcp_tool: "MCP tool",
  agent_skill: "Agent skill",
  uc_skill: "UC skill",
};

export function subtypeLabel(subtype: string | null | undefined): string {
  if (!subtype) return "";
  return SUBTYPE_LABEL[subtype] ?? subtype.replace(/_/g, " ");
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "–";
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

export function fmtNum(v: number | null | undefined): string {
  if (v == null) return "–";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return v == null ? "–" : `${(v * 100).toFixed(digits)}%`;
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "–";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
