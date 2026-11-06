import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { deltaTone } from "../components/charts/bars";
import { envelope, recordFetch } from "../components/workspace/fetchRecorder.test-utils";
import type { ChangeDetail, ImpactItem } from "../lib/types";
import { renderWithProviders } from "../test/utils";
import ChangeDetailPage, { ackSegments, metricRows } from "./ChangeDetail";

const item = (impact_type: ImpactItem["impact_type"], key: string, extra: Partial<ImpactItem> = {}): ImpactItem => ({
  impacted_key: key, impact_type, via_asset_id: null, hops: 0, email: impact_type === "downstream_asset" ? null : key, ack_status: "pending",
  ack_note: null, migrate_by: null, acked_at: null, notified_at: "2026-10-26T10:00:00Z", label: key, ...extra,
});

const DETAIL: ChangeDetail = {
  change: {
    change_id: 7, asset_id: "agent:endpoint:demo-policy-ka", asset_display_name: "Policy Docs Assistant", asset_type: "agent", from_version: "v1", to_version: "v2",
    change_kinds: ["tools_removed"], breaking: true, title: "Drop legacy index", summary: "The v1 index is removed.", status: "published", detected_by: "owner",
    published_by: "ana.ruiz@example.com", published_at: "2026-10-26T10:00:00Z", effective_at: "2026-11-10T10:00:00Z", created_at: "2026-10-26T10:00:00Z",
    impacted_people: 4, acked: 2, my_ack: null,
    diff: [{ field: "tools", before: ["search_v1", "search_v2"], after: ["search_v2"] }], release_notes: "Use the v2 index.", sunset_at: "2026-12-01T00:00:00Z",
  },
  impact: [
    item("downstream_asset", "agent:endpoint:demo-care-supervisor", { label: "Care Ops Supervisor", hops: 1, via_asset_id: "agent:endpoint:demo-policy-ka", ack_status: "not_required", notified_at: null }),
    item("subscriber", "kim@example.com", { ack_status: "not_impacted", acked_at: "2026-10-26T11:00:00Z" }),
    item("subscriber", "lee@example.com", { ack_status: "impacted_will_migrate", migrate_by: "2026-11-05", ack_note: "moving to v2" }),
    item("downstream_owner", "ana.ruiz@example.com", { via_asset_id: "agent:endpoint:demo-care-supervisor", hops: 1 }),
    item("observed_consumer", "sam.ito@example.com"),
  ],
  ack_summary: { not_impacted: 1, impacted_will_migrate: 1, need_help: 0, pending: 2, not_required: 0 },
  metrics_before: { window_days: 7, requests: 271, error_rate: 0.02, cost_usd: 0.96, p95_ms: 2400, eval: { correctness: 0.8 } },
  metrics_after: { window_days: 7, requests: 300, error_rate: 0.05, cost_usd: 0.9, p95_ms: 1800, eval: { correctness: 0.9 } },
};

function render() {
  recordFetch({ "/api/changes/7": envelope(DETAIL) });
  renderWithProviders(
    <Routes>
      <Route path="/changes/:changeId" element={<ChangeDetailPage />} />
    </Routes>,
    { route: "/changes/7" },
  );
}

describe("Impact report", () => {
  it("groups impacted people into subscribers, downstream owners and observed consumers", async () => {
    render();
    expect(await screen.findByRole("heading", { level: 1, name: "Drop legacy index" })).toBeInTheDocument();
    const subs = screen.getByLabelText("Subscribers");
    expect(within(subs).getByText("kim@example.com")).toBeInTheDocument();
    expect(within(subs).getByText("Impacted, will migrate")).toBeInTheDocument();
    expect(within(subs).getByText("“moving to v2”")).toBeInTheDocument();
    const owners = screen.getByLabelText("Downstream owners");
    expect(within(owners).getByText("ana.ruiz@example.com")).toBeInTheDocument();
    expect(within(owners).getByRole("link", { name: "Care Ops Supervisor" })).toHaveAttribute("href", "/assets/agent%3Aendpoint%3Ademo-care-supervisor");
    expect(within(screen.getByLabelText("Observed unregistered consumers")).getByText("sam.ito@example.com")).toBeInTheDocument();
    // downstream assets with hops, and the lineage deep link with the change
    expect(screen.getByText("1 hop")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View impact on lineage/ })).toHaveAttribute("href", "/lineage?focus=agent%3Aendpoint%3Ademo-policy-ka&change_id=7&depth=3&dir=down");
    expect(screen.getByText("tools")).toBeInTheDocument();
  });

  it("shows the acknowledgement summary as a stacked bar with counts", async () => {
    render();
    const bar = await screen.findByRole("img", { name: /^Acknowledgement status:/ });
    expect(bar).toHaveAccessibleName("Acknowledgement status: 1 not impacted, 1 impacted, will migrate, 2 awaiting acknowledgement");
    expect(screen.getByText((_, el) => el?.tagName === "DIV" && el.textContent === "2 of 4 acknowledged")).toBeInTheDocument();
    expect(ackSegments(DETAIL.ack_summary).map((s) => s.key)).toEqual(["not_impacted", "impacted_will_migrate", "need_help", "pending"]);
  });

  it("colours metric deltas by whether they moved the good way", async () => {
    render();
    await screen.findByText("Before vs after");
    const row = (name: string) => screen.getByRole("rowheader", { name }).closest("tr")!;
    expect(row("Error rate").querySelector("[data-tone]")).toHaveAttribute("data-tone", "bad");
    expect(within(row("Error rate")).getByText("worse")).toBeInTheDocument();
    expect(row("p95 latency").querySelector("[data-tone]")).toHaveAttribute("data-tone", "good");
    expect(row("Eval · Correctness").querySelector("[data-tone]")).toHaveAttribute("data-tone", "good");
    expect(row("Requests").querySelector("[data-tone]")).toHaveAttribute("data-tone", "flat");
    expect(metricRows(DETAIL.metrics_before, null).every((m) => m.after === null)).toBe(true);
    expect(deltaTone(100, 100.2, "lower")).toBe("flat");
    expect(deltaTone(null, 3, "higher")).toBe("unknown");
  });
});
