import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { setRequestHeader } from "../lib/api";
import { SessionProvider, VIEW_AS_HEADER } from "../lib/session";
import type { Me, Notification } from "../lib/types";
import { HEALTH_OK, mockFetch, renderWithProviders } from "../test/utils";
import Shell, { SIDEBAR_KEY } from "./Shell";
import { envelope, recordFetch } from "./workspace/fetchRecorder.test-utils";

const primaryNav = () => screen.getByRole("navigation", { name: "Primary" });

const ME: Me = {
  email: "jane.doe@example.com", display_name: "Jane Doe", roles: ["viewer", "admin"], primary_role: "admin", view_as: null,
  is_admin: true, is_steward: true, is_auditor: false,
  counts: { owned: 0, subscriptions: 1, pending_approvals: 2, my_open_requests: 0, unread_notifications: 3, unacked_impacts: 1 },
};

afterEach(() => {
  setRequestHeader(VIEW_AS_HEADER, null);
});

describe("Shell", () => {
  it("renders the navbar, the How It Works nav entry and the page content", async () => {
    mockFetch({ "/api/health": [200, HEALTH_OK] });
    renderWithProviders(
      <Shell>
        <p>page body</p>
      </Shell>,
      { route: "/how-it-works" },
    );
    expect(screen.getByText("Agent Registry Hub")).toBeInTheDocument();
    expect(within(primaryNav()).getByRole("link", { name: /How It Works/ })).toHaveAttribute("href", "/how-it-works");
    expect(screen.getByRole("main")).toHaveTextContent("page body");
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    // /api/me is not there (404): the chip falls back to the health user and shows no role
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("View as role")).not.toBeInTheDocument();
  });

  it("shows the primary role once /api/me answers with its envelope", async () => {
    mockFetch({ "/api/health": [200, HEALTH_OK], "/api/me": [200, envelope({ ...ME, roles: ["viewer", "steward"], primary_role: "steward", is_admin: false })] });
    renderWithProviders(<Shell>content</Shell>);
    expect(await screen.findByText("Steward")).toBeInTheDocument();
    // not an admin: no "View as" switcher
    expect(screen.queryByLabelText("View as role")).not.toBeInTheDocument();
  });

  it("collapses the sidebar to icons and remembers it across reloads", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<Shell>content</Shell>);
    expect(primaryNav()).toHaveAttribute("data-collapsed", "false");
    expect(within(primaryNav()).getByText("How It Works")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(primaryNav()).toHaveAttribute("data-collapsed", "true");
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("true");
    // icons only: the label is gone from the rail but the link keeps an accessible name
    expect(within(primaryNav()).queryByText("How It Works")).not.toBeInTheDocument();
    expect(within(primaryNav()).getByRole("link", { name: "How It Works" })).toBeInTheDocument();

    first.unmount();
    renderWithProviders(<Shell>content</Shell>);
    expect(primaryNav()).toHaveAttribute("data-collapsed", "true");
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("false");
  });

  it("opens the command palette with Ctrl+K and the theme toggle persists", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Shell>content</Shell>);
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).toHaveClass("light");
    expect(localStorage.getItem("arh.theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });

  it("opens the mobile navigation drawer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Shell>content</Shell>);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Agent Registry Hub" });
    expect(within(drawer).getByRole("link", { name: /How It Works/ })).toBeInTheDocument();
  });
});

describe("Shell · view as", () => {
  it("lets an admin preview a role: sends x-registry-view-as on every call, shows the banner, and exits", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/health": HEALTH_OK,
      "/api/me": (c: { headers: Headers }) => {
        const role = c.headers.get(VIEW_AS_HEADER);
        return envelope(role ? { ...ME, roles: ["viewer", role], primary_role: role, view_as: role, is_steward: false, is_auditor: role === "auditor" } : ME);
      },
    });
    renderWithProviders(
      <SessionProvider>
        <Shell>content</Shell>
      </SessionProvider>,
    );
    const select = await screen.findByLabelText("View as role");
    expect(select).toHaveValue("admin");
    await user.selectOptions(select, "auditor");

    await waitFor(() => expect(rec.last("GET", "/api/me")!.headers.get(VIEW_AS_HEADER)).toBe("auditor"));
    expect(await screen.findByText("Previewing as Auditor.")).toBeInTheDocument();
    expect(localStorage.getItem("arh.viewAs")).toBe("auditor");
    // the user chip follows the previewed role; the switcher stays (is_admin is the real flag)
    expect(await screen.findByText("Auditor", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByLabelText("View as role")).toHaveValue("auditor");

    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    await waitFor(() => expect(screen.queryByText("Previewing as Auditor.")).not.toBeInTheDocument());
    await waitFor(() => expect(rec.last("GET", "/api/me")!.headers.get(VIEW_AS_HEADER)).toBeNull());
    expect(screen.getByLabelText("View as role")).toHaveValue("admin");
    expect(localStorage.getItem("arh.viewAs")).toBe("");
  });
});

describe("Shell · notifications and search", () => {
  const N = (id: number, extra: Partial<Notification> = {}): Notification => ({
    notification_id: id, kind: "change_published", title: `Change ${id}`, body: null, asset_id: "agent:endpoint:x", ref_id: String(id),
    channel: "in_app", delivery_status: "sent", read_at: null, created_at: `2026-10-2${id}T10:00:00Z`, ...extra,
  });

  it("shows the unread count, lists the latest notifications and marks one read", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/health": HEALTH_OK,
      "/api/me": envelope(ME),
      "/api/notifications": envelope([N(1), N(2, { read_at: "2026-10-25T00:00:00Z", kind: "access_decision", title: "Request approved" }), N(3)]),
      "POST /api/notifications/3/read": { ok: true },
    });
    renderWithProviders(<Shell>content</Shell>);
    const bell = await screen.findByRole("button", { name: "Notifications, 3 unread" });
    await user.click(bell);
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    const titles = within(panel).getAllByRole("button", { name: /^(Change|Request)/ }).map((b) => b.textContent);
    expect(titles[0]).toContain("Change 3"); // newest first
    await user.click(within(panel).getByRole("button", { name: "Mark “Change 3” read" }));
    await waitFor(() => expect(rec.last("POST", "/api/notifications/3/read")).toBeDefined());
    expect(within(panel).queryByRole("button", { name: "Mark “Change 3” read" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "View all" })).toHaveAttribute("href", "/notifications");
  });

  it("puts /api/search results (assets, people) into the command palette", async () => {
    const user = userEvent.setup();
    const rec = recordFetch({
      "/api/search?q=care": envelope([
        { kind: "asset", id: "agent:endpoint:demo-care-supervisor", label: "Care Ops Supervisor", sublabel: "agent · Databricks", href: "/assets/agent%3Aendpoint%3Ademo-care-supervisor", asset_type: "agent" },
        { kind: "person", id: "ana.ruiz@example.com", label: "Ana Ruiz", sublabel: "owner of 2 assets", href: "/catalog?owner=ana.ruiz%40example.com" },
      ]),
    });
    renderWithProviders(<Shell>content</Shell>);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox", { name: "Search" }), "care");
    expect(await screen.findByRole("option", { name: /Care Ops Supervisor/ })).toHaveTextContent("Agent");
    expect(screen.getByRole("option", { name: /Ana Ruiz/ })).toHaveTextContent("Person");
    expect(rec.calls.filter((c) => c.path.startsWith("/api/search")).map((c) => c.path)).toEqual(["/api/search?q=care"]);
  });
});
