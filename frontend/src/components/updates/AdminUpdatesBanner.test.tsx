// The admin banner as it runs inside the real Shell.
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, WatchOverview } from "../../lib/types";
import { HEALTH_OK, renderWithProviders } from "../../test/utils";
import Shell from "../Shell";
import { envelope, recordFetch } from "../workspace/fetchRecorder.test-utils";
import { BANNER_DISMISS_KEY, BANNER_REFRESH_MS } from "./AdminUpdatesBanner";
import { ADMIN, AUDITOR, candidate, overview } from "./fixtures.test-utils";

const READY_TEXT = "2 platform updates are ready for your decision (1 breaking) · 1 failed regression";
const banner = () => screen.queryByRole("status", { name: "Platform updates" });

function setup({ me = ADMIN, watch = overview() as WatchOverview | [number, unknown], route = "/home" }: { me?: Me; watch?: WatchOverview | [number, unknown]; route?: string } = {}) {
  const rec = recordFetch({
    "/api/health": HEALTH_OK,
    "/api/me": envelope(me),
    "/api/platform-watch": Array.isArray(watch) ? watch : envelope(watch),
    "/api/platform-watch/candidates?status=passed": envelope([candidate({ breaking: true }), candidate()]),
  });
  const view = renderWithProviders(<Shell><p>page body</p></Shell>, { route });
  return { rec, view, watchCalls: () => rec.calls.filter((c) => c.path === "/api/platform-watch").length };
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
});

describe("Shell · platform updates banner", () => {
  it("tells an admin how many updates are ready, how many are breaking and how many failed, with a Review link", async () => {
    const { rec } = setup();
    expect(await screen.findByText(READY_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/platform-updates#updates");
    expect(rec.calls.filter((c) => c.path === "/api/platform-watch/candidates?status=passed")).toHaveLength(1);
  });

  it("stays hidden when nothing is ready or failing (and skips the candidates call)", async () => {
    const { rec, watchCalls } = setup({ watch: overview({ ready: 0, attention: 0, counts: { detected: 3 } }) });
    await waitFor(() => expect(watchCalls()).toBe(1));
    expect(banner()).not.toBeInTheDocument();
    expect(rec.calls.some((c) => c.path.startsWith("/api/platform-watch/candidates"))).toBe(false);
  });

  it("dismissal is remembered for the session and the banner returns when the counts change", async () => {
    const user = userEvent.setup();
    const first = setup();
    await screen.findByText(READY_TEXT);
    await user.click(screen.getByRole("button", { name: "Dismiss the platform updates banner" }));
    await waitFor(() => expect(banner()).not.toBeInTheDocument());
    expect(sessionStorage.getItem(BANNER_DISMISS_KEY)).toBe("2|1|1");
    first.view.unmount();

    // same counts after a reload: still dismissed
    const second = setup();
    await waitFor(() => expect(second.watchCalls()).toBe(1));
    await waitFor(() => expect(second.rec.calls.some((c) => c.path === "/api/platform-watch/candidates?status=passed")).toBe(true));
    expect(banner()).not.toBeInTheDocument();
    second.view.unmount();

    // a new candidate is ready: it comes back
    setup({ watch: overview({ ready: 3, counts: { passed: 3, failed: 1 } }) });
    expect(await screen.findByText(/^3 platform updates are ready for your decision \(1 breaking\) · 1 failed regression$/)).toBeInTheDocument();
  });

  it("is never shown to non-admins (no request is made)", async () => {
    const { rec } = setup({ me: AUDITOR });
    expect(await screen.findByText("Ari Audit")).toBeInTheDocument();
    await waitFor(() => expect(rec.calls.some((c) => c.path === "/api/me")).toBe(true));
    expect(rec.calls.some((c) => c.path.startsWith("/api/platform-watch"))).toBe(false);
    expect(banner()).not.toBeInTheDocument();
  });

  it("tolerates a 403 (or 404): no banner, and the shell keeps working", async () => {
    const { watchCalls } = setup({ watch: [403, { detail: "Platform updates are for admins, stewards and auditors" }] });
    await waitFor(() => expect(watchCalls()).toBe(1));
    expect(banner()).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("page body");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("refetches on window focus at most every 5 minutes", async () => {
    const { watchCalls } = setup();
    await screen.findByText(READY_TEXT);
    expect(watchCalls()).toBe(1);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(watchCalls()).toBe(1); // too soon
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + BANNER_REFRESH_MS + 1000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(watchCalls()).toBe(2));
  });

  it("is not shown on the Platform updates page itself", async () => {
    const { watchCalls } = setup({ route: "/platform-updates" });
    await waitFor(() => expect(watchCalls()).toBe(1));
    expect(banner()).not.toBeInTheDocument();
  });
});
