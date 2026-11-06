import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HomeData } from "../lib/types";
import { jsonResponse, renderWithProviders } from "../test/utils";
import Home from "./Home";

const HOME: HomeData = {
  kpis: { agents: 4, mcp_servers: 3, tools: 12, skills: 1, subscribers: 9, requests_30d: 23600, cost_30d_usd: 28.71, governed_pct: 53.6, ownerless: 2 },
  top_actions: [
    { kind: "pending_approvals", label: "Access requests awaiting you", count: 3, href: "/requests", severity: "info" },
    { kind: "ownerless", label: "Assets without an owner", count: 2, href: "/catalog?ownerless=true", severity: "warning" },
    { kind: "unacked_impacts", label: "Breaking changes to acknowledge", count: 1, href: "/changes?mine=true", severity: "critical" },
  ],
  my_subscriptions: [],
  recent_changes: [
    { change_id: 1, asset_id: "a", asset_display_name: "Alpha", asset_type: "agent", from_version: "1", to_version: "1.1", change_kinds: ["description"], breaking: false, title: "Clarify purpose", summary: null, status: "published", detected_by: "owner", published_by: "ana@example.com", published_at: "2026-10-25T10:00:00Z", effective_at: null, created_at: "2026-10-25T10:00:00Z", impacted_people: 2, acked: 1, my_ack: null },
    { change_id: 2, asset_id: "b", asset_display_name: "Beta MCP", asset_type: "mcp_server", from_version: "3.2", to_version: "4.0", change_kinds: ["tools_removed"], breaking: true, title: "Remove search_mail", summary: null, status: "published", detected_by: "owner", published_by: "lee@example.com", published_at: "2026-10-20T10:00:00Z", effective_at: "2026-11-10T00:00:00Z", created_at: "2026-10-20T10:00:00Z", impacted_people: 5, acked: 0, my_ack: "pending" },
  ],
  trending: [],
  sync: { last_run_at: null, status: null },
};

describe("Home", () => {
  it("shows top actions (critical first), the KPI row, subscriptions empty state and breaking changes first", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/api/home") ? jsonResponse({ data: HOME, source: "lakebase", degraded_reason: null, as_of: "2026-10-26T10:00:00Z" }) : jsonResponse({ detail: "Not Found" }, 404);
    });
    renderWithProviders(<Home />);
    const actions = await screen.findByRole("list", { name: "Top actions for you" });
    const links = within(actions).getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "/changes?mine=true");
    expect(links[0]).toHaveTextContent("Severity: Critical");
    expect(links[1]).toHaveAttribute("href", "/catalog?ownerless=true");
    expect(screen.getByRole("link", { name: "Ownerless: 2" })).toHaveAttribute("href", "/catalog?ownerless=true");
    expect(screen.getByRole("link", { name: "Cost · 30 d: $29" })).toBeInTheDocument();
    expect(screen.getByText("You're not subscribed to anything yet")).toBeInTheDocument();
    const changes = screen.getByRole("region", { name: "Recent changes" });
    const titles = within(changes).getAllByRole("link").map((l) => l.textContent ?? "");
    expect(titles[1]).toContain("Remove search_mail");
    expect(within(changes).getByText("Awaiting your acknowledgement")).toBeInTheDocument();
    expect(screen.getByLabelText("Data source: Lakebase")).toBeInTheDocument();
  });
});
