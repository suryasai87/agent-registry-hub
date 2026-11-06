import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, CatalogPage } from "../../lib/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";
import SubscribeDialog from "./SubscribeDialog";

const ASSET = { asset_id: "mcp:uc:demo.care_tools", display_name: "Care tools" };

const DOWNSTREAM = {
  asset_id: "agent:endpoint:claims-triage",
  asset_type: "agent",
  display_name: "Claims Triage Agent",
} as AssetCard;

function catalogMock() {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/catalog")) {
      const page: CatalogPage = { items: [DOWNSTREAM], total: 1, page: 1, page_size: 8, facets: {} as CatalogPage["facets"] };
      return jsonResponse({ data: page, source: "lakebase", degraded_reason: null, as_of: "2026-10-26T10:00:00Z" });
    }
    return jsonResponse({ detail: "Not Found" }, 404);
  });
}

describe("SubscribeDialog", () => {
  it("requires a valid email (prefilled from the session)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({});
    renderWithProviders(<SubscribeDialog open onClose={() => {}} asset={ASSET} defaultEmail="jo.park@example.com" onSubmit={onSubmit} />);
    const email = screen.getByLabelText("Your email (required)");
    expect(email).toHaveValue("jo.park@example.com");

    await user.clear(email);
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText("An email is required: change notifications go here.")).toBeInTheDocument();

    await user.type(email, "jo.park@");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Team or distribution-list emails (optional)"), "team@example.com, nope");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText("Not a valid email: nope")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires a downstream declaration for 'My agent / app uses it', accepting a not-registered name", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    renderWithProviders(<SubscribeDialog open onClose={onClose} asset={ASSET} defaultEmail="jo.park@example.com" onSubmit={onSubmit} />);
    await user.click(screen.getByRole("radio", { name: /My agent \/ app uses it/ }));
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText(/Pick the agent or app that uses this asset/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: /Not registered yet/ }));
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText("Name the agent or app that uses this asset.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Agent or app name"), "claims-bot (staging)");
    await user.selectOptions(screen.getByLabelText("Notify me about"), "all");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      subscriber_email: "jo.park@example.com",
      notify_emails: [],
      subscriber_kind: "user",
      relationship: "via_downstream",
      downstream_asset_id: null,
      downstream_name: "claims-bot (staging)",
      use_case: null,
      environment: "prod",
      notify_pref: "all",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("picks the downstream agent from catalog search results", async () => {
    const user = userEvent.setup();
    catalogMock();
    const onSubmit = vi.fn().mockResolvedValue({});
    renderWithProviders(<SubscribeDialog open onClose={() => {}} asset={ASSET} defaultEmail="jo.park@example.com" onSubmit={onSubmit} />);
    await user.click(screen.getByRole("radio", { name: /My agent \/ app uses it/ }));
    await user.type(screen.getByLabelText("Which agent or app?"), "claims");
    await user.click(await screen.findByRole("radio", { name: /Claims Triage Agent/ }));
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ relationship: "via_downstream", downstream_asset_id: "agent:endpoint:claims-triage", downstream_name: "Claims Triage Agent" });
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith("/api/catalog?q=claims"))).toBe(true);
  });

  it("keeps the dialog open and shows the server's reason when the subscribe is rejected", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("../../lib/api");
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, "Already subscribed with this email"));
    const onClose = vi.fn();
    renderWithProviders(<SubscribeDialog open onClose={onClose} asset={ASSET} defaultEmail="jo.park@example.com" onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already subscribed with this email");
    expect(onClose).not.toHaveBeenCalled();
  });
});
