import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AssetDetail } from "../lib/types";
import { jsonResponse, renderWithProviders } from "../test/utils";
import AssetPage, { visibleTabs } from "./AssetPage";

const TOOL_ID = "tool:mcp:system:system.ai.microsoft_365/search_mail";

function detail(overrides: Partial<AssetDetail> = {}, asset: Partial<AssetDetail["asset"]> = {}): AssetDetail {
  return {
    asset: {
      asset_id: "agent:endpoint:care-supervisor", asset_type: "agent", subtype: "agent_bricks_supervisor", display_name: "Care Ops Supervisor", name: "care-supervisor",
      source: "databricks", platform: "agent_bricks", publisher: "Databricks", lifecycle_status: "approved", runtime_status: "running", certification: "certified",
      sensitivity: "confidential", risk_tier: "high", domain: "care-ops", tags: ["care"], purpose: "Routes care questions.",
      owners: [{ email: "ana.ruiz@example.com", kind: "owner", source: "synced", display_name: "Ana Ruiz" }],
      kpi: { requests_30d: 2000, users_30d: 40, cost_30d_usd: 8, error_rate: 0.02, spark: [] }, policy_shield: "partial", coverage_pct: 33,
      subscribers: 2, tools_count: 3, my: { has_access: false, requested: false, subscribed: false, owner: false },
      parent_asset_id: null, parent_display_name: null, last_changed_at: null, deep_link: null, origin: "sync", eval_score: null,
      attributes: {}, external_ref: {}, also_registered_in: [], published_version: "3.2", latest_version: "3.3",
      first_seen_at: "2026-10-01T00:00:00Z", last_synced_at: "2026-10-26T09:00:00Z", source_created_at: null, created_by: null, completeness_pct: 40,
      ...asset,
    },
    fields: [
      { field_key: "purpose", label: "Purpose", kind: "text", value: "Routes care questions.", source_value: "Routes care questions.", source_label: "Agent Bricks", source_synced_at: "2026-10-26T09:00:00Z", override_value: null, provenance: "source", lock_mode: "keep", overridden_by: null, overridden_at: null, override_reason: null, drift: false, required: true },
    ],
    versions: [],
    parent: null,
    tabs: ["overview", "access", "lineage"],
    permissions: { can_edit: false, can_override: false, can_manage_access: false, can_publish: false, can_view_all_usage: false, can_view_traces: false, can_curate: false, can_pause: false },
    access_settings: { approval_required: true, approver_mode: "any", approvers: [], default_duration_days: 30, max_duration_days: 90, sla_hours: 24, terms_text: null, managed_externally_url: null, privileges: ["CAN_QUERY"], default_privilege: "CAN_QUERY", target_note: null, provisioning_mode: "record_only" },
    ...overrides,
  };
}

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

function mockDetail(d: AssetDetail | null, status = 200) {
  const paths: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    paths.push(path);
    if (path === `/api/assets/${encodeURIComponent(d?.asset.asset_id ?? "")}` || (!d && path.startsWith("/api/assets/")))
      return d ? jsonResponse({ data: d, source: "lakebase", degraded_reason: null, as_of: "2026-10-26T10:00:00Z" }) : jsonResponse({ detail: "asset not found" }, status);
    return jsonResponse({ detail: "Not Found" }, 404);
  });
  return paths;
}

function open(id: string, tab = "") {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/assets/:assetId/:tab?" element={<AssetPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { route: `/assets/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}` },
  );
}

describe("AssetPage tabs", () => {
  it("orders and filters tabs by detail.tabs", () => {
    expect(visibleTabs(["audit", "overview", "bogus", "tools"])).toEqual(["overview", "tools", "audit"]);
    expect(visibleTabs([])).toEqual(["overview"]);
  });

  it("shows only the tabs listed in detail.tabs, URL-driven", async () => {
    const user = userEvent.setup();
    mockDetail(detail());
    open("agent:endpoint:care-supervisor");
    const tablist = await screen.findByRole("tablist");
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Access", "Lineage"]);
    expect(within(tablist).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Usage & Cost" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Description" })).toBeInTheDocument();

    await user.click(within(tablist).getByRole("tab", { name: "Lineage" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/assets/agent%3Aendpoint%3Acare-supervisor/lineage"));
  });

  it("redirects an unknown or hidden tab to the first visible tab", async () => {
    mockDetail(detail());
    open("agent:endpoint:care-supervisor", "traces");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/assets/agent%3Aendpoint%3Acare-supervisor/overview"));
  });

  it("decodes URNs with ':' '.' '/' and labels the tools tab by type", async () => {
    const paths = mockDetail(
      detail({ tabs: ["overview", "tools", "usage", "audit"] }, { asset_id: TOOL_ID, asset_type: "tool", subtype: "mcp_tool", display_name: "search_mail", parent_asset_id: "mcp:system:system.ai.microsoft_365" }),
    );
    open(TOOL_ID, "overview");
    const tablist = await screen.findByRole("tablist");
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Schema", "Usage & Cost", "Audit"]);
    expect(paths[0]).toBe(`/api/assets/${encodeURIComponent(TOOL_ID)}`);
    expect(screen.getByRole("heading", { level: 1, name: "search_mail" })).toBeInTheDocument();
  });
});

describe("AssetPage header", () => {
  it("renders badges, both status axes, versions, the KPI ribbon and a Request access CTA for a viewer", async () => {
    mockDetail(detail());
    open("agent:endpoint:care-supervisor");
    expect(await screen.findByRole("heading", { level: 1, name: "Care Ops Supervisor" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Catalog");
    expect(screen.getByText("Supervisor Agent")).toBeInTheDocument();
    expect(screen.getByText("Certified")).toBeInTheDocument();
    expect(screen.getByText(/Sensitivity:/)).toBeInTheDocument();
    expect(screen.getByText(/Runtime:/)).toBeInTheDocument();
    expect(screen.getByText("v3.2 published")).toBeInTheDocument();
    expect(screen.getByText("v3.3 latest")).toBeInTheDocument();
    expect(screen.getByLabelText("Last 30 days")).toHaveTextContent("$ / 1k requests$4.00");
    expect(screen.getByRole("button", { name: "Request access" })).toBeInTheDocument();
    expect(screen.getByLabelText("Data source: Lakebase")).toBeInTheDocument();
  });

  it("warns when the asset has no active owner and gives owners the publish CTA", async () => {
    mockDetail(detail({}, { owners: [] }));
    const { unmount } = open("agent:endpoint:care-supervisor");
    expect(await screen.findByText("This asset has no active owner")).toBeInTheDocument();
    unmount();

    mockDetail(detail({ permissions: { can_edit: true, can_override: false, can_manage_access: true, can_publish: true, can_view_all_usage: true, can_view_traces: true, can_curate: false, can_pause: true } }, { my: { has_access: true, requested: false, subscribed: false, owner: true } }));
    open("agent:endpoint:care-supervisor");
    expect(await screen.findByRole("button", { name: "Publish new version" })).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown asset", async () => {
    mockDetail(null, 404);
    open("agent:endpoint:nope");
    expect(await screen.findByText("Asset not found")).toBeInTheDocument();
  });
});
