import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { UcLineageStatus, UcReadiness, UcReadinessCheck, UcReadinessPath } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { envelope, recordFetch } from "../workspace/fetchRecorder.test-utils";
import { UcLineagePanel } from "./UcLineagePanel";
import { publishBlockedReason } from "./UcReadiness";

const SP = "cd960439-5173-4ef4-8f1d-1cefe69d5435";
const GRANT = `GRANT CREATE EXTERNAL METADATA ON METASTORE TO \`${SP}\`;`;
const TABLE_GRANT = `GRANT MODIFY ON TABLE \`demo\`.\`claims\`.\`claim_lines\` TO \`${SP}\`;`;
const counts = (c: number) => ({ create: c, update: 0, delete: 0, forget: 0, unchanged: 0 });
const STATUS: UcLineageStatus = {
  available: true, can_publish: true, settings: { publish_in_sync: false }, tracked: {}, failed: [], runs: [],
  plan: {
    mode: "platform", digest: "d1g3st", instance: "i-1", total_ops: 2, truncated: false, objects: counts(1), relationships: counts(1),
    desired: { objects: 1, relationships: 1 }, tables: ["demo.claims.claim_lines"], requirements: ["MODIFY on each of the 1 UC table(s) the relationships touch"], skipped: [],
    ops: [{ op: "create", kind: "external_metadata", key: "agent_registry_hub__a", label: "Claims Analytics", detail: "New in the hub's lineage", content_hash: "h",
      request: { method: "POST", path: "/api/2.0/lineage-tracking/external-metadata" } }],
  },
};

const metastore = (status: UcReadinessCheck["status"]): UcReadinessCheck => ({
  id: "metastore_privilege", title: "CREATE EXTERNAL METADATA on the metastore", blocking: true, status,
  detail: status === "ok" ? "Held on metastore m (SP, granted directly)." : status === "missing" ? `${SP} does not hold CREATE EXTERNAL METADATA on metastore metastore_aws_us_east_1.`
    : "Couldn't read effective permissions on metastore m: InternalError: upstream timeout",
  remediation: status === "ok" ? null : { sql: [GRANT], run_by: "A metastore admin (a member of the metastore owner metastore_admins)" },
});
const tables = (status: UcReadinessCheck["status"]): UcReadinessCheck => ({
  id: "table_modify", title: "MODIFY on the tables the relationships touch", blocking: false, status, total: 1, checked: 1, unchecked: 0,
  detail: status === "ok" ? "1 of 1 checked table(s) have it." : "0 of 1 checked table(s) have it; 1 without MODIFY.",
  tables: [{ table: "demo.claims.claim_lines", status: status === "ok" ? "ok" : "missing", detail: status === "ok" ? "SP, granted directly" : "No MODIFY; the owner is data-team", sql: status === "ok" ? undefined : TABLE_GRANT }],
  remediation: status === "ok" ? null : { sql: [TABLE_GRANT], run_by: "Each table's owner (or anyone with MANAGE on the table, its schema or its catalog)" },
});
const api: UcReadinessCheck = { id: "api_reachable", title: "External lineage API answers", blocking: true, status: "ok", detail: "GET … answered.", remediation: null };
const path = (status: UcReadinessPath["status"], checks: UcReadinessCheck[], reason: string | null): UcReadinessPath => ({
  path: "app", label: "App service principal", applies_to: "Publish from this page when no user token is forwarded", principal: SP, principal_kind: "service_principal",
  status, reason, checks, remediation_sql: checks.flatMap((c) => c.remediation?.sql ?? []),
});
const sync: UcReadinessPath = { ...path("blocked", [metastore("missing")], "blocked"), path: "sync", label: "Sync job identity", principal: "deployer@example.com", principal_kind: "user",
  applies_to: "Publish during the hourly sync (when turned on)", remediation_sql: [],
  last_check: { status: "blocked", reason: "x", principal: "deployer@example.com", skipped: true, triggered_by: "schedule", checked_at: "2026-10-28T09:15:00Z", checks: [] } };
const readiness = (status: UcReadiness["status"], checks: UcReadinessCheck[], reason: string | null): UcReadiness => ({
  status, reason, active_path: "app", mode: "platform", enforced: true, obo_token_forwarded: false,
  metastore: { metastore_id: "c0da", name: "metastore_aws_us_east_1", owner: "metastore_admins" },
  paths: [path(status === "not_required" ? "unknown" : status, checks, reason), sync],
  tables: { total: 1, max_checked: 20, error: null }, remediation_sql: checks.flatMap((c) => c.remediation?.sql ?? []),
  grants_script: "python3 scripts/uc_lineage_grants.py <target> <profile>", checked_at: "2026-10-28T10:00:00Z", cached: false, ttl_seconds: 300,
});
const BLOCKED = readiness("blocked", [metastore("missing"), tables("missing"), api], `${SP} does not hold CREATE EXTERNAL METADATA on metastore metastore_aws_us_east_1.`);
const READY = readiness("ready", [metastore("ok"), tables("ok"), api], null);
const UNKNOWN = readiness("unknown", [metastore("unknown"), tables("ok"), api], "Couldn't read effective permissions on metastore m: InternalError: upstream timeout");
const PARTIAL = readiness("partial", [metastore("ok"), tables("missing"), api], "0 of 1 checked table(s) have it; 1 without MODIFY.");

