import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard as Card } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import AssetCard from "./AssetCard";

function card(overrides: Partial<Card> = {}): Card {
  return {
    asset_id: "agent:endpoint:care-supervisor",
    asset_type: "agent",
    subtype: "agent_bricks_supervisor",
    display_name: "Care Ops Supervisor",
    name: "care-supervisor",
    source: "databricks",
    platform: "agent_bricks",
    publisher: "Databricks",
    lifecycle_status: "approved",
    runtime_status: "running",
    certification: "certified",
    sensitivity: "confidential",
    risk_tier: "high",
    domain: "care-ops",
    tags: ["care"],
    purpose: "Routes care-operations questions to Genie and UC tools.",
    owners: [{ email: "ana.ruiz@example.com", kind: "owner", source: "synced", display_name: "Ana Ruiz" }],
    kpi: { requests_30d: 1364, users_30d: 12, cost_30d_usd: 4.87, error_rate: 0.01, spark: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
    policy_shield: "partial",
    coverage_pct: 33,
    subscribers: 3,
    tools_count: 4,
    my: { has_access: false, requested: false, subscribed: false, owner: false },
    parent_asset_id: null,
    parent_display_name: null,
    last_changed_at: null,
    deep_link: null,
    origin: "sync",
    published_version: "v3",
    latest_version: "v3",
    eval_score: null,
    ...overrides,
  };
}

describe("AssetCard anatomy", () => {
  it("shows type + source, name link + mono URN, trust badge, status, purpose, KPI micro-row and owners", () => {
    renderWithProviders(<AssetCard card={card()} />);
    const article = screen.getByRole("article", { name: "Care Ops Supervisor" });
    const c = within(article);
    expect(c.getByText("Agent")).toBeInTheDocument();
    expect(c.getByText("Databricks · Agent Bricks")).toBeInTheDocument();
    expect(c.getByRole("link", { name: "Care Ops Supervisor" })).toHaveAttribute("href", "/assets/agent%3Aendpoint%3Acare-supervisor");
    expect(c.getByText("agent:endpoint:care-supervisor")).toHaveClass("font-mono");
    expect(c.getByText("Certified")).toBeInTheDocument();
    expect(c.getByText("Live")).toBeInTheDocument();
    expect(c.getByText(/Routes care-operations questions/)).toBeInTheDocument();
    expect(c.getByRole("img", { name: /14-day requests: 105 total, 14 on the last day/ })).toBeInTheDocument();
    expect(c.getByText("1.4k")).toBeInTheDocument();
    expect(c.getByText("$4.87")).toBeInTheDocument();
    expect(c.getByRole("img", { name: /Policy coverage: Partially governed · 33% coverage/ })).toBeInTheDocument();
    expect(c.getByRole("img", { name: "Owners: Ana Ruiz (Owner)" })).toBeInTheDocument();
    expect(c.queryByText("Ownerless")).not.toBeInTheDocument();
  });

  it("shows an amber Ownerless chip when nobody is an owner or co-owner", () => {
    renderWithProviders(<AssetCard card={card({ owners: [{ email: "vp@example.com", kind: "sponsor", source: "assigned", display_name: "VP" }] })} />);
    expect(screen.getByText("Ownerless").closest("span")).toHaveClass("text-warning");
  });

  it("shows the paused runtime instead of the lifecycle label (with text, not colour alone)", () => {
    renderWithProviders(<AssetCard card={card({ runtime_status: "paused" })} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("renders the my-relationship pills", () => {
    const { unmount } = renderWithProviders(<AssetCard card={card({ my: { has_access: true, requested: false, subscribed: true, owner: false } })} />);
    const pills = screen.getByLabelText("Your relationship: Has access, Subscribed");
    expect(within(pills).getByText("Has access")).toBeInTheDocument();
    expect(within(pills).getByText("Subscribed")).toBeInTheDocument();
    unmount();

    renderWithProviders(<AssetCard card={card({ my: { has_access: false, requested: true, subscribed: false, owner: false } })} />);
    expect(screen.getByLabelText("Your relationship: Requested")).toBeInTheDocument();
  });

  it("offers Subscribe / Request access quick actions only when they apply", async () => {
    const user = userEvent.setup();
    const onSubscribe = vi.fn();
    const onRequestAccess = vi.fn();
    const { unmount } = renderWithProviders(<AssetCard card={card()} onSubscribe={onSubscribe} onRequestAccess={onRequestAccess} />);
    await user.click(screen.getByRole("button", { name: "Subscribe to Care Ops Supervisor" }));
    await user.click(screen.getByRole("button", { name: "Request access to Care Ops Supervisor" }));
    expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({ asset_id: "agent:endpoint:care-supervisor" }));
    expect(onRequestAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Open Care Ops Supervisor" })).toBeInTheDocument();
    unmount();

    renderWithProviders(<AssetCard card={card({ my: { has_access: true, requested: false, subscribed: true, owner: false } })} onSubscribe={onSubscribe} onRequestAccess={onRequestAccess} />);
    expect(screen.queryByRole("button", { name: /Subscribe to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request access to/ })).not.toBeInTheDocument();
  });
});
