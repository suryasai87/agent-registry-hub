import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Agent365Overview, ExternalRegistration, UcLineageStatus } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { envelope, recordFetch } from "../workspace/fetchRecorder.test-utils";
import { Agent365Panel } from "./Agent365Panel";
import { UcLineagePanel } from "./UcLineagePanel";

const counts = (c: number, u = 0, d = 0, k = 0) => ({ create: c, update: u, delete: d, forget: 0, unchanged: k });
const STATUS: UcLineageStatus = {
  available: true, can_publish: true, settings: { publish_in_sync: false }, tracked: {}, failed: [],
  runs: [{ run_id: 3, triggered_by: "admin@example.com", mode: "record_only", acting_as: null, status: "succeeded", plan_digest: "aaa", counts: { outcomes: { recorded: 4 } }, errors: [], started_at: "2026-10-27T10:00:00Z", finished_at: "2026-10-27T10:00:01Z" }],
  plan: {
    mode: "record_only", digest: "d1g3st", instance: "i-1", total_ops: 2, truncated: false, objects: counts(1, 0, 0, 7), relationships: counts(0, 0, 1, 9),
    desired: { objects: 8, relationships: 9 }, tables: ["demo.claims.claim_lines"],
    requirements: ["CREATE EXTERNAL METADATA on the metastore for the publishing identity", "MODIFY on each of the 1 UC table(s) the relationships touch"],
    skipped: [{ reason: "People stay in the hub (consumer privacy)", count: 2, sample: ["user:jo.park@example.com subscribes agent:endpoint:x"] }],
    ops: [
      { op: "delete", kind: "external_lineage", key: "table:demo.claims.claim_lines>em:agent_registry_hub__a", label: "table:demo.claims.claim_lines>em:agent_registry_hub__a", detail: "No longer in the hub's lineage", content_hash: "h1",
        request: { method: "DELETE", path: "/api/2.0/lineage-tracking/external-lineage", query: { external_lineage_relationship: { id: "r1" } } } },
      { op: "create", kind: "external_metadata", key: "agent_registry_hub__mcp_service_demo__abc", asset_id: "mcp:service:demo", label: "Care Ops MCP", detail: "New in the hub's lineage", content_hash: "h2",
        request: { method: "POST", path: "/api/2.0/lineage-tracking/external-metadata", body: { name: "agent_registry_hub__mcp_service_demo__abc", system_type: "OTHER", entity_type: "MCP server" } } },
    ],
  },
};

describe("Publish to Unity Catalog", () => {
  it("shows the plan, its requests and the requirements, and publishes exactly the previewed digest", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/lineage/uc-publish": envelope(STATUS),
      "POST /api/lineage/uc-publish": { run_id: 4, status: "succeeded", mode: "record_only", acting_as: null, plan_digest: "d1g3st", counts: { outcomes: { recorded: 2 } }, errors: [],
        requests: [{ op: "create", kind: "external_metadata", key: "k", method: "POST", path: "/api/2.0/lineage-tracking/external-metadata" }], results: [] },
    });
    renderWithProviders(<UcLineagePanel canPublish />);
    expect(await screen.findByText("Record only: nothing is sent")).toBeInTheDocument();
    expect(screen.getByLabelText("External metadata objects").querySelector('[data-count="External metadata objects:create"]')).toHaveTextContent("1");
    expect(screen.getByText(/CREATE EXTERNAL METADATA/)).toBeInTheDocument();
    expect(screen.getByText("Care Ops MCP")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Request" })[1]);
    expect(screen.getByText("POST /api/2.0/lineage-tracking/external-metadata")).toBeInTheDocument();
    expect(screen.getByText(/Not published \(2 edges\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish 2 changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish to Unity Catalog" });
    expect(within(dialog).getByText(/Deletes only remove objects the hub created/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(rec.last("POST", "/api/lineage/uc-publish")).toBeDefined());
    expect(rec.last("POST", "/api/lineage/uc-publish")!.body).toEqual({ digest: "d1g3st" });
    expect(await screen.findByText(/1 request\(s\) recorded, none sent/)).toBeInTheDocument();
  });

  it("lets only admins publish or flip the sync setting", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({ "/api/lineage/uc-publish": envelope({ ...STATUS, can_publish: false }), "PUT /api/lineage/uc-publish/settings": { key: "uc_lineage_publish_in_sync", value: true } });
    const view = renderWithProviders(<UcLineagePanel canPublish={false} />);
    await screen.findByText("Care Ops MCP");
    expect(screen.queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Publish during the hourly sync/ })).toBeDisabled();
    view.unmount();
    renderWithProviders(<UcLineagePanel canPublish />);
    await user.click(await screen.findByRole("switch", { name: /Publish during the hourly sync/ }));
    await waitFor(() => expect(rec.last("PUT", "/api/lineage/uc-publish/settings")!.body).toEqual({ publish_in_sync: true }));
  });

  it("explains when the feature is not available yet", async () => {
    recordFetch({ "/api/lineage/uc-publish": envelope({ ...STATUS, available: false, plan: null, note: "Migration 007 is not applied yet: run the setup job." }) });
    renderWithProviders(<UcLineagePanel canPublish />);
    expect(await screen.findByText("Migration 007 is not applied yet: run the setup job.")).toBeInTheDocument();
  });
});

