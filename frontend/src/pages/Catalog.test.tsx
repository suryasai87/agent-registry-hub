import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, CatalogPage } from "../lib/types";
import { jsonResponse, renderWithProviders } from "../test/utils";
import Catalog, { DENSITY_KEY, VIEW_KEY, catalogApiPath } from "./Catalog";

function card(id: string, name: string, type: AssetCard["asset_type"] = "agent", source: AssetCard["source"] = "databricks"): AssetCard {
  return {
    asset_id: id, asset_type: type, subtype: "custom_agent", display_name: name, name, source, platform: "model_serving", publisher: null,
    lifecycle_status: "approved", runtime_status: "running", certification: "certified", sensitivity: "internal", risk_tier: "medium", domain: null, tags: [],
    purpose: `${name} purpose`, owners: [{ email: "lee@example.com", kind: "owner", source: "synced", display_name: "Lee" }],
    kpi: { requests_30d: 10, users_30d: 1, cost_30d_usd: 1, error_rate: 0, spark: [] }, policy_shield: "full", coverage_pct: 100, subscribers: 0, tools_count: 0,
    my: { has_access: false, requested: false, subscribed: false, owner: false }, parent_asset_id: null, parent_display_name: null, last_changed_at: null, deep_link: null, origin: "sync", published_version: null, latest_version: null, eval_score: null,
  };
}

const FACETS: CatalogPage["facets"] = {
  asset_type: { agent: 2, mcp_server: 1 },
  source: { databricks: 2, external: 1 },
  platform: { model_serving: 2, unity_catalog: 1 },
  lifecycle_status: { approved: 3 },
  certification: { certified: 2, unreviewed: 1 },
  sensitivity: { internal: 3 },
  risk_tier: { medium: 2, high: 1 },
};

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{l.search}</output>;
}

function mockCatalog(itemsFor: (params: URLSearchParams) => AssetCard[] = () => [card("agent:endpoint:a", "Alpha Agent"), card("agent:endpoint:b", "Beta Agent"), card("mcp:connection:gh", "GitHub MCP", "mcp_server", "external")]) {
  const paths: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/api/catalog")) {
      paths.push(path);
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      const items = itemsFor(params);
      return jsonResponse({ data: { items, total: items.length, page: 1, page_size: 24, facets: FACETS }, source: "lakebase", degraded_reason: null, as_of: "2026-10-26T10:00:00Z" });
    }
    return jsonResponse({ detail: "Not Found" }, 404);
  });
  return paths;
}

const view = (route = "/catalog") =>
  renderWithProviders(
    <>
      <Catalog />
      <LocationProbe />
    </>,
    { route },
  );
const location = () => screen.getByTestId("location").textContent ?? "";

describe("Catalog", () => {
  it("maps URL params to the API query (page size fixed)", () => {
    expect(catalogApiPath(new URLSearchParams("type=agent&status=approved,deprecated&rel=subscribed&bogus=1"))).toBe("/api/catalog?type=agent&status=approved%2Cdeprecated&rel=subscribed&page_size=24");
  });

  it("renders facet counts from the server, type-tab counts and the source pill", async () => {
    mockCatalog();
    view();
    expect(await screen.findByText("Alpha Agent")).toBeInTheDocument();
    const rail = screen.getByRole("complementary", { name: "Filters" });
    const source = within(rail).getByRole("group", { name: "Source" });
    expect(within(source).getByRole("checkbox", { name: /Databricks-provided/ })).toBeInTheDocument();
    expect(within(source).getByLabelText("2 assets")).toBeInTheDocument();
    expect(within(rail).getByRole("group", { name: "Risk" })).toHaveTextContent("High risk".replace(" risk", ""));
    expect(within(screen.getByRole("tablist")).getByRole("tab", { name: /MCP servers\s*1/ })).toBeInTheDocument();
    expect(within(screen.getByRole("tablist")).getByRole("tab", { name: /All\s*3/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Data source: Lakebase")).toBeInTheDocument();
  });

  it("syncs facets, type tabs, quick chips, sort and the debounced search to the URL and the API", async () => {
    const user = userEvent.setup();
    const paths = mockCatalog();
    view();
    await screen.findByText("Alpha Agent");

    await user.click(screen.getByRole("checkbox", { name: /External/ }));
    await waitFor(() => expect(location()).toBe("?source=external"));
    await waitFor(() => expect(paths.at(-1)).toContain("source=external"));

    await user.click(screen.getByRole("tab", { name: /Agents/ }));
    await waitFor(() => expect(location()).toContain("type=agent"));

    await user.click(screen.getByRole("button", { name: "Mine" }));
    await waitFor(() => expect(location()).toContain("owner=me"));
    expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Subscribed" }));
    await user.click(screen.getByRole("button", { name: "Recently changed" }));
    await waitFor(() => expect(location()).toContain("changed_days=7"));
    expect(location()).toContain("rel=subscribed");

    await user.selectOptions(screen.getByLabelText("Sort"), "cost");
    await waitFor(() => expect(location()).toContain("sort=cost"));

    await user.type(screen.getByLabelText("Search the catalog"), "genie");
    await waitFor(() => expect(location()).toContain("q=genie"), { timeout: 2000 });
    await waitFor(() => expect(paths.at(-1)).toMatch(/q=genie.*page_size=24|page_size=24/));
    expect(paths.at(-1)).toContain("q=genie");
    expect(paths.at(-1)).toContain("owner=me");

    await user.click(screen.getByRole("button", { name: "Mine" }));
    await waitFor(() => expect(location()).not.toContain("owner=me"));
  });

  it("restores filters from the URL and clears them from the empty state", async () => {
    const user = userEvent.setup();
    mockCatalog((p) => (p.get("risk") === "high" ? [] : [card("agent:endpoint:a", "Alpha Agent")]));
    view("/catalog?risk=high&ownerless=true");
    expect(await screen.findByText("No assets match these filters")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /High/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Ownerless" })).toHaveAttribute("aria-pressed", "true");
    const empty = screen.getByText("No assets match these filters").closest("div")!.parentElement!;
    await user.click(within(empty).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(location()).toBe(""));
    expect(await screen.findByText("Alpha Agent")).toBeInTheDocument();
  });

  it("persists the list view and compact density", async () => {
    const user = userEvent.setup();
    mockCatalog();
    view();
    await screen.findByText("Alpha Agent");
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("table", { name: "Catalog results" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Policy coverage" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compact" }));
    expect(localStorage.getItem(VIEW_KEY)).toBe("list");
    expect(localStorage.getItem(DENSITY_KEY)).toBe("compact");
  });
});
