import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { dayStartIso, localDay } from "../components/updates/model";
import { ADMIN, AUDITOR, STEPS_FAILED, candidate, capability, feedItem, overview } from "../components/updates/fixtures.test-utils";
import { envelope, recordFetch } from "../components/workspace/fetchRecorder.test-utils";
import type { Me, UpdateCandidate } from "../lib/types";
import { HEALTH_OK, renderWithProviders } from "../test/utils";
import PlatformUpdatesPage from "./PlatformUpdates";

const READY = candidate({ candidate_id: 1, title: "Agent Registry Hub 0.3.0 is staged", to_version: "0.3.0" });
const BREAKING = candidate({
  candidate_id: 2, kind: "capability", title: "New API available here: Supervisor Agent API (v2.1)", capability_key: "supervisor_agents_v21",
  breaking: true, breaking_reasons: ["006_agent_services: DROP COLUMN asset.legacy_endpoint"],
  migrations: [{ version: "006_agent_services", breaking: true, reasons: ["DROP COLUMN asset.legacy_endpoint"], allow_data_loss: false, statements: 3 }],
});
const FAILED = candidate({
  candidate_id: 3, title: "Agent Registry Hub 0.4.0 is staged", status: "failed",
  regression: { started_at: "2026-10-26T11:00:00Z", finished_at: "2026-10-26T11:00:02Z", branch: "local:br_upd_3", passed: false, steps: STEPS_FAILED },
});
const DETECTED = candidate({ candidate_id: 4, kind: "advisory", title: "Release notes: UC skills API", status: "detected", regression: null, migrations: [] });
const REJECTED = candidate({ candidate_id: 5, title: "Agent Registry Hub 0.1.9 is staged", status: "rejected", decided_by: "jane.doe@example.com", decided_at: "2026-10-20T10:00:00Z", decision_note: "Superseded by 0.3.0" });
const ALL = [READY, BREAKING, FAILED, DETECTED, REJECTED];

function setup({ me = ADMIN, route = "/platform-updates", rows = ALL, routes = {} }: { me?: Me; route?: string; rows?: UpdateCandidate[]; routes?: Record<string, unknown> } = {}) {
  const rec = recordFetch({
    "/api/health": HEALTH_OK,
    "/api/me": envelope(me),
    "/api/platform-watch": envelope(overview()),
    "/api/platform-watch/candidates": envelope(rows),
    ...routes,
  });
  renderWithProviders(<PlatformUpdatesPage />, { route });
  return rec;
}

const card = (name: RegExp) => screen.findByRole("article", { name });

