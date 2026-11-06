import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AssetCard, GovernanceSources } from "../../lib/types";
import { renderWithProviders } from "../../test/utils";
import { envelope, recordFetch } from "../workspace/fetchRecorder.test-utils";
import AuditVerify from "./AuditVerify";
import { SourcesPanel } from "./GovernancePanels";
import { AssetForm, SkillForm, slugify } from "./RegisterForms";

describe("Audit verify", () => {
  it("shows an intact chain", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/audit/verify": envelope({ intact: true, checked: 1234, problems: [] }) });
    renderWithProviders(<AuditVerify />);
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByText(/1,234 rows checked/)).toBeInTheDocument();
    expect(screen.getByText("Chain intact.").closest("[data-verdict]")).toHaveAttribute("data-verdict", "intact");
  });

  it("lists the problems of a broken chain", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/audit/verify": envelope({ intact: false, checked: 40, problems: [{ audit_id: 17, problem: "row hash mismatch" }, { audit_id: 18, problem: "prev_hash does not match row 17" }] }) });
    renderWithProviders(<AuditVerify />);
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    const verdict = (await screen.findByText(/2 problems found in 40 rows checked/)).closest("[data-verdict]")!;
    expect(verdict).toHaveAttribute("data-verdict", "broken");
    expect(within(verdict as HTMLElement).getByText("row hash mismatch")).toBeInTheDocument();
    expect(within(verdict as HTMLElement).getByText("#18")).toBeInTheDocument();
  });

  it("says so when it couldn't verify", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/audit/verify": [403, { detail: "Only stewards, admins and auditors can verify the audit chain" }] });
    renderWithProviders(<AuditVerify />);
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByText(/Couldn't verify: You don't have access to this view\. Only stewards/)).toBeInTheDocument();
  });
});

describe("Sources & sync", () => {
  const SOURCES: GovernanceSources = {
    job: { configured: true, job_id: "991", url: "https://ws.example.com/jobs/991" },
    collectors: [
      {
        collector: "agent_endpoints", label: "Agents on Model Serving endpoints",
        last: { run_id: 4, collector: "agent_endpoints", started_at: "2026-10-26T09:00:00Z", finished_at: "2026-10-26T09:00:12Z", status: "partial", items_seen: 40, items_changed: 3, error: null, triggered_by: "schedule" },
        history: [
          { run_id: 4, collector: "agent_endpoints", started_at: "2026-10-26T09:00:00Z", finished_at: "2026-10-26T09:00:12Z", status: "partial", items_seen: 40, items_changed: 3, error: null, triggered_by: "schedule" },
          { run_id: 2, collector: "agent_endpoints", started_at: "2026-10-25T09:00:00Z", finished_at: "2026-10-25T09:00:10Z", status: "failed", items_seen: 0, items_changed: 0, error: "403 PERMISSION_DENIED", triggered_by: "schedule" },
        ],
      },
    ],
  };

  it("shows each collector's status and history, and the honest Sync now result (job run link)", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/governance/sources": envelope(SOURCES),
      "POST /api/governance/sync": { ok: true, run: { mode: "job", job_id: "991", run_id: 5521, url: "https://ws.example.com/jobs/991/runs/5521" } },
    });
    renderWithProviders(<SourcesPanel canSync />);
    expect(await screen.findByText("Agents on Model Serving endpoints")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Last 2 runs: partial, failed" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(screen.getByText("403 PERMISSION_DENIED")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("link", { name: /Open the job run/ })).toHaveAttribute("href", "https://ws.example.com/jobs/991/runs/5521");
    expect(rec.last("POST", "/api/governance/sync")!.body).toEqual({});
    await user.click(screen.getByRole("button", { name: "Sync Agents on Model Serving endpoints now" }));
    await waitFor(() => expect(rec.last("POST", "/api/governance/sync")!.body).toEqual({ collectors: ["agent_endpoints"] }));
  });

  it("surfaces a refused sync as an error toast and hides Sync for read-only roles", async () => {
    const user = userEvent.setup();
    recordFetch({ "/api/governance/sources": envelope(SOURCES), "POST /api/governance/sync": [409, { detail: "A sync is already running in this app instance" }] });
    const view = renderWithProviders(<SourcesPanel canSync />);
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("It changed state in the meantime. A sync is already running in this app instance")).toBeInTheDocument();
    view.unmount();
    renderWithProviders(<SourcesPanel canSync={false} />);
    await screen.findByText("Agents on Model Serving endpoints");
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
  });
});

describe("Register", () => {
  const CARD = { asset_id: "skill:custom:jane-cohort-builder", display_name: "cohort-builder" } as AssetCard;

  it("posts a custom agent with the contract's fields", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({ "POST /api/assets": { ...CARD, asset_id: "agent:custom:claims-triage", display_name: "Claims Triage" } });
    renderWithProviders(<AssetForm />, { route: "/register" });
    await user.type(screen.getByLabelText("Display name"), "Claims Triage");
    expect(screen.getByLabelText("Name (id)")).toHaveValue("claims-triage");
    await user.type(screen.getByLabelText("Purpose"), "Triages incoming claims.");
    await user.type(screen.getByLabelText("Endpoint URL (optional)"), "https://ws.example.com/serving-endpoints/claims/invocations");
    await user.type(screen.getByLabelText("Tags (comma separated)"), "Claims, triage, claims");
    await user.click(screen.getByRole("button", { name: "Register agent" }));
    await waitFor(() => expect(rec.last("POST", "/api/assets")).toBeDefined());
    expect(rec.last("POST", "/api/assets")!.body).toEqual({
      asset_type: "agent", display_name: "Claims Triage", name: "claims-triage", platform: "model_serving", purpose: "Triages incoming claims.", sensitivity: "internal",
      endpoint_url: "https://ws.example.com/serving-endpoints/claims/invocations", tags: ["claims", "triage"],
    });
    expect(slugify("Ünïcode  Agent!")).toBe("unicode-agent");
  });

  it("previews and validates a SKILL.md live, then posts it", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({ "POST /api/skills": CARD });
    renderWithProviders(<SkillForm />, { route: "/register#skill" });
    const area = screen.getByLabelText("SKILL.md content");
    await user.click(area);
    await user.paste("---\nname: Cohort_Builder\ndescription: Builds cohorts. Use when someone asks for a cohort or its size.\n---\n# Steps");
    expect(screen.getByText("1 problem")).toBeInTheDocument();
    expect(screen.getByText(/name may only contain lowercase letters, digits and hyphens/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register skill" })).toBeDisabled();
    await user.clear(area);
    await user.paste("---\nname: cohort-builder\ndescription: Builds cohorts. Use when someone asks for a cohort or its size.\nallowed-tools: Read Bash(databricks:*)\n---\n# Steps");
    expect(screen.getByText("Valid")).toBeInTheDocument();
    expect(screen.getByText("14/64")).toBeInTheDocument();
    expect(screen.getByText("Bash(databricks:*)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Register skill" }));
    await waitFor(() => expect(rec.last("POST", "/api/skills")?.body).toEqual({ skill_md: expect.stringContaining("name: cohort-builder") }));
  });
});
