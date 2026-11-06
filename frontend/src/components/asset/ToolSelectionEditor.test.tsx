import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssetDetail, ImpactPreview, ToolSelectionPreview, ToolSelectionState } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { envelope, recordFetch } from "../workspace/fetchRecorder.test-utils";
import { AssetContext, type AssetCtx } from "./AssetContext";
import ToolSelectionEditor from "./ToolSelectionEditor";
import { diffSelection, parseSelectors, selects, validateSelectors } from "./toolSelection";

const SVC = "mcp:service:demo.care_tools.care_ops_mcp";
const BASE = `/api/assets/${encodeURIComponent(SVC)}`;
const tool = (name: string, exposed: boolean, side_effect = "read") => ({ asset_id: `tool:mcp:service:demo.care_tools.care_ops_mcp/${name}`, name, display_name: name, side_effect, requests_30d: 3, exposed_now: exposed });
const STATE: ToolSelectionState = {
  asset_id: SVC, editable: true, reason_not_editable: null, can_edit: true, current: ["lookup_*", "create_ticket"], etag: "demo-etag-1",
  tools: [tool("close_ticket", false, "write"), tool("create_ticket", true, "write"), tool("lookup_claim", true), tool("lookup_member", true)],
  history: [], mode: "record_only", limits: { max_selectors: 1024, max_length: 256 },
};
const IMPACT: ImpactPreview = {
  subscribers: [{ impacted_key: "jo.park@example.com", impact_type: "subscriber", via_asset_id: null, hops: 1, email: "jo.park@example.com", ack_status: "pending", ack_note: null, migrate_by: null, acked_at: null, notified_at: null, label: "jo.park@example.com" }],
  downstream: [{ impacted_key: "agent:endpoint:demo-intake-agent", impact_type: "downstream_asset", via_asset_id: null, hops: 1, email: null, ack_status: "not_required", ack_note: null, migrate_by: null, acked_at: null, notified_at: null, label: "Member Intake Agent" }],
  observed: [], total_people: 1, email_preview: { subject: "[Breaking] Care Ops MCP (Unity Gateway): Tool selection: 1 tool hidden", body: "" }, checks: [],
};
const REQUEST = { method: "PATCH" as const, path: "/api/2.1/unity-catalog/mcp-services/demo.care_tools.care_ops_mcp", query: { update_mask: "config.include_tool_selectors", etag: "demo-etag-1" }, body: { name: "mcp-services/demo.care_tools.care_ops_mcp", config: { include_tool_selectors: ["lookup_*"] } } };

function ctx(): AssetCtx {
  const noop = () => {};
  return { assetId: SVC, base: BASE, detail: { asset: { asset_id: SVC, asset_type: "mcp_server" } } as unknown as AssetDetail, email: "lee.chen@example.com", isAuditor: false,
    reload: vi.fn(), patchDetail: noop, openRequest: noop, openSubscribe: noop, openUse: noop, openRuntime: noop, openGovernance: noop, goTab: noop, refreshKey: 0, pendingSubscriptions: [] };
}

function renderEditor(value = ctx()) {
  return renderWithProviders(<AssetContext.Provider value={value}><ToolSelectionEditor /></AssetContext.Provider>);
}

describe("tool selection rules", () => {
  it("validates selectors like Unity Catalog does", () => {
    expect(parseSelectors("lookup_*\n\n create_ticket ,close_ticket")).toEqual(["lookup_*", "create_ticket", "close_ticket"]);
    const v = validateSelectors(["!delete_*", "*", "a*b", "two words", "ok_*", "ok_*"]);
    expect(v.selectors).toEqual(["!delete_*", "*", "a*b", "two words", "ok_*"]);
    expect(v.errors).toHaveLength(4);
    expect(v.warnings).toEqual(["“ok_*” is listed twice"]);
    expect(validateSelectors(Array.from({ length: 1025 }, (_, i) => `t${i}`)).errors).toEqual(["At most 1,024 selectors are allowed (1,025 given)"]);
    expect(selects("anything", [])).toBe(true);
    expect(selects("lookup_claim", ["lookup_*"]) && !selects("close_ticket", ["lookup_*"])).toBe(true);
  });

  it("diffs against the known tools: hiding a tool or narrowing 'every tool' is breaking", () => {
    const d = diffSelection(STATE.tools, STATE.current, ["lookup_*", "search_*"]);
    expect(d.removed).toEqual(["create_ticket"]);
    expect(d.unmatched).toEqual(["search_*"]);
    expect(d.breaking && d.changed).toBe(true);
    expect(diffSelection(STATE.tools, STATE.current, [...STATE.current, "close_ticket"]).breaking).toBe(false);
    expect(diffSelection(STATE.tools, [], ["lookup_*"]).narrowsAll).toBe(true);
  });
});