const reg = (over: Partial<ExternalRegistration>): ExternalRegistration => ({
  external_id: "T_1", display_name: "Policy Docs Assistant", platform: "Databricks Genie", publisher: "Example Health Data", url: null,
  hints: { note: "same normalised name" }, matched_asset_id: "agent:endpoint:demo-policy-ka", asset_display_name: "Policy Docs Assistant",
  match_method: "name", confidence: 0.8, status: "suggested", source: "file", first_seen_at: "2026-10-27T10:00:00Z", last_seen_at: "2026-10-27T10:00:00Z",
  reviewed_by: null, reviewed_at: null, review_note: null, ...over,
});
const OVERVIEW: Agent365Overview = {
  registry: "Microsoft Agent 365", available: true, graph: { configured: false, connection: null }, can_import: true, can_review: true,
  counts: { matched: 2, suggested: 1, unmatched: 1 }, runs: [],
  review: [reg({}), reg({ external_id: "T_9", display_name: "Supply Forecast Genie", matched_asset_id: null, asset_display_name: null, match_method: null, confidence: null, status: "unmatched",
                          hints: { genie_space_ids: ["01f0aa11bb22cc33dd44ee55ff667788"], workspace_hosts: ["dbc-a1b2c3d4-e5f6.cloud.databricks.com"] } })],
  linked: [reg({ external_id: "T_6", display_name: "Claims Analytics", matched_asset_id: "agent:genie:demo-claims", asset_display_name: "Claims Analytics (Genie)", match_method: "genie_space_id", confidence: 1, status: "matched" })],
};

describe("Agent 365", () => {
  it("imports an admin-center export and shows what matched", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/agent365": envelope(OVERVIEW),
      "POST /api/agent365/import": { run_id: 7, records: 6, ignored_not_databricks: 1, matched: 2, suggested: 2, unmatched: 1, kept_steward_decision: 0, fields_changed: 2, assets_linked: 2 },
    });
    renderWithProviders(<Agent365Panel />);
    expect(await screen.findByText(/Not configured\. An admin sets the bundle variable/)).toBeInTheDocument();
    const file = new File(["Name,Platform,Agent ID\nClaims Analytics,Databricks Genie,T_6\n"], "AgentRegistry.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Agent 365 export file"), file);
    await waitFor(() => expect(rec.last("POST", "/api/agent365/import")).toBeDefined());
    expect(rec.last("POST", "/api/agent365/import")!.body).toEqual({ filename: "AgentRegistry.csv", content: "Name,Platform,Agent ID\nClaims Analytics,Databricks Genie,T_6\n", format: "csv" });
    expect(await screen.findByText("Imported 6 records:")).toBeInTheDocument();
    expect(screen.getByText("2 matched")).toBeInTheDocument();
  });

  it("queues suggestions and unmatched records for a steward, who links with a reason", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({ "/api/agent365": envelope(OVERVIEW), "POST /api/agent365/review": reg({ status: "linked" }) });
    renderWithProviders(<Agent365Panel />);
    const queue = await screen.findByRole("table", { name: "Registrations waiting for review" });
    expect(within(queue).getByText("Suggested")).toBeInTheDocument();
    expect(within(queue).getByText(/space 01f0aa11bb22cc33dd44ee55ff667788/)).toBeInTheDocument();
    expect(within(queue).getByText("Name 80%")).toBeInTheDocument();
    await user.click(within(queue).getAllByRole("button", { name: "Link" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Link “Policy Docs Assistant”" });
    const submit = within(dialog).getByRole("button", { name: "Link" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), "Same assistant, confirmed with the owner");
    await user.click(submit);
    await waitFor(() => expect(rec.last("POST", "/api/agent365/review")).toBeDefined());
    expect(rec.last("POST", "/api/agent365/review")!.body).toEqual({ external_id: "T_1", action: "link", asset_id: "agent:endpoint:demo-policy-ka", reason: "Same assistant, confirmed with the owner" });
    expect(screen.getByRole("table", { name: "Linked registrations" })).toHaveTextContent("Claims Analytics (Genie)");
  });

  it("hides the file import and review actions from read-only roles", async () => {
    recordFetch({ "/api/agent365": envelope({ ...OVERVIEW, can_import: false, can_review: false }) });
    renderWithProviders(<Agent365Panel />);
    expect(await screen.findByText("Only an admin imports files.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent 365 export file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link" })).not.toBeInTheDocument();
  });
});