const READINESS = "/api/lineage/uc-publish/readiness";
const publishButton = () => screen.getByRole("button", { name: "Publish 2 changes" });

describe("Unity Catalog lineage readiness", () => {
  it("disables Publish with the reason while blocked, and shows the grant SQL with who runs it", async () => {
    recordFetch({ "/api/lineage/uc-publish": envelope(STATUS), [READINESS]: envelope(BLOCKED, "live") });
    renderWithProviders(<UcLineagePanel canPublish />);
    const checklist = await screen.findByRole("region", { name: "Publishing readiness" });
    await waitFor(() => expect(publishButton()).toBeDisabled());
    expect(publishButton()).toHaveAttribute("title", expect.stringContaining("does not hold CREATE EXTERNAL METADATA"));
    expect(screen.getByRole("alert")).toHaveTextContent("Publish is disabled until the missing privilege is granted");
    const app = within(checklist).getByRole("region", { name: "App service principal readiness" });
    expect(within(app).getByText("Blocked")).toBeInTheDocument();
    expect(app.querySelector('[data-check="metastore_privilege"]')).toHaveAttribute("data-status", "missing");
    expect(within(app).getByText(GRANT)).toBeInTheDocument();
    expect(within(app).getByText("Run by: A metastore admin (a member of the metastore owner metastore_admins)")).toBeInTheDocument();
    expect(within(app).getByText(/Not blocking/)).toBeInTheDocument();
    expect(within(checklist).getByText("Live API")).toBeInTheDocument();
    // the sync identity's last hourly check, next to the toggle
    expect(screen.getByText(/the step skips \(and records why\) until this is ready/)).toBeInTheDocument();
  });

  it("copies the exact grant SQL", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/lineage/uc-publish": envelope(STATUS), [READINESS]: envelope(BLOCKED, "live") });
    renderWithProviders(<UcLineagePanel canPublish />);
    const app = await screen.findByRole("region", { name: "App service principal readiness" });
    await user.click(within(app).getByRole("button", { name: "Copy grant SQL: CREATE EXTERNAL METADATA on the metastore" }));
    expect(await navigator.clipboard.readText()).toBe(GRANT);
    await user.click(within(app).getByRole("button", { name: "Copy all grant SQL for App service principal" }));
    expect(await navigator.clipboard.readText()).toBe(`${GRANT}\n${TABLE_GRANT}`);
  });

  it("re-checks without the server cache and enables Publish once ready", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({ "/api/lineage/uc-publish": envelope(STATUS), [READINESS]: envelope(BLOCKED, "live"), [`${READINESS}?refresh=true&n=1`]: envelope(READY, "live") });
    renderWithProviders(<UcLineagePanel canPublish />);
    await waitFor(() => expect(publishButton()).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(rec.calls.some((c) => c.path === `${READINESS}?refresh=true&n=1`)).toBe(true));
    await waitFor(() => expect(publishButton()).toBeEnabled());
    const app = screen.getByRole("region", { name: "App service principal readiness" });
    expect(within(app).queryByText(GRANT)).not.toBeInTheDocument();
    expect(within(app).getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an unknown answer without locking Publish, and warns in the confirm dialog", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/lineage/uc-publish": envelope(STATUS), [READINESS]: envelope(UNKNOWN, "live") });
    renderWithProviders(<UcLineagePanel canPublish />);
    const app = await screen.findByRole("region", { name: "App service principal readiness" });
    expect(app.querySelector('[data-check="metastore_privilege"]')).toHaveAttribute("data-status", "unknown");
    expect(within(app).getByText("Couldn't check")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't confirm:/)).toBeInTheDocument();
    expect(publishButton()).toBeEnabled();
    await user.click(publishButton());
    const dialog = await screen.findByRole("dialog", { name: "Publish to Unity Catalog" });
    expect(within(dialog).getByText(/Readiness couldn't be confirmed/)).toBeInTheDocument();
  });

  it("keeps Publish enabled when only tables lack MODIFY, and when the readiness request itself fails", async () => {
    recordFetch({ "/api/lineage/uc-publish": envelope(STATUS), [READINESS]: envelope(PARTIAL, "live") });
    const view = renderWithProviders(<UcLineagePanel canPublish />);
    await waitFor(() => expect(screen.getAllByText("Ready, with table gaps").length).toBeGreaterThan(0));
    expect(publishButton()).toBeEnabled();
    view.unmount();
    recordFetch({ "/api/lineage/uc-publish": envelope(STATUS), [READINESS]: [500, { detail: "boom" }] });
    renderWithProviders(<UcLineagePanel canPublish />);
    expect(await screen.findByText("Couldn't check publishing readiness")).toBeInTheDocument();
    expect(publishButton()).toBeEnabled();
    expect(screen.getByText("Claims Analytics")).toBeInTheDocument();
  });

  it("only a blocked, enforced answer disables Publish", () => {
    expect(publishBlockedReason(BLOCKED)).toContain("does not hold CREATE EXTERNAL METADATA");
    expect(publishBlockedReason({ ...BLOCKED, enforced: false })).toBeNull();
    expect(publishBlockedReason(UNKNOWN)).toBeNull();
    expect(publishBlockedReason(PARTIAL)).toBeNull();
    expect(publishBlockedReason(null)).toBeNull();
  });
});