describe("ToolSelectionEditor", () => {
  it("shows the current selection read-only for non-editors", async () => {
    recordFetch({ [`${BASE}/tool-selection`]: envelope({ ...STATE, can_edit: false }) });
    renderEditor();
    expect(await screen.findByText("3 of 4 known tools exposed")).toBeInTheDocument();
    expect(screen.getByText("lookup_*")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit selection" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the service's owners and stewards/)).toBeInTheDocument();
  });

  it("previews live, validates, needs a fresh impact preview and a reason, then applies with the etag", async () => {
    const user = userEvent.setup();
    const preview: ToolSelectionPreview = { selectors: ["lookup_*"], current: STATE.current, errors: [], warnings: [], tools: STATE.tools, removed: ["create_ticket"], added: [],
      unmatched_selectors: [], exposed_count: 2, hidden_count: 2, breaking: true, changed: true, impact: IMPACT, request: REQUEST, mode: "record_only" };
    const rec = recordFetch({
      [`${BASE}/tool-selection`]: envelope(STATE),
      [`POST ${BASE}/tool-selection/preview`]: preview,
      [`PUT ${BASE}/tool-selection`]: { status: "recorded", selection_id: 1, mode: "record_only", as: null, error: null, request: REQUEST,
        change: { change: { change_id: 42 }, impact: IMPACT.subscribers, ack_summary: {}, metrics_before: null, metrics_after: null }, note: "record_only" },
    });
    const view = ctx();
    renderEditor(view);
    await user.click(await screen.findByRole("button", { name: "Edit selection" }));
    const area = screen.getByLabelText("Selectors (one per line)");
    expect(area).toHaveValue("lookup_*\ncreate_ticket");
    await user.clear(area);
    await user.type(area, "!create_ticket");
    expect(within(screen.getByRole("alert", { name: "Selector problems" })).getByText(/exclusions \(!\) are not supported/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview impact" })).toBeDisabled();
    await user.clear(area);
    await user.type(area, "lookup_*");
    const live = screen.getByRole("region", { name: "Live preview" });
    expect(within(live).getByText("Breaking")).toBeInTheDocument();
    expect(live.querySelector('[data-tool="create_ticket"]')).toHaveAttribute("data-state", "hidden");
    expect(within(live).getByText("Will be hidden")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Record change" });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText("Breaking: 1 tool hidden")).toBeInTheDocument();
    expect(screen.getByText("Member Intake Agent")).toBeInTheDocument();
    expect(rec.last("POST", `${BASE}/tool-selection/preview`)!.body).toEqual({ selectors: ["lookup_*"], reason: null });
    expect(apply).toBeDisabled(); // breaking: a reason is required
    await user.type(screen.getByLabelText(/Reason and what consumers should do/), "Ticket writes move to the ticketing MCP");
    await user.click(apply);
    await waitFor(() => expect(rec.last("PUT", `${BASE}/tool-selection`)).toBeDefined());
    expect(rec.last("PUT", `${BASE}/tool-selection`)!.body).toEqual({ selectors: ["lookup_*"], etag: "demo-etag-1", reason: "Ticket writes move to the ticketing MCP" });
    expect(await screen.findByText("Tool selection recorded")).toBeInTheDocument();
    expect(view.reload).toHaveBeenCalled();
  });

  it("stays hidden for MCP servers without an editable selection", async () => {
    const rec = recordFetch({ [`${BASE}/tool-selection`]: envelope({ ...STATE, editable: false }) });
    renderEditor();
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: "Tool selection" })).not.toBeInTheDocument();
    expect(screen.queryByText("Edit selection")).not.toBeInTheDocument();
  });
});
