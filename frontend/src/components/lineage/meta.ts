// Visual vocabulary of lineage nodes: every node type has a fixed shape, icon and tone (benchmark §7.3:
// "each type has a fixed shape and icon; colour tokens are secondary"). Class strings are static for Tailwind.
import {
  AppWindow, Bot, Brain, Globe, HardDrive, KeyRound, ScanSearch, Server, Sparkles, Table2, User, Wrench, type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import type { NodeType } from "../../lib/types";

export type TileShape = "rounded" | "hex" | "circle" | "diamond" | "octagon" | "cylinder" | "pentagon" | "square" | "dashed";

export interface NodeMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  /** Icon tile tone. */
  tile: string;
  /** Node outline radius. */
  radius: string;
  shape: TileShape;
  /** MiniMap colour (CSS colour string). */
  color: string;
  /** Asset node types have entity pages. */
  asset: boolean;
}

export const NODE_META: Record<NodeType, NodeMeta> = {
  agent: { label: "Agent", plural: "agents", icon: Bot, tile: "bg-type-agent/18 text-type-agent", radius: "rounded-xl", shape: "rounded", color: "hsl(var(--type-agent))", asset: true },
  mcp_server: { label: "MCP server", plural: "MCP servers", icon: Server, tile: "bg-type-mcp/18 text-type-mcp", radius: "rounded-lg", shape: "hex", color: "hsl(var(--type-mcp))", asset: true },
  tool: { label: "Tool", plural: "tools", icon: Wrench, tile: "bg-type-tool/18 text-type-tool", radius: "rounded-full", shape: "circle", color: "hsl(var(--type-tool))", asset: true },
  skill: { label: "Skill", plural: "skills", icon: Sparkles, tile: "bg-type-skill/18 text-type-skill", radius: "rounded-xl", shape: "diamond", color: "hsl(var(--type-skill))", asset: true },
  user: { label: "User", plural: "users", icon: User, tile: "bg-info/15 text-info", radius: "rounded-full", shape: "circle", color: "hsl(var(--info))", asset: false },
  service_principal: { label: "Service principal", plural: "service principals", icon: KeyRound, tile: "bg-info/15 text-info", radius: "rounded-full", shape: "octagon", color: "hsl(var(--info))", asset: false },
  table: { label: "Table", plural: "tables", icon: Table2, tile: "bg-db-teal/15 text-db-teal", radius: "rounded-md", shape: "cylinder", color: "hsl(var(--db-teal))", asset: false },
  index: { label: "Vector index", plural: "vector indexes", icon: ScanSearch, tile: "bg-db-teal/15 text-db-teal", radius: "rounded-md", shape: "cylinder", color: "hsl(var(--db-teal))", asset: false },
  volume: { label: "Volume", plural: "volumes", icon: HardDrive, tile: "bg-db-teal/15 text-db-teal", radius: "rounded-md", shape: "cylinder", color: "hsl(var(--db-teal))", asset: false },
  model: { label: "Model", plural: "models", icon: Brain, tile: "bg-db-orange/15 text-db-orange", radius: "rounded-lg", shape: "pentagon", color: "hsl(var(--db-orange))", asset: false },
  app: { label: "App", plural: "apps", icon: AppWindow, tile: "bg-db-lava/15 text-db-lava", radius: "rounded-sm", shape: "square", color: "hsl(var(--db-lava))", asset: false },
  external: { label: "External", plural: "external systems", icon: Globe, tile: "bg-muted text-muted-foreground", radius: "rounded-lg", shape: "dashed", color: "hsl(var(--muted-foreground))", asset: false },
};

export function nodeMeta(type: NodeType | string): NodeMeta {
  return NODE_META[type as NodeType] ?? NODE_META.external;
}

/** Inline style that gives the icon tile its type shape. */
export function tileStyle(shape: TileShape): CSSProperties {
  switch (shape) {
    case "hex":
      return { clipPath: "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)" };
    case "circle":
      return { borderRadius: "999px" };
    case "diamond":
      return { clipPath: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" };
    case "octagon":
      return { clipPath: "polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)" };
    case "cylinder":
      return { borderRadius: "50% / 24%" };
    case "pentagon":
      return { clipPath: "polygon(50% 0, 100% 38%, 82% 100%, 18% 100%, 0 38%)" };
    case "square":
      return { borderRadius: "2px" };
    case "dashed":
      return { borderRadius: "8px", border: "1.5px dashed currentColor" };
    default:
      return { borderRadius: "8px" };
  }
}
