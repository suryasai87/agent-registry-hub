// Sidebar + command-palette navigation (sidebar order from docs/research/03-ux-benchmark.md §3.2).
// Add a page: append an entry here and register its lazy component in App.tsx (PAGES).
// Entries with ``roles`` show only for users holding at least one of those roles (GET /api/me → roles).
import {
  Activity, BadgeCheck, Bell, BookOpen, ClipboardCheck, Compass, FileClock, GitBranch, Home, Inbox, LayoutGrid,
  PlusCircle, RefreshCcwDot, ShieldCheck, Workflow, type LucideIcon,
} from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  section: string;
  roles?: string[];
  description?: string;
}

const REVIEWERS = ["owner", "steward", "admin"];
const QUALITY = ["owner", "steward", "admin", "auditor"];
const GOVERNORS = ["steward", "admin", "auditor"];

export const NAV: NavItem[] = [
  { path: "/how-it-works", label: "How It Works", icon: Workflow, section: "Overview", description: "How the registry discovers, governs and serves AI assets" },
  { path: "/home", label: "Home", icon: Home, section: "Overview", description: "Your top actions, subscriptions and recent changes" },
  { path: "/catalog", label: "Catalog", icon: LayoutGrid, section: "Discover", description: "Agents, MCP servers, tools and skills" },
  { path: "/me", label: "My workspace", icon: Compass, section: "Workspace", description: "Subscriptions, access, requests and impacts" },
  { path: "/requests", label: "Requests", icon: Inbox, section: "Workspace", roles: REVIEWERS, description: "Access requests awaiting your decision" },
  { path: "/changes", label: "Changes & Impact", icon: FileClock, section: "Workspace", description: "Published changes, who they affect, acknowledgements" },
  { path: "/lineage", label: "Lineage", icon: GitBranch, section: "Insights", description: "Upstream and downstream of agents, MCPs, tools and data" },
  { path: "/usage-cost", label: "Usage & Cost", icon: Activity, section: "Insights", description: "Requests, users, cost, budgets and anomalies" },
  { path: "/quality", label: "Quality", icon: BadgeCheck, section: "Insights", roles: QUALITY, description: "Traces and evals for Databricks-built agents" },
  { path: "/policies", label: "Policies & Guardrails", icon: ShieldCheck, section: "Insights", description: "Guardrails, coverage, gaps and violations" },
  { path: "/governance", label: "Governance", icon: ClipboardCheck, section: "Govern", roles: GOVERNORS, description: "Sources & sync, curation, overrides, roles" },
  { path: "/audit", label: "Audit", icon: BookOpen, section: "Govern", roles: GOVERNORS, description: "Tamper-evident audit trail and evidence export" },
  { path: "/platform-updates", label: "Platform updates", icon: RefreshCcwDot, section: "Govern", roles: GOVERNORS, description: "Release feeds, new APIs, branch-tested upgrades: accept or delay" },
  { path: "/register", label: "Register an asset", icon: PlusCircle, section: "Govern", description: "Register a custom agent, MCP server or skill" },
  { path: "/notifications", label: "Notifications", icon: Bell, section: "Workspace", description: "Your inbox" },
];

/** Items visible to a user with ``roles`` (a single role string is accepted for backwards compatibility). */
export function visibleNav(items: NavItem[], roles: readonly string[] | string | null | undefined): NavItem[] {
  const held = new Set(Array.isArray(roles) ? roles : roles ? [roles as string] : []);
  return items.filter((item) => !item.roles || item.roles.some((r) => held.has(r)));
}

/** Items grouped by section, keeping the order in which sections first appear. */
export function navSections(items: NavItem[]): [string, NavItem[]][] {
  const groups = new Map<string, NavItem[]>();
  for (const item of items) {
    const list = groups.get(item.section);
    if (list) list.push(item);
    else groups.set(item.section, [item]);
  }
  return [...groups.entries()];
}
