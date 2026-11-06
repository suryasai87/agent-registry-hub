import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ChangeSummary, Subscription } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { ackBody } from "./AckControl";
import { envelope, recordFetch } from "./fetchRecorder.test-utils";
import { expiryState, groupImpacts, ImpactsPanel, ownedChecklist, parseEmails, SubscriptionsPanel, type MyImpact } from "./WorkspacePanels";

const CHANGE: ChangeSummary = {
  change_id: 5, asset_id: "agent:endpoint:demo-policy-ka", asset_display_name: "Policy Docs Assistant", asset_type: "agent", from_version: "v1", to_version: "v2",
  change_kinds: ["tools_removed"], breaking: true, title: "Drop legacy index", summary: null, status: "published", detected_by: "owner",
  published_by: "ana.ruiz@example.com", published_at: "2026-10-26T10:00:00Z", effective_at: "2026-11-10T10:00:00Z", created_at: "2026-10-26T10:00:00Z",
  impacted_people: 3, acked: 0, my_ack: "pending",
};
const IMPACT: MyImpact = {
  impacted_key: "me@example.com", impact_type: "subscriber", via_asset_id: "agent:endpoint:demo-care-supervisor", hops: 2, email: "me@example.com",
  ack_status: "pending", ack_note: null, migrate_by: null, acked_at: null, notified_at: "2026-10-26T10:00:00Z", label: "me@example.com", change: CHANGE,
};

function renderImpacts() {
  const rec = recordFetch({
    "/api/me/impacts": envelope([IMPACT]),
    "POST /api/changes/5/ack": (c: { body: { status: string; migrate_by?: string; note?: string } }) => [{ ...IMPACT, change: undefined, ack_status: c.body.status, migrate_by: c.body.migrate_by ?? null, ack_note: c.body.note ?? null, acked_at: "2026-10-26T11:00:00Z" }],
  });
  renderWithProviders(<ImpactsPanel />, { route: "/me#impacts" });
  return rec;
}

describe("My workspace · impacts", () => {
  it("acknowledges “not impacted” with just the status", async () => {
    const user = userEvent.setup();
    const rec = renderImpacts();
    await user.click(await screen.findByRole("button", { name: "Not impacted" }));
    await waitFor(() => expect(rec.last("POST", "/api/changes/5/ack")?.body).toEqual({ status: "not_impacted" }));
    expect(await screen.findByText("Not impacted", { selector: "span" })).toBeInTheDocument();
  });

  it("“impacted, will migrate” needs a date and sends migrate_by", async () => {
    const user = userEvent.setup();
    const rec = renderImpacts();
    await user.click(await screen.findByRole("button", { name: "Impacted, will migrate…" }));
    const date = screen.getByLabelText("I'll have migrated by");
    expect(date).toHaveValue("2026-11-10"); // defaults to the effective date
    await user.clear(date);
    await user.type(date, "2026-11-03");
    await user.type(screen.getByLabelText("Note (optional)"), "switching to v2");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rec.last("POST", "/api/changes/5/ack")?.body).toEqual({ status: "impacted_will_migrate", migrate_by: "2026-11-03", note: "switching to v2" }));
    expect(await screen.findByText(/Impacted, will migrate/, { selector: "span" })).toHaveTextContent("Nov 3, 2026");
  });

  it("“I need help” requires a note for the owner", async () => {
    const user = userEvent.setup();
    const rec = renderImpacts();
    await user.click(await screen.findByRole("button", { name: "I need help…" }));
    const send = screen.getByRole("button", { name: "Ask the owner" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("What do you need?"), "Which tool replaces search_v1?");
    await user.click(send);
    await waitFor(() => expect(rec.last("POST", "/api/changes/5/ack")?.body).toEqual({ status: "need_help", note: "Which tool replaces search_v1?" }));
  });

  it("shows how the change reaches me", async () => {
    renderImpacts();
    const card = (await screen.findByRole("link", { name: "Drop legacy index" })).closest("li")!;
    expect(within(card).getByText("Subscriber")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "demo-care-supervisor" })).toHaveAttribute("href", "/assets/agent%3Aendpoint%3Ademo-care-supervisor");
    expect(within(card).getByRole("link", { name: "See impact on lineage" })).toHaveAttribute("href", "/lineage?focus=agent%3Aendpoint%3Ademo-policy-ka&change_id=5");
  });

  it("builds ack bodies and groups impact rows per change", () => {
    expect(ackBody("not_impacted", { note: "ignored", migrateBy: "2026-11-01" })).toEqual({ status: "not_impacted" });
    expect(ackBody("impacted_will_migrate", { migrateBy: "2026-11-01", note: " " })).toEqual({ status: "impacted_will_migrate", migrate_by: "2026-11-01" });
    const groups = groupImpacts([IMPACT, { ...IMPACT, impact_type: "downstream_owner" }, { ...IMPACT, change: { ...CHANGE, change_id: 6 }, ack_status: "not_impacted" }]);
    expect(groups.map((g) => [g.change.change_id, g.items.length, g.status])).toEqual([[5, 2, "pending"], [6, 1, "not_impacted"]]);
  });
});

