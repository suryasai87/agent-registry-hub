import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccessRequest, AccessSettings } from "../../lib/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";
import RequestAccessDialog from "./RequestAccessDialog";

const ASSET = { asset_id: "agent:endpoint:care-supervisor", display_name: "Care Ops Supervisor", asset_type: "agent" as const };
const SETTINGS: AccessSettings = {
  approval_required: true,
  approver_mode: "any",
  approvers: ["ana.ruiz@example.com"],
  default_duration_days: 30,
  max_duration_days: 90,
  sla_hours: 48,
  terms_text: "Do not send PHI outside the approved workspace.",
  managed_externally_url: null,
  privileges: ["CAN_QUERY", "CAN_VIEW"],
  default_privilege: "CAN_QUERY",
  target_note: null,
  provisioning_mode: "record_only",
};

function capture() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      const req: Partial<AccessRequest> = { request_id: 7, status: "pending", privilege: body.privilege, approvers: ["ana.ruiz@example.com"], subscribe_email: body.subscribe_email };
      return jsonResponse(req);
    }
    return jsonResponse({ detail: "Not Found" }, 404);
  });
  return posts;
}

function open(onSubmitted = vi.fn()) {
  renderWithProviders(<RequestAccessDialog open onClose={() => {}} asset={ASSET} settings={SETTINGS} defaultEmail="jo.park@example.com" onSubmitted={onSubmitted} />);
  return onSubmitted;
}

describe("RequestAccessDialog", () => {
  it("shows approvers + SLA, defaults the privilege/duration, and subscribes by default with the session email", () => {
    capture();
    open();
    expect(screen.getByRole("dialog", { name: "Request access to Care Ops Supervisor" })).toBeInTheDocument();
    expect(screen.getByText("ana.ruiz@example.com")).toBeInTheDocument();
    expect(screen.getByText("SLA 48 hours")).toBeInTheDocument();
    expect(screen.getByLabelText("Access level")).toHaveValue("CAN_QUERY");
    expect(screen.getByLabelText("Duration (days)")).toHaveValue(30);
    expect(screen.getByRole("switch", { name: /Subscribe me to change notifications/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Notification email")).toHaveValue("jo.park@example.com");
  });

  it("validates justification length, duration ≤ max, terms and the subscribe email before posting", async () => {
    const user = userEvent.setup();
    const posts = capture();
    open();
    await user.type(screen.getByLabelText("Justification"), "need it");
    const duration = screen.getByLabelText("Duration (days)");
    await user.clear(duration);
    await user.type(duration, "120");
    const email = screen.getByLabelText("Notification email");
    await user.clear(email);
    await user.type(email, "not-an-email");
    await user.click(screen.getByRole("button", { name: "Submit request" }));

    expect(await screen.findByText(/at least 15 characters; 7 so far/)).toBeInTheDocument();
    expect(screen.getByText("The maximum for this asset is 90 days.")).toBeInTheDocument();
    expect(screen.getByText("Accept the terms to continue.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email for change notifications.")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it("posts the request with the subscribe email, then reports it", async () => {
    const user = userEvent.setup();
    const posts = capture();
    const onSubmitted = open();
    await user.type(screen.getByLabelText("Justification"), "Building the claims triage agent for Q4 intake.");
    await user.click(screen.getByRole("button", { name: "90 days" }));
    await user.selectOptions(screen.getByLabelText("Access level"), "CAN_VIEW");
    await user.click(screen.getByRole("checkbox", { name: "I accept these terms" }));
    const email = screen.getByLabelText("Notification email");
    await user.clear(email);
    await user.type(email, "claims-team@example.com");
    await user.click(screen.getByRole("button", { name: "Submit request" }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(posts[0].path).toBe("/api/assets/agent%3Aendpoint%3Acare-supervisor/access-requests");
    expect(posts[0].body).toEqual({
      privilege: "CAN_VIEW",
      justification: "Building the claims triage agent for Q4 intake.",
      duration_days: 90,
      terms_accepted: true,
      subscribe_email: "claims-team@example.com",
      principal_type: "user",
    });
  });

  it("sends subscribe_email null when the subscription toggle is off, and needs a principal for a group", async () => {
    const user = userEvent.setup();
    const posts = capture();
    open();
    await user.click(screen.getByRole("switch", { name: /Subscribe me to change notifications/ }));
    expect(screen.queryByLabelText("Notification email")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "A group" }));
    await user.type(screen.getByLabelText("Justification"), "Team-wide evaluation in the dev workspace.");
    await user.click(screen.getByRole("checkbox", { name: "I accept these terms" }));
    await user.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByText("Enter the group name.")).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    await user.type(screen.getByLabelText("Group name"), "claims-analysts");
    await user.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toMatchObject({ principal_type: "group", principal: "claims-analysts", subscribe_email: null, duration_days: 30 });
  });
});