describe("Platform updates · Updates tab", () => {
  it("shows the KPI row and groups candidates by status (history folded)", async () => {
    setup();
    const ready = await screen.findByRole("list", { name: "Ready to review" });
    // breaking first among the ready ones
    expect(within(ready).getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual([
      "New capability: New API available here: Supervisor Agent API (v2.1)",
      "App release: Agent Registry Hub 0.3.0 is staged",
    ]);
    expect(within(screen.getByRole("list", { name: "Needs attention" })).getByRole("article", { name: /0\.4\.0/ })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Testing & detected" })).getByRole("article", { name: /UC skills API/ })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Delayed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: /0\.1\.9/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show history (1)" }));
    expect(within(screen.getByRole("list", { name: "History" })).getByRole("article", { name: /0\.1\.9/ })).toHaveTextContent("Superseded by 0.3.0");

    const kpis = screen.getByLabelText("Platform update counts");
    expect(within(kpis).getByText("Ready to review").closest("div")?.parentElement).toHaveTextContent("2");
    expect(within(kpis).getByText("Non-breaking only")).toBeInTheDocument();
  });

  it("renders the regression timeline: passed steps, a failed step with its detail open, JSON details on demand", async () => {
    const user = userEvent.setup();
    setup();
    const failed = await card(/0\.4\.0/);
    const steps = within(failed).getByRole("list", { name: "Regression steps" });
    const items = within(steps).getAllByRole("listitem").filter((li) => li.hasAttribute("data-status"));
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual(["passed", "passed", "passed", "failed", "passed"]);
    const failedStep = items[3];
    expect(within(failedStep).getByText("Data preservation")).toBeInTheDocument();
    expect(within(failedStep).getByText("Failed")).toBeInTheDocument();
    expect(within(failedStep).getByText(/rows lost: \{'legacy_tool': \(14, 0\)\}/)).toBeInTheDocument(); // open by default
    expect(within(failed).getByText("Regression failed")).toBeInTheDocument();
    expect(within(failed).getByText("local:br_upd_3")).toBeInTheDocument();
    expect(within(failed).queryByRole("button", { name: "Accept…" })).not.toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Re-run regression" })).toBeInTheDocument();

    const ready = await card(/0\.3\.0 is staged/);
    expect(within(ready).getByText("6 of 6 steps passed", { exact: false })).toBeInTheDocument();
    expect(within(ready).getByText("1161 rows in 35 tables")).toBeInTheDocument(); // short string details inline
    await user.click(within(ready).getByRole("button", { name: "Show detail for Read-path smoke checks (live data copy)" }));
    const json = within(ready).getByRole("list", { name: "Step detail (JSON)" });
    expect(json).toHaveTextContent("catalog:");
    expect(json).toHaveTextContent("total: 11");
  });

  it("a breaking accept lists the reasons, needs a note, then shows the apply run from the server", async () => {
    const user = userEvent.setup();
    const rec = setup({
      routes: {
        "POST /api/platform-watch/candidates/2/decision": (c: { body: { note?: string } }) => ({
          ...BREAKING, status: "accepted", decided_by: ADMIN.email, decided_at: "2026-10-26T12:00:00Z", decision_note: c.body.note,
          apply_run: { mode: "not_configured", note: "The updates job isn't configured (WATCH_JOB_ID). Run `python jobs/platform_updates.py --mode apply --candidate 2`" },
        }),
      },
    });
    const c = await card(/Supervisor Agent API/);
    expect(within(c).getAllByText("Breaking").length).toBeGreaterThan(0);
    await user.click(within(c).getByRole("button", { name: "Accept…" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept a breaking update" });
    expect(within(within(dialog).getByRole("list", { name: "Breaking reasons" })).getByText("006_agent_services: DROP COLUMN asset.legacy_endpoint")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Tell the impacted consumers first");
    const accept = within(dialog).getByRole("button", { name: "Accept breaking update" });
    expect(accept).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Note (required)"), "   ");
    expect(accept).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Note (required)"), "Told the 3 subscribers on 26 Oct");
    await user.click(accept);

    await waitFor(() => expect(rec.last("POST", "/api/platform-watch/candidates/2/decision")).toBeDefined());
    expect(rec.last("POST", "/api/platform-watch/candidates/2/decision")!.body).toEqual({ action: "accept", note: "Told the 3 subscribers on 26 Oct" });
    const moved = await screen.findByRole("article", { name: /Supervisor Agent API/ });
    expect(within(screen.getByRole("list", { name: "Testing & detected" })).getByRole("article", { name: /Supervisor Agent API/ })).toBe(moved);
    expect(within(moved).getByText("Accepted · apply queued")).toBeInTheDocument();
    expect(within(moved).getByText("python jobs/platform_updates.py --mode apply --candidate 2")).toBeInTheDocument();
    expect(within(moved).queryByRole("button", { name: "Accept…" })).not.toBeInTheDocument();
  });

  it("a non-breaking accept sends no note; a 409 is shown in a toast and nothing moves", async () => {
    const user = userEvent.setup();
    const rec = setup({ routes: { "POST /api/platform-watch/candidates/1/decision": [409, { detail: "Only a candidate whose regression passed can be accepted. Run the regression first" }] } });
    const c = await card(/0\.3\.0 is staged/);
    await user.click(within(c).getByRole("button", { name: "Accept…" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this update" });
    await user.click(within(dialog).getByRole("button", { name: "Accept & apply" }));
    await waitFor(() => expect(rec.last("POST", "/api/platform-watch/candidates/1/decision")?.body).toEqual({ action: "accept" }));
    expect(await screen.findByRole("alert", { name: "" })).toBeDefined();
    expect(await screen.findByText(/Run the regression first/)).toBeInTheDocument();
    expect(within(await card(/0\.3\.0 is staged/)).getByText("Regression passed")).toBeInTheDocument();
  });

  it("delay proposes today + default_delay_days and sends that date", async () => {
    const user = userEvent.setup();
    const rec = setup({ routes: { "POST /api/platform-watch/candidates/1/decision": (c: { body: { delay_until: string } }) => ({ ...READY, status: "delayed", delay_until: c.body.delay_until }) } });
    const c = await card(/0\.3\.0 is staged/);
    await user.click(within(c).getByRole("button", { name: "Delay…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delay this update" });
    expect(within(dialog).getByLabelText("Delay until")).toHaveValue(localDay(7));
    await user.click(within(dialog).getByRole("button", { name: "Delay" }));
    await waitFor(() => expect(rec.last("POST", "/api/platform-watch/candidates/1/decision")?.body).toEqual({ action: "delay", delay_until: dayStartIso(localDay(7)) }));
    const delayed = within(await screen.findByRole("list", { name: "Delayed" })).getByRole("article", { name: /0\.3\.0 is staged/ });
    expect(within(delayed).getByRole("button", { name: "Change delay…" })).toBeInTheDocument();
    expect(within(delayed).queryByRole("button", { name: "Accept…" })).not.toBeInTheDocument();
  });

  it("reject needs a reason", async () => {
    const user = userEvent.setup();
    const rec = setup({ routes: { "POST /api/platform-watch/candidates/1/decision": (c: { body: { note: string } }) => ({ ...READY, status: "rejected", decision_note: c.body.note }) } });
    await user.click(within(await card(/0\.3\.0 is staged/)).getByRole("button", { name: "Reject…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this update" });
    const reject = within(dialog).getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason (required)"), "We stay on 0.2 this quarter");
    await user.click(reject);
    await waitFor(() => expect(rec.last("POST", "/api/platform-watch/candidates/1/decision")?.body).toEqual({ action: "reject", note: "We stay on 0.2 this quarter" }));
  });

  it("an advisory is acknowledged, and Run Platform Watch now shows the not_configured note", async () => {
    const user = userEvent.setup();
    const rec = setup({
      routes: {
        "POST /api/platform-watch/candidates/4/decision": { ...DETECTED, status: "applied", applied_at: "2026-10-26T12:00:00Z" },
        "POST /api/platform-watch/run": { mode: "not_configured", note: "The updates job isn't configured (WATCH_JOB_ID). Run `python jobs/platform_updates.py --mode watch`" },
      },
    });
    const adv = await card(/UC skills API/);
    expect(within(adv).queryByRole("button", { name: "Accept…" })).not.toBeInTheDocument();
    await user.click(within(adv).getByRole("button", { name: "Acknowledge…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Acknowledge this advisory" })).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(rec.last("POST", "/api/platform-watch/candidates/4/decision")?.body).toEqual({ action: "acknowledge" }));

    await user.click(screen.getByRole("button", { name: "Run Platform Watch now" }));
    expect(await screen.findByText("python jobs/platform_updates.py --mode watch")).toBeInTheDocument();
    expect(rec.last("POST", "/api/platform-watch/run")).toBeDefined();
  });

  it("is read-only for auditors: no decision or run buttons", async () => {
    setup({ me: AUDITOR });
    const c = await card(/0\.3\.0 is staged/);
    expect(within(c).queryByRole("button", { name: /Accept|Delay|Reject|Re-run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Platform Watch now" })).not.toBeInTheDocument();
    expect(screen.getByText("Read-only (auditor)")).toBeInTheDocument();
  });
});

describe("Platform updates · capabilities, feed, settings", () => {
  it("shows every capability status as icon + words, with the probe in mono", async () => {
    setup({
      route: "/platform-updates#capabilities",
      routes: {
        "/api/platform-watch/capabilities": envelope([
          capability(),
          capability({ capability_key: "genie_agents_api", label: "Genie Agents API", area: "agents", status: "unavailable", http_status: 404, adapter: null, adapter_enabled: false }),
          capability({ capability_key: "rfa_requests", label: "RFA API", area: "access", status: "no_access", http_status: 403, probe_detail: "PERMISSION_DENIED" }),
          capability({ capability_key: "traces", label: "MLflow trace search (v3)", area: "traces", status: "error", http_status: 500, probe_method: "POST", probe_path: "/api/3.0/mlflow/traces/search" }),
          capability({ capability_key: "service_policies", label: "Service policies", area: "guardrails", status: "unknown", probe_kind: "none", probe_path: null, http_status: null, last_probed_at: null }),
        ]),
      },
    });
    const row = (key: string) => document.querySelector(`tr[data-capability="${key}"]`) as HTMLElement;
    await waitFor(() => expect(row("uc_skills")).not.toBeNull());
    const expectations: [string, string][] = [["uc_skills", "Available"], ["genie_agents_api", "Unavailable"], ["rfa_requests", "No access"], ["traces", "Probe error"], ["service_policies", "Not probed"]];
    for (const [key, label] of expectations) {
      const pill = within(row(key)).getByText(label);
      expect(pill.querySelector("svg")).not.toBeNull(); // never colour only
    }
    expect(within(row("traces")).getByText("POST")).toBeInTheDocument();
    expect(within(row("traces")).getByText("/api/3.0/mlflow/traces/search")).toBeInTheDocument();
    expect(within(row("genie_agents_api")).getByText("No adapter yet")).toBeInTheDocument();
    expect(within(row("uc_skills")).getByText("Enabled")).toBeInTheDocument();
    expect(within(row("service_policies")).getByText("No probe (no list API)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Traces & evals" })).toBeInTheDocument();
  });

  it("filters the release feed by the relevance threshold and lets an admin dismiss", async () => {
    const user = userEvent.setup();
    const rec = setup({
      route: "/platform-updates#feed",
      routes: {
        "/api/platform-watch/feed?min_relevance=35": envelope([feedItem(), feedItem({ item_id: 83, title: "MLflow 3.6", source_id: "mlflow_releases", candidate_id: null, lifecycle_hint: null, breaking_hint: false, relevance: 40, matched_capabilities: [] })]),
        "/api/platform-watch/capabilities": envelope([capability({ capability_key: "supervisor_agents_v21", label: "Supervisor Agent API (v2.1)" })]),
        "POST /api/platform-watch/feed/83/dismiss": { ok: true },
      },
    });
    const item = await screen.findByRole("article", { name: "Knowledge Assistant and Supervisor Agent are now legacy" });
    expect(within(item).getByText("Deprecation")).toBeInTheDocument();
    expect(within(item).getByText("May break")).toBeInTheDocument();
    expect(await within(item).findByText("Supervisor Agent API (v2.1)")).toBeInTheDocument();
    expect(within(item).getByRole("meter", { name: "Relevance" })).toHaveAttribute("aria-valuenow", "78");
    expect(within(item).getByRole("link", { name: "View candidate #27" })).toHaveAttribute("href", "/platform-updates?candidate=27#updates");
    expect(screen.getByLabelText("Minimum relevance")).toHaveValue("35");
    expect(screen.getByRole("list", { name: "Feed source health" })).toHaveTextContent("error: URLError: timed out");

    const other = screen.getByRole("article", { name: "MLflow 3.6" });
    await user.click(within(other).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(rec.last("POST", "/api/platform-watch/feed/83/dismiss")).toBeDefined());
    expect(await within(other).findByText("Dismissed")).toBeInTheDocument();
  });

  it("saves the auto-upgrade policy and a threshold with the server's value", async () => {
    const user = userEvent.setup();
    const rec = setup({
      route: "/platform-updates#settings",
      routes: {
        "PUT /api/platform-watch/settings/auto_upgrade": (c: { body: { value: string } }) => ({ key: "auto_upgrade", value: c.body.value }),
        "PUT /api/platform-watch/settings/relevance_threshold": (c: { body: { value: number } }) => ({ key: "relevance_threshold", value: c.body.value }),
      },
    });
    const save = await screen.findByRole("button", { name: "Save policy" });
    expect(save).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Non-breaking only/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^All/ }));
    await user.click(save);
    await waitFor(() => expect(rec.last("PUT", "/api/platform-watch/settings/auto_upgrade")?.body).toEqual({ value: "all" }));
    await waitFor(() => expect(within(screen.getByRole("radio", { name: /^All/ }).closest("label")!).getByText("Current")).toBeInTheDocument());

    const threshold = screen.getByLabelText("Relevance threshold (of 100)");
    await user.clear(threshold);
    await user.type(threshold, "50");
    await user.click(screen.getByRole("button", { name: "Save relevance threshold" }));
    await waitFor(() => expect(rec.last("PUT", "/api/platform-watch/settings/relevance_threshold")?.body).toEqual({ value: 50 }));
    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByText("Lakebase branch", { selector: "div" })).toBeInTheDocument();
  });

  it("settings are read-only for non-admins", async () => {
    setup({ me: AUDITOR, route: "/platform-updates#settings" });
    expect(await screen.findByText(/Read-only: only admins change/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^All/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
  });
});