describe("My workspace · subscriptions and access", () => {
  const SUB: Subscription = {
    subscription_id: 3, asset_id: "agent:endpoint:demo-care-supervisor", asset_display_name: "Care Ops Supervisor", asset_type: "agent", subscriber_email: "me@example.com",
    notify_emails: [], subscriber_kind: "user", relationship: "direct_use", downstream_asset_id: null, downstream_name: null, use_case: null, environment: "prod",
    notify_pref: "breaking_only", status: "active", created_by: "me@example.com", created_at: "2026-10-01T10:00:00Z", last_ack_at: null, has_access: false,
  };

  it("edits the notify preference and team emails inline and flags lost access", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/me/subscriptions": envelope([SUB]),
      "PATCH /api/subscriptions/3": (c: { body: Partial<Subscription> }) => ({ ...SUB, ...c.body }),
    });
    renderWithProviders(<SubscriptionsPanel />);
    expect(await screen.findByText("No current access")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Notify me about (Care Ops Supervisor)"), "all");
    await waitFor(() => expect(rec.last("PATCH", "/api/subscriptions/3")?.body).toEqual({ notify_pref: "all" }));
    await user.click(screen.getByRole("button", { name: "Edit team emails for Care Ops Supervisor" }));
    await user.type(screen.getByLabelText("Team emails (comma separated)"), "team@example.com, not-an-email");
    expect(screen.getByText("Not an email: not-an-email")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Team emails (comma separated)"));
    await user.type(screen.getByLabelText("Team emails (comma separated)"), "Team@example.com; oncall@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rec.last("PATCH", "/api/subscriptions/3")?.body).toEqual({ notify_emails: ["team@example.com", "oncall@example.com"] }));
    expect(parseEmails("a@b.co a@b.co, x")).toEqual({ emails: ["a@b.co"], invalid: ["x"] });
  });

  it("highlights grants that expire soon", () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    expect(expiryState(null, now)).toEqual({ tone: "none", label: "No expiry" });
    expect(expiryState("2026-10-28T00:00:00Z", now)).toEqual({ tone: "urgent", label: "Expires in 2 d" });
    expect(expiryState("2026-11-05T00:00:00Z", now).tone).toBe("soon");
    expect(expiryState("2027-01-05T00:00:00Z", now).tone).toBe("ok");
    expect(expiryState("2026-10-20T00:00:00Z", now).tone).toBe("expired");
  });

  it("derives owner open actions from the asset card", () => {
    const card = { asset_id: "agent:x", purpose: "", owners: [{ email: "me@example.com", kind: "owner" as const, source: "synced" as const, display_name: "Me" }], policy_shield: "none" as const, coverage_pct: 20, certification: "unreviewed" as const, lifecycle_status: "approved" as const };
    const c = ownedChecklist(card as Parameters<typeof ownedChecklist>[0], 2);
    expect(c.actions.map((a) => a.key)).toEqual(["requests", "purpose", "co_owner", "policies", "certify"]);
    expect(c).toMatchObject({ done: 1, total: 5 });
  });
});
