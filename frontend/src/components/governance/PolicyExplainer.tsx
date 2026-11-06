// Read-only explanation: how platform controls map into the registry's policy chips and coverage (benchmark §7.2).
import { Database, Network, Server, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Card, SectionTitle } from "../ui";

const SOURCES: { icon: ReactNode; title: string; provider: string; reads: string; becomes: string[] }[] = [
  {
    icon: <Network size={16} aria-hidden />,
    title: "Unity AI Gateway service policies",
    provider: "unity_gateway",
    reads: "Guardrail policies attached to Unity Gateway MCP services (input / output, block / mask / flag), and per-request usage tracking for MCP services in system.ai_gateway.usage.",
    becomes: [
      "Each synced policy becomes an active binding and a chip on the MCP server (inherited by its tools).",
      "Input and output guardrails meet the guardrail requirements of the asset's risk tier.",
      "MCP calls on the legacy /api/2.0/mcp path bypass service policies: register the server as a UC MCP service to attach guardrails.",
    ],
  },
  {
    icon: <Server size={16} aria-hidden />,
    title: "Serving endpoint AI Gateway guardrails",
    provider: "serving_ai_gateway",
    reads: "The AI Gateway configuration of the Model Serving endpoint behind an agent: safety and PII guardrails on input and output, and whether usage tracking is on.",
    becomes: [
      "Chips on the agent served by that endpoint (custom agents, Knowledge Assistants, Supervisors).",
      "They meet the same input / output guardrail requirements as gateway service policies.",
      "Traffic covered by a guardrail counts toward governed traffic.",
    ],
  },
  {
    icon: <Database size={16} aria-hidden />,
    title: "Platform-default Unity Catalog gates",
    provider: "unity_catalog",
    reads: "Facts that hold for every MCP server reached through the Databricks MCP proxy: each call needs EXECUTE (UC functions, MCP services) or USE CONNECTION (external and app MCPs), and is audited in system.access.audit.",
    becomes: [
      "Shown as “platform default” chips, never as app-configured policies.",
      "They meet the access and usage-tracking requirements for proxied MCP servers and UC tools, and their traffic counts as governed.",
      "Access requests approved here provision these same UC grants.",
    ],
  },
  {
    icon: <ShieldCheck size={16} aria-hidden />,
    title: "Registry facts",
    provider: "registry",
    reads: "Requirements the registry checks itself: a named owner, a documented purpose and support channel, a monthly budget, and certification where the risk tier demands it.",
    becomes: [
      "Each one is met (or listed as a gap) per asset, by its risk tier and type.",
      "Owners propose policies; stewards activate them; every change is audited.",
    ],
  },
];

export default function PolicyExplainer() {
  return (
    <Card>
      <SectionTitle title="How guardrails map into the registry" subtitle="Read-only: the registry reflects platform policies; it doesn't replace them" />
      <ol className="grid gap-3 md:grid-cols-2">
        {SOURCES.map((s, i) => (
          <li key={s.provider} className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/15 text-primary">{s.icon}</span>
              <span className="text-ui-base font-bold">{i + 1}. {s.title}</span>
            </div>
            <div className="mt-1 font-mono text-ui-xs text-muted-foreground">{s.provider === "registry" ? "checked by the registry" : `provider: ${s.provider}`}</div>
            <p className="mt-2 text-ui-sm text-muted-foreground">{s.reads}</p>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-ui-sm">
              {s.becomes.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    </Card>
  );
}
