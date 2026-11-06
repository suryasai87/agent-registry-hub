import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { approveBody, sideEffect } from "../components/workspace/RequestCard";
import { envelope, recordFetch } from "../components/workspace/fetchRecorder.test-utils";
import type { AccessRequest } from "../lib/types";
import { renderWithProviders } from "../test/utils";
import RequestsPage, { filterRequests } from "./Requests";

const REQ: AccessRequest = {
  request_id: 11, asset_id: "mcp:system:system.ai.microsoft_365", asset_display_name: "Microsoft 365", asset_type: "mcp_server",
  requester_email: "jo.park@example.com", principal: "jo.park@example.com", principal_type: "user", privilege: "EXECUTE",
  tool_subset: ["search_mail", "send_mail", "delete_message"], justification: "Building the care-ops intake agent.", duration_days: 90,
  terms_accepted: true, subscribe_email: "jo.park@example.com", status: "pending", approvers: ["platform.admins@example.com"],
  decided_by: null, decided_at: null, decision_reason: null, provision_mode: null, provision_detail: null, grant_expires_at: null,
  sla_due_at: "2026-10-27T10:00:00Z", request_expires_at: "2026-11-02T10:00:00Z", created_at: "2026-10-26T09:00:00Z", sla_state: "due_soon", can_decide: true,
};

function setup(decision: (body: unknown) => Partial<AccessRequest>) {
  const rec = recordFetch({
    "/api/requests?scope=review": envelope([REQ]),
    [`POST /api/requests/${REQ.request_id}/decision`]: (c: { body: unknown }) => ({ ...REQ, ...decision(c.body) }),
  });
  renderWithProviders(<RequestsPage />, { route: "/requests" });
  return rec;
}

describe("Requests", () => {
  it("flags write and destructive tools and shows the SLA chip", async () => {
    setup(() => ({}));
    const card = await screen.findByRole("article", { name: /EXECUTE on Microsoft 365/ });
    expect(within(card).getByText("delete_message · destructive")).toBeInTheDocument();
    expect(within(card).getByText("send_mail · write")).toBeInTheDocument();
    expect(within(card).getByText("search_mail")).toBeInTheDocument();
    expect(within(card).getByText("Due soon")).toBeInTheDocument();
    expect(sideEffect("system.ai.microsoft_365/delete_message")).toBe("destructive");
    expect(sideEffect("list_events")).toBe("read");
  });

  it("approve opens the Provision choice and sends exactly what the approver chose", async () => {
    const user = userEvent.setup();
    const rec = setup((b) => ({ status: "provision_failed", provision_mode: (b as { provision_mode: string }).provision_mode, provision_detail: { applied: false, mode: "add_to_group", error: "group 'care-ops' not found", statement: "add jo.park@example.com to group care-ops" } }));
    const card = await screen.findByRole("article", { name: /EXECUTE on Microsoft 365/ });
    await user.click(within(card).getByRole("button", { name: "Approve…" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve and provision" });
    expect(within(dialog).getByRole("radio", { name: /Grant directly/ })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: /Add to a group/ }));
    const approve = within(dialog).getByRole("button", { name: "Approve & provision" });
    expect(approve).toBeDisabled(); // a group name is required
    await user.type(within(dialog).getByLabelText("Group name"), "care-ops");
    const days = within(dialog).getByLabelText("Grant duration (days)");
    await user.clear(days);
    await user.type(days, "30");
    await user.click(approve);

    await waitFor(() => expect(rec.last("POST", "/api/requests/11/decision")).toBeDefined());
    expect(rec.last("POST", "/api/requests/11/decision")!.body).toEqual({ decision: "approve", provision_mode: "add_to_group", group: "care-ops", duration_days: 30 });
    // the server's answer, not an optimistic "provisioned": the failure, its error and the statement
    const updated = await screen.findByRole("article", { name: /EXECUTE on Microsoft 365/ });
    expect(within(updated).getAllByText("Provisioning failed").length).toBeGreaterThan(0);
    expect(within(updated).getByText("group 'care-ops' not found")).toBeInTheDocument();
    expect(within(updated).getByText("add jo.park@example.com to group care-ops")).toBeInTheDocument();
    expect(within(updated).getByRole("button", { name: "Retry provisioning" })).toBeInTheDocument();
  });

  it("deny needs a reason", async () => {
    const user = userEvent.setup();
    const rec = setup((b) => ({ status: "denied", decision_reason: (b as { reason: string }).reason, can_decide: false }));
    const card = await screen.findByRole("article", { name: /EXECUTE on Microsoft 365/ });
    await user.click(within(card).getByRole("button", { name: "Deny…" }));
    const dialog = await screen.findByRole("dialog", { name: "Deny the request" });
    const deny = within(dialog).getByRole("button", { name: "Deny" });
    expect(deny).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason (required)"), "   ");
    expect(deny).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason (required)"), "Use the read-only tool set.");
    await user.click(deny);
    await waitFor(() => expect(rec.last("POST", "/api/requests/11/decision")?.body).toEqual({ decision: "deny", reason: "Use the read-only tool set." }));
    expect(await screen.findByText("Denied")).toBeInTheDocument();
  });

  it("builds approve payloads without unchanged fields", () => {
    expect(approveBody(REQ, { mode: "grant_direct", durationDays: 90 })).toEqual({ decision: "approve", provision_mode: "grant_direct" });
    expect(approveBody(REQ, { mode: "record_only", durationDays: 14, reason: " ok " })).toEqual({ decision: "approve", provision_mode: "record_only", duration_days: 14, reason: "ok" });
  });

  it("sorts overdue first and keeps just-decided requests visible", () => {
    const a = { ...REQ, request_id: 1, sla_state: "on_track" as const };
    const b = { ...REQ, request_id: 2, sla_state: "overdue" as const };
    const c = { ...REQ, request_id: 3, status: "denied" as const, sla_state: "closed" as const };
    expect(filterRequests([a, b, c], "open").map((r) => r.request_id)).toEqual([2, 1]);
    expect(filterRequests([a, b, c], "open", new Set([3])).map((r) => r.request_id)).toEqual([2, 1, 3]);
  });
});
