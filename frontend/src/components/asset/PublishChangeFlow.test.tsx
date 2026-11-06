import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, ImpactPreview } from "../../lib/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";
import { endOfLocalDayIso, isoDateFromToday } from "./format";
import PublishChangeFlow from "./PublishChangeFlow";

const ASSET = {
  asset_id: "mcp:system:system.ai.microsoft_365",
  asset_type: "mcp_server",
  display_name: "Microsoft 365",
  published_version: "3.2.0",
  latest_version: "3.2.0",
} as AssetCard & { published_version: string; latest_version: string };

const PREVIEW: ImpactPreview = {
  subscribers: [{ impacted_key: "jo@example.com", impact_type: "subscriber", via_asset_id: null, hops: 1, email: "jo@example.com", ack_status: "pending", ack_note: null, migrate_by: null, acked_at: null, notified_at: null, label: "jo@example.com" }],
  downstream: [{ impacted_key: "agent:endpoint:care", impact_type: "downstream_asset", via_asset_id: null, hops: 1, email: "ana@example.com", ack_status: "pending", ack_note: null, migrate_by: null, acked_at: null, notified_at: null, label: "Care Ops Supervisor" }],
  observed: [],
  total_people: 2,
  email_preview: { subject: "[Breaking] Microsoft 365 v4.0.0 - effective soon", body: "search_mail is removed." },
  checks: [
    { name: "Release notes present", passed: true, detail: "Required for breaking changes" },
    { name: "Required policies for the risk tier", passed: false, detail: "Missing: input guardrail" },
  ],
};

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}</output>;
}

function setup() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    posts.push({ path, body });
    if (path.endsWith("/changes/preview")) return jsonResponse(PREVIEW);
    if (path.endsWith("/changes")) return jsonResponse({ change: { change_id: 42 }, impact: PREVIEW.subscribers, ack_summary: {}, metrics_before: null, metrics_after: null });
    return jsonResponse({ detail: "Not Found" }, 404);
  });
  renderWithProviders(
    <Routes>
      <Route path="/assets/x/changes" element={<PublishChangeFlow asset={ASSET} onCancel={() => {}} />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    { route: "/assets/x/changes" },
  );
  return posts;
}

describe("PublishChangeFlow", () => {
  it("previews impact, shows checks, and publishes the same body, then opens the impact report", async () => {
    const user = userEvent.setup();
    const posts = setup();

    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText("Pick at least one kind of change.")).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    await user.click(screen.getByRole("checkbox", { name: "Tools removed" }));
    // a breaking kind turns Breaking on: major version + 14-day notice + release notes required
    expect(screen.getByRole("switch", { name: /Breaking change/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("New version")).toHaveValue("4.0.0");
    expect(screen.getByLabelText("Effective date")).toHaveValue(isoDateFromToday(14));
    await user.type(screen.getByLabelText("Title"), "Remove search_mail");
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText(/Release notes are required for a breaking change/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Release notes (required for breaking changes)"), "Use search_messages instead.");
    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByText("people will be notified")).toBeInTheDocument();
    expect(screen.getByText("Care Ops Supervisor")).toBeInTheDocument();
    expect(screen.getByText("[Breaking] Microsoft 365 v4.0.0 - effective soon")).toBeInTheDocument();
    const checks = screen.getByRole("region", { name: "Pre-publish checks" });
    expect(within(checks).getAllByText("Pass")).toHaveLength(1);
    expect(within(checks).getAllByText("Fail")).toHaveLength(1);

    const publish = screen.getByRole("button", { name: "Publish v4.0.0" });
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Publish anyway: I accept 1 failing check/ }));
    expect(publish).toBeEnabled();
    await user.click(publish);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/changes/42"));
    const preview = posts.find((p) => p.path.endsWith("/changes/preview"))!;
    const published = posts.find((p) => p.path.endsWith("/changes"))!;
    expect(preview.path).toBe("/api/assets/mcp%3Asystem%3Asystem.ai.microsoft_365/changes/preview");
    expect(published.body).toEqual(preview.body);
    expect(published.body).toEqual({
      to_version: "4.0.0",
      change_kinds: ["tools_removed"],
      breaking: true,
      title: "Remove search_mail",
      summary: null,
      release_notes: "Use search_messages instead.",
      effective_at: endOfLocalDayIso(isoDateFromToday(14)),
    });
  });

  it("marks the preview stale when the draft changes, so publish needs a fresh preview", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("checkbox", { name: "Description" }));
    await user.type(screen.getByLabelText("Title"), "Clarify purpose");
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText("people will be notified")).toBeInTheDocument();
    expect(screen.getByLabelText("New version")).toHaveValue("3.3.0");
    await user.type(screen.getByLabelText("Title"), " and owners");
    expect(screen.getByText(/The draft changed since this preview/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Publish v/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeInTheDocument();
  });
});
